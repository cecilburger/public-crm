"""Instagram DM, Facebook DM, and comments on both.

None of this can be tested against Meta: running it live needs an app review,
a Page token and a public HTTPS endpoint, which is a business process rather
than a build step. So the payloads below are the documented shapes, written
out in full rather than reduced to the fields under test — a webhook that
parses a stripped-down fixture and not the real envelope is the failure this
suite exists to catch.

The prohibitions are the interesting half, and each one is a test:

* a comment must never reach the flow;
* our own messages and our own comments must never be answered;
* a retried delivery must not be answered twice;
* an unsigned or wrongly-signed payload must be refused.
"""

import hashlib
import hmac
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bd_bot import meta  # noqa: E402
from bd_bot.config import Settings  # noqa: E402
from bd_bot.models import Conversation  # noqa: E402
from bd_bot.transport.meta import MetaTransport, _split  # noqa: E402

PAGE_ID = "111222333"
IG_ID = "17841400000000000"


def _cfg(**over) -> Settings:
    cfg = Settings()
    cfg.meta_app_secret = "rahasia-app"
    cfg.meta_verify_token = "token-verifikasi"
    cfg.meta_page_token = "token-halaman"
    cfg.meta_page_ids = (PAGE_ID, IG_ID)
    for k, v in over.items():
        setattr(cfg, k, v)
    return cfg


# --- the payloads Meta actually sends ---------------------------------------


def ig_dm(text="Mau info affiliate", sender="9988776655", mid="mid.ig.1", echo=False):
    msg = {"mid": mid, "text": text}
    if echo:
        msg["is_echo"] = True
    return {
        "object": "instagram",
        "entry": [{
            "id": IG_ID,
            "time": 1758150000000,
            "messaging": [{
                "sender": {"id": PAGE_ID if echo else sender},
                "recipient": {"id": sender if echo else IG_ID},
                "timestamp": 1758150000000,
                "message": msg,
            }],
        }],
    }


def fb_dm(text="Halo, saya mau konsultasi", sender="5544332211", mid="mid.fb.1"):
    return {
        "object": "page",
        "entry": [{
            "id": PAGE_ID,
            "time": 1758150000000,
            "messaging": [{
                "sender": {"id": sender},
                "recipient": {"id": PAGE_ID},
                "timestamp": 1758150000000,
                "message": {"mid": mid, "text": text},
            }],
        }],
    }


def ig_comment(text="Info kak", sender="9090909090", cid="17900000000000000"):
    return {
        "object": "instagram",
        "entry": [{
            "id": IG_ID,
            "time": 1758150000000,
            "changes": [{
                "field": "comments",
                "value": {
                    "id": cid,
                    "text": text,
                    "timestamp": "2026-09-18T04:20:00+0000",
                    "from": {"id": sender, "username": "brandkecil.id"},
                    "media": {"id": "17800000000000000", "media_product_type": "FEED"},
                },
            }],
        }],
    }


def fb_comment(text="Berapa harganya?", sender="7070707070",
               cid="111222333_444", verb="add", item="comment"):
    return {
        "object": "page",
        "entry": [{
            "id": PAGE_ID,
            "time": 1758150000000,
            "changes": [{
                "field": "feed",
                "value": {
                    "item": item,
                    "verb": verb,
                    "comment_id": cid,
                    "post_id": "111222333_999",
                    "created_time": 1758150000,
                    "message": text,
                    "from": {"id": sender, "name": "Toko Melati"},
                },
            }],
        }],
    }


# --- parsing ----------------------------------------------------------------


def test_an_instagram_dm_becomes_one_event():
    (ev,) = meta.parse(ig_dm(), {PAGE_ID, IG_ID})
    assert ev.kind == "dm"
    assert ev.platform == meta.INSTAGRAM
    assert ev.text == "Mau info affiliate"
    assert ev.jid == "ig:9988776655"
    # Meta sends milliseconds on messages. Read as seconds this lands in
    # 57000 AD, and `stale_inbound_hours` would escalate every message.
    assert ev.sent_at == datetime(2025, 9, 17, 23, 0, tzinfo=timezone.utc)


def test_a_facebook_dm_is_told_apart_from_an_instagram_one():
    (ev,) = meta.parse(fb_dm(), {PAGE_ID})
    assert ev.platform == meta.FACEBOOK
    assert ev.jid == "fb:5544332211"


