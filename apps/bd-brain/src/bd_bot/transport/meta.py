"""Instagram DM, Facebook DM, and comments on both — as a Transport.

The flow does not change shape for a new channel. This turns a Meta webhook
into the same `(jid, name, text, sent_at)` the WhatsApp transport produces,
and `Engine.handle_inbound` cannot tell the difference. Everything that makes
these channels different is here:

* **A comment is not a conversation.** It never reaches the flow. The BD
  team's rule is one short public line and a move to DM, and handing a
  comment to `handle_inbound` would answer it at length *in public* — the
  exact failure their CRM analysis warns about. `_on_comment` implements the
  rule and is the only path that ever posts publicly.
* **Meta retries.** A delivery it believes failed is sent again, so the same
  message would be answered twice. Ids already seen are dropped.
* **Our own voice comes back.** DMs carry `is_echo`; comments carry nothing,
  so `meta.parse` is given the ids we post as.
* **We answer with a 200 and then work.** Meta times these out fast and
  disables a webhook that keeps failing; the answer must not wait on
  Sonnet, on SQLite, or on a send.

Attachments are refused loudly rather than sent. Messenger caps attachments
at 25 MB and the deck is 30, and IG DM will not take a document at all — a
silent failure here is a brand who was told the deck was coming and never
got it. The refusal escalates to a human instead.
"""

from __future__ import annotations

import json
import logging
import threading
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .. import meta
from .. import templates
from ..models import Conversation, Node, Outcome

log = logging.getLogger(__name__)

#: How many message ids to remember for de-duplication. Meta retries within
#: minutes, so this only has to outlive a retry window, not a conversation.
_SEEN_MAX = 2000

#: Meta's own cap on a message; we split rather than let it truncate.
_MAX_TEXT = 900


