"""Wire types and the handler registry.

--- DO NOT MODIFY: infrastructure code. ---

Field names and encodings are fixed by docs/extension-contract.md §4.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from .encoding import string_to_bytes32_hex

# A handler receives the raw originalMessage hex and returns
# (data_hex_or_None, status, error_message_or_None).
HandlerFunc = Callable[[str], "tuple[Optional[str], int, Optional[str]]"]

# Returns any JSON-serializable snapshot of extension state.
ReportStateFunc = Callable[[], Any]

# Called once at startup to register handlers.
RegisterFunc = Callable[["Framework"], None]

EMPTY_BYTES32 = string_to_bytes32_hex("")


@dataclass
class ActionData:
    """The `data` field of an Action (contract §4.2)."""

    id: str
    type: str
    submission_tag: str
    message: str  # hex-encoded UTF-8 JSON that decodes to a DataFixed


@dataclass
class Action:
    """Request body of POST /action (contract §4.1)."""

    data: ActionData
    additional_variable_messages: list[str] = field(default_factory=list)
    timestamps: list[int] = field(default_factory=list)
    additional_action_data: str = "0x"
    signatures: list[str] = field(default_factory=list)


@dataclass
class DataFixed:
    """Decoded from ActionData.message (contract §4.3)."""

    instruction_id: str
    op_type: str
    op_command: str
    tee_id: str = ""
    timestamp: int = 0
    reward_epoch_id: int = 0
    cosigners: list[str] = field(default_factory=list)
    cosigners_threshold: int = 0
    original_message: str = "0x"
    additional_fixed_message: str = "0x"


@dataclass
class ActionResult:
    """Response body of POST /action (contract §4.4)."""

    id: str
    submission_tag: str
    status: int
    op_type: str
    op_command: str
    version: str  # plain version string, NOT bytes32 — see contract §4.4
    log: Optional[str] = None
    additional_result_status: Optional[str] = None
    data: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        """Serialize exactly as tee-node's Go ActionResult struct does.

        Every field is always present. tee-node declares `Data` and
        `AdditionalResultStatus` as hexutil.Bytes with no omitempty, so they
        marshal as "0x" rather than being omitted when empty; `Log` is a plain
        string and is likewise always emitted. Key order matches the Go struct.
        """
        return {
            "id": self.id,
            "submissionTag": self.submission_tag,
            "status": self.status,
            "log": self.log or "",
            "opType": self.op_type,
            "opCommand": self.op_command,
            "additionalResultStatus": self.additional_result_status or "0x",
            "version": self.version,
            "data": self.data or "0x",
        }


@dataclass
class StateResponse:
    """Response body of GET /state (contract §4.5).

    Note the asymmetry with ActionResult: stateVersion IS bytes32 hex.
    """

    state_version: str
    state: Any

    def to_dict(self) -> dict[str, Any]:
        return {"stateVersion": self.state_version, "state": self.state}


class Framework:
    """Maps (opType, opCommand) bytes32 pairs to handlers (contract §5)."""

    def __init__(self) -> None:
        self._handlers: list[tuple[str, str, HandlerFunc]] = []

    def handle(self, op_type: str, op_command: str, handler: HandlerFunc) -> None:
        """Register a handler.

        Both identifiers are given as plain strings and converted to bytes32.
        Pass "" for op_command to make this the default for every command under
        op_type.
        """
        self._handlers.append(
            (string_to_bytes32_hex(op_type), string_to_bytes32_hex(op_command), handler)
        )

    def lookup(self, op_type: str, op_command: str) -> Optional[HandlerFunc]:
        """Exact (opType, opCommand) match first, then the opCommand wildcard."""
        op_type = _normalize(op_type)
        op_command = _normalize(op_command)

        for reg_type, reg_cmd, handler in self._handlers:
            if reg_type == op_type and reg_cmd == op_command:
                return handler
        for reg_type, reg_cmd, handler in self._handlers:
            if reg_type == op_type and reg_cmd == EMPTY_BYTES32:
                return handler
        return None


def _normalize(h: str) -> str:
    """Lowercase and 0x-prefix a hex identifier so comparisons are stable."""
    if not h:
        return EMPTY_BYTES32
    h = h.lower()
    if not h.startswith("0x"):
        h = "0x" + h
    return h


def parse_action(raw: dict[str, Any]) -> Action:
    data_raw = raw["data"]
    return Action(
        data=ActionData(
            id=data_raw["id"],
            type=data_raw.get("type", ""),
            submission_tag=data_raw.get("submissionTag", ""),
            message=data_raw["message"],
        ),
        additional_variable_messages=raw.get("additionalVariableMessages") or [],
        timestamps=raw.get("timestamps") or [],
        additional_action_data=raw.get("additionalActionData") or "0x",
        signatures=raw.get("signatures") or [],
    )


def parse_data_fixed(raw: dict[str, Any]) -> DataFixed:
    return DataFixed(
        instruction_id=raw.get("instructionId", ""),
        op_type=raw["opType"],
        op_command=raw.get("opCommand", ""),
        tee_id=raw.get("teeId", ""),
        timestamp=raw.get("timestamp", 0),
        reward_epoch_id=raw.get("rewardEpochId", 0),
        cosigners=raw.get("cosigners") or [],
        cosigners_threshold=raw.get("cosignersThreshold", 0),
        original_message=raw.get("originalMessage") or "0x",
        additional_fixed_message=raw.get("additionalFixedMessage") or "0x",
    )