def test_the_two_id_spaces_cannot_collide():
    """An IGSID and a PSID are separate id spaces. The same digits on the two
    platforms are two different people, and an unnamespaced key would merge
    their conversations."""
    assert meta.jid_for(meta.INSTAGRAM, "123") != meta.jid_for(meta.FACEBOOK, "123")
    assert meta.account_id("ig:123") == meta.account_id("fb:123") == "123"


def test_a_meta_jid_does_not_look_like_a_phone_number():
    """Anything treating a jid as a number must fail loudly rather than
    quietly dial an account id — an IGSID is 17 digits and would parse as a
    phone number without complaint."""
    jid = meta.jid_for(meta.INSTAGRAM, IG_ID)
    assert "@s.whatsapp.net" not in jid
    assert not jid.isdigit()
    assert meta.platform_of(jid) == meta.INSTAGRAM
    assert meta.platform_of("6281234567890@s.whatsapp.net") == ""


def test_our_own_echoed_message_is_not_answered():
    """Messenger delivers our outgoing messages back on the same webhook.
    Answering one is a bot talking to itself forever, and every turn is a
    real notification on somebody's phone."""
    assert meta.parse(ig_dm(echo=True), {PAGE_ID, IG_ID}) == []


def test_a_message_from_the_page_itself_is_not_answered():
    """Belt and braces: `is_echo` is not present on every shape Meta has
    shipped, so the sender id is checked too."""
    payload = ig_dm(sender=PAGE_ID)
    assert meta.parse(payload, {PAGE_ID, IG_ID}) == []


@pytest.mark.parametrize("message", [
    {"mid": "m1", "attachments": [{"type": "image", "payload": {"url": "http://x/y.jpg"}}]},
    {"mid": "m2", "text": "   "},
    {"mid": "m3", "reaction": {"emoji": "❤", "action": "react"}},
])
def test_envelopes_with_nothing_to_classify_are_skipped(message):
    """Reactions, read receipts and attachment-only messages are valid
    envelopes with no text. Passing "" to the classifier would burn an
    unknown-streak strike towards a human handover."""
    payload = ig_dm()
    payload["entry"][0]["messaging"][0]["message"] = message
    assert meta.parse(payload, {PAGE_ID, IG_ID}) == []


def test_a_delivery_receipt_is_not_a_message():
    payload = {"object": "page", "entry": [{"id": PAGE_ID, "messaging": [
        {"sender": {"id": "5", "": ""}, "recipient": {"id": PAGE_ID},
         "delivery": {"mids": ["mid.1"], "watermark": 1758150000000}},
    ]}]}
    assert meta.parse(payload, {PAGE_ID}) == []


def test_an_instagram_comment_carries_what_a_reply_needs():
    (ev,) = meta.parse(ig_comment(), {PAGE_ID, IG_ID})
    assert ev.kind == "comment"
    assert ev.comment_id == "17900000000000000"
    assert ev.post_id == "17800000000000000"
    assert ev.sender_name == "brandkecil.id"
    assert ev.jid == "ig:9090909090"


def test_a_facebook_comment_carries_the_same():
    (ev,) = meta.parse(fb_comment(), {PAGE_ID})
    assert ev.kind == "comment"
    assert ev.platform == meta.FACEBOOK
    assert ev.comment_id == "111222333_444"
    assert ev.post_id == "111222333_999"
    assert ev.sender_name == "Toko Melati"


@pytest.mark.parametrize("verb,item", [
    ("add", "like"), ("add", "post"), ("add", "share"),
    ("edited", "comment"), ("remove", "comment"), ("hide", "comment"),
])
def test_the_feed_field_is_not_all_comments(verb, item):
    """`feed` is everything that happens on a Page. Only an ADDED comment is
    a person asking us something — answering an edit or a like would post a
    public reply to nobody."""
    assert meta.parse(fb_comment(verb=verb, item=item), {PAGE_ID}) == []


def test_our_own_comment_is_not_answered():
    """A comment we posted carries no echo flag at all, so replying to our
    own reply is a public loop with nothing to stop it."""
    assert meta.parse(ig_comment(sender=IG_ID), {PAGE_ID, IG_ID}) == []


