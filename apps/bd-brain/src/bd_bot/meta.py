"""Instagram and Facebook inbound: reading what Meta sends us.

Everything here is pure. A webhook arrives as bytes and a signature header,
and this module turns it into `Event`s or refuses it — no sockets, no Graph
calls, no state. That is deliberate: the credentials to run this live are a
business process (an app review, a Page token, a public HTTPS endpoint), and
without them the only way to know the parsing is right is to test it against
the payload shapes Meta documents. So the parsing is separable, and it is.

The three shapes that reach us, and how they differ:

* **DMs** (`entry[].messaging[]`) — Instagram DMs and Messenger DMs are the
  same envelope. A story reply arrives here too, carrying the story as
  context; without that context it reads as a non-sequitur, which is why
  `Event.context` exists rather than being dropped.
* **Instagram comments** (`entry[].changes[]`, field `comments`).
* **Facebook Page comments** (`entry[].changes[]`, field `feed`, with
  `item == "comment"`). The feed field also carries likes, posts, shares and
  edits, and only an added comment is ours.

A comment is **not** a conversation, and this module does not pretend it is.
It marks them `kind="comment"` and the caller applies the BD team's own rule:
one short public reply, then move to DM. See `transport/meta.py`.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

log = logging.getLogger(__name__)

#: What we call each platform on `Conversation.source`.
INSTAGRAM = "instagram"
FACEBOOK = "facebook"


@dataclass(frozen=True, slots=True)
class Event:
    """One inbound thing a person did, normalised across both platforms."""

    kind: str
    """"dm" or "comment". Nothing else is produced."""

    platform: str
    """INSTAGRAM or FACEBOOK."""

    sender_id: str
    """The scoped id Meta gives us — an IGSID or a PSID. NOT a phone number
    and not a username: it is per-app, and it is the only thing we can send
    to."""

    text: str
    sender_name: str = ""
    """Present on comments (the commenter's username/name); Messenger does
    not put a name in the message webhook, so DMs usually have none."""

    message_id: str = ""
    """Meta's own id for the message or comment. Meta retries a webhook it
    thinks failed, so this is what stops one message being answered twice."""

    comment_id: str = ""
    """Set on comments: the object a public reply is posted to."""

    post_id: str = ""
    """The media/post the comment sits under — the BD team's "which post is
    producing leads" question."""

    context: str = ""
    """A story reply's story, or a comment's parent. Carried because a story
    reply without it reads as a non-sequitur."""

    sent_at: datetime | None = None

    extra: dict[str, Any] = field(default_factory=dict, compare=False)

    @property
    def jid(self) -> str:
        """The conversation key. Namespaced by platform because an IGSID and
        a PSID are separate id spaces and could collide."""
        return jid_for(self.platform, self.sender_id)


def jid_for(platform: str, sender_id: str) -> str:
    """`ig:<IGSID>` / `fb:<PSID>`.

    Deliberately unlike a WhatsApp jid (`62812...@s.whatsapp.net`), so that
    anything treating a jid as a phone number fails loudly here instead of
    quietly dialling a number that is actually an account id.
    """
    prefix = "ig" if platform == INSTAGRAM else "fb"
    return f"{prefix}:{sender_id}"


def platform_of(jid: str) -> str:
    """INSTAGRAM / FACEBOOK / "" for anything else (i.e. WhatsApp)."""
    if jid.startswith("ig:"):
        return INSTAGRAM
    if jid.startswith("fb:"):
        return FACEBOOK
    return ""


def account_id(jid: str) -> str:
    """The id back out of a jid — what Graph calls need."""
    return jid.split(":", 1)[1] if ":" in jid else jid


# --- authenticity ----------------------------------------------------------


def verify_signature(body: bytes, header: str, app_secret: str) -> bool:
    """Is this payload really from Meta?

    The endpoint is public by necessity — Meta has to reach it — so without
    this anyone who learns the URL can post a message that the bot answers
    as a brand, and the reply goes to an account id of their choosing.

    An empty app secret returns False rather than True. A missing secret is
    a misconfiguration, and the safe reading of "I cannot check" is "no".
    """
    if not app_secret or not header:
        return False
    algo, _, sent = header.partition("=")
    if algo != "sha256" or not sent:
        return False
    expected = hmac.new(
        app_secret.encode("utf-8"), body, hashlib.sha256
    ).hexdigest()
    # compare_digest, not ==: a plain comparison leaks how much of the
    # signature was right through how long it took to say no.
    return hmac.compare_digest(expected, sent)


def challenge(params: dict[str, list[str]] | dict[str, str], verify_token: str) -> str | None:
    """Meta's GET handshake when the webhook is first subscribed.

    Returns the challenge string to echo, or None to refuse. Refusing on a
    wrong token matters: the handshake is how Meta decides the endpoint is
    ours, and an endpoint that echoes anything lets someone else point their
    app's webhooks at us.
    """
    def one(key: str) -> str:
        v = params.get(key, "")
        return (v[0] if isinstance(v, list) else v) or ""

    if one("hub.mode") != "subscribe":
        return None
    if not verify_token or not hmac.compare_digest(one("hub.verify_token"), verify_token):
        return None
    return one("hub.challenge") or None


# --- parsing ---------------------------------------------------------------


def _ts(value: Any) -> datetime | None:
    """Meta sends milliseconds on messages and ISO-8601 on comments."""
    if value in (None, ""):
        return None
    try:
        if isinstance(value, (int, float)) or str(value).isdigit():
            return datetime.fromtimestamp(int(value) / 1000, tz=timezone.utc)
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, OSError, OverflowError):
        return None


