"""Hex and bytes32 encoding helpers.

--- DO NOT MODIFY: infrastructure code. ---

These implement the encodings in docs/extension-contract.md §4. Getting them
wrong is silent — the node accepts the request and verification fails later.
"""

from __future__ import annotations


def hex_to_bytes(h: str) -> bytes:
    """Decode a 0x-prefixed (or bare) hex string to bytes.

    Go's hexutil.Bytes encodes empty as "0x", so that must decode to b"".
    """
    if h is None:
        return b""
    h = h.removeprefix("0x").removeprefix("0X")
    if not h:
        return b""
    return bytes.fromhex(h)


def bytes_to_hex(b: bytes) -> str:
    """Encode bytes as a 0x-prefixed hex string, matching Go's hexutil.Bytes."""
    return "0x" + b.hex()


def string_to_bytes32_hex(s: str) -> str:
    """Encode a UTF-8 string as a right-zero-padded 32-byte hex string.

    This is how op-type and op-command identifiers cross the wire: Solidity's
    bytes32("GREETING") is the UTF-8 bytes followed by zero padding.
    """
    b = s.encode("utf-8")
    if len(b) > 32:
        raise ValueError(f"string too long for bytes32 ({len(b)} bytes): {s!r}")
    return "0x" + b.ljust(32, b"\x00").hex()


def bytes32_hex_to_string(h: str) -> str:
    """Decode a 32-byte hex string back to its trimmed UTF-8 string.

    Used for logging; never for dispatch (comparisons are done on the hex form).
    """
    try:
        b = hex_to_bytes(h)
    except ValueError:
        return ""
    return b.rstrip(b"\x00").decode("utf-8", errors="replace")
