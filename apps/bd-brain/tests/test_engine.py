"""Engine tests — guardrails and side effects."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bd_bot.config import Settings  # noqa: E402
from bd_bot.engine import Engine, _requested_hours  # noqa: E402
from bd_bot.storage import Store  # noqa: E402
from bd_bot.transport.mock import MockTransport  # noqa: E402


@pytest.fixture
def engine(tmp_path):
    cfg = Settings()
    cfg.db_path = tmp_path / "t.sqlite3"
    cfg.dry_run = False
    cfg.require_approval = False
    cfg.auto_reply = True
    cfg.min_seconds_between_sends = 0  # don't make the suite sleep
    cfg.company_profile_pdf = tmp_path / "profile.pdf"
    cfg.company_profile_pdf.write_bytes(b"%PDF-1.4 fake")
    cfg.opening_dir = tmp_path / "opening"
    cfg.opening_dir.mkdir()
    (cfg.opening_dir / "deck.pdf").write_bytes(b"%PDF-1.4 fake deck")
    (cfg.opening_dir / "greeting.jpeg").write_bytes(b"\xff\xd8fake")
    store = Store(cfg.db_path)
    transport = MockTransport(echo=False)
    eng = Engine(cfg, store, transport)
    transport.start(eng.handle_inbound)
    yield eng, transport, cfg, store
    store.close()


JID = "628123@s.whatsapp.net"


def _qna_convo(store, jid=JID, **kwargs):
    """Seed a mid-conversation contact — Node.NEW now routes first messages
    to the inbound qualification form (ROADMAP 2.1)."""
    from bd_bot.models import Conversation, Node

    convo = Conversation(jid=jid, node=Node.QNA, **kwargs)
    store.upsert(convo)
    return convo


def test_reply_sends_without_approval(engine):
    eng, transport, cfg, _ = engine
    cfg.require_approval = True  # blasts gated...
    cfg.auto_reply = True  # ...but replies are not
    transport.feed(JID, "harganya berapa?")
    assert len(transport.sent) == 1


def test_templates_never_mention_the_contact_name(engine):
    """Everyone is 'Kak' — a wrong or misspelled name reads worse than none."""
    eng, transport, cfg, _ = engine
    eng.blast(JID, name="Cika", brand="Brand X")
    transport.feed(JID, "harganya berapa?", name="Cika")
    for _, text in transport.sent:
        assert "Cika" not in text, text
    assert any("Kak" in t for _, t in transport.sent)
    assert any("Brand X" in t for _, t in transport.sent), "brand may be named"


def test_blast_ships_the_opening_folder(engine):
    """The greeting sends the pic first, then the deck — everything in opening/."""
    eng, transport, cfg, _ = engine
    eng.blast(JID, name="Cika", brand="B")
    kinds = [msg for _, msg in transport.sent]
    assert len(kinds) == 3, kinds
    assert kinds[1] == "[image: greeting.jpeg]"
    assert kinds[2] == "[document: deck.pdf]"


def test_rejection_falls_back_to_the_opening_deck(engine):
    """No assets/company-profile.pdf? Rejections still leave the deck behind."""
    eng, transport, cfg, _ = engine
    cfg.company_profile_pdf.unlink()
    transport.feed(JID, "maaf belum tertarik kak")
    assert ("[document: deck.pdf]" in {m for _, m in transport.sent})


def test_declined_send_does_not_leak_the_pdf(engine, monkeypatch):
    """A blocked text must not be followed by its attachment."""
    eng, transport, cfg, _ = engine
    cfg.require_approval = True
    monkeypatch.setattr(Engine, "_approved", lambda self, jid, text: False)

    eng.blast(JID, name="Cika", brand="B")
    assert transport.sent == [], "nothing should have been sent"


def test_daily_cap_blocks_further_outreach(engine):
    """The cap governs what the bot STARTS.

    It used to block replies too, which meant a day of brands actually
    engaging would shut the campaign down — the budget was spent answering
    people rather than reaching new ones. Replies are the safest message the
    bot sends, so they neither count against the cap nor are stopped by it.
    """
    from bd_bot.models import Conversation, Node

    eng, transport, cfg, store = engine
    cfg.max_blasts_per_day = 1
    eng.blast(JID, name="Cika", brand="B")

    # A brand mid-conversation is still answered.
    before = len(transport.sent)
    transport.feed(JID, "harganya berapa?")
    assert len(transport.sent) > before, "the cap left a brand unanswered"

    # But no new brand is opened.
    other = "628999000@s.whatsapp.net"
    store.upsert(Conversation(jid=other, node=Node.NEW))
    assert eng.blast(other, name="Rina", brand="R") is False


def test_inbound_cancels_pending_timers(engine):
    eng, transport, cfg, store = engine
    eng.blast(JID, name="Cika", brand="B")
    assert store.pending(JID), "blast should arm the cold ladder"
    transport.feed(JID, "boleh kak")
    pending = [j.timer.value for j in store.pending(JID)]
    assert "cold_fu1" not in pending, "reply must cancel the cold ladder"


def test_unknown_reply_is_escalated(engine):
    eng, transport, cfg, store = engine
    _qna_convo(store)
    transport.feed(JID, "zxcvbnm qwerty")
    assert store.open_escalations(), "unclassified reply should raise an escalation"


def test_first_message_from_stranger_gets_the_form(engine):
    """ROADMAP 2.1 — an ad lead's first message runs the qualification SOP."""
    eng, transport, cfg, store = engine
    transport.feed(JID, "halo, saya tertarik dengan penawarannya")
    assert len(transport.sent) == 1
    assert "Nama Brand" in transport.sent[0][1]
    assert not store.open_escalations(), "an expected opener is not an anomaly"


def test_send_window_rejects_night_and_weekend():
    from datetime import datetime

    cfg = Settings()
    eng = Engine.__new__(Engine)
    eng.cfg = cfg
    assert eng.within_send_window(datetime(2026, 7, 21, 10, 0))  # Tue 10:00
    assert not eng.within_send_window(datetime(2026, 7, 21, 3, 0))  # Tue 03:00
    assert not eng.within_send_window(datetime(2026, 7, 25, 10, 0))  # Sat


def test_personalise_swaps_brand_before_name():
    """'Cika Beauty' contains 'Cika' — brand must be replaced first or the
    name pass corrupts it."""
    from bd_bot.engine import _personalise

    out = _personalise(
        "Halo Kak Cika, paket untuk Cika Beauty siap ya Kak Cika.",
        old_name="Cika",
        old_brand="Cika Beauty",
        new_name="Budi",
        new_brand="Toko Budi",
    )
    assert out == "Halo Kak Budi, paket untuk Toko Budi siap ya Kak Budi."


def test_llm_mode_sends_one_meeting_ask_not_two(engine, monkeypatch):
    """FLOWCHART §3.1 gadget: a generated tanya_sistem reply already ends with
    the meeting ask — the separate OFFER_MEETING must be suppressed."""
    from bd_bot import responder

    eng, transport, cfg, _ = engine
    cfg.use_llm_replies = True
    cfg.anthropic_api_key = "sk-fake"
    monkeypatch.setattr(
        responder,
        "generate",
        lambda key, intent, convo, inbound, fallback, cfg: (
            f"[{key}] jawaban plus ajakan meeting 20-30 menit, jam 09.00?"
        ),
    )
    transport.feed(JID, "sistemnya gimana ya?")
    keys = [t for _, t in transport.sent]
    assert len(keys) == 1, f"expected one message, got: {keys}"
    assert "OFFER_MEETING" not in keys[0]


def test_requested_hours_parses_replies():
    assert 13 in _requested_hours("boleh jam 13 aja ka", 9)
    assert 13 in _requested_hours("13.00 ya", 9)
    assert _requested_hours("terserah kak", 9) == set()
    assert 14 in _requested_hours("besok siang jam 2 ya", 9)  # 2 siang = 14:00
    assert 17 in _requested_hours("jam 5 sore", 9)


def test_requested_day_parses_replies():
    from datetime import datetime
    from zoneinfo import ZoneInfo

    from bd_bot.engine import _requested_day

    tz = ZoneInfo("Asia/Jakarta")
    now = datetime(2026, 7, 22, 10, 0, tzinfo=tz)  # Wednesday 22 Jul

    assert _requested_day("besok jam 10", now) == now.date().replace(day=23)
    assert _requested_day("hari ini aja", now) == now.date()
    assert _requested_day("lusa ya kak", now) == now.date().replace(day=24)
    assert _requested_day("jumat jam 2 siang", now) == now.date().replace(day=24)
    assert _requested_day("hari senin ya", now) == now.date().replace(day=27)
    assert _requested_day("tanggal 28 bisa?", now) == now.date().replace(day=28)
    assert _requested_day("28/7 jam 10", now) == now.date().replace(day=28)
    assert _requested_day("minggu depan aja", now) is None  # week, not Sunday
    assert _requested_day("boleh kak", now) is None


def _scheduling_convo(store, jid, email="cika@brand.co"):
    from bd_bot.models import Conversation, Node, Outcome

    convo = Conversation(jid=jid, brand="Brand X", email=email)
    convo.node = Node.SCHEDULING
    convo.outcome = Outcome.ACCEPTANCE
    store.upsert(convo)
    return convo


def test_busy_requested_hour_offers_alternatives_not_a_silent_swap(
    engine, monkeypatch
):
    """'jam 13' when 13:00 is busy must NOT book some other hour — it must
    say the slot is taken and list what is actually free."""
    from datetime import datetime, timedelta

    from bd_bot import gcal

    eng, transport, cfg, store = engine
    _scheduling_convo(store, JID)
    free = [datetime(2026, 7, 23, h, 0, tzinfo=cfg.tz) for h in (9, 10, 15)]
    monkeypatch.setattr(gcal, "free_slots", lambda cfg_, now, limit=12: free)
    booked = []
    monkeypatch.setattr(gcal, "book", lambda *a, **k: booked.append(1))

    transport.feed(JID, "boleh jam 13 aja ya kak")

    assert not booked, "must not book a different hour silently"
    text = transport.sent[-1][1]
    assert "13.00" in text and "terisi" in text
    assert "15.00" in text, "free alternatives must be listed"


