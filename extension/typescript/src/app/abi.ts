/**
 * ★ ABI decoding for the Sealed operations.
 *
 * OrderBook.submitOrder sends abi.encode(address trader, uint256 batchId,
 * bytes ciphertext). The trader and batch id are supplied by the contract, NOT
 * by the person submitting, which is what lets the enclave reject a ciphertext
 * copied out of someone else's public transaction and replayed.
 *
 * OrderBook.closeBatch sends abi.encode(uint256 batchId).
 */

import {decodeAbiParameters, type Hex} from "viem";

const SUBMIT_ORDER_PARAMS = [
  {name: "trader", type: "address"},
  {name: "batchId", type: "uint256"},
  {name: "ciphertext", type: "bytes"},
] as const;

const RUN_MATCH_PARAMS = [{name: "batchId", type: "uint256"}] as const;

export interface SubmitOrderEnvelope {
  /** Authoritative submitter, taken from msg.sender on chain. */
  trader: `0x${string}`;
  batchId: bigint;
  /** Encrypted to the enclave's public key. Opaque until decrypted. */
  ciphertext: Hex;
}

export function decodeSubmitOrder(data: Hex): SubmitOrderEnvelope {
  try {
    const [trader, batchId, ciphertext] = decodeAbiParameters(SUBMIT_ORDER_PARAMS, data);
    return {trader, batchId, ciphertext};
  } catch (e) {
    throw new Error(`ABI decode failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function decodeRunMatch(data: Hex): {batchId: bigint} {
  try {
    const [batchId] = decodeAbiParameters(RUN_MATCH_PARAMS, data);
    return {batchId};
  } catch (e) {
    throw new Error(`ABI decode failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
