# Python implementation

Selected with `LANGUAGE=python` in `.env`.

Runs the tee-node `server` binary alongside `main.py` in one container, joined so the container exits if either process dies. ~268 MB, same-machine reproducible — see [../docs/languages.md](../docs/languages.md) for what that does and does not promise.

## Layout

```
main.py                 Entry point — reads EXTENSION_PORT / SIGN_PORT
base/                   Infrastructure — DO NOT MODIFY
├── server.py           HTTP server, routing, ActionResult envelope
├── types.py            Wire types and the handler registry
├── encoding.py         hex ⟷ bytes, bytes32 padding
└── node.py             Client for the tee-node signing API
app/                    ★ Your extension
├── config.py           ★ Version, OPType and OPCommand constants
├── handlers.py         ★ MAIN CUSTOMIZATION POINT — handlers and state
└── abi.py              ★ ABI decoding for non-JSON payloads
tests/                  pytest suite
```

## Develop

From the repo root — creates `.venv` and installs dev dependencies on first run:

```bash
./scripts/test-unit.sh python
```

Or directly:

```bash
cd python && python3 -m venv .venv && ./.venv/bin/pip install -r requirements-dev.txt
```

```bash
cd python && ./.venv/bin/python -m pytest -q
```

Run the extension alone (no tee-node, no proxy):

```bash
cd python && EXTENSION_PORT=8080 ./.venv/bin/python main.py
```

## Add an operation

1. Add the constants to `app/config.py`
2. Register a handler in `register()` and write it in `app/handlers.py`
3. Add ABI decoding to `app/abi.py` if the payload is not JSON
4. Mirror the `bytes32` constants and a send function in `../contracts/InstructionSender.sol`

Run the `/create-extension` skill to have this done with the Python reference loaded.

## Things specific to this implementation

**Do not add locks.** `base/server.py` serializes every handler call and state read. Plain module-level state is safe; your own lock would deadlock against the framework's.

**Compact JSON is mandatory.** Always `json.dumps(resp, separators=(",", ":"))`. Python's default inserts spaces, and the response payload is hashed and signed by tee-node — the conformance fixtures compare it byte-for-byte against Go.

**Handler signature** is `(original_message_hex) -> (data_hex_or_None, status, error_or_None)`, where status `0` is failure and `1` is success.

**Reset new state in `reset_state()`** or tests will leak between cases.

## Dependencies

`requirements.txt` is runtime-only and is the only file installed into the image. Pin exact versions, and only use packages shipping prebuilt manylinux wheels — the Dockerfile installs without a build toolchain, so anything requiring compilation fails the build. Test-only packages belong in `requirements-dev.txt`.

## Verify

```bash
./scripts/test-conformance.sh python
```

Replays the golden wire fixtures. Run `--all` before committing a handler change.
