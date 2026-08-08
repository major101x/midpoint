# Midpoint: Technical Specification

**A sealed-bid batch auction venue for FXRP, with the matching engine inside a TEE.**

Flare Summer Signal · Bounty 1 (Interoperable Asset Products) + Bounty 2 (Confidential Compute Apps)
Target network: Coston2 (chain ID 114) · Solo build · 15 days (2026-07-30 to 2026-08-14)

> **On the name.** A dark pool crosses at the midpoint of the spread, and this
> venue's auction clears at the midpoint of the tied price range. The word means
> the same thing in both halves of what this is.
>
> The wire protocol still calls the operation type `SEALED`, and deliberately so:
> that constant is deployed on-chain and matched by the extension's handler
> registration, and "sealed-bid" remains the correct term for the mechanism
> regardless of what the venue is called.

---

## 1. Problem

Every on-chain trade leaks its intent before it executes. Transactions sit in a public queue where anyone can read them, so a bot can buy immediately ahead of a large order, let that order push the price up, and sell into it. The victim gets a worse fill; the bot keeps the difference. This is a sandwich attack, and MEV extraction of this kind removes hundreds of millions of dollars a year from ordinary traders.

The root cause is structural, not moral: **public state means public intent.** No amount of clever AMM design fixes it, because the leak happens before execution.

Traditional finance solved this with dark pools: venues where resting orders are not visible pre-trade. They handle roughly 10-15% of US equity volume, and they exist because an institution liquidating a large position cannot let the market see it coming.

On-chain dark pools have been impossible, because contract storage is readable by everyone. Flare Confidential Compute removes that constraint for the first time.

### Who this is for

FAssets agents, market makers, and treasuries moving size in FXRP. Concretely: anyone whose order is large enough relative to available liquidity that revealing it costs them money. This is a small user set with an acute, quantifiable problem. That is the right shape for a hackathon product, and the right shape for something with a life afterwards.

---

## 2. Mechanism

Three components, all load-bearing. Remove any one and front-running returns through a different door.

| Component | Removes | Without it |
|---|---|---|
| **Encryption**: orders are encrypted to the TEE's public key | Information advantage | Bots read your order and race it |
| **Batch auction**: all orders in a window clear at one uniform price | Timing advantage | Bots optimise for block position instead |
| **Attestation**: the TEE proves which code it runs | Need to trust the operator | It is a centralised exchange with extra steps |

### Uniform-price call auction

Orders accumulate for a window. At close, the engine computes the single price `p*` that maximises executed volume:

- Bids sorted descending by limit price, asks sorted ascending.
- `p*` is the price at which cumulative demand meets cumulative supply.
- Every bid with `limit >= p*` and every ask with `limit <= p*` fills, **all at `p*`**.
- The marginal price level fills pro-rata when supply and demand are unequal there.
- Unfilled orders are returned to the trader's balance and never revealed.

Being first in the batch is worth exactly nothing. That is the point.

---

## 3. Architecture

```
 ┌──────────┐   1. encrypt order client-side (TEE pubkey)
 │  Trader  │──────────────────────────────────────────────┐
 └──────────┘                                              │
      │ 0. deposit (public, decoupled in time)             │
      ▼                                                    ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ Vault.sol            internal balances, funds never leave    │
 │ OrderBook.sol        submitOrder(ciphertext) -> TEE instr.   │  ON-CHAIN
 │ Settlement.sol       verify TEE sig + FTSO band -> transfer  │  (Coston2)
 └─────────────────────────────────────────────────────────────┘
      │ 2. TeeInstructionsSent event          ▲ 6. settle(batch, fills, sig)
      ▼                                       │
 ┌──────────────────────┐          ┌──────────────────────┐
 │ FCC infrastructure   │          │ Relayer (untrusted)  │
 │ proxy -> TEE node    │─────────▶│ polls proxy, submits │
 └──────────────────────┘  5.      └──────────────────────┘
      │ 3. POST /action
      ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ Midpoint FCE  (TypeScript, Docker, inside TEE)              │
 │   /decrypt via tee-node sign port                           │
 │   private in-memory order book                              │  CONFIDENTIAL
 │   4. uniform-price clearing -> signed settlement payload    │
 └─────────────────────────────────────────────────────────────┘
```

### What is public vs. private

