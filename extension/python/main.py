"""Entry point for the Python extension server.

Mirrors go/cmd/main.go. In the container this runs alongside the tee-node
`server` binary (docs/extension-contract.md §1, two-process topology).
"""

from __future__ import annotations

import logging
import os
import sys

# Allow `from base...` / `from app...` when run as `python3 main.py`.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.config import VERSION  # noqa: E402
from app.handlers import register, report_state  # noqa: E402
from base.server import Server  # noqa: E402


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(message)s",
    )

    # Defaults match go/internal/config/config.go.
    ext_port = os.environ.get("EXTENSION_PORT", "8080")
    sign_port = os.environ.get("SIGN_PORT", "9090")

    srv = Server(ext_port, sign_port, VERSION, register, report_state)
    srv.listen_and_serve()


if __name__ == "__main__":
    main()
