"""Server routing and wire format — docs/extension-contract.md §2, §4."""

import json

import pytest
from eth_abi import encode as abi_encode

from app import handlers
from app.config import VERSION
from base.encoding import bytes_to_hex, hex_to_bytes, string_to_bytes32_hex
from base.server import Server


@pytest.fixture
def srv():
    handlers.reset_state()
    s = Server(0, 0, VERSION, handlers.register, handlers.report_state)
    yield s
    handlers.reset_state()


def build_action(op_type="GREETING", op_command="SAY_HELLO", original=b"", action_id=None):
    """Build a POST /action body in the exact shape tee-node sends."""
    data_fixed = {
        "instructionId": action_id or "0x" + "11" * 32,
        "teeId": "0x" + "22" * 20,
        "timestamp": 1700000000,
        "rewardEpochId": 42,
        "opType": string_to_bytes32_hex(op_type),
        "opCommand": string_to_bytes32_hex(op_command),
        "cosigners": [],
        "cosignersThreshold": 0,
        "originalMessage": bytes_to_hex(original),
        "additionalFixedMessage": "0x",
    }
    return json.dumps(
        {
            "data": {
                "id": action_id or "0x" + "11" * 32,
                "type": "instruction",
                "submissionTag": "submit",
                "message": bytes_to_hex(json.dumps(data_fixed).encode("utf-8")),
            },
            "additionalVariableMessages": [],
            "timestamps": [],
            "additionalActionData": "0x",
            "signatures": [],
        }
    ).encode("utf-8")


class TestRouting:
    def test_get_action_is_405(self, srv):
        assert srv.handle_request("GET", "/action", b"")[0] == 405

    def test_post_state_is_405(self, srv):
        assert srv.handle_request("POST", "/state", b"")[0] == 405

    def test_unknown_path_is_404(self, srv):
        assert srv.handle_request("GET", "/nope", b"")[0] == 404
        assert srv.handle_request("POST", "/nope", b"")[0] == 404

    def test_unknown_op_type_is_501(self, srv):
        status, body = srv.handle_request(
            "POST", "/action", build_action(op_type="NOPE")
        )
        assert status == 501
        assert body == "unsupported op type"

    def test_unknown_op_command_is_501(self, srv):
        status, _ = srv.handle_request(
            "POST", "/action", build_action(op_command="NOPE")
        )
        assert status == 501

    def test_query_string_is_ignored(self, srv):
        assert srv.handle_request("GET", "/state?verbose=1", b"")[0] == 200


class TestMalformedInput:
    def test_invalid_json_body_is_400(self, srv):
        assert srv.handle_request("POST", "/action", b"not json")[0] == 400

    def test_missing_data_field_is_400(self, srv):
        assert srv.handle_request("POST", "/action", b'{"foo":1}')[0] == 400

    def test_invalid_hex_message_is_400(self, srv):
        body = json.dumps(
            {"data": {"id": "0x1", "type": "instruction",
                      "submissionTag": "submit", "message": "0xZZ"}}
        ).encode()
        assert srv.handle_request("POST", "/action", body)[0] == 400

    def test_message_not_json_is_400(self, srv):
        body = json.dumps(
            {"data": {"id": "0x1", "type": "instruction",
                      "submissionTag": "submit",
                      "message": bytes_to_hex(b"not json")}}
        ).encode()
        assert srv.handle_request("POST", "/action", body)[0] == 400


class TestActionResultWireFormat:
    def test_success_shape(self, srv):
        msg = json.dumps({"name": "World"}).encode()
        status, body = srv.handle_request("POST", "/action", build_action(original=msg))

        assert status == 200
        assert body["status"] == 1
        assert body["log"] == "ok"
        assert body["opType"] == string_to_bytes32_hex("GREETING")
        assert body["opCommand"] == string_to_bytes32_hex("SAY_HELLO")
        assert body["data"].startswith("0x")

    def test_version_is_plain_string_not_bytes32(self, srv):
        # Contract §4.4: tee-node declares `Version string`. The sign repo's
        # Python/TS ports hex-encode this and are wrong; this test pins it.
        msg = json.dumps({"name": "World"}).encode()
        _, body = srv.handle_request("POST", "/action", build_action(original=msg))

        assert body["version"] == "0.1.0"
        assert not body["version"].startswith("0x")

    def test_handler_error_is_http_200_with_status_0(self, srv):
        # Handler failure is signalled in the body, never by the HTTP status.
        msg = json.dumps({"name": ""}).encode()
        status, body = srv.handle_request("POST", "/action", build_action(original=msg))

        assert status == 200
        assert body["status"] == 0
        assert body["log"].startswith("error: ")
        # Present as "0x", not omitted: the Go struct has no omitempty.
        assert body["data"] == "0x"

    def test_all_fields_always_present(self, srv):
        # tee-node's ActionResult has no omitempty tags, so every field appears
        # on the wire regardless of value. Verified against Go by the
        # conformance fixtures in testdata/conformance/.
        msg = json.dumps({"name": "W"}).encode()
        _, body = srv.handle_request("POST", "/action", build_action(original=msg))

        assert set(body) == {
            "id", "submissionTag", "status", "log", "opType",
            "opCommand", "additionalResultStatus", "version", "data",
        }
        assert body["additionalResultStatus"] == "0x"

    def test_echoes_id_and_submission_tag(self, srv):
        action_id = "0x" + "ab" * 32
        msg = json.dumps({"name": "W"}).encode()
        _, body = srv.handle_request(
            "POST", "/action", build_action(original=msg, action_id=action_id)
        )
        assert body["id"] == action_id
        assert body["submissionTag"] == "submit"

    def test_say_goodbye_abi_path(self, srv):
        msg = abi_encode(["(string,string)"], [("World", "done")])
        _, body = srv.handle_request(
            "POST", "/action", build_action(op_command="SAY_GOODBYE", original=msg)
        )
        assert body["status"] == 1
        assert json.loads(hex_to_bytes(body["data"])) == {
            "farewell": "Goodbye, World! Reason: done",
            "farewellNumber": 1,
        }


class TestStateWireFormat:
    def test_state_version_is_bytes32(self, srv):
        # Asymmetric with ActionResult.version by design — contract §4.5.
        status, body = srv.handle_request("GET", "/state", b"")
        assert status == 200
        assert body["stateVersion"] == string_to_bytes32_hex("0.1.0")
        assert len(body["stateVersion"]) == 66

    def test_state_reflects_handler_effects(self, srv):
        msg = json.dumps({"name": "World"}).encode()
        srv.handle_request("POST", "/action", build_action(original=msg))
        _, body = srv.handle_request("GET", "/state", b"")
        assert body["state"]["greetingCount"] == 1
        assert body["state"]["lastGreeting"].startswith("Hello, World!")
