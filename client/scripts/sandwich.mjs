/**
 * The comparison: the same order, on a public pool and in the sealed venue.
 *
 * Part A sandwiches a trade on `NaiveAmm`, a correct constant-product pool.
 * Part B puts an order of the same size through the sealed venue while an
 * adversary watches the chain and tries to do the same thing.
 *
 * The number worth reading is the last one: what it costs to be observed.
 *
 * Two honest notes, stated here rather than buried:
 *
 * 1. Coston2's public RPC exposes no mempool. `txpool_status` is not served and
 *    there is no pending-transaction subscription, so this script cannot race
 *    for the ordering a real searcher races for. It executes the three
 *    transactions in the order a successful searcher achieves. The claim under
 *    test is "an attacker who front-runs profits", not "an attacker always wins
 *    the race". On a chain with a public mempool, obtaining that ordering is a
 *    fee auction, and it is routinely won.
 *
 * 2. The pool is shallow, because testnet FXRP comes from a faucet capped at 10
 *    per address per day. Constant-product pricing is scale-invariant: a trade
 *    worth 10% of the reserves moves the price by the same proportion whether
 *    the pool holds one FXRP or one million. Trade sizes here are therefore set
 *    as fractions of the reserves, and the pool depth is printed alongside every
 *    result so nothing is being hidden by choosing convenient absolute numbers.
 *
 * Usage:
 *   node scripts/sandwich.mjs             both parts
 *   node scripts/sandwich.mjs --amm-only  skip the venue leg (no TEE needed)
 */

import { createPublicClient, createWalletClient, http, parseAbi, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { publicKeyFromInfo } from "../src/ecies.ts";
import { sealOrder } from "../src/order.ts";
import { awaitResult, decodeBatchResult } from "../src/relayer.ts";

const RPC = "https://coston2-api.flare.network/ext/C/rpc";
const PROXY = "http://localhost:6674";
const INSTRUCTION_FEE = 1_000_000n;
const SCALE = 1_000_000n;

const AMM_ONLY = process.argv.includes("--amm-only");

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
const AMM = env("AMM");
const VAULT = env("VAULT");
const BOOK = env("BOOK");
const SETTLEMENT = env("SETTLEMENT");

const erc20 = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const ammAbi = parseAbi([
  "function addLiquidity(uint256,uint256)",
  "function swapBaseForQuote(uint256,uint256) returns (uint256)",
  "function swapQuoteForBase(uint256,uint256) returns (uint256)",
  "function quoteOut(bool,uint256) view returns (uint256)",
  "function spotPrice() view returns (uint256)",
  "function reserveBase() view returns (uint256)",
  "function reserveQuote() view returns (uint256)",
  "event Swap(address indexed trader, bool baseIn, uint256 amountIn, uint256 amountOut)",
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
  "function batchOpenedAt() view returns (uint64)",
  "function minBatchDuration() view returns (uint64)",
  "event BatchClosed(uint256 indexed batchId, address indexed tee, uint32 orderCount, bytes32 instructionId)",
]);
const settlementAbi = parseAbi([
  "function settle(bytes,bytes)",
  "function bandBps() view returns (uint16)",
]);
const ftsoAbi = parseAbi(["function getFeedById(bytes21) view returns (uint256,int8,uint64)"]);

const FTSO = "0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d";
/** bytes21: 0x01 (crypto) then ASCII "XRP/USD" right-padded to 20 bytes. */
const XRP_USD = "0x015852502f55534400000000000000000000000000";

const pub = createPublicClient({ chain: coston2, transport: http(RPC) });
const wallet = (pk) =>
  createWalletClient({ account: privateKeyToAccount(pk), chain: coston2, transport: http(RPC) });

/** The pool's liquidity provider, and the party that funds the demo. */
const lp = wallet(env("DEPLOYER_KEY"));
/** The searcher. Reads the chain, acts on what it sees. */
const attacker = wallet(env("MAKER_KEY"));
/** The trader with an order to fill. */
const victim = wallet(env("TAKER_KEY"));

const log = (...a) => console.log(...a);
const fmt = (v, dp = 6) => (Number(v) / 1e6).toFixed(dp);
const pct = (n, d) => (d === 0n ? "0.00" : ((Number(n) / Number(d)) * 100).toFixed(2));
const bps = (n, d) => (d === 0n ? 0 : Math.round((Number(n) / Number(d)) * 10_000));

/**
 * Send with a padded gas limit.
 *
 * @remarks FXRP is a FAssets proxy whose `transfer` delegates twice and reads
 * an emergency-pause flag from a third contract. A swap that ends in an FXRP
 * payout costs far more than the estimator predicts against pre-swap state, and
 * an under-estimate surfaces as `OutOfGas` inside the token rather than as a
 * legible failure. Padding is cheaper than debugging that twice.
 */
async function send(client, args) {
  const estimate = await pub.estimateContractGas({ ...args, account: client.account });
  const hash = await client.writeContract({ ...args, gas: (estimate * 3n) / 2n });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`tx reverted: ${hash}`);
  return receipt;
}

