/**
 * ★ ABI decoding for the Midpoint operations.
 *
 * OrderBook.submitOrder sends abi.encode(address trader, uint256 batchId,
 * bytes ciphertext). The trader and batch id are supplied by the contract, NOT
 * by the person submitting, which is what lets the enclave reject a ciphertext
 * copied out of someone else's public transaction and replayed.
 *
 * OrderBook.closeBatch sends abi.encode(uint256 batchId).
 */

import {decodeAbiParameters, encodeAbiParameters, type Hex} from "viem";

const SUBMIT_ORDER_PARAMS = [
  {name: "trader", type: "address"},
  {name: "batchId", type: "uint256"},
  {name: "baseBalance", type: "uint256"},
  {name: "quoteBalance", type: "uint256"},
  {name: "ciphertext", type: "bytes"},
] as const;

const RUN_MATCH_PARAMS = [{name: "batchId", type: "uint256"}] as const;

export interface SubmitOrderEnvelope {
  /** Authoritative submitter, taken from msg.sender on chain. */
  trader: `0x${string}`;
  batchId: bigint;
  /**
   * The trader's vault balances, read on chain at submission.
   *
   * The enclave cannot see the vault, so without these it clears blind and can
   * sign a settlement the vault cannot execute, which reverts the batch and
   * strands everyone in it. Passing them leaks nothing: vault balances are
   * already public.
   */
  baseBalance: bigint;
  quoteBalance: bigint;
  /** Encrypted to the enclave's public key. Opaque until decrypted. */
  ciphertext: Hex;
}

export function decodeSubmitOrder(data: Hex): SubmitOrderEnvelope {
  try {
    const [trader, batchId, baseBalance, quoteBalance, ciphertext] = decodeAbiParameters(
      SUBMIT_ORDER_PARAMS,
      data,
    );
    return {trader, batchId, baseBalance, quoteBalance, ciphertext};
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

/**
 * The settlement payload the enclave signs and Settlement.sol verifies.
 *
 * Encoded exactly as Solidity would encode
 *   (uint256 batchId, uint256 clearingPrice, Fill[] fills)
 * with Fill = (address trader, uint8 side, uint256 size), side 0 = BUY, 1 = SELL.
 *
 * Both sides must agree byte for byte: the signature is over keccak256 of these
 * bytes, so any encoding difference makes every settlement fail verification.
 */
const SETTLEMENT_PARAMS = [
  {name: "batchId", type: "uint256"},
  {name: "clearingPrice", type: "uint256"},
  {
    name: "fills",
    type: "tuple[]",
    components: [
      {name: "trader", type: "address"},
      {name: "side", type: "uint8"},
      {name: "size", type: "uint256"},
      {name: "quote", type: "uint256"},
    ],
  },
] as const;

export interface EncodableFill {
  trader: `0x${string}`;
  side: 0 | 1;
  size: bigint;
  quote: bigint;
}

export function encodeSettlement(
  batchId: bigint,
  clearingPrice: bigint,
  fills: readonly EncodableFill[],
): Hex {
  return encodeAbiParameters(SETTLEMENT_PARAMS, [batchId, clearingPrice, fills]);
}
