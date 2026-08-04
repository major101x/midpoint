/**
 * ★ Uniform-price call auction.
 *
 * Every order that fills in a batch trades at one price. That is what removes
 * the timing advantage: arriving first in the batch is worth nothing, because
 * position in the queue cannot change the price anyone pays.
 *
 * The rules, in the order they are applied:
 *
 *  1. CHOOSE p* TO MAXIMISE EXECUTED VOLUME. For each candidate price, demand is
 *     the total size of bids willing to pay at least p*, supply is the total
 *     size of asks willing to accept at most p*, and executable volume is the
 *     smaller of the two.
 *  2. BREAK TIES BY MINIMISING IMBALANCE, |demand - supply|. Two prices can clear
 *     the same volume; the fairer one leaves less unfilled interest stranded.
 *  3. BREAK REMAINING TIES BY TAKING THE MIDPOINT of the tied range, so the
 *     surplus is split between buyers and sellers rather than handed to one side.
 *
 * Allocation then respects price priority: an order that was willing to trade on
 * strictly better terms than p* fills before one that only just qualifies. Orders
 * at exactly p* are rationed pro-rata, because they are indistinguishable on
 * price and rationing them by arrival time would reintroduce the queue race this
 * design exists to remove.
 *
 * ALL ARITHMETIC IS INTEGER. Amounts are token base units, prices are quote
 * units per whole base unit, both 6 decimals on Coston2. Floating point is never
 * used: a rounding error here is a mispriced trade.
 */

import type { RestingOrder, Side } from "./order.js";

/** One trader's execution in a cleared batch. */
export interface Fill {
  trader: string;
  side: Side;
  /** Base units transacted. Always positive. */
  size: bigint;
  /**
   * Quote units this fill pays (BUY) or receives (SELL).
   *
   * Computed here, not on chain, and NOT simply floor(size * price / SCALE) per
   * fill. Both sides trade the same total base, but flooring each fill
   * separately makes the two quote totals diverge whenever one side has more
   * fills than the other, which would leave settlement a few units short and
   * revert the batch. Instead the total quote is computed once from the total
   * volume and then split across each side exactly, so both sides sum to the
   * same number by construction.
   */
  quote: bigint;
}

export interface ClearingResult {
  clearingPrice: bigint;
  /** Base units traded. Equal on both sides by construction. */
  volume: bigint;
  fills: Fill[];
}

/** Scale factor for prices: 6 decimals, matching FXRP and USDT0. */
export const PRICE_SCALE = 1_000_000n;

/**
 * Quote units owed for `size` base units at `price`.
 * Exported so settlement and tests use one definition of the conversion.
 */
export function quoteAmount(size: bigint, price: bigint): bigint {
  return (size * price) / PRICE_SCALE;
}

/**
 * Clear a batch. Returns null when nothing can trade, which is a normal
 * outcome, not an error: a batch of only buyers, or one where the best bid sits
 * below the best ask, simply does not cross.
 */
export function clear(orders: readonly RestingOrder[]): ClearingResult | null {
  const bids = orders.filter((o) => o.side === "BUY");
  const asks = orders.filter((o) => o.side === "SELL");
  if (bids.length === 0 || asks.length === 0) return null;

  const demandAt = (p: bigint) => sum(bids.filter((o) => o.limitPrice >= p));
  const supplyAt = (p: bigint) => sum(asks.filter((o) => o.limitPrice <= p));

  // Only prices present in the book can be optimal: executable volume is a step
  // function that changes only where an order's limit sits.
  const candidates = [...new Set(orders.map((o) => o.limitPrice))].sort(ascending);

  let bestVolume = 0n;
  let bestImbalance = 0n;
  let tied: bigint[] = [];

  for (const p of candidates) {
    const demand = demandAt(p);
    const supply = supplyAt(p);
    const volume = demand < supply ? demand : supply;
    if (volume === 0n) continue;

    const imbalance = abs(demand - supply);

    if (volume > bestVolume || (volume === bestVolume && imbalance < bestImbalance)) {
      bestVolume = volume;
      bestImbalance = imbalance;
      tied = [p];
    } else if (volume === bestVolume && imbalance === bestImbalance) {
      tied.push(p);
    }
  }

  if (bestVolume === 0n) return null;

  // Midpoint of the tied range. Integer division floors, which nudges the price
  // towards the buyer by at most one unit; documented rather than hidden.
  const clearingPrice = (tied[0]! + tied[tied.length - 1]!) / 2n;

  const totalQuote = quoteAmount(bestVolume, clearingPrice);
  const fills = [
    ...withQuote(allocate(bids, clearingPrice, bestVolume, "BUY"), totalQuote),
    ...withQuote(allocate(asks, clearingPrice, bestVolume, "SELL"), totalQuote),
  ];

  return { clearingPrice, volume: bestVolume, fills };
}

