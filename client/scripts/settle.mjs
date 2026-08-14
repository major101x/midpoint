/** Relay a stored batch result and settle it. Usage: settle.mjs <instructionId> */
import "./env.mjs";

import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { awaitResult, decodeBatchResult } from "../src/relayer.ts";

const RPC = "https://coston2-api.flare.network/ext/C/rpc";
const coston2 = { id: 114, name: "Coston2", nativeCurrency: { name: "C2FLR", symbol: "C2FLR", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain: coston2, transport: http(RPC) });
const relayer = createWalletClient({ account: privateKeyToAccount(process.env.DEPLOYER_KEY), chain: coston2, transport: http(RPC) });

const vaultAbi = parseAbi(["function baseBalanceOf(address) view returns (uint256)", "function quoteBalanceOf(address) view returns (uint256)"]);
const fmt = (v) => (Number(v) / 1e6).toFixed(6);
const who = { maker: process.env.MAKER_ADDRESS, taker: process.env.TAKER_ADDRESS };

const snap = async () => ({
  makerBase: await pub.readContract({ address: process.env.VAULT, abi: vaultAbi, functionName: "baseBalanceOf", args: [who.maker] }),
  makerQuote: await pub.readContract({ address: process.env.VAULT, abi: vaultAbi, functionName: "quoteBalanceOf", args: [who.maker] }),
  takerBase: await pub.readContract({ address: process.env.VAULT, abi: vaultAbi, functionName: "baseBalanceOf", args: [who.taker] }),
  takerQuote: await pub.readContract({ address: process.env.VAULT, abi: vaultAbi, functionName: "quoteBalanceOf", args: [who.taker] }),
});

const before = await snap();
const batch = decodeBatchResult(await awaitResult("http://localhost:6674", process.argv[2]));
console.log(`batch ${batch.batchId}  clearing price ${fmt(batch.clearingPrice)}  volume ${fmt(batch.volume)} FXRP`);

// Estimate, then pad by half: the estimator shorted advanceBatch at the tail
// of settle on 2026-08-14 and the run reverted OutOfGas.
const settleArgs = {
  address: process.env.SETTLEMENT,
  abi: parseAbi(["function settle(bytes,bytes)"]),
  functionName: "settle",
  args: [batch.payload, batch.signature],
};
const gas = await pub.estimateContractGas({ ...settleArgs, account: relayer.account });
const hash = await relayer.writeContract({ ...settleArgs, gas: (gas * 3n) / 2n });
const rc = await pub.waitForTransactionReceipt({ hash });
console.log(`settle tx ${hash}  status ${rc.status}`);

const after = await snap();
console.log(`maker  FXRP ${fmt(before.makerBase)} -> ${fmt(after.makerBase)}   USDT0 ${fmt(before.makerQuote)} -> ${fmt(after.makerQuote)}`);
console.log(`taker  FXRP ${fmt(before.takerBase)} -> ${fmt(after.takerBase)}   USDT0 ${fmt(before.takerQuote)} -> ${fmt(after.takerQuote)}`);
console.log(`conserved: base ${before.makerBase + before.takerBase === after.makerBase + after.takerBase}, quote ${before.makerQuote + before.takerQuote === after.makerQuote + after.takerQuote}`);
