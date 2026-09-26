"""The CRM's brain: the flow served over HTTP, one conversation per call.

`public-crm`'s worker (`apps/worker/src/bdBrain.ts`) does not run this bot;
it asks it. Every inbound BD message becomes one `POST /v1/step` carrying the
conversation's state and the message, and gets back the same state, mutated,
plus the list of things the flow decided to do. The worker executes the
actions it knows how to (queue a message, set the node, hand over) and
defers the rest. Booking is a second call, `/v1/book`, because choosing WHEN
needs a calendar and a reading of what the contact asked for; `/v1/propose-
slots` is the same for an agreement with no time named yet. `GET
/v1/comment-reply` hands out the two comment texts so the CRM's Instagram
comment processor never carries a copy of them.

**Stateless, and how.** Nothing is kept between calls: the CRM's Postgres is
the memory. Each request opens a fresh `Store` on `:memory:`, writes the
conversation and the recent turns the CRM sends into it, runs the REAL
`Engine` — not a re-implementation of it — and reads the result back out.
That is the whole design choice here, and it is what keeps this copy honest
against `whatsapp-bot-bd`: every guard the engine has (the loop breaker, the
echo check, the autoresponder detector, the referral hand-over, the FOKUS
context gate, the learned reading) runs unchanged, because it is the same
code. What differs is what `Engine` does with its decisions:

* `RecordingEngine._send` records a `send` action instead of pacing a
  socket; `_schedule` records a `schedule`; `alert` and `NotifyGroup` become
  `notify_group`; `RecordingStore.escalate` records an `escalate`;
  `BookMeeting` and `ProposeSlots` are recorded, not executed, because the
  CRM calls back for them. No approval prompt, no daily cap, no send window:
  those govern messages the bot STARTS, and the CRM only ever asks about
  replies.
* Nothing is sent through a transport, ever. `_NoTransport` raises if anything
  reaches it, so a code path that bypasses the recording shows up in a test
  rather than as a silent no-op.

**What the CRM must send for the engine-level behaviour to work** (each one
is a store lookup in `whatsapp-bot-bd`, so here it has to arrive on the wire):

* `history` — the last turns, oldest first, `{direction: "in"|"out", body,
  at}`. Feeds the FOKUS_CAMPAIGN gate (was OUR last message the focus
  question?), the loop breaker (did they repeat themselves verbatim; how many
  messages did we send in the window), the echo check (is this our own text
  forwarded back), the second-wording swap, the learned reading's context,
  and slot picking (the hour is usually a turn or two before the email). The
  newest inbound turn is dropped when it is the message being stepped: the
  CRM records a message before it asks about it, and the engine logs the
  current message itself.
* `source` — `""` for WhatsApp, `"instagram"` / `"facebook"` for a Meta DM.
  The CRM's jid is a UUID, so `flow.dm_channel` can only see the channel
  through this field. It is what switches the DM opener, the DM pitch and the
  DM → WhatsApp hand-off on.
* `now` — the clock. The engine's `now()` returns it, so a replayed job books
  the same slot it would have booked when the message arrived.

`BD_WHATSAPP_NUMBER` is read from this process's environment (it is a
`Settings` field); the CRM does not send it. Empty keeps the hand-off off,
exactly as in `whatsapp-bot-bd`.

Started with `python -m bd_bot brain-serve` (see `cli.py`), or from the CRM
with `npm run dev:bd-brain`. Refuses to start without `BD_BRAIN_SECRET`: the
endpoint decides what a business says to its leads.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import threading
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from . import flow, gcal, templates
from .config import Settings
from .engine import Engine
from .models import Conversation, Intent, Node, Outcome
from .storage import Store

log = logging.getLogger(__name__)

#: Largest request body accepted. A conversation plus eight turns is a few
#: kilobytes; anything near this is not a message from a brand.
_MAX_BODY = 256 * 1024

#: Turns the CRM may send. `bdDraft.ts` sends eight; the engine reads eight
#: (`understanding.HISTORY_TURNS`). More is accepted and simply older.
_MAX_HISTORY = 64


class BadRequest(ValueError):
    """The CRM sent something this cannot act on. Answered with 400, which
    `BdBrainClient` treats as permanent — retrying a malformed payload eight
    times with backoff helps nobody."""


# ---------------------------------------------------------------------------
# Wire format
# ---------------------------------------------------------------------------


def _parse_when(value, cfg: Settings, field: str) -> datetime | None:
    """ISO-8601 in, tz-aware `datetime` in the bot's timezone out.

    The CRM sends `toISOString()` (UTC, trailing Z). A naive value is read
    as the bot's own timezone — the only other thing it could sensibly be.
    """
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        raise BadRequest(f"{field} must be an ISO-8601 string")
    try:
        when = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise BadRequest(f"{field} is not ISO-8601: {value!r}") from exc
    if when.tzinfo is None:
        when = when.replace(tzinfo=cfg.tz)
    return when.astimezone(cfg.tz)


def _iso(when: datetime | None) -> str | None:
    return when.isoformat() if when is not None else None


def conversation_from(data, cfg: Settings) -> Conversation:
    """`BdConversation` (bdBrain.ts) -> `models.Conversation`, field for field.

    Missing fields take the dataclass defaults, so a CRM row that has never
    been stepped (`node` absent) starts at NEW like a first message would.
    Unknown node/outcome values are a 400: a typo in the CRM's state table
    must not be silently read as "new" and greet a brand mid-conversation.
    """
    if not isinstance(data, dict):
        raise BadRequest("conversation must be an object")
    jid = data.get("jid")
    if not isinstance(jid, str) or not jid.strip():
        raise BadRequest("conversation.jid is required")

    convo = Conversation(jid=jid.strip())
    for field in ("name", "brand", "category", "email", "meet_link", "stopped_reason", "source"):
        value = data.get(field)
        if value is None:
            continue
        if not isinstance(value, str):
            raise BadRequest(f"conversation.{field} must be a string")
        setattr(convo, field, value)
    try:
        if data.get("node") not in (None, ""):
            convo.node = Node(data["node"])
        if data.get("outcome") not in (None, ""):
            convo.outcome = Outcome(data["outcome"])
    except ValueError as exc:
        raise BadRequest(f"conversation has an unknown node/outcome: {exc}") from exc
    for field in ("gadget_loops", "unknown_streak", "price_stage"):
        value = data.get(field)
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise BadRequest(f"conversation.{field} must be a non-negative integer")
        setattr(convo, field, value)
    convo.last_inbound_at = _parse_when(data.get("last_inbound_at"), cfg, "conversation.last_inbound_at")
    convo.last_outbound_at = _parse_when(data.get("last_outbound_at"), cfg, "conversation.last_outbound_at")
    convo.meeting_at = _parse_when(data.get("meeting_at"), cfg, "conversation.meeting_at")
    return convo


def conversation_to(convo: Conversation) -> dict:
    """The mirror of `conversation_from`. Every field, always, so the CRM's
    upsert never has to guess which ones the flow touched."""
    return {
        "jid": convo.jid,
        "name": convo.name,
        "brand": convo.brand,
        "category": convo.category,
        "node": convo.node.value,
        "outcome": convo.outcome.value,
        "gadget_loops": convo.gadget_loops,
        "email": convo.email,
        "last_inbound_at": _iso(convo.last_inbound_at),
        "last_outbound_at": _iso(convo.last_outbound_at),
        "meeting_at": _iso(convo.meeting_at),
        "meet_link": convo.meet_link,
        "unknown_streak": convo.unknown_streak,
        "price_stage": convo.price_stage,
        "stopped_reason": convo.stopped_reason,
        "source": convo.source,
    }


def _history_from(data, cfg: Settings, now: datetime) -> list[tuple[str, str, datetime]]:
    """`{direction, body, at?}[]` -> (direction, body, at), oldest first.

    A turn without `at` is placed an hour ago, in order — old enough that
    none of the time-windowed guards (the loop breaker, "would we repeat
    ourselves") can fire on a timestamp we invented, recent enough that it
    is still the history `recent_turns` reads.
    """
    if data is None:
        return []
    if not isinstance(data, list):
        raise BadRequest("history must be a list")
    turns = data[-_MAX_HISTORY:]
    out: list[tuple[str, str, datetime]] = []
    base = now - timedelta(hours=1)
    for i, turn in enumerate(turns):
        if not isinstance(turn, dict):
            raise BadRequest("history entries must be objects")
        direction = turn.get("direction")
        if direction not in ("in", "out"):
            raise BadRequest("history[].direction must be 'in' or 'out'")
        body = turn.get("body")
        if not isinstance(body, str):
            raise BadRequest("history[].body must be a string")
        at = _parse_when(turn.get("at"), cfg, "history[].at") or (base + timedelta(seconds=i))
        out.append((direction, body, at))
    return out


def _same_text(a: str, b: str) -> bool:
    return " ".join((a or "").split()).lower() == " ".join((b or "").split()).lower()


# ---------------------------------------------------------------------------
# The engine, recording instead of sending
# ---------------------------------------------------------------------------


class _NoTransport:
    """Nothing is delivered from here. Reaching this is a bug, and a loud one."""

    paired_user = ""

    def send_text(self, jid: str, text: str) -> None:
        raise AssertionError(f"brain-serve tried to send through a transport: {text[:40]!r}")

    def send_document(self, jid: str, path: Path, filename: str, caption: str = "") -> None:
        raise AssertionError("brain-serve tried to send a document through a transport")

    def send_image(self, jid: str, path: Path, caption: str = "") -> None:
        raise AssertionError("brain-serve tried to send an image through a transport")


class RecordingStore(Store):
    """A `Store` on `:memory:` that also writes the two side effects the flow
    expresses through the store — an escalation, a timer cancel — into the
    request's action list, where the CRM can see them."""

    def __init__(self, actions: list[dict]) -> None:
        super().__init__(Path(":memory:"))
        self._actions = actions

    def escalate(self, jid: str, reason: str, body: str, at: datetime) -> None:
        super().escalate(jid, reason, body, at)
        self._actions.append({"type": "escalate", "reason": reason, "inbound_text": body})

    def cancel_all(self, jid: str) -> int:
        n = super().cancel_all(jid)
        # Once per request, whichever path asked: the flow's first action on
        # any inbound is CancelTimers, and the pre-flow hand-overs call this
        # too. The CRM does not execute timers yet; one marker is enough.
        if not any(a["type"] == "cancel_timers" for a in self._actions):
            self._actions.append({"type": "cancel_timers"})
        return n


class RecordingEngine(Engine):
    """`Engine` with every outward effect turned into an action.

    The inbound path (`_handle_inbound`), the slot proposal, the booking and
    the calendar helpers are all the parent's — untouched. Only the edges are
    replaced: the clock, the sending, the scheduling, the alerting, and
    `apply`, which records `BookMeeting` / `ProposeSlots` instead of running
    them (the CRM calls `/v1/book` and `/v1/propose-slots` for those).
    """

    def __init__(self, cfg: Settings, now: datetime) -> None:
        self.actions: list[dict] = []
        super().__init__(cfg, RecordingStore(self.actions), _NoTransport())
        self._now = now
        self.last_booking: gcal.Booking | None = None

    # -- the clock is the request's ------------------------------------------

    def now(self) -> datetime:
        return self._now

    # -- recording ------------------------------------------------------------

    def _record(self, action: dict) -> None:
        self.actions.append(action)

    def _last_send(self) -> dict | None:
        for action in reversed(self.actions):
            if action["type"] == "send":
                return action
        return None

    def apply(self, convo: Conversation, result: flow.Result) -> None:
        now = self.now()
        for action in result.actions:
            match action:
                case flow.CancelTimers():
                    self.store.cancel_all(convo.jid)

                case flow.SetNode(node=node, outcome=outcome):
                    convo.node = node
                    convo.outcome = outcome
                    self._record({"type": "set_node", "node": node.value, "outcome": outcome.value})

                case flow.Schedule(timer=timer, fire_at=fire_at):
                    self._schedule(convo.jid, timer, fire_at, now)

                case flow.Send(message=message):
                    # Same three steps as Engine.apply: the second wording if
                    # the first just went out, the composed text (a static
                    # template unless USE_LLM_REPLIES), then the send — with
                    # the attachments riding on it only if it went out.
                    varied = self._vary(convo, message.key)
                    if varied != message.key:
                        message = templates.render(varied, convo, self.cfg)
                    text = self._compose(convo, message)
                    if self._send(convo, text, now, key=message.key):
                        if message.attach_opening:
                            self._send_opening(convo)
                        if message.attach_company_profile:
                            self._send_profile(convo)
                        if message.attach_case_study:
                            self._send_case_studies(convo)
                        if message.attach_ads_deck:
                            self._send_ads_deck(convo)

                case flow.NotifyGroup(text=text):
                    self._record({"type": "notify_group", "text": text})

                case flow.BookMeeting(preferred=preferred):
                    self._record({"type": "book_meeting", "preferred": preferred})

                case flow.ProposeSlots(fallback=fallback):
                    self._record({
                        "type": "propose_slots",
                        "fallback_text": fallback.text,
                        "fallback_key": fallback.key,
                    })

                case flow.Escalate(reason=reason, inbound_text=body):
                    self.store.escalate(convo.jid, reason, body, now)

        self.store.upsert(convo)

    def _send(self, convo: Conversation, text: str, now: datetime, key: str = "") -> bool:
        # The one guard from Engine._send that is about the conversation
        # rather than the socket: never say the identical thing twice in a
        # row. It reads the history the CRM sent, so it sees the last message
        # the CRM queued as well as anything recorded earlier in this call.
        if self._would_repeat_ourselves(convo.jid, text, now):
            if not self.store.has_open_escalation(convo.jid, self._LOOP_TAG):
                self.store.escalate(
                    convo.jid,
                    f"{self._LOOP_TAG}: would have repeated our own last message",
                    text, now,
                )
            log.warning("LOOP %s — refusing to send the same message twice", convo.jid)
            return False
        # One text per send, not the up-to-three-chunk burst Engine._send
        # makes for generative keys: the burst is pacing for a WhatsApp
        # socket, and the CRM's outbox delivers one message per row.
        self._record({
            "type": "send",
            "text": text,
            "key": key,
            "attach_company_profile": False,
            "attach_opening": False,
            "attach_case_study": False,
            "attach_ads_deck": False,
        })
        convo.last_outbound_at = now
        self.store.log_message(convo.jid, "out", text, now, self._context)
        self._sends += 1
        return True

    def _raw_send(self, jid: str, text: str) -> bool:
        self._record({"type": "notify_group", "text": text})
        return True

    def alert(self, text: str) -> None:
        # Operational, for a human — the same audience as the BD group. Not
        # an `escalate`: `_booking_failed` already escalates the conversation
        # and alerts, and the CRM would open two items for one failure.
        log.warning("ALERT: %s", text)
        self._record({"type": "notify_group", "text": text})

    def _schedule(self, jid: str, timer, fire_at: datetime, now: datetime) -> None:
        self.store.schedule(jid, timer, fire_at)
        self._record({"type": "schedule", "timer": timer.value, "fire_at": fire_at.isoformat()})

    # The flow says WHICH file goes with a message; whether the CRM has the
    # file is the CRM's business. The flag is what crosses the wire.
    def _flag(self, name: str) -> None:
        last = self._last_send()
        if last is not None:
            last[name] = True

    def _send_opening(self, convo: Conversation) -> None:
        self._flag("attach_opening")

    def _send_profile(self, convo: Conversation) -> None:
        self._flag("attach_company_profile")

    def _send_case_studies(self, convo: Conversation) -> None:
        self._flag("attach_case_study")

    def _send_ads_deck(self, convo: Conversation) -> None:
        self._flag("attach_ads_deck")

    def _calendar_book(self, start: datetime, **kwargs) -> gcal.Booking:
        booking = super()._calendar_book(start, **kwargs)
        self.last_booking = booking
        return booking


# ---------------------------------------------------------------------------
# The service: one method per endpoint, no HTTP in sight
# ---------------------------------------------------------------------------


def serving_settings(cfg: Settings) -> Settings:
    """The settings `whatsapp-bot-bd` runs with, minus what only a socket needs.

    Same reasoning as `cmd_simulate`: nothing here reaches a transport, so
    the dry-run rendering, the approval prompt, the pacing gap and the daily
    cap have nothing to protect and would only refuse or delay a reply the
    CRM is waiting on. Demo mode is off because the CRM has no timers to
    compress; the tester allowlist is empty because `/restart` is a WhatsApp
    convention the CRM does not carry.
    """
    cfg.dry_run = False
    cfg.require_approval = False
    cfg.auto_reply = True
    cfg.min_seconds_between_sends = 0
    cfg.max_blasts_per_day = 10**6
    cfg.demo_mode = False
    cfg.restart_jids = frozenset()
    return cfg


class BrainService:
    def __init__(self, cfg: Settings) -> None:
        self.cfg = serving_settings(cfg)

    # -- helpers ---------------------------------------------------------------

    def _engine(self, payload: dict, *, drop_current: str | None = None):
        cfg = self.cfg
        now = _parse_when(payload.get("now"), cfg, "now") or datetime.now(tz=cfg.tz)
        convo = conversation_from(payload.get("conversation"), cfg)
        history = _history_from(payload.get("history"), cfg, now)
        if drop_current is not None and history and history[-1][0] == "in" \
                and _same_text(history[-1][1], drop_current):
            history = history[:-1]

        engine = RecordingEngine(cfg, now)
        engine.store.upsert(convo)
        for direction, body, at in history:
            engine.store.log_message(convo.jid, direction, body, at)
        return engine, convo, now

    # -- /v1/step ----------------------------------------------------------------

    def step(self, payload: dict) -> dict:
        text = payload.get("text")
        if not isinstance(text, str):
            raise BadRequest("text is required")
        forced = payload.get("intent")
        if forced is not None:
            try:
                forced = Intent(forced)
            except ValueError as exc:
                raise BadRequest(f"unknown intent: {forced!r}") from exc

        engine, convo, now = self._engine(payload, drop_current=text)
        before = convo.node

        if forced is None:
            # The real inbound path, guards and all. It reads the conversation
            # back out of the store, so the object to return is the store's.
            engine.handle_inbound(convo.jid, convo.name, text, sent_at=None)
            after = engine.store.get(convo.jid) or convo
            tags = engine.store.recent_inbound_intents(convo.jid, limit=1)
            intent = tags[0] if tags and tags[0] else Intent.UNKNOWN.value
        else:
            # A caller that has already decided what the message means. The
            # pre-flow guards are skipped on purpose — they exist to work out
            # what a message is, which is the very thing being overridden.
            convo.last_inbound_at = now
            engine.store.log_message(convo.jid, "in", text, now, forced.value)
            engine.apply(convo, flow.on_inbound(convo, forced, text, self.cfg, now))
            after = convo
            intent = forced.value

        # The pre-flow hand-overs (referral, "send it to this email", a
        # closed thread) move the node directly rather than through SetNode.
        # `bdDraft.ts` reads the node off the conversation when no set_node
        # arrived, so this is belt and braces — but the contract says a node
        # change is an action, so make it one.
        if after.node is not before and not any(a["type"] == "set_node" for a in engine.actions):
            engine.actions.append({
                "type": "set_node", "node": after.node.value, "outcome": after.outcome.value,
            })

        return {
            "intent": intent,
            "conversation": conversation_to(after),
            "actions": engine.actions,
        }

    # -- /v1/book ------------------------------------------------------------------

    def book(self, payload: dict) -> dict:
        engine, convo, now = self._engine(payload)

        # A re-run of a job that already booked (a stalled lock, a retry
        # after the CRM's own write failed) must not put a second event on
        # the calendar. The existing meeting is the answer, with nothing to
        # say — the confirmation went out the first time.
        if convo.meeting_at is not None and convo.meet_link:
            return {
                "booked": False,
                "meeting_at": _iso(convo.meeting_at),
                "meet_link": convo.meet_link,
                "event_id": None,
                "html_link": None,
                "messages": [],
                "conversation": conversation_to(convo),
            }

        engine._book(convo, now)
        booking = engine.last_booking
        return {
            "booked": booking is not None,
            "meeting_at": _iso(convo.meeting_at),
            "meet_link": convo.meet_link,
            "event_id": booking.event_id if booking else None,
            "html_link": (booking.html_link or None) if booking else None,
            "messages": [a["text"] for a in engine.actions if a["type"] == "send"],
            "conversation": conversation_to(convo),
        }

    # -- /v1/propose-slots ----------------------------------------------------------

    def propose_slots(self, payload: dict) -> dict:
        fallback_text = payload.get("fallback_text")
        if not isinstance(fallback_text, str) or not fallback_text.strip():
            raise BadRequest("fallback_text is required")
        fallback_key = payload.get("fallback_key") or ""
        if not isinstance(fallback_key, str):
            raise BadRequest("fallback_key must be a string")

        engine, convo, now = self._engine(payload)
        engine._propose_slots(convo, templates.Message(text=fallback_text, key=fallback_key), now)
        engine.store.upsert(convo)
        return {
            "messages": [a["text"] for a in engine.actions if a["type"] == "send"],
            "conversation": conversation_to(convo),
        }

    # -- /v1/comment-reply ---------------------------------------------------------

    def comment_reply(self) -> dict:
        """The two comment texts, verbatim from the bank — the same two
        `transport/meta.py` posts, un-rendered for the same reason: a comment
        has no name, brand or history yet."""
        return {
            "publicReply": templates.REPLY_KOMENTAR_PUBLIK.strip(),
            "dmOpener": templates.COMMENT_DM_OPENER.strip(),
        }


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


def _handler_factory(service: BrainService, secret: str):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args) -> None:  # noqa: A003
            pass  # the module logger says what matters

        # -- plumbing --

        def _json(self, code: int, body: dict) -> None:
            raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def _authorised(self) -> bool:
            header = self.headers.get("Authorization", "")
            scheme, _, token = header.partition(" ")
            return scheme.lower() == "bearer" and hmac.compare_digest(token.strip(), secret)

        def _body(self) -> dict:
            length = int(self.headers.get("Content-Length") or 0)
            if length > _MAX_BODY:
                raise BadRequest("request body too large")
            raw = self.rfile.read(length) if length else b""
            try:
                payload = json.loads(raw or b"{}")
            except ValueError as exc:
                raise BadRequest("body is not JSON") from exc
            if not isinstance(payload, dict):
                raise BadRequest("body must be a JSON object")
            return payload

        def _route(self, method: str) -> None:
            path = urlparse(self.path).path.rstrip("/")
            if path == "/healthz":
                return self._json(200, {"ok": True})
            if not path.startswith("/v1/"):
                return self._json(404, {"error": "not found"})
            if not self._authorised():
                log.warning("refused %s %s from %s: bad or missing bearer", method, path, self.client_address[0])
                return self._json(401, {"error": "unauthorised"})

            routes = {
                ("GET", "/v1/comment-reply"): lambda: service.comment_reply(),
                ("POST", "/v1/step"): lambda: service.step(self._body()),
                ("POST", "/v1/book"): lambda: service.book(self._body()),
                ("POST", "/v1/propose-slots"): lambda: service.propose_slots(self._body()),
            }
            handler = routes.get((method, path))
            if handler is None:
                known = {p for _, p in routes}
                if path in known:
                    return self._json(405, {"error": "method not allowed"})
                return self._json(404, {"error": "not found"})
            try:
                self._json(200, handler())
            except BadRequest as exc:
                log.warning("400 %s: %s", path, exc)
                self._json(400, {"error": str(exc)})
            except Exception:
                # The CRM retries a 500 with backoff, which is right for a
                # calendar hiccup and harmless for a bug: the payload is
                # logged here, the state is unchanged there.
                log.exception("%s failed", path)
                self._json(500, {"error": "internal error"})

        def do_GET(self) -> None:  # noqa: N802 - stdlib API
            self._route("GET")

        def do_POST(self) -> None:  # noqa: N802 - stdlib API
            self._route("POST")

    return Handler