def test_free_requested_hour_books_with_invite(engine, monkeypatch):
    from datetime import datetime, timedelta

    from bd_bot import gcal

    eng, transport, cfg, store = engine
    _scheduling_convo(store, JID)
    free = [datetime(2026, 7, 23, h, 0, tzinfo=cfg.tz) for h in (9, 15)]
    monkeypatch.setattr(gcal, "free_slots", lambda cfg_, now, limit=12: free)
    captured = {}

    def fake_book(cfg_, start, summary, description="", attendee_email=""):
        captured["start"] = start
        captured["email"] = attendee_email
        return gcal.Booking(
            start=start,
            end=start + timedelta(minutes=60),
            meet_link="https://meet.google.com/x",
            event_id="e",
        )

    monkeypatch.setattr(gcal, "book", fake_book)
    transport.feed(JID, "jam 3 sore ya")

    assert captured["start"].hour == 15
    assert captured["email"] == "cika@brand.co", "invite goes to the brand's email"


def test_named_day_books_that_day_not_the_earliest(engine, monkeypatch):
    """'jumat jam 10' books Friday 10:00 even when Thursday 10:00 is free."""
    from datetime import timedelta

    from bd_bot import gcal

    eng, transport, cfg, store = engine
    _scheduling_convo(store, JID)
    # Relative to today: "jumat" always means the *next* Friday, so pinning
    # these to literal dates only passed during the week they were written.
    now = eng.now()
    fri = (now + timedelta(days=(4 - now.weekday()) % 7)).replace(
        hour=10, minute=0, second=0, microsecond=0
    )
    thu = fri - timedelta(days=1)
    monkeypatch.setattr(gcal, "free_slots", lambda cfg_, now, limit=12: [thu, fri])
    captured = {}

    def fake_book(cfg_, start, summary, description="", attendee_email=""):
        captured["start"] = start
        return gcal.Booking(
            start=start, end=start + timedelta(minutes=60),
            meet_link="https://meet.google.com/x", event_id="e",
        )

    monkeypatch.setattr(gcal, "book", fake_book)
    transport.feed(JID, "jumat jam 10 ya kak")
    assert captured["start"] == fri


def test_newest_hour_overrides_earlier_request(engine, monkeypatch):
    """'jam 13' rejected, brand says 'jam 15 aja' -> book 15:00, and the old
    13 must not linger in the request."""
    from datetime import datetime, timedelta

    from bd_bot import gcal

    eng, transport, cfg, store = engine
    _scheduling_convo(store, JID)
    free = [
        datetime(2026, 7, 23, h, 0, tzinfo=cfg.tz) for h in (9, 13, 15)
    ]
    monkeypatch.setattr(gcal, "free_slots", lambda cfg_, now, limit=12: free)
    captured = {}

    def fake_book(cfg_, start, summary, description="", attendee_email=""):
        captured["start"] = start
        return gcal.Booking(
            start=start, end=start + timedelta(minutes=60),
            meet_link="https://meet.google.com/x", event_id="e",
        )

    monkeypatch.setattr(gcal, "book", fake_book)
    store.log_message(JID, "in", "jam 13 ya", eng.now())  # older turn
    transport.feed(JID, "eh jam 15 aja deh")
    assert captured["start"].hour == 15, "newest mention must win"


def test_full_day_offers_other_days(engine, monkeypatch):
    """Requested day entirely busy -> say so, list other days' slots."""
    from datetime import datetime

    from bd_bot import gcal

    eng, transport, cfg, store = engine
    _scheduling_convo(store, JID)
    thu = datetime(2026, 7, 23, 10, 0, tzinfo=cfg.tz)  # only Thursday free
    monkeypatch.setattr(gcal, "free_slots", lambda cfg_, now, limit=12: [thu])
    booked = []
    monkeypatch.setattr(gcal, "book", lambda *a, **k: booked.append(1))

    transport.feed(JID, "jumat ya kak")  # Friday: nothing free
    assert not booked
    text = transport.sent[-1][1]
    assert "terisi" in text and "Kamis" in text


def test_calendar_failure_books_nothing(engine, monkeypatch):
    """If availability can't be verified, fail closed and escalate."""
    from bd_bot import gcal

    eng, transport, cfg, store = engine
    _scheduling_convo(store, JID)

    def boom(cfg_, now, limit=12):
        raise gcal.CalendarError("no oauth")

    monkeypatch.setattr(gcal, "free_slots", boom)
    booked = []
    monkeypatch.setattr(gcal, "book", lambda *a, **k: booked.append(1))

    transport.feed(JID, "jam 10 ya kak")
    assert not booked
    reasons = [r["reason"] for r in store.open_escalations()]
    assert any("availability" in x for x in reasons)


def test_no_hour_named_shows_open_slots(engine, monkeypatch):
    from datetime import datetime

    from bd_bot import gcal

    eng, transport, cfg, store = engine
    _scheduling_convo(store, JID)
    free = [datetime(2026, 7, 23, h, 0, tzinfo=cfg.tz) for h in (9, 10)]
    monkeypatch.setattr(gcal, "free_slots", lambda cfg_, now, limit=12: free)

    transport.feed(JID, "oke silakan diatur")
    text = transport.sent[-1][1]
    assert "09.00" in text and "10.00" in text


def test_candidate_slots_are_hourly_and_respect_the_window():
    from datetime import datetime
    from zoneinfo import ZoneInfo

    from bd_bot import gcal

    cfg = Settings()
    tz = ZoneInfo("Asia/Jakarta")
    now = datetime(2026, 7, 22, 10, 0, tzinfo=tz)  # Wednesday 10:00
    slots = gcal.candidate_slots(cfg, now)

    same_day = [s for s in slots if s.date() == now.date()]
    assert same_day, "same-day booking must be possible"
    assert min(s.hour for s in same_day) >= 12, "2h lead time"
    hours = {s.hour for s in slots}
    assert min(hours) >= 9 and max(hours) <= 18, "09:00–19:00 window"
    weekdays = {s.weekday() for s in slots}
    assert 5 in weekdays, "Saturday (25 Jul) must be offered — Senin–Sabtu"
    assert 6 not in weekdays, "Sunday excluded"


def test_generated_replies_are_cached_and_repersonalised(engine, monkeypatch):
    """Second contact asking the same thing must reuse the cached reply —
    no API call — with the first contact's name/brand swapped for theirs."""
    from bd_bot import responder

    eng, transport, cfg, store = engine
    cfg.use_llm_replies = True
    cfg.anthropic_api_key = "sk-fake"
    cfg.reply_cache_variants = 1

    calls = []

    def fake_generate(key, intent, convo, inbound, fallback, cfg):
        calls.append(key)
        return f"Halo Kak {convo.name}, paket {convo.brand} Rp10 juta ya."

    monkeypatch.setattr(responder, "generate", fake_generate)

    jid2 = "628999@s.whatsapp.net"
    _qna_convo(store)
    _qna_convo(store, jid=jid2)
    transport.feed(JID, "harganya berapa?", name="Cika")
    transport.feed(jid2, "harganya berapa?", name="Budi")

    texts = [t for _, t in transport.sent if "Rp10 juta" in t]
    assert len(texts) == 2
    assert calls == ["REPLY_TANYA_HARGA"], "second send must not re-generate"
    assert "Budi" in texts[1] and "Cika" not in texts[1], "must be re-personalised"


def test_stale_cached_replies_are_evicted_on_read(engine, monkeypatch):
    """A correction to the knowledge base must reach the wire.

    Variants are validated when generated, so one saved before a fact changed
    would keep going out unchecked. Live on 29 Jul 2026 the cache held a
    REPLY_TANYA_HARGA quoting "Rp25 juta per bulan" — the fee is per campaign.
    """
    from bd_bot import responder

    eng, transport, cfg, store = engine
    cfg.use_llm_replies = True
    cfg.anthropic_api_key = "sk-fake"
    cfg.reply_cache_variants = 1

    store.cache_reply(
        "REPLY_TANYA_HARGA",
        "Baik, Kak. Paket kami mulai dari Rp25 juta per bulan ya Kak.",
        "Cika",
        "Brand Lama",
        eng.now(),
    )

    calls = []

    def fake_generate(key, intent, convo, inbound, fallback, cfg):
        calls.append(key)
        return f"Baik Kak {convo.name}, paket {convo.brand} mulai dari Rp25 juta per campaign."

    monkeypatch.setattr(responder, "generate", fake_generate)

    _qna_convo(store)
    transport.feed(JID, "harganya berapa?", name="Cika")

    assert calls == ["REPLY_TANYA_HARGA"], "the stale variant must not be served"
    assert store.cached_replies("REPLY_TANYA_HARGA") and not any(
        "per bulan" in r["text"] for r in store.cached_replies("REPLY_TANYA_HARGA")
    ), "the stale variant must be evicted, not just skipped"
    assert not any("per bulan" in t for _, t in transport.sent)


def test_freeform_replies_are_never_reused(engine, monkeypatch):
    """REPLY_FREEFORM answers the specific message — a cached one would
    answer the wrong question."""
    from bd_bot import responder

    eng, transport, cfg, store = engine
    cfg.use_llm_replies = True
    cfg.anthropic_api_key = "sk-fake"
    cfg.reply_cache_variants = 1

    calls = []

    def fake_generate(key, intent, convo, inbound, fallback, cfg):
        calls.append(key)
        return f"Jawaban khusus untuk: {inbound}"

    monkeypatch.setattr(responder, "generate", fake_generate)

    _qna_convo(store)
    _qna_convo(store, jid="628999@s.whatsapp.net")
    transport.feed(JID, "zxcvbnm qwerty", name="Cika")
    transport.feed("628999@s.whatsapp.net", "asdfgh jkl", name="Budi")

    assert calls.count("REPLY_FREEFORM") == 2, "freeform must generate every time"
    assert store.cached_replies("REPLY_FREEFORM") == []


# --- propose-first scheduling, ROADMAP 2.2 -----------------------------------


def test_agreement_proposes_concrete_slots(engine, monkeypatch):
    """'boleh kak' gets real free slots + the email ask, like the real
    agents ("kita kosong di jam 12:00, possible kak?").

    Three options, and the window said out loud: with two, a brand reads them
    as the only times we have — "we're available Senin–Sabtu 09.00–19.00" was
    missing from this message even though REPLY_SETUJU says it."""
    from datetime import datetime

    from bd_bot import gcal

    eng, transport, cfg, store = engine
    _qna_convo(store)
    free = [
        datetime(2026, 7, 23, 9, 0, tzinfo=cfg.tz),
        datetime(2026, 7, 23, 10, 0, tzinfo=cfg.tz),
        datetime(2026, 7, 24, 13, 0, tzinfo=cfg.tz),
    ]
    monkeypatch.setattr(gcal, "free_slots", lambda cfg_, now, limit=12: free)

    transport.feed(JID, "boleh kak")
    text = transport.sent[-1][1]
    assert "Kamis 23/07 jam 09.00" in text
    assert "Jumat 24/07 jam 13.00" in text, "later slots prefer another day"
    assert "09.00-19.00" in text.replace("–", "-"), "the real window is unstated"
    assert "Senin" in text and "Sabtu" in text, "the available days are unstated"
    assert "email" in text.lower(), "the email ask rides along"
    import re as _re
    # The template says "setiap jam antara …" too, so count real slots.
    offered = _re.findall(r"jam \d{2}\.\d{2}", text)
    assert len(offered) <= 3, f"offered more than three options: {offered}"


