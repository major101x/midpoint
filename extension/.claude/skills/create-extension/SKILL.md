# Create Extension

Guides the developer through implementing their extension's business logic — the core "what does your extension do?" workflow. Works for any implementation language.

## When to Use

The user wants to implement their extension logic: define operations, write handlers, and wire up the Solidity contract. They may say things like:
- "create my extension"
- "add an operation"
- "implement my extension logic"
- "add a new op type"
- "/create-extension"

## Inputs

The skill needs two things.

**1. The implementation language.** Determine it in this order:
1. The user said so explicitly ("add a Python handler").
2. Read `LANGUAGE=` from `.env` at the scaffold root.
3. If `.env` is absent or has no `LANGUAGE`, default to `go` (the scaffold default) and say so.

Valid values are the directory names for which `<dir>/language.env` exists — run `ls -d */language.env | cut -d/ -f1` to enumerate. Do NOT assume the list is `go python typescript`; the scaffold is convention-based and the user may have added their own.

**2. The operation(s).** For each, gather:
- **Name** (e.g. "SayHello", "Transfer", "Swap")
- **Description** — what it does
- **Request fields** — what the caller sends
- **Response fields** — what the extension returns
- **Encoding** — JSON (the common case) or ABI-encoded

If the user is vague, ask: "What operation(s) should your extension support? For each, describe the name, what it does, and what data it takes and returns."

Before starting, read the current state of the files — the scaffold may already be renamed, or some operations may already exist.

## Steps to Execute

All paths are relative to the scaffold root (the directory containing `foundry.toml`).

### Step 1: Language-neutral — Solidity contract

Read `contracts/InstructionSender.sol` first. Add one `bytes32` constant per operation and a matching send function. The scaffold ships:

```solidity
bytes32 public constant OP_TYPE_GREETING = bytes32("GREETING");
bytes32 public constant OP_COMMAND_SAY_HELLO = bytes32("SAY_HELLO");
```

The op-type and op-command strings must **exactly match** the constants you will add in the extension language. A mismatch means actions fall through to "unsupported op type" (HTTP 501).

For a JSON payload, the send function takes `bytes calldata _message`. For an ABI-encoded payload, take typed parameters and `abi.encode(...)` them into a struct — see `sendSayGoodbye` for the pattern.

### Step 2: Language-specific — constants, handlers, state

**Read the reference for the target language and follow it:**

| Language | Reference |
|---|---|
| `go` | `references/go.md` |
| `python` | `references/python.md` |
| `typescript` | `references/typescript.md` |
| anything else | `references/adding-a-language.md` |

Each reference covers the same four things in that language's idiom: where op constants live, how to register a handler, the 4-step handler pattern, and how to extend the reported state.

### Step 3: Regenerate bindings

```bash
./scripts/generate-bindings.sh
```

Compiles the Solidity contract and regenerates the Go bindings in `tools/pkg/contracts/`. Required after ANY Solidity change, in every language — the deployment tooling is Go regardless of the extension language.

### Step 4: Update the test tooling

Read `tools/pkg/utils/instructions.go`. If you added send functions with new signatures, add matching Go helpers. Then update `tools/cmd/run-test/main.go` with payloads and response assertions.

`tools/` is deliberately independent of every language implementation — declare expected response shapes as local structs there, never import them from a language directory. That independence is what lets one test path serve all languages.

### Step 5: Update the conformance fixtures

If you changed any handler's request or response shape, the golden fixtures no longer match. Edit `testdata/conformance/gen_fixtures.py` to describe the new operations, then regenerate:

```bash
./python/.venv/bin/python testdata/conformance/gen_fixtures.py
```

Skipping this is the most common way to leave the repo in a state where `test-conformance.sh` fails for reasons unrelated to the user's change.

## Verification

Run all three layers, cheapest first:

```bash
./scripts/test-unit.sh
```

```bash
./scripts/test-conformance.sh
```

```bash
cd tools && go build ./...
```

If the user maintains more than one language, also run `./scripts/test-conformance.sh --all` — implementations must stay byte-identical on the wire.

Report the results to the user plainly, including any failures with their output.

## Important Notes

- **Do NOT modify infrastructure code.** Anything marked "DO NOT MODIFY" is boilerplate: `go/internal/extension/utils.go`, `go/pkg/server/`, `python/base/`, `typescript/src/base/`. Your changes belong in the app layer.
- **Always read each file before editing** to confirm current content.
- **Op-type strings must match exactly** across Solidity and the extension language.
- **Consult `docs/extension-contract.md`** for anything wire-format related. It is normative, and it documents traps — notably that `ActionResult.version` is a plain string while `StateResponse.stateVersion` is bytes32.
- If the user maintains multiple languages, **apply the change to all of them**, or state clearly which you changed and which you left behind.
- Use `replace_all: true` when replacing identifiers that appear multiple times in a file.
