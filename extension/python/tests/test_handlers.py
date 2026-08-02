"""Hello World handlers — behaviour must match go/internal/extension/extension.go."""

import json

import pytest
from eth_abi import encode as abi_encode

from app import handlers
from base.encoding import bytes_to_hex, hex_to_bytes


@pytest.fixture(autouse=True)
def _reset():
    handlers.reset_state()
    yield
    handlers.reset_state()


def _json_msg(obj):
    return bytes_to_hex(json.dumps(obj).encode("utf-8"))


def _goodbye_msg(name, reason):
    return bytes_to_hex(abi_encode(["(string,string)"], [(name, reason)]))


class TestSayHello:
    def test_success(self):
        data, status, err = handlers.handle_say_hello(_json_msg({"name": "World"}))
        assert (status, err) == (1, None)
        resp = json.loads(hex_to_bytes(data))
        assert resp == {
            "greeting": "Hello, World! Welcome to Flare Confidential Compute.",
            "greetingNumber": 1,
        }

    def test_counter_increments(self):
        for expected in (1, 2, 3):
            data, status, _ = handlers.handle_say_hello(_json_msg({"name": "A"}))
            assert status == 1
            assert json.loads(hex_to_bytes(data))["greetingNumber"] == expected

    def test_empty_name_rejected(self):
        data, status, err = handlers.handle_say_hello(_json_msg({"name": ""}))
        assert (data, status) == (None, 0)
        assert "name must not be empty" in err

    def test_missing_name_rejected(self):
        _, status, err = handlers.handle_say_hello(_json_msg({}))
        assert status == 0
        assert "name must not be empty" in err

    def test_unknown_field_rejected(self):
        # Matches Go's dec.DisallowUnknownFields().
        _, status, err = handlers.handle_say_hello(
            _json_msg({"name": "A", "extra": 1})
        )
        assert status == 0
        assert "unknown field" in err

    def test_invalid_json_rejected(self):
        _, status, err = handlers.handle_say_hello(bytes_to_hex(b"not json"))
        assert status == 0
        assert "decoding request" in err

    def test_invalid_hex_rejected(self):
        _, status, err = handlers.handle_say_hello("0xZZ")
        assert status == 0
        assert "decoding request" in err

    def test_failure_does_not_increment_counter(self):
        handlers.handle_say_hello(_json_msg({"name": ""}))
        data, status, _ = handlers.handle_say_hello(_json_msg({"name": "A"}))
        assert json.loads(hex_to_bytes(data))["greetingNumber"] == 1


class TestSayGoodbye:
    def test_success(self):
        data, status, err = handlers.handle_say_goodbye(_goodbye_msg("World", "done"))
        assert (status, err) == (1, None)
        resp = json.loads(hex_to_bytes(data))
        assert resp == {
            "farewell": "Goodbye, World! Reason: done",
            "farewellNumber": 1,
        }

    def test_counter_is_independent_of_greeting(self):
        handlers.handle_say_hello(_json_msg({"name": "A"}))
        data, _, _ = handlers.handle_say_goodbye(_goodbye_msg("B", "r"))
        assert json.loads(hex_to_bytes(data))["farewellNumber"] == 1

    def test_empty_name_rejected(self):
        _, status, err = handlers.handle_say_goodbye(_goodbye_msg("", "r"))
        assert status == 0
        assert "name must not be empty" in err

    def test_empty_reason_is_allowed(self):
        # Go validates name only.
        data, status, _ = handlers.handle_say_goodbye(_goodbye_msg("W", ""))
        assert status == 1
        assert json.loads(hex_to_bytes(data))["farewell"] == "Goodbye, W! Reason: "

    def test_json_payload_rejected(self):
        # SAY_GOODBYE is ABI-encoded; JSON must not silently decode.
        _, status, err = handlers.handle_say_goodbye(_json_msg({"name": "W"}))
        assert status == 0
        assert "decoding request" in err


class TestReportState:
    def test_initial(self):
        assert handlers.report_state() == {
            "greetingCount": 0,
            "lastGreeting": "",
            "farewellCount": 0,
            "lastFarewell": "",
        }

    def test_tracks_both_operations(self):
        handlers.handle_say_hello(_json_msg({"name": "A"}))
        handlers.handle_say_goodbye(_goodbye_msg("B", "r"))
        assert handlers.report_state() == {
            "greetingCount": 1,
            "lastGreeting": "Hello, A! Welcome to Flare Confidential Compute.",
            "farewellCount": 1,
            "lastFarewell": "Goodbye, B! Reason: r",
        }
