# Build log

Running record of what was built, and when. Kept because the hackathon judges
on "evidence of new work" and this repo started empty on 2026-07-30.

---

## Day 1 to 2, 2026-07-31: environment and pipeline proven

**Milestone reached: a real instruction round-trips through a TEE on Coston2.**

```
Hello, World! Welcome to Flare Confidential Compute.   GreetingNumber: 1
Goodbye, World! Reason: heading out                    FarewellNumber: 1
```

### Deployed on Coston2

| Thing | Value |
|---|---|
| Deployer / owner | `0x2382CCa5073a6fd18AD8e94F9B412ebAC120Cb15` |
| InstructionSender | `0x9DB9d092E4a600f002D43F28675d25285f80aF05` |
| Extension ID | `0x10150` (65872) |
| Registered TEE machine | `0xFAcCDbDB46763190251501e9AeD3108928238073` |
| Code hash (simulated) | `0x194844cf417dde867073e5ab7199fa4d21fd82b5dbe2bdea8b3d7fc18d10fdc2` |
| Platform | `TEST_PLATFORM` (simulated attestation) |

Stack: `LANGUAGE=typescript`, `SIMULATED_TEE=true`, `LOCAL_MODE=false`.
Three containers running: `redis`, `ext-proxy`, `extension-tee`.

### Measurements worth keeping

- **Instruction round trip: about 6 seconds** (send to result available at the proxy). Sets the floor for `closeBatch` latency. Batch windows in minutes are comfortable.
- **FTSO XRP/USD read live**: value `1063983`, decimals `6`, so $1.063983.
- **FXRP and USDT0 both use 6 decimals.** Never assume 18.

### Open questions moved

- **Q2 RESOLVED.** Real testnet FXRP and USDT0 come from the faucet. No mock ERC-20 needed, which strengthens the Bounty 1 claim.
- **Q3 PARTIALLY RESOLVED.** Only one TEE machine is registered for this extension, so `getRandomTeeIds(extensionId, 1)` is trivially stable today. That is enough for the hackathon, but it is stability by accident, not by design. `OrderBook.sol` should pin the TEE id for a batch's lifetime at `closeBatch` rather than re-drawing, so the book cannot end up split across enclaves if a second machine is ever registered.
- **Q1 STILL OPEN** (TEE signing of the settlement payload). Encouraging signal: the proxy `/info` endpoint publishes the TEE's `publicKey` (x, y), so the enclave demonstrably holds a keypair with a published public half. That is the foundation the fallback approach needs.

### Environment problems solved (not in the original plan)

1. **No VPN needed for Coston2**, confirmed by Flare admin in Telegram. The prerequisite line in `docs/deployment-steps.md` is misleading.
2. **Indexer DB credentials are required** and are not in the docs. Obtained from Flare in Telegram. Host is `34.38.42.208`; the `35.241.249.150` in `deployment-steps.md` is stale and unreachable.
3. **Docker Desktop was installed but stopped**, and the CLI defaulted to its socket. Started via `systemctl --user start docker-desktop`. It is `disabled` at boot, so this will recur after a reboot.
4. **BuildKit could not reach the registry.** The host has no IPv6 default route, but BuildKit resolved `production.cloudfront.docker.com` to IPv6 and failed. Worked around by pre-pulling all pinned base images with `docker pull`, which uses the daemon's working IPv4 path, then building against the local cache.

### Notes

- Credentials live in `config/proxy/extension_proxy.coston2*.toml`, both already covered by the scaffold's `.gitignore`.
- ngrok returns a stable subdomain on this account, so a restart does not invalidate the on-chain TEE registration.
- `pre-build.sh` refuses to re-run while `config/extension.env` exists. Do not pass `--force`; it mints a new extension ID and can trigger `MachineManager.TooMany()`.
- Flare's own tooling warns that in simulated mode the code hash is self-reported rather than proven by hardware. Say this plainly in the README and video, per spec §8.

---

## Day 3, 2026-08-01: Q1 spike resolved

