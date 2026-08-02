#!/usr/bin/env python3
"""Regenerate the conformance fixtures in this directory.

The fixtures are committed; this script exists so the hex encodings are derived
rather than hand-written, and so adding a case is a code edit rather than a
manual hex-assembly exercise.

Run with the python venv that has eth-abi installed:
    ./python/.venv/bin/python testdata/conformance/gen_fixtures.py

Each fixture is a single request/response pair asserted against every language
implementation by scripts/test-conformance.sh. See docs/extension-contract.md.
"""

from __future__ import annotations

import json
import pathlib

from eth_abi import encode as abi_encode

HERE = pathlib.Path(__file__).parent

ACTION_ID = "0x" + "11" * 32
TEE_ID = "0x" + "22" * 20
VERSION = "0.1.0"


def b32(s: str) -> str:
    b = s.encode("utf-8")
    return "0x" + b.ljust(32, b"\x00").hex()


def to_hex(b: bytes) -> str:
    return "0x" + b.hex()


def action(op_type: str, op_command: str, original: bytes, action_id: str = ACTION_ID) -> dict:
    """Build a POST /action body in the exact shape tee-node sends."""
    data_fixed = {
        "instructionId": action_id,
        "teeId": TEE_ID,
        "timestamp": 1700000000,
        "rewardEpochId": 42,
        "opType": b32(op_type),
        "opCommand": b32(op_command),
        "cosigners": [],
        "cosignersThreshold": 0,
        "originalMessage": to_hex(original),
        "additionalFixedMessage": "0x",
    }
    return {
        "data": {
            "id": action_id,
            "type": "instruction",
            "submissionTag": "submit",
            "message": to_hex(json.dumps(data_fixed).encode("utf-8")),
        },
        "additionalVariableMessages": [],
        "timestamps": [],
        "additionalActionData": "0x",
        "signatures": [],
    }


def goodbye(name: str, reason: str) -> bytes:
    return abi_encode(["(string,string)"], [(name, reason)])


def json_msg(obj) -> bytes:
    """Serialize compactly, with no whitespace.

    This matters for expected ActionResult.data: the comparison is byte-exact,
    because tee-node hashes `data` (ActionResult.Hash computes keccak256 over
    it) and signs the result. Go's encoding/json emits compact output with
    struct-declaration field order; Python dicts and TS object literals preserve
    insertion order, so all three implementations produce identical bytes.
    """
    return json.dumps(obj, separators=(",", ":")).encode("utf-8")


