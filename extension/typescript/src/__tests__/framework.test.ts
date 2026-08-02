/** Handler dispatch — docs/extension-contract.md §5. */

import { describe, expect, it } from "vitest";

import { stringToBytes32Hex } from "../base/encoding.js";
import { Framework, type HandlerResult } from "../base/types.js";

const h = (name: string) => (): HandlerResult => [null, 1, name];

describe("Framework.lookup", () => {
  it("finds an exact match", () => {
    const f = new Framework();
    f.handle("GREETING", "SAY_HELLO", h("hello"));
    const got = f.lookup(
      stringToBytes32Hex("GREETING"),
      stringToBytes32Hex("SAY_HELLO"),
    );
    expect(got).not.toBeNull();
    expect((got!("") as HandlerResult)[2]).toBe("hello");
  });

  it("distinguishes commands under one op type", () => {
    const f = new Framework();
    f.handle("GREETING", "SAY_HELLO", h("hello"));
    f.handle("GREETING", "SAY_GOODBYE", h("goodbye"));
    const got = f.lookup(
      stringToBytes32Hex("GREETING"),
      stringToBytes32Hex("SAY_GOODBYE"),
    );
    expect((got!("") as HandlerResult)[2]).toBe("goodbye");
  });

  it("treats an empty command as a wildcard", () => {
    const f = new Framework();
    f.handle("GREETING", "", h("any"));
    const got = f.lookup(
      stringToBytes32Hex("GREETING"),
      stringToBytes32Hex("ANYTHING"),
    );
    expect((got!("") as HandlerResult)[2]).toBe("any");
  });

  it("prefers an exact match over a wildcard regardless of registration order", () => {
    const f = new Framework();
    f.handle("GREETING", "", h("wildcard"));
    f.handle("GREETING", "SAY_HELLO", h("specific"));
    const got = f.lookup(
      stringToBytes32Hex("GREETING"),
      stringToBytes32Hex("SAY_HELLO"),
    );
    expect((got!("") as HandlerResult)[2]).toBe("specific");
  });

  it("returns null for an unknown op type", () => {
    const f = new Framework();
    f.handle("GREETING", "SAY_HELLO", h("hello"));
    expect(
      f.lookup(stringToBytes32Hex("NOPE"), stringToBytes32Hex("SAY_HELLO")),
    ).toBeNull();
  });

  it("returns null for an unknown command with no wildcard", () => {
    const f = new Framework();
    f.handle("GREETING", "SAY_HELLO", h("hello"));
    expect(
      f.lookup(stringToBytes32Hex("GREETING"), stringToBytes32Hex("NOPE")),
    ).toBeNull();
  });

  it("compares hex case-insensitively", () => {
    const f = new Framework();
    f.handle("GREETING", "SAY_HELLO", h("hello"));
    const got = f.lookup(
      stringToBytes32Hex("GREETING").toUpperCase().replace("0X", "0x"),
      stringToBytes32Hex("SAY_HELLO").toUpperCase().replace("0X", "0x"),
    );
    expect(got).not.toBeNull();
  });
});
