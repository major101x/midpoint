/**
 * ★ MAIN CUSTOMIZATION POINT: the Sealed venue's handlers.
 *
 * This module holds the order book. It is the only place in the system where
 * order contents are legible, and it lives inside the enclave, so nothing here
 * may be exposed through reportState().
 *
 * Handler contract:
 *   (originalMessageHex) => [dataHexOrNull, status, errorOrNull]
 *   status 0 = error, 1 = success. See docs/extension-contract.md §4.6.
 *
 * The framework serializes handler calls, so plain module-level state is safe.
 */

import { bytesToHex, hexToBytes } from "../base/encoding.js";
import type { Framework, HandlerResult } from "../base/types.js";

import { decodeRunMatch, decodeSubmitOrder } from "./abi.js";
import {
  OP_COMMAND_RUN_MATCH,
  OP_COMMAND_SUBMIT_ORDER,
  OP_TYPE_SEALED,
} from "./config.js";

/** A single resting order. Never leaves the enclave in readable form. */
interface RestingOrder {
  trader: `0x${string}`;
  /** Still encrypted. Decryption lands with the sign-port work. */
  ciphertext: string;
}

// --- Private state -----------------------------------------------------------
// Keyed by batch so a late order for a closed batch cannot slip in.
const books = new Map<string, RestingOrder[]>();
let lastClearedBatch = 0n;
let lastClearingPrice = 0n;

export function resetState(): void {
  books.clear();
  lastClearedBatch = 0n;
  lastClearingPrice = 0n;
}

export function register(framework: Framework): void {
  framework.handle(OP_TYPE_SEALED, OP_COMMAND_SUBMIT_ORDER, handleSubmitOrder);
  framework.handle(OP_TYPE_SEALED, OP_COMMAND_RUN_MATCH, handleRunMatch);
}

/**
 * Snapshot returned by GET /state.
 *
 * DELIBERATELY AGGREGATE ONLY. Order counts and the last clearing price are
 * already public on chain. Sides, prices, sizes and who placed what must never
 * appear here: /state is reachable from outside the enclave, and publishing the
 * book would defeat the entire venue.
 */
export function reportState(): unknown {
  let openOrders = 0;
  for (const orders of books.values()) openOrders += orders.length;
  return {
    openBatches: books.size,
    openOrders,
    lastClearedBatch: lastClearedBatch.toString(),
    lastClearingPrice: lastClearingPrice.toString(),
  };
}

/** SEALED/SUBMIT_ORDER. Payload is abi.encode(address, uint256, bytes). */
export function handleSubmitOrder(msg: string): HandlerResult {
  let hex: string;
  try {
    hex = bytesToHex(hexToBytes(msg));
  } catch (e) {
    return [null, 0, `decoding request: invalid hex: ${String(e)}`];
  }

  let envelope;
  try {
    envelope = decodeSubmitOrder(hex as `0x${string}`);
  } catch (e) {
    return [null, 0, `decoding request: ${e instanceof Error ? e.message : String(e)}`];
  }

  if (envelope.ciphertext.length <= 2) {
    return [null, 0, "ciphertext must not be empty"];
  }

  // TODO(day 6): decrypt via NodeClient, then reject unless the trader named
  // inside the plaintext equals envelope.trader. That equality check is what
  // stops a replayed ciphertext being credited to the replayer.
  const key = envelope.batchId.toString();
  const book = books.get(key) ?? [];
  book.push({ trader: envelope.trader, ciphertext: envelope.ciphertext });
  books.set(key, book);

  // Acknowledge with a count only. Echoing anything order-specific would leak
  // it, because action results are readable through the proxy.
  const resp = { batchId: key, accepted: true, ordersInBatch: book.length };
  return [bytesToHex(Buffer.from(JSON.stringify(resp), "utf-8")), 1, null];
}

/** SEALED/RUN_MATCH. Payload is abi.encode(uint256 batchId). */
export function handleRunMatch(msg: string): HandlerResult {
  let hex: string;
  try {
    hex = bytesToHex(hexToBytes(msg));
  } catch (e) {
    return [null, 0, `decoding request: invalid hex: ${String(e)}`];
  }

  let batchId: bigint;
  try {
    ({ batchId } = decodeRunMatch(hex as `0x${string}`));
  } catch (e) {
    return [null, 0, `decoding request: ${e instanceof Error ? e.message : String(e)}`];
  }

  const key = batchId.toString();
  const book = books.get(key);
  if (book === undefined || book.length === 0) {
    return [null, 0, `no orders for batch ${key}`];
  }

  // TODO(day 7): uniform-price clearing over the decrypted book, then sign the
  // settlement payload with the in-enclave key (spec Q1).
  lastClearedBatch = batchId;
  books.delete(key);

  const resp = {
    batchId: key,
    orders: book.length,
    cleared: false,
    reason: "clearing not yet implemented",
  };
  return [bytesToHex(Buffer.from(JSON.stringify(resp), "utf-8")), 1, null];
}