def test_agreement_falls_back_to_open_ask_when_calendar_is_down(
    engine, monkeypatch
):
    from bd_bot import gcal

    eng, transport, cfg, store = engine
    _qna_convo(store)

    def boom(cfg_, now, limit=12):
        raise gcal.CalendarError("no oauth")

    monkeypatch.setattr(gcal, "free_slots", boom)
    transport.feed(JID, "boleh kak")
    text = transport.sent[-1][1]
    assert "hari dan jam" in text.lower(), "degrades to the open question"


def test_spread_slots_prefers_distinct_days():
    from datetime import datetime

    from bd_bot.engine import _spread_slots

    same_day = [datetime(2026, 7, 23, h, 0) for h in (9, 10, 11)]
    other = datetime(2026, 7, 24, 9, 0)
    picked = _spread_slots(same_day + [other])
    assert picked[0] == same_day[0] and other in picked
    assert len(picked) == 3, "three options, so two do not read as all we have"
    # All on one day: fills up from that day rather than offering fewer.
    assert _spread_slots(same_day) == same_day[:3]
    assert _spread_slots([]) == []


# --- message bursts, ROADMAP 2.3 ---------------------------------------------


def test_long_generative_reply_goes_out_as_a_burst(engine):
    """The full price list (5 paragraphs) arrives as ≤3 messages — the real
    agents text in short runs, one wall of text reads like a bot."""
    eng, transport, cfg, store = engine
    convo = _qna_convo(store)
    convo.price_stage = 1  # second price ask -> REPLY_PAKET_DETAIL
    store.upsert(convo)

    transport.feed(JID, "detail paketnya dong")
    texts = [t for j, t in transport.sent if j == JID]
    # The price list bursts into 2–3 messages, then OFFER_MEETING follows.
    assert 3 <= len(texts) <= 4, texts
    joined = "\n\n".join(texts)
    for piece in ("Rp10.000.000", "Yang membedakan kami"):
        assert piece in joined, "nothing may be lost in the split"


def test_burst_counts_as_one_logical_send(engine):
    """The cap counts conversations touched, not burst fragments."""
    eng, transport, cfg, store = engine
    convo = _qna_convo(store)
    convo.price_stage = 1
    store.upsert(convo)
    transport.feed(JID, "detail paketnya dong")
    # Two logical sends: REPLY_PAKET_DETAIL (burst) + OFFER_MEETING.
    assert store.sent_today(eng.now()) == 2


def test_burst_needs_only_one_approval(engine, monkeypatch):
    """The operator approves the full text once — not each fragment."""
    eng, transport, cfg, store = engine
    cfg.auto_reply = False
    cfg.require_approval = True
    approvals = []
    monkeypatch.setattr(
        Engine, "_approved", lambda self, jid, text: approvals.append(text) or True
    )
    convo = _qna_convo(store)
    convo.price_stage = 1
    store.upsert(convo)
    transport.feed(JID, "detail paketnya dong")
    # Two logical sends (PAKET_DETAIL burst + OFFER_MEETING) = two approvals,
    # even though more fragments hit the wire.
    assert len(approvals) == 2
    assert len([t for j, t in transport.sent if j == JID]) > 2


def test_operational_messages_never_burst(engine):
    """The blast is one message (plus attachments) — confirmations and
    openers carry data and stay whole."""
    eng, transport, cfg, store = engine
    eng.blast(JID, name="Cika", brand="B")
    texts = [t for _, t in transport.sent if not t.startswith("[")]
    assert len(texts) == 1, texts


def test_burst_chunks_split_and_preserve_everything():
    from bd_bot.engine import _burst_chunks

    short = "Baik kak.\n\nSiap ya."
    assert _burst_chunks(short) == [short]

    paras = [f"Paragraf {i} " + "x" * 80 for i in range(5)]
    text = "\n\n".join(paras)
    chunks = _burst_chunks(text)
    assert 2 <= len(chunks) <= 3
    assert "\n\n".join(chunks) == text, "order preserved, nothing reworded"


# --- case-study assets, ROADMAP 2.4 ------------------------------------------


def test_portfolio_reply_ships_category_case_studies(engine):
    eng, transport, cfg, store = engine
    cfg.case_studies_dir = cfg.opening_dir.parent / "case-studies"
    beauty = cfg.case_studies_dir / "beauty"
    beauty.mkdir(parents=True)
    (beauty / "gmv-report.jpg").write_bytes(b"\xff\xd8fake")
    (beauty / "study.pdf").write_bytes(b"%PDF-1.4 fake")

    _qna_convo(store, category="beauty")
    transport.feed(JID, "boleh minta portofolio terbaru kah?")
    sent = {m for _, m in transport.sent}
    assert "[image: gmv-report.jpg]" in sent
    assert "[document: study.pdf]" in sent


def test_no_category_or_folder_means_no_extra_files(engine):
    eng, transport, cfg, store = engine
    cfg.case_studies_dir = cfg.opening_dir.parent / "case-studies"  # absent
    _qna_convo(store, category="fnb")  # category without a folder
    transport.feed(JID, "boleh minta portofolio terbaru kah?")
    assert not any(m.startswith("[image:") for _, m in transport.sent)
    # The portfolio answer legitimately ships the company profile now — that
    # is a brand asking to see a document. What must not appear is a case
    # study, because this category has no folder.
    docs = [m for _, m in transport.sent if m.startswith("[document:")]
    assert all("profile" in d.lower() or "deck" in d.lower() for d in docs), docs


def test_case_studies_never_cross_categories(engine):
    eng, transport, cfg, store = engine
    cfg.case_studies_dir = cfg.opening_dir.parent / "case-studies"
    (cfg.case_studies_dir / "beauty").mkdir(parents=True)
    (cfg.case_studies_dir / "beauty" / "gmv.jpg").write_bytes(b"\xff\xd8")
    _qna_convo(store, category="fnb")
    transport.feed(JID, "boleh minta portofolio terbaru kah?")
    assert not any("gmv.jpg" in m for _, m in transport.sent)


def test_permission_questions_are_not_read_as_agreement(engine):
    """"boleh …?" opens a polite request as often as it accepts one. Both of
    these were classified SETUJU and answered "saya siapkan jadwalnya" —
    booking a meeting off a question about content rights."""
    from bd_bot import intents
    from bd_bot.models import Intent

    for text in ("videonya boleh kami repost ga?",
                 "boleh kami pilih sendiri affiliatenya?"):
        assert intents.classify_rules(text) is not Intent.SETUJU, text

    # Real agreement still is.
    for text in ("boleh kak", "bolehh", "boleh banget"):
        assert intents.classify_rules(text) is Intent.SETUJU, text


def test_compound_questions_reach_a_human(engine):
    """One reply answers one subject. When a message asks about several, the
    rest goes unanswered with nothing to show for it."""
    eng, transport, cfg, store = engine
    _qna_convo(store)
    transport.feed(
        JID,
        "harganya berapa ya kak? lalu untuk sample nya gimana? "
        "sama kantornya dimana?",
    )

    reasons = [e["reason"] for e in store.open_escalations()]
    assert any("multi-part question" in r for r in reasons), reasons
    # The answer still goes out — this adds an escalation, it does not
    # replace the reply.
    assert [t for j, t in transport.sent if j == JID]


def test_single_subject_questions_do_not_escalate(engine):
    """Two question marks about one thing is not a compound question —
    escalating those would bury the real ones."""
    eng, transport, cfg, store = engine
    _qna_convo(store)
    transport.feed(JID, "bisa quick meet jam berapaaa? jam 2 apakah aman?")

    reasons = [e["reason"] for e in store.open_escalations()]
    assert not any("multi-part" in r for r in reasons), reasons


def test_restart_accepts_the_command_without_a_slash():
    """Testers are told to send /restart, and they approximate it. On 30 Jul
    2026 one tried "Restart" then "Mulai dari awal"; both fell to unknown and
    they could not get back to the opening at all."""
    from bd_bot.engine import Engine

    for good in ("/restart", "!restart", "Restart", "restart.",
                 "Mulai dari awal", "mulai awal", "ulang dari awal",
                 # Typos: the same tester fumbled it four times running.
                 "RestRt", "restrt", "resttart"):
        assert Engine._RESTART_CMD.match(good), good

    # Only when the whole message is the command — otherwise a brand
    # discussing their campaign would wipe their own conversation.
    for bad in ("kita restart campaign nya ya", "mulai dari awal bulan depan",
                "Mau meeting", "rest"):
        assert not Engine._RESTART_CMD.match(bad), bad


def test_asking_where_we_got_their_number_never_invents_a_source(engine):
    """The one question the bot must not improvise on."""
    from bd_bot import responder

    eng, transport, cfg, store = engine
    _qna_convo(store)
    transport.feed(JID, "kaka tau nomor saya dari mana?")

    joined = "\n".join(t for j, t in transport.sent if j == JID)
    assert "hapus dari daftar" in joined, "must offer removal"
    assert not responder._PROVENANCE_RE.search(joined), "must not name a source"
    assert any(
        "where we got their contact" in e["reason"]
        for e in store.open_escalations()
    ), "a human must be told"


# --- commission counter-offers ------------------------------------------------


def test_commission_counter_offer_quotes_their_figure_back(engine):
    """A brand that names a number wants a response to that number, not a
    recital of our 10% opening."""
    eng, transport, cfg, store = engine
    _qna_convo(store)
    transport.feed(JID, "Kalau komisi ke mcnasia nego di 5 % gimana ?")

    joined = "\n".join(t for j, t in transport.sent if j == JID)
    assert "5%" in joined, joined
    assert "10%" not in joined, "their counter-offer is the subject, not ours"
    assert "manajemen" in joined.lower()


