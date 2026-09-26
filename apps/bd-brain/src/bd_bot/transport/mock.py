"""Console transport — prints instead of sending.

Used by `dry-run`, by the simulator, and by tests. This is the default so that
a misconfigured run can never message a real contact.
"""

from __future__ import annotations

import logging
from pathlib import Path

from .base import InboundHandler

log = logging.getLogger("transport.mock")

_DIM = "\033[2m"
_CYAN = "\033[36m"
_RESET = "\033[0m"


class MockTransport:
    def __init__(self, echo: bool = True) -> None:
        self.echo = echo
        self.sent: list[tuple[str, str]] = []
        self._handler: InboundHandler | None = None
        self.on_connected = None

    def start(self, on_message: InboundHandler) -> None:
        self._handler = on_message
        if self.on_connected is not None:
            self.on_connected()

    def send_text(self, jid: str, text: str) -> None:
        self.sent.append((jid, text))
        if self.echo:
            short = jid.split("@")[0]
            print(f"\n{_CYAN}▶ OUT → {short}{_RESET}")
            print(f"{_DIM}{text}{_RESET}\n")

    def send_document(
        self, jid: str, path: Path, filename: str, caption: str = ""
    ) -> None:
        self.sent.append((jid, f"[document: {filename}]"))
        if self.echo:
            short = jid.split("@")[0]
            exists = "" if path.is_file() else "  (FILE MISSING)"
            print(f"{_CYAN}▶ OUT → {short}{_RESET} 📎 {filename}{exists}")

    def send_image(self, jid: str, path: Path, caption: str = "") -> None:
        self.sent.append((jid, f"[image: {path.name}]"))
        if self.echo:
            short = jid.split("@")[0]
            exists = "" if path.is_file() else "  (FILE MISSING)"
            print(f"{_CYAN}▶ OUT → {short}{_RESET} 🖼️  {path.name}{exists}")

    def feed(self, jid: str, text: str, name: str = "") -> None:
        """Inject an inbound message, as if the contact had replied."""
        if self._handler is None:
            raise RuntimeError("start() must be called before feed()")
        self._handler(jid, name, text)

    def stop(self) -> None:
        pass