const read = (address, abi, functionName, args) =>
  pub.readContract({ address, abi, functionName, args });

const ammRead = (fn, args) => read(AMM, ammAbi, fn, args);
const balanceOf = (token, who) => read(token, erc20, "balanceOf", [who]);

/** Execution price of a fill, in quote per base, scaled by 1e6. */
const priceOf = (base, quote) => (base === 0n ? 0n : (quote * SCALE) / base);

/** Swaps and returns the amount actually received, read from the event. */
async function swap(client, baseIn, amountIn) {
  const fn = baseIn ? "swapBaseForQuote" : "swapQuoteForBase";
  const receipt = await send(client, {
    address: AMM,
    abi: ammAbi,
    functionName: fn,
    args: [amountIn, 0n],
  });
  const [ev] = parseEventLogs({ abi: ammAbi, eventName: "Swap", logs: receipt.logs });
  if (!ev) throw new Error("Swap event not found");
  return ev.args.amountOut;
}

/** Approve once, generously, so the run is not a sequence of approvals. */
async function approveAll(client, label) {
  for (const [token, name] of [
    [FXRP, "FXRP"],
    [USDT0, "USDT0"],
  ]) {
    const allowanceAbi = parseAbi(["function allowance(address,address) view returns (uint256)"]);
    const current = await read(token, allowanceAbi, "allowance", [client.account.address, AMM]);
    if (current > 10n ** 12n) continue;
    await send(client, {
      address: token,
      abi: erc20,
      functionName: "approve",
      args: [AMM, 2n ** 255n],
    });
    log(`   ${label} approved ${name}`);
  }
}

// --- pool setup -------------------------------------------------------------

/**
 * Seed the pool if it is empty, using whatever the LP wallet holds.
 *
 * The quote side is sized to open the pool at roughly the FTSO XRP/USD reading
 * the venue's price band is centred on, so the two halves of the comparison
 * start from the same price rather than from two arbitrary ones.
 */
async function ensureLiquidity() {
  const [rb, rq] = await Promise.all([ammRead("reserveBase"), ammRead("reserveQuote")]);
  if (rb > 0n && rq > 0n) {
    log(`   pool already holds ${fmt(rb)} FXRP / ${fmt(rq)} USDT0`);
    return { rb, rq };
  }

  const OPENING_PRICE = 1_064_000n; // 1.064, near the live feed
  const [haveBase, haveQuote] = await Promise.all([
    balanceOf(FXRP, lp.account.address),
    balanceOf(USDT0, lp.account.address),
  ]);

  // Take the largest balanced pair the wallet can cover on both sides.
  let base = haveBase;
  let quote = (base * OPENING_PRICE) / SCALE;
  if (quote > haveQuote) {
    quote = haveQuote;
    base = (quote * SCALE) / OPENING_PRICE;
  }
  if (base === 0n || quote === 0n) {
    throw new Error(
      `LP wallet cannot seed the pool: holds ${fmt(haveBase)} FXRP and ${fmt(haveQuote)} USDT0. ` +
        `Claim the Coston2 faucet for ${lp.account.address}.`,
    );
  }

  await approveAll(lp, "lp");
  await send(lp, { address: AMM, abi: ammAbi, functionName: "addLiquidity", args: [base, quote] });
  log(`   seeded ${fmt(base)} FXRP / ${fmt(quote)} USDT0`);
  return { rb: base, rq: quote };
}

