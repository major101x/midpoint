# Go implementation

The default implementation. Selected with `LANGUAGE=go` in `.env` (also the fallback when `LANGUAGE` is unset).

Go is the only language that can embed tee-node as a **library**, so this image runs a single static binary on a distroless base: ~22 MB, and bit-for-bit reproducible across machines. Every other language runs tee-node as a separate process. See [../docs/languages.md](../docs/languages.md) for the trade-offs.

## Layout

```
cmd/
├── main.go             Standalone extension server (local dev)
├── docker/main.go      Combined tee-node + extension — the image entry point
└── start-tee/main.go   Host-process runner backing `start-services.sh --local`
internal/
├── config/config.go    ★ Version, OPType and OPCommand constants
└── extension/
    ├── extension.go    ★ MAIN CUSTOMIZATION POINT — routing and handlers
    └── utils.go        Infrastructure: actionHandler, buildResult
pkg/
├── server/server.go    Infrastructure: StartExtension
└── types/types.go      ★ Request, response and state types
```

★ = yours to change. Everything else is infrastructure — see the `DO NOT MODIFY` comments.

## Develop

```bash
cd go && go build ./... && go test ./...
```

Or through the language-neutral entry point, from the repo root:

```bash
./scripts/test-unit.sh go
```

Run the extension alone (no tee-node, no proxy) on a port of your choosing:

```bash
EXTENSION_PORT=8080 go run ./cmd
```

## Add an operation

1. Add the constants to `internal/config/config.go`
2. Add request/response structs to `pkg/types/types.go`
3. Add a `case` to `processAction` and write the handler in `internal/extension/extension.go`
4. Mirror the `bytes32` constants and a send function in `../contracts/InstructionSender.sol`

Full walkthrough: [../docs/extension-guide.md](../docs/extension-guide.md). Or run the `/create-extension` skill, which does the language dispatch for you.

## Things specific to this implementation

**You must lock.** `Extension` holds mutable state guarded by `e.mu`. Unlike the Python and TypeScript ports, the framework does not serialize handler calls for you — `actionHandler` may run concurrently.

**`buildResult` owns the envelope.** Return through it rather than constructing an `ActionResult` by hand; it sets the `log` values the wire contract requires.

**ABI payloads** use `structs.DecodeTo` with an `abi.Argument` declared in `pkg/types/types.go` — see `SayGoodbyeMessageArg`.

## Verify

```bash
./scripts/test-conformance.sh go
```

Replays the golden wire fixtures against this implementation. Run `--all` before committing a handler change, so Go, Python and TypeScript stay byte-identical.
