/**
 * End-to-end demo: two traders, one sealed batch, settled on Coston2.
 *
 * Deposit -> seal orders client side -> submit as opaque bytes -> close the
 * batch -> relay the enclave's signed result -> settle on chain.
 *
 * Everything the chain sees is a ciphertext and, at the end, a clearing price
 * and net movements. Sides, limits and sizes never leave the enclave.
 *
 * Usage: vite-node scripts/demo.mjs
 * Keys and addresses load from `.secrets/` and `spec.md` section 3 via env.mjs.
 */

import "./env.mjs";

import { createPublicClient, createWalletClient, http, parseAbi, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { publicKeyFromInfo } from "../src/ecies.ts";
import { sealOrder } from "../src/order.ts";
import { awaitResult, decodeBatchResult } from "../src/relayer.ts";

const RPC = "https://coston2-api.flare.network/ext/C/rpc";
const PROXY = "http://localhost:6674";
const INSTRUCTION_FEE = 1_000_000n;

const coston2 = {
  id: 114,
  name: "Coston2",
  nativeCurrency: { name: "C2FLR", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const FXRP = env("FXRP");
const USDT0 = env("USDT0");
const VAULT = env("VAULT");
const BOOK = env("BOOK");
const SETTLEMENT = env("SETTLEMENT");

const erc20 = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const vaultAbi = parseAbi([
  "function deposit(bool,uint256)",
  "function baseBalanceOf(address) view returns (uint256)",
  "function quoteBalanceOf(address) view returns (uint256)",
]);
const bookAbi = parseAbi([
  "function submitOrder(bytes) payable returns (bytes32)",
  "function closeBatch() payable returns (bytes32)",
  "function currentBatchId() view returns (uint256)",
  "function orderCount() view returns (uint32)",
  "function batchTee() view returns (address)",
  "function batchOpenedAt() view returns (uint64)",
  "function minBatchDuration() view returns (uint64)",
  "event OrderSubmitted(address indexed trader, uint256 indexed batchId, address indexed tee, bytes32 instructionId)",
  "event BatchClosed(uint256 indexed batchId, address indexed tee, uint32 orderCount, bytes32 instructionId)",
]);
const settlementAbi = parseAbi(["function settle(bytes,bytes)"]);

const pub = createPublicClient({ chain: coston2, transport: http(RPC) });
const wallet = (pk) =>
  createWalletClient({ account: privateKeyToAccount(pk), chain: coston2, transport: http(RPC) });

const maker = wallet(env("MAKER_KEY"));
const taker = wallet(env("TAKER_KEY"));
const relayer = wallet(env("DEPLOYER_KEY"));

const log = (...a) => console.log(...a);
const fmt = (v) => (Number(v) / 1e6).toFixed(6);

async function send(client, args) {
  // Estimate, then pad by half. The estimator has under-predicted twice on
  // this path (FXRP's double proxy delegation on day 12, and advanceBatch at
  // the tail of settle), and both times the shortfall burned a live run.
  const gas = await pub.estimateContractGas({ ...args, account: client.account });
  const hash = await client.writeContract({ ...args, gas: (gas * 3n) / 2n });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`tx reverted: ${hash}`);
  return receipt;
}

async function main() {
  const teeInfo = await (await fetch(`${PROXY}/info`)).json();
  const teePub = publicKeyFromInfo(
    teeInfo.machineData.publicKey.x,
    teeInfo.machineData.publicKey.y,
  );
  log("enclave      ", teeInfo.machineData.extensionId);

  const batchId = await pub.readContract({ address: BOOK, abi: bookAbi, functionName: "currentBatchId" });
  log("batch        ", batchId.toString());

  // --- deposit -------------------------------------------------------------
  // Public, and deliberately decoupled from ordering: the deposit reveals only
  // that someone is a participant, never what they intend to trade.
  log("\n1. deposits");
  // Idempotent, so the demo can be re-run without exhausting a trader's wallet.
  // Deposit whatever the wallet actually holds, capped at what the demo needs.
  // Robust across repeat runs and across a redeploy, where balances are stranded
  // in the previous vault until withdrawn.
  async function topUp(client, token, isBase, want, label) {
    const fn = isBase ? "baseBalanceOf" : "quoteBalanceOf";
    const inVault = await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: fn, args: [client.account.address] });
    if (inVault >= want) {
      log(`   ${label} already holds ${fmt(inVault)} in the vault`);
      return;
    }
    const inWallet = await pub.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [client.account.address] });
    const amount = inWallet < want - inVault ? inWallet : want - inVault;
    if (amount === 0n) throw new Error(`${label} has nothing left to deposit`);
    await send(client, { address: token, abi: erc20, functionName: "approve", args: [VAULT, amount] });
    await send(client, { address: VAULT, abi: vaultAbi, functionName: "deposit", args: [isBase, amount] });
    log(`   ${label} deposited ${fmt(amount)}`);
  }

  // Sized to what the faucet-limited wallets can actually cover: the sell
  // needs 1.5 FXRP of base collateral, the buy 1.62 USDT0 of quote.
  await topUp(maker, FXRP, true, 1_500_000n, "maker (FXRP)");
  await topUp(taker, USDT0, false, 2_000_000n, "taker (USDT0)");

  const before = {
    makerBase: await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "baseBalanceOf", args: [maker.account.address] }),
    makerQuote: await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "quoteBalanceOf", args: [maker.account.address] }),
    takerBase: await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "baseBalanceOf", args: [taker.account.address] }),
    takerQuote: await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "quoteBalanceOf", args: [taker.account.address] }),
  };

  // --- seal and submit -----------------------------------------------------
  // Limits straddle the live FTSO reading by 1%, so the midpoint the engine
  // clears at lands on the feed, comfortably inside Settlement's price band.
  // Hardcoded limits burned a run on day 12; the feed had moved out from
  // under them and the guard rejected the price, exactly as designed.
  const ftsoAbi = parseAbi([
    "function getFeedById(bytes21) view returns (uint256,int8,uint64)",
  ]);
  const FTSO = "0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d";
  const XRP_USD = "0x015852502f55534400000000000000000000000000";
  const [oracle] = await pub.readContract({
    address: FTSO, abi: ftsoAbi, functionName: "getFeedById", args: [XRP_USD],
  });
  const sellLimit = (oracle * 99n) / 100n;
  const buyLimit = (oracle * 101n) / 100n;

  log("\n2. sealed orders (the chain sees only ciphertext)");
  const sellCt = sealOrder(teePub, {
    trader: maker.account.address, batchId, side: "SELL",
    limitPrice: sellLimit, size: 1_500_000n,
  });
  const buyCt = sealOrder(teePub, {
    trader: taker.account.address, batchId, side: "BUY",
    limitPrice: buyLimit, size: 1_500_000n,
  });
  log(`   maker SELL 1.5 FXRP @ ${fmt(sellLimit)}  ->  ${sellCt.slice(0, 34)}...`);
  log(`   taker BUY  1.5 FXRP @ ${fmt(buyLimit)}  ->  ${buyCt.slice(0, 34)}...`);

  await send(maker, { address: BOOK, abi: bookAbi, functionName: "submitOrder", args: [sellCt], value: INSTRUCTION_FEE });
  await send(taker, { address: BOOK, abi: bookAbi, functionName: "submitOrder", args: [buyCt], value: INSTRUCTION_FEE });
  const count = await pub.readContract({ address: BOOK, abi: bookAbi, functionName: "orderCount" });
  log(`   on chain: orderCount=${count}, and nothing else`);

  // --- close ---------------------------------------------------------------
  // The batch cannot be closed the instant it opens. That rate limit is what
  // stops anyone isolating a single order into its own batch and reading its
  // side straight off the settlement.
  const openedAt = await pub.readContract({ address: BOOK, abi: bookAbi, functionName: "batchOpenedAt" });
  const minDuration = await pub.readContract({ address: BOOK, abi: bookAbi, functionName: "minBatchDuration" });
  const closeableAt = Number(openedAt) + Number(minDuration);
  for (;;) {
    const now = Number((await pub.getBlock()).timestamp);
    if (now >= closeableAt) break;
    log(`   waiting ${closeableAt - now}s for the batch window to elapse`);
    await new Promise((r) => setTimeout(r, Math.min(15, closeableAt - now + 1) * 1000));
  }

  log("\n3. close the batch");
  const closeReceipt = await send(relayer, { address: BOOK, abi: bookAbi, functionName: "closeBatch", value: INSTRUCTION_FEE });
  const [closed] = parseEventLogs({ abi: bookAbi, eventName: "BatchClosed", logs: closeReceipt.logs });
  if (!closed) throw new Error("BatchClosed event not found");
  const instructionId = closed.args.instructionId;
  log(`   orders ${closed.args.orderCount}, instruction ${instructionId}`);

  // --- relay ---------------------------------------------------------------
  log("\n4. relayer polls the proxy for the enclave's signed result");
  const envelope = await awaitResult(PROXY, instructionId);
  const batch = decodeBatchResult(envelope);
  log(`   clearing price ${fmt(batch.clearingPrice)}   volume ${fmt(batch.volume)} FXRP`);
  log(`   signature      ${batch.signature.slice(0, 34)}...`);

  // --- settle --------------------------------------------------------------
  log("\n5. settle on chain");
  await send(relayer, {
    address: SETTLEMENT, abi: settlementAbi, functionName: "settle",
    args: [batch.payload, batch.signature],
  });

  const after = {
    makerBase: await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "baseBalanceOf", args: [maker.account.address] }),
    makerQuote: await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "quoteBalanceOf", args: [maker.account.address] }),
    takerBase: await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "baseBalanceOf", args: [taker.account.address] }),
    takerQuote: await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "quoteBalanceOf", args: [taker.account.address] }),
  };

  log("\n6. balances");
  log(`   maker  FXRP ${fmt(before.makerBase)} -> ${fmt(after.makerBase)}   USDT0 ${fmt(before.makerQuote)} -> ${fmt(after.makerQuote)}`);
  log(`   taker  FXRP ${fmt(before.takerBase)} -> ${fmt(after.takerBase)}   USDT0 ${fmt(before.takerQuote)} -> ${fmt(after.takerQuote)}`);

  const baseConserved =
    before.makerBase + before.takerBase === after.makerBase + after.takerBase;
  const quoteConserved =
    before.makerQuote + before.takerQuote === after.makerQuote + after.takerQuote;
  log(`\n   conserved: base ${baseConserved}, quote ${quoteConserved}`);
  log(`   settled batch ${batch.batchId} at ${fmt(batch.clearingPrice)}`);
}

main().catch((e) => {
  console.error("\nFAILED:", e.message);
  process.exit(1);
});
