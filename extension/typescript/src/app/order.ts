/**
 * ★ The plaintext order, as it exists only inside the enclave.
 *
 * Traders encrypt this JSON to the enclave's public key. Nothing outside the
 * TEE ever sees it: on chain it is an opaque blob, and the handler never echoes
 * any of it back through an action result or GET /state.
 *
 * `trader` and `batchId` are duplicated here even though OrderBook already
 * supplies both from msg.sender. That redundancy IS the replay protection: the
 * handler rejects the order unless the pair inside the ciphertext matches the
 * pair the contract vouched for, so a ciphertext copied out of someone else's
 * public transaction cannot be resubmitted by, or credited to, anyone else, in
 * this batch or a later one.
 */

export type Side = "BUY" | "SELL";

export interface PlainOrder {
  trader: string;
  batchId: string;
  side: Side;
  /** Quote units per whole base unit, integer, 6 decimals. Never a float. */
  limitPrice: string;
  /** Base units, integer, 6 decimals. */
  size: string;
  /** Random, so two identical orders do not produce comparable ciphertexts. */
  nonce: string;
}

/** A validated order held in the book. Amounts are bigint from here on. */
export interface RestingOrder {
  trader: string;
  side: Side;
  limitPrice: bigint;
  size: bigint;
}

export class OrderValidationError extends Error {}

/**
 * Parse and validate a decrypted order against the envelope the contract
 * vouched for. Throws OrderValidationError with a reason that is safe to log:
 * it must never contain a price or size, because handler errors surface in
 * action results that anyone can read through the proxy.
 */
export function parseOrder(
  plaintext: Uint8Array,
  expectedTrader: string,
  expectedBatchId: bigint,
): RestingOrder {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(plaintext).toString("utf-8"));
  } catch {
    throw new OrderValidationError("plaintext is not JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new OrderValidationError("plaintext is not an object");
  }
  const o = raw as Partial<PlainOrder>;

  if (typeof o.trader !== "string") throw new OrderValidationError("trader missing");
  if (o.trader.toLowerCase() !== expectedTrader.toLowerCase()) {
    // Someone replayed a ciphertext they did not create.
    throw new OrderValidationError("trader does not match submitter");
  }

  if (typeof o.batchId !== "string") throw new OrderValidationError("batchId missing");
  let batchId: bigint;
  try {
    batchId = BigInt(o.batchId);
  } catch {
    throw new OrderValidationError("batchId is not an integer");
  }
  if (batchId !== expectedBatchId) {
    // Replay of a ciphertext from an earlier batch.
    throw new OrderValidationError("batchId does not match");
  }

  if (o.side !== "BUY" && o.side !== "SELL") {
    throw new OrderValidationError("side must be BUY or SELL");
  }

  const limitPrice = parsePositive(o.limitPrice, "limitPrice");
  const size = parsePositive(o.size, "size");

  if (typeof o.nonce !== "string" || o.nonce.length === 0) {
    throw new OrderValidationError("nonce missing");
  }

  return {trader: o.trader.toLowerCase(), side: o.side, limitPrice, size};
}

function parsePositive(v: unknown, name: string): bigint {
  if (typeof v !== "string" || !/^[0-9]+$/.test(v)) {
    throw new OrderValidationError(`${name} must be a decimal integer string`);
  }
  const n = BigInt(v);
  if (n <= 0n) throw new OrderValidationError(`${name} must be positive`);
  return n;
}
