"""Reading a message in context, and what the engine does with the reading.

Every case here is a real thread the bot got wrong on 13–20 Aug 2026, reduced
to the reading that should have prevented it. No API is called: the reader is
stubbed, because what is under test is what the engine does with an answer, not
whether Claude produces one.
"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bd_bot import understanding  # noqa: E402
from bd_bot.config import Settings  # noqa: E402
from bd_bot.engine import Engine  # noqa: E402
from bd_bot.models import Conversation, Intent, Node, Timer  # noqa: E402
from bd_bot.storage import Store  # noqa: E402
from bd_bot.transport.mock import MockTransport  # noqa: E402

JID = "628119000001@s.whatsapp.net"


@pytest.fixture
def bot(tmp_path):
    cfg = Settings()
    cfg.db_path = tmp_path / "u.sqlite3"
    cfg.dry_run = False
    cfg.require_approval = False
    cfg.auto_reply = True
    cfg.min_seconds_between_sends = 0
    cfg.use_llm_replies = False
    cfg.use_llm_intents = False
    cfg.company_profile_pdf = tmp_path / "p.pdf"
    cfg.company_profile_pdf.write_bytes(b"%PDF-1.4")
    cfg.opening_dir = tmp_path / "o"
    cfg.opening_dir.mkdir()
    (cfg.opening_dir / "d.pdf").write_bytes(b"%PDF-1.4")
    store = Store(cfg.db_path)
    tr = MockTransport(echo=False)
    eng = Engine(cfg, store, tr)
    eng.within_send_window = lambda when: True
    tr.start(eng.handle_inbound)
    yield eng, tr, store
    store.close()


def _reads(eng, **fields):
    """Make the engine read every message the same way."""
    reading = understanding.Reading(understood=True, **fields)
    eng.read_message = lambda convo, text, now: reading
    return reading


def _said(tr):
    return " ".join(t for _, t in tr.sent).lower()


# -- the reader's own parsing ----------------------------------------------


def test_a_fenced_answer_is_still_read():
    got = understanding._json_object('```json\n{"intent": "setuju"}\n```')
    assert got == {"intent": "setuju"}


def test_prose_instead_of_json_is_no_opinion():
    assert understanding._json_object("Saya siap membantu!") is None


def test_an_email_must_appear_in_what_they_wrote():
    """A paraphrased or invented address would send the proposal nowhere."""
    text = "boleh ke email marketing@contoh-brand.com ya kak"
    assert understanding._as_email("marketing@contoh-brand.com", text) == (
        "marketing@contoh-brand.com")
    assert understanding._as_email("marketing@contoh-brand.co.id", text) == ""
    assert understanding._as_email("bukan-email", text) == ""


def test_phones_are_normalised_and_filtered():
    assert understanding._as_phones(["0856-0000-0003"]) == ["6285600000003"]
    assert understanding._as_phones(["1500123", "62", None]) == []


def test_no_key_means_no_opinion():
    cfg = Settings()
    cfg.use_llm_intents = True
    cfg.anthropic_api_key = ""
    assert understanding.read(cfg, "halo", []).understood is False


# -- what the engine does with it ------------------------------------------


def test_politeness_is_not_agreement(bot):
    """Kymm Skin: "baik kak 😊 -okt" drew a slot list, then an email request,
    then the same email request five more times."""
    eng, tr, store = bot
    _reads(eng, politeness_only=True, intent=Intent.TERIMA_KASIH)
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="Kymm Skin"))
    tr.sent.clear()
    eng.handle_inbound(JID, "Kymm Skin", "baik kak 😊 -okt")
    assert tr.sent == [], _said(tr)
    assert store.get(JID).node is Node.QNA, "politeness advanced the flow"


def test_the_follow_up_ladder_survives_politeness(bot):
    """Quiet now, not given up on: the scheduled nudge still stands."""
    eng, _, store = bot
    _reads(eng, politeness_only=True)
    store.upsert(Conversation(jid=JID, node=Node.WARM_D2, name="Kymm Skin"))
    store.schedule(JID, Timer.WARM_D5, eng.now())
    eng.handle_inbound(JID, "Kymm Skin", "baik kak 😊")
    assert store.pending(JID), "the follow-up was cancelled by a pleasantry"


def test_a_second_pleasantry_in_a_row_reaches_a_human(bot):
    eng, _, store = bot
    _reads(eng, politeness_only=True)
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="Kymm Skin"))
    eng.handle_inbound(JID, "Kymm Skin", "baik kak 😊 -okt")
    eng.handle_inbound(JID, "Kymm Skin", "baik kak🙏 -sa")
    reasons = [r["reason"] for r in store.open_escalations()]
    assert any("basa-basi" in r for r in reasons), reasons


def test_an_address_is_thanked_and_ends_the_thread(bot):
    """Bali Botanica: "Boleh langsung ke email marketing@… aja ya kak" was
    answered with three meeting slots and a request for their email."""
    eng, tr, store = bot
    _reads(eng, email="marketing@contoh-brand.com", intent=Intent.KIRIM_EMAIL)
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="Bali Botanica"))
    tr.sent.clear()
    eng.handle_inbound(JID, "Bali Botanica", "Boleh langsung ke email ... aja ya kak")
    said = _said(tr)
    assert "terima kasih" in said and "akan segera kami kirimkan" in said
    assert "kami tersedia" not in said and "boleh dibantu alamat email" not in said
    assert store.get(JID).node is Node.HANDOVER
    assert any("marketing@contoh-brand.com" in r["reason"]
               for r in store.open_escalations())


def test_an_address_inside_the_booking_still_books(bot):
    """The same nine characters mean the opposite here — it is the invitee."""
    eng, tr, store = bot
    _reads(eng, email="okta@kymm.co.id", intent=Intent.SETUJU)
    store.upsert(Conversation(jid=JID, node=Node.SCHEDULING, name="Kymm"))
    tr.sent.clear()
    eng.handle_inbound(JID, "Kymm", "okta@kymm.co.id")
    assert store.get(JID).node is not Node.HANDOVER


def test_a_bot_closing_the_chat_ends_it(bot):
    """Bening's: "percakapan ini akan kami akhiri dalam 5 menit kedepan" was
    read as a 17.00 booking, and the nudges ran for three more days."""
    eng, tr, store = bot
    _reads(eng, automated=True, ends_conversation=True,
           reason="bot menutup percakapan")
    store.upsert(Conversation(jid=JID, node=Node.WARM_D2, name="Bening's"))
    store.schedule(JID, Timer.WARM_D5, eng.now())
    tr.sent.clear()
    eng.handle_inbound(
        JID, "Bening's",
        "jika tidak ada, maka percakapan ini akan kami akhiri dalam 5 menit kedepan")
    assert tr.sent == [], _said(tr)
    assert store.get(JID).node is Node.HANDOVER
    assert store.pending(JID) == [], "still chasing a machine"


def test_hesitation_is_not_an_ending(bot):
    """A model that ends live conversations by itself costs real leads, so its
    verdict counts only alongside something that ends a thread on its own
    terms — a machine, an address, a number, a refusal."""
    eng, tr, store = bot
    _reads(eng, ends_conversation=True, intent=Intent.PELAJARI_DULU,
           reason="mau dipelajari dulu")
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="Medan Sport"))
    tr.sent.clear()
    eng.handle_inbound(JID, "Medan Sport", "Nanti di pelajari ya")
    assert tr.sent, "a brand still considering us was dropped"
    assert store.get(JID).node is not Node.HANDOVER


def test_opening_hours_are_never_a_booking(bot):
    """The exact 15 Aug failure: "Senin s/d Jumat pukul 09.00 - 18.00" became
    "Senin 17/08 jam 09.00 saya catat ya"."""
    eng, tr, store = bot
    _reads(eng, automated=True, intent=Intent.UNKNOWN)
    store.upsert(Conversation(jid=JID, node=Node.SCHEDULING, name="Bening's"))
    tr.sent.clear()
    eng.handle_inbound(
        JID, "Bening's",
        "Silahkan hubungi kami kembali pada Jam Operasional yaitu hari "
        "Senin s/d Jumat pukul 09.00 - 18.00")
    assert "saya catat" not in _said(tr)


def test_a_chosen_day_reaches_the_scheduling_branch(bot):
    """Green Angelica named Tuesday and was answered with who attends our
    meetings — the choice never reached the booking code."""
    eng, tr, store = bot
    _reads(eng, intent=Intent.TANYA_SISTEM, meeting_day=date(2026, 8, 18))
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="Green Angelica"))
    tr.sent.clear()
    eng.handle_inbound(JID, "Green Angelica", "Selasa aja yaa, sy libur kerja")
    assert store.get(JID).node in (Node.SCHEDULING, Node.SCHEDULED), _said(tr)


def test_a_named_day_does_not_override_a_refusal(bot):
    eng, _, store = bot
    _reads(eng, intent=Intent.TOLAK_TEGAS, meeting_day=date(2026, 9, 1))
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="X"))
    eng.handle_inbound(JID, "X", "bulan depan pun kami tidak tertarik")
    assert store.get(JID).node not in (Node.SCHEDULING, Node.SCHEDULED)


def test_without_a_reading_nothing_changes(bot):
    """No key, no package, a timeout: the rules answer exactly as before."""
    eng, tr, store = bot
    eng.read_message = lambda convo, text, now: understanding.Reading()
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="Cimory"))
    tr.sent.clear()
    eng.handle_inbound(JID, "Cimory", "harga paketnya berapa kak?")
    assert "harga" in _said(tr) or "paket" in _said(tr), _said(tr)


def test_a_reader_that_explodes_does_not_swallow_the_message(bot):
    """Reading can make a reply slower. It must never stop one going out."""
    eng, tr, store = bot

    def boom(cfg, text, history, **kw):
        raise RuntimeError("upstream is down")

    understanding_read = understanding.read
    understanding.read = boom
    try:
        store.upsert(Conversation(jid=JID, node=Node.QNA, name="Cimory"))
        tr.sent.clear()
        eng.handle_inbound(JID, "Cimory", "harga paketnya berapa kak?")
        assert tr.sent, "the message was dropped when the reader failed"
    finally:
        understanding.read = understanding_read


# -- learning: think once, then remember ------------------------------------
# The pilot's inbound traffic is overwhelmingly repeats — the same
# autoresponders, "baik kak" all day long. Every one of them used to be a
# fresh call.


@pytest.fixture
def counted(bot, monkeypatch):
    """The engine with a real cache and a counted stand-in for the model."""
    eng, tr, store = bot
    eng.cfg.use_llm_intents = True
    eng.cfg.anthropic_api_key = "test-key"
    calls = []

    def fake_read(cfg, text, history, *, brand="", now=None):
        calls.append(text)
        return understanding.Reading(
            understood=True, politeness_only=True, intent=Intent.TERIMA_KASIH,
            reason="basa-basi",
        )

    monkeypatch.setattr(understanding, "read", fake_read)
    return eng, tr, store, calls


def test_the_same_message_is_only_thought_about_once(counted):
    eng, _, store, calls = counted
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="Kymm"))
    for _ in range(4):
        eng.handle_inbound(JID, "Kymm", "baik kak 😊 -okt")
    assert len(calls) == 1, f"{len(calls)} calls for one repeated message"
    assert store.reading_stats()[0] == 1


def test_decoration_and_initials_do_not_make_a_new_case(counted):
    eng, _, store, calls = counted
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="Kymm"))
    eng.handle_inbound(JID, "Kymm", "baik kak 😊🙏🏻 -sa")
    eng.handle_inbound(JID, "Kymm", "Baik kak -dl")
    assert len(calls) == 1, "the same sentence, signed by two people"


def test_a_learned_case_carries_across_brands(counted):
    """The table is the bot's, not the conversation's — that is what makes it
    cheaper the longer it runs."""
    eng, _, store, calls = counted
    other = "628999000111@s.whatsapp.net"
    for jid, brand in ((JID, "Kymm"), (other, "Cimory")):
        store.upsert(Conversation(jid=jid, node=Node.QNA, name=brand))
        eng.handle_inbound(jid, brand, "baik kak 😊")
    assert len(calls) == 1


def test_what_we_said_first_is_part_of_the_case(bot, monkeypatch):
    """"Baik kak" after a slot proposal is not "baik kak" after a price."""
    eng, _, store = bot
    eng.cfg.use_llm_intents = True
    eng.cfg.anthropic_api_key = "test-key"
    calls = []
    monkeypatch.setattr(
        understanding, "read",
        lambda cfg, text, history, **kw: (
            calls.append(text),
            understanding.Reading(understood=True, intent=Intent.TERIMA_KASIH),
        )[1],
    )
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="Kymm"))
    store.log_message(JID, "out", "Boleh dibantu alamat email-nya?", eng.now())
    eng.handle_inbound(JID, "Kymm", "baik kak")
    store.log_message(JID, "out", "Harga paketnya Rp10jt per 2 bulan, Kak.",
                      eng.now())
    eng.handle_inbound(JID, "Kymm", "baik kak")
    assert len(calls) == 2, "two different situations collapsed into one case"


def test_an_address_is_never_answered_from_memory(bot, monkeypatch):
    """Replaying a remembered address would send the proposal to the wrong
    brand, so readings carrying one are not learned at all."""
    eng, _, store = bot
    eng.cfg.use_llm_intents = True
    eng.cfg.anthropic_api_key = "test-key"
    calls = []
    monkeypatch.setattr(
        understanding, "read",
        lambda cfg, text, history, **kw: (
            calls.append(text),
            understanding.Reading(
                understood=True, intent=Intent.KIRIM_EMAIL,
                email="marketing@contoh-brand.com"),
        )[1],
    )
    other = "628999000222@s.whatsapp.net"
    for jid, brand, addr in (
        (JID, "Bali", "marketing@contoh-brand.com"),
        (other, "Otten", "clarita.pinky@ottencoffee.co.id"),
    ):
        store.upsert(Conversation(jid=jid, node=Node.QNA, name=brand))
        eng.handle_inbound(jid, brand, f"boleh ke email {addr} ya kak")
    # Near-identical sentences, one address apart: matched loosely they would
    # be the same case, and the second brand would be sent the first one's
    # proposal.
    assert len(calls) == 2, "an address came back out of the cache"
    assert store.reading_stats()[0] == 0


def test_a_machine_means_the_same_thing_whatever_we_asked(counted):
    """A switchboard's notice does not depend on our question, so it is
    matched on the text alone."""
    eng, _, store, calls = counted
    notice = ("Mohon maaf saat ini anda tidak bisa terhubung ke customer "
              "service dikarenakan sudah diluar jam operasional.")
    calls.clear()
    eng.read_message = Engine.read_message.__get__(eng)
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="Bening"))
    store.remember_reading(
        understanding.fingerprint("apa pun", understanding.normalize(notice)),
        "apa pun", understanding.normalize(notice), notice,
        {"intent": "unknown", "automated": True, "reason": "di luar jam"},
        True, eng.now(),
    )
    store.log_message(JID, "out", "Selamat pagi, izin menindaklanjuti.", eng.now())
    got = eng.read_message(store.get(JID), notice, eng.now())
    assert got.automated and got.remembered
    assert calls == [], "a known autoresponder still cost a call"


def test_a_recalled_reading_says_so(counted):
    eng, _, store, _ = counted
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="Kymm"))
    eng.handle_inbound(JID, "Kymm", "baik kak")
    fresh = store.reading_stats()
    assert fresh == (1, 0)
    eng.handle_inbound(JID, "Kymm", "baik kak")
    assert store.reading_stats() == (1, 1), "the reuse was not counted"


def test_a_bad_case_can_be_unlearned(bot):
    """One wrong reading, remembered, repeats forever — so it must be
    removable without a deploy."""
    eng, _, store = bot
    store.remember_reading(
        "fp1", "ctx", "baik kak", "baik kak 😊",
        {"intent": "setuju", "reason": "salah baca"}, False, eng.now())
    assert store.learned_readings()[0]["intent"] == "setuju"
    assert store.forget_readings(store.learned_readings()[0]["id"]) == 1
    assert store.recall_reading("ctx", "baik kak", "fp1") is None


def test_forgetting_everything_starts_again(bot):
    eng, _, store = bot
    for i in range(3):
        store.remember_reading(f"fp{i}", "c", f"m{i}", f"m{i}", {}, False, eng.now())
    assert store.forget_readings(None) == 3
    assert store.reading_stats() == (0, 0)


# -- re-reading the history -------------------------------------------------


@pytest.mark.parametrize("fields,expected", [
    ({"phones": ["6285600000003"], "automated": True}, "referral"),
    ({"email": "a@b.co", "automated": True}, "kirim_email"),
    ({"automated": True}, "auto"),
    ({"politeness_only": True}, "basa_basi"),
    ({"ends_conversation": True}, "selesai"),
    ({"intent": Intent.TANYA_HARGA}, "tanya_harga"),
])
def test_the_label_a_reread_message_gets(fields, expected):
    """A canned message that hands over a number is still a referral — the
    engine decides it that way live, and the history must match."""
    from bd_bot.cli import _tag_for

    assert _tag_for(understanding.Reading(understood=True, **fields)) == expected
