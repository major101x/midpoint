# create-extension — TypeScript reference

Loaded by `SKILL.md` Step 2 when `LANGUAGE=typescript`. All paths relative to the scaffold root.

## Step 2a: Op constants — `typescript/src/app/config.ts`

Read the file first. The scaffold ships:

```typescript
export const VERSION = "0.1.0";

export const OP_TYPE_GREETING = "GREETING";
export const OP_COMMAND_SAY_HELLO = "SAY_HELLO";
export const OP_COMMAND_SAY_GOODBYE = "SAY_GOODBYE";
```

Use UPPER_SNAKE_CASE. These strings must exactly match the `bytes32` constants in `contracts/InstructionSender.sol`.

## Step 2b: ABI decoding — `typescript/src/app/abi.ts`

Only needed for operations whose payload is ABI-encoded rather than JSON. The scaffold ships:

```typescript
import { decodeAbiParameters, type Hex } from "viem";

const SAY_GOODBYE_PARAMS = [
  {
    type: "tuple",
    components: [
      { name: "name", type: "string" },
      { name: "reason", type: "string" },
    ],
  },
] as const;

export function decodeSayGoodbye(data: Hex): SayGoodbyeMessage {
  try {
    const [decoded] = decodeAbiParameters(SAY_GOODBYE_PARAMS, data);
    return { name: decoded.name, reason: decoded.reason };
  } catch (e) {
    throw new Error(`ABI decode failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
```

The `as const` matters — it is what gives `decodeAbiParameters` a precisely typed return instead of a loose tuple. Components must match the Solidity struct exactly, in declaration order.

New dependencies go in `typescript/package.json` with an exact version (no `^`), then run `npm install --package-lock-only` and commit the updated `package-lock.json`. The lockfile is the reproducibility anchor for `npm ci` in the Dockerfile.

## Step 2c: Registration — `typescript/src/app/handlers.ts`

```typescript
export function register(framework: Framework): void {
  framework.handle(OP_TYPE_GREETING, OP_COMMAND_SAY_HELLO, handleSayHello);
  framework.handle(OP_TYPE_GREETING, OP_COMMAND_SAY_GOODBYE, handleSayGoodbye);
}
```

Pass `""` as the op-command to register a default handler for every command under that op-type.

## Step 2d: Handler — the 4-step pattern

The handler signature is `(msg: string) => [dataHexOrNull, status, errorOrNull]`, and may be async.

```typescript
export function handleSayHello(msg: string): HandlerResult {
  // 1. Decode
  let raw: Uint8Array;
  try {
    raw = hexToBytes(msg);
  } catch (e) {
    return [null, 0, `decoding request: invalid hex: ${String(e)}`];
  }

  let req: unknown;
  try {
    req = JSON.parse(Buffer.from(raw).toString("utf-8"));
  } catch (e) {
    return [null, 0, `decoding request: ${String(e)}`];
  }

  if (typeof req !== "object" || req === null || Array.isArray(req)) {
    return [null, 0, "decoding request: expected a JSON object"];
  }

  // Match Go's DisallowUnknownFields
  const unknown = Object.keys(req).filter((k) => k !== "name").sort();
  if (unknown.length > 0) {
    return [null, 0, `decoding request: unknown field "${unknown[0]}"`];
  }

  // 2. Validate
  const name = (req as { name?: unknown }).name;
  if (typeof name !== "string" || name === "") {
    return [null, 0, "name must not be empty"];
  }

  // 3. Execute — the framework serializes handlers, so no locking needed
  greetingCount++;
  const greeting = `Hello, ${name}! Welcome to Flare Confidential Compute.`;
  lastGreeting = greeting;

  // 4. Respond
  const resp = { greeting, greetingNumber: greetingCount };
  return [bytesToHex(Buffer.from(JSON.stringify(resp), "utf-8")), 1, null];
}
```

`JSON.stringify` is already compact, which is what the wire format requires: the response `data` is hashed and signed by tee-node, and the conformance fixtures compare it byte-for-byte against Go. Declare response object properties in the same order as the other languages.

Status codes: `0` = error (the message becomes `ActionResult.log`), `1` = success.

## Step 2e: State — `reportState`

```typescript
export function reportState(): unknown {
  return {
    greetingCount,
    lastGreeting,
  };
}
```

Keys must match the other languages' state shape exactly — the conformance fixtures assert on it.

Add any new module-level state to `resetState()` too, or tests will leak state between cases.

## Calling the TEE node

For crypto operations, use `src/base/node.ts` rather than hand-rolling `fetch`:

```typescript
import { NodeClient } from "../base/node.js";

const plaintext = await new NodeClient(signPort).decrypt(ciphertext);
```

The node's API is base64-encoded, not hex — Go marshals `[]byte` as base64. `NodeClient` handles that.

Note the `.js` extension on relative imports: the project is ESM with `moduleResolution: NodeNext`, so imports must reference the compiled output path even from `.ts` source.

## Verify

```bash
cd typescript && npm run build && npm test
```

Add tests in `typescript/src/__tests__/` mirroring the existing structure: `handlers.test.ts` for handler behaviour, `server.test.ts` for wire format.

## Do not modify

- `typescript/src/base/` — server, wire types, encoding, node client
- `typescript/src/main.ts` — entry point