def _platform(entry: dict, payload_object: str) -> str:
    """`object` is "instagram" or "page" at the top of the payload. Trust it
    first; fall back to the field name, because Meta has shipped both."""
    if payload_object == "instagram":
        return INSTAGRAM
    if payload_object == "page":
        return FACEBOOK
    return INSTAGRAM if entry.get("messaging_product") == "instagram" else FACEBOOK


def _dm_events(entry: dict, platform: str, page_ids: set[str]) -> list[Event]:
    out: list[Event] = []
    for m in entry.get("messaging") or []:
        msg = m.get("message") or {}
        sender = str((m.get("sender") or {}).get("id") or "")
        if not sender:
            continue

        # Our own outgoing messages come back on the same webhook. Answering
        # one is a bot talking to itself forever, on a channel where every
        # turn is a real notification on somebody's phone.
        if msg.get("is_echo") or sender in page_ids:
            continue

        # A deletion, a reaction, a read receipt, a delivery receipt, a
        # postback: all valid envelopes with no message for the flow.
        text = (msg.get("text") or "").strip()
        if not text:
            if msg.get("attachments"):
                log.info("attachment-only DM from %s — nothing to classify", sender)
            continue

        reply_to = msg.get("reply_to") or {}
        out.append(
            Event(
                kind="dm",
                platform=platform,
                sender_id=sender,
                text=text,
                message_id=str(msg.get("mid") or ""),
                # A story reply carries what it is replying to. Without it
                # "bagus banget kak!" has no referent.
                context=str(reply_to.get("story", {}).get("id", "") or reply_to.get("mid", "") or ""),
                sent_at=_ts(m.get("timestamp")),
            )
        )
    return out


def _comment_events(entry: dict, platform: str, page_ids: set[str]) -> list[Event]:
    out: list[Event] = []
    for ch in entry.get("changes") or []:
        field_name = ch.get("field")
        v = ch.get("value") or {}

        if field_name == "comments":  # Instagram
            frm = v.get("from") or {}
            media = v.get("media") or {}
            sender = str(frm.get("id") or "")
            text = (v.get("text") or "").strip()
            if not sender or not text or sender in page_ids:
                continue
            out.append(
                Event(
                    kind="comment",
                    platform=INSTAGRAM,
                    sender_id=sender,
                    sender_name=str(frm.get("username") or ""),
                    text=text,
                    message_id=str(v.get("id") or ""),
                    comment_id=str(v.get("id") or ""),
                    post_id=str(media.get("id") or ""),
                    context=str((v.get("parent_id") or "")),
                    sent_at=_ts(v.get("timestamp")),
                )
            )

        elif field_name == "feed":  # Facebook Page
            # The feed field is everything that happens on the Page. Likes,
            # posts, shares, edits and removals all arrive here, and only an
            # added comment is a person asking us something.
            if v.get("item") != "comment" or v.get("verb") != "add":
                continue
            frm = v.get("from") or {}
            sender = str(frm.get("id") or "")
            text = (v.get("message") or "").strip()
            if not sender or not text or sender in page_ids:
                continue
            out.append(
                Event(
                    kind="comment",
                    platform=FACEBOOK,
                    sender_id=sender,
                    sender_name=str(frm.get("name") or ""),
                    text=text,
                    message_id=str(v.get("comment_id") or ""),
                    comment_id=str(v.get("comment_id") or ""),
                    post_id=str(v.get("post_id") or ""),
                    context=str(v.get("parent_id") or ""),
                    sent_at=_ts(v.get("created_time")),
                )
            )
    return out


def parse(payload: dict, page_ids: set[str] | None = None) -> list[Event]:
    """Every actionable event in one webhook delivery.

    `page_ids` are the ids we post as (the Page id, the IG business account
    id). Anything from them is our own voice coming back and is dropped —
    the echo flag covers DMs, but a comment we posted has no echo flag at
    all, and replying to our own reply is a public loop.

    Anything unrecognised is skipped silently. Meta adds fields to these
    payloads without notice, and a webhook that 500s gets retried and then
    disabled.
    """
    page_ids = {str(p) for p in (page_ids or set()) if p}
    obj = str(payload.get("object") or "")
    events: list[Event] = []
    for entry in payload.get("entry") or []:
        if not isinstance(entry, dict):
            continue
        platform = _platform(entry, obj)
        events.extend(_dm_events(entry, platform, page_ids))
        events.extend(_comment_events(entry, platform, page_ids))
    return events