class MetaTransport:
    """Serves the webhook and sends through the Graph API."""

    def __init__(self, cfg, store=None, escalate=None):
        self.cfg = cfg
        self.store = store
        self._escalate = escalate
        self.on_connected = None
        self._on_message = None
        self._server: ThreadingHTTPServer | None = None
        self._seen: OrderedDict[str, None] = OrderedDict()
        self._lock = threading.Lock()
        self._page_ids = set(cfg.meta_page_ids)

    # --- de-duplication ----------------------------------------------------

    def _first_time(self, key: str) -> bool:
        """False when this id has been handled already.

        Keyed on Meta's own message/comment id. A message with no id at all
        is let through: dropping it would lose a real message to protect
        against a duplicate that may not exist.
        """
        if not key:
            return True
        with self._lock:
            if key in self._seen:
                return False
            self._seen[key] = None
            while len(self._seen) > _SEEN_MAX:
                self._seen.popitem(last=False)
            return True

    # --- inbound -----------------------------------------------------------

    def _dispatch(self, events: list[meta.Event]) -> None:
        for ev in events:
            if not self._first_time(ev.message_id):
                log.info("duplicate %s %s — already handled", ev.kind, ev.message_id)
                continue
            try:
                if ev.kind == "comment":
                    self._on_comment(ev)
                else:
                    self._on_dm(ev)
            except Exception:
                # One bad event must not take the webhook down with it: a
                # webhook that raises gets retried, then disabled by Meta.
                log.exception("failed handling %s from %s", ev.kind, ev.sender_id)

    def _on_dm(self, ev: meta.Event) -> None:
        if self._on_message is None:
            return
        # A story reply without its story reads as a non-sequitur — "bagus
        # banget kak!" with no referent. Logged, not prepended: the brand
        # never sees it and the classifier is trained on what people type.
        if ev.context:
            log.info("story/DM reply from %s in context %s", ev.sender_id, ev.context)
        # BEFORE the flow runs, on first contact only: the flow chooses the
        # DM opener over the WhatsApp form by channel, and on the very first
        # message the channel has to already be on the row. (The jid prefix
        # says it too — belt and braces; a CRM fronting the flow has neither
        # unless it sets `source`.) An existing row is left alone.
        self._seed(ev)
        self._on_message(ev.jid, ev.sender_name, ev.text, ev.sent_at)
        # AND after: handle_inbound may have created the row itself when the
        # store was absent above, and a source written to nothing is lost.
        self._remember_source(ev)

    def _on_comment(self, ev: meta.Event) -> None:
        """One short public line, then everything else in DM.

        The public reply is posted first and the DM second, because that is
        the order a person experiences: they see the reply on the post, then
        find the DM. If the DM fails the public line has still been said, and
        the failure escalates.
        """
        log.info(
            "comment from %s on %s (%s): %r",
            ev.sender_name or ev.sender_id, ev.post_id, ev.platform, ev.text[:80],
        )
        self._remember_source(ev)

        if self.cfg.meta_comment_public_reply and ev.comment_id:
            try:
                self._reply_to_comment(
                    ev.comment_id, templates.REPLY_KOMENTAR_PUBLIK.strip()
                )
            except Exception:
                log.exception("public reply to comment %s failed", ev.comment_id)

        # The DM is the actual answer. It may legitimately fail: Instagram
        # only allows a DM to a commenter within a window, and someone who
        # has never messaged the Page may not be reachable at all.
        # Not templates.render(): that needs a Conversation, and a comment
        # has no brand, no name and no history yet — that is what the DM
        # is asking for.
        opener = templates.COMMENT_DM_OPENER.strip()
        try:
            self.send_text(ev.jid, opener)
        except Exception as exc:
            self._debt(
                ev.jid,
                f"comment from {ev.sender_name or ev.sender_id} on {ev.platform} "
                f"could not be answered by DM ({exc}); the public reply went out. "
                f"They said: {ev.text[:160]}",
            )
            return

        # The opener has asked for their brand, so the conversation now
        # stands at INBOUND_QUALIFY — the node whose next reply is read as
        # the answer to that question. Without this, a commenter's first DM
        # reply arrived at Node.NEW and was answered with the qualification
        # form, i.e. the same questions a second time (24 Sep 2026). Only a
        # conversation that does not exist yet is created; a person who has
        # talked to us before keeps their place.
        self._seed(ev, node=Node.INBOUND_QUALIFY, sent=opener)

    def _seed(self, ev: meta.Event, node: Node | None = None, sent: str = "") -> None:
        """Create the conversation row for a first contact, with its channel.

        `node` is set for a comment (the DM opener has already asked the
        qualification question); a DM leaves it at NEW for the flow to
        handle. `sent` is logged as our outbound turn so the thread reads
        correctly — the opener was sent by this transport, not by the flow,
        and would otherwise be invisible in the conversation history.
        """
        if self.store is None:
            return
        try:
            if self.store.get(ev.jid) is not None:
                return
            convo = Conversation(jid=ev.jid, name=ev.sender_name, source=ev.platform)
            if node is not None:
                convo.node = node
                convo.outcome = Outcome.FOLLOWUP
                convo.last_outbound_at = datetime.now(tz=timezone.utc)
            self.store.upsert(convo)
            log_message = getattr(self.store, "log_message", None)
            if sent and callable(log_message):
                log_message(ev.jid, "out", sent, datetime.now(tz=timezone.utc), "COMMENT_DM_OPENER")
        except Exception:
            log.exception("could not seed conversation for %s", ev.jid)

    def _remember_source(self, ev: meta.Event) -> None:
        """Record the channel on the conversation.

        "Which channel is producing leads" is a question the BD team asks
        weekly and this bot could not answer before. Written here rather than
        in the flow because the flow is deliberately channel-blind.
        """
        if self.store is None:
            return
        try:
            convo = self.store.get(ev.jid)
            if convo is None:
                return
            if convo.source != ev.platform:
                convo.source = ev.platform
                self.store.upsert(convo)
        except Exception:
            log.exception("could not record source for %s", ev.jid)

    def _debt(self, jid: str, note: str) -> None:
        log.warning("%s", note)
        if self._escalate is not None:
            try:
                self._escalate(jid, note)
            except Exception:
                log.exception("escalation failed")

    # --- outbound ----------------------------------------------------------

    def _graph(self, path: str, payload: dict) -> dict:
        if not self.cfg.meta_page_token:
            raise RuntimeError("META_PAGE_TOKEN is not set; nothing can be sent")
        url = (
            f"https://graph.facebook.com/{self.cfg.meta_graph_version}/{path}"
            f"?access_token={urllib.parse.quote(self.cfg.meta_page_token)}"
        )
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            url, data=body, headers={"Content-Type": "application/json"}
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:400]
            raise RuntimeError(f"Graph {exc.code}: {detail}") from exc

    def send_text(self, jid: str, text: str) -> None:
        recipient = meta.account_id(jid)
        for chunk in _split(text, _MAX_TEXT):
            self._graph(
                "me/messages",
                {
                    "recipient": {"id": recipient},
                    "message": {"text": chunk},
                    "messaging_type": "RESPONSE",
                },
            )

    def _reply_to_comment(self, comment_id: str, text: str) -> None:
        self._graph(f"{comment_id}/replies", {"message": text.strip()})

    def send_document(
        self, jid: str, path: Path, filename: str, caption: str = ""
    ) -> None:
        """Refused, loudly. See the module docstring.

        Graph will only attach a file it can fetch from a public URL, or one
        under 25 MB uploaded inline. The deck is 30 MB and IG DM takes no
        documents at all, so the honest outcomes are a human sending it or
        nobody sending it — and a silent third option where the brand is
        told it is coming is the worst of the three.
        """
        self._debt(
            jid,
            f"{filename or path.name} not sent on {meta.platform_of(jid) or 'meta'} "
            f"— Graph cannot attach it (documents are not supported on IG DM, "
            f"and the file is over Messenger's limit). Send it by hand, or ask "
            f"them for a WhatsApp number.",
        )

    def send_image(self, jid: str, path: Path, caption: str = "") -> None:
        self._debt(
            jid,
            f"{path.name} not sent on {meta.platform_of(jid) or 'meta'} — an "
            f"image must be reachable at a public URL for Graph to attach it, "
            f"and this file is local only.",
        )

    def is_on_whatsapp(self, numbers):  # pragma: no cover - not answerable here
        raise NotImplementedError(
            "these are Instagram/Facebook account ids, not phone numbers"
        )

    # --- serving -----------------------------------------------------------

    def start(self, on_message) -> None:
        """Serve the webhook and block."""
        self._on_message = on_message
        if not self.cfg.meta_app_secret:
            raise RuntimeError(
                "META_APP_SECRET is not set. Every webhook would be refused, "
                "which is the safe behaviour but not a working bot."
            )
        self._server = ThreadingHTTPServer(
            (self.cfg.meta_webhook_host, self.cfg.meta_webhook_port),
            _handler_factory(self),
        )
        log.info(
            "meta webhook on http://%s:%d/webhook (put HTTPS in front of it)",
            self.cfg.meta_webhook_host, self.cfg.meta_webhook_port,
        )
        if self.on_connected:
            self.on_connected()
        self._server.serve_forever()

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None