**Q1 RESOLVED.** Settlement will use an in-enclave secp256k1 key signing with the
documented `fce-sign` pattern, verified on-chain with plain `ecrecover`. Full
reasoning in `spec.md` §7 Q1.

### What was investigated and rejected

Reusing the TEE's own result signature looked ideal and was chased down properly:

- `GET /action/result/<id>` returns `{result, signature, proxySignature}`, both 65 bytes.
- The TEE identity key **is** the registered machine id. Deriving the address from the `/info` public key (`keccak256(x || y)` last 20 bytes) produced `0xcedcf76d...60c7`, matching the registry exactly.
- The signing construction was read from source: `keccak256(abi.encode(bytes32 prefix, uint256 chainId, bytes32 dataHash))`, `prefix = bytes32("TEE_ACTION_RESULT")`, `dataHash = ActionResult.Hash()`, where `ActionResult.Hash() = keccak256(keccak256(data) || id || keccak256(submissionTag) || status)`.
- Reproducing it did not verify. A **control test** using the proxy's known private key against `proxySignature` also failed to recover, proving the method was wrong rather than the TEE key.
- Both ABI tuple encodings (inline and offset-prefixed), both recovery ids, several chain ids, and several candidate dataHash values were brute-forced with no match.
- `VerificationFacet` (`0x78203332236cF39A0079746385F33060aCC95778`) exposes only `requestTeeAttestation`, `confirmAvailability`, `getCosigners`, and settings. No on-chain action-result verification helper exists.

Stopped here deliberately. Settlement resting on an undocumented detail would be worse than a documented pattern, and the days are better spent on the product.

### Critical finding: TEE keys are ephemeral

The registered TEE machine id changed across a container restart:

```
0xFAcCDbDB46763190251501e9AeD3108928238073   (07-31)
0xCEDCF76d90c5Fe875cBC05B1191bF160ad7C60C7   (08-01, after restart)
```

`Settlement.sol` must therefore store the signer in mutable storage with a setter,
never a constant. The in-memory order book has the same property: a batch that
spans an enclave restart must be voidable, not settleable.

### Operational findings

1. **Re-registration is needed after reward epochs advance.** After a day, the proxy had moved from policy 5883 to 5888 and instructions were silently never picked up: no error, just no result in storage. Fix is to re-run `post-build.sh`.
2. **`post-build.sh` needed patching to re-run.** It called `register-tee` with the default `-command rap`. Per `docs/deployment-steps.md`, re-runs need `-command rRap`, because `r` skips itself once registered and the availability challenge is then never issued. Patched locally in `scripts/post-build.sh`.
3. **Foundry auto-loads `.env` from the working directory.** Our `.env` sets `CHAIN=coston2`, which is not a valid Foundry chain name, so every `cast` call from the scaffold directory fails with a confusing `invalid value 'coston2' for '--chain'`. Run `cast` from a neutral directory.
4. **Debugging trap:** `%x` on `hexutil.Bytes` invokes `String()` first, printing the hex of the ASCII of the hex string. Signature bytes look double-encoded when they are fine. Cost about twenty minutes; check `len()` before believing the print.

---

## Day 4, 2026-08-01: Vault

**`forge test` green: 22 passing, 19 offline and 3 forked against real Coston2 tokens.**

Foundry project lives in `contracts/`, deliberately separate from the vendored
scaffold so the core contracts test with no Docker, no TEE and no network.
`forge-std` is a submodule, so clone with `--recursive`.

### What Vault does and why

Traders pre-fund an internal balance and draw orders against it. Per-order escrow
was rejected: the escrowed amount *is* the order size, published on chain, which
would make the order encryption decorative. This is the design decision the whole
privacy claim rests on.

The consequence is that the chain cannot know whether a trader's balance covers
their encrypted order, so it cannot lock the right amount at submission time
without revealing it. Sealed freezes withdrawals for the duration of a settling
batch instead. Deposits stay open while frozen, since blocking inflows would be
gratuitous.

`move(from, to, isBase, amount)` is the only mutation available to settlement.
Keeping it a primitive leaves Vault ignorant of auction mechanics.

