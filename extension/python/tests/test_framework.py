"""Handler dispatch — docs/extension-contract.md §5."""

from base.encoding import string_to_bytes32_hex
from base.types import Framework


def _h(name):
    return lambda msg: (None, 1, name)


class TestLookup:
    def test_exact_match(self):
        f = Framework()
        f.handle("GREETING", "SAY_HELLO", _h("hello"))
        found = f.lookup(
            string_to_bytes32_hex("GREETING"), string_to_bytes32_hex("SAY_HELLO")
        )
        assert found is not None
        assert found("")[2] == "hello"

    def test_distinguishes_commands(self):
        f = Framework()
        f.handle("GREETING", "SAY_HELLO", _h("hello"))
        f.handle("GREETING", "SAY_GOODBYE", _h("goodbye"))
        got = f.lookup(
            string_to_bytes32_hex("GREETING"), string_to_bytes32_hex("SAY_GOODBYE")
        )
        assert got("")[2] == "goodbye"

    def test_empty_command_is_a_wildcard(self):
        f = Framework()
        f.handle("GREETING", "", _h("any"))
        got = f.lookup(
            string_to_bytes32_hex("GREETING"), string_to_bytes32_hex("ANYTHING")
        )
        assert got("")[2] == "any"

    def test_exact_match_wins_over_wildcard(self):
        # Registration order deliberately puts the wildcard first, to prove
        # precedence is by specificity and not by insertion order.
        f = Framework()
        f.handle("GREETING", "", _h("wildcard"))
        f.handle("GREETING", "SAY_HELLO", _h("specific"))
        got = f.lookup(
            string_to_bytes32_hex("GREETING"), string_to_bytes32_hex("SAY_HELLO")
        )
        assert got("")[2] == "specific"

    def test_unknown_op_type_returns_none(self):
        f = Framework()
        f.handle("GREETING", "SAY_HELLO", _h("hello"))
        assert (
            f.lookup(string_to_bytes32_hex("NOPE"), string_to_bytes32_hex("SAY_HELLO"))
            is None
        )

    def test_unknown_command_without_wildcard_returns_none(self):
        f = Framework()
        f.handle("GREETING", "SAY_HELLO", _h("hello"))
        assert (
            f.lookup(string_to_bytes32_hex("GREETING"), string_to_bytes32_hex("NOPE"))
            is None
        )

    def test_lookup_is_case_insensitive_on_hex(self):
        # tee-node emits lowercase hex, but a hand-built fixture may not.
        f = Framework()
        f.handle("GREETING", "SAY_HELLO", _h("hello"))
        got = f.lookup(
            string_to_bytes32_hex("GREETING").upper().replace("0X", "0x"),
            string_to_bytes32_hex("SAY_HELLO").upper().replace("0X", "0x"),
        )
        assert got is not None
