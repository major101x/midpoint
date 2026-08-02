/**
 * Order validation, including the replay protections.
 *
 * The trader and batchId inside the ciphertext are checked against the values
 * OrderBook vouched for from msg.sender. Those two checks are the whole reason
 * the fields are duplicated, so they are tested as adversarial scenarios rather
 * than as field validation.
 */

import { describe, expect, it } from "vitest";

import { OrderValidationError, parseOrder } from "../app/order.js";

const ALICE = "0x00000000000000000000000000000000000000a1";
const EVE = "0x00000000000000000000000000000000000000ee";

function encode(o: Record<string, unknown>): Uint8Array {
  return Buffer.from(JSON.stringify(o), "utf-8");
}

function validOrder(overrides: Record<string, unknown> = {}) {
  return encode({
    trader: ALICE,
    batchId: "1",
    side: "BUY",
    limitPrice: "1064000",
    size: "5000000",
    nonce: "abc123",
    ...overrides,
  });
}

describe("parseOrder", () => {
  it("accepts a well-formed order", () => {
    const o = parseOrder(validOrder(), ALICE, 1n);
    expect(o).toEqual({
      trader: ALICE,
      side: "BUY",
      limitPrice: 1064000n,
      size: 5000000n,
    });
  });

  it("is case insensitive about the trader address", () => {
    const o = parseOrder(validOrder({ trader: ALICE.toUpperCase().replace("0X", "0x") }), ALICE, 1n);
    expect(o.trader).toBe(ALICE);
  });

  /**
   * Eve lifts Alice's ciphertext out of a public transaction and submits it as
   * her own. The contract stamps Eve as the submitter, so the inner trader no
   * longer matches and the enclave throws it out.
   */
  it("rejects a ciphertext replayed by a different trader", () => {
    expect(() => parseOrder(validOrder(), EVE, 1n)).toThrow(OrderValidationError);
    expect(() => parseOrder(validOrder(), EVE, 1n)).toThrow(/trader does not match/);
  });

  /** The same ciphertext resubmitted in a later batch. */
  it("rejects a ciphertext replayed into a different batch", () => {
    expect(() => parseOrder(validOrder(), ALICE, 2n)).toThrow(/batchId does not match/);
  });

  it("rejects an unknown side", () => {
    expect(() => parseOrder(validOrder({ side: "HOLD" }), ALICE, 1n)).toThrow(/side must be/);
  });

  it("rejects a zero or negative size", () => {
    expect(() => parseOrder(validOrder({ size: "0" }), ALICE, 1n)).toThrow(/size must be positive/);
  });

  it("rejects a non-integer price", () => {
    expect(() => parseOrder(validOrder({ limitPrice: "1.5" }), ALICE, 1n)).toThrow(
      /limitPrice must be a decimal integer/,
    );
  });

  /** Floats would silently lose precision on 6-decimal amounts. */
  it("rejects numeric JSON amounts, requiring strings", () => {
    expect(() => parseOrder(validOrder({ size: 5000000 }), ALICE, 1n)).toThrow(
      /size must be a decimal integer/,
    );
  });

  it("rejects a missing nonce", () => {
    expect(() => parseOrder(validOrder({ nonce: "" }), ALICE, 1n)).toThrow(/nonce missing/);
  });

  it("rejects non-JSON plaintext", () => {
    expect(() => parseOrder(Buffer.from("garbage"), ALICE, 1n)).toThrow(/not JSON/);
  });

  /** Error messages surface in action results, which anyone can read. */
  it("never puts a price or size into an error message", () => {
    const secretPrice = "999999";
    const secretSize = "424242";
    try {
      parseOrder(
        validOrder({ side: "HOLD", limitPrice: secretPrice, size: secretSize }),
        ALICE,
        1n,
      );
      throw new Error("expected a throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain(secretPrice);
      expect(msg).not.toContain(secretSize);
    }
  });
});
