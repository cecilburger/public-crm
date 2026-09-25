"""A brand handing us somebody else's number.

"Hai kak grace, kaka bisa hubungi yang berkait ya +62 878-8496-2002 Pak Jo" —
a warm introduction, and the best lead the list will ever get. It gets queued
before the acknowledgement goes out, and the acknowledgement itself is a
promise the team keeps: thanks, and we will call them.

Whether the queue accepted it is a separate matter. The thread ends either
way — a brand that hands over a number has said "I am not your contact", and
that is true with or without a reachable dashboard.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bd_bot.config import Settings  # noqa: E402
from bd_bot.engine import Engine  # noqa: E402
from bd_bot.models import Conversation, Node  # noqa: E402
from bd_bot.storage import Store  # noqa: E402
from bd_bot.transport.mock import MockTransport  # noqa: E402

JID = "628119000002@s.whatsapp.net"


@pytest.fixture
def bot(tmp_path):
    cfg = Settings()
    cfg.db_path = tmp_path / "r.sqlite3"
    cfg.dry_run = False
    cfg.require_approval = False
    cfg.auto_reply = True
    cfg.min_seconds_between_sends = 0
    cfg.use_llm_replies = False
    cfg.company_profile_pdf = tmp_path / "p.pdf"
    cfg.company_profile_pdf.write_bytes(b"%PDF-1.4")
    cfg.opening_dir = tmp_path / "o"
    cfg.opening_dir.mkdir()
    (cfg.opening_dir / "d.pdf").write_bytes(b"%PDF-1.4")
    store = Store(cfg.db_path)
    tr = MockTransport(echo=False)
    eng = Engine(cfg, store, tr)
    eng.within_send_window = lambda when: True
    queued: list[tuple[str, str]] = []
    eng.on_referral = lambda phone, by="": (queued.append((phone, by)), True)[1]
    tr.start(eng.handle_inbound)
    yield eng, tr, store, queued
    store.close()


# -- reading the number out of the message ---------------------------------


# Pak Jo's real number, in the shapes brands actually type it.
# +62 878-8496-2002 is thirteen digits: 62 878 8496 2002.
@pytest.mark.parametrize("text,expected", [
    ("kaka bisa hubungi yang berkait ya +62 878-8496-2002 Pak Jo", "6287884962002"),
    ("silakan hubungi 0878-8496-2002 ya kak", "6287884962002"),
    ("coba ke 6287884962002 kak", "6287884962002"),
    ("hubungi pak jo di +62 878 8496 2002", "6287884962002"),
])
def test_a_referred_number_is_read(bot, text, expected):
    eng, *_ = bot
    assert eng._referred_numbers(text, JID) == [expected]


def test_their_own_number_is_not_re_added(bot):
    """Signatures repeat it; re-queueing would put this contact back in line."""
    eng, *_ = bot
    assert eng._referred_numbers("ini nomor kami 628119000002 ya kak", JID) == []


@pytest.mark.parametrize("text", [
    "harganya 62000000 kak",              # a price, not a phone
    "order id 6281 sudah masuk",          # too short
    "boleh minta detail paketnya kak?",   # no number at all
])
def test_things_that_are_not_phone_numbers(bot, text):
    eng, *_ = bot
    assert eng._referred_numbers(text, JID) == []


def test_two_numbers_are_both_taken(bot):
    eng, *_ = bot
    got = eng._referred_numbers(
        "bisa ke 0878-8496-2002 atau 081234567890 ya kak", JID)
    assert got == ["6287884962002", "6281234567890"]


# -- what the bot does with it ---------------------------------------------


def test_the_number_is_queued_and_acknowledged(bot):
    eng, tr, store, queued = bot
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Cimory"))
    tr.sent.clear()
    eng.handle_inbound(
        JID, "Cimory", "Hai kak grace, kaka bisa hubungi yang berkait ya "
                       "+62 878-8496-2002 Pak Jo")
    assert queued and queued[0][0] == "6287884962002"
    bodies = [t for _, t in tr.sent]
    assert bodies and "akan segera kami hubungi" in bodies[0].lower()


def test_it_is_queued_before_the_reply_goes_out(bot):
    """The queue is already moving by the time the promise is read."""
    eng, tr, store, queued = bot
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Cimory"))
    order = []
    eng.on_referral = lambda phone, by="": (order.append("queued"), True)[1]
    real_send = eng._send
    eng._send = lambda c, t, n, **kw: (order.append("replied"), real_send(c, t, n, **kw))[1]
    eng.handle_inbound(JID, "Cimory", "hubungi 0878-8496-2002 ya kak")
    assert order[:2] == ["queued", "replied"]


def test_a_human_reads_it_too(bot):
    eng, _, store, _ = bot
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Cimory"))
    eng.handle_inbound(JID, "Cimory", "hubungi pak jo 0878-8496-2002 ya")
    assert any("nomor lain" in r["reason"] for r in store.open_escalations())


def test_a_failed_queue_still_ends_the_conversation(bot):
    """The dashboard being down does not put us back in the wrong thread.

    The old code gated everything on a successful POST, so a rejected or
    unreachable queue dropped the message into the ordinary flow — same
    receptionist, same email request, by another route.
    """
    from bd_bot.models import Node as N

    eng, tr, store, _ = bot
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Cimory"))
    eng.on_referral = lambda phone, by="": False
    tr.sent.clear()
    eng.handle_inbound(JID, "Cimory", "hubungi 0878-8496-2002 ya kak")
    assert [t for _, t in tr.sent if "akan segera kami hubungi" in t.lower()]
    assert store.get(JID).node is N.HANDOVER


def test_a_failed_queue_asks_a_human_to_add_the_number(bot):
    """A number that exists only in a log line never gets called."""
    eng, _, store, _ = bot
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Cimory"))
    eng.on_referral = lambda phone, by="": False
    eng.handle_inbound(JID, "Cimory", "hubungi 0878-8496-2002 ya kak")
    reasons = [r["reason"] for r in store.open_escalations()]
    assert any("manual" in r and "6287884962002" in r for r in reasons), reasons


def test_a_message_with_no_number_flows_on_normally(bot):
    eng, tr, store, queued = bot
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Cimory"))
    tr.sent.clear()
    eng.handle_inbound(JID, "Cimory", "harganya berapa kak?")
    assert queued == []
    assert tr.sent, "an ordinary question stopped being answered"


def test_no_hook_still_hands_the_conversation_over(bot):
    """The simulator has no dashboard to queue into — it still stops here."""
    from bd_bot.models import Node as N

    eng, tr, store, _ = bot
    eng.on_referral = None
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Cimory"))
    tr.sent.clear()
    eng.handle_inbound(JID, "Cimory", "hubungi 0878-8496-2002 ya kak")
    assert store.get(JID).node is N.HANDOVER
    assert [t for _, t in tr.sent if "akan segera kami hubungi" in t.lower()]


# -- and then the conversation is over -------------------------------------
# "Hubungi PIC kami di Luthfi" means "I am not your contact". On 14 Aug the
# bot carried on regardless: it read the sign-off "baik kak good luck yaa" as
# agreement, offered meeting slots, and then asked a receptionist for her
# email address. Everything after a referral is spent on the wrong person.


def test_the_conversation_is_handed_over(bot):
    from bd_bot.models import Node as N

    eng, _, store, _ = bot
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Marimas"))
    eng.handle_inbound(
        JID, "Marimas",
        "Kakak dapat langsung menghubungi PIC Digital Marketing kami di "
        "kontak berikut: Luthfi (+62 856-0000-0003)")
    assert store.get(JID).node is N.HANDOVER


def test_a_sign_off_after_a_referral_is_not_agreement(bot):
    """The exact turn that went wrong: "baik kak good luck yaa" produced a
    slot proposal."""
    eng, tr, store, _ = bot
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Marimas"))
    eng.handle_inbound(JID, "Marimas", "hubungi PIC kami Luthfi 0856-0000-0003")
    tr.sent.clear()
    eng.handle_inbound(JID, "Marimas", "baik kak good luck yaa ☺️")
    assert tr.sent == [], "the bot answered after being handed off"


def test_a_repeated_redirect_gets_no_reply_either(bot):
    eng, tr, store, _ = bot
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Marimas"))
    eng.handle_inbound(JID, "Marimas", "hubungi PIC kami Luthfi 0856-0000-0003")
    eng.handle_inbound(JID, "Marimas", "baik kak good luck yaa ☺️")
    tr.sent.clear()
    eng.handle_inbound(
        JID, "Marimas", "bisa langsung menghubungi kontak yang tadi mimin share ya kak")
    assert tr.sent == [], "the bot asked the wrong person for an email"


def test_later_messages_still_reach_a_human(bot):
    """Quiet, not deaf — somebody should still read what they wrote."""
    eng, _, store, _ = bot
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Marimas"))
    eng.handle_inbound(JID, "Marimas", "hubungi PIC kami Luthfi 0856-0000-0003")
    eng.handle_inbound(JID, "Marimas", "oh iya kak satu lagi")
    reasons = [r["reason"] for r in store.open_escalations()]
    assert any("handover" in r for r in reasons), reasons


def test_the_pending_ladder_is_dropped(bot):
    """No follow-up should chase a contact who has redirected us."""
    from bd_bot.models import Timer

    eng, _, store, _ = bot
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Marimas"))
    store.schedule(JID, Timer.COLD_FU2, eng.now())
    eng.handle_inbound(JID, "Marimas", "hubungi PIC kami Luthfi 0856-0000-0003")
    assert store.pending(JID) == []


# -- a well-wish is not a yes ----------------------------------------------


@pytest.mark.parametrize("text", [
    "baik kak good luck yaa ☺️",          # verbatim, 14 Aug
    "semoga sukses ya kak",
    "good luck kak",
    "baik kak, sukses selalu",
    "ok kak semoga lancar",
])
def test_a_farewell_is_not_agreement(text):
    """"baik kak good luck yaa" was classified OK_LANJUT — the "baik kak" won
    — and the flow answered a farewell with three meeting slots."""
    from bd_bot import intents
    from bd_bot.models import Intent

    cfg = Settings()
    cfg.use_llm_intents = False
    got = intents.classify(text, cfg)
    assert got not in (Intent.OK_LANJUT, Intent.SETUJU), f"{text!r} -> {got}"


@pytest.mark.parametrize("text", [
    "baik kak boleh",
    "ok kak lanjut",
    "oke siap kak",
    "boleh kak dijadwalkan online meeting",
])
def test_real_agreement_still_reads_as_agreement(text):
    from bd_bot import intents
    from bd_bot.models import Intent

    cfg = Settings()
    cfg.use_llm_intents = False
    got = intents.classify(text, cfg)
    assert got in (Intent.OK_LANJUT, Intent.SETUJU), f"{text!r} -> {got}"


# -- the canned reply that still hands over a number ------------------------
# The referral check used to sit AFTER the autoresponder check, and Marimas'
# actual reply trips the marker "terima kasih atas ketertarikan" — so the auto
# branch swallowed the whole message, the number was never queued, and the
# thread stayed open. Two turns later the bot offered three meeting slots and
# asked for an email address. A machine that gives us a number is still giving
# us the number.

MARIMAS = (
    "Halo Kak 👋\n\n"
    "Terima kasih atas ketertarikannya dan penawarannya 🙏✨\n"
    "Untuk informasi lebih lanjut serta koordinasi terkait berbagai bentuk "
    "kerja sama dengan Marifood, Kakak dapat langsung menghubungi PIC Digital "
    "Marketing kami di kontak berikut:\n\n"
    "📞 Luthfi (+62 856-0000-0003)\n\n"
    "Semoga dapat segera terhubung dan menjalin komunikasi lebih lanjut 😊\n"
    "Terima kasih."
)


def test_the_marimas_reply_reads_as_a_referral_not_an_autoresponder(bot):
    from bd_bot.models import Node as N

    eng, tr, store, queued = bot
    assert eng._looks_automated(MARIMAS, eng.transport_number()), (
        "the premise of this test: it does look automated")
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Marimas"))
    tr.sent.clear()
    eng.handle_inbound(JID, "Marimas", MARIMAS)
    assert queued and queued[0][0] == "6285600000003", queued
    assert [t for _, t in tr.sent if "akan segera kami hubungi" in t.lower()]
    assert store.get(JID).node is N.HANDOVER


def test_the_whole_marimas_thread_stops_after_the_referral(bot):
    """Verbatim, 13-14 Aug: the two turns that drew a slot list and an email
    request."""
    eng, tr, store, _ = bot
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Marimas"))
    eng.handle_inbound(JID, "Marimas", MARIMAS)
    tr.sent.clear()
    eng.handle_inbound(JID, "Marimas", "baik kak good luck yaa ☺️")
    eng.handle_inbound(
        JID, "Marimas",
        "bisa langsung menghubungi kontak yang tadi mimin share ya kak ☺️")
    assert tr.sent == [], [t for _, t in tr.sent]


# -- a switchboard printing its own contact details -------------------------
# Reading the referral before the autoresponder branch means hotline numbers
# now reach this code. A toll-free line is not a warm lead, and queueing one
# would also hand over a conversation nobody redirected.

@pytest.mark.parametrize("text", [
    "Customer Care kami 0800-1-234567 siap membantu",   # toll-free
    "hubungi kami di 021-5289-7000 ya",                 # Jakarta landline
    "layanan pelanggan 0804-1-500-500",
])
def test_a_hotline_is_not_a_referral(bot, text):
    eng, *_ = bot
    assert eng._referred_numbers(text, JID) == []


@pytest.mark.parametrize("prefix", ["811", "812", "813", "821", "822", "831",
                                    "838", "851", "856", "877", "878", "881",
                                    "895", "899"])
def test_every_real_mobile_prefix_still_reads(bot, prefix):
    eng, *_ = bot
    assert eng._referred_numbers(f"hubungi 0{prefix}-1234-5678 ya kak", JID) == [
        f"62{prefix}12345678"]