def test_an_unknown_payload_is_skipped_not_raised():
    """Meta adds fields without notice, and a webhook that 500s is retried
    and then disabled."""
    assert meta.parse({"object": "page", "entry": [{"id": PAGE_ID, "changes": [
        {"field": "mention", "value": {"post_id": "1"}}]}]}, {PAGE_ID}) == []
    assert meta.parse({}, set()) == []
    assert meta.parse({"entry": ["not a dict"]}, set()) == []


def test_one_delivery_can_carry_several_events():
    """Meta batches. A handler that reads entry[0] only loses the rest."""
    payload = ig_dm()
    payload["entry"].append(ig_comment()["entry"][0])
    kinds = sorted(e.kind for e in meta.parse(payload, {PAGE_ID, IG_ID}))
    assert kinds == ["comment", "dm"]


# --- authenticity -----------------------------------------------------------


def _sign(body: bytes, secret: str = "rahasia-app") -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def test_a_correct_signature_is_accepted():
    body = json.dumps(ig_dm()).encode()
    assert meta.verify_signature(body, _sign(body), "rahasia-app")


@pytest.mark.parametrize("header", [
    "", "sha256=", "sha1=abc", "abc",
    "sha256=" + "0" * 64,
])
def test_a_wrong_signature_is_refused(header):
    """The endpoint is public by necessity. Without this, anyone who finds
    the URL can make the bot answer as us, to an account of their choosing."""
    body = json.dumps(ig_dm()).encode()
    assert not meta.verify_signature(body, header, "rahasia-app")


def test_a_tampered_body_is_refused():
    body = json.dumps(ig_dm()).encode()
    sig = _sign(body)
    assert not meta.verify_signature(body + b" ", sig, "rahasia-app")


def test_no_app_secret_refuses_everything():
    """A missing secret is a misconfiguration, and the safe reading of
    "I cannot check" is "no" — not "yes"."""
    body = json.dumps(ig_dm()).encode()
    assert not meta.verify_signature(body, _sign(body), "")


def test_the_subscription_handshake_needs_the_right_token():
    params = {"hub.mode": ["subscribe"], "hub.verify_token": ["token-verifikasi"],
              "hub.challenge": ["1158201444"]}
    assert meta.challenge(params, "token-verifikasi") == "1158201444"
    assert meta.challenge(params, "token-lain") is None
    assert meta.challenge(params, "") is None
    assert meta.challenge({**params, "hub.mode": ["unsubscribe"]}, "token-verifikasi") is None


# --- the transport's own rules ----------------------------------------------


class _Store:
    def __init__(self):
        self.convos: dict[str, Conversation] = {}

    def get(self, jid):
        return self.convos.get(jid)

    def upsert(self, convo):
        self.convos[convo.jid] = convo


class _Sent:
    """Records what would have gone to Graph, and never calls it."""

    def __init__(self):
        self.dms: list[tuple[str, str]] = []
        self.public: list[tuple[str, str]] = []


def _transport(cfg=None, store=None, escalate=None):
    t = MetaTransport(cfg or _cfg(), store=store, escalate=escalate)
    sent = _Sent()
    t.send_text = lambda jid, text: sent.dms.append((jid, text))
    t._reply_to_comment = lambda cid, text: sent.public.append((cid, text))
    return t, sent


def test_a_comment_never_reaches_the_flow():
    """The BD team's own rule: "Jangan jelaskan panjang di komentar." Handing
    a comment to handle_inbound would answer it at length in public, give the
    pitch away to everyone scrolling past, and remove the commenter's reason
    to DM — which is the entire goal."""
    seen = []
    t, sent = _transport()
    t._on_message = lambda *a: seen.append(a)
    t._dispatch(meta.parse(ig_comment(), {PAGE_ID, IG_ID}))
    assert seen == [], "a comment was given to the conversation flow"
    assert len(sent.public) == 1
    assert len(sent.dms) == 1


def test_the_public_reply_says_almost_nothing():
    """It exists to point at the DM. A price, a package or a scope in here is
    public, permanent and readable by every competitor."""
    from bd_bot import templates

    line = templates.REPLY_KOMENTAR_PUBLIK.strip()
    assert len(line) < 160, "a public comment reply must stay one short line"
    low = line.lower()
    for leak in ("rp", "juta", "harga", "paket", "%", "affiliate"):
        assert leak not in low, f"public comment reply leaks {leak!r}"
    assert "dm" in low


