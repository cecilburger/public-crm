"""The `/restart` tester command: wipe one conversation, replay the opening.

Pilot testers hunt for bad replies by walking a path, then starting the same
path over. These cover the two things that make that safe: only allowlisted
numbers can trigger it, and the reset leaves nothing of the old run behind.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bd_bot.config import Settings  # noqa: E402
from bd_bot.engine import Engine  # noqa: E402
from bd_bot.models import Node, Timer  # noqa: E402
from bd_bot.storage import Store  # noqa: E402
from bd_bot.transport.mock import MockTransport  # noqa: E402

TESTER = "628123@s.whatsapp.net"
BRAND = "628999@s.whatsapp.net"


@pytest.fixture
def engine(tmp_path):
    cfg = Settings()
    cfg.db_path = tmp_path / "t.sqlite3"
    cfg.dry_run = False
    cfg.require_approval = False
    cfg.auto_reply = True
    cfg.min_seconds_between_sends = 0
    cfg.company_profile_pdf = tmp_path / "profile.pdf"
    cfg.company_profile_pdf.write_bytes(b"%PDF-1.4 fake")
    cfg.opening_dir = tmp_path / "opening"
    cfg.opening_dir.mkdir()
    (cfg.opening_dir / "deck.pdf").write_bytes(b"%PDF-1.4 fake deck")
    cfg.restart_jids = frozenset({TESTER})
    store = Store(cfg.db_path)
    transport = MockTransport(echo=False)
    eng = Engine(cfg, store, transport)
    transport.start(eng.handle_inbound)
    yield eng, transport, cfg, store
    store.close()


def test_restart_replays_the_opening(engine):
    eng, transport, _, store = engine
    eng.blast(TESTER, name="Cika", brand="Brand X")
    opening = [t for _, t in transport.sent]
    transport.sent.clear()

    transport.feed(TESTER, "/restart", name="Cika")

    assert [t for _, t in transport.sent] == opening, "same greeting, from the top"
    assert store.get(TESTER).node is Node.BLASTED


def test_restart_clears_state_timers_and_history(engine):
    """A stale run must not bleed into the new one — that reads as a bot flaw."""
    eng, transport, _, store = engine
    eng.blast(TESTER, name="Cika", brand="Brand X")
    transport.feed(TESTER, "harganya berapa?", name="Cika")
    assert store.get(TESTER).price_stage > 0
    assert store.pending(TESTER), "the walked path armed timers"

    transport.feed(TESTER, "/restart", name="Cika")

    convo = store.get(TESTER)
    assert convo.price_stage == 0
    assert convo.gadget_loops == 0
    assert convo.unknown_streak == 0
    assert "harganya berapa?" not in store.recent_inbound_texts(TESTER)
    assert [j.timer for j in store.pending(TESTER)] == [Timer.COLD_FU1], (
        "only the fresh cold ladder, none of the old run's timers"
    )


def test_restart_keeps_the_contact_identity(engine):
    """The replayed opening is still personalised — testers shouldn't have to
    re-introduce themselves every round."""
    eng, transport, _, store = engine
    eng.blast(TESTER, name="Cika", brand="Brand X")
    transport.sent.clear()

    transport.feed(TESTER, "/restart")

    convo = store.get(TESTER)
    assert convo.brand == "Brand X"
    assert any("Brand X" in t for _, t in transport.sent)


def test_restart_works_from_a_terminal_node(engine):
    """The main reason to restart: you drove the flow to STOP and want another go."""
    eng, transport, _, store = engine
    eng.blast(TESTER, name="Cika", brand="Brand X")
    transport.feed(TESTER, "maaf belum tertarik", name="Cika")
    transport.sent.clear()

    transport.feed(TESTER, "/restart", name="Cika")

    assert store.get(TESTER).node is Node.BLASTED
    assert transport.sent, "a stopped conversation still restarts"


def test_restart_from_a_non_tester_is_an_ordinary_message(engine):
    """A real brand typing /restart must never trigger a re-blast."""
    eng, transport, _, store = engine
    eng.blast(BRAND, name="Nana", brand="Brand Y")
    transport.feed(BRAND, "harganya berapa?", name="Nana")
    opening = eng.preview_blast(store.get(BRAND))
    transport.sent.clear()

    transport.feed(BRAND, "/restart", name="Nana")

    assert store.get(BRAND).price_stage > 0, "state survived; nothing was reset"
    assert "/restart" in store.recent_inbound_texts(BRAND), "handled, not swallowed"
    assert opening not in [t for _, t in transport.sent], "the opening was not replayed"


def test_restart_is_off_by_default(engine):
    """Empty RESTART_JIDS disables the command everywhere."""
    eng, transport, cfg, store = engine
    cfg.restart_jids = frozenset()
    eng.blast(TESTER, name="Cika", brand="Brand X")
    transport.feed(TESTER, "harganya berapa?", name="Cika")
    transport.sent.clear()

    transport.feed(TESTER, "/restart", name="Cika")

    assert store.get(TESTER).price_stage > 0, "state survived; nothing was reset"


@pytest.mark.parametrize("text", ["/restart", "  /restart", "/RESTART", "!restart", "/restart ya kak"])
def test_restart_spellings(engine, text):
    eng, transport, _, store = engine
    eng.blast(TESTER, name="Cika", brand="Brand X")
    transport.feed(TESTER, "harganya berapa?", name="Cika")

    transport.feed(TESTER, text, name="Cika")

    assert store.get(TESTER).price_stage == 0, f"{text!r} should restart"


def test_restart_is_not_triggered_by_ordinary_words(engine):
    """'restart' inside a sentence is a brand talking, not a command."""
    eng, transport, _, store = engine
    eng.blast(TESTER, name="Cika", brand="Brand X")
    transport.feed(TESTER, "harganya berapa?", name="Cika")

    transport.feed(TESTER, "campaignnya bisa restart bulan depan?", name="Cika")

    assert store.get(TESTER).price_stage > 0, "not a command; state must survive"


# --- a message the previous process died holding ----------------------------


def test_a_message_left_unanswered_by_a_crash_is_reported(engine):
    """Pending timers resume from SQLite; a half-handled message does not.

    A pilot tester sent "lewat chat dulu aja ka, detail paket nya" eleven
    seconds before a restart. The inbound was logged, the process died before
    the reply went out, and nothing retried it — two minutes of silence, from
    the tester's side, for no reason they could see."""
    from datetime import timedelta

    eng, transport, cfg, store = engine
    eng.blast(TESTER, name="Cika", brand="B")
    now = eng.now()
    store.log_message(TESTER, "in", "lewat chat dulu aja ka", now, "minta_chat")

    dropped = store.unanswered_inbound(now - timedelta(hours=6))
    assert [(j, b) for j, b, _ in dropped] == [(TESTER, "lewat chat dulu aja ka")]


