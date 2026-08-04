/**
 * ★ Signing settlement payloads with the TEE's own identity key.
 *
 * tee-node exposes `POST /sign` on the sign port. The scaffold's NodeClient does
 * not wrap it and the docs do not mention it, but it is the right primitive
 * here, because it signs with the key whose address IS this machine's registered
 * TEE id. Settlement can therefore check the signature against the enclave that
 * the chain already pinned for the batch, with no key to distribute, store or
 * rotate, and nobody outside the enclave ever able to produce one.
 *
 * The digest is standard EIP-191. tee-node computes:
 *
 *   crypto.Sign(accounts.TextHash(keccak256(message)), teeKey)
 *
 * so Solidity verifies with:
 *
 *   bytes32 inner  = keccak256(payload);
 *   bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", inner));
 *   require(ecrecover(digest, v, r, s) == batchTee);
 *
 * Verified against a live enclave: a probe signature recovered to exactly the
 * registered machine id. See spec.md §7 Q1.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

export type Signer = (message: Uint8Array) => Promise<Uint8Array>;

/** Signs via the tee-node sign port. Returns 65 bytes, r || s || v. */
export function teeSigner(signPort: string | number, timeoutMs = DEFAULT_TIMEOUT_MS): Signer {
  return async (message: Uint8Array): Promise<Uint8Array> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`http://localhost:${Number(signPort)}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The sign port speaks base64, like /decrypt, because Go marshals
        // []byte that way. Everything else on the wire is hex.
        body: JSON.stringify({ message: Buffer.from(message).toString("base64") }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`sign port returned ${res.status}: ${await res.text()}`);
      }

      const body = (await res.json()) as { signature?: string };
      if (body.signature === undefined) throw new Error("sign response missing signature");

      const sig = new Uint8Array(Buffer.from(body.signature, "base64"));
      if (sig.length !== 65) throw new Error(`expected a 65 byte signature, got ${sig.length}`);
      return sig;
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        throw new Error(`sign request timed out after ${timeoutMs}ms`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };
}
