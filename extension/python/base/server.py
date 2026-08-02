"""Extension HTTP server.

--- DO NOT MODIFY: infrastructure code. ---

Implements docs/extension-contract.md §2 (HTTP surface), §4 (wire format),
§5 (dispatch and serialization). Your code lives in app/.
"""

from __future__ import annotations

import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional

from .encoding import bytes32_hex_to_string, hex_to_bytes, string_to_bytes32_hex
from .types import (
    ActionResult,
    Framework,
    RegisterFunc,
    ReportStateFunc,
    StateResponse,
    parse_action,
    parse_data_fixed,
)

logger = logging.getLogger(__name__)


class Server:
    def __init__(
        self,
        ext_port: str | int,
        sign_port: str | int,
        version: str,
        register: RegisterFunc,
        report_state: ReportStateFunc,
    ) -> None:
        self.ext_port = int(ext_port)
        self.sign_port = int(sign_port)

        # ActionResult.version is the PLAIN string (contract §4.4); only
        # StateResponse.stateVersion is bytes32. This asymmetry is real —
        # tee-node declares `Version string` but `StateVersion common.Hash`.
        self.version = version
        self.state_version_hex = string_to_bytes32_hex(version)

        self.framework = Framework()
        self.report_state = report_state

        # Handlers and state reads are serialized (contract §5).
        self._lock = threading.Lock()

        register(self.framework)

        server_ref = self

        class RequestHandler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                status, payload = server_ref.handle_request(
                    "POST", self.path, body
                )
                server_ref._send(self, status, payload)

            def do_GET(self) -> None:  # noqa: N802
                status, payload = server_ref.handle_request("GET", self.path, b"")
                server_ref._send(self, status, payload)

            def log_message(self, fmt: str, *args: object) -> None:
                # Suppressed; the server logs actions itself.
                pass

        self._handler_class = RequestHandler
        self._http_server: Optional[ThreadingHTTPServer] = None

    # --- lifecycle ---------------------------------------------------------

    def listen_and_serve(self) -> None:
        self._http_server = ThreadingHTTPServer(("", self.ext_port), self._handler_class)
        logger.info("extension listening on port %s", self.ext_port)
        self._http_server.serve_forever()

    def shutdown(self) -> None:
        if self._http_server:
            self._http_server.shutdown()
            self._http_server.server_close()

    # --- routing -----------------------------------------------------------

    def handle_request(self, method: str, path: str, body: bytes) -> tuple[int, Any]:
        """Route a request. Exposed directly so tests and the conformance
        harness can exercise the contract without binding a socket."""
        path = path.split("?", 1)[0]

        if path == "/action":
            if method == "POST":
                return self._process_action(body)
            return 405, "method not allowed"
        if path == "/state":
            if method == "GET":
                return self._process_state()
            return 405, "method not allowed"
        return 404, "not found"

    # --- handlers ----------------------------------------------------------

    def _process_action(self, body: bytes) -> tuple[int, Any]:
        try:
            raw = json.loads(body)
        except (json.JSONDecodeError, ValueError) as e:
            return 400, {"error": f"invalid action JSON: {e}"}

        try:
            action = parse_action(raw)
        except (KeyError, TypeError) as e:
            return 400, {"error": f"invalid action structure: {e}"}

        try:
            msg_bytes = hex_to_bytes(action.data.message)
        except ValueError as e:
            return 400, {"error": f"invalid hex in message: {e}"}

        try:
            df = parse_data_fixed(json.loads(msg_bytes))
        except (json.JSONDecodeError, ValueError, KeyError, TypeError) as e:
            return 400, {"error": f"invalid DataFixed JSON in message: {e}"}

        handler = self.framework.lookup(df.op_type, df.op_command)
        if handler is None:
            return 501, "unsupported op type"

        with self._lock:
            data, status, err = handler(df.original_message)

        result = ActionResult(
            id=action.data.id,
            submission_tag=action.data.submission_tag,
            op_type=df.op_type,
            op_command=df.op_command,
            version=self.version,
            status=status,
            data=data,
        )

        # Log values are part of the contract (§4.6).
        if status == 0:
            result.log = f"error: {err}" if err else "error: unknown"
        elif status == 1:
            result.log = "ok"
        else:
            result.log = "pending"

        logger.info(
            "action %s: opType=%s opCommand=%s status=%d",
            action.data.id,
            bytes32_hex_to_string(df.op_type),
            bytes32_hex_to_string(df.op_command),
            status,
        )

        return 200, result.to_dict()

    def _process_state(self) -> tuple[int, Any]:
        with self._lock:
            state = self.report_state()
        return 200, StateResponse(
            state_version=self.state_version_hex, state=state
        ).to_dict()

    # --- response writing --------------------------------------------------

    def _send(self, handler: BaseHTTPRequestHandler, status: int, payload: Any) -> None:
        if isinstance(payload, str):
            body = payload.encode("utf-8")
            content_type = "text/plain"
        else:
            body = json.dumps(payload).encode("utf-8")
            content_type = "application/json"

        handler.send_response(status)
        handler.send_header("Content-Type", content_type)
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)
