/**
 * Handler tests for the Midpoint venue.
 *
 * The confidentiality assertions are the important ones. A venue that clears
 * correctly but leaks its book is worthless, so "state never exposes an order"
 * is tested as a first-class property rather than assumed.
 */

import { encodeAbiParameters } from "viem";
import { beforeEach, describe, expect, it } from "vitest";

import {
  handleRunMatch,
  handleSubmitOrder,
  reportState,
  resetState,
  setDecryptor,
  setSigner,
} from "../app/handlers.js";
import { bytesToHex, hexToBytes } from "../base/encoding.js";

const SUBMIT_PARAMS = [
  { name: "trader", type: "address" },
  { name: "batchId", type: "uint256" },
  { name: "baseBalance", type: "uint256" },
  { name: "quoteBalance", type: "uint256" },
  { name: "ciphertext", type: "bytes" },
] as const;

const MATCH_PARAMS = [{ name: "batchId", type: "uint256" }] as const;

/** Balances large enough that collateral is never the thing under test here. */
const PLENTY = 10n ** 24n;

const ALICE = "0x00000000000000000000000000000000000000A1" as const;

/** Builds a plaintext order and returns it as a fake "ciphertext" hex blob. */
function order(
  trader: string,
  batchId: bigint,
  overrides: Record<string, unknown> = {},
): `0x${string}` {
  const o = {
    trader,
    batchId: batchId.toString(),
    side: "BUY",
    limitPrice: "1064000",
    size: "5000000",
    nonce: "n1",
    ...overrides,
  };
  return `0x${Buffer.from(JSON.stringify(o), "utf-8").toString("hex")}`;
}

/** Identity decryptor: tests supply plaintext directly as the ciphertext. */
beforeEach(() => {
  setDecryptor(async (ct) => ct);
  // Deterministic stub signature; the real one is exercised on chain.
  setSigner(async () => new Uint8Array(65).fill(7));
});
const BOB = "0x00000000000000000000000000000000000000b0" as const;

/** Same envelope, but with balances the caller controls. */
function submitMsgWithBalances(
  trader: `0x${string}`,
  batchId: bigint,
  ciphertext: `0x${string}`,
  base: bigint,
  quote: bigint,
): string {
  return bytesToHex(
    hexToBytes(encodeAbiParameters(SUBMIT_PARAMS, [trader, batchId, base, quote, ciphertext])),
  );
}

function submitMsg(trader: `0x${string}`, batchId: bigint, ciphertext: `0x${string}`): string {
  return bytesToHex(hexToBytes(encodeAbiParameters(SUBMIT_PARAMS, [trader, batchId, PLENTY, PLENTY, ciphertext])));
}

function matchMsg(batchId: bigint): string {
  return bytesToHex(hexToBytes(encodeAbiParameters(MATCH_PARAMS, [batchId])));
}

function decodeData(dataHex: string | null): Record<string, unknown> {
  if (dataHex === null) throw new Error("expected data");
  return JSON.parse(Buffer.from(hexToBytes(dataHex)).toString("utf-8"));
}

describe("SUBMIT_ORDER", () => {
  beforeEach(() => resetState());

  it("accepts an order and counts it against its batch", async () => {
    const [data, status, err] = await handleSubmitOrder(submitMsg(ALICE, 1n, order(ALICE, 1n)));
    expect(err).toBeNull();
    expect(status).toBe(1);
    expect(decodeData(data)).toEqual({ batchId: "1", accepted: true, ordersInBatch: 1 });
  });

  it("keeps separate books per batch", async () => {
    await handleSubmitOrder(submitMsg(ALICE, 1n, order(ALICE, 1n)));
    await handleSubmitOrder(submitMsg(BOB, 1n, order(BOB, 1n)));
    const [data] = await handleSubmitOrder(submitMsg(ALICE, 2n, order(ALICE, 2n)));
    expect(decodeData(data).ordersInBatch).toBe(1);
    expect((reportState() as { openBatches: number }).openBatches).toBe(2);
  });

  /**
   * The live failure of 2026-08-04, at the handler level. Two sells that each
   * fit the balance but together do not. Letting the second through would have
   * the enclave sign a settlement the vault refuses, reverting the batch for
   * everyone in it.
   */
  it("rejects an order the trader's vault balance cannot cover", async () => {
    const threeFxrp = 3_000_000n;
    const twoFxrp = { size: "2000000", side: "SELL" };

    const first = await handleSubmitOrder(
      submitMsgWithBalances(ALICE, 1n, order(ALICE, 1n, twoFxrp), threeFxrp, 0n),
    );
    expect(first[1]).toBe(1);

    const second = await handleSubmitOrder(
      submitMsgWithBalances(ALICE, 1n, order(ALICE, 1n, twoFxrp), threeFxrp, 0n),
    );
    expect(second[1]).toBe(0);
    expect(second[2]).toContain("exceeds available base");

    // The rejected order is not in the book.
    expect((reportState() as { openOrders: number }).openOrders).toBe(1);
  });

  it("rejects an empty ciphertext", async () => {
    const [, status, err] = await handleSubmitOrder(submitMsg(ALICE, 1n, "0x"));
    expect(status).toBe(0);
    expect(err).toContain("ciphertext");
  });

  it("rejects malformed hex", async () => {
    const [, status, err] = await handleSubmitOrder("nonsense");
    expect(status).toBe(0);
    expect(err).toContain("decoding request");
  });

  it("rejects a payload that is not the expected ABI shape", async () => {
    const [, status, err] = await handleSubmitOrder("0x1234");
    expect(status).toBe(0);
    expect(err).toContain("decoding request");
  });
});