/**
 * Distribute `volume` across one side, honouring price priority and rationing
 * the marginal price level pro-rata.
 */
function allocate(
  side: readonly RestingOrder[],
  clearingPrice: bigint,
  volume: bigint,
  which: Side,
): Fill[] {
  // Eligible orders, best terms first: buyers who bid highest, sellers who ask
  // lowest. Ties keep book order, which is stable and therefore reproducible.
  const eligible = side
    .filter((o) => (which === "BUY" ? o.limitPrice >= clearingPrice : o.limitPrice <= clearingPrice))
    .map((o, i) => ({ o, i }))
    .sort((a, b) => {
      const cmp = which === "BUY" ? compare(b.o.limitPrice, a.o.limitPrice) : compare(a.o.limitPrice, b.o.limitPrice);
      return cmp !== 0 ? cmp : a.i - b.i;
    })
    .map((x) => x.o);

  const fills: Fill[] = [];
  let remaining = volume;

  for (let i = 0; i < eligible.length && remaining > 0n; ) {
    // Gather every order at this price level: they are indistinguishable.
    const price = eligible[i]!.limitPrice;
    const level: RestingOrder[] = [];
    while (i < eligible.length && eligible[i]!.limitPrice === price) {
      level.push(eligible[i]!);
      i++;
    }

    const levelTotal = sum(level);
    if (levelTotal <= remaining) {
      for (const o of level) fills.push({ trader: o.trader, side: which, size: o.size, quote: 0n });
      remaining -= levelTotal;
    } else {
      for (const f of prorate(level, remaining, which)) fills.push(f);
      remaining = 0n;
    }
  }

  return fills;
}

/**
 * Split `amount` across a price level in proportion to order size.
 *
 * Integer division loses a few units. The remainder is handed out one unit at a
 * time to the orders with the largest fractional entitlement, so the fills sum
 * to `amount` EXACTLY. Settlement requires both sides to net to zero, so an
 * off-by-one here would revert the whole batch.
 */
function prorate(level: readonly RestingOrder[], amount: bigint, which: Side): Fill[] {
  const total = sum(level);

  const parts = level.map((o, i) => {
    const numerator = o.size * amount;
    return { o, i, base: numerator / total, remainder: numerator % total };
  });

  let allocated = parts.reduce((acc, p) => acc + p.base, 0n);

  // Largest fractional part first; index breaks ties so the result is
  // deterministic and reproducible across enclaves.
  const order = [...parts].sort((a, b) => {
    const cmp = compare(b.remainder, a.remainder);
    return cmp !== 0 ? cmp : a.i - b.i;
  });

  const extra = new Map<number, bigint>();
  for (const p of order) {
    if (allocated >= amount) break;
    extra.set(p.i, (extra.get(p.i) ?? 0n) + 1n);
    allocated += 1n;
  }

  return parts
    .map((p) => ({
      trader: p.o.trader,
      side: which,
      size: p.base + (extra.get(p.i) ?? 0n),
      quote: 0n,
    }))
    .filter((f) => f.size > 0n);
}

/**
 * Split `totalQuote` across one side's fills in proportion to size, exactly.
 *
 * Same remainder rule as `prorate`: floor first, then hand out the shortfall to
 * the largest fractional entitlements, ties broken by index for determinism.
 * The result sums to `totalQuote` on both sides, which is what lets settlement
 * insist the quote legs net to zero.
 */
function withQuote(fills: Fill[], totalQuote: bigint): Fill[] {
  const totalSize = fills.reduce((a, f) => a + f.size, 0n);
  if (totalSize === 0n) return fills;

  const parts = fills.map((f, i) => {
    const numerator = f.size * totalQuote;
    return { f, i, base: numerator / totalSize, remainder: numerator % totalSize };
  });

  let allocated = parts.reduce((acc, p) => acc + p.base, 0n);
  const order = [...parts].sort((a, b) => {
    const cmp = compare(b.remainder, a.remainder);
    return cmp !== 0 ? cmp : a.i - b.i;
  });

  const extra = new Map<number, bigint>();
  for (const p of order) {
    if (allocated >= totalQuote) break;
    extra.set(p.i, (extra.get(p.i) ?? 0n) + 1n);
    allocated += 1n;
  }

  return parts.map((p) => ({ ...p.f, quote: p.base + (extra.get(p.i) ?? 0n) }));
}

function sum(orders: readonly RestingOrder[]): bigint {
  return orders.reduce((acc, o) => acc + o.size, 0n);
}

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

function compare(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function ascending(a: bigint, b: bigint): number {
  return compare(a, b);
}
