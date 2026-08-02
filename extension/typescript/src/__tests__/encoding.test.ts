/** Encoding helpers — docs/extension-contract.md §4. */

import { describe, expect, it } from "vitest";

import {
  bytes32HexToString,
  bytesToHex,
  hexToBytes,
  stringToBytes32Hex,
} from "../base/encoding.js";

describe("hexToBytes", () => {
  it("round-trips", () => {
    expect(Array.from(hexToBytes("0xdeadbeef"))).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it("accepts bare hex", () => {
    expect(Array.from(hexToBytes("deadbeef"))).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it("decodes Go's empty hexutil.Bytes", () => {
    // Go encodes an empty slice as "0x", not "".
    expect(hexToBytes("0x").length).toBe(0);
    expect(hexToBytes("").length).toBe(0);
    expect(hexToBytes(null).length).toBe(0);
    expect(hexToBytes(undefined).length).toBe(0);
  });

  it("rejects non-hex characters", () => {
    expect(() => hexToBytes("0xZZ")).toThrow();
  });

  it("rejects odd-length input", () => {
    expect(() => hexToBytes("0xabc")).toThrow();
  });
});

describe("bytesToHex", () => {
  it("prefixes with 0x", () => {
    expect(bytesToHex(new Uint8Array([0xde, 0xad]))).toBe("0xdead");
  });

  it("zero-pads single digits", () => {
    expect(bytesToHex(new Uint8Array([0x00, 0x0f]))).toBe("0x000f");
  });

  it("encodes empty as 0x, matching Go", () => {
    expect(bytesToHex(new Uint8Array(0))).toBe("0x");
  });
});

describe("bytes32", () => {
  it("right-pads to 32 bytes", () => {
    const h = stringToBytes32Hex("GREETING");
    expect(h.length).toBe(66); // 0x + 64 hex chars
  });

  it("matches the Solidity bytes32 literal", () => {
    // Solidity: bytes32("GREETING") in contracts/InstructionSender.sol.
    expect(stringToBytes32Hex("GREETING")).toBe(`0x4752454554494e47${"00".repeat(24)}`);
  });

  it("encodes the empty string as all zeros", () => {
    expect(stringToBytes32Hex("")).toBe(`0x${"00".repeat(32)}`);
  });

  it("round-trips", () => {
    for (const s of ["GREETING", "SAY_HELLO", "SAY_GOODBYE", ""]) {
      expect(bytes32HexToString(stringToBytes32Hex(s))).toBe(s);
    }
  });

  it("rejects strings longer than 32 bytes", () => {
    expect(() => stringToBytes32Hex("x".repeat(33))).toThrow();
  });
});
