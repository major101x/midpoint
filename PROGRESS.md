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

### Next

Day 3 spike: resolve Q1 (TEE signing path) before any work on `Settlement.sol`.
