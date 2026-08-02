# create-extension — Python reference

Loaded by `SKILL.md` Step 2 when `LANGUAGE=python`. All paths relative to the scaffold root.

## Step 2a: Op constants — `python/app/config.py`

Read the file first. The scaffold ships:

```python
VERSION = "0.1.0"

OP_TYPE_GREETING = "GREETING"
OP_COMMAND_SAY_HELLO = "SAY_HELLO"
OP_COMMAND_SAY_GOODBYE = "SAY_GOODBYE"
```

Use UPPER_SNAKE_CASE. These strings must exactly match the `bytes32` constants in `contracts/InstructionSender.sol`.

## Step 2b: ABI decoding — `python/app/abi.py`

Only needed for operations whose payload is ABI-encoded rather than JSON. The scaffold ships:

```python
from eth_abi import decode as abi_decode

SAY_GOODBYE_TYPES = ["(string,string)"]


def decode_say_goodbye(data: bytes) -> tuple[str, str]:
    try:
        (decoded,) = abi_decode(SAY_GOODBYE_TYPES, data)
    except Exception as e:
        raise ValueError(f"ABI decode failed: {e}") from e
    name, reason = decoded
    return name, reason
```

The type string must match the Solidity struct exactly, in declaration order. A struct ABI-encodes as a tuple, hence the outer parentheses.

If you add a dependency, pin it exactly in `python/requirements.txt` and confirm it ships prebuilt manylinux wheels — the Dockerfile installs with `--no-install-recommends` and no build toolchain, so anything requiring compilation will fail the image build.

## Step 2c: Registration — `python/app/handlers.py`

```python
def register(framework: Framework) -> None:
    framework.handle(OP_TYPE_GREETING, OP_COMMAND_SAY_HELLO, handle_say_hello)
    framework.handle(OP_TYPE_GREETING, OP_COMMAND_SAY_GOODBYE, handle_say_goodbye)
```

Pass `""` as the op-command to register a default handler for every command under that op-type.

## Step 2d: Handler — the 4-step pattern

The handler signature is `(original_message_hex) -> (data_hex_or_None, status, error_or_None)`.

```python
def handle_say_hello(msg: str) -> tuple[Optional[str], int, Optional[str]]:
    global _greeting_count, _last_greeting

    # 1. Decode
    try:
        raw = hex_to_bytes(msg)
    except ValueError as e:
        return None, 0, f"decoding request: invalid hex: {e}"

    try:
        req = json.loads(raw)
    except (json.JSONDecodeError, ValueError) as e:
        return None, 0, f"decoding request: {e}"

    # Match Go's DisallowUnknownFields
    unknown = set(req) - {"name"}
    if unknown:
        return None, 0, f"decoding request: unknown field {sorted(unknown)[0]!r}"

    # 2. Validate
    name = req.get("name", "")
    if not name:
        return None, 0, "name must not be empty"

    # 3. Execute — the framework serializes handlers, so no locking needed
    _greeting_count += 1
    greeting = f"Hello, {name}! Welcome to Flare Confidential Compute."
    _last_greeting = greeting

    # 4. Respond
    resp = {"greeting": greeting, "greetingNumber": _greeting_count}
    return bytes_to_hex(json.dumps(resp, separators=(",", ":")).encode("utf-8")), 1, None
```

**`separators=(",", ":")` is required, not stylistic.** The response `data` is hashed and signed by tee-node, and the conformance fixtures compare it byte-for-byte against the Go implementation. Python's default `json.dumps` inserts spaces and would not match.

Status codes: `0` = error (the message becomes `ActionResult.log`), `1` = success.

## Step 2e: State — `report_state`

```python
def report_state() -> Any:
    return {
        "greetingCount": _greeting_count,
        "lastGreeting": _last_greeting,
    }
```

Keys must match the other languages' state shape exactly — the conformance fixtures assert on it.

Add any new module-level state to `reset_state()` too, or tests will leak state between cases.

## Calling the TEE node

For crypto operations, use `base/node.py` rather than hand-rolling HTTP:

```python
from base.node import NodeClient

plaintext = NodeClient(sign_port).decrypt(ciphertext)
```

The node's API is base64-encoded, not hex — Go marshals `[]byte` as base64. `NodeClient` handles that.

## Verify

```bash
cd python && ./.venv/bin/python -m pytest -q
```

Add tests in `python/tests/` mirroring the existing structure: `test_handlers.py` for handler behaviour, `test_server.py` for wire format.

## Do not modify

- `python/base/` — server, wire types, encoding, node client
- `python/main.py` — entry point