### Hazards handled

- **Non-standard tokens.** `SafeTransfer` uses low-level calls that accept either empty return data or a value decoding to `true`. A strictly typed `IERC20.transfer` would revert on the USDT lineage even when the transfer succeeded. Proven against real USDT0 in a fork test, not just a mock.
- **Fee-on-transfer.** Deposits credit the balance delta actually received, not the amount requested, so the vault can never credit more than it holds. Fuzzed for solvency.
- **Reentrancy.** Checks-effects-interactions plus a guard.
- **Decimals.** Balances are raw token units, so nothing assumes 18. Test constants spell out `1e6` so a future change breaks loudly.

### Environment notes

1. `forge init` created a nested `.git` inside `contracts/`, which silently made the first commit contain nothing but `.gitmodules`. Removed it and re-added as a proper submodule (mode `160000`).
2. `forge init` also wrote `.github/workflows/` inside `contracts/`, where GitHub ignores it. Moved to the repo root and adjusted to run from `contracts/` with `submodules: recursive`. Fork tests are excluded in CI since they need a live RPC and a funded address.

---

## Day 5, 2026-08-02: OrderBook live on Coston2, SEALED reaching the enclave

**Acceptance criterion met.** A real order submitted on chain reached the TEE
with the right op-type and the handler accepted it:

```
main queue: routing action with OPType, OPCommand: SEALED, SUBMIT_ORDER
action 0xab3d...: opType=SEALED opCommand=SUBMIT_ORDER status=1
handler response: {"batchId":"1","accepted":true,"ordersInBatch":1}
```

### Deployed on Coston2

| Thing | Address |
|---|---|
| Vault | `0xa49fbba899ab03f7ba0694989738a4c222a5e4d9` |
| OrderBook | `0xb4c2eaB99883280eCb886dB38a8710Ffe215698b` |
| Extension ID | `0x10160` (65888) |
| TEE machine | `0x2Fd46E88149D0BF66D66a886bd3A93F857B55A86` |

Superseded: the day 1-2 hello-world extension `0x10150` and its instruction
sender `0x9DB9...aF05` are dead. Do not reference them.

### Pinning verified against the real registry

On chain after one order: `orderCount = 1`, `batchTee =
0x2fd46e88149d0bf66d66a886bd3a93f857b55a86`, which is exactly the registered TEE
machine. The property was also mutation-tested off chain: disabling pinning makes
`test_pinning_allOrdersInBatchGoToSameTee` fail.

Writing the mock sharpened *why* pinning matters. `getRandomTeeIds` is `view`, so
it compiles to a STATICCALL and cannot mutate storage, which means Flare's
randomness must come from block state: stable within a block, free to change
between blocks. A batch spans many blocks, so a per-order draw would scatter one
batch across enclaves and clear against a partial book. That is a silent wrong
answer, the worst failure mode available.

### Security property added beyond the spec

The spec put `trader` inside the encrypted payload, which is self-declared.
Nothing stopped a bystander copying a ciphertext out of a public transaction and
resubmitting it. `OrderBook` now sends `abi.encode(msg.sender, batchId,
ciphertext)`, so the enclave can reject a blob whose inner trader does not match
the actual sender, in this batch or a later one. The equality check itself lands
with decryption on day 6.

### Architecture decision: deployment lives in our repo

The scaffold's `register-extension` accepts any address as the instructions
sender, so `Vault` and `OrderBook` are deployed by `contracts/script/Deploy.s.sol`
and never copied into the vendored tree. Our contracts cannot drift from the
tested versions in `contracts/src`, and the scaffold is left to do only what it
is good at: running the enclave.

### Test counts

- Solidity: 44 passing (19 Vault, 25 OrderBook), plus 3 forked.
- Extension TypeScript: 50 passing, including two confidentiality tests asserting
  that `GET /state` never contains a ciphertext or trader address. `/state` is
  reachable from outside the enclave, so that is a first-class property.

### Notes