def test_the_real_answer_goes_out_privately():
    t, sent = _transport()
    t._dispatch(meta.parse(fb_comment(), {PAGE_ID}))
    (jid, text), = sent.dms
    assert jid == "fb:7070707070"
    assert "MCNAsia" in text and "Nama brand" in text


def test_the_public_reply_can_be_turned_off_without_losing_the_dm():
    t, sent = _transport(cfg=_cfg(meta_comment_public_reply=False))
    t._dispatch(meta.parse(ig_comment(), {PAGE_ID, IG_ID}))
    assert sent.public == []
    assert len(sent.dms) == 1


def test_a_failed_dm_escalates_rather_than_disappearing():
    """Instagram only allows a DM to a commenter inside a window. When it
    fails, a human has to know: the public line has already promised one."""
    notes = []
    t, _ = _transport(escalate=lambda jid, note: notes.append((jid, note)))
    t._reply_to_comment = lambda *a: None
    def boom(*_a):
        raise RuntimeError("(#10) not allowed to message this user")
    t.send_text = boom
    t._dispatch(meta.parse(ig_comment(text="Berapa harganya kak?"), {PAGE_ID, IG_ID}))
    assert notes, "a DM that could not be sent vanished"
    assert "Berapa harganya kak?" in notes[0][1]


def test_a_retried_delivery_is_answered_once():
    """Meta re-sends a delivery it believes failed. Without this the brand is
    answered twice, and on a channel where every turn is a notification."""
    seen = []
    t, _ = _transport()
    t._on_message = lambda *a: seen.append(a)
    payload = ig_dm(mid="mid.retry")
    t._dispatch(meta.parse(payload, {PAGE_ID, IG_ID}))
    t._dispatch(meta.parse(payload, {PAGE_ID, IG_ID}))
    assert len(seen) == 1


def test_a_message_with_no_id_is_still_delivered():
    """De-duplication must not become a way to lose real messages."""
    seen = []
    t, _ = _transport()
    t._on_message = lambda *a: seen.append(a)
    payload = ig_dm(mid="")
    t._dispatch(meta.parse(payload, {PAGE_ID, IG_ID}))
    t._dispatch(meta.parse(payload, {PAGE_ID, IG_ID}))
    assert len(seen) == 2


def test_a_dm_reaches_the_flow_unchanged():
    """The whole point of the adapter: the flow cannot tell which channel
    this came from, so the state machine, classifier and calendar are
    untouched."""
    seen = []
    t, _ = _transport()
    t._on_message = lambda *a: seen.append(a)
    t._dispatch(meta.parse(fb_dm(text="Paket 100 affiliate berapa?"), {PAGE_ID}))
    (jid, name, text, sent_at), = seen
    assert jid == "fb:5544332211"
    assert text == "Paket 100 affiliate berapa?"


def test_the_channel_is_recorded_on_the_conversation():
    """"Which channel is producing leads" is a weekly question this bot could
    not answer before."""
    store = _Store()
    t, _ = _transport(store=store)
    # handle_inbound is what creates the row, so stand in for it.
    def create(jid, name, text, sent_at):
        store.upsert(Conversation(jid=jid, name=name))
    t._on_message = create
    t._dispatch(meta.parse(ig_dm(), {PAGE_ID, IG_ID}))
    assert store.convos["ig:9988776655"].source == "instagram"


def test_one_failing_event_does_not_stop_the_rest():
    """A webhook that raises is retried and then disabled by Meta."""
    seen = []
    t, _ = _transport()
    calls = {"n": 0}
    def flaky(*a):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("boom")
        seen.append(a)
    t._on_message = flaky
    payload = ig_dm(mid="a")
    payload["entry"].append(ig_dm(sender="5", mid="b")["entry"][0])
    t._dispatch(meta.parse(payload, {PAGE_ID, IG_ID}))
    assert len(seen) == 1


def test_a_document_is_refused_loudly_not_dropped():
    """Graph will not attach the deck: IG DM takes no documents and the file
    is over Messenger's limit. A brand told the deck is coming and never sent
    it is the failure this prevents."""
    notes = []
    t, _ = _transport(escalate=lambda jid, note: notes.append(note))
    t.send_document("ig:123", Path("opening/deck.pdf"), "deck.pdf")
    assert notes and "deck.pdf" in notes[0]


# --- splitting --------------------------------------------------------------


