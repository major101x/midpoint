/**
 * Collateral tests.
 *
 * These exist because of a real failure: on 2026-08-04 the first live settlement
 * reverted with `Vault.InsufficientBalance` after a trader sold four FXRP across
 * two orders while holding three in the vault. The enclave had cleared blind.
 *
 * The damage is collective, which is what makes it worth guarding: one trader
 * overcommitting reverts the whole batch and strands everyone else in it.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  InsufficientCollateralError,
  commit,
  committedFor,
  releaseBatch,
  resetCollateral,
} from "../app/collateral.js";
import type { RestingOrder } from "../app/order.js";

const ALICE = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b0";

const sell = (size: bigint, trader = ALICE): RestingOrder => ({
  trader,
  side: "SELL",
  limitPrice: 1_000_000n,
  size,
});

const buy = (size: bigint, limitPrice = 1_000_000n, trader = ALICE): RestingOrder => ({
  trader,
  side: "BUY",
  limitPrice,
  size,
});

describe("collateral", () => {
  beforeEach(() => resetCollateral());

  it("accepts an order the balance covers", () => {
    expect(() => commit(1n, sell(2_000_000n), 3_000_000n, 0n)).not.toThrow();
    expect(committedFor(1n, ALICE).base).toBe(2_000_000n);
  });

  it("rejects a single order larger than the balance", () => {
    expect(() => commit(1n, sell(5_000_000n), 3_000_000n, 0n)).toThrow(
      InsufficientCollateralError,
    );
  });

  /**
   * The exact shape of the live failure. Each order fits on its own; together
   * they do not. Checking orders in isolation would let this through.
   */
  it("rejects the second of two orders that individually fit", () => {
    commit(1n, sell(2_000_000n), 3_000_000n, 0n);
    expect(() => commit(1n, sell(2_000_000n), 3_000_000n, 0n)).toThrow(
      /exceeds available base/,
    );
  });

  it("reserves buys at the limit price, which is an upper bound on what they pay", () => {
    // 2 base at a limit of 1.5 commits 3 quote.
    commit(1n, buy(2_000_000n, 1_500_000n), 0n, 3_000_000n);
    expect(committedFor(1n, ALICE).quote).toBe(3_000_000n);

    expect(() => commit(1n, buy(1n, 1_500_000n), 0n, 3_000_000n)).toThrow(
      /exceeds available quote/,
    );
  });

  it("keeps the two sides independent", () => {
    commit(1n, sell(3_000_000n), 3_000_000n, 5_000_000n);
    // Base is exhausted, but a buy draws on quote and still fits.
    expect(() => commit(1n, buy(2_000_000n), 3_000_000n, 5_000_000n)).not.toThrow();
  });

  it("tracks traders separately", () => {
    commit(1n, sell(3_000_000n, ALICE), 3_000_000n, 0n);
    expect(() => commit(1n, sell(3_000_000n, BOB), 3_000_000n, 0n)).not.toThrow();
  });

  it("tracks batches separately", () => {
    commit(1n, sell(3_000_000n), 3_000_000n, 0n);
    expect(() => commit(2n, sell(3_000_000n), 3_000_000n, 0n)).not.toThrow();
  });

  /** A later order sees a larger balance if the trader topped up in between. */
  it("honours a balance that grew between orders", () => {
    commit(1n, sell(3_000_000n), 3_000_000n, 0n);
    expect(() => commit(1n, sell(1_000_000n), 4_000_000n, 0n)).not.toThrow();
  });

  it("releases a batch once it clears", () => {
    commit(1n, sell(3_000_000n), 3_000_000n, 0n);
    releaseBatch(1n);
    expect(committedFor(1n, ALICE).base).toBe(0n);
    expect(() => commit(1n, sell(3_000_000n), 3_000_000n, 0n)).not.toThrow();
  });

  /** Error strings surface in action results that anyone can read. */
  it("names no amounts in its error", () => {
    try {
      commit(1n, sell(9_999_999n), 3n, 0n);
      throw new Error("expected a throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain("9999999");
      expect(msg).not.toContain("3");
    }
  });
});