- Instruction fee is `1000000` wei, taken from `tools/pkg/utils/instructions.go`. Sending zero reverts.
- Registering a new instructions sender mints a **new** extension id, which then needs `config/extension.env` updated, the container restarted, and `post-build.sh` re-run. The TEE machine address changes again each time.

### Repo layout

The Flare scaffold was forked into `extension/` so the confidential-compute half
of the product lives in this repo rather than in an untracked directory. Done as
two commits on purpose:

1. `vendor: fce-extension-scaffold at f48cafb` contains upstream unmodified. None of it is our work.
2. Everything after it is ours, so our enclave changes read as a reviewable diff against a known baseline.

Secrets stay out: `.env*`, `config/extension.env` and
`config/proxy/extension_proxy.coston2*.toml` are all covered by the scaffold's
own `.gitignore`, and the staged tree was grepped for the indexer credentials and
the deployer private key before committing. Both clean.

Note: the docker compose project name derives from the directory, so the next
rebuild replaces the `fce-extension-scaffold-*` containers with `extension-*`.

---

## Day 6, 2026-08-02: sealed orders decrypting inside the enclave

**Verified live on Coston2.** An order sealed by `client/`, submitted on chain as
opaque bytes, was decrypted and accepted inside the TEE:

```
routing action with OPType, OPCommand: SEALED, SUBMIT_ORDER
opType=SEALED opCommand=SUBMIT_ORDER status=1
handler response: {"batchId":"2","accepted":true,"ordersInBatch":1}
enclave /state:   {"openBatches":1,"openOrders":1,"lastClearedBatch":"0","lastClearingPrice":"0"}
```

That `/state` line is the product working. One order is resting in the book, and
nothing about its side, price, size or owner is visible from outside the enclave.

### The encryption scheme

Determined by reading tee-node rather than guessing: it calls
`ecies.Decrypt(ciphertext, nil, nil)` with go-ethereum's defaults
(ECIES_AES128_SHA256). **The common JavaScript ECIES libraries are not
wire-compatible with this.** `eciesjs` defaults to AES-256-GCM; `eth-crypto` and
`eccrypto` use AES-256-CBC with a SHA-512 KDF. Either produces ciphertext the
enclave silently refuses.

Implemented directly in `client/src/ecies.ts` against geth's layout:

```
R(65) || IV(16) || AES-128-CTR ciphertext || HMAC-SHA256(32)
Ke = K[0:16], Km = SHA256(K[16:32]),  K = concatKDF(ECDH_x, 32)   NIST SP 800-56
```

Pinned by a round-trip test, a wire-layout test, and a live probe against the
running enclave.

### Q1 revised: the TEE signs with its own identity key

Reading the sign port turned up `POST /sign`, which the scaffold does not wrap
and the docs do not mention. It computes
`crypto.Sign(accounts.TextHash(keccak256(message)), teePrivateKey)`, so it is a
plain EIP-191 signature from the **TEE identity key**, whose address is the
registered machine id.

Verified: signing a probe string inside the enclave and recovering it gave
`0x2fd46e88...5a86`, exactly the registered machine. Settlement therefore needs no
key management at all, and should require the signer to equal the `batchTee`
already pinned by OrderBook. See `spec.md` §7 Q1. The day 3 failure was specific
to the `ActionResult` path, which wraps its digest in a domain-separated payload
that `/sign` does not have.

### Replay protection is now enforced

The enclave rejects an order unless the `trader` and `batchId` inside the
ciphertext match the ones OrderBook took from `msg.sender`. Tested as adversarial
scenarios: a ciphertext lifted from a public transaction and submitted by someone
else, and the same ciphertext replayed into a later batch.

Handler error strings are deliberately terse. They surface in action results
readable through the proxy, so a validation message must never carry a price or
size. There is a test asserting exactly that.

### The ephemeral-key hazard, hit for real

Rebuilding the enclave changed the TEE machine from `0x2Fd46E88...5A86` to
`0xC52c42dB...9407`, while `OrderBook.batchTee` was still pinned to the dead one.
Batch 1 could not be settled, only voided: `closeBatch` then `advanceBatch`, which
is exactly the "a batch spanning an enclave restart must be voidable" rule the
spec records. Good to have exercised the recovery path before it mattered.