/**
 * Return the pool to the FTSO price before measuring anything.
 *
 * A real pool does not sit at a stale price: the moment it diverges from the
 * wider market, an arbitrageur closes the gap and keeps the difference. Without
 * this step every run of this script would start wherever the previous run's
 * sandwich left the pool, and the absolute prices in the summary would be
 * comparing a drifted pool against a live oracle. The measured extraction is a
 * within-run delta and is unaffected either way, but the absolute figures
 * should not invite a comparison they do not support.
 *
 * Constant product: to reach price P while holding k = rb * rq, the reserves
 * must be rb' = sqrt(k / P) and rq' = sqrt(k * P).
 */
async function rebalanceToOracle() {
  const [rb, rq] = await Promise.all([ammRead("reserveBase"), ammRead("reserveQuote")]);
  const [oracle] = await read(FTSO, ftsoAbi, "getFeedById", [XRP_USD]);

  // Integer square root, so the target never depends on floating point.
  const isqrt = (n) => {
    if (n <= 1n) return n;
    let x = n;
    let y = (x + 1n) / 2n;
    while (y < x) {
      x = y;
      y = (x + n / x) / 2n;
    }
    return x;
  };

  const k = rb * rq;
  const targetBase = isqrt((k * SCALE) / oracle); // sqrt(k / P)
  const targetQuote = isqrt((k * oracle) / SCALE); // sqrt(k * P)
  const spot = (rq * SCALE) / rb;

  // Ignore drift small enough that the fee would eat the arbitrage anyway.
  if (spot > (oracle * 995n) / 1000n && spot < (oracle * 1005n) / 1000n) return;

  // Above the oracle the pool is short base, so the arbitrageur sells base into
  // it. Below, the reverse.
  const sellBase = targetBase > rb;
  // Undo the 30 bps fee so the swap lands on the target rather than short of it.
  const amountIn = sellBase
    ? ((targetBase - rb) * 10_000n) / 9970n
    : ((targetQuote - rq) * 10_000n) / 9970n;

  const token = sellBase ? FXRP : USDT0;
  const holders = [
    [lp, "lp"],
    [attacker, "attacker"],
    [victim, "victim"],
  ];
  for (const [client, label] of holders) {
    const held = await balanceOf(token, client.account.address);
    if (held < amountIn) continue;
    await approveAll(client, label);
    await swap(client, sellBase, amountIn);
    log(`   arbitrage returned spot ${fmt(spot)} -> ${fmt(await ammRead("spotPrice"))}`);
    return;
  }
  log(`   spot ${fmt(spot)} is off the oracle ${fmt(oracle)}, and nobody holds enough to arb it`);
}

// --- part A: the public pool -------------------------------------------------