FIXTURES: list[dict] = [
    {
        "name": "01-say-hello-success",
        "description": "SAY_HELLO with a JSON payload returns a greeting and counter 1",
        "request": {"method": "POST", "path": "/action",
                    "body": action("GREETING", "SAY_HELLO", json_msg({"name": "World"}))},
        "expect": {
            "status": 200,
            "json": {
                "id": ACTION_ID,
                "submissionTag": "submit",
                "status": 1,
                "log": "ok",
                "opType": b32("GREETING"),
                "opCommand": b32("SAY_HELLO"),
                # hexutil.Bytes with no omitempty marshals as "0x", never absent.
                "additionalResultStatus": "0x",
                # Plain string, NOT bytes32 — contract §4.4. This single field is
                # where the sign repo's Python and TS ports diverge from Go.
                "version": VERSION,
                "data": to_hex(json_msg({"greeting": "Hello, World! Welcome to Flare Confidential Compute.",
                                         "greetingNumber": 1})),
            },
        },
    },
    {
        "name": "02-say-hello-counter-increments",
        "description": "A second SAY_HELLO increments greetingNumber to 2",
        "request": {"method": "POST", "path": "/action",
                    "body": action("GREETING", "SAY_HELLO", json_msg({"name": "Second"}))},
        "expect": {
            "status": 200,
            "json_subset": {
                "status": 1,
                "data": to_hex(json_msg({"greeting": "Hello, Second! Welcome to Flare Confidential Compute.",
                                         "greetingNumber": 2})),
            },
        },
    },
    {
        "name": "03-say-hello-empty-name",
        "description": "Empty name is a handler error: HTTP 200, status 0, no data",
        "request": {"method": "POST", "path": "/action",
                    "body": action("GREETING", "SAY_HELLO", json_msg({"name": ""}))},
        "expect": {
            "status": 200,
            # data is still emitted, as "0x" — the Go struct has no omitempty.
            "json_subset": {"status": 0, "data": "0x"},
            "log_prefix": "error: ",
        },
    },
    {
        "name": "04-say-hello-malformed-payload",
        "description": "Non-JSON originalMessage is a handler error, not an HTTP error",
        "request": {"method": "POST", "path": "/action",
                    "body": action("GREETING", "SAY_HELLO", b"not json")},
        "expect": {"status": 200, "json_subset": {"status": 0}, "log_prefix": "error: "},
    },
    {
        "name": "05-say-goodbye-success",
        "description": "SAY_GOODBYE decodes an ABI-encoded (string,string) payload",
        "request": {"method": "POST", "path": "/action",
                    "body": action("GREETING", "SAY_GOODBYE", goodbye("World", "done"))},
        "expect": {
            "status": 200,
            "json_subset": {
                "status": 1,
                "log": "ok",
                "opCommand": b32("SAY_GOODBYE"),
                "version": VERSION,
                "data": to_hex(json_msg({"farewell": "Goodbye, World! Reason: done",
                                         "farewellNumber": 1})),
            },
        },
    },
    {
        "name": "06-say-goodbye-empty-reason-allowed",
        "description": "Only name is validated; an empty reason succeeds",
        "request": {"method": "POST", "path": "/action",
                    "body": action("GREETING", "SAY_GOODBYE", goodbye("W", ""))},
        "expect": {
            "status": 200,
            "json_subset": {
                "status": 1,
                "data": to_hex(json_msg({"farewell": "Goodbye, W! Reason: ", "farewellNumber": 2})),
            },
        },
    },
    {
        "name": "07-say-goodbye-rejects-json",
        "description": "SAY_GOODBYE is ABI-encoded; a JSON payload must not decode",
        "request": {"method": "POST", "path": "/action",
                    "body": action("GREETING", "SAY_GOODBYE", json_msg({"name": "W"}))},
        "expect": {"status": 200, "json_subset": {"status": 0}, "log_prefix": "error: "},
    },
    {
        "name": "08-unknown-op-type",
        "description": "An unrouted opType is 501 with a plain-text body",
        "request": {"method": "POST", "path": "/action",
                    "body": action("NOT_A_REAL_TYPE", "SAY_HELLO", json_msg({"name": "W"}))},
        # Go names the received vs expected opType, which is more useful than a
        # bare string. The status code is contractual; the wording is not.
        "expect": {"status": 501, "text_contains": "unsupported op type"},
    },
    {
        "name": "09-unknown-op-command",
        "description": "A known opType with an unrouted opCommand is also 501",
        "request": {"method": "POST", "path": "/action",
                    "body": action("GREETING", "NOT_A_COMMAND", json_msg({"name": "W"}))},
        "expect": {"status": 501},
    },
    {
        "name": "10-invalid-action-json",
        "description": "A body that is not JSON is 400",
        "request": {"method": "POST", "path": "/action", "raw_body": "not json at all"},
        "expect": {"status": 400},
    },
    {
        "name": "11-invalid-hex-in-message",
        "description": "A non-hex data.message is 400",
        "request": {
            "method": "POST", "path": "/action",
            "body": {"data": {"id": ACTION_ID, "type": "instruction",
                              "submissionTag": "submit", "message": "0xZZZZ"}},
        },
        "expect": {"status": 400},
    },
    {
        "name": "12-message-not-datafixed",
        "description": "A valid-hex message that is not DataFixed JSON is 400",
        "request": {
            "method": "POST", "path": "/action",
            "body": {"data": {"id": ACTION_ID, "type": "instruction",
                              "submissionTag": "submit", "message": to_hex(b"not json")}},
        },
        "expect": {"status": 400},
    },
    {
        "name": "13-get-action-not-allowed",
        "description": "GET /action is 405",
        "request": {"method": "GET", "path": "/action"},
        "expect": {"status": 405},
    },
    {
        "name": "14-post-state-not-allowed",
        "description": "POST /state is 405",
        "request": {"method": "POST", "path": "/state", "raw_body": ""},
        "expect": {"status": 405},
    },
    {
        "name": "15-unknown-path",
        "description": "An unknown path is 404",
        "request": {"method": "GET", "path": "/does-not-exist"},
        "expect": {"status": 404},
    },
    {
        "name": "16-get-state",
        "description": "GET /state returns bytes32 stateVersion and the accumulated state",
        "request": {"method": "GET", "path": "/state"},
        "expect": {
            "status": 200,
            "json": {
                # Asymmetric with ActionResult.version by design — contract §4.5.
                "stateVersion": b32(VERSION),
                "state": {
                    "greetingCount": 2,
                    "lastGreeting": "Hello, Second! Welcome to Flare Confidential Compute.",
                    "farewellCount": 2,
                    "lastFarewell": "Goodbye, W! Reason: ",
                },
            },
        },
    },
]


def main() -> None:
    index = []
    for f in FIXTURES:
        path = HERE / f"{f['name']}.json"
        path.write_text(json.dumps(f, indent=2) + "\n")
        index.append(f["name"])

    (HERE / "index.json").write_text(json.dumps({"fixtures": index}, indent=2) + "\n")
    print(f"wrote {len(index)} fixtures + index.json to {HERE}")


if __name__ == "__main__":
    main()