| Public | Private |
|---|---|
| That a deposit happened, and its size | Side, limit price, size of every order |
| That an address submitted *an* order to batch N | Which orders belong to which address |
| The clearing price `p*` | The entire resting book |
| Net token movements at settlement | Every order that did not fill |

### Component responsibilities

**`Vault.sol`**: Traders deposit FXRP and the quote token once; the contract holds internal balances. Orders draw against balance.

> **Why this exists.** The obvious design escrows funds per-order, but then the escrowed amount *is* the order size, published on-chain, and the encryption is pointless. Pre-funded balances decouple the public act of depositing from the private act of ordering, in both time and amount. This is the single most important design decision in the spec.

**`OrderBook.sol`**: The extension's on-chain entry point. Follows the scaffold's `InstructionSender` pattern (`setExtensionId()` and `_getExtensionId()` are copied verbatim and never modified).

```
submitOrder(bytes ciphertext) payable      -> OP_TYPE=SEALED, OP_COMMAND=SUBMIT_ORDER
closeBatch() payable                       -> OP_TYPE=SEALED, OP_COMMAND=RUN_MATCH
```

Rejects orders from addresses with zero balance (cheap spam guard that leaks nothing about size). `closeBatch` is permissionless and rate-limited by a minimum batch duration.

**Midpoint FCE (TypeScript)**: An HTTP server satisfying `docs/extension-contract.md`. Handlers registered against `(SEALED, SUBMIT_ORDER)` and `(SEALED, RUN_MATCH)`. On submit: decrypt via `NodeClient`, validate, insert into the in-memory book for the current batch. On match: clear, produce the settlement payload, sign it, return it. `GET /state` exposes only non-sensitive aggregates, namely batch number, order count, and last clearing price. **Never the book.**

**`Settlement.sol`**: Accepts `(batchId, fills[], clearingPrice, signature)`. Rejects unless:
1. `ecrecover` of the EIP-191 digest equals the `batchTee` recorded for that batch, so only the enclave that held the book can settle it (see §7 Q1);
2. `batchId` is the next unsettled batch (replay protection);
3. `clearingPrice` is within the FTSO band (below);
4. fills net to zero, meaning total bought equals total sold.

Then it moves internal balances. No external transfers; withdrawal is a separate user-initiated call.

**Relayer**: A TypeScript process that polls the FCC proxy for the batch result and submits it. **Explicitly untrusted**: it can delay settlement or refuse to act, but cannot forge or alter a batch, because it cannot produce a TEE signature. If it dies, anyone can run one. Liveness is degradable; safety is not.

### The FTSO fairness band

A hidden matching engine invites one obvious question: *how do I know the price was fair?*

`Settlement.sol` independently reads XRP/USD from FTSO v2 and reverts if the clearing price deviates by more than `BAND_BPS` (initially 200, meaning 2%). The TEE's discretion is bounded by an oracle it does not control and cannot influence. A malicious or buggy engine cannot print an arbitrary price.

- FtsoV2 proxy on Coston2: `0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d` (prefer resolving via `ContractRegistry`)
- XRP/USD feed ID: `0x015852502f55534400000000000000000000000000`
  (`0x01` = crypto category, then ASCII `XRP/USD` right-padded to 20 bytes)
- Feeds return `(value, decimals, timestamp)`, integers plus a scale exponent, since there are no floats on-chain.
- Verified live on 2026-07-31: value `1063983`, decimals `6`, so XRP/USD = $1.063983.

This is what turns FTSO from decoration into enforcement, and it is the direct answer to the "is the integration superficial?" judging criterion.

### Coston2 constants

Verified on-chain 2026-07-31.

| Thing | Value |
|---|---|
| Chain ID | `114` |
| RPC | `https://coston2-api.flare.network/ext/C/rpc` |
| Explorer | `https://coston2-explorer.flare.network` |
| FXRP (base), symbol `FTestXRP` | `0x0b6a3645c240605887a5532109323a3e12273dc7` |
| USDT0 (quote), symbol `USD₮0` | `0xc1a5b41512496b80903d1f32d6dea3a73212e71f` |
| FtsoV2 proxy | `0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d` |
| XRP/USD feed ID | `0x015852502f55534400000000000000000000000000` |

