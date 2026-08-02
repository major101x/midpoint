/**
 * ECIES compatible with go-ethereum's `crypto/ecies`, which is what Flare's
 * tee-node uses to decrypt.
 *
 * WHY THIS IS HAND-ROLLED. tee-node calls `ecies.Decrypt(ciphertext, nil, nil)`
 * with go-ethereum's default parameters (ECIES_AES128_SHA256). The popular
 * JavaScript ECIES libraries are not wire-compatible with it: `eciesjs` defaults
 * to AES-256-GCM, and `eth-crypto`/`eccrypto` use AES-256-CBC with a SHA-512
 * KDF. Using either produces ciphertext the enclave silently refuses. The scheme
 * below is small enough to implement exactly, and it is pinned by a round-trip
 * test plus a live probe against a running enclave.
 *
 * Wire format, matching geth byte for byte:
 *
 *   R  (65)  uncompressed ephemeral public key, 0x04 prefixed
 *   IV (16)  AES-CTR initialisation vector
 *   C  (n)   AES-128-CTR ciphertext
 *   D  (32)  HMAC-SHA256 over (IV || C)
 *
 * Key derivation, from geth's `deriveKeys`:
 *
 *   z  = ECDH x coordinate, 32 bytes big-endian
 *   K  = concatKDF(z, 32)          NIST SP 800-56, SHA-256
 *   Ke = K[0:16]                   AES key
 *   Km = SHA-256(K[16:32])         MAC key
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { ctr } from "@noble/ciphers/aes";
import { randomBytes } from "@noble/hashes/utils";

const KEY_LEN = 16;
const IV_LEN = 16;
const PUB_LEN = 65;
const MAC_LEN = 32;

/** NIST SP 800-56 concatenation KDF with an empty shared-info field. */
function concatKDF(z: Uint8Array, kdLen: number): Uint8Array {
  const blocks: Uint8Array[] = [];
  let written = 0;
  for (let counter = 1; written < kdLen; counter++) {
    const c = new Uint8Array(4);
    new DataView(c.buffer).setUint32(0, counter, false);
    const block = sha256(concat(c, z));
    blocks.push(block);
    written += block.length;
  }
  return concat(...blocks).subarray(0, kdLen);
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

/** Constant-time comparison, so a bad MAC cannot be probed byte by byte. */
function equalCT(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function deriveKeys(z: Uint8Array): { ke: Uint8Array; km: Uint8Array } {
  const k = concatKDF(z, 2 * KEY_LEN);
  return { ke: k.subarray(0, KEY_LEN), km: sha256(k.subarray(KEY_LEN, 2 * KEY_LEN)) };
}

/**
 * Encrypt to an uncompressed secp256k1 public key (65 bytes, 0x04 prefixed).
 * Get the enclave's key from the proxy's `/info` endpoint.
 */
export function eciesEncrypt(publicKey: Uint8Array, message: Uint8Array): Uint8Array {
  if (publicKey.length !== PUB_LEN || publicKey[0] !== 0x04) {
    throw new Error("public key must be 65 uncompressed bytes starting 0x04");
  }

  const ephPriv = secp256k1.utils.randomPrivateKey();
  const ephPub = secp256k1.getPublicKey(ephPriv, false);

  // getSharedSecret returns a 33-byte compressed point; z is its x coordinate.
  const z = secp256k1.getSharedSecret(ephPriv, publicKey, true).subarray(1, 33);
  const { ke, km } = deriveKeys(z);

  const iv = randomBytes(IV_LEN);
  const c = ctr(ke, iv).encrypt(message);
  const em = concat(iv, c);
  const d = hmac(sha256, km, em);

  return concat(ephPub, em, d);
}

/**
 * Decrypt with a raw 32-byte secp256k1 private key.
 *
 * The enclave never exposes its private key, so this exists only so the round
 * trip can be tested without a running TEE. It is the same scheme in reverse.
 */
export function eciesDecrypt(privateKey: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  if (ciphertext.length < PUB_LEN + IV_LEN + MAC_LEN) {
    throw new Error("ciphertext too short");
  }

  const r = ciphertext.subarray(0, PUB_LEN);
  const em = ciphertext.subarray(PUB_LEN, ciphertext.length - MAC_LEN);
  const d = ciphertext.subarray(ciphertext.length - MAC_LEN);

  const z = secp256k1.getSharedSecret(privateKey, r, true).subarray(1, 33);
  const { ke, km } = deriveKeys(z);

  if (!equalCT(hmac(sha256, km, em), d)) throw new Error("invalid MAC");

  const iv = em.subarray(0, IV_LEN);
  return ctr(ke, iv).decrypt(em.subarray(IV_LEN));
}

/** Parse the `{x, y}` pair from the proxy `/info` response into a public key. */
export function publicKeyFromInfo(x: string, y: string): Uint8Array {
  const hex = (s: string) => s.replace(/^0x/, "").padStart(64, "0");
  const bytes = Uint8Array.from(
    Buffer.from(`04${hex(x)}${hex(y)}`, "hex"),
  );
  if (bytes.length !== PUB_LEN) throw new Error("malformed public key in /info");
  return bytes;
}
