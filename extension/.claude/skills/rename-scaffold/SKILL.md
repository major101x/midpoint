# Rename Scaffold

Renames all placeholder names in the extension scaffold to the user's chosen extension name. This automates the 5-step "Setup" process described in the README.

## When to Use

The user wants to rename the Hello World extension (`HelloWorldInstructionSender`, `helloworld`, `SAY_HELLO`) to their own extension name. They may say things like:
- "rename this scaffold to Orderbook"
- "set up this extension as PriceFeed"
- "rename the placeholders"
- "/rename-scaffold"

## Inputs

The skill needs one piece of information: the **extension name** (e.g., "Orderbook", "PriceFeed", "Bridge").

How to determine it:
1. **User provided it explicitly** — use what they said (e.g., "rename to Orderbook")
2. **User already renamed the Solidity contract** — read `contracts/InstructionSender.sol`, find the `contract XxxInstructionSender` line, extract `Xxx` as the name
3. **Neither** — ask the user: "What should your extension be called? (e.g., Orderbook, PriceFeed, Bridge)"

## Derived Values

From the extension name (example: `Orderbook`):

| Value | Derivation | Example |
|-------|-----------|---------|
| `CONTRACT_NAME` | `{Name}InstructionSender` | `OrderbookInstructionSender` |
| `GO_PKG` | lowercase of name | `orderbook` |
| `MODULE` | first line of `tools/go.mod` (the `module` directive) | `extension-scaffold/tools` |
| Old contract name | Always `HelloWorldInstructionSender` | `HelloWorldInstructionSender` |
| Old Go package | Always `helloworld` | `helloworld` |

Read `tools/go.mod` line 1 to get the module name — do NOT hardcode it. The module name varies depending on whether this is the scaffold (`extension-scaffold/tools`) or a copy.

**Rename in every language implementation present**, not just the active one. Enumerate them with `ls -d */language.env | cut -d/ -f1`. Beyond the Solidity and bindings renames below, that means:

| Language | Also rename |
|---|---|
| `go` | `module` line in `go/go.mod`, and every `extension-scaffold/...` import path across `go/` |
| `python` | package docstrings in `python/app/`; no module identifier to change |
| `typescript` | the `name` field in `typescript/package.json`, then re-run `npm install --package-lock-only` and commit the lockfile |

Op-type strings (`GREETING`, `SAY_HELLO`, `SAY_GOODBYE`) are **not** part of renaming — they are the extension's operations, changed by `/create-extension`. Renaming them here without updating Solidity and the conformance fixtures in lockstep will break dispatch.

## Steps to Execute

All paths are relative to the scaffold root (the directory containing `foundry.toml`).

### Step 1: Rename the Solidity contract

**File:** `contracts/InstructionSender.sol`

Replace all occurrences of `HelloWorldInstructionSender` with `{CONTRACT_NAME}` using `replace_all: true`.

The contract title comment (`/// @title`) will be updated by this replacement too.

Do NOT touch the OP_TYPE constants, send function names, or any business logic — only the contract name identifier.

### Step 2: Update `generate-bindings.sh`

**File:** `scripts/generate-bindings.sh`

Replace:
```
CONTRACT_NAME="HelloWorldInstructionSender"
```
With:
```
CONTRACT_NAME="{CONTRACT_NAME}"
```

Replace:
```
GO_PKG="helloworld"
```
With:
```
GO_PKG="{GO_PKG}"
```

### Step 3: Rename the Go bindings directory

Rename `tools/pkg/contracts/helloworld/` to `tools/pkg/contracts/{GO_PKG}/`.

Use `git mv` if in a git repo, otherwise `mv`. Run via Bash tool:
```bash
git mv tools/pkg/contracts/helloworld tools/pkg/contracts/{GO_PKG}
```

### Step 4: Rename and update the go:generate file

Inside `tools/pkg/contracts/{GO_PKG}/`:

1. Rename `helloworld.go` to `{GO_PKG}.go` via Bash:
   ```bash
   git mv tools/pkg/contracts/{GO_PKG}/helloworld.go tools/pkg/contracts/{GO_PKG}/{GO_PKG}.go
   ```

2. Read the renamed file and update its contents. The final file should be:
   ```go
   //go:generate go run github.com/ethereum/go-ethereum/cmd/abigen --abi={CONTRACT_NAME}.abi --bin={CONTRACT_NAME}.bin --pkg={GO_PKG} --type={CONTRACT_NAME} --out=autogen.go

   package {GO_PKG}
   ```

### Step 5: Update Go imports and type references

**File:** `tools/pkg/utils/instructions.go`

Read the file first, then make these replacements:
- Import path: `"{MODULE}/pkg/contracts/helloworld"` → `"{MODULE}/pkg/contracts/{GO_PKG}"`
- Package qualifier: `helloworld.` → `{GO_PKG}.` (use `replace_all: true`)
- Type names: `HelloWorldInstructionSender` → `{CONTRACT_NAME}` (use `replace_all: true`)

**File:** `tools/cmd/deploy-contract/main.go`

Read the file. If it imports `{MODULE}/pkg/utils` with an alias like `instrutils`, the import path references the utils package not the contracts package directly — so it may not need changes. But check for any direct references to `helloworld` or `HelloWorldInstructionSender` and update those if found.

## Verification

After all steps, run from the scaffold root:
```bash
cd tools && go build ./...
```

Then confirm every language implementation still builds and behaves identically:
```bash
./scripts/test-unit.sh --all
```

```bash
./scripts/test-conformance.sh --all
```

Renaming should not change behaviour, so conformance must still pass unchanged. If it does not, the rename touched an op-type string or a response shape — revert that part.

If this succeeds, all imports and type references are correct. Report the result to the user.

If it fails due to missing generated files (like `autogen.go`), that's expected — the bindings haven't been generated yet. The important thing is that import paths and type names resolve. You can check with:
```bash
cd tools && go vet ./... 2>&1 || true
```

Tell the user: "Scaffold renamed to {Name}. Run `./scripts/generate-bindings.sh` when ready to compile the contract and generate Go bindings."

## Important Notes

- Always read each file before editing to confirm current content — the user may have already partially renamed things.
- Use `replace_all: true` when replacing identifiers that appear multiple times in a file.
- Do NOT modify `scripts/pre-build.sh` — it calls `generate-bindings.sh` which handles the name.
- Do NOT modify OP_TYPE constants, send function names, or any business logic — only rename contract/package identifiers.
- If `autogen.go` exists in the old directory, it will be moved with the directory rename. That's fine — it will be regenerated.
