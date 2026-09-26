"""Operator Stop/Run: what a halt has to hold on to.

The button is easy; the semantics are not. Stop cannot mean "kill the
process" — pm2 restarts this within seconds — so it is a flag, and a flag is
only honest if nothing quietly drains away behind it. Three things have to
survive a stop and still be there on run: the pending timer queue, whatever
the brand said while we were quiet, and the WhatsApp session itself.
"""

from __future__ import annotations

import sys
from datetime import timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bd_bot.config import Settings  # noqa: E402
from bd_bot.engine import Engine  # noqa: E402
from bd_bot.models import Conversation, Node, Timer  # noqa: E402
from bd_bot.storage import Store  # noqa: E402
from bd_bot.transport.mock import MockTransport  # noqa: E402

JID = "628123@s.whatsapp.net"


@pytest.fixture
def bot(tmp_path):
    cfg = Settings()
    cfg.db_path = tmp_path / "pause.sqlite3"
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
    # Hold the sending window open. Nothing here is about business hours, and
    # without this the suite passes or fails on what time of day it is run —
    # a timer test written at noon started failing at 19:01.
    eng.within_send_window = lambda when: True
    transport.start(eng.handle_inbound)
    yield eng, transport, cfg, store
    store.close()


# -- the flag ---------------------------------------------------------------


def test_a_fresh_engine_is_running(bot):
    eng, _, _, _ = bot
    assert eng.paused is False and eng.pause_reason == ""


def test_pause_records_who_asked(bot):
    eng, _, _, _ = bot
    eng.pause("dashboard")
    assert eng.paused is True and eng.pause_reason == "dashboard"


def test_resume_clears_the_reason(bot):
    eng, _, _, _ = bot
    eng.pause("dashboard")
    eng.resume()
    assert eng.paused is False and eng.pause_reason == ""


def test_stop_and_run_are_idempotent(bot):
    """A double-clicked button must not need a second click to undo."""
    eng, _, _, _ = bot
    eng.pause("dashboard")
    eng.pause("dashboard")
    eng.resume()
    assert eng.paused is False
    eng.resume()
    assert eng.paused is False


def test_a_ban_pauses_with_its_own_reason(bot):
    """ROADMAP 3.2. The operator must be able to tell this apart from a Stop
    they clicked themselves."""
    eng, _, _, _ = bot
    eng.handle_transport_event("banned", "spam report")
    assert eng.paused is True
    assert "banned" in eng.pause_reason


# -- outbound ---------------------------------------------------------------


def test_a_stopped_bot_sends_nothing(bot):
    eng, transport, _, store = bot
    store.upsert(Conversation(jid=JID, node=Node.NEW, name="Cika"))
    eng.pause("dashboard")
    transport.sent.clear()
    assert eng.blast(JID, "Cika", "BrandCo") is False
    assert transport.sent == []


def test_run_lets_sends_through_again(bot):
    eng, transport, _, store = bot
    store.upsert(Conversation(jid=JID, node=Node.NEW, name="Cika"))
    eng.pause("dashboard")
    eng.blast(JID, "Cika", "BrandCo")
    eng.resume()
    transport.sent.clear()
    assert eng.blast(JID, "Cika", "BrandCo") is True
    assert transport.sent != []


# -- the timer queue --------------------------------------------------------


def test_a_stopped_tick_fires_nothing(bot):
    eng, transport, _, store = bot
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Cika"))
    store.schedule(JID, Timer.COLD_FU2, eng.now() - timedelta(minutes=1))
    eng.pause("dashboard")
    transport.sent.clear()
    assert eng.tick() == 0
    assert transport.sent == []


def test_the_ladder_is_held_not_burned(bot):
    """The bug this guards: draining a due queue into a muted `_send` marks
    every job fired and walks the conversation past a follow-up the brand
    never received. A stop over lunch would silently eat the whole ladder."""
    eng, _, _, store = bot
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Cika"))
    store.schedule(JID, Timer.COLD_FU2, eng.now() - timedelta(minutes=1))
    eng.pause("dashboard")
    eng.tick()
    assert len(store.pending(JID)) == 1, "the follow-up was consumed while stopped"


def test_the_held_timer_fires_on_run(bot):
    eng, transport, _, store = bot
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Cika"))
    store.schedule(JID, Timer.COLD_FU2, eng.now() - timedelta(minutes=1))
    eng.pause("dashboard")
    eng.tick()
    eng.resume()
    transport.sent.clear()
    assert eng.tick() == 1
    assert transport.sent != []


# -- inbound ----------------------------------------------------------------


def test_a_stopped_bot_does_not_reply(bot):
    eng, transport, _, store = bot
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Cika"))
    eng.pause("dashboard")
    transport.sent.clear()
    eng.handle_inbound(JID, "Cika", "berapa harganya kak?")
    assert transport.sent == []