async function publicPool() {
  log("=".repeat(72));
  log("PART A   a public constant-product pool");
  log("=".repeat(72));

  await ensureLiquidity();
  await rebalanceToOracle();
  const [rb, rq] = await Promise.all([ammRead("reserveBase"), ammRead("reserveQuote")]);
  const spot = await ammRead("spotPrice");
  log(`   depth ${fmt(rb)} FXRP / ${fmt(rq)} USDT0     spot ${fmt(spot)}`);

  // Sizes as fractions of the reserves, so the result does not depend on how
  // much the faucet happened to dispense, and so the same figures would hold on
  // a pool a million times deeper.
  const victimSize = rq / 50n; // a buy worth 2% of the quote reserve
  const frontRunSize = rq / 25n; // the searcher commits twice the victim's size

  await approveAll(attacker, "attacker");
  await approveAll(victim, "victim");

  const haveQuote = await balanceOf(USDT0, attacker.account.address);
  if (haveQuote < frontRunSize) {
    throw new Error(
      `attacker holds ${fmt(haveQuote)} USDT0 but needs ${fmt(frontRunSize)} to front-run`,
    );
  }

  // The baseline, priced but not executed. `quoteOut` is a public view
  // function: this is the same read the searcher makes, and anyone can make it.
  const aloneOut = await ammRead("quoteOut", [false, victimSize]);
  const alonePrice = priceOf(aloneOut, victimSize);
  log("");
  log(`1. the victim intends to buy with ${fmt(victimSize)} USDT0`);
  log(`   that is ${pct(victimSize, rq)}% of the pool's quote reserve`);
  log(`   unobserved, it fills ${fmt(aloneOut)} FXRP at ${fmt(alonePrice)}`);

  log("");
  log("2. the searcher reads the pending trade and front-runs it");
  const attackerBaseBefore = await balanceOf(FXRP, attacker.account.address);
  const attackerQuoteBefore = await balanceOf(USDT0, attacker.account.address);
  const frontRunOut = await swap(attacker, false, frontRunSize);
  log(`   bought ${fmt(frontRunOut)} FXRP with ${fmt(frontRunSize)} USDT0`);
  log(`   spot moved ${fmt(spot)} -> ${fmt(await ammRead("spotPrice"))}`);

  // From here the searcher is holding inventory. If anything below throws, the
  // position must still be unwound or the pool is left skewed for the next run.
  let sandwichedOut;
  try {
    log("");
    log("3. the victim's trade lands, into the price the searcher just moved");
    sandwichedOut = await swap(victim, false, victimSize);
    log(`   filled ${fmt(sandwichedOut)} FXRP at ${fmt(priceOf(sandwichedOut, victimSize))}`);
  } finally {
    log("");
    log("4. the searcher unwinds");
    await swap(attacker, true, frontRunOut);
  }
  const sandwichedPrice = priceOf(sandwichedOut, victimSize);

  const attackerBaseAfter = await balanceOf(FXRP, attacker.account.address);
  const attackerQuoteAfter = await balanceOf(USDT0, attacker.account.address);
  const baseDelta = attackerBaseAfter - attackerBaseBefore;
  const quoteDelta = attackerQuoteAfter - attackerQuoteBefore;
  log(`   searcher net: ${fmt(baseDelta)} FXRP, ${fmt(quoteDelta)} USDT0`);

  const shortfall = aloneOut - sandwichedOut;
  log("");
  log(`   the victim received ${fmt(shortfall)} FXRP less than an unobserved trade,`);
  log(`   which is ${pct(shortfall, aloneOut)}% of the fill, or ${bps(shortfall, aloneOut)} bps.`);

  return {
    victimSize,
    alonePrice,
    sandwichedPrice,
    shortfall,
    aloneOut,
    sandwichedOut,
    searcherQuote: quoteDelta,
    depth: { rb, rq },
  };
}

// --- part B: the sealed venue ------------------------------------------------

/**
 * The same trade, sealed. An adversary with the same privileges as the searcher
 * above watches the chain throughout and is shown exactly what it can learn.
 */
