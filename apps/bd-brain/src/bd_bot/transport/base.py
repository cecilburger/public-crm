"""Transport interface.

The flow engine never imports a WhatsApp library directly — it goes through
this. That keeps the state machine testable and leaves the door open to
swapping neonize for a Baileys sidecar or the official Cloud API.
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable, Protocol

#: Handler signature: (jid, sender_display_name, text, sent_at) -> None.
#: `sent_at` is when the sender sent it — None when the transport cannot say.
#: It is not the arrival time: on reconnect WhatsApp replays everything that
#: landed while the device was offline, and only this separates that backlog
#: from a live reply.
InboundHandler = Callable[..., None]


class Transport(Protocol):
    on_connected: Callable[[], None] | None
    """Optional hook, run once the socket is up and before serving begins.

    Sending needs a live connection, so anything the caller wants to send at
    startup — the opening blast of a test session, say — has to wait for this
    rather than run before `start`."""

    def start(self, on_message: InboundHandler) -> None:
        """Connect and block, dispatching inbound messages to `on_message`."""

    def send_text(self, jid: str, text: str) -> None: ...

    def send_document(
        self, jid: str, path: Path, filename: str, caption: str = ""
    ) -> None: ...

    def send_image(self, jid: str, path: Path, caption: str = "") -> None: ...

    def stop(self) -> None: ...
