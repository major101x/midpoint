/**
 * Live Coston2 deployment.
 *
 * These are the verified addresses recorded in PROGRESS.md. Never hardcode an
 * address that is not written down there: earlier deployments are dead, and one
 * of them has a batch stranded behind a paused enclave.
 */

import { parseAbi } from "viem";

export const RPC_URL = "https://coston2-api.flare.network/ext/C/rpc";
export const EXPLORER = "https://coston2-explorer.flare.network";

/**
 * Base URL of the FCC proxy, with no trailing slash.
 *
 * Development leaves this unset and the value falls back to `/tee`, which the
 * Vite dev server forwards to localhost:6674 (see `vite.config.ts`). That
 * forwarder exists only in the dev server. A production build is three static
 * files with nothing standing behind them, so a hosted page must be handed a
 * real public URL at build time through `VITE_TEE_URL`, or every call here
 * lands on the static host and 404s.
 *
 * The proxy is already public by design: `post-build.sh` registers this same
 * endpoint on chain as the extension's proxy, so pointing the page at it
 * exposes nothing that the registry does not already publish.
 */
export const TEE_BASE = (import.meta.env.VITE_TEE_URL ?? "/tee").replace(/\/+$/, "");
export const TEE_INFO_URL = `${TEE_BASE}/info`;

/**
 * `fetch` for the proxy.
 *
 * @remarks The header is for ngrok, whose free tier answers anything that looks
 * like a browser with an HTML interstitial instead of the response. That would
 * surface here as JSON parsing failing on `<!DOCTYPE html>`, which is a
 * genuinely confusing way to learn about it. The header is ngrok's documented
 * opt-out and is ignored by every other host, including the dev proxy.
 */
export const teeFetch = (url: string, init: RequestInit = {}) =>
  fetch(url, {
    ...init,
    headers: { ...init.headers, "ngrok-skip-browser-warning": "true" },
  });

export const CHAIN = {
  id: 114,
  name: "Coston2",
  nativeCurrency: { name: "C2FLR", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "Coston2 Explorer", url: EXPLORER } },
} as const;

export const ADDRESSES = {
  fxrp: "0x0b6A3645c240605887a5532109323A3E12273dc7",
  usdt0: "0xC1A5B41512496B80903D1f32d6dEa3a73212E71F",
  vault: "0x38F182C65415C9bBCA03420E256E8A9E957B72b2",
  orderBook: "0xDC1F76dD480EE9A3B4383a29a1C956E11E5326d4",
  settlement: "0xd064e426F10a8DC00E9892722c468C8A41e9Cb45",
  /**
   * The comparison pool, and deliberately not part of the venue. It exists so
   * the cost of trading in the open can be measured rather than asserted.
   */
  amm: "0xE93DED1D2a9501Ad47F493a17a2BB1411148d408",
} as const;

/** Charged by the TEE extension registry per instruction. */
export const INSTRUCTION_FEE = 1_000_000n;

/** Both tokens and the FTSO feed use 6 decimals, not the usual 18. */
export const DECIMALS = 6;
export const SCALE = 1_000_000n;

export const erc20Abi = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
]);

export const vaultAbi = parseAbi([
  "function deposit(bool,uint256)",
  "function withdraw(bool,uint256)",
  "function baseBalanceOf(address) view returns (uint256)",
  "function quoteBalanceOf(address) view returns (uint256)",
  "function frozen() view returns (bool)",
]);

export const orderBookAbi = parseAbi([
  "function submitOrder(bytes) payable returns (bytes32)",
  "function closeBatch() payable returns (bytes32)",
  "function voidBatch()",
  "function currentBatchId() view returns (uint256)",
  "function orderCount() view returns (uint32)",
  "function batchTee() view returns (address)",
  "function batchOpenedAt() view returns (uint64)",
  "function batchClosed() view returns (bool)",
  "function minBatchDuration() view returns (uint64)",
  "function voidDelay() view returns (uint64)",
  "event OrderSubmitted(address indexed trader, uint256 indexed batchId, address indexed tee, bytes32 instructionId)",
  "event BatchClosed(uint256 indexed batchId, address indexed tee, uint32 orderCount, bytes32 instructionId)",
]);

export const ammAbi = parseAbi([
  "function reserveBase() view returns (uint256)",
  "function reserveQuote() view returns (uint256)",
]);

export const settlementAbi = parseAbi([
  "function settle(bytes,bytes)",
  "function lastSettledBatch() view returns (uint256)",
  "function bandBps() view returns (uint16)",
]);

/** Format a 6-decimal integer amount for display. */
export function fmt(v: bigint | undefined, dp = 6): string {
  if (v === undefined) return "-";
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(DECIMALS, "0").slice(0, dp);
  return `${neg ? "-" : ""}${whole}${dp > 0 ? `.${frac}` : ""}`;
}

/** Parse a decimal string into 6-decimal base units without floating point. */
export function parseAmount(input: string): bigint {
  const trimmed = input.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") {
    throw new Error("enter a number");
  }
  const [whole = "0", frac = ""] = trimmed.split(".");
  const padded = (frac + "000000").slice(0, DECIMALS);
  return BigInt(whole || "0") * SCALE + BigInt(padded || "0");
}

export const short = (s: string, head = 10, tail = 8) =>
  s.length <= head + tail ? s : `${s.slice(0, head)}...${s.slice(-tail)}`;
