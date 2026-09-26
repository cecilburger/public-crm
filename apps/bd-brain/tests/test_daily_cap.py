"""What the daily cap counts, and what it must not.

The cap exists because messaging people who did not ask is what gets a number
banned. Answering someone who just wrote in is the safest message the bot
sends — so on 13 Aug 2026, when nineteen openings and eleven replies together
hit a cap of thirty, the campaign stopped at lunchtime *because brands had
engaged*. Exactly backwards.

Follow-up rungs still count: they go to people who never answered, which is
the same unsolicited volume an opening is.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta
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
    cfg.db_path = tmp_path / "cap.sqlite3"
    cfg.dry_run = False
    cfg.require_approval = False
    cfg.auto_reply = True
    cfg.min_seconds_between_sends = 0
    cfg.use_llm_replies = False
    cfg.demo_mode = False
    cfg.max_blasts_per_day = 3
    cfg.company_profile_pdf = tmp_path / "p.pdf"
    cfg.company_profile_pdf.write_bytes(b"%PDF-1.4")
    cfg.opening_dir = tmp_path / "opening"
    cfg.opening_dir.mkdir(exist_ok=True)
    (cfg.opening_dir / "d.pdf").write_bytes(b"%PDF-1.4")
    store = Store(cfg.db_path)
    transport = MockTransport(echo=False)
    eng = Engine(cfg, store, transport)
    eng.within_send_window = lambda when: True
    transport.start(eng.handle_inbound)
    yield eng, transport, cfg, store
    store.close()


# -- the counter -----------------------------------------------------------


def test_replies_are_not_counted(bot):
    eng, _, _, store = bot
    now = eng.now()
    for _ in range(9):
        store.log_message(JID, "out", "jawaban", now, "reply")
    assert store.proactive_sent_today(now) == 0
    assert store.sent_today(now) == 9, "sent_today still counts everything"


@pytest.mark.parametrize("context", ["blast", "campaign", "timer"])
def test_everything_the_bot_starts_is_counted(bot, context):
    """A follow-up goes to somebody who never answered — same risk as an
    opening, so it draws on the same budget."""
    eng, _, _, store = bot
    now = eng.now()
    store.log_message(JID, "out", "pembuka", now, context)
    assert store.proactive_sent_today(now) == 1


def test_unlabelled_rows_count_as_proactive(bot):
    """Rows written before sends were labelled. Under-counting a ban guard is
    the dangerous direction, so an unknown row is treated as proactive."""
    eng, _, _, store = bot
    now = eng.now()
    store.log_message(JID, "out", "lama", now)
    assert store.proactive_sent_today(now) == 1


def test_yesterday_does_not_count(bot):
    eng, _, _, store = bot
    now = eng.now()
    for _ in range(5):
        store.log_message(JID, "out", "kemarin", now - timedelta(days=1), "blast")
    assert store.proactive_sent_today(now) == 0


def test_attachments_and_markers_are_not_sends(bot):
    eng, _, _, store = bot
    now = eng.now()
    store.record_file(JID, "deck.pdf", now)
    store.log_message(JID, "demo", "⏩ *1 hari kemudian*", now)
    assert store.proactive_sent_today(now) == 0


# -- what it does to the bot ----------------------------------------------


def test_a_busy_conversation_does_not_close_the_campaign(bot):
    """The 13 Aug failure: brands replying used up the opening budget."""
    eng, transport, cfg, store = bot
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Cika"))
    for i in range(10):
        eng.handle_inbound(JID, "Cika", f"pertanyaan ke-{i} tentang paketnya?")
    assert store.proactive_sent_today(eng.now()) == 0, "replies ate the budget"

    fresh = "628999@s.whatsapp.net"
    store.upsert(Conversation(jid=fresh, node=Node.NEW, name="Rina"))
    transport.sent.clear()
    assert eng.blast(fresh, "Rina", "RinaCo") is True, (
        "a day of engaged brands blocked the next opening"
    )


def test_openings_still_stop_at_the_cap(bot):
    eng, _, cfg, store = bot
    for i in range(cfg.max_blasts_per_day):
        jid = f"62800000{i}@s.whatsapp.net"
        store.upsert(Conversation(jid=jid, node=Node.NEW))
        assert eng.blast(jid, "X", "X") is True
    over = "628999999@s.whatsapp.net"
    store.upsert(Conversation(jid=over, node=Node.NEW))
    assert eng.blast(over, "X", "X") is False, "the cap stopped protecting"


def test_replies_still_go_out_after_the_cap(bot):
    """A brand mid-conversation must not be abandoned because the day's
    outreach budget ran out."""
    eng, transport, cfg, store = bot
    for i in range(cfg.max_blasts_per_day):
        jid = f"62800000{i}@s.whatsapp.net"
        store.upsert(Conversation(jid=jid, node=Node.NEW))
        eng.blast(jid, "X", "X")
    assert store.proactive_sent_today(eng.now()) >= cfg.max_blasts_per_day

    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Cika"))
    transport.sent.clear()
    eng.handle_inbound(JID, "Cika", "boleh minta detail paketnya kak?")
    assert transport.sent != [], "a brand who wrote in was left unanswered"


def test_a_follow_up_is_refused_once_the_cap_is_hit(bot):
    """Follow-ups are unsolicited, so the cap must still hold them."""
    eng, transport, cfg, store = bot
    now = eng.now()
    for _ in range(cfg.max_blasts_per_day):
        store.log_message("628777@s.whatsapp.net", "out", "pembuka", now, "blast")
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Cika"))
    store.schedule(JID, Timer.COLD_FU2, now - timedelta(minutes=1))
    transport.sent.clear()
    eng.tick()
    assert transport.sent == [], "a follow-up slipped past the cap"
