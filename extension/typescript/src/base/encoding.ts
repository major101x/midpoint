/**
 * Hex and bytes32 encoding helpers.
 *
 * --- DO NOT MODIFY: infrastructure code. ---
 *
 * These implement the encodings in docs/extension-contract.md §4. Getting them
 * wrong is silent — the node accepts the request and verification fails later.
 */

/**
 * Decode a 0x-prefixed (or bare) hex string to bytes.
 *
 * Go's hexutil.Bytes encodes empty as "0x", so that must decode to an empty array.
 * Throws on malformed input rather than silently producing garbage.
 */
export function hexToBytes(h: string | null | undefined): Uint8Array {
  if (h === null || h === undefined) return new Uint8Array(0);

  let s = h;
  if (s.startsWith("0x") || s.startsWith("0X")) s = s.slice(2);
  if (s.length === 0) return new Uint8Array(0);

  if (s.length % 2 !== 0) {
    throw new Error(`invalid hex: odd length (${s.length})`);
  }
  if (!/^[0-9a-fA-F]*$/.test(s)) {
    throw new Error("invalid hex: non-hex characters");
  }

  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Encode bytes as a 0x-prefixed hex string, matching Go's hexutil.Bytes. */
export function bytesToHex(b: Uint8Array): string {
  let s = "0x";
  for (const byte of b) s += byte.toString(16).padStart(2, "0");
  return s;
}

/**
 * Encode a UTF-8 string as a right-zero-padded 32-byte hex string.
 *
 * This is how op-type and op-command identifiers cross the wire: Solidity's
 * bytes32("GREETING") is the UTF-8 bytes followed by zero padding.
 */
export function stringToBytes32Hex(s: string): string {
  const encoded = new TextEncoder().encode(s);
  if (encoded.length > 32) {
    throw new Error(`string too long for bytes32 (${encoded.length} bytes): ${s}`);
  }
  const padded = new Uint8Array(32);
  padded.set(encoded);
  return bytesToHex(padded);
}

/**
 * Decode a 32-byte hex string back to its trimmed UTF-8 string.
 * Used for logging; never for dispatch (comparisons are done on the hex form).
 */
export function bytes32HexToString(h: string): string {
  let b: Uint8Array;
  try {
    b = hexToBytes(h);
  } catch {
    return "";
  }
  let end = b.length;
  while (end > 0 && b[end - 1] === 0) end--;
  return new TextDecoder("utf-8").decode(b.slice(0, end));
}
