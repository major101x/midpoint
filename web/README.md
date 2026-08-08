# Midpoint, web interface

The trading interface. Orders are sealed in the browser, so plaintext never
leaves this page.

## Running it

The interface needs the FCC proxy running locally, because it fetches the
enclave's public key from `/info` and polls it for batch results.

```bash
# 1. bring up the enclave stack (from the repo root)
cd extension && ./scripts/start-services.sh --chain coston2

# 2. run the interface
cd web && npm install && npm run dev
```

Then open http://localhost:5173 and connect a wallet on Coston2.

`vite.config.ts` proxies `/tee` to `localhost:6674`. That indirection exists
because the FCC proxy sends no CORS headers, so the browser cannot call it
directly.

## What it shows

The page is built around one contrast:

- **What the chain sees**: the batch, how many orders were submitted, which enclave is pinned, and your order as an opaque ciphertext.
- **What only the enclave sees**: side, limit price, size, unfilled orders, and the resting book.

Only the clearing price and the net movements ever become public, and only once
the batch settles.

## Notes

- The crypto in `src/lib/` is copied from `client/src`, adapted to drop Node's `Buffer`. The client package holds the tested originals.
- Contract addresses live in `src/lib/config.ts` and must match `PROGRESS.md`. Earlier deployments are dead.
- The order form mirrors the enclave's own collateral rule, so an order the TEE would reject is caught before it costs an instruction fee.
