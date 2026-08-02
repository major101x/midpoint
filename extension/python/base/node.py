"""Client for the tee-node signing API.

--- DO NOT MODIFY: infrastructure code. ---

tee-node exposes crypto operations on http://localhost:$SIGN_PORT
(docs/extension-contract.md §3). Because tee-node is Go and Go marshals []byte
as base64 in JSON, the payloads here are base64 — NOT hex like the rest of the
wire format. That mismatch is the most common porting mistake, which is why this
lives in base/ rather than being hand-rolled in each extension.
"""

from __future__ import annotations

import base64
import json
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

_DEFAULT_TIMEOUT = 30


class NodeClient:
    def __init__(self, sign_port: str | int, timeout: int = _DEFAULT_TIMEOUT) -> None:
        self.sign_port = int(sign_port)
        self.timeout = timeout

    @property
    def base_url(self) -> str:
        return f"http://localhost:{self.sign_port}"

    def decrypt(self, ciphertext: bytes) -> bytes:
        """Decrypt a payload encrypted to this TEE's public key.

        Raises RuntimeError if the node rejects or is unreachable.
        """
        resp = self._post(
            "/decrypt",
            {"encryptedMessage": base64.b64encode(ciphertext).decode("ascii")},
        )
        encoded = resp.get("decryptedMessage")
        if encoded is None:
            raise RuntimeError("node response missing decryptedMessage")
        return base64.b64decode(encoded)

    def _post(self, path: str, payload: dict) -> dict:
        req = Request(
            f"{self.base_url}{path}",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"node returned {e.code} for {path}: {body}") from e
        except URLError as e:
            raise RuntimeError(f"node unreachable at {self.base_url}{path}: {e}") from e