def test_an_answered_message_is_not_reported(engine):
    """The outbound that follows it is the whole signal — without this the
    warning would fire on every healthy conversation at every startup."""
    from datetime import timedelta

    eng, transport, cfg, store = engine
    eng.blast(TESTER, name="Cika", brand="B")
    now = eng.now()
    store.log_message(TESTER, "in", "harganya berapa?", now, "tanya_harga")
    store.log_message(TESTER, "out", "Mulai dari Rp25 juta", now + timedelta(seconds=1))

    assert store.unanswered_inbound(now - timedelta(hours=6)) == []


def test_an_old_unanswered_message_is_left_alone(engine):
    """The window keeps a restart from resurfacing every stale conversation in
    the database — only what the previous run could plausibly have dropped."""
    from datetime import timedelta

    eng, transport, cfg, store = engine
    eng.blast(TESTER, name="Cika", brand="B")
    now = eng.now()
    store.log_message(TESTER, "in", "kemarin dulu", now - timedelta(days=3), "unknown")

    assert store.unanswered_inbound(now - timedelta(hours=6)) == []


@pytest.mark.parametrize("text", ['"/restart"', "'/restart'", " /restart ", "/restart"])
def test_the_restart_command_survives_being_quoted(text):
    """A tester typed `"/restart"` with the quote marks during the pilot. It
    missed, fell through to unknown, and their attempt to reset the
    conversation was answered by escalating them to a human."""
    assert Engine._RESTART_CMD.match(text)


@pytest.mark.parametrize("text", ["restart dong", "bisa restart campaign?", "kapan restart"])
def test_ordinary_talk_about_restarting_is_not_a_command(text):
    assert not Engine._RESTART_CMD.match(text)
