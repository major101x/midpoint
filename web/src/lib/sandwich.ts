/**
 * What a sandwich would cost on the comparison pool, right now.
 *
 * This is arithmetic on the pool's live reserves, not a recorded figure and not
 * a transaction. It reproduces `NaiveAmm.quoteOut` exactly, including the
 * integer truncation, so the number on the page is the number the pool would
 * actually produce. `contracts/test/Sandwich.t.sol` proves the same result
 * against the deployed bytecode, and `client/scripts/sandwich.mjs` has executed
 * it live for real.
 *
 * The attack modelled is the ordinary one: a searcher reads a pending buy,
 * buys ahead of it, lets the victim's trade land into the worsened price, and
 * unwinds. The pool is a correct constant-product implementation. It is
 * sandwichable because the trade was legible before it executed, which is the
 * entire argument this page exists to make.
 */

const SCALE = 1_000_000n;
const FEE_NUMERATOR = 9970n;
const FEE_DENOMINATOR = 10_000n;

export interface MevEstimate {
  /** Reserves the estimate was computed from. */
  reserveBase: bigint;
  reserveQuote: bigint;
  /** Quote spent by the victim, and its share of the reserve in percent. */
  tradeSize: bigint;
  tradePctOfReserve: number;
  /** Base received with nobody watching, and with a searcher in front. */
  aloneOut: bigint;
  sandwichedOut: bigint;
  /** Average price paid, quote per base, scaled by 1e6. */
  alonePrice: bigint;
  sandwichedPrice: bigint;
  /** What the victim lost, in base units and in basis points of the fill. */
  shortfall: bigint;
  bps: number;
}

/** `NaiveAmm.quoteOut`, reproduced including its truncation. */
function quoteOut(reserveIn: bigint, reserveOut: bigint, amountIn: bigint): bigint {
  if (reserveIn <= 0n || reserveOut <= 0n || amountIn <= 0n) return 0n;
  const amountInWithFee = (amountIn * FEE_NUMERATOR) / FEE_DENOMINATOR;
  return (reserveOut * amountInWithFee) / (reserveIn + amountInWithFee);
}

/**
 * @param reserveBase FXRP held by the pool.
 * @param reserveQuote USDT0 held by the pool.
 *
 * @remarks Sizes are fractions of the reserves rather than absolute amounts.
 * Constant-product pricing is scale invariant, so a trade worth 2% of a pool
 * costs the same in basis points whether the pool holds one FXRP or a million.
 * That matters here because testnet FXRP is faucet-capped, and it means the
 * figure on the page is not an artifact of a conveniently small pool.
 */
export function estimateSandwich(reserveBase: bigint, reserveQuote: bigint): MevEstimate | null {
  if (reserveBase <= 0n || reserveQuote <= 0n) return null;

  const tradeSize = reserveQuote / 50n; // 2% of the quote reserve
  const frontRun = reserveQuote / 25n; // the searcher commits twice that
  if (tradeSize <= 0n) return null;

  // Unobserved: the victim trades alone.
  const aloneOut = quoteOut(reserveQuote, reserveBase, tradeSize);

  // Observed: the searcher buys first, moving the price against the victim.
  const frontOut = quoteOut(reserveQuote, reserveBase, frontRun);
  const sandwichedOut = quoteOut(reserveQuote + frontRun, reserveBase - frontOut, tradeSize);

  if (aloneOut <= 0n || sandwichedOut <= 0n) return null;

  const shortfall = aloneOut - sandwichedOut;
  return {
    reserveBase,
    reserveQuote,
    tradeSize,
    tradePctOfReserve: (Number(tradeSize) / Number(reserveQuote)) * 100,
    aloneOut,
    sandwichedOut,
    alonePrice: (tradeSize * SCALE) / aloneOut,
    sandwichedPrice: (tradeSize * SCALE) / sandwichedOut,
    shortfall,
    bps: Number((shortfall * 10_000n) / aloneOut),
  };
}
