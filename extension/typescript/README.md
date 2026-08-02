# TypeScript implementation

Selected with `LANGUAGE=typescript` in `.env`.

Runs the tee-node `server` binary alongside the compiled `dist/main.js` in one container, joined so the container exits if either process dies. ~472 MB, same-machine reproducible — see [../docs/languages.md](../docs/languages.md) for what that does and does not promise.

## Layout

```
src/
├── main.ts             Entry point — reads EXTENSION_PORT / SIGN_PORT
├── base/               Infrastructure — DO NOT MODIFY
│   ├── server.ts       HTTP server, routing, ActionResult envelope
│   ├── types.ts        Wire types and the handler registry
│   ├── encoding.ts     hex ⟷ bytes, bytes32 padding
│   └── node.ts         Client for the tee-node signing API
├── app/                ★ Your extension
│   ├── config.ts       ★ Version, OPType and OPCommand constants
│   ├── handlers.ts     ★ MAIN CUSTOMIZATION POINT — handlers and state
│   └── abi.ts          ★ ABI decoding for non-JSON payloads
└── __tests__/          vitest suite
```

## Develop

From the repo root — runs `npm ci` then the suite:

```bash
./scripts/test-unit.sh typescript
```

Or directly:

```bash
cd typescript && npm ci && npm run build && npm test
```

Run the extension alone (no tee-node, no proxy):

```bash
cd typescript && npm run build && EXTENSION_PORT=8080 node dist/main.js
```

Type-check without emitting:

```bash
cd typescript && npm run typecheck
```

## Add an operation

1. Add the constants to `src/app/config.ts`
2. Register a handler in `register()` and write it in `src/app/handlers.ts`
3. Add ABI decoding to `src/app/abi.ts` if the payload is not JSON
4. Mirror the `bytes32` constants and a send function in `../contracts/InstructionSender.sol`

Run the `/create-extension` skill to have this done with the TypeScript reference loaded.

## Things specific to this implementation

**Do not add locks.** `src/base/server.ts` serializes handler calls and state reads through a promise chain. Plain module-level state is safe. Handlers may be `async` — the framework awaits them in order.

**Relative imports need a `.js` extension**, even from `.ts` source. The project is ESM with `moduleResolution: NodeNext`, so `import { x } from "./foo.js"` is correct in a file named `foo.ts`.

**Handler signature** is `(msg: string) => [dataHexOrNull, status, errorOrNull]`, where status `0` is failure and `1` is success. `HandlerResult` is exported from `base/types.ts`.

**`JSON.stringify` is already compact**, which the wire format requires — the response payload is hashed and signed by tee-node. Declare response object properties in the same order as the other languages; key order is part of the bytes being hashed.

**Reset new state in `resetState()`** or tests will leak between cases.

## Dependencies

Add with an exact version (no `^`), then regenerate and commit the lockfile:

```bash
cd typescript && npm install --package-lock-only
```

`package-lock.json` is the reproducibility anchor for `npm ci` in the Dockerfile — the image never installs from `package.json` alone. `npm prune --omit=dev` runs at build time, so devDependencies never reach the runtime image.

## Verify

```bash
./scripts/test-conformance.sh typescript
```

Replays the golden wire fixtures. Run `--all` before committing a handler change.