def test_commission_counter_offer_reaches_a_human(engine):
    """Only management can approve a number, so one must be told."""
    eng, transport, cfg, store = engine
    _qna_convo(store)
    transport.feed(JID, "komisi mcn bisa 5% ga?")

    open_items = store.open_escalations()
    assert any("commission counter-offer" in e["reason"] for e in open_items), open_items


def test_asking_how_commission_works_is_not_a_counter_offer(engine):
    """Verbatim from the corpus — quoting the number we gave them is a
    question about the split, and TANYA_KOMISI explains it."""
    from bd_bot import intents
    from bd_bot.models import Intent

    assert intents.classify_rules(
        "Itu kan komisi ada komisi 10% utk MCN. Dan komisi utk affiliate "
        "sendiri. Jadi double dong?"
    ) is Intent.TANYA_KOMISI


# --- ads service line --------------------------------------------------------


def test_ads_question_ships_the_ads_deck(engine):
    """A brand asking about ads gets the ads deck, not the affiliate profile."""
    eng, transport, cfg, store = engine
    cfg.ads_deck_pdf = cfg.opening_dir.parent / "configured-ads-deck.pdf"
    cfg.ads_deck_pdf.parent.mkdir(parents=True, exist_ok=True)
    cfg.ads_deck_pdf.write_bytes(b"%PDF-1.4 fake")

    _qna_convo(store)
    transport.feed(JID, "kak ada service ads juga gak?")

    sent = [m for _, m in transport.sent]
    assert any("configured-ads-deck.pdf" in m for m in sent), sent
    answer = next(m for m in sent if "Ads Management" in m)
    for piece in ("TikTok Ads", "Shopee Ads", "Meta Ads", "di luar budget iklan"):
        assert piece in answer, piece
    # The affiliate deck answers a different question — it must not tag along.
    assert not any("profile" in m.lower() for m in sent), sent


def test_missing_ads_deck_still_answers(engine):
    """No file is a reason to send text alone, never to go silent."""
    eng, transport, cfg, store = engine
    cfg.ads_deck_pdf = cfg.opening_dir.parent / "absent.pdf"

    _qna_convo(store)
    transport.feed(JID, "kak ada service ads juga gak?")

    sent = [m for _, m in transport.sent]
    assert any("Ads Management" in m for m in sent), sent
    assert not any(m.startswith("[document:") for m in sent), sent


def test_ads_answer_does_not_push_the_meeting_gadget(engine):
    """"boleh share untuk paket ads" is a request for material. The reply
    carries its own soft offer; a second, harder ask is what produced "ko
    langsung ngajak meeting sih kak" in the 29 Jul pilot."""
    eng, transport, cfg, store = engine
    cfg.ads_deck_pdf = cfg.opening_dir.parent / "absent.pdf"

    _qna_convo(store)
    transport.feed(JID, "boleh share untuk paket ads")

    joined = "\n".join(m for _, m in transport.sent)
    assert "Ads Management" in joined
    assert "bersedia" not in joined.lower(), joined


def test_import_carries_category_to_the_conversation(engine, tmp_path):
    """CSV category column -> contact -> blast -> conversation."""
    from bd_bot import contacts as contacts_mod

    eng, transport, cfg, store = engine
    csv_file = tmp_path / "brands.csv"
    csv_file.write_text("phone,brand,kategori\n0812333444555,Glow Co,Beauty\n")
    report = contacts_mod.load_file(csv_file)
    assert report.contacts[0].category == "beauty", "category is normalised"
    store.add_contacts(report.contacts, "test", eng.now())
    contact = store.queue(1)[0]
    eng.blast(contact.jid, contact.name, contact.brand, contact.category)
    assert store.get(contact.jid).category == "beauty"


# --- transport failure behaviour, ROADMAP 3.2 --------------------------------


def test_ban_event_pauses_outbound_and_alerts(engine):
    eng, transport, cfg, store = engine
    cfg.alert_jid = "628000@s.whatsapp.net"
    _qna_convo(store)

    eng.handle_transport_event("banned", "TemporaryBanEv: 3 days")
    assert eng.paused
    alerts = [t for j, t in transport.sent if j == cfg.alert_jid]
    assert alerts and "PAUSED" in alerts[0]
    assert any(
        "banned" in r["reason"] for r in store.open_escalations()
    ), "the pause must be visible in the inbox too"

    before = len(transport.sent)
    transport.feed(JID, "harganya berapa?")
    assert len(transport.sent) == before, "paused engine must not send"


def test_disconnect_alerts_but_does_not_pause(engine):
    eng, transport, cfg, store = engine
    cfg.alert_jid = "628000@s.whatsapp.net"
    eng.handle_transport_event("disconnected", "stream error")
    assert not eng.paused, "neonize reconnects on its own"
    assert any(j == cfg.alert_jid for j, _ in transport.sent)


def test_alert_falls_through_to_bd_group(engine):
    """No ALERT_JID → operational alerts land in the BD group instead of only
    the log (config.py: alert_jid or bd_group_jid). The whole point of leaving
    ALERT_JID blank once BD_GROUP_JID is set."""
    eng, transport, cfg, store = engine
    cfg.alert_jid = ""
    cfg.bd_group_jid = "120363123456@g.us"
    eng.alert("kalender down")
    assert any(
        j == cfg.bd_group_jid and t == "kalender down" for j, t in transport.sent
    )


def test_alert_jid_wins_over_bd_group(engine):
    """A set ALERT_JID takes precedence — the group is the fallback, not a
    second recipient."""
    eng, transport, cfg, store = engine
    cfg.alert_jid = "628000@s.whatsapp.net"
    cfg.bd_group_jid = "120363123456@g.us"
    eng.alert("halo")
    assert any(j == cfg.alert_jid for j, _ in transport.sent)
    assert not any(j == cfg.bd_group_jid for j, _ in transport.sent)


def test_alert_with_no_target_only_logs(engine):
    """Both unset: alerting must never raise and must send nowhere — a missing
    target can't be allowed to break the caller mid-flow."""
    eng, transport, cfg, store = engine
    cfg.alert_jid = ""
    cfg.bd_group_jid = ""
    before = len(transport.sent)
    eng.alert("kalender down")  # must not raise
    assert len(transport.sent) == before


def test_booking_failure_answers_the_contact_and_alerts(engine, monkeypatch):
    """Calendar down mid-booking: the lead who just agreed must get an
    acknowledgement, a human gets the escalation + alert — never silence."""
    from bd_bot import gcal

    eng, transport, cfg, store = engine
    cfg.alert_jid = "628000@s.whatsapp.net"
    _scheduling_convo(store, JID)

    def boom(cfg_, now, limit=12):
        raise gcal.CalendarError("no oauth")

    monkeypatch.setattr(gcal, "free_slots", boom)
    transport.feed(JID, "jam 10 ya kak")

    to_contact = [t for j, t in transport.sent if j == JID]
    assert any("sedang saya siapkan" in t for t in to_contact), "acknowledge!"
    assert any(j == cfg.alert_jid for j, _ in transport.sent)
    assert store.open_escalations()


def test_llm_fallback_streak_alerts_once(engine, monkeypatch):
    from bd_bot import responder

    eng, transport, cfg, store = engine
    cfg.use_llm_replies = True
    cfg.anthropic_api_key = "sk-fake"
    cfg.alert_jid = "628000@s.whatsapp.net"
    # Force generation to fall back to the static template every time.
    monkeypatch.setattr(
        responder, "generate",
        lambda key, intent, convo, inbound, fallback, cfg: fallback,
    )
    _qna_convo(store)
    for _ in range(4):
        transport.feed(JID, "sistemnya gimana ya?")
    alerts = [t for j, t in transport.sent if j == cfg.alert_jid]
    assert len(alerts) == 1, "alert once, not on every message"
    assert "static templates" in alerts[0]


def test_non_generative_templates_do_not_count_as_llm_failures(engine):
    """A follow-up template returns the fallback because it was never eligible
    for generation — that is the design, not a fault.

    Counting it fired "check the API key and logs" at a live run whose key was
    working: three timer-driven follow-ups in a row were enough."""
    from bd_bot import responder, templates

    eng, transport, cfg, store = engine
    cfg.use_llm_replies = True
    cfg.anthropic_api_key = "sk-fake"
    cfg.alert_jid = "628000@s.whatsapp.net"

    follow_ups = ["cold_fu1", "menunda_h1", "reject_promo", "decay_stop"]
    assert not (set(follow_ups) & responder.GENERATIVE_KEYS), (
        "premise: these are the timer templates nothing tries to generate"
    )
    eng.blast(JID, name="Cika", brand="B")
    convo = store.get(JID)
    for key in follow_ups:
        eng._compose(convo, templates.Message(text="teks statis", key=key))

    assert eng._llm_fallback_streak == 0, "non-generative keys leave health alone"
    assert not [t for j, t in transport.sent if j == cfg.alert_jid]


# --- restart safety, ROADMAP 3.1 ---------------------------------------------


def test_pending_timers_survive_restart_and_fire_once(engine, tmp_path):
    """Kill/restart mid-conversation: the cold ladder resumes from SQLite,
    fires exactly once, and never duplicates."""
    from datetime import timedelta

    from bd_bot.engine import Engine
    from bd_bot.storage import Store
    from bd_bot.transport.mock import MockTransport

    eng, transport, cfg, store = engine
    eng.blast(JID, name="Cika", brand="B")
    assert store.pending(JID), "blast arms the ladder"

    # "Restart": new store handle, new engine, same database file.
    store2 = Store(cfg.db_path)
    transport2 = MockTransport(echo=False)
    eng2 = Engine(cfg, store2, transport2)
    transport2.start(eng2.handle_inbound)

    future = eng2.now() + timedelta(days=2)
    eng2.now = lambda: future  # everything is overdue now
    fired_first = eng2.tick()
    assert fired_first >= 1, "resumed timer must fire"
    fired_second = eng2.tick()
    assert fired_second == 0, "and must never fire twice"
    store2.close()


def test_store_is_usable_across_threads(tmp_path):
    """`run` ticks from a worker thread while the transport thread serves
    inbound — the connection must allow it (check_same_thread=False)."""
    import threading

    from bd_bot.storage import Store

    store = Store(tmp_path / "x.sqlite3")
    errors = []

    def worker():
        try:
            store.sent_today(__import__("datetime").datetime.now())
        except Exception as exc:  # pragma: no cover
            errors.append(exc)

    t = threading.Thread(target=worker)
    t.start()
    t.join()
    assert not errors, errors
    store.close()


# --- escalation SLA digest, ROADMAP 3.5 --------------------------------------


