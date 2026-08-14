# Midpoint

A dark pool for FXRP. Sealed-bid batch auctions matched inside Flare
Confidential Compute, cleared at one uniform price, checked against the FTSO,
settled on Coston2.

**Bounties: Interoperable Asset Products, and Confidential Compute Apps.**
FAssets are the traded asset; the Confidential Extension is the matching
engine. Removing either removes the product.

- **Live:** https://major101x.github.io/midpoint/
- **Repo:** https://github.com/major101x/midpoint
- **Demo video:** `docs/submission.mp4` (74 seconds: the story, then a real
  batch settling on Coston2, recorded live and played at 4x)
- Also in `docs/`: `sandwich.mp4` (the technical explainer on one price
  axis), `story.mp4` (the same argument for a lay audience), `demo-run.mp4`
  and `demo-run.log` (the unedited capture and its terminal log)

## The problem, measured rather than asserted

Every on-chain trade announces itself before it executes. To make that
concrete, this repo contains `NaiveAmm.sol`: a deliberately ordinary
constant-product pool with tracked reserves, a 30 bps fee, and a slippage
bound. Nothing about it is broken, and it is sandwichable anyway.

`client/scripts/sandwich.mjs` runs the same trade down both paths on Coston2:

```
                                public pool         sealed venue
visible before it fills         yes                 no
price depends on order size     yes                 no, one clearing price
checked against an oracle       no                  yes, FTSO band
execution price                 1.133141            1.026613
price if unobserved             1.048538            1.026613
cost of being observed          747 bps             0 bps
```

Stable at 746-747 bps across five consecutive runs. The slippage bound does
not prevent the extraction; a test in the suite shows it converts a bad fill
into a failed trade, and an attacker sizes the front-run to take exactly what
the trader said they would tolerate.

## Target user

Anyone moving FXRP at a size worth front-running, and FAssets agents in
particular: their mint and redeem flows put predictable, sizeable FXRP trades
on a public book, which is exactly the order flow a searcher waits for.

## How it works

1. Orders are encrypted in the browser to the enclave's public key. The chain
   stores ciphertext; side, size and limit never appear on it.
2. `OrderBook.sol` pins one TEE machine per batch and forwards sealed orders
   as FCC instructions with op-type `SEALED`.
3. Inside the Confidential Extension, the book lives in enclave memory only.
   At close, it clears the batch at a single uniform price, the midpoint of
   the crossing limits, and signs the settlement payload with the enclave's
   own identity key (EIP-191 over the tee-node sign port).
4. `Settlement.sol` refuses the result unless the recovered signer is the
   exact machine pinned for that batch, the batch is the next unsettled one,
   the fills net to zero, and the clearing price sits inside a 2% band around
   the live FTSO XRP/USD feed. A hidden matching engine still has to prove
   its price was fair; the FTSO is what makes that provable on chain.
5. The relayer that carries the result is explicitly untrusted: it can stall,
   it cannot forge. If it dies, anyone can run one.

## Flare integration

- **FCC / Confidential Extensions** are the product. The extension
  (id 65944) registers on the TeeExtensionRegistry, machines attest through
  the TeeMachineRegistry, and settlement authority derives from attestation
  rather than from an address an admin typed in.
- **FTSO v2** enforces the fairness band at settlement time, on chain, using
  the XRP/USD feed.
- **FAssets** provide the asset: the venue trades real Coston2 FXRP against
  USDT0.

## Coston2 addresses

| Contract | Address |
|---|---|
| Vault | `0x38F182C65415C9bBCA03420E256E8A9E957B72b2` |
| OrderBook | `0xDC1F76dD480EE9A3B4383a29a1C956E11E5326d4` |
| Settlement | `0xd064e426F10a8DC00E9892722c468C8A41e9Cb45` |
| NaiveAmm (comparison baseline) | `0xE93DED1D2a9501Ad47F493a17a2BB1411148d408` |
| FXRP (base) | `0x0b6a3645c240605887a5532109323a3e12273dc7` |
| USDT0 (quote) | `0xc1a5b41512496b80903d1f32d6dea3a73212e71f` |

Extension id 65944. The TEE machine address is ephemeral by design: enclave
identity keys regenerate on restart, which is why Settlement binds to the
machine pinned per batch instead of to a fixed signer.

## Evidence of new work

The repo started empty on 2026-07-30 and everything landed inside the
window; the commit history is the record, and `PROGRESS.md` is the day-by-day
build log with live measurements and the failures that shaped the design.

| | |
|---|---|
| Built here | Vault, OrderBook, Settlement, NaiveAmm, the matching extension (TypeScript), client-side ECIES order sealing, relayer, web interface, sandwich comparison, design system, explainer videos |
| Ported / scaffold | The FCE extension scaffold (registration scripts, compose files, tee-node images) from Flare's template |
| Out of scope, stated | Continuous trading and cancellation; multiple pairs; cross-TEE failover; PMW settlement to XRPL (the roadmap item); real hardware attestation (`SIMULATED_TEE=true` throughout) |

Tests: 88 Solidity, 93 extension, 13 client. Six sealed batches settled on
Coston2 to date, plus one voided through the designed recovery path after an
enclave restart, which is the failure mode the void mechanism exists for.

## Honest limitations

- The enclave runs in FCC development mode on the operator's machine behind a
  tunnel, so sealing new orders works only while that stack is up. The page
  says so when the proxy is unreachable, and on-chain state renders
  regardless: the settled batches, clearing prices and contract state are
  permanently verifiable on Coston2 whether or not the enclave is running.
  A live session can be arranged on request.
- Simulated TEE, not real hardware attestation. The trust story is the
  registry contract flow, not a hardware root.
- Coston2 exposes no public mempool, so the sandwich comparison executes the
  ordering a successful searcher achieves rather than racing for it.

## Roadmap

1. Real attestation on hardware with a reproducible image hash.
2. Private Market Maker settlement to XRPL: the same sealed venue, with the
   settlement leg paying out natively on the XRP Ledger through FAssets.
3. Batch scheduling and partial-fill carryover, then more pairs.

## User feedback

Posted to the Flare community channels alongside submission; feedback
received before the deadline will be linked from the repo README.
