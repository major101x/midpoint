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

## The hosted build

Live at **https://major101x.github.io/midpoint/**, published by
`.github/workflows/pages.yml` on every push that touches `web/`.

The dev-server proxy above does not exist in a production build, so the hosted
page is given a real proxy URL at build time:

| Variable | Value | Why |
|---|---|---|
| `VITE_TEE_URL` | the ngrok URL | Without it the page falls back to `/tee`, which nothing serves on a static host |
| `VITE_BASE` | `/midpoint/` | Pages serves a project site from a subpath, and assets 404 without the prefix |

CORS is handled at the tunnel by `ngrok-policy.yml`, which answers the preflight
and adds the header to every response. Start the tunnel with it:

```bash
ngrok http 6674 --url https://<reserved-domain> \
  --traffic-policy-file web/ngrok-policy.yml
```

**The hosted page is only fully live while that tunnel and the enclave stack are
running**, because the enclave runs on the operator's machine in FCC development
mode. When they are down the page still renders live on-chain state, since that
comes from the public Coston2 RPC; only sealing a new order needs the proxy, and
the page says so rather than failing silently.

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