### Environment notes

1. **The container rename bit.** Forking the scaffold to `extension/` changed the compose project name, so the new `extension-*` containers collided with the old `fce-extension-scaffold-*` ones on port 6382. Worse, a half-created `extension-redis-1` was left attached to **no network**, so the proxy panicked with `lookup redis: no such host`. Fix: remove the old containers and the stale network, then start clean.
2. `@noble/ciphers` was resolving as a transitive dependency only. Declared explicitly, since a dependency bump would otherwise break encryption silently.

### Test counts

- Solidity: 44 offline, 3 forked.
- Extension: 61.
- Client: 13.

---

## Day 7, 2026-08-02: clearing engine and signed settlement payloads

`extension/typescript/src/app/auction.ts`. **80 extension tests, 13 client, 44
Solidity plus 3 forked.**

### The mechanism, as implemented

1. Choose `p*` to maximise executed volume.
2. Break ties by minimising imbalance, `|demand - supply|`.
3. Break remaining ties by taking the midpoint of the tied range, so the surplus is split rather than handed to one side.

Allocation respects price priority: an order offering strictly better terms than
`p*` fills before one that only just qualifies. Orders sitting exactly at `p*` are
**rationed pro-rata, never by arrival**. Rationing by arrival would rebuild the
queue race the venue exists to remove, which would be a subtle way to undo the
whole design.

### Why the tests look the way they do

A wrong clearing price does not crash. It moves the wrong amount of money and
looks fine. So correctness is argued two ways:

- **Property test over 400 random books**, each checked against an independent brute-force optimum, plus conservation, no overfill, and nobody trading outside their limit. Deterministic PRNG, so any failure is reproducible from its seed.
- **Mutation check.** Removing the pro-rata remainder distribution fails two tests. All arithmetic is integer, and settlement requires both sides to net to zero, so a lost remainder unit would revert an entire batch.

### Signing

`RUN_MATCH` now ABI-encodes `(batchId, clearingPrice, Fill[])`, signs it through
the sign port's `POST /sign`, and returns payload plus signature. The signer is
the TEE identity key, so no key is generated, distributed or stored anywhere.
`Settlement.sol` will rebuild the same digest:

```solidity
bytes32 inner  = keccak256(payload);
bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", inner));
require(ecrecover(digest, v, r, s) == batchTee);
```

### A bug worth recording

The first version of `handleRunMatch` deleted the book **before** signing, so an
unreachable sign port would have destroyed the batch with no way to retry or
void it, contradicting the comment sitting immediately below it. Now the book is
consumed only once a signature exists, with a regression test that fails signing,
asserts the orders survive, then retries successfully.

A batch that does not cross still clears, as an empty settlement, so traders'
funds unfreeze promptly rather than waiting for a batch that will never fill.

---

## Day 8, 2026-08-04: Settlement

**74 Solidity tests, 82 extension, 13 client.**

`Settlement.sol` runs four independent checks before touching a balance:

1. **Provenance.** The signature must recover to the exact TEE machine `OrderBook` pinned for this batch. Not any registered TEE, and not an address an admin typed in. Nobody else can produce it, including the operator, and `test_settle_ownerCannotForge` says so.
2. **Replay.** Only the currently closed batch settles, and settling advances it.
3. **Price sanity.** The clearing price must sit within `bandBps` of the FTSO oracle. This is what bounds a hidden engine's discretion, and the reason the venue does not require blind trust in the TEE. Skipped for empty batches, which have no price and would otherwise strand.
4. **Conservation.** Base bought equals base sold, quote paid equals quote received. Value moves between traders, never appears or vanishes.

### A correctness problem found while writing it

Both sides of a batch trade the same total base, but quote is `floor(size * price / 1e6)`. Flooring **per fill** makes the two totals diverge whenever one side has more fills than the other, so settlement would come up a few units short and revert the whole batch. Subtle, and it would have looked like a random failure on a demo.