def test_digest_reports_stale_escalations_once_per_day(engine):
    from datetime import datetime, timedelta

    eng, transport, cfg, store = engine
    cfg.alert_jid = "628000@s.whatsapp.net"
    in_window = datetime(2026, 7, 21, 10, 0, tzinfo=cfg.tz)  # Tue 10:00
    eng.now = lambda: in_window
    store.escalate(JID, "price negotiation", "", in_window - timedelta(days=1))

    eng.tick()
    digests = [t for j, t in transport.sent if j == cfg.alert_jid]
    assert len(digests) == 1 and "SLA" in digests[0]

    eng.tick()
    digests = [t for j, t in transport.sent if j == cfg.alert_jid]
    assert len(digests) == 1, "once per day, not per tick"


def test_fresh_escalations_do_not_trigger_the_digest(engine):
    from datetime import datetime, timedelta

    eng, transport, cfg, store = engine
    cfg.alert_jid = "628000@s.whatsapp.net"
    in_window = datetime(2026, 7, 21, 10, 0, tzinfo=cfg.tz)
    eng.now = lambda: in_window
    store.escalate(JID, "new item", "", in_window - timedelta(minutes=30))
    eng.tick()
    assert not [t for j, t in transport.sent if j == cfg.alert_jid]


def test_business_hours_skip_nights_and_weekends():
    from datetime import datetime

    from bd_bot.config import Settings
    from bd_bot.engine import business_hours_between

    cfg = Settings()
    fri_16 = datetime(2026, 7, 24, 16, 0)  # Friday 16:00
    mon_10 = datetime(2026, 7, 27, 10, 0)  # Monday 10:00
    hours = business_hours_between(fri_16, mon_10, cfg)
    # Fri 16:00–17:00 + Mon 09:00–10:00 ≈ 2h — the weekend doesn't count.
    # The send window is 09.00-19.00, matched to the meeting window.
    assert 4.0 <= hours <= 5.0, hours


def test_persistence_survives_reload(engine, tmp_path):
    eng, transport, cfg, store = engine
    eng.blast(JID, name="Cika", brand="Brand X")
    transport.feed(JID, "nanti aja kak")
    loops_before = store.get(JID).gadget_loops

    reopened = Store(cfg.db_path)
    convo = reopened.get(JID)
    assert convo is not None
    assert convo.name == "Cika"
    assert convo.brand == "Brand X"
    assert convo.gadget_loops == loops_before
    reopened.close()


# --- a named time must not be overruled by our own suggestions --------------


def _slots(now, *hours, day_offset=0):
    from datetime import timedelta as td

    base = (now + td(days=day_offset)).replace(minute=0, second=0, microsecond=0)
    return [base.replace(hour=h) for h in hours]


def test_a_requested_free_hour_is_confirmed_not_overruled(engine, monkeypatch):
    """Seen in testing: "saya available hari ini di jam 13.00" was answered
    with "11.00 / 09.00", and the lead dropped their own preference to fit
    ours — at the one turn where momentum matters most."""
    from bd_bot import gcal
    from bd_bot.models import Conversation, Node

    eng, transport, cfg, store = engine
    now = eng.now()
    store.upsert(Conversation(jid=JID, node=Node.SCHEDULING, brand="Brand X"))
    store.log_message(JID, "in", "saya available hari ini di jam 13.00", now)
    monkeypatch.setattr(
        gcal, "free_slots", lambda c, n, limit=12: _slots(now, 9, 11, 13, 15)
    )

    convo = store.get(JID)
    transport.sent.clear()
    eng._propose_slots(convo, _fallback_msg(), now)

    body = transport.sent[0][1]
    assert "13.00" in body, f"the hour they asked for is missing: {body!r}"
    assert "11.00" not in body and "09.00" not in body, "we argued with them"
    assert "email" in body.lower(), "the next step was dropped"


def test_a_requested_hour_that_is_taken_gets_alternatives(engine, monkeypatch):
    """Offering other times is the right answer to a slot that is genuinely
    unavailable — the bug was doing it when the slot was free."""
    from bd_bot import gcal
    from bd_bot.models import Conversation, Node

    eng, transport, cfg, store = engine
    now = eng.now()
    store.upsert(Conversation(jid=JID, node=Node.SCHEDULING, brand="Brand X"))
    store.log_message(JID, "in", "bisa jam 13.00 kak?", now)
    monkeypatch.setattr(gcal, "free_slots", lambda c, n, limit=12: _slots(now, 9, 11))

    convo = store.get(JID)
    transport.sent.clear()
    eng._propose_slots(convo, _fallback_msg(), now)
    assert "13.00" not in transport.sent[0][1]


def test_no_named_time_still_proposes_slots(engine, monkeypatch):
    from bd_bot import gcal
    from bd_bot.models import Conversation, Node

    eng, transport, cfg, store = engine
    now = eng.now()
    store.upsert(Conversation(jid=JID, node=Node.SCHEDULING, brand="Brand X"))
    store.log_message(JID, "in", "boleh kak", now)
    monkeypatch.setattr(gcal, "free_slots", lambda c, n, limit=12: _slots(now, 9, 11))

    convo = store.get(JID)
    transport.sent.clear()
    eng._propose_slots(convo, _fallback_msg(), now)
    assert "09.00" in transport.sent[0][1] or "11.00" in transport.sent[0][1]


def _fallback_msg():
    from bd_bot import templates
    from bd_bot.config import Settings
    from bd_bot.models import Conversation

    return templates.render(
        "REPLY_SETUJU", Conversation(jid=JID, brand="Brand X"), Settings()
    )


def test_a_time_range_is_not_read_as_a_date(engine, monkeypatch):
    """Seen live: "saya available di jam 13.00-15.00" was booked at 12.00.
    The date stripper read the "00-15" in the middle as a day/month and left
    "jam 13. .00" behind, which parsed as the hours {0, 12, 13}."""
    from bd_bot.engine import _requested_hours, _strip_dates

    eng, _, cfg, _ = engine
    hours = _requested_hours(
        _strip_dates("hari ini saya available di jam 13.00-15.00 apakah bisa?"),
        cfg.meeting_hour_start,
    )
    # Every hour in the span, not just its ends — someone free 13.00-15.00
    # is also free at 14.00, and offering only 13 and 15 loses the middle.
    assert sorted(hours) == [13, 14, 15], f"parsed {sorted(hours)}"


def test_a_real_date_is_still_stripped(engine):
    """The stripper exists so "29/07" and "tanggal 12" are not read as
    clock times — that must keep working."""
    from bd_bot.engine import _requested_hours, _strip_dates

    eng, _, cfg, _ = engine
    for text, want in [
        ("ketemu 29/07 jam 10.00", [10]),
        ("meeting tanggal 12 jam 14.00", [14]),
    ]:
        got = sorted(_requested_hours(_strip_dates(text), cfg.meeting_hour_start))
        assert got == want, f"{text!r} parsed {got}"


def test_a_range_books_the_hour_they_named(engine, monkeypatch):
    """The whole point: offer 13.00–15.00 and get 13.00, not some third hour."""
    from datetime import datetime

    from bd_bot import gcal
    from bd_bot.models import Conversation, Node

    eng, transport, cfg, store = engine
    now = eng.now()
    store.upsert(Conversation(jid=JID, node=Node.SCHEDULING, brand="Brand X"))
    store.log_message(JID, "in", "hari ini saya available di jam 13.00-15.00", now)
    free = [now.replace(hour=h, minute=0, second=0, microsecond=0)
            for h in (10, 12, 13, 15)]
    monkeypatch.setattr(gcal, "free_slots", lambda c, n, limit=12: free)

    convo = store.get(JID)
    transport.sent.clear()
    eng._propose_slots(convo, _fallback_msg(), now)
    body = transport.sent[0][1]
    assert "13.00" in body, f"did not take the hour they named: {body!r}"
    assert "12.00" not in body, "booked an hour they never mentioned"


# --- case-study folders, ROADMAP 2.4 ----------------------------------------


@pytest.mark.parametrize(
    "written,folder",
    [("F&B", "fnb"), ("f & b", "fnb"), ("Food & Beverage", "fnb"),
     ("skincare", "beauty"), ("Beauty", "beauty"), ("kosmetik", "beauty"),
     ("Mom & Kids", "mom-kids"), ("ibu anak", "mom-kids"),
     ("Home Living", "home-living"), ("furniture", "home-living"),
     ("hijab", "fashion"), ("supplement", "health")],
)
def test_however_the_csv_spells_it_finds_the_folder(written, folder):
    """The brand list is filled in by hand. Matching the folder name exactly
    meant "F&B" needed a folder called "f&b", and any other wording silently
    sent nothing."""
    from bd_bot.engine import _category_slug

    assert _category_slug(written) == folder


def test_an_unknown_category_never_guesses_a_folder():
    """Sending a beauty brand's GMV screenshots to an automotive brand is
    worse than sending nothing."""
    from bd_bot.engine import _category_slug

    assert _category_slug("Otomotif") == "otomotif"   # its own folder or none
    assert _category_slug("") == ""
    assert _category_slug("   ") == ""


def test_case_studies_are_sent_for_a_matching_category(engine, tmp_path):
    from bd_bot.models import Conversation, Node

    eng, transport, cfg, store = engine
    cfg.case_studies_dir = tmp_path / "case-studies"
    (cfg.case_studies_dir / "beauty").mkdir(parents=True)
    (cfg.case_studies_dir / "beauty" / "01-gmv.png").write_bytes(b"\x89PNG fake")

    convo = Conversation(jid=JID, brand="X", category="Skincare", node=Node.QNA)
    transport.sent.clear()
    eng._send_case_studies(convo)
    assert any("01-gmv.png" in t for _, t in transport.sent), transport.sent


def test_files_never_cross_categories(engine, tmp_path):
    from bd_bot.models import Conversation, Node

    eng, transport, cfg, store = engine
    cfg.case_studies_dir = tmp_path / "case-studies"
    (cfg.case_studies_dir / "beauty").mkdir(parents=True)
    (cfg.case_studies_dir / "beauty" / "01-gmv.png").write_bytes(b"\x89PNG fake")

    convo = Conversation(jid=JID, brand="X", category="Otomotif", node=Node.QNA)
    transport.sent.clear()
    eng._send_case_studies(convo)
    assert not transport.sent, "sent another category's evidence"