> **TEE keys are ephemeral.** The TEE's identity key is regenerated when the container restarts. Observed directly: the registered machine id went from `0xFAcCDbDB...8073` to `0xCEDCF76d...60C7` across a restart. Nothing in `Settlement.sol` may hardcode a TEE address or signer. Store `settlementSigner` in mutable storage with an owner-only setter, and re-point it after any enclave restart. The same applies to the extension's in-memory order book: a restart loses it, so a batch spanning a restart must be voidable rather than settleable.

> **Both tokens use 6 decimals, not 18.** The FTSO feed also returns 6 decimals. Never hardcode `1e18` anywhere in this codebase. Define decimals as named constants and convert explicitly at every boundary, because a silent 12-orders-of-magnitude error in a clearing price will look like a working demo right up until settlement moves absurd amounts.

---

## 4. Data shapes

**Encrypted order** (client to TEE, never on-chain in plaintext):

```
{ batchId, side: "BUY"|"SELL", limitPrice, size, trader, nonce }
```

`nonce` prevents an observer from correlating two identical orders by ciphertext equality.

**Settlement payload** (TEE to relayer to chain):

```
{ batchId, clearingPrice, fills: [{ trader, side, size }], teeId }
```

Signed over `keccak256(abi.encode(...))`. Only net movements appear; unfilled orders never leave the enclave.

---

## 5. Threat model

| Adversary | Capability | Outcome |
|---|---|---|
| MEV bot / mempool observer | Reads all transactions | Sees ciphertext and deposit sizes. Cannot recover side, price or size. Cannot gain from ordering, because pricing is uniform. |
| Relayer operator | Controls result submission | Can stall settlement. Cannot forge, reorder or alter fills. |
| Venue operator (you) | Root on the host machine | Cannot read enclave memory. Cannot alter matching without changing the image hash, which breaks attestation visibly. |
| Malicious TEE code | Ships a rigged engine | Image hash on-chain will not match the hash of the published source; independently reproducible builds expose it. Clearing price still bounded by the FTSO band. |
| Colluding traders | Submit orders to probe the book | Uniform pricing and batch aggregation limit inference to what settlement already reveals. |

### Stated honestly

A TEE is a **hardware** trust assumption, not a mathematical one. You are trusting the silicon vendor's implementation, and there is a real published literature of side-channel attacks against TEEs. This is a large improvement over "trust the exchange operator" and strictly weaker than a zero-knowledge construction. Say this in the README and in the video. Judges will ask; knowing exactly where the product sits on that spectrum reads as competence, and pretending otherwise reads as the opposite.

Timing side channels are also real here: order arrival times are public even when contents are not. Batching blunts this. It does not eliminate it. Out of scope, and named as such.

---

## 6. Scope

### In

- One pair: FXRP/USDT0, both real Coston2 testnet tokens
- Deposit, submit encrypted order, close batch, settle, withdraw
- Uniform-price clearing, roughly 10-20 orders per batch
- FTSO band enforcement
- Manual (permissionless) batch close
- Side-by-side demo against a naive AMM showing the sandwich attack
- Coston2 deployment with published addresses

### Out (and say so explicitly in the submission)

- Continuous trading, partial-fill queues, cancellation
- Multiple pairs, fee tiers, maker rebates
- Cross-TEE replication and failover
- PMW settlement to XRPL: *named as the roadmap item, not built*
- Real hardware attestation (`SIMULATED_TEE=true` throughout; see §8)

Scoping down is the correct move solo, and stating the cut lines clearly scores under "clarity and future potential." Silently omitting them does not.

---

## 7. Open questions to resolve first

**Q1: REVISED 2026-08-02. The TEE signs directly with its own identity key. No key management at all.**

The day 1 answer below (an in-enclave generated key, the `fce-sign` pattern) is superseded. Reading `tee-node`'s sign port turned up `POST /sign`, which the scaffold's `NodeClient` does not wrap and the docs do not mention:

```
POST localhost:$SIGN_PORT/sign   {"message": "<base64>"}
  -> {"message": "<base64>", "signature": "<base64>"}   65 bytes, r || s || v
```

It computes `crypto.Sign(accounts.TextHash(keccak256(message)), teePrivateKey)`. `TextHash` is EIP-191, so the digest is exactly:

```
keccak256("\x19Ethereum Signed Message:\n32" || keccak256(payload))
```

which Solidity can rebuild in two lines. Crucially the signer is the TEE's **identity** key, whose address is the machine id registered on chain.

