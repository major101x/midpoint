"""Encoding helpers — docs/extension-contract.md §4."""

import pytest

from base.encoding import (
    bytes32_hex_to_string,
    bytes_to_hex,
    hex_to_bytes,
    string_to_bytes32_hex,
)


class TestHexToBytes:
    def test_roundtrip(self):
        assert hex_to_bytes("0xdeadbeef") == b"\xde\xad\xbe\xef"

    def test_accepts_bare_hex(self):
        assert hex_to_bytes("deadbeef") == b"\xde\xad\xbe\xef"

    def test_empty_hexutil_bytes_decodes_to_empty(self):
        # Go's hexutil.Bytes encodes an empty slice as "0x", not "".
        assert hex_to_bytes("0x") == b""
        assert hex_to_bytes("") == b""
        assert hex_to_bytes(None) == b""

    def test_invalid_hex_raises(self):
        with pytest.raises(ValueError):
            hex_to_bytes("0xnothex")


class TestBytesToHex:
    def test_prefixes(self):
        assert bytes_to_hex(b"\xde\xad") == "0xdead"

    def test_empty_matches_go(self):
        assert bytes_to_hex(b"") == "0x"


class TestBytes32:
    def test_right_pads_to_32_bytes(self):
        h = string_to_bytes32_hex("GREETING")
        assert h.startswith("0x")
        assert len(h) == 66  # 0x + 64 hex chars
        assert h == "0x" + b"GREETING".hex() + "00" * 24

    def test_empty_string_is_all_zeros(self):
        assert string_to_bytes32_hex("") == "0x" + "00" * 32

    def test_roundtrip(self):
        for s in ["GREETING", "SAY_HELLO", "SAY_GOODBYE", ""]:
            assert bytes32_hex_to_string(string_to_bytes32_hex(s)) == s

    def test_too_long_raises(self):
        with pytest.raises(ValueError):
            string_to_bytes32_hex("x" * 33)

    def test_matches_solidity_bytes32_literal(self):
        # Solidity: bytes32("GREETING") in contracts/InstructionSender.sol.
        # "GREETING" is 8 bytes, so 24 zero bytes of right padding follow.
        assert string_to_bytes32_hex("GREETING") == "0x4752454554494e47" + "00" * 24