async function sealedVenue(wantBase) {
  log("");
  log("=".repeat(72));
  log("PART B   the sealed venue, same size, same adversary");
  log("=".repeat(72));

  const info = await (await fetch(`${PROXY}/info`)).json();
  const teePub = publicKeyFromInfo(info.machineData.publicKey.x, info.machineData.publicKey.y);
  const batchId = await read(BOOK, bookAbi, "currentBatchId");
  log(`   enclave ${info.machineData.extensionId}   batch ${batchId}`);

  // Limits are derived from the live FTSO reading rather than hardcoded.
  //
  // Settlement rejects any batch whose clearing price falls outside a band
  // around the oracle, so a fixed pair of limits works only until the feed
  // moves. It moved: an earlier run of this script cleared at 1.074488 against
  // a feed of 1.029415 and was refused with `PriceOutsideBand`. Straddling the
  // feed by 1% keeps the midpoint on the oracle and well inside a 2% band.
  const [oracle, , oracleAt] = await read(FTSO, ftsoAbi, "getFeedById", [XRP_USD]);
  const band = await read(SETTLEMENT, settlementAbi, "bandBps");
  const LIMIT_BUY = (oracle * 101n) / 100n;
  const LIMIT_SELL = (oracle * 99n) / 100n;
  log(`   FTSO XRP/USD ${fmt(oracle)} at ${oracleAt}, band ${band} bps`);

  const [vBase, vQuote, aBase] = await Promise.all([
    read(VAULT, vaultAbi, "baseBalanceOf", [victim.account.address]),
    read(VAULT, vaultAbi, "quoteBalanceOf", [victim.account.address]),
    read(VAULT, vaultAbi, "baseBalanceOf", [attacker.account.address]),
  ]);

  // Size the sealed order to what the vault can actually cover on both sides.
  // The enclave rejects an order the vault cannot back, so asking for more than
  // this would simply be refused, and refused invisibly.
  const affordable = (vQuote * SCALE) / LIMIT_BUY;
  let size = wantBase < affordable ? wantBase : affordable;
  if (size > aBase) size = aBase;
  if (size === 0n) {
    throw new Error(
      `nothing to trade: victim holds ${fmt(vQuote)} USDT0 and the counterparty ${fmt(aBase)} FXRP in the vault`,
    );
  }
  log(`   victim vault ${fmt(vBase)} FXRP / ${fmt(vQuote)} USDT0`);
  log(`   trading ${fmt(size)} FXRP`);

  log("");
  log("1. the victim seals the order in their own browser and submits it");
  const buyCt = sealOrder(teePub, {
    trader: victim.account.address,
    batchId,
    side: "BUY",
    limitPrice: LIMIT_BUY,
    size,
  });
  await send(victim, {
    address: BOOK,
    abi: bookAbi,
    functionName: "submitOrder",
    args: [buyCt],
    value: INSTRUCTION_FEE,
  });
  log(`   the chain now stores ${buyCt.length / 2 - 1} bytes:`);
  log(`   ${buyCt.slice(0, 66)}...`);

  log("");
  log("2. the adversary reads everything the chain will give it");
  const count = await read(BOOK, bookAbi, "orderCount");
  log(`   currentBatchId  ${batchId}`);
  log(`   orderCount      ${count}`);
  log(`   order contents  the ciphertext above, and nothing else`);
  log("");
  log("   To front-run this the adversary needs the side, and it has a coin");
  log("   flip. Guessing wrong funds the victim instead of taxing them, so the");
  log("   expected value of the attack is not merely lower, it is negative.");

  log("");
  log("3. a counterparty submits into the same batch, equally blind");
  const sellCt = sealOrder(teePub, {
    trader: attacker.account.address,
    batchId,
    side: "SELL",
    limitPrice: LIMIT_SELL,
    size,
  });
  await send(attacker, {
    address: BOOK,
    abi: bookAbi,
    functionName: "submitOrder",
    args: [sellCt],
    value: INSTRUCTION_FEE,
  });

  // The batch cannot be closed the instant it opens. That window is what stops
  // an observer isolating one order into a batch of its own and reading its
  // side straight off the settlement.
  const [openedAt, minDuration] = await Promise.all([
    read(BOOK, bookAbi, "batchOpenedAt"),
    read(BOOK, bookAbi, "minBatchDuration"),
  ]);
  const closeableAt = Number(openedAt) + Number(minDuration);
  for (;;) {
    const now = Number((await pub.getBlock()).timestamp);
    if (now >= closeableAt) break;
    log(`   waiting ${closeableAt - now}s for the batch window`);
    await new Promise((r) => setTimeout(r, Math.min(15, closeableAt - now + 1) * 1000));
  }

  log("");
  log("4. the batch closes, the enclave clears it, the chain settles it");
  const closeReceipt = await send(lp, {
    address: BOOK,
    abi: bookAbi,
    functionName: "closeBatch",
    value: INSTRUCTION_FEE,
  });
  const [closed] = parseEventLogs({
    abi: bookAbi,
    eventName: "BatchClosed",
    logs: closeReceipt.logs,
  });
  if (!closed) throw new Error("BatchClosed event not found");

  const before = await read(VAULT, vaultAbi, "baseBalanceOf", [victim.account.address]);
  const envelope = await awaitResult(PROXY, closed.args.instructionId);
  const batch = decodeBatchResult(envelope);
  await send(lp, {
    address: SETTLEMENT,
    abi: settlementAbi,
    functionName: "settle",
    args: [batch.payload, batch.signature],
  });
  const after = await read(VAULT, vaultAbi, "baseBalanceOf", [victim.account.address]);

  const filled = after - before;
  log(`   clearing price ${fmt(batch.clearingPrice)}   volume ${fmt(batch.volume)} FXRP`);
  log(`   the victim filled ${fmt(filled)} FXRP at ${fmt(batch.clearingPrice)}`);
  log("");
  log("   Every filled order in the batch cleared at that one price. A fill here");
  log("   is not a function of order size, so there is no size-dependent gap for");
  log("   an observer to widen.");

  return { clearingPrice: batch.clearingPrice, filled, size };
}

