/**
 * ★ What a trader can actually afford to have filled.
 *
 * WHY THIS EXISTS. The enclave clears the book, but the vault holds the money
 * and the enclave cannot read it. Without a check here, the enclave will happily
 * sign a perfectly valid settlement that the vault cannot execute: the transfer
 * reverts, the whole batch reverts with it, and every trader in that batch is
 * stuck until someone voids it. One trader overcommitting punishes everyone else
 * in the batch, which is the part that makes this worth guarding rather than
 * leaving to chance.
 *
 * `OrderBook` therefore reads the submitter's vault balances on chain and sends
 * them along with the order. That leaks nothing, because vault balances are
 * already public and anyone can read them directly.
 *
 * The commitment is deliberately conservative:
 *
 *   SELL  commits `size` base units. The seller must deliver exactly that.
 *   BUY   commits `size * limitPrice` quote units. Buyers pay the clearing
 *         price, which is never worse than their limit, so reserving at the
 *         limit is an upper bound and can never under-reserve.
 *
 * Commitments accumulate per trader per batch. Checking each order in isolation
 * would let someone submit five orders that each fit their balance and together
 * do not.
 */

import { quoteAmount } from "./auction.js";
import type { RestingOrder } from "./order.js";

export class InsufficientCollateralError extends Error {}

interface Committed {
  base: bigint;
  quote: bigint;
}

/** Running commitments, keyed by batch then by trader. */
const committed = new Map<string, Map<string, Committed>>();

export function resetCollateral(): void {
  committed.clear();
}

/** Drop a batch's commitments once it has cleared or been abandoned. */
export function releaseBatch(batchId: bigint): void {
  committed.delete(batchId.toString());
}

/**
 * Record an order against the trader's balance, or reject it.
 *
 * @throws InsufficientCollateralError if this order would push the trader past
 * what their vault balance can cover. The message deliberately names no amount:
 * it surfaces in an action result that anyone can read.
 */
export function commit(
  batchId: bigint,
  order: RestingOrder,
  baseBalance: bigint,
  quoteBalance: bigint,
): void {
  const batchKey = batchId.toString();
  const traderKey = order.trader.toLowerCase();

  const byTrader = committed.get(batchKey) ?? new Map<string, Committed>();
  const current = byTrader.get(traderKey) ?? { base: 0n, quote: 0n };

  let next: Committed;
  if (order.side === "SELL") {
    next = { base: current.base + order.size, quote: current.quote };
    if (next.base > baseBalance) {
      throw new InsufficientCollateralError("order exceeds available base balance");
    }
  } else {
    // Upper bound: buyers never pay more than their own limit.
    next = { base: current.base, quote: current.quote + quoteAmount(order.size, order.limitPrice) };
    if (next.quote > quoteBalance) {
      throw new InsufficientCollateralError("order exceeds available quote balance");
    }
  }

  byTrader.set(traderKey, next);
  committed.set(batchKey, byTrader);
}

/** Test helper. Not part of the wire contract. */
export function committedFor(batchId: bigint, trader: string): Committed {
  return (
    committed.get(batchId.toString())?.get(trader.toLowerCase()) ?? { base: 0n, quote: 0n }
  );
}