describe("RUN_MATCH", () => {
  beforeEach(() => resetState());

  it("consumes the batch it cleared", async () => {
    await handleSubmitOrder(submitMsg(ALICE, 1n, order(ALICE, 1n)));
    await handleSubmitOrder(submitMsg(BOB, 1n, order(BOB, 1n)));

    const [data, status, err] = await handleRunMatch(matchMsg(1n));
    expect(err).toBeNull();
    expect(status).toBe(1);
    expect(decodeData(data).batchId).toBe('1');
    expect((reportState() as { openBatches: number }).openBatches).toBe(0);
  });

  it("refuses to clear a batch with no orders", async () => {
    const [, status, err] = await handleRunMatch(matchMsg(99n));
    expect(status).toBe(0);
    expect(err).toContain("no orders");
  });

  it("refuses to clear the same batch twice", async () => {
    await handleSubmitOrder(submitMsg(ALICE, 1n, order(ALICE, 1n)));
    expect((await handleRunMatch(matchMsg(1n)))[1]).toBe(1);
    expect((await handleRunMatch(matchMsg(1n)))[1]).toBe(0);
  });

  /**
   * A signing failure must not destroy the book. If RUN_MATCH consumed the
   * batch before obtaining a signature, an unreachable sign port would lose
   * every order in it with no way to retry or void the batch on chain.
   */
  it("keeps the book when signing fails, so the batch can be retried", async () => {
    await handleSubmitOrder(submitMsg(ALICE, 1n, order(ALICE, 1n)));
    setSigner(async () => {
      throw new Error("sign port unreachable");
    });

    const [, status, err] = await handleRunMatch(matchMsg(1n));
    expect(status).toBe(0);
    expect(err).toContain("signing failed");
    // Still there.
    expect((reportState() as { openOrders: number }).openOrders).toBe(1);

    // And a retry once signing recovers succeeds.
    setSigner(async () => new Uint8Array(65).fill(7));
    expect((await handleRunMatch(matchMsg(1n)))[1]).toBe(1);
    expect((reportState() as { openOrders: number }).openOrders).toBe(0);
  });

  it("leaves other batches untouched", async () => {
    await handleSubmitOrder(submitMsg(ALICE, 1n, order(ALICE, 1n)));
    await handleSubmitOrder(submitMsg(BOB, 2n, order(BOB, 2n)));
    await handleRunMatch(matchMsg(1n));
    expect((reportState() as { openOrders: number }).openOrders).toBe(1);
  });
});

describe("state confidentiality", () => {
  beforeEach(() => resetState());

  /**
   * GET /state is reachable from outside the enclave. If any part of an order
   * reaches it the venue is pointless, so this asserts on the serialized bytes
   * rather than on named fields, which a nested leak could slip past.
   */
  it("never exposes ciphertext or trader", async () => {
    await handleSubmitOrder(submitMsg(ALICE, 1n, order(ALICE, 1n, {limitPrice: "1234567"})));
    await handleSubmitOrder(submitMsg(BOB, 1n, order(BOB, 1n, {size: "7654321"})));

    const serialized = JSON.stringify(reportState()).toLowerCase();

    expect(serialized).not.toContain("1234567");
    expect(serialized).not.toContain("7654321");
    expect(serialized).not.toContain("ciphertext");
    expect(serialized).not.toContain("trader");
    expect(serialized).not.toContain("0x");
  });

  it("reports only aggregates", async () => {
    await handleSubmitOrder(submitMsg(ALICE, 1n, order(ALICE, 1n)));
    expect(Object.keys(reportState() as object).sort()).toEqual([
      "lastClearedBatch",
      "lastClearingPrice",
      "openBatches",
      "openOrders",
    ]);
  });
});
