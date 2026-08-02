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

### Next

Day 6: decrypt inside the enclave. Needs the ECIES format the sign port's
`/decrypt` expects to be determined, then the inner-trader equality check.