Fixed by allocating quote **inside the enclave**: compute the total once from total volume, then split it across each side exactly, reusing the remainder logic already property-tested for base. Settlement then only has to verify that both legs net to zero, rather than reproduce the arithmetic. `test_settle_quoteNotConserved_reverts` and a dedicated conservation test cover it.

### The cross-language seam is now tested

The enclave encodes the payload with viem and Solidity decodes it, and the signature covers those exact bytes, so any layout disagreement breaks every settlement. There is now a conformance test holding a payload generated by the real extension encoder, asserting Solidity decodes it field for field and actually settles it. If the two sides drift, the test fails rather than the demo.

### Notes

- `_applyFills` collects from every payer before paying anyone, using the Settlement contract's own vault account as a pass-through. It nets to exactly zero, asserted in `test_settle_conservesTotalBalances`.
- The vault is frozen only while balances are in flux, then released in the same transaction.
- The FTSO reading is rescaled from the feed's own `decimals` rather than assuming 6. The field exists because it can change, and assuming would misprice by orders of magnitude.
- `IFtsoV2.getFeedById` is declared `view`, matching Coston2. Flare's production interface marks the equivalent payable so a fee can be charged; if that ever applies, Settlement needs revisiting.

---

## Day 9, 2026-08-04: ★ FIRST SEALED BATCH SETTLED ON COSTON2

The milestone the whole plan was built around. Orders sealed client side,
submitted on chain as opaque bytes, decrypted and cleared inside the enclave,
signed with the TEE identity key, relayed, and settled after four on-chain checks.

```
batch 1   clearing price 1.065000   volume 4.000000 FXRP
settle tx 0xa827f1710adb808965dedbc66fa61cb7a2d13b28ba3b311f2cfeccd212bbd043

maker  FXRP 4.000000 -> 0.000000   USDT0 0.000000 -> 4.260000
taker  FXRP 0.000000 -> 4.000000   USDT0 5.000000 -> 0.740000
conserved: base true, quote true
```

4 FXRP at 1.065 is 4.26 USDT0 exactly. Nobody outside the enclave ever saw a
side, a limit price or an order size.

### Live deployment (current)

| Thing | Address |
|---|---|
| Vault | `0x5713888cC2AD639000872f2b8282D68B425b3cC2` |
| OrderBook | `0xeB37fDA0f90AC634cb43DfDcF8080851087ca3E4` |
| Settlement | `0x9Ca8a93c86C60D732113155184E40DBe2958cEE4` |
| Extension ID | `0x10196` (65942) |
| TEE machine | `0x2C0e95a9D3C98acEb0646E45F678572698ad2998` |
| Maker (demo) | `0xE9217204186e6b3D3d8e5109a7dD8a9D45B5F0BD` |
| Taker (demo) | `0x1206a2Bf6375B1446c53Ea5Ed5766e85917c1d5c` |

Supersedes every earlier deployment. The previous `OrderBook`
(`0xb4c2...698b`) predates `voidBatch` and has a batch stranded behind a paused
enclave; it is dead and must not be referenced.

### OPEN GAP found by running it: the enclave cannot see vault balances

The first settlement attempt reverted with `Vault.InsufficientBalance`. The
maker had sold 4 FXRP across two runs while holding only 3 in the vault.

This is a real design gap, not a demo artifact. **The enclave clears orders
without knowing whether traders can honour them**, so it can sign a perfectly
valid settlement that the vault cannot execute. The whole batch then reverts and
every trader in it waits for `voidBatch`.

The fix is cheap and leaks nothing: **vault balances are already public on
chain**, so `OrderBook` can include the submitter's current base and quote
balance in the envelope it sends to the enclave, and the enclave can reject or
cap an order that exceeds what the trader can cover. No new information is
revealed, because anyone can already read those balances.

Recorded rather than rushed. It needs a contract change, a redeploy, a new
extension id and an enclave rebuild, so it is the first task of day 10.

### Notes

