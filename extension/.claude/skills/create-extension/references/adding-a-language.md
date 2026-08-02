# Adding a new implementation language

Use this when the user wants an extension in a language the scaffold does not yet ship (Rust, Java, C#, …).

The scaffold is convention-based: nothing in `scripts/`, `tools/`, `contracts/` or `docker-compose.yaml` enumerates languages. Adding one means creating a directory that satisfies the contract, and nothing else.

**Read `docs/extension-contract.md` first.** It is normative and this reference assumes it.

## What you must create

```
<language>/
├── language.env      # manifest — this file is what makes the language discoverable
├── Dockerfile        # must satisfy contract §6
└── <sources>         # framework layer + app layer
```

### 1. `language.env`

Discovery works by globbing `*/language.env`, so this file is what distinguishes an implementation directory from, say, `proxy/` (which also has a Dockerfile). All commands run with the language directory as the working directory.

```sh
LANGUAGE_NAME="Rust"
LANGUAGE_DOCKERFILE="Dockerfile"
LANGUAGE_SETUP_CMD=""              # install deps; empty if the toolchain handles it
LANGUAGE_BUILD_CMD="cargo build --release"
LANGUAGE_TEST_CMD="cargo test"
LANGUAGE_RUN_CMD="./target/release/extension"
```

`LANGUAGE_RUN_CMD` must start the extension HTTP server in the foreground, reading `EXTENSION_PORT` and `SIGN_PORT` from the environment. `scripts/test-conformance.sh` depends on it.

### 2. The framework layer

Port the infrastructure, using `python/base/` or `typescript/src/base/` as the reference:

- **encoding** — hex ⟷ bytes, and bytes32 padding for op identifiers. Note that Go encodes empty byte slices as `"0x"`, not `""` or `null`.
- **wire types** — `Action`, `ActionData`, `DataFixed`, `ActionResult`, `StateResponse` per contract §4. Every `ActionResult` field is always present; `data` and `additionalResultStatus` are `"0x"` when empty.
- **dispatch registry** — `(opType, opCommand)` bytes32 lookup with exact match first, then the empty-opCommand wildcard (contract §5).
- **serialization** — handler calls and state reads must not overlap.
- **HTTP server** — `POST /action`, `GET /state`, plus the 405/404/501 rules in contract §2.
- **node client** — the `$SIGN_PORT` API is **base64**, not hex, because Go marshals `[]byte` that way. This trips up nearly every port.

### 3. The app layer

Implement `GREETING`/`SAY_HELLO` (JSON) and `GREETING`/`SAY_GOODBYE` (ABI-encoded `(string,string)`), behaviourally identical to the existing languages — same greeting strings, same counters, same state keys. `tools/cmd/run-test` and the conformance fixtures both assert on the exact values.

### 4. `Dockerfile`

Unless the language can link tee-node as a library (only Go can), use the two-process shape. Start from `python/Dockerfile` — most of it is boilerplate you can copy:

```dockerfile
ARG TEE_NODE_REF
FROM local/tee-node-base:${TEE_NODE_REF} AS node
```

The shared base image supplies the tee-node `server` binary and the Confidential Space root cert, so you do not repeat the golang stage or the tee-node fetch. `scripts/start-services.sh` builds it automatically for any Dockerfile mentioning `tee-node-base`.

Then satisfy contract §6 exactly: the same `EXPOSE`, the same `MODE`/port env, `USER 0:0`, and an **identical** `tee.launch_policy.allow_env_override` label. A label mismatch means Confidential Space silently rejects operator env overrides at attestation time — the failure appears at deployment, not at build.

Use the `wait -n` CMD pattern with `/bin/bash` (dash does not implement `wait -n`).

Add `<language>/Dockerfile.dockerignore` excluding the other language directories and local build artifacts. Anything reachable in the build context can perturb layer hashes.

## Acceptance

```bash
./scripts/test-conformance.sh <language>
```

16 fixtures, no chain and no Docker required. This is the real gate — it catches wire-format divergence that unit tests miss, and byte-compares the response payloads against the other languages.

Then the full path:

```bash
LANGUAGE=<language> ./scripts/start-services.sh --chain local
```

```bash
./scripts/test.sh
```

`test.sh` is unmodified — if it passes, the language is a first-class citizen.

## Reproducibility

Be honest in `REPRODUCIBILITY.md` about what the new language actually guarantees. Bit-for-bit cross-machine reproducibility requires a static binary and a digest-pinned base; most interpreted or package-manager-driven runtimes achieve same-machine determinism only. The image's code hash is registered on-chain, so overclaiming here has real consequences.
