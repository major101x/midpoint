# create-extension — Go reference

Loaded by `SKILL.md` Step 2 when `LANGUAGE=go`. All paths relative to the scaffold root.

## Step 2a: Op constants — `go/internal/config/config.go`

Read the file first. The scaffold ships:

```go
const (
	Version = "0.1.0"

	OPTypeGreeting      = "GREETING"
	OPCommandSayHello   = "SAY_HELLO"
	OPCommandSayGoodbye = "SAY_GOODBYE"
)
```

Use UPPER_SNAKE_CASE. These strings must exactly match the `bytes32` constants in `contracts/InstructionSender.sol`.

## Step 2b: Request/response types — `go/pkg/types/types.go`

Add a request and response struct per operation, and extend `State`:

```go
type SayHelloRequest struct {
	Name string `json:"name"`
}

type SayHelloResponse struct {
	Greeting       string `json:"greeting"`
	GreetingNumber int    `json:"greetingNumber"`
}

type State struct {
	GreetingCount int    `json:"greetingCount"`
	LastGreeting  string `json:"lastGreeting"`
}
```

For an ABI-encoded payload, also declare the ABI layout:

```go
var SayGoodbyeMessageArg abi.Argument

func init() {
	tupleTy, _ := abi.NewType("tuple", "", []abi.ArgumentMarshaling{
		{Name: "name", Type: "string"},
		{Name: "reason", Type: "string"},
	})
	SayGoodbyeMessageArg = abi.Argument{Type: tupleTy}
}
```

The tuple fields must match the Solidity struct exactly, in declaration order.

## Step 2c: Routing — `go/internal/extension/extension.go`

Add a case to `processAction`, then sub-route on `OPCommand`:

```go
case dataFixed.OPType == teeutils.ToHash(config.OPTypeGreeting):
	return e.processGreeting(action, dataFixed)
```

```go
func (e *Extension) processGreeting(action teetypes.Action, df *instruction.DataFixed) (int, []byte) {
	switch {
	case df.OPCommand == teeutils.ToHash(config.OPCommandSayHello):
		ar := e.processSayHello(action, df)
		b, _ := json.Marshal(ar)
		return http.StatusOK, b

	default:
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported op command: received %s", df.OPCommand.Hex()))
	}
}
```

Keep the diagnostic detail in the `default` branch — naming the received and expected identifiers is what makes a mismatch debuggable, and the conformance suite only requires the body to contain `unsupported op type`.

## Step 2d: Handler — the 4-step pattern

```go
func (e *Extension) processSayHello(action teetypes.Action, df *instruction.DataFixed) teetypes.ActionResult {
	// 1. Decode
	var req types.SayHelloRequest
	dec := json.NewDecoder(bytes.NewReader(df.OriginalMessage))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("decoding request: %w", err))
	}

	// 2. Validate
	if req.Name == "" {
		return buildResult(action, df, nil, 0, fmt.Errorf("name must not be empty"))
	}

	// 3. Execute — always hold the mutex around state
	e.mu.Lock()
	e.greetingCount++
	greetingNumber := e.greetingCount
	greeting := fmt.Sprintf("Hello, %s! Welcome to Flare Confidential Compute.", req.Name)
	e.lastGreeting = greeting
	e.mu.Unlock()

	// 4. Respond
	resp := types.SayHelloResponse{Greeting: greeting, GreetingNumber: greetingNumber}
	data, _ := json.Marshal(resp)
	return buildResult(action, df, data, 1, nil)
}
```

For an ABI-encoded payload, replace step 1 with:

```go
var req types.SayGoodbyeRequest
err := structs.DecodeTo(types.SayGoodbyeMessageArg, df.OriginalMessage, &req)
```

`buildResult` status codes: `0` = error (the `err` message becomes `ActionResult.Log`), `1` = success (`data` is returned to the caller).

## Step 2e: State — `Extension` struct and `stateHandler`

Add fields to the `Extension` struct and map them in `stateHandler` via `types.State`. Guard every read and write with `e.mu`.

## Verify

```bash
cd go && go build ./... && go test ./...
```

## Do not modify

- `go/internal/extension/utils.go` — `actionHandler`, `buildResult`
- `go/pkg/server/` — `StartExtension`
- `go/cmd/docker/main.go`, `go/cmd/start-tee/main.go`
