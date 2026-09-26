"""Never ping-pong with a machine.

Brand numbers run WhatsApp autoresponders. The bot read the canned reply as a
real answer, answered it, and drew the same canned reply again. On 12 Aug 2026
that put 8 messages on one brand in 12 minutes and cost the account —
whatsmeow logged `Got device removed stream error` 14 seconds after the last
one.

Three nets, tested separately because they catch different things: the contact
repeating itself verbatim (the common case), us about to repeat ourselves
(independent of the inbound), and a plain count (the only one that survives an
autoresponder that stamps a ticket number into its text).
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bd_bot.config import Settings  # noqa: E402
from bd_bot.engine import Engine  # noqa: E402
from bd_bot.models import Conversation, Node  # noqa: E402
from bd_bot.storage import Store  # noqa: E402
from bd_bot.transport.mock import MockTransport  # noqa: E402

JID = "628119000002@s.whatsapp.net"          # Cimory, the number it happened to

#: The real thing, from the 12 Aug transcript.
CANNED = (
    "Hai Cimories, \nUntuk chat kakak akan kami lanjutkan sesuai jadwal "
    "operasional kami ya. Terima kasih sudah menghubungi Cimory."
)


@pytest.fixture
def bot(tmp_path):
    cfg = Settings()
    cfg.db_path = tmp_path / "loop.sqlite3"
    cfg.dry_run = False
    cfg.require_approval = False
    cfg.auto_reply = True
    cfg.min_seconds_between_sends = 0
    cfg.use_llm_replies = False
    cfg.demo_mode = False
    cfg.company_profile_pdf = tmp_path / "profile.pdf"
    cfg.company_profile_pdf.write_bytes(b"%PDF-1.4 fake")
    cfg.opening_dir = tmp_path / "opening"
    cfg.opening_dir.mkdir(exist_ok=True)
    (cfg.opening_dir / "deck.pdf").write_bytes(b"%PDF-1.4 fake deck")
    store = Store(cfg.db_path)
    transport = MockTransport(echo=False)
    eng = Engine(cfg, store, transport)
    eng.within_send_window = lambda when: True
    transport.start(eng.handle_inbound)
    yield eng, transport, cfg, store
    store.close()


def _open_conversation(store):
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Cimory",
                              brand="Cimory"))


# -- the incident -----------------------------------------------------------


def test_the_cimory_loop_is_broken(bot):
    """Replay of what actually happened: same canned text after every reply."""
    eng, transport, _, store = bot
    _open_conversation(store)

    eng.handle_inbound(JID, "Cimory", CANNED)      # 1st: looks like a reply
    first_round = len(transport.sent)

    for _ in range(6):
        eng.handle_inbound(JID, "Cimory", CANNED)  # and again, and again

    assert len(transport.sent) == first_round, (
        "the bot kept answering an autoresponder — this is the 12 Aug incident"
    )


def test_the_repeat_is_escalated_not_silently_dropped(bot):
    """A brand with an autoresponder is still a brand.

    Cimory's line is now caught by the content detector on the FIRST message
    rather than by the repeat check on the second, so the escalation reason is
    the autoresponder one either way — both carry the `auto-loop` tag, which is
    what the inbox groups on.
    """
    eng, _, _, store = bot
    _open_conversation(store)
    eng.handle_inbound(JID, "Cimory", CANNED)
    eng.handle_inbound(JID, "Cimory", CANNED)
    reasons = [r["reason"] for r in store.open_escalations()]
    assert any(Engine._LOOP_TAG in r for r in reasons), reasons


def test_what_they_said_is_still_recorded(bot):
    eng, _, _, store = bot
    _open_conversation(store)
    eng.handle_inbound(JID, "Cimory", CANNED)
    eng.handle_inbound(JID, "Cimory", CANNED)
    assert CANNED in store.recent_inbound_texts(JID)


def test_the_node_does_not_advance_on_a_loop(bot):
    """Left where a human will need to pick it up."""
    eng, _, _, store = bot
    _open_conversation(store)
    eng.handle_inbound(JID, "Cimory", CANNED)
    before = store.get(JID).node
    eng.handle_inbound(JID, "Cimory", CANNED)
    assert store.get(JID).node is before


# -- a real person is not caught -------------------------------------------


def test_a_person_asking_two_different_things_is_answered(bot):
    eng, transport, _, store = bot
    _open_conversation(store)
    eng.handle_inbound(JID, "Cika", "halo kak, ini dari brand apa ya?")
    after_first = len(transport.sent)
    eng.handle_inbound(JID, "Cika", "boleh minta detail paketnya?")
    assert len(transport.sent) > after_first


def test_a_short_repeated_ack_is_not_an_autoresponder(bot):
    """"ok kak" twice is a person being terse, not a machine."""
    eng, transport, _, store = bot
    _open_conversation(store)
    eng.handle_inbound(JID, "Cika", "ok kak")
    after_first = len(transport.sent)
    transport.sent.clear()
    eng.handle_inbound(JID, "Cika", "ok kak")
    assert eng._looping_with_a_machine(JID, "ok kak", eng.now()) == ""
    assert len(transport.sent) or after_first, "short repeat must still be handled"


def test_whitespace_and_case_do_not_hide_a_repeat(bot):
    eng, _, _, store = bot
    _open_conversation(store)
    eng.handle_inbound(JID, "Cimory", CANNED)
    noisy = "  " + CANNED.upper().replace("\n", "  ") + "  "
    assert eng._looping_with_a_machine(JID, noisy, eng.now()) != ""


# -- the counter, for autoresponders that vary their text -------------------


def test_a_varying_autoresponder_is_still_stopped(bot):
    """Ticket numbers defeat text matching. Nothing defeats counting."""
    eng, transport, cfg, store = bot
    _open_conversation(store)
    for i in range(cfg.loop_guard_max_replies + 4):
        eng.handle_inbound(
            JID, "Cimory",
            f"Terima kasih telah menghubungi kami. Tiket #{1000 + i} dibuat.",
        )
    assert len(transport.sent) <= cfg.loop_guard_max_replies, (
        f"sent {len(transport.sent)} messages; the cap is "
        f"{cfg.loop_guard_max_replies}"
    )


def test_the_counter_only_looks_at_its_window(bot):
    """Yesterday's conversation must not hold today's hostage."""
    eng, _, cfg, store = bot
    _open_conversation(store)
    old = eng.now() - timedelta(hours=8)
    for _ in range(cfg.loop_guard_max_replies + 2):
        store.log_message(JID, "out", "an old message", old)
    assert eng._looping_with_a_machine(JID, "halo kak", eng.now()) == ""


def test_the_counter_ignores_attachments_and_markers(bot):
    """Those have their own direction and are not conversation turns."""
    eng, _, cfg, store = bot
    _open_conversation(store)
    now = eng.now()
    for _ in range(cfg.loop_guard_max_replies + 2):
        store.log_message(JID, "file", "deck.pdf", now)
        store.log_message(JID, "demo", "⏩ *1 hari kemudian*", now)
    assert eng._looping_with_a_machine(JID, "halo kak", now) == ""


# -- never say the same thing twice ----------------------------------------


def test_the_same_message_does_not_go_out_twice(bot):
    eng, transport, _, store = bot
    _open_conversation(store)
    convo = store.get(JID)
    now = eng.now()
    assert eng._send(convo, "Boleh dibantu alamat email-nya?", now) is True
    transport.sent.clear()
    assert eng._send(convo, "Boleh dibantu alamat email-nya?", now) is False
    assert transport.sent == []


def test_a_refused_repeat_is_escalated(bot):
    eng, _, _, store = bot
    _open_conversation(store)
    convo = store.get(JID)
    now = eng.now()
    eng._send(convo, "Boleh dibantu alamat email-nya?", now)
    eng._send(convo, "Boleh dibantu alamat email-nya?", now)
    assert any("repeated our own" in r["reason"] for r in store.open_escalations())


def test_a_different_message_still_goes_out(bot):
    eng, transport, _, store = bot
    _open_conversation(store)
    convo = store.get(JID)
    now = eng.now()
    eng._send(convo, "Boleh dibantu alamat email-nya?", now)
    transport.sent.clear()
    assert eng._send(convo, "Baik kak, saya tunggu ya.", now) is True
    assert transport.sent != []


def test_repeating_much_later_is_allowed(bot):
    """A legitimate re-ask days on is not a machine looping."""
    eng, transport, cfg, store = bot
    _open_conversation(store)
    convo = store.get(JID)
    text = "Boleh dibantu alamat email-nya?"
    long_ago = eng.now() - timedelta(minutes=cfg.loop_guard_window_minutes + 5)
    store.log_message(JID, "out", text, long_ago)
    transport.sent.clear()
    assert eng._send(convo, text, eng.now()) is True


def test_the_first_message_to_a_contact_is_never_a_repeat(bot):
    eng, _, _, store = bot
    _open_conversation(store)
    assert eng._would_repeat_ourselves(JID, "halo", eng.now()) is False


# -- one escalation per episode --------------------------------------------


def test_a_loop_raises_one_escalation_not_one_per_message(bot):
    """The inbox this protects must not be buried by the protection."""
    eng, _, _, store = bot
    _open_conversation(store)
    for _ in range(8):
        eng.handle_inbound(JID, "Cimory", CANNED)
    loops = [r for r in store.open_escalations() if Engine._LOOP_TAG in r["reason"]]
    assert len(loops) == 1, f"{len(loops)} escalations for one loop"


def test_a_new_loop_after_the_first_is_resolved_escalates_again(bot):
    """Closing the item means the next episode has to be reported afresh."""
    eng, _, _, store = bot
    _open_conversation(store)
    eng.handle_inbound(JID, "Cimory", CANNED)
    eng.handle_inbound(JID, "Cimory", CANNED)
    for r in store.open_escalations():
        store.resolve_escalation(r["id"])
    eng.handle_inbound(JID, "Cimory", CANNED)
    loops = [r for r in store.open_escalations() if Engine._LOOP_TAG in r["reason"]]
    assert len(loops) == 1
