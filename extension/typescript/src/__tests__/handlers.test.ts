/** Hello World handlers — behaviour must match go/internal/extension/extension.go. */

import { encodeAbiParameters } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as handlers from "../app/handlers.js";
import { bytesToHex, hexToBytes } from "../base/encoding.js";
import type { HandlerResult } from "../base/types.js";

const GOODBYE_PARAMS = [
  {
    type: "tuple",
    components: [
      { name: "name", type: "string" },
      { name: "reason", type: "string" },
    ],
  },
] as const;

function jsonMsg(obj: unknown): string {
  return bytesToHex(Buffer.from(JSON.stringify(obj), "utf-8"));
}

function goodbyeMsg(name: string, reason: string): string {
  return encodeAbiParameters(GOODBYE_PARAMS, [{ name, reason }]);
}

function parseData(result: HandlerResult): Record<string, unknown> {
  return JSON.parse(Buffer.from(hexToBytes(result[0]!)).toString("utf-8"));
}

beforeEach(() => handlers.resetState());
afterEach(() => handlers.resetState());

describe("handleSayHello", () => {
  it("greets and returns the counter", () => {
    const r = handlers.handleSayHello(jsonMsg({ name: "World" }));
    expect([r[1], r[2]]).toEqual([1, null]);
    expect(parseData(r)).toEqual({
      greeting: "Hello, World! Welcome to Flare Confidential Compute.",
      greetingNumber: 1,
    });
  });

  it("increments the counter across calls", () => {
    for (const expected of [1, 2, 3]) {
      const r = handlers.handleSayHello(jsonMsg({ name: "A" }));
      expect(parseData(r).greetingNumber).toBe(expected);
    }
  });

  it("rejects an empty name", () => {
    const r = handlers.handleSayHello(jsonMsg({ name: "" }));
    expect([r[0], r[1]]).toEqual([null, 0]);
    expect(r[2]).toContain("name must not be empty");
  });

  it("rejects a missing name", () => {
    const r = handlers.handleSayHello(jsonMsg({}));
    expect(r[1]).toBe(0);
    expect(r[2]).toContain("name must not be empty");
  });

  it("rejects unknown fields, matching Go's DisallowUnknownFields", () => {
    const r = handlers.handleSayHello(jsonMsg({ name: "A", extra: 1 }));
    expect(r[1]).toBe(0);
    expect(r[2]).toContain("unknown field");
  });

  it("rejects invalid JSON", () => {
    const r = handlers.handleSayHello(bytesToHex(Buffer.from("not json")));
    expect(r[1]).toBe(0);
    expect(r[2]).toContain("decoding request");
  });

  it("rejects invalid hex", () => {
    const r = handlers.handleSayHello("0xZZ");
    expect(r[1]).toBe(0);
    expect(r[2]).toContain("decoding request");
  });

  it("does not increment the counter on failure", () => {
    handlers.handleSayHello(jsonMsg({ name: "" }));
    const r = handlers.handleSayHello(jsonMsg({ name: "A" }));
    expect(parseData(r).greetingNumber).toBe(1);
  });
});

describe("handleSayGoodbye", () => {
  it("decodes the ABI payload and returns a farewell", () => {
    const r = handlers.handleSayGoodbye(goodbyeMsg("World", "done"));
    expect([r[1], r[2]]).toEqual([1, null]);
    expect(parseData(r)).toEqual({
      farewell: "Goodbye, World! Reason: done",
      farewellNumber: 1,
    });
  });

  it("keeps its counter independent of greetings", () => {
    handlers.handleSayHello(jsonMsg({ name: "A" }));
    const r = handlers.handleSayGoodbye(goodbyeMsg("B", "r"));
    expect(parseData(r).farewellNumber).toBe(1);
  });

  it("rejects an empty name", () => {
    const r = handlers.handleSayGoodbye(goodbyeMsg("", "r"));
    expect(r[1]).toBe(0);
    expect(r[2]).toContain("name must not be empty");
  });

  it("allows an empty reason, matching Go which validates name only", () => {
    const r = handlers.handleSayGoodbye(goodbyeMsg("W", ""));
    expect(r[1]).toBe(1);
    expect(parseData(r).farewell).toBe("Goodbye, W! Reason: ");
  });

  it("rejects a JSON payload — this operation is ABI-encoded", () => {
    const r = handlers.handleSayGoodbye(jsonMsg({ name: "W" }));
    expect(r[1]).toBe(0);
    expect(r[2]).toContain("decoding request");
  });
});

describe("reportState", () => {
  it("starts empty", () => {
    expect(handlers.reportState()).toEqual({
      greetingCount: 0,
      lastGreeting: "",
      farewellCount: 0,
      lastFarewell: "",
    });
  });

  it("tracks both operations", () => {
    handlers.handleSayHello(jsonMsg({ name: "A" }));
    handlers.handleSayGoodbye(goodbyeMsg("B", "r"));
    expect(handlers.reportState()).toEqual({
      greetingCount: 1,
      lastGreeting: "Hello, A! Welcome to Flare Confidential Compute.",
      farewellCount: 1,
      lastFarewell: "Goodbye, B! Reason: r",
    });
  });
});