@pytest.mark.skipif(
    not any((Path(__file__).resolve().parents[1] / "assets" / "case-studies").glob("*/*")),
    reason="case studies are client material and are not published with this repo",
)
def test_the_shipped_folders_cover_every_stated_category():
    """knowledge.CATEGORIES is what the opening claims experience in; each
    should have somewhere for its evidence to live."""
    from pathlib import Path

    from bd_bot.engine import _category_slug
    from bd_bot import knowledge

    root = Path(__file__).resolve().parents[1] / "assets" / "case-studies"
    for category in knowledge.CATEGORIES:
        folder = root / _category_slug(category)
        assert folder.is_dir(), f"no folder for {category!r} (expected {folder.name})"


# --- a day the contact ruled out is not the day they asked for --------------


@pytest.mark.parametrize(
    "text,offset",
    [("I see, aku ga available hari ini mungkin lusa di jam 10.00", 2),
     ("ga bisa besok, senin aja", None),          # next Monday, checked below
     ("ga available besok tapi jumat bisa", None),
     ("besok jam 10 bisa kak", 1),
     ("hari ini jam 3 ya", 0),
     ("lusa jam 10", 2)],
)
def test_a_negated_day_is_not_the_requested_day(text, offset):
    """Seen live: "aku ga available hari ini mungkin lusa" resolved to today —
    earliest-match-wins picked the day the contact had just ruled out, and the
    bot offered slots on it."""
    from datetime import datetime, timedelta

    from bd_bot.engine import _requested_day
    from bd_bot.config import Settings

    cfg = Settings()
    now = datetime(2026, 7, 29, 12, 0, tzinfo=cfg.tz)   # a Wednesday
    got = _requested_day(text, now)
    if offset is not None:
        assert got == (now + timedelta(days=offset)).date(), f"{text!r} -> {got}"
    else:
        assert got is not None and got > now.date(), f"{text!r} -> {got}"


def test_a_bare_negation_asks_for_no_day_at_all():
    from datetime import datetime

    from bd_bot.engine import _requested_day
    from bd_bot.config import Settings

    cfg = Settings()
    now = datetime(2026, 7, 29, 12, 0, tzinfo=cfg.tz)
    assert _requested_day("belum bisa hari ini", now) is None


# --- availability as spans, not as one arbitrary hour per day ---------------


def _day(offset=0, tz=None, hours=()):
    from datetime import datetime, timedelta
    from zoneinfo import ZoneInfo

    tz = tz or ZoneInfo("Asia/Jakarta")
    base = datetime(2026, 7, 29, tzinfo=tz) + timedelta(days=offset)
    return [base.replace(hour=h) for h in hours]


def test_a_wide_open_day_is_offered_as_a_span():
    """Picking one hour out of a free day reads as though it is the only time
    we have — and "jam 09.00" twice in a row reads as a machine."""
    from bd_bot.engine import _free_ranges

    out = _free_ranges(_day(1, hours=range(9, 19)))
    assert out == "Kamis 30/07 jam 09.00-19.00", out


def test_a_booked_gap_splits_the_span():
    """A meeting from 12 to 15 has to show as two spans, not one wrong one."""
    from bd_bot.engine import _free_ranges

    out = _free_ranges(_day(0, hours=(9, 10, 11, 15, 16, 17, 18)))
    assert out == "Rabu 29/07 jam 09.00-12.00, 15.00-19.00", out


def test_the_span_ends_when_the_last_meeting_ends():
    """The last bookable slot starts at 18.00 and runs an hour, so the day
    ends at 19.00 — quoting 18.00 would understate availability."""
    from bd_bot.engine import _free_ranges

    assert _free_ranges(_day(0, hours=(17, 18))).endswith("17.00-19.00")


def test_a_single_free_hour_is_not_dressed_up_as_a_range():
    from bd_bot.engine import _free_ranges

    assert _free_ranges(_day(0, hours=(14,))) == "Rabu 29/07 jam 14.00"


def test_only_the_next_few_days_are_listed():
    from bd_bot.engine import _free_ranges

    slots = sum((_day(d, hours=range(9, 19)) for d in range(6)), [])
    assert _free_ranges(slots).count("•") == 2, "listed more than three days"


# --- a file goes to a contact once ------------------------------------------


def test_the_same_attachment_is_not_sent_twice(engine):
    """The deck arriving with the opening and again on every follow-up reads
    as spam rather than service. A brand who wants it again asks for it —
    which is a different message with a different answer."""
    from bd_bot.models import Conversation, Node

    eng, transport, cfg, store = engine
    convo = Conversation(jid=JID, brand="X", node=Node.QNA)
    store.upsert(convo)

    eng._send_profile(convo)
    first = len([m for _, m in transport.sent if m.startswith("[document:")])
    assert first == 1, transport.sent

    eng._send_profile(convo)
    again = len([m for _, m in transport.sent if m.startswith("[document:")])
    assert again == 1, "the profile went out a second time"


def test_a_different_file_still_goes(engine):
    """Send-once is per file, not per contact — a case study after the deck
    is new information."""
    from bd_bot.models import Conversation, Node

    eng, transport, cfg, store = engine
    convo = Conversation(jid=JID, brand="X", node=Node.QNA)
    store.upsert(convo)

    eng._send_profile(convo)
    eng._send_opening(convo)
    names = {m for _, m in transport.sent if m.startswith(("[document:", "[image:"))}
    assert len(names) > 1, names


def test_an_undelivered_file_is_not_marked_as_sent(engine):
    """If the socket dies mid-send, the contact never got it — recording it
    would mean they never do."""
    from bd_bot.models import Conversation, Node

    eng, transport, cfg, store = engine
    convo = Conversation(jid=JID, brand="X", node=Node.QNA)
    store.upsert(convo)

    def _boom(*a, **k):
        raise RuntimeError("websocket not connected")

    transport.send_document = _boom
    eng._send_profile(convo)
    assert not store.already_sent_file(JID, cfg.company_profile_pdf.name)


@pytest.mark.parametrize(
    "text,offset",
    [("aku gabisa hari ini kl besok bisa ga ya?", 1),
     ("gbs hari ini besok aja", 1),
     ("ga available hari ini mungkin lusa", 2),
     ("besok jam 10 bisa?", 1),
     ("hari ini jam 3 ya", 0)],
)
def test_a_negation_only_rules_out_the_day_it_names(text, offset):
    """"gabisa"/"gbs" written solid are negations too, and one negation must
    not silence every later day — "gbs hari ini besok aja" offers tomorrow."""
    from datetime import datetime, timedelta

    from bd_bot.engine import _requested_day
    from bd_bot.config import Settings

    cfg = Settings()
    now = datetime(2026, 7, 29, 12, 46, tzinfo=cfg.tz)
    assert _requested_day(text, now) == (now + timedelta(days=offset)).date(), text


def test_asking_about_one_day_answers_about_that_day(engine, monkeypatch):
    """Live: "kalau Sabtu?" was answered with Wednesday/Thursday/Friday and a
    "terima kasih" — which does not answer the question that was asked."""
    from datetime import datetime, timedelta

    from bd_bot import gcal
    from bd_bot.models import Conversation, Node

    eng, transport, cfg, store = engine
    now = datetime(2026, 7, 29, 13, 0, tzinfo=cfg.tz)   # a Wednesday
    store.upsert(Conversation(jid=JID, node=Node.SCHEDULING, brand="X"))
    store.log_message(JID, "in", "kalau Sabtu?", now)

    # A full week free — including the Saturday, which a truncated slot list
    # would never have reached.
    free = [
        (now + timedelta(days=d)).replace(hour=h, minute=0, second=0, microsecond=0)
        for d in range(6) for h in range(9, 19)
    ]
    monkeypatch.setattr(gcal, "free_slots", lambda c, n, limit=12: free)

    transport.sent.clear()
    eng._propose_slots(store.get(JID), _fallback_msg(), now)
    body = transport.sent[0][1]
    assert "Sabtu 01/08" in body, body
    assert "Rabu" not in body and "Kamis" not in body, "answered about other days"


def test_a_day_they_ruled_out_is_not_offered(engine, monkeypatch):
    """"aku gabisa hari ini" then being offered today is the whole problem
    restated."""
    from datetime import datetime, timedelta

    from bd_bot import gcal
    from bd_bot.models import Conversation, Node

    eng, transport, cfg, store = engine
    now = datetime(2026, 7, 29, 13, 0, tzinfo=cfg.tz)
    store.upsert(Conversation(jid=JID, node=Node.SCHEDULING, brand="X"))
    store.log_message(
        JID, "in", "aku gabisa hari ini kira kira alternativenya hari apa aja ya?", now
    )
    free = [
        (now + timedelta(days=d)).replace(hour=h, minute=0, second=0, microsecond=0)
        for d in range(4) for h in range(9, 19)
    ]
    monkeypatch.setattr(gcal, "free_slots", lambda c, n, limit=12: free)

    transport.sent.clear()
    eng._propose_slots(store.get(JID), _fallback_msg(), now)
    body = transport.sent[0][1]
    assert "29/07" not in body, f"offered the day they ruled out: {body}"
    assert "30/07" in body


@pytest.mark.parametrize(
    "text,expected_offset",
    [("waduh kayanya aku blm bisa kalau minggu depan hari rabu?", 7),
     ("minggu depan hari rabu ya", 7),
     ("rabu depan bisa?", 7),
     ("hari rabu bisa?", 0),
     ("jumat bisa?", 2)],
)
def test_next_week_moves_the_weekday_a_week_out(text, expected_offset):
    """Live: "minggu depan hari rabu" resolved to today — and the contact had
    just said they could not do today."""
    from datetime import datetime, timedelta

    from bd_bot.engine import _requested_day
    from bd_bot.config import Settings

    cfg = Settings()
    now = datetime(2026, 7, 29, 13, 0, tzinfo=cfg.tz)   # a Wednesday
    assert _requested_day(text, now) == (now + timedelta(days=expected_offset)).date()