def _split(text: str, limit: int) -> list[str]:
    """Break on paragraph, then sentence, then hard. Never mid-word."""
    text = text.strip()
    if len(text) <= limit:
        return [text] if text else []
    out, rest = [], text
    while len(rest) > limit:
        window = rest[:limit]
        cut = max(window.rfind("\n\n"), window.rfind(". "), window.rfind("\n"))
        if cut < limit // 3:
            cut = window.rfind(" ")
        if cut <= 0:
            cut = limit
        out.append(rest[:cut].strip())
        rest = rest[cut:].strip()
    if rest:
        out.append(rest)
    return out


def _handler_factory(transport: MetaTransport):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args) -> None:  # noqa: A003
            pass  # the module logger says what matters

        def _text(self, body: str, code: int = 200) -> None:
            raw = body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self) -> None:  # noqa: N802 - stdlib API
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path.rstrip("/") not in ("/webhook", ""):
                return self._text("not found", 404)
            params = urllib.parse.parse_qs(parsed.query)
            answer = meta.challenge(params, transport.cfg.meta_verify_token)
            if answer is None:
                log.warning("webhook verification refused from %s", self.client_address[0])
                return self._text("forbidden", 403)
            self._text(answer)

        def do_POST(self) -> None:  # noqa: N802 - stdlib API
            if urllib.parse.urlparse(self.path).path.rstrip("/") not in ("/webhook", ""):
                return self._text("not found", 404)
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b""

            if not meta.verify_signature(
                body,
                self.headers.get("X-Hub-Signature-256", ""),
                transport.cfg.meta_app_secret,
            ):
                log.warning("webhook with a bad signature from %s", self.client_address[0])
                return self._text("forbidden", 403)

            try:
                payload = json.loads(body or b"{}")
            except ValueError:
                # 200 anyway: a 4xx is retried and then the webhook is
                # disabled, and a payload we cannot parse will not parse on
                # the retry either.
                log.warning("webhook body was not JSON (%d bytes)", len(body))
                return self._text("ok")

            events = meta.parse(payload, transport._page_ids)

            # Answer first, work after. Meta times these out in seconds and
            # disables an endpoint that keeps being slow; a reply here can
            # involve Sonnet, SQLite and an outbound send.
            self._text("ok")
            if events:
                threading.Thread(
                    target=transport._dispatch, args=(events,), daemon=True
                ).start()

    return Handler