def make_server(service: BrainService, secret: str, host: str = "127.0.0.1", port: int = 4321) -> ThreadingHTTPServer:
    """Bound but not serving. Tests call `serve_forever` on a thread and read
    `server_address` for the port; `serve` below does it for real."""
    if not secret:
        raise RuntimeError(
            "BD_BRAIN_SECRET is not set. The brain decides what this business says "
            "to its leads; it does not answer unauthenticated requests. Put the same "
            "value in the CRM's .env (BD_BRAIN_SECRET) and in this process's environment."
        )
    return ThreadingHTTPServer((host, port), _handler_factory(service, secret))


def serve(cfg: Settings, host: str = "127.0.0.1", port: int = 4321) -> int:
    secret = os.getenv("BD_BRAIN_SECRET", "").strip()
    service = BrainService(cfg)

    # No Google OAuth on a laptop? The simulated calendar (every hour free
    # except 13.00) lets a tester walk the booking path instead of grading
    # the "jadwalnya sedang saya siapkan" degradation. Never the default: the
    # runbook's scenario 3 checks the event lands in the real calendar.
    if (os.getenv("BD_BRAIN_SIMULATE_CALENDAR") or "").strip().lower() in {"1", "true", "yes", "on"}:
        gcal.use_simulated()
        log.warning("calendar: SIMULATED (BD_BRAIN_SIMULATE_CALENDAR) — nothing reaches Google")
    else:
        log.info("calendar: %s via %s", cfg.google_calendar_id, cfg.google_token)

    server = make_server(service, secret, host, port)
    log.info(
        "bd-brain serving on http://%s:%d — LLM intents %s, LLM replies %s, DM→WA hand-off %s",
        host, port,
        "on" if cfg.use_llm_intents and cfg.anthropic_api_key else "off (rules only)",
        "on" if cfg.use_llm_replies and cfg.anthropic_api_key else "off (static templates)",
        "on" if flow.handoff_ready(cfg) else "OFF — BD_WHATSAPP_NUMBER is empty",
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


def start_in_thread(service: BrainService, secret: str, host: str = "127.0.0.1") -> tuple[ThreadingHTTPServer, str]:
    """For tests: an ephemeral port, serving on a daemon thread. Returns the
    server (call `shutdown()`) and its base URL."""
    server = make_server(service, secret, host, 0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    h, p = server.server_address[:2]
    return server, f"http://{h}:{p}"