**Verified end to end on 2026-08-02.** Signing the probe string `sealed-signing-probe` inside the running enclave and recovering the signature gave `0x2fd46e88149d0bf66d66a886bd3a93f857b55a86`, exactly the registered TEE machine. This is the check that failed on day 3 for the `ActionResult` path, which wraps its digest in an extra domain-separated payload; `/sign` has no such wrapper.

Why this is better than a generated key:

- Nobody ever holds the settlement private key, not even at generation time. The `fce-sign` load-a-key pattern always left whoever created the key able to forge settlements.
- The signer is verifiable against the TEE machine registry, so settlement is tied to attestation rather than to an address an admin typed in.
- One fewer setup step and one fewer thing to get wrong after a restart.

**Bind the signature to the batch's own enclave.** `OrderBook` already pins `batchTee` for a batch's lifetime, so `Settlement` should require that the recovered signer equals the `batchTee` recorded for *that* batch. The enclave that held the book is then the only one that can settle it, which needs no admin setter and closes the ephemeral-key problem without configuration.

---

**Superseded (kept for the reasoning): 2026-08-01, in-enclave settlement key.**

Path (a), reusing the TEE's own result signature, was investigated and rejected. Findings:

- `GET /action/result/<id>` does return `{result, signature, proxySignature}`, and the TEE's identity key does equal its registered machine id (verified: the address derived from the `/info` public key matched the registry exactly).
- The signature is over `keccak256(abi.encode(bytes32 prefix, uint256 chainId, bytes32 dataHash))` with `prefix = bytes32("TEE_ACTION_RESULT")` and `dataHash = ActionResult.Hash()`. That construction was reproduced from source but does **not** verify. A control test using the proxy's known private key against `proxySignature` also failed, so the published construction is incomplete in some way not visible in the source read.
- `VerificationFacet` on Coston2 exposes only attestation and availability-check functions. There is no on-chain "verify this action result" helper to lean on.

Reverse-engineering this further is not a good use of hackathon days, and it would leave settlement resting on an undocumented detail.

**Decision:** follow the officially documented `fce-sign` pattern (`https://dev.flare.network/fcc/guides/sign-extension`), which has a complete TypeScript reference implementation:

1. The extension holds a secp256k1 settlement key in enclave memory.
2. It signs with `signECDSA`: `keccak256` of the payload, then secp256k1, returning 65 bytes `r || s || v` with `v = recovery + 27`. Directly compatible with Solidity `ecrecover`.
3. `Settlement.sol` verifies `ecrecover(payloadHash, sig) == settlementSigner`.

**Key provenance.** Prefer generating the keypair inside the enclave on first init and returning only its address, so no party ever holds the private half. The alternative documented by `fce-sign` (encrypt a key to the TEE public key and load it via `KEY/UPDATE`) is simpler but weaker: whoever generated the key can also forge settlements. If the loaded-key route is used to save time, say so plainly in the threat model rather than implying otherwise.

**Consequence: the signer address must be settable, never hardcoded.** See the ephemeral-key note in §3.

**Q2: RESOLVED 2026-07-31. Real testnet FXRP is available, no mock needed.**

The official faucet (`https://faucet.flare.network/coston2`) dispenses 100 C2FLR, 10 USDT0 and 10 FXRP per address per 24 hours. The pair is therefore **FXRP/USDT0**, both real testnet tokens.

Two consequences:

- Bounty 1 claim strengthens from "trades an ERC-20 we minted" to "trades actual FAssets FXRP".
- The demo needs several distinct trader addresses to make a batch auction meaningful. Generate them and fund each from the same faucet. 10 FXRP per address is ample when order sizes are fractional.

**Q3: Does `getRandomTeeIds` return a stable machine across a batch?**

The book lives in one enclave's memory. If instructions can route to different machines, the design needs a single pinned TEE for the batch's lifetime. Verify during Day 1-2 hello-world.

---

## 8. Attestation posture

Development and demo run with `SIMULATED_TEE=true`. Real: the container, the extension contract, encryption, on-chain registration, the instruction pipeline, Coston2 deployment. Simulated: the hardware attestation quote, because a GCP Confidential VM is not in budget.

This is the officially documented development mode and is one environment variable from production. **State it plainly, unprompted, in the README and video.** Include a section describing the production path (Confidential Space VM, `SIMULATED_TEE=false`, reproducible image hash registered on-chain) to show it was designed for, not bolted on.

---

## 9. Build plan