- A brand new extension id starts with exactly one active TEE machine, confirmed with `getActiveTeeMachines`. The zombie-machine problem from day 7 only accumulates within one extension.
- `closeBatch` correctly refused to run instantly with `BatchTooYoung`. The demo now waits out the window rather than assuming.
- Demo traders are funded by transferring from the deployer rather than the faucet, since the faucet is limited to one address per 24 hours.

---

## Day 10, 2026-08-04: collateral guard, and a second clean settlement

**76 Solidity tests, 93 extension, 13 client.**

The balance gap from day 9 is closed. `OrderBook` now reads the submitter's vault
balances on chain and sends them with the order; the enclave reserves against
them cumulatively per trader per batch and rejects anything the balance cannot
cover.

Proven live. The maker held 1 FXRP and tried to sell 5:

```
vault base balance: 1.000000 FXRP
submitting SELL of 5.000000 FXRP, which the balance cannot cover
on chain: accepted (the chain cannot see the size)
enclave verdict: status=0  log="error: order exceeds available base balance"
```

That contrast is the design in one screen. The chain **cannot** police the order,
because it cannot see it, which is the entire point of the venue. So the enclave
polices it, using public balances the chain passes in. Sending them leaks
nothing: anyone can already read vault balances directly.

Reservations are conservative. A sell commits its size in base. A buy commits
`size * limitPrice` in quote, an upper bound, because buyers pay the clearing
price and that is never worse than their own limit.

### Second settled batch, on the fixed deployment

```
batch 1   clearing price 1.065000   volume 2.000000 FXRP
maker  FXRP 3.000000 -> 1.000000   USDT0 0.000000 -> 2.130000
taker  FXRP 0.000000 -> 2.000000   USDT0 4.000000 -> 1.870000
conserved: base true, quote true
```

### Live deployment (current)

| Thing | Address |
|---|---|
| Vault | `0x38F182C65415C9bBCA03420E256E8A9E957B72b2` |
| OrderBook | `0xDC1F76dD480EE9A3B4383a29a1C956E11E5326d4` |
| Settlement | `0xd064e426F10a8DC00E9892722c468C8A41e9Cb45` |
| Extension ID | `0x10198` (65944) |
| TEE machine | `0x02a2Dd00685F76F93185F1E59359863F8BdCF9C7` |

Supersedes the day 9 deployment (`0x5713...`, `0xeB37...`, `0x9Ca8...`).

### Known behaviour worth stating

`OrderBook.orderCount` counts **submissions, not acceptances**, because the chain
cannot tell whether the enclave accepted an order without being told what was in
it. So a batch can show orders on chain while the enclave's book holds fewer. If
every order in a batch is rejected, `RUN_MATCH` returns "no orders for batch" and
the batch needs `voidBatch`. That is the correct trade: the alternative leaks
which orders were valid.

### Notes

- A redeploy strands balances in the previous vault. Traders must withdraw and re-deposit; the demo now deposits what a wallet actually holds rather than a fixed amount, so it survives that.
- After a settled batch the roles naturally invert: the seller is holding quote and the buyer is holding base.

### Next

Frontend, then the naive-AMM comparison demo, then the video and submission.

---

## Day 11, 2026-08-07: web interface

Vite + React + viem, in `web/`. The page is arranged around one contrast,
because that contrast is the product: a "what the chain sees" panel beside a
"what only the enclave sees" panel. Orders are sealed in the browser, so
plaintext never leaves the page, reusing the ECIES the `client` package tests
with `Buffer` removed.

Verified against the live deployment: batch 2, enclave pinned
`0x02a2Dd00...`, last settled batch 1, all read from Coston2. Screenshot in
`docs/screenshot.png`.

The order form mirrors the enclave's collateral rule so an order the TEE would
reject is caught before it costs an instruction fee. The footer states the
attestation posture without being asked.

Vite proxies `/tee` to `localhost:6674`, because the FCC proxy sends no CORS
headers.

---

## Day 12, 2026-08-07: the comparison, and a third settled batch

**88 Solidity tests (9 new), 93 extension, 13 client.**

