import { hexToBytes } from "./ecies.js";

/**
 * The relayer: carries a signed batch result from the enclave to the chain.
 *
 * DELIBERATELY UNTRUSTED. It can delay settlement or refuse to run, but it
 * cannot forge or alter a batch, because it cannot produce a TEE signature and
 * `Settlement` checks that signature against the enclave `OrderBook` pinned for
 * the batch. Liveness degrades if it stops; safety does not. Anyone can run one,
 * and running a second changes nothing, because the first settlement advances
 * the batch and the second reverts.
 *
 * It exists because the FCC pipeline delivers results to a proxy that callers
 * poll, rather than pushing them back on chain.
 */

export interface ActionResultEnvelope {
  result: {
    id: string;
    status: number;
    log: string;
    data: string;
  };
  signature: string;
}

/** What the enclave's RUN_MATCH handler returns, once hex-decoded. */
export interface BatchResult {
  batchId: string;
  clearingPrice: string;
  volume: string;
  /** ABI-encoded (uint256, uint256, Fill[]), the bytes the enclave signed. */
  payload: `0x${string}`;
  /** 65 bytes, r || s || v. */
  signature: `0x${string}`;
}

/**
 * Poll the proxy for an instruction's result.
 *
 * The proxy answers 404 until the enclave has processed the instruction, which
 * is normal rather than an error: the round trip runs about six seconds.
 */
export async function awaitResult(
  proxyUrl: string,
  instructionId: string,
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    /**
     * Injected so the caller can supply proxy-specific headers. Narrower than
     * `typeof fetch` on purpose: this only ever receives a URL string, and the
     * wide signature would force every caller to accept `Request` too.
     */
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  } = {},
): Promise<ActionResultEnvelope> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const doFetch = opts.fetchImpl ?? fetch;
  const deadline = Date.now() + timeoutMs;
  let lastError = "not found";

  while (Date.now() < deadline) {
    try {
      const res = await doFetch(`${proxyUrl}/action/result/${instructionId}`);
      if (res.ok) {
        const text = await res.text();
        // The proxy returns a plain string, not JSON, when it has nothing yet.
        if (text.trimStart().startsWith("{")) {
          return JSON.parse(text) as ActionResultEnvelope;
        }
        lastError = text.trim();
      } else {
        lastError = `HTTP ${res.status}`;
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(`timed out waiting for ${instructionId}: ${lastError}`);
}

/** Decode the handler's JSON response out of an action result. */
export function decodeBatchResult(envelope: ActionResultEnvelope): BatchResult {
  if (envelope.result.status !== 1) {
    throw new Error(`enclave rejected the batch: ${envelope.result.log}`);
  }
  const hex = envelope.result.data.replace(/^0x/, "");
  if (hex.length === 0) throw new Error("action result carried no data");

  const parsed = JSON.parse(new TextDecoder().decode(hexToBytes(hex))) as BatchResult;
  if (!parsed.payload || !parsed.signature) {
    throw new Error("batch result is missing payload or signature");
  }
  return parsed;
}