Fifteen days. The ordering is deliberate: the riskiest unknowns are front-loaded, and the demo-critical milestone lands with four days of slack.

| Day | Date | Work | Done when |
|---|---|---|---|
| 1 | Jul 30 | Wallet, Coston2 faucet, Foundry, clone scaffold, read `docs/` | Wallet funded, `forge` runs |
| 2 | Jul 31 | Hello-world E2E on Coston2 (`LANGUAGE=typescript`), ngrok tunnel | A greeting round-trips through a real TEE instruction |
| 3 | Aug 1 | **Spike: Q1, Q2, Q3.** Nothing else. | Signing path decided; token decided; TEE routing understood |
| 4 | Aug 2 | `Vault.sol` + mock tokens, deposit/withdraw + tests | `forge test` green |
| 5 | Aug 3 | `OrderBook.sol`, both instructions wired | Instruction reaches the extension with the right op-type |
| 6 | Aug 4 | FCE: decrypt + book insertion | Encrypted order submitted on-chain appears in `/state` count |
| 7 | Aug 5 | FCE: clearing algorithm, unit-tested off-chain | Auction tests pass, including pro-rata and empty-book |
| 8 | Aug 6 | `Settlement.sol`: signature verify, replay guard, FTSO band | Tests pass against a mock signer |
| 9 | Aug 7 | Relayer + full E2E | **★ First sealed batch settles on Coston2** |
| 10 | Aug 8 | Frontend: connect, deposit, encrypt, submit | Order submitted from a browser |
| 11 | Aug 9 | Frontend: batch view, clearing price, fills | Full flow usable by a stranger |
| 12 | Aug 10 | Naive AMM + sandwich-bot script for the comparison demo | Sandwich reproduces on demand |
| 13 | Aug 11 | Buffer. Polish, attestation docs, deploy addresses, error paths | n/a |
| 14 | Aug 12 | Record video, write README + submission | Video under 4 min, links live |
| 15 | Aug 13 | **Submit.** Post in the Flare Telegram, get 3 to 5 people to try it | Submitted, 24h before deadline |

Aug 14 is deadline day and is reserved as pure slack. Do not plan work into it.

**Day 9 is the milestone that matters.** If Day 9 slips past Aug 9, cut the frontend to a CLI demo and protect the video.

---

## 10. Judging criteria to evidence

| Criterion | What we point at |
|---|---|
| Product usefulness | MEV is a quantified, ongoing extraction from real traders; dark pools are the proven TradFi answer; FAssets agents are a named user with the problem |
| Flare integration quality | FCC is the product, not a feature. FTSO enforces the fairness band on-chain. FXRP is the traded asset. Removing any of them breaks it. |
| Technical execution | Live Coston2 addresses, working browser demo, `forge test` suite, honest architecture diagram, threat model |
| Evidence of new work | Repo starts empty on Jul 30; commit history is the proof; explicit built/ported/out-of-scope table |
| Clarity and future potential | This document; the stated cut lines; the PMW to XRPL roadmap |

**Submission checklist:** name · both bounties · description · target user · demo video · live link · repo · Flare integration writeup · new-work table · Coston2 addresses · roadmap · any user feedback gathered.

---

## 11. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| FCC tooling is pre-production and something is broken | High | Day 1-2 exists to find out. Flare Telegram is an active support channel; use it early, not on Aug 13. |
| Q1 (signing) has no clean answer | Medium | Fallback (b) is already specified and works |
| Clearing algorithm edge cases eat days | Medium | Unit-test off-chain in plain TypeScript, no chain in the loop |
| Frontend consumes the endgame | Medium | It is Days 10-11, after the milestone. A CLI demo is an acceptable downgrade. |
| Real FXRP unobtainable on testnet | Resolved | Faucet dispenses real FXRP and USDT0, see §7 Q2 |
| Solo burnout across 15 days | High | Day 13 is deliberate buffer. Submit on Day 15, not Day 16. |

---

## 12. Roadmap beyond the hackathon

1. **PMW settlement to XRPL**: deliver native XRP to counterparties who never touch Flare. The full round trip, and the most natural next build.
2. **Real attestation** on a Confidential Space VM with a reproducible, independently verifiable image hash.
3. **Multi-TEE replication** so a single enclave is not a liveness dependency.
4. **FAssets-agent integration**: agents rebalancing large FXRP positions are the highest-value first users and already exist as an identifiable group.