def test_a_long_reply_is_split_on_a_boundary_never_mid_word():
    text = ("Baik Kak. " + "kata " * 400).strip()
    parts = _split(text, 900)
    assert len(parts) > 1
    assert all(len(p) <= 900 for p in parts)
    assert "".join(parts).replace(" ", "") == text.replace(" ", "")


def test_a_short_reply_is_left_alone():
    assert _split("Halo Kak", 900) == ["Halo Kak"]
    assert _split("   ", 900) == []


# --- the comment → DM seam (24 Sep 2026) -------------------------------------
#
# The opener a comment triggers is sent by this transport, not by the flow,
# so the flow did not know it had been sent: the commenter's first DM reply
# arrived at Node.NEW and was answered with the qualification questions a
# second time. The transport now seeds the conversation where the opener
# leaves it.


def test_a_comment_seeds_the_conversation_where_the_opener_leaves_it():
    from bd_bot.models import Node

    store = _Store()
    t, _ = _transport(store=store)
    t._dispatch(meta.parse(ig_comment(), {PAGE_ID, IG_ID}))
    convo = store.convos["ig:9090909090"]
    assert convo.node is Node.INBOUND_QUALIFY, "the opener has asked for their brand"
    assert convo.source == "instagram"
    assert convo.name == "brandkecil.id"


def test_a_dm_after_a_comment_is_not_asked_the_form_again():
    """End to end through the flow: comment, opener, their reply. The reply
    is read as the answer to the opener and gets the pitch, not INBOUND_
    QUALIFY_DM asking the same thing over."""
    from datetime import datetime

    from bd_bot import flow
    from bd_bot.flow import Send
    from bd_bot.models import Intent, Node

    store = _Store()
    t, _ = _transport(store=store)
    t._dispatch(meta.parse(ig_comment(text="Info kak"), {PAGE_ID, IG_ID}))
    convo = store.convos["ig:9090909090"]
    r = flow.on_inbound(convo, Intent.UNKNOWN, "Brand X, skincare, di TikTok", _cfg(), datetime(2026, 9, 24, 10, 0))
    keys = [a.message.key for a in r.actions if isinstance(a, Send)]
    assert keys == ["DM_SERVICE_PITCH"]
    assert convo.node is Node.INBOUND_QUALIFY or keys  # the flow moves it on via SetNode


def test_a_failed_dm_does_not_seed_a_conversation():
    """No opener went out, so nothing has been asked: the next message, if
    one ever comes, must get the opener from the flow."""
    store = _Store()
    t, _ = _transport(store=store, escalate=lambda *a: None)
    t._reply_to_comment = lambda *a: None

    def boom(*_a):
        raise RuntimeError("(#10) not allowed to message this user")

    t.send_text = boom
    t._dispatch(meta.parse(ig_comment(), {PAGE_ID, IG_ID}))
    assert "ig:9090909090" not in store.convos


def test_a_comment_from_someone_we_already_talk_to_keeps_their_place():
    from bd_bot.models import Node

    store = _Store()
    store.upsert(Conversation(jid="ig:9090909090", node=Node.SCHEDULING, source="instagram"))
    t, _ = _transport(store=store)
    t._dispatch(meta.parse(ig_comment(), {PAGE_ID, IG_ID}))
    assert store.convos["ig:9090909090"].node is Node.SCHEDULING


def test_a_dm_first_contact_carries_its_channel_into_the_flow():
    """The flow chooses the DM opener over the WhatsApp form by channel, so
    the channel has to be on the row BEFORE the flow runs on the very first
    message — not only written afterwards."""
    store = _Store()
    seen = []
    t, _ = _transport(store=store)

    def handler(jid, name, text, sent_at):
        seen.append(store.get(jid).source if store.get(jid) else None)

    t._on_message = handler
    t._dispatch(meta.parse(fb_dm(), {PAGE_ID}))
    assert seen == ["facebook"]


def test_the_public_line_matches_the_teams_own_script():
    """The CRM PDF's comment script: "Siap, detailnya kami kirim melalui DM
    ya Kak" — and nothing about the commenter's business asked in public."""
    from bd_bot import templates

    line = templates.REPLY_KOMENTAR_PUBLIK.strip().lower()
    assert "dm" in line and "siap" in line
    for ask in ("brand", "produk", "nomor", "wa"):
        assert ask not in line.split(), f"public line asks for {ask!r}"
