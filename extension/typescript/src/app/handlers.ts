/**
 * ★ MAIN CUSTOMIZATION POINT: the Sealed venue's handlers.
 *
 * This module holds the order book. It is the only place in the system where
 * order contents are legible, and it lives inside the enclave, so nothing here
 * may be exposed through reportState() or through an action result.
 *
 * Handler contract:
 *   (originalMessageHex) => [dataHexOrNull, status, errorOrNull]
 *   status 0 = error, 1 = success. See docs/extension-contract.md §4.6.
 *
 * The framework serializes handler calls, so plain module-level state is safe.
 */

import { bytesToHex, hexToBytes } from "../base/encoding.js";
import { NodeClient } from "../base/node.js";
import type { Framework, HandlerResult } from "../base/types.js";

import { decodeRunMatch, decodeSubmitOrder, encodeSettlement, type EncodableFill } from "./abi.js";
import { clear } from "./auction.js";
import {
  OP_COMMAND_RUN_MATCH,
  OP_COMMAND_SUBMIT_ORDER,
  OP_TYPE_SEALED,
} from "./config.js";
import {
  InsufficientCollateralError,
  commit,
  releaseBatch,
  resetCollateral,
} from "./collateral.js";
import { OrderValidationError, parseOrder, type RestingOrder } from "./order.js";
import { teeSigner, type Signer } from "./sign.js";

// --- Private state -----------------------------------------------------------
// Keyed by batch so a late order for a closed batch cannot slip in.
const books = new Map<string, RestingOrder[]>();
let lastClearedBatch = 0n;
let lastClearingPrice = 0n;

/** Decrypts a ciphertext to plaintext. Swapped out in tests. */
export type Decryptor = (ciphertext: Uint8Array) => Promise<Uint8Array>;

let decryptor: Decryptor = async () => {
  throw new Error("decryptor not configured");
};

let signer: Signer = async () => {
  throw new Error("signer not configured");
};

/** Called once at startup with the tee-node sign port. */
export function configure(signPort: string | number): void {
  const client = new NodeClient(signPort);
  decryptor = (ct) => client.decrypt(ct);
  signer = teeSigner(signPort);
}

/** Test seam. Not used in production. */
export function setDecryptor(fn: Decryptor): void {
  decryptor = fn;
}

/** Test seam. Not used in production. */
export function setSigner(fn: Signer): void {
  signer = fn;
}

export function resetState(): void {
  books.clear();
  resetCollateral();
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
export async function handleSubmitOrder(msg: string): Promise<HandlerResult> {
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

  let plaintext: Uint8Array;
  try {
    plaintext = await decryptor(hexToBytes(envelope.ciphertext));
  } catch {
    // Deliberately terse. This string is readable through the proxy, and a
    // detailed failure reason could hint at the ciphertext's structure.
    return [null, 0, "decryption failed"];
  }

  let order: RestingOrder;
  try {
    order = parseOrder(plaintext, envelope.trader, envelope.batchId);
  } catch (e) {
    if (e instanceof OrderValidationError) return [null, 0, `invalid order: ${e.message}`];
    return [null, 0, "invalid order"];
  }

  // Reject anything the trader's vault balance cannot cover. Without this the
  // enclave signs a settlement the vault refuses, reverting the batch and
  // stranding every other trader in it.
  try {
    commit(envelope.batchId, order, envelope.baseBalance, envelope.quoteBalance);
  } catch (e) {
    if (e instanceof InsufficientCollateralError) return [null, 0, e.message];
    throw e;
  }

  const key = envelope.batchId.toString();
  const book = books.get(key) ?? [];
  book.push(order);
  books.set(key, book);

  // Acknowledge with a count only. Echoing anything order-specific would leak
  // it, because action results are readable through the proxy.
  const resp = { batchId: key, accepted: true, ordersInBatch: book.length };
  return [bytesToHex(Buffer.from(JSON.stringify(resp), "utf-8")), 1, null];
}

/** SEALED/RUN_MATCH. Payload is abi.encode(uint256 batchId). */
export async function handleRunMatch(msg: string): Promise<HandlerResult> {
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

  const result = clear(book);
  const clearingPrice = result?.clearingPrice ?? 0n;
  const fills: EncodableFill[] = (result?.fills ?? []).map((f) => ({
    trader: f.trader as `0x${string}`,
    side: f.side === "BUY" ? 0 : 1,
    size: f.size,
    quote: f.quote,
  }));

  const payload = encodeSettlement(batchId, clearingPrice, fills);

  let signature: Uint8Array;
  try {
    signature = await signer(hexToBytes(payload));
  } catch (e) {
    // Without a signature the batch cannot settle. Report failure so the batch
    // can be retried or voided rather than silently losing the book.
    return [null, 0, `signing failed: ${e instanceof Error ? e.message : String(e)}`];
  }

  // Consume the book only once a signature exists. Deleting earlier would mean a
  // signing failure destroyed the batch with no way to retry it. A batch that
  // does not cross still clears, as an empty settlement, so funds unfreeze.
  books.delete(key);
  releaseBatch(batchId);
  lastClearedBatch = batchId;
  lastClearingPrice = clearingPrice;

  // The response carries the settlement payload and its signature. This is the
  // only order-derived data that ever leaves the enclave, and it is exactly what
  // settlement already makes public: a clearing price and net movements. Resting
  // orders that did not fill are never mentioned.
  const resp = {
    batchId: key,
    clearingPrice: clearingPrice.toString(),
    volume: (result?.volume ?? 0n).toString(),
    payload,
    signature: bytesToHex(signature),
  };
  return [bytesToHex(Buffer.from(JSON.stringify(resp), "utf-8")), 1, null];
}