def test_the_day_from_an_earlier_turn_is_carried_to_the_booking(engine, monkeypatch):
    """The real exchange this comes from:

        "oke kak kali Sabtu jadwalnya kapan aja ya?"
        "waduh kayanya aku blm bisa kalau minggu depan hari rabu"
        "cecil@example.com aku bisanya di jam 13.00 ya kak"

    The hour is in the last message and the day is two messages back, so the
    booking only lands correctly if the earlier turns are read. Live it booked
    Wednesday THIS week — the day they had just ruled out — and then offered
    that afternoon's leftovers.
    """
    from datetime import datetime, timedelta

    from bd_bot import gcal
    from bd_bot.models import Conversation, Node

    eng, transport, cfg, store = engine
    now = datetime(2026, 7, 29, 13, 0, tzinfo=cfg.tz)      # Wednesday
    store.upsert(
        Conversation(jid=JID, node=Node.SCHEDULING, brand="X",
                     email="cecil@example.com")
    )
    for text in ("oke kak kali Sabtu jadwalnya kapan aja ya?",
                 "waduh kayanya aku blm bisa kalau minggu depan hari rabu",
                 "cecil@example.com aku bisanya di jam 13.00 ya kak"):
        store.log_message(JID, "in", text, now)

    free = [
        (now + timedelta(days=d)).replace(hour=h, minute=0, second=0, microsecond=0)
        for d in range(15) for h in range(9, 19)
    ]
    monkeypatch.setattr(gcal, "free_slots", lambda c, n, limit=12: free)
    booked = {}
    monkeypatch.setattr(
        gcal, "book",
        lambda c, start, summary, description="", attendee_email="": booked.update(
            start=start
        ) or gcal.Booking(start=start, end=start, meet_link="x", event_id="1"),
    )

    eng._book(store.get(JID), now)
    assert booked, "nothing was booked"
    assert booked["start"].date() == (now + timedelta(days=7)).date(), (
        f"booked {booked['start']}, expected next Wednesday 5 Aug"
    )
    assert booked["start"].hour == 13


def test_the_slot_preamble_is_said_once(engine, monkeypatch):
    """A brand working through days gets three proposals in a row. Opening
    each with "Terima kasih, Kak. Saya siapkan jadwalnya ya." reads as a
    machine that has not registered anything they said."""
    from datetime import datetime, timedelta

    from bd_bot import gcal
    from bd_bot.models import Conversation, Node

    eng, transport, cfg, store = engine
    now = datetime(2026, 7, 29, 13, 0, tzinfo=cfg.tz)
    store.upsert(Conversation(jid=JID, node=Node.SCHEDULING, brand="X"))
    free = [
        (now + timedelta(days=d)).replace(hour=h, minute=0, second=0, microsecond=0)
        for d in range(8) for h in range(9, 19)
    ]
    monkeypatch.setattr(gcal, "free_slots", lambda c, n, limit=12: free)

    transport.sent.clear()
    # A brand "working through days" is ruling one out each time — that is what
    # makes the second and third proposals different messages. Without an
    # inbound between them the bot would repeat itself verbatim, which the loop
    # breaker now refuses (see test_loop_guard.py); freezing the contact as
    # well as the clock would be testing a case production cannot reach.
    for excuse in (None, "hari ini aku ga bisa", "besok juga ga bisa"):
        if excuse:
            store.log_message(JID, "in", excuse, now)
        eng._propose_slots(store.get(JID), _fallback_msg(), now)
    bodies = [t for _, t in transport.sent]

    assert len(bodies) == 3
    assert "Kami tersedia Senin" in bodies[0], "the first proposal sets the scene"
    for later in bodies[1:]:
        assert "Kami tersedia Senin" not in later, "repeated the whole preamble"
        assert "Terima kasih" not in later, "thanked them again mid-negotiation"
        assert "kosong" in later, "the later proposal stopped answering"
    assert "email" in bodies[1].lower(), "dropped the email ask while still needed"


def test_no_template_thanks_them_on_a_slot_proposal():
    """Thanks belongs at the opening and the close, not on every turn."""
    from bd_bot import templates

    assert not templates.PROPOSE_SLOTS.strip().startswith("Terima kasih")
    assert not templates.PROPOSE_SLOTS_AGAIN.strip().startswith("Terima kasih")


# --- how Indonesians actually write times -----------------------------------


def _now():
    from datetime import datetime
    from bd_bot.config import Settings
    return datetime(2026, 7, 29, 13, 0, tzinfo=Settings().tz)   # Wednesday


@pytest.mark.parametrize(
    "text,hours",
    [("besok jam setengah 3 bisa?", [14]),      # 14.30, NOT 15
     ("jam setengah 11 aja kak", [10]),
     ("jam 2 aja", [14]),                       # afternoon shorthand
     ("besok pagi bisa kak?", [9, 10, 11]),
     ("sorean aja ya kak", [15, 16, 17]),
     ("abis maghrib aja kak", [18, 19]),
     ("sehabis makan siang ya kak", [13, 14]),  # not also "siang"
     ("nanti siang jam 1 bisa ga", [13])],
)
def test_times_of_day_and_half_hours(text, hours):
    """"setengah 3" is 14.30 — half an hour BEFORE three. Reading the digit
    after "jam" books an hour late. And "besok pagi" produced no hour at all
    before this, so a perfectly clear answer went unparsed."""
    from bd_bot.engine import _requested_hours

    assert sorted(_requested_hours(text, 9)) == hours


@pytest.mark.parametrize(
    "text,expected",
    [("minggu depan hari selasa gmn kak", "2026-08-04"),
     ("rabu minggu depan ya", "2026-08-05"),
     ("senin depan aja jam 10", "2026-08-03"),
     ("bsk aja gmn kak", "2026-07-30"),
     ("ntar sore aja ya kak", "2026-07-29"),
     ("malem ini bisa kak? jam 7 gt", "2026-07-29")],
)
def test_next_week_lands_in_next_week(text, expected):
    """Adding seven days to "the next Tuesday" overshoots whenever that
    Tuesday is already next week — "senin depan" landed on the 10th."""
    from bd_bot.engine import _requested_day

    assert str(_requested_day(text, _now())) == expected


@pytest.mark.parametrize(
    "text,expected",
    [("besok gbs, lusa ya", "2026-07-31"),
     ("duh hari ini penuh, besok jg full, jumat aja", "2026-07-31"),
     ("lusa ya kak, besok aku full", "2026-07-31"),
     ("aku gabisa hari ini kl besok bisa ga ya?", "2026-07-30"),
     ("besok bisa ga ya kak?", "2026-07-30")],
)
def test_a_refusal_after_the_day_still_counts(text, expected):
    """Indonesian puts the refusal on either side — "gbs hari ini" and "hari
    ini penuh" say the same thing. But a bare "ga" AFTER a day is usually the
    question particle: "besok bisa ga ya?" is asking, not refusing."""
    from bd_bot.engine import _requested_day

    assert str(_requested_day(text, _now())) == expected


@pytest.mark.parametrize(
    "text",
    ["asal jangan pagi ya kak", "jangan siang2 ya, lg jam rame toko",
     "kalo bisa jangan pas jam makan siang",
     "pagi aku gabisa, anter anak sekolah dulu",
     "besok bisa sih tp jangan pagi2"],
)
def test_a_refused_time_of_day_is_not_a_request(text):
    """"asal jangan pagi" yielded 9, 10, 11 — so the bot would offer back
    exactly the hours the contact had just ruled out. The same rudeness as
    proposing a day they refused, one level down."""
    from bd_bot.engine import _requested_hours, _strip_dates

    assert _requested_hours(_strip_dates(text), 9) == set()


@pytest.mark.parametrize(
    "text,hours",
    [("dari jam 10 sampe 12 aku kosong", [10, 11, 12]),
     ("aku available nya 14.00-16.00 ya kak", [14, 15, 16]),
     ("jam 9-11 aku free", [9, 10, 11]),
     ("abis jam 4 aja ya kak", [16, 17, 18]),
     ("jam 3 ke atas bebas", [15, 16, 17, 18]),
     ("sebelum jam 11 ya kalo bisa", [9, 10]),
     ("paling telat mulai jam 2 ya", [9, 10, 11, 12, 13, 14])],
)
def test_spans_and_open_ended_bounds(text, hours):
    """A span means every hour inside it, not just its ends. "sebelum jam 11"
    stops before 11 and must not also yield 11 as a plain time; "paling telat
    mulai jam 2" is an upper bound, not also "from 2 onward"."""
    from bd_bot.engine import _requested_hours, _strip_dates

    assert sorted(_requested_hours(_strip_dates(text), 9)) == hours


@pytest.mark.parametrize(
    "text,expected",
    [("31 juli bisa ga? jam 2", "2026-07-31"),
     ("3 agustus ya kak", "2026-08-03"),
     ("tgl 1 aja biar awal bulan", "2026-08-01")],
)
def test_dates_written_with_a_month_name(text, expected):
    """"3 agustus" produced no day at all, and worse, the 3 was read as an
    hour — the meeting would have been offered at 15.00 today."""
    from bd_bot.engine import _requested_day

    assert str(_requested_day(text, _now())) == expected


def test_an_hour_span_is_never_a_date():
    """"jam 9-11 aku free" resolved to 9 November — the general form of the
    13.00-15.00 failure found in live testing."""
    from bd_bot.engine import _requested_day

    assert _requested_day("jam 9-11 aku free", _now()) is None


def test_a_week_qualifier_carries_onto_a_later_weekday(engine):
    """The real exchange: "kalau minggu depan apakah bisa?" then "kamis jam
    14.00 ya kak". Read message by message, "minggu depan" carries no day of
    its own and is discarded, so the bare "kamis" resolved to tomorrow — the
    bot confirmed Kamis 30/07 to someone who had just said next week."""
    from bd_bot.engine import _day_in_context

    got = _day_in_context(
        ["kamis jam 14.00 ya kak", "kalau minggu depan apakah bisa?"], _now()
    )
    assert str(got) == "2026-08-06"


def test_an_explicitly_near_day_overrides_the_earlier_week(engine):
    """"minggu depan" then "besok aja deh" is a change of mind, not a
    qualifier to carry forward."""
    from bd_bot.engine import _day_in_context

    got = _day_in_context(
        ["besok aja deh", "kalau minggu depan apakah bisa?"], _now()
    )
    assert str(got) == "2026-07-30"


def test_a_weekday_with_no_earlier_context_is_this_week(engine):
    from bd_bot.engine import _day_in_context

    assert str(_day_in_context(["kamis jam 14.00 ya kak"], _now())) == "2026-07-30"


def test_the_custom_answer_promises_nothing_concrete():
    """"tentu bisa disesuaikan dengan kombinasi paket yang ada" reads as a
    commitment to a shape nobody has priced. Say yes, then take it to the
    meeting."""
    from bd_bot import templates
    from bd_bot.config import Settings
    from bd_bot.models import Conversation

    text = templates.render(
        "REPLY_TANYA_CUSTOM",
        Conversation(jid="628@s.whatsapp.net", brand="X"), Settings(),
    ).text.lower()
    assert "bisa" in text, "it should still say yes"
    assert "meeting" in text, "it should take the detail to the meeting"
    for promise in ("budget", "kombinasi paket", "bertingkat"):
        assert promise not in text, f"still promising {promise!r}"