def test_what_they_said_while_stopped_is_kept(bot):
    """Losing it is the one thing a pause must not do."""
    eng, _, _, store = bot
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Cika"))
    eng.pause("dashboard")
    eng.handle_inbound(JID, "Cika", "berapa harganya kak?")
    assert "berapa harganya kak?" in store.recent_inbound_texts(JID)


def test_an_unanswered_message_is_put_in_front_of_a_human(bot):
    """`unanswered_inbound` is what cmd_run prints at the next start, so a
    question asked during a stop is chased by hand rather than lost."""
    eng, _, _, store = bot
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Cika"))
    eng.pause("dashboard")
    eng.handle_inbound(JID, "Cika", "berapa harganya kak?")
    dropped = store.unanswered_inbound(eng.now() - timedelta(hours=6))
    assert [jid for jid, _, _ in dropped] == [JID]


def test_the_node_does_not_move_while_stopped(bot):
    """If the flow advanced, resuming would answer the next question and
    never the one they actually asked."""
    eng, _, _, store = bot
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Cika"))
    eng.pause("dashboard")
    eng.handle_inbound(JID, "Cika", "boleh kak, kita meeting aja")
    assert store.get(JID).node is Node.BLASTED


def test_restart_is_ignored_while_stopped(bot):
    """A tester typing /restart must not re-blast a bot the operator stopped."""
    eng, transport, cfg, store = bot
    cfg.restart_jids = {JID}
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Cika"))
    eng.pause("dashboard")
    transport.sent.clear()
    eng.handle_inbound(JID, "Cika", "/restart")
    assert transport.sent == []


def test_a_new_contact_who_writes_during_a_stop_is_not_lost(bot):
    """No conversation row exists yet — the paused branch has to make one."""
    eng, _, _, store = bot
    eng.pause("dashboard")
    eng.handle_inbound("628999@s.whatsapp.net", "Rina", "halo, ini apa ya?")
    assert store.get("628999@s.whatsapp.net") is not None
    assert store.get("628999@s.whatsapp.net").name == "Rina"


def test_the_conversation_carries_on_after_run(bot):
    eng, transport, _, store = bot
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Cika"))
    eng.pause("dashboard")
    eng.handle_inbound(JID, "Cika", "berapa harganya kak?")
    eng.resume()
    transport.sent.clear()
    eng.handle_inbound(JID, "Cika", "berapa harganya kak?")
    assert transport.sent != [], "the bot stayed mute after being told to run"


# -- the wait-for-connect gate ---------------------------------------------
# The session lives on disk, so the bot reconnects by itself after any restart.
# "Connected" therefore proves nothing about whether a person meant it to send.


def test_the_gate_holds_outbound(bot):
    eng, transport, _, store = bot
    store.upsert(Conversation(jid=JID, node=Node.NEW, name="Cika"))
    eng.pause(Engine.WAITING_FOR_CONNECT)
    transport.sent.clear()
    assert eng.blast(JID, "Cika", "BrandCo") is False
    assert transport.sent == []


def test_connect_releases_the_gate(bot):
    eng, transport, _, store = bot
    store.upsert(Conversation(jid=JID, node=Node.NEW, name="Cika"))
    eng.pause(Engine.WAITING_FOR_CONNECT)
    assert eng.release_connect_gate() is True
    assert eng.paused is False
    transport.sent.clear()
    assert eng.blast(JID, "Cika", "BrandCo") is True


def test_connect_does_not_clear_a_logout_halt(bot):
    """The one control that stops a flagged account must not be cleared by the
    very click an operator makes while investigating it."""
    eng, _, _, _ = bot
    eng.handle_transport_event("logged_out", "device removed")
    assert eng.release_connect_gate() is False
    assert eng.paused is True


def test_connect_does_not_clear_an_operator_stop(bot):
    eng, _, _, _ = bot
    eng.pause("dashboard")
    assert eng.release_connect_gate() is False
    assert eng.paused is True


def test_releasing_a_running_bot_is_a_no_op(bot):
    eng, _, _, _ = bot
    assert eng.release_connect_gate() is False
    assert eng.paused is False


def test_the_ladder_survives_the_gate(bot):
    """A restart must not burn queued follow-ups while it waits to be let go."""
    eng, _, _, store = bot
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Cika"))
    store.schedule(JID, Timer.COLD_FU2, eng.now() - timedelta(minutes=1))
    eng.pause(Engine.WAITING_FOR_CONNECT)
    eng.tick()
    assert len(store.pending(JID)) == 1
    eng.release_connect_gate()
    assert eng.tick() == 1