// --- the comparison ----------------------------------------------------------

async function main() {
  const amm = await publicPool();

  // Match on base size, not on the quote spent. The AMM victim expressed their
  // intent as "spend this much USDT0"; the comparable sealed order is for the
  // FXRP that intent would have bought had nobody been watching.
  let venue = null;
  if (!AMM_ONLY) {
    venue = await sealedVenue(amm.aloneOut);
  }

  log("");
  log("=".repeat(72));
  log("WHAT IT COSTS TO BE OBSERVED");
  log("=".repeat(72));
  log("");
  log(`   pool depth ${fmt(amm.depth.rb)} FXRP / ${fmt(amm.depth.rq)} USDT0`);
  log(`   order size ${pct(amm.victimSize, amm.depth.rq)}% of the quote reserve`);
  log("");

  const row = (label, left, right) =>
    log(`   ${label.padEnd(32)}${String(left).padEnd(20)}${right}`);
  const na = "not run";

  row("", "public pool", "sealed venue");
  row("visible before it fills", "yes", "no");
  row("price depends on order size", "yes", "no, one clearing price");
  row("checked against an oracle", "no", "yes, FTSO band");
  row("execution price", fmt(amm.sandwichedPrice), venue ? fmt(venue.clearingPrice) : na);
  row("price if unobserved", fmt(amm.alonePrice), venue ? fmt(venue.clearingPrice) : na);
  row(
    "cost of being observed",
    `${bps(amm.shortfall, amm.aloneOut)} bps`,
    venue ? "0 bps" : na,
  );
  log("");
  log("   The public pool's loss is not a bug in the pool. It is a correct");
  log("   constant-product implementation. The loss is structural: the trade was");
  log("   legible before it executed, and something read it.");
  log("");
  log("   Worth noting from the run above: the front-run pushed the pool's spot");
  log("   price well away from the FTSO reading, and the pool filled the victim");
  log("   there without objection, because it has no idea what XRP is worth. The");
  log("   venue refuses to settle outside a band around the feed. That guard is");
  log("   not decoration: an earlier run of this script was rejected by it.");
}

main().catch((e) => {
  console.error("\nFAILED:", e.message);
  process.exit(1);
});