@pytest.mark.parametrize(
    "text",
    ["siang, saya interested kak, namun apakah bisa custom?",
     "selamat pagi kak", "pagi kak, harganya berapa?",
     "malam kak salam kenal", "sore kak, mau tanya"],
)
def test_a_greeting_is_not_a_time_request(text):
    """"siang" is overwhelmingly the hello. Read as 12.00-13.00, it made the
    bot confirm a slot in that range to someone who had named no time —
    "siang, saya interested kak" was answered with "Kamis 30/07 jam 12.00
    saya catat ya"."""
    from bd_bot.engine import _requested_hours, _strip_dates

    assert _requested_hours(_strip_dates(text), 9) == set()


@pytest.mark.parametrize(
    "text,hours",
    [("sorean aja ya kak", [15, 16, 17]),     # the suffix settles it
     ("siangan aja kak", [12, 13]),
     ("besok pagi bisa kak?", [9, 10, 11]),   # a scheduling cue settles it
     ("bisanya siang kak", [12, 13]),
     ("nanti siang jam 1 bisa ga", [13])],
)
def test_a_real_time_request_still_reads(text, hours):
    from bd_bot.engine import _requested_hours, _strip_dates

    assert sorted(_requested_hours(_strip_dates(text), 9)) == hours


def test_a_slot_is_confirmed_only_on_a_complete_choice(engine, monkeypatch):
    """"boleh kak tapi aku gabisa minggu ini bisanya minggu depan" names
    neither a day nor an hour, and was answered with a confirmed slot for
    tomorrow. Anything short of both goes back as a question."""
    from datetime import datetime, timedelta

    from bd_bot import gcal
    from bd_bot.models import Conversation, Node

    eng, transport, cfg, store = engine
    now = datetime(2026, 7, 29, 15, 43, tzinfo=cfg.tz)
    store.upsert(Conversation(jid=JID, node=Node.SCHEDULING, brand="X"))
    for t in ("boleh kak tapi aku gabisa minggu ini bisanya minggu depan",
              "siang, saya interested kak, namun apakah bisa custom?"):
        store.log_message(JID, "in", t, now)
    free = [
        (now + timedelta(days=d)).replace(hour=h, minute=0, second=0, microsecond=0)
        for d in range(9) for h in range(9, 19)
    ]
    monkeypatch.setattr(gcal, "free_slots", lambda c, n, limit=12: free)

    transport.sent.clear()
    eng._propose_slots(store.get(JID), _fallback_msg(), now)
    body = transport.sent[0][1]
    assert "saya catat" not in body, f"confirmed a slot nobody chose: {body!r}"
    assert "kosong" in body, "it should offer availability instead"


@pytest.mark.parametrize(
    "said,why",
    [("hari kamis aja kak", "a day with no hour — the time would be guessed"),
     ("jam 2 aja ya", "an hour with no day — the date would be guessed")],
)
def test_half_a_choice_is_not_a_confirmation(engine, monkeypatch, said, why):
    from datetime import datetime, timedelta

    from bd_bot import gcal
    from bd_bot.models import Conversation, Node

    eng, transport, cfg, store = engine
    now = datetime(2026, 7, 29, 10, 0, tzinfo=cfg.tz)
    store.upsert(Conversation(jid=JID, node=Node.SCHEDULING, brand="X"))
    store.log_message(JID, "in", said, now)
    free = [
        (now + timedelta(days=d)).replace(hour=h, minute=0, second=0, microsecond=0)
        for d in range(9) for h in range(9, 19)
    ]
    monkeypatch.setattr(gcal, "free_slots", lambda c, n, limit=12: free)

    transport.sent.clear()
    eng._propose_slots(store.get(JID), _fallback_msg(), now)
    assert "saya catat" not in transport.sent[0][1], why


def test_a_complete_choice_is_confirmed(engine, monkeypatch):
    """The other direction: naming both must still book without re-asking."""
    from datetime import datetime, timedelta

    from bd_bot import gcal
    from bd_bot.models import Conversation, Node

    eng, transport, cfg, store = engine
    now = datetime(2026, 7, 29, 10, 0, tzinfo=cfg.tz)
    store.upsert(Conversation(jid=JID, node=Node.SCHEDULING, brand="X"))
    store.log_message(JID, "in", "kamis jam 2 aja ya kak", now)
    free = [
        (now + timedelta(days=d)).replace(hour=h, minute=0, second=0, microsecond=0)
        for d in range(9) for h in range(9, 19)
    ]
    monkeypatch.setattr(gcal, "free_slots", lambda c, n, limit=12: free)

    transport.sent.clear()
    eng._propose_slots(store.get(JID), _fallback_msg(), now)
    body = transport.sent[0][1]
    assert "saya catat" in body and "14.00" in body, body


# Under pm2 stdin is an open IPC socket, not a closed pipe, so input() blocks
# forever rather than raising EOFError. On 8 Aug 2026 that froze the timer
# thread on the first scheduled follow-up — no follow-up fired again, while the
# control API still reported the bot as connected.
class _Stdin:
    """Stand-in for sys.stdin with a controllable isatty()."""

    def __init__(self, tty: bool) -> None:
        self._tty = tty

    def isatty(self) -> bool:
        return self._tty


def _approval_engine(tmp_path):
    # Settings() directly, never config.load(): that reads the real .env and
    # os.environ.setdefault()s every key into the process, which switches the
    # rest of the suite onto live LLM calls.
    cfg = Settings()
    cfg.db_path = tmp_path / "t.sqlite3"
    cfg.require_approval = True
    cfg.auto_reply = True
    engine = Engine(cfg, Store(cfg.db_path), MockTransport(echo=False))
    # Default to the gated class; tests that care about follow-ups set it.
    engine._context = "blast"
    return engine


def test_approval_declines_instead_of_blocking_without_a_terminal(monkeypatch, tmp_path):
    engine = _approval_engine(tmp_path)
    monkeypatch.setattr(sys, "stdin", _Stdin(tty=False))
    monkeypatch.setattr("builtins.input", lambda *_: pytest.fail(
        "input() must not be called when nothing can answer it"))
    assert engine._approved("628@s.whatsapp.net", "halo") is False


def test_approval_still_prompts_on_a_real_terminal(monkeypatch, tmp_path):
    engine = _approval_engine(tmp_path)
    monkeypatch.setattr(sys, "stdin", _Stdin(tty=True))
    monkeypatch.setattr("builtins.input", lambda *_: "y")
    assert engine._approved("628@s.whatsapp.net", "halo") is True
    monkeypatch.setattr("builtins.input", lambda *_: "n")
    assert engine._approved("628@s.whatsapp.net", "halo") is False


def test_scheduled_followups_send_without_approval(monkeypatch, tmp_path):
    """The gate stops the bot STARTING conversations, not continuing them.

    Gating follow-ups too made COLD_FU1-4 and WARM_* unsendable on a server,
    where nothing can answer the prompt — the ladder under test never ran.
    """
    engine = _approval_engine(tmp_path)
    monkeypatch.setattr(sys, "stdin", _Stdin(tty=False))
    monkeypatch.setattr("builtins.input", lambda *_: pytest.fail("must not prompt"))
    engine._context = "timer"
    assert engine._approved("628@s.whatsapp.net", "follow-up") is True


def test_cold_blasts_are_still_gated(monkeypatch, tmp_path):
    """An unattended process must not be able to cold-message a new contact."""
    engine = _approval_engine(tmp_path)
    monkeypatch.setattr(sys, "stdin", _Stdin(tty=False))
    monkeypatch.setattr("builtins.input", lambda *_: pytest.fail("must not prompt"))
    engine._context = "blast"
    assert engine._approved("628@s.whatsapp.net", "opening") is False


def test_queued_campaign_openings_send_without_approval(monkeypatch, tmp_path):
    """A row typed into the dashboard IS the approval; re-asking at a terminal
    nobody watches would mean no outreach ever leaves."""
    engine = _approval_engine(tmp_path)
    monkeypatch.setattr(sys, "stdin", _Stdin(tty=False))
    monkeypatch.setattr("builtins.input", lambda *_: pytest.fail("must not prompt"))
    engine._context = "campaign"
    assert engine._approved("628@s.whatsapp.net", "opening") is True


# --- the focus answer is only the answer when we asked (24 Sep 2026) ----------


def test_a_focus_answer_after_our_focus_question_is_understood(engine):
    """Repro from parent testing: form, "harganya berapa", then "Lebih ke
    sales kak" — which was UNKNOWN, answered with "boleh dijelaskan lebih
    detail maksud Kak?", and escalated. Two of those is a handover for a
    lead who was answering our own question."""
    eng, transport, cfg, store = engine
    _qna_convo(store, brand="Glow")
    transport.feed(JID, "Harganya berapa ya kak?")
    assert "awareness" in transport.sent[-1][1].lower()
    n = len(transport.sent)
    transport.feed(JID, "Lebih ke sales kak")
    said = " ".join(t for _, t in transport.sent[n:])
    assert "Siap, Kak" in said and "hari dan jam berapa" in said
    assert "dijelaskan sedikit lebih detail" not in said
    assert store.get(JID).unknown_streak == 0
    assert not [e for e in store.open_escalations() if "unclassified" in e["reason"]]

    n = len(transport.sent)
    transport.feed(JID, "dua-duanya kak")  # a second answer, after our invite — no question asked
    said = " ".join(t for _, t in transport.sent[n:])
    assert "penjualan sembari" not in said, "answered a focus question we did not put"


def test_a_focus_word_when_we_did_not_ask_is_not_hijacked(engine):
    """"sales" after we answered where the office is answers nothing of
    ours: the rule fires, the engine sees no focus question before it, and
    the honest label (UNKNOWN) asks what they meant."""
    eng, transport, cfg, store = engine
    _qna_convo(store, brand="Glow")
    transport.feed(JID, "kantornya dimana kak?")
    # The location answer, then the meeting gadget — neither asks the focus.
    assert "Seasons City" in " ".join(t for _, t in transport.sent)
    n = len(transport.sent)
    transport.feed(JID, "sales")
    said = " ".join(t for _, t in transport.sent[n:])
    assert "Campaign Affiliate memang kami arahkan" not in said
    assert store.recent_inbound_intents(JID, limit=1) == ["unknown"]
