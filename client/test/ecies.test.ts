import { secp256k1 } from "@noble/curves/secp256k1";
import { describe, expect, it } from "vitest";

import { eciesDecrypt, eciesEncrypt, publicKeyFromInfo } from "../src/ecies.js";
import { sealOrder, serializeOrder } from "../src/order.js";

const ALICE = "0x00000000000000000000000000000000000000a1" as const;

function keypair() {
  const priv = secp256k1.utils.randomPrivateKey();
  return { priv, pub: secp256k1.getPublicKey(priv, false) };
}

describe("ECIES, geth-compatible", () => {
  it("round trips", () => {
    const { priv, pub } = keypair();
    const msg = new TextEncoder().encode("sealed order payload");
    expect(eciesDecrypt(priv, eciesEncrypt(pub, msg))).toEqual(msg);
  });

  it("round trips an empty message", () => {
    const { priv, pub } = keypair();
    const msg = new Uint8Array(0);
    expect(eciesDecrypt(priv, eciesEncrypt(pub, msg))).toEqual(msg);
  });

  it("round trips a message spanning several AES blocks", () => {
    const { priv, pub } = keypair();
    const msg = new Uint8Array(1000).fill(7);
    expect(eciesDecrypt(priv, eciesEncrypt(pub, msg))).toEqual(msg);
  });

  /** Layout must match geth exactly: R(65) || IV(16) || C(n) || MAC(32). */
  it("produces the geth wire layout", () => {
    const { pub } = keypair();
    const msg = new Uint8Array(18);
    const ct = eciesEncrypt(pub, msg);

    expect(ct.length).toBe(65 + 16 + 18 + 32);
    expect(ct[0]).toBe(0x04);
  });

  it("is non-deterministic, so identical orders differ on the wire", () => {
    const { pub } = keypair();
    const msg = new TextEncoder().encode("same order twice");
    expect(eciesEncrypt(pub, msg)).not.toEqual(eciesEncrypt(pub, msg));
  });

  it("refuses a wrong recipient key", () => {
    const a = keypair();
    const b = keypair();
    const ct = eciesEncrypt(a.pub, new TextEncoder().encode("secret"));
    expect(() => eciesDecrypt(b.priv, ct)).toThrow();
  });

  it("rejects a tampered ciphertext via the MAC", () => {
    const { priv, pub } = keypair();
    const ct = eciesEncrypt(pub, new TextEncoder().encode("secret"));
    ct[80] ^= 0xff; // flip a bit inside the AES-CTR body
    expect(() => eciesDecrypt(priv, ct)).toThrow(/invalid MAC/);
  });

  it("rejects a truncated ciphertext", () => {
    const { priv, pub } = keypair();
    const ct = eciesEncrypt(pub, new TextEncoder().encode("secret"));
    expect(() => eciesDecrypt(priv, ct.subarray(0, 40))).toThrow(/too short/);
  });

  it("parses a public key from an /info response", () => {
    const { pub } = keypair();
    const x = `0x${Buffer.from(pub.subarray(1, 33)).toString("hex")}`;
    const y = `0x${Buffer.from(pub.subarray(33, 65)).toString("hex")}`;
    expect(publicKeyFromInfo(x, y)).toEqual(pub);
  });
});

describe("order sealing", () => {
  it("serializes amounts as integer strings, never floats", () => {
    const json = JSON.parse(
      Buffer.from(
        serializeOrder({
          trader: ALICE,
          batchId: 3n,
          side: "SELL",
          limitPrice: 1_064_000n,
          size: 5_000_000n,
        }),
      ).toString("utf-8"),
    );

    expect(json.limitPrice).toBe("1064000");
    expect(json.size).toBe("5000000");
    expect(json.batchId).toBe("3");
    expect(typeof json.limitPrice).toBe("string");
  });

  it("includes a fresh nonce so identical orders are not correlatable", () => {
    const o = { trader: ALICE, batchId: 1n, side: "BUY" as const, limitPrice: 1n, size: 1n };
    const a = JSON.parse(Buffer.from(serializeOrder(o)).toString("utf-8"));
    const b = JSON.parse(Buffer.from(serializeOrder(o)).toString("utf-8"));
    expect(a.nonce).not.toBe(b.nonce);
  });

  it("rejects non-positive amounts", () => {
    const base = { trader: ALICE, batchId: 1n, side: "BUY" as const, limitPrice: 1n, size: 1n };
    expect(() => serializeOrder({ ...base, size: 0n })).toThrow(/size must be positive/);
    expect(() => serializeOrder({ ...base, limitPrice: 0n })).toThrow(/limitPrice must be positive/);
  });

  it("seals to a hex blob the contract can carry", () => {
    const { pub } = keypair();
    const sealed = sealOrder(pub, {
      trader: ALICE,
      batchId: 1n,
      side: "BUY",
      limitPrice: 1_064_000n,
      size: 5_000_000n,
    });
    expect(sealed.startsWith("0x")).toBe(true);
    expect(sealed.length).toBeGreaterThan(2 + 2 * (65 + 16 + 32));
  });
});