The MEV claim is now measured rather than asserted. `NaiveAmm` is a correct
constant-product pool for the same FXRP/USDT0 pair, deployed separately at
`0xe93ded1d2a9501ad47f493a17a2bb1411148d408`, and `client/scripts/sandwich.mjs`
runs the same trade down both paths on Coston2.

```
                                public pool         sealed venue
visible before it fills         yes                 no
price depends on order size     yes                 no, one clearing price
checked against an oracle       no                  yes, FTSO band
execution price                 1.133141            1.026613
price if unobserved             1.048538            1.026613
cost of being observed          747 bps             0 bps
```

Stable at 746-747 bps across five consecutive runs. The searcher ends flat in
FXRP and up roughly 0.0014 USDT0, funded entirely by the front-run's proceeds.

### The point the pool makes better than any argument

Nothing in `NaiveAmm` is deliberately broken. It has tracked reserves, a 30 bps
fee, a slippage bound, and it re-prices against what actually arrived rather
than what was asked for. It is sandwichable anyway. The vulnerability is in the
shape of the venue, not in a bug a careful developer would have caught, which is
why a better AMM implementation is not the answer.

The slippage bound is worth singling out. `test_sandwich_slippageBoundConvertsA-`
`LossIntoAFailedTrade` shows it converts a bad fill into a failed trade rather
than preventing the extraction. It caps the loss at whatever the trader was
willing to tolerate, and an attacker sizes the front-run to take exactly that.

### Honest limits, stated in the script header rather than left to be found

1. **Coston2 exposes no public mempool.** `txpool_status` is not served and
   there is no pending-transaction subscription. The script cannot race for the
   ordering a real searcher races for, so it executes the three transactions in
   the order a successful searcher achieves. The claim under test is "an
   attacker who front-runs profits", not "an attacker always wins the race".
2. **The pool is shallow**, because faucet FXRP is capped at 10 per address per
   day and only about 5 exists across all three wallets. Constant-product
   pricing is scale invariant, so sizes are set as fractions of the reserves and
   the depth is printed with every result. The same figures hold on a pool a
   million times deeper.

### Problems hit and fixed

1. **`PriceOutsideBand` on the first full run.** Hardcoded limits cleared at
   1.074488 against a feed reading 1.029415, outside the 2% band. This is the
   guard working. Limits are now derived from the live FTSO reading, straddling
   it by 1%.
2. **`OutOfGas` inside FXRP.** FXRP is a FAssets proxy whose `transfer`
   delegates twice and reads an emergency-pause flag from a third contract. A
   swap paying out FXRP costs far more than the estimator predicts against
   pre-swap state. Gas is now padded 50%.
3. **Instructions silently not picked up again**, the day 7 failure recurring
   after a reward epoch advance. `post-build.sh` fixes it, but it needs the
   ngrok tunnel running first and `go` on `PATH` (`~/.local/go/bin`).
4. **A second zombie TEE machine.** Restarting the container regenerated the
   identity key, so `getActiveTeeMachines` now lists both `0x02a2Dd00...` (dead)
   and `0xeDA60B45...` (live). Batch 2 was pinned to the dead one and had to be
   voided. `getRandomTeeIds` returned the live machine on six consecutive
   samples, so the registry appears to filter on recent availability even though
   both stay listed as active. Relying on that is luck, not design; the standing
   answer is still a fresh extension id.
5. **Runs inherited the previous run's skew.** Each sandwich left the pool
   further from the oracle, so absolute prices drifted out of comparability. An
   arbitrage step now returns the pool to the FTSO price first, which is what a
   real pool experiences between trades.

### Live deployment (unchanged, plus the pool)

| Thing | Address |
|---|---|
| NaiveAmm (comparison baseline, not part of the venue) | `0xe93ded1d2a9501ad47f493a17a2bb1411148d408` |
| TEE machine (current) | `0xeDA60B450bcdef15cFD8F6e594545e91F4B5E3A8` |

Batch 4 settled at 1.026613. Batches 2 and 3 were voided, 2 for the dead
enclave pin and 3 for the out-of-band clearing price.

### Next

Buffer and polish, then the video and the submission writeup.
