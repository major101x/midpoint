# Test Extension

Guides the developer through writing and running E2E tests for their extension.

## When to Use

The user wants to write or run tests for their extension. They may say things like:
- "write tests for my extension"
- "add test cases"
- "test my extension"
- "how do I test this?"
- "/test-extension"

## Inputs

Before starting, read these files to understand what operations exist and what types are defined:

1. Your language's config — `go/internal/config/config.go`, `python/app/config.py`, or `typescript/src/app/config.ts` — what OPType constants exist
2. `contracts/InstructionSender.sol` — what send functions exist
3. Your language's request/response shapes — `go/pkg/types/types.go`, or the handlers in `python/app/handlers.py` / `typescript/src/app/handlers.ts`
4. `tools/cmd/run-test/main.go` — current test state
5. `tools/pkg/utils/instructions.go` — what send helpers exist

## Steps to Execute

All paths are relative to the scaffold root (the directory containing `foundry.toml`).

### Step 1: Define response type(s) at top of `tools/cmd/run-test/main.go`

Read the file first. Add structs that **mirror** (not import) your response shapes. `tools/` is deliberately independent of every language implementation — that independence is what lets one test path serve Go, Python and TypeScript alike. The scaffold has:

```go
type SayHelloResponse struct {
    Greeting       string `json:"greeting"`
    GreetingNumber int    `json:"greetingNumber"`
}
```

These are defined separately in the test file because the test tool module is independent from the main extension module.

### Step 2: Build test payload(s) matching request types

Create JSON payloads matching your request shapes. The scaffold sends:

```go
payload, _ := json.Marshal(map[string]interface{}{
    "name": "World",
})
```

You can also define request types in the test file if needed, or use inline `map[string]interface{}` for simple payloads.

### Step 3: Send instruction(s)

Use `instrutils.SendInstruction()` to send through the contract:

```go
instructionId, _, err := instrutils.SendInstruction(s, addr, payload)
if err != nil {
    log.Fatalf("sending instruction: %v", err)
}
```

If the Solidity contract has multiple send functions (e.g., `sendSayHello()` plus additional operations you've added), you'll need corresponding Go helpers in `tools/pkg/utils/instructions.go`. Each helper calls a different contract method:

```go
func SendSayHello(s *utils.Session, addr common.Address, message []byte) (*big.Int, *ethtypes.Transaction, error) {
    instance, err := helloworld.NewHelloWorldInstructionSender(addr, s.Client)
    if err != nil {
        return nil, nil, fmt.Errorf("creating contract instance: %w", err)
    }
    tx, err := instance.SendSayHello(s.Transactor, message)
    if err != nil {
        return nil, nil, fmt.Errorf("sending instruction: %w", err)
    }
    return extractInstructionId(tx, s)
}
```

### Step 4: Update `verifyResult()` — unmarshal and validate

Read the current `verifyResult()` function. The generic parts (polling, status checks) are already there. The scaffold validates like this:

```go
var resp SayHelloResponse
err = json.Unmarshal(actionResult.Data, &resp)
if err != nil {
    return errors.Errorf("failed to unmarshal response: %s", err)
}

if resp.Greeting == "" {
    return errors.New("expected non-empty Greeting")
}
if resp.GreetingNumber < 1 {
    return errors.Errorf("expected GreetingNumber >= 1, got %d", resp.GreetingNumber)
}
```

Replace the response type, unmarshal target, and field assertions with your own.

### Step 5: Add additional test cases

Add more send+verify pairs for comprehensive coverage:

- **Each op type** your extension supports
- **Success cases** with valid inputs
- **Edge cases** (empty fields, boundary values)
- **Error cases** (invalid payloads that should return `status == 0`)

Each test case follows the same pattern: build payload, send instruction, wait, verify result.

## Test Lifecycle Reference

```
1. SetExtensionId()         <- Generic: tells the contract its extension ID (idempotent)
2. Send instruction          <- YOUR CODE: call your contract function with your payload
3. Wait for TEE processing   <- Generic: time.Sleep(5s)
4. Poll for result            <- Generic: utils.ActionResult() polls proxy (15 retries, 2s apart)
5. Validate response          <- YOUR CODE: unmarshal Data into your type, check your fields
```

## Response Envelope Structure

The proxy returns results in this envelope:

```json
{
  "result": {
    "id": "0x...",
    "status": 1,
    "log": "",
    "opType": "0x...",
    "opCommand": "0x...",
    "data": "<your extension's JSON response>"
  }
}
```

- `status`: `0` = failed, `1` = success, `2` = pending
- `log`: error message when `status == 0`
- `data`: your extension's response bytes (whatever `buildResult` returned)

## Running Tests

```bash
./scripts/test.sh
```

Or run everything (build + deploy + test) in one shot:

```bash
./scripts/full-setup.sh --test
```

## Verification

After writing tests, confirm compilation:

```bash
cd tools && go build ./...
```

Report the result to the user.

## Important Notes

- **Do NOT modify the generic parts of `verifyResult()`** — the polling logic, status checks, and retry loop are infrastructure code.
- **Do NOT modify the `SetExtensionId` call** — it's required boilerplate.
- **Response types in the test file must mirror, never import, the extension's types** — `tools/` is a standalone module with no dependency on any language implementation, which is what lets `./scripts/test.sh` run unchanged against every language.
- **Before the on-chain test, run the cheaper layers**: `./scripts/test-unit.sh` and `./scripts/test-conformance.sh`. If a handler's shape changed, also regenerate the golden fixtures with `./python/.venv/bin/python testdata/conformance/gen_fixtures.py`.
- Always read each file before editing to confirm current content.
