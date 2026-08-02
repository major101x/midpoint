/**
 * Building and sealing an order.
 *
 * Amounts are integers in the token's own units. Both Coston2 tokens use 6
 * decimals, so 1 FXRP is 1_000_000 and a price of $1.064 is 1_064_000. Floats
 * are never used: a rounding error here becomes a mispriced trade.
 */

import { randomBytes } from "@noble/hashes/utils";

import { eciesEncrypt } from "./ecies.js";

export type Side = "BUY" | "SELL";

export interface OrderInput {
  trader: `0x${string}`;
  batchId: bigint;
  side: Side;
  /** Quote units per whole base unit. 6 decimals. */
  limitPrice: bigint;
  /** Base units. 6 decimals. */
  size: bigint;
}

/**
 * Serialize an order to the exact JSON the enclave expects.
 *
 * `trader` and `batchId` are included even though OrderBook supplies both from
 * msg.sender, because the enclave compares the two. That comparison is what
 * stops a ciphertext lifted from a public transaction being replayed by someone
 * else or into a later batch.
 *
 * `nonce` is random so that two economically identical orders do not produce
 * identical ciphertexts, which would let an observer correlate them.
 */
export function serializeOrder(o: OrderInput): Uint8Array {
  if (o.limitPrice <= 0n) throw new Error("limitPrice must be positive");
  if (o.size <= 0n) throw new Error("size must be positive");

  const payload = {
    trader: o.trader.toLowerCase(),
    batchId: o.batchId.toString(),
    side: o.side,
    limitPrice: o.limitPrice.toString(),
    size: o.size.toString(),
    nonce: Buffer.from(randomBytes(16)).toString("hex"),
  };
  return new Uint8Array(Buffer.from(JSON.stringify(payload), "utf-8"));
}

/** Serialize and encrypt an order to the enclave's public key. */
export function sealOrder(teePublicKey: Uint8Array, o: OrderInput): `0x${string}` {
  const sealed = eciesEncrypt(teePublicKey, serializeOrder(o));
  return `0x${Buffer.from(sealed).toString("hex")}`;
}
