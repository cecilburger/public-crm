"""Demo mode: collapse the flow's waits so testers can walk a whole path.

The flowchart's ladders span days — nobody finds flaws in a follow-up they
have to wait until Thursday to read. Demo mode fires those timers seconds
apart and puts a marker ("⏩ *1 hari kemudian*") in front of each one, so the
compressed transcript still reads like the real schedule. These cover the two
things that makes it trustworthy: the compression is total (no wait survives
to stall a session), and it changes only *when* messages go out — the text,
the order, and the caps are the production ones.
"""

from __future__ import annotations

import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bd_bot.config import Settings  # noqa: E402
from bd_bot.engine import Engine, _wait_label  # noqa: E402
from bd_bot.models import Conversation, Node, Timer  # noqa: E402
from bd_bot.storage import Store  # noqa: E402
from bd_bot.transport.mock import MockTransport  # noqa: E402

JID = "628123@s.whatsapp.net"


def _make(tmp_path, *, demo: bool):
    cfg = Settings()
    cfg.db_path = tmp_path / f"{'demo' if demo else 'prod'}.sqlite3"
    cfg.dry_run = False
    cfg.require_approval = False
    cfg.auto_reply = True
    cfg.min_seconds_between_sends = 0
    cfg.use_llm_replies = False
    cfg.demo_mode = demo
    cfg.company_profile_pdf = tmp_path / "profile.pdf"
    cfg.company_profile_pdf.write_bytes(b"%PDF-1.4 fake")
    cfg.opening_dir = tmp_path / "opening"
    cfg.opening_dir.mkdir(exist_ok=True)
    (cfg.opening_dir / "deck.pdf").write_bytes(b"%PDF-1.4 fake deck")
    store = Store(cfg.db_path)
    transport = MockTransport(echo=False)
    eng = Engine(cfg, store, transport)
    transport.start(eng.handle_inbound)
    return eng, transport, cfg, store


@pytest.fixture
def demo(tmp_path):
    eng, transport, cfg, store = _make(tmp_path, demo=True)
    yield eng, transport, cfg, store
    store.close()


# --- compression -----------------------------------------------------------


def test_blast_arms_the_cold_ladder_seconds_away(demo):
    eng, _, cfg, store = demo
    eng.blast(JID, "Cika", "Brand Uji")

    pending = store.pending(JID)
    assert len(pending) == 1
    ahead = pending[0].fire_at - eng.now()
    assert ahead <= timedelta(seconds=cfg.demo_gap_seconds + 5)


def test_production_keeps_the_real_delay(tmp_path):
    """The compression must be demo-only — the whole point of the pilot is
    that the schedule the testers grade is the schedule brands will get."""
    eng, _, cfg, store = _make(tmp_path, demo=False)
    try:
        eng.blast(JID, "Cika", "Brand Uji")
        [job] = store.pending(JID)
        # The point is that it is NOT the demo compression. Any wall-clock
        # bound is wrong here: first_cold_touch is 16:00 today or +4h, so a
        # ">5 minutes" assertion fails whenever the suite runs at 15:56.
        # What actually distinguishes the two is the compression itself.
        assert job.fire_at > eng.now()
        assert job.fire_at - eng.now() > timedelta(
            seconds=cfg.demo_gap_seconds * 3
        ), "the delay looks compressed"
        assert job.payload.get("wait_label", "") == ""
    finally:
        store.close()


def test_timers_queue_in_flowchart_order(demo):
    """A fan-out that schedules several timers at once (booking arms two
    reminders and a meeting-end) must not collapse them onto one instant —
    they would then fire in insertion order by luck rather than by design."""
    eng, _, cfg, store = demo
    now = eng.now()
    for offset in (timedelta(days=5), timedelta(days=1), timedelta(days=3)):
        eng._schedule(JID, Timer.COLD_FU2, now + offset, now)

    fire_ats = [j.fire_at for j in store.pending(JID)]
    assert len(set(fire_ats)) == 3, "compressed timers landed on the same second"
    gaps = [b - a for a, b in zip(fire_ats, fire_ats[1:])]
    assert all(g >= timedelta(seconds=cfg.demo_gap_seconds) for g in gaps)


# --- the marker ------------------------------------------------------------


def test_firing_announces_the_wait_it_skipped(demo):
    eng, transport, _, store = demo
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Cika"))
    eng._schedule(JID, Timer.COLD_FU2, eng.now() + timedelta(days=1), eng.now())
    [job] = store.pending(JID)

    transport.sent.clear()
    eng.handle_timer(job.id, JID, job.timer, job.payload)

    assert transport.sent, "the follow-up itself never went out"
    assert transport.sent[0][1] == "⏩ *1 hari kemudian*"
    assert len(transport.sent) > 1, "marker sent but the follow-up did not follow"


def test_labels_are_relative_to_the_message_above_them(demo):
    """Booking arms two reminders and a meeting-end in one breath. Labelled
    from `now` they would read 21 jam / 22 jam / 24 jam — telling a tester who
    just read "21 jam kemudian" to expect the next message 22 hours after a
    moment the chat has already passed."""
    eng, _, _, store = demo
    now = eng.now()
    meeting = now + timedelta(hours=23)
    eng._schedule(JID, Timer.REMINDER, meeting - timedelta(hours=2), now)
    eng._schedule(JID, Timer.REMINDER, meeting - timedelta(hours=1), now)
    eng._schedule(JID, Timer.MEETING_END, meeting + timedelta(hours=1), now)

    labels = [j.payload["wait_label"] for j in store.pending(JID)]
    assert labels == ["21 jam kemudian", "1 jam kemudian", "2 jam kemudian"]


def test_silent_timer_sends_no_marker(demo):
    """MEETING_END only escalates to a human. A jump marker with no message
    under it reads as a reply that failed to arrive."""
    eng, transport, _, store = demo
    store.upsert(
        Conversation(
            jid=JID,
            node=Node.SCHEDULED,
            name="Cika",
            meeting_at=eng.now() + timedelta(hours=1),
        )
    )
    eng._schedule(JID, Timer.MEETING_END, eng.now() + timedelta(days=1), eng.now())
    [job] = store.pending(JID)

    transport.sent.clear()
    eng.handle_timer(job.id, JID, job.timer, job.payload)
    assert not transport.sent
    assert store.open_escalations(), "the meeting-end escalation was lost"


def test_marker_is_not_charged_to_the_daily_cap(demo):
    """The marker is scaffolding for the test session. Counting it would let
    a compressed ladder exhaust the cap and silence the bot mid-session."""
    eng, _, cfg, store = demo
    store.upsert(Conversation(jid=JID, node=Node.BLASTED))
    before = store.sent_today(eng.now())
    eng._send_marker(JID, "1 hari kemudian")
    assert store.sent_today(eng.now()) == before


def test_no_marker_in_production(tmp_path):
    eng, transport, _, store = _make(tmp_path, demo=False)
    try:
        store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Cika"))
        store.schedule(JID, Timer.COLD_FU2, eng.now() - timedelta(seconds=1))
        [job] = store.pending(JID)
        transport.sent.clear()
        eng.handle_timer(job.id, JID, job.timer, {"wait_label": "1 hari kemudian"})
        assert not any("kemudian*" in text for _, text in transport.sent)
    finally:
        store.close()


# --- the sending window ----------------------------------------------------


def test_out_of_hours_timer_still_fires_in_demo(demo):
    """A test session runs when the testers are free. Re-queueing a follow-up
    to tomorrow's window — correct in production — would just end the test."""
    eng, transport, cfg, store = demo
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Cika"))
    eng.within_send_window = lambda when: False  # pretend it is 23:00
    store.schedule(JID, Timer.COLD_FU2, eng.now() - timedelta(seconds=1))
    [job] = store.pending(JID)

    transport.sent.clear()
    eng.handle_timer(job.id, JID, job.timer, {"wait_label": "1 hari kemudian"})
    assert transport.sent
    # It fired, so the ladder moved on: what is pending now is the *next*
    # rung, not COLD_FU2 pushed to tomorrow morning.
    assert Timer.COLD_FU2 not in {j.timer for j in store.pending(JID)}


def test_out_of_hours_timer_is_requeued_in_production(tmp_path):
    eng, transport, _, store = _make(tmp_path, demo=False)
    try:
        store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Cika"))
        eng.within_send_window = lambda when: False
        store.schedule(JID, Timer.COLD_FU2, eng.now() - timedelta(seconds=1))
        [job] = store.pending(JID)
        transport.sent.clear()
        eng.handle_timer(job.id, JID, job.timer)
        assert not transport.sent
        assert store.pending(JID), "out-of-hours timer was dropped, not re-queued"
    finally:
        store.close()


# --- labels ----------------------------------------------------------------


@pytest.mark.parametrize(
    "delay,expected",
    [
        (timedelta(seconds=30), ""),          # too short to be worth naming
        (timedelta(minutes=30), "30 menit kemudian"),
        (timedelta(hours=4), "4 jam kemudian"),
        (timedelta(hours=6), "6 jam kemudian"),
        (timedelta(days=1), "1 hari kemudian"),
        (timedelta(days=3), "3 hari kemudian"),
        (timedelta(days=5), "5 hari kemudian"),
        # H+1 measured from a real clock is never exactly 24h; it must still
        # read as a day, not as "23 jam".
        (timedelta(hours=23, minutes=52), "1 hari kemudian"),
    ],
)
def test_wait_label(delay, expected):
    assert _wait_label(delay) == expected


def test_tick_passes_the_label_through(demo):
    """The label is written by the process that schedules and read by the one
    that fires — for a `blast` then `run`, those are different processes, so
    it has to survive the round-trip through SQLite."""
    eng, transport, cfg, store = demo
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Cika"))
    eng._schedule(JID, Timer.COLD_FU2, eng.now() + timedelta(days=1), eng.now())
    # Reopen: the firing process has none of the scheduling one's state.
    store.close()
    store = Store(cfg.db_path)
    eng2 = Engine(cfg, store, transport)
    for job in store.pending(JID):
        store.db.execute(
            "UPDATE jobs SET fire_at = ? WHERE id = ?",
            ((eng2.now() - timedelta(seconds=1)).isoformat(), job.id),
        )

    transport.sent.clear()
    assert eng2.tick() == 1
    assert transport.sent[0][1] == "⏩ *1 hari kemudian*"
    store.close()


# --- concurrency: one terminal, several threads ----------------------------


def test_two_threads_never_prompt_at_once(demo):
    """The timer loop, the inbound dispatcher, and the startup blast hook all
    reach `_send`. Unserialised, two of them sit on `input()` at the same
    terminal and the operator cannot tell which prompt they just answered."""
    import threading

    eng, _, cfg, _ = demo
    cfg.require_approval = True
    cfg.auto_reply = False

    guard = threading.Lock()
    inside = threading.Semaphore(0)
    release = threading.Event()
    open_prompts = 0
    peak = 0

    def _prompt(jid, text):
        nonlocal open_prompts, peak
        with guard:
            open_prompts += 1
            peak = max(peak, open_prompts)
        inside.release()
        release.wait(2)
        with guard:
            open_prompts -= 1
        return True

    eng._approved = _prompt
    eng._context = "timer"

    # `_raw_send` takes the same lock around the same approval, and touches no
    # database — so a thread that outlives the test cannot die on a closed
    # connection and turn a lock regression into a confusing SQLite error.
    threads = [
        threading.Thread(target=lambda: eng._raw_send(JID, "halo"))
        for _ in range(3)
    ]
    try:
        for t in threads:
            t.start()
        assert inside.acquire(timeout=2), "no thread ever reached the prompt"
    finally:
        release.set()
        for t in threads:
            t.join(timeout=5)

    assert not any(t.is_alive() for t in threads)
    assert peak == 1, f"{peak} prompts were open at once — approvals are not serialised"


# --- a blast that never left ------------------------------------------------


def test_declined_blast_leaves_nothing_behind(demo):
    """`apply` runs SetNode and Schedule whether or not the Send succeeded. If
    the opening is declined, the contact must not be left looking blasted —
    the retry would be refused as "already in flow" and the armed COLD_FU1
    would later chase someone who was never greeted."""
    eng, transport, cfg, store = demo
    cfg.require_approval = True
    cfg.auto_reply = False
    eng._approved = lambda jid, text: False  # operator says N

    assert eng.blast(JID, "Cika", "Brand Uji") is False
    convo = store.get(JID)
    assert convo is None or convo.node is Node.NEW, "contact looks blasted"
    assert not store.pending(JID), "a follow-up was armed for an ungreeted contact"
    assert not transport.sent


def test_a_retry_after_a_declined_blast_gets_through(demo):
    """The point of the rollback: the second attempt must actually send."""
    eng, transport, cfg, store = demo
    cfg.require_approval = True
    cfg.auto_reply = False

    eng._approved = lambda jid, text: False
    eng.blast(JID, "Cika", "Brand Uji")
    eng._approved = lambda jid, text: True
    assert eng.blast(JID, "Cika", "Brand Uji") is True

    assert store.get(JID).node is Node.BLASTED
    assert store.pending(JID), "the cold ladder was not armed on the retry"
    assert any("Perkenalkan" in t for _, t in transport.sent)


def test_a_delivered_blast_still_arms_the_ladder(demo):
    """The rollback must not fire on the happy path."""
    eng, _, _, store = demo
    assert eng.blast(JID, "Cika", "Brand Uji") is True
    assert store.get(JID).node is Node.BLASTED
    assert [j.timer for j in store.pending(JID)] == [Timer.COLD_FU1]


# --- a test number that carries real traffic --------------------------------


def test_demo_ignores_anyone_who_is_not_a_tester(demo):
    """The pilot number received a stranger's payment details mid-session.
    With AUTO_REPLY on, that person would have been answered with a cold
    sales pitch. Outside the allowlist: no reply, no conversation, no record."""
    eng, transport, cfg, store = demo
    cfg.restart_jids = frozenset({JID})
    stranger = "628999888777@s.whatsapp.net"

    eng.handle_inbound(stranger, "kiki", "RIZKY MAHARANI\nBank Mandiri\n1570013421749")

    assert not transport.sent, "the bot answered a stranger"
    assert store.get(stranger) is None, "a stranger became a conversation"
    assert not store.last_inbound_text(stranger)


def test_demo_still_answers_a_listed_tester(demo):
    eng, transport, cfg, store = demo
    cfg.restart_jids = frozenset({JID})
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="Cika"))

    eng.handle_inbound(JID, "Cika", "harganya berapa?")
    assert transport.sent, "a listed tester was ignored"


def test_production_answers_everyone(tmp_path):
    """The allowlist is a demo-mode guard, not a new production behaviour —
    real brands reply from numbers nobody put on a list."""
    eng, transport, cfg, store = _make(tmp_path, demo=False)
    try:
        cfg.restart_jids = frozenset()
        store.upsert(Conversation(jid=JID, node=Node.QNA, name="Cika"))
        eng.handle_inbound(JID, "Cika", "harganya berapa?")
        assert transport.sent
    finally:
        store.close()


# --- attachments must not take the conversation down with them --------------


class _FlakyTransport(MockTransport):
    """Delivers text, then dies — a socket replaced mid-blast."""

    def send_document(self, jid, path, filename, caption=""):
        raise RuntimeError("failed to send message node: websocket not connected")

    def send_image(self, jid, path, caption=""):
        raise RuntimeError("failed to send message node: websocket not connected")


def test_a_failed_attachment_keeps_the_conversation(tmp_path):
    """Observed live: the socket was replaced while the opening's PDF was in
    flight. The raise unwound `apply` before it saved anything, so the contact
    held a greeting the bot had no record of — un-blasted in the database and
    due to be greeted all over again."""
    eng, _, cfg, store = _make(tmp_path, demo=True)
    eng.transport = _FlakyTransport(echo=False)
    try:
        assert eng.blast(JID, "Cika", "Brand Uji") is True

        convo = store.get(JID)
        assert convo is not None, "the conversation was lost with the attachment"
        assert convo.node is Node.BLASTED
        assert store.pending(JID), "the cold ladder was never armed"
    finally:
        store.close()


def test_the_greeting_text_is_still_recorded(tmp_path):
    eng, _, _, store = _make(tmp_path, demo=True)
    eng.transport = _FlakyTransport(echo=False)
    try:
        eng.blast(JID, "Cika", "Brand Uji")
        assert store.sent_today(eng.now()) == 1, "the delivered text went unlogged"
    finally:
        store.close()


# --- one pairing, one process ----------------------------------------------


def test_a_second_process_is_refused_the_session(tmp_path):
    """WhatsApp allows one live connection per linked device: a second one
    replaces the first, which reconnects and replaces it back, and sends die
    mid-flight. A day-old `run` that a Ctrl-C had not killed did exactly this
    during the pilot."""
    from bd_bot import cli

    cfg = Settings()
    cfg.session_dir = tmp_path / "wa-session"

    held = cli.claim_session(cfg)
    try:
        with pytest.raises(RuntimeError) as caught:
            cli.claim_session(cfg)
        message = str(caught.value)
        assert str(__import__("os").getpid()) in message, "the holder's pid is not named"
        assert "kill" in message, "no instruction for how to resolve it"
    finally:
        held.close()

    # Released — the next process may take it.
    again = cli.claim_session(cfg)
    again.close()


# --- don't chase a tester who is still typing -------------------------------


def test_a_timer_waits_while_the_contact_is_still_talking(demo):
    """Compressed delays all mean "they went quiet on us". A tester typing a
    reply on a phone takes longer than the gap, and being chased mid-sentence
    reads as a bug in the bot rather than the compression it is."""
    eng, transport, cfg, store = demo
    cfg.demo_idle_seconds = 120
    store.upsert(
        Conversation(
            jid=JID, node=Node.BLASTED, name="Cika",
            last_inbound_at=eng.now() - timedelta(seconds=5),  # mid-conversation
        )
    )
    eng._schedule(JID, Timer.COLD_FU2, eng.now() + timedelta(days=1), eng.now())
    [job] = store.pending(JID)

    transport.sent.clear()
    eng.handle_timer(job.id, JID, job.timer, job.payload)

    assert not transport.sent, "the bot nudged someone who had just spoken"
    held = store.pending(JID)
    assert held, "the nudge was dropped instead of held"
    assert held[0].payload["wait_label"] == "1 hari kemudian", "label lost on hold"
    assert held[0].payload.get("real_at"), "real_at lost on hold"


def test_the_timer_fires_once_the_contact_goes_quiet(demo):
    eng, transport, cfg, store = demo
    cfg.demo_idle_seconds = 120
    store.upsert(
        Conversation(
            jid=JID, node=Node.BLASTED, name="Cika",
            last_inbound_at=eng.now() - timedelta(seconds=300),  # long silent
        )
    )
    eng._schedule(JID, Timer.COLD_FU2, eng.now() + timedelta(days=1), eng.now())
    [job] = store.pending(JID)

    transport.sent.clear()
    eng.handle_timer(job.id, JID, job.timer, job.payload)
    assert transport.sent[0][1] == "⏩ *1 hari kemudian*"


def test_a_contact_who_never_replied_is_paced_by_our_own_last_message(demo):
    """Seen live: a tester who had not replied yet had no inbound to measure
    against, so the whole ladder emptied onto them — opening plus three
    follow-ups inside ninety seconds."""
    eng, transport, cfg, store = demo
    cfg.demo_idle_seconds = 120
    store.upsert(
        Conversation(
            jid=JID, node=Node.BLASTED, name="Cika",
            last_outbound_at=eng.now() - timedelta(seconds=5),  # just greeted
        )
    )
    eng._schedule(JID, Timer.COLD_FU2, eng.now() + timedelta(days=1), eng.now())
    [job] = store.pending(JID)

    transport.sent.clear()
    eng.handle_timer(job.id, JID, job.timer, job.payload)
    assert not transport.sent, "the ladder piled onto a contact we just messaged"
    assert store.pending(JID), "the rung was dropped rather than paced"


def test_the_ladder_still_runs_on_a_silent_contact(demo):
    """Pacing must not become a stall: once the gap has genuinely passed, a
    contact who never replies still walks the whole ladder — that path is the
    one the cold follow-ups exist for."""
    eng, transport, cfg, store = demo
    cfg.demo_idle_seconds = 120
    store.upsert(
        Conversation(
            jid=JID, node=Node.BLASTED, name="Cika",
            last_outbound_at=eng.now() - timedelta(seconds=300),
        )
    )
    eng._schedule(JID, Timer.COLD_FU2, eng.now() + timedelta(days=1), eng.now())
    [job] = store.pending(JID)

    transport.sent.clear()
    eng.handle_timer(job.id, JID, job.timer, job.payload)
    assert transport.sent, "the cold ladder stalled on a contact who never replied"


def test_production_never_holds_a_timer(tmp_path):
    """Real follow-ups fire on the flowchart's schedule, not on how recently
    the brand happened to type."""
    eng, transport, _, store = _make(tmp_path, demo=False)
    try:
        eng.within_send_window = lambda when: True  # not what is under test
        store.upsert(
            Conversation(
                jid=JID, node=Node.BLASTED, name="Cika",
                last_inbound_at=eng.now() - timedelta(seconds=1),
            )
        )
        store.schedule(JID, Timer.COLD_FU2, eng.now() - timedelta(seconds=1))
        [job] = store.pending(JID)
        eng.handle_timer(job.id, JID, job.timer, job.payload)
        assert transport.sent, "a production follow-up was held back"
    finally:
        store.close()


# --- backlog is not conversation --------------------------------------------


def test_backlogged_messages_are_not_answered(demo):
    """WhatsApp replays everything that arrived while the device was offline
    the moment it reconnects. During the pilot the bot answered a days-old
    personal exchange as though it had just been typed."""
    eng, transport, cfg, store = demo
    cfg.restart_jids = frozenset({JID})
    cfg.demo_stale_seconds = 300
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="Cika"))

    eng.handle_inbound(
        JID, "Cika", "harganya berapa?",
        sent_at=eng.now() - timedelta(hours=9),
    )

    assert not transport.sent, "the bot answered a message from nine hours ago"
    assert not store.last_inbound_text(JID), "backlog entered the conversation"


def test_a_live_reply_is_answered(demo):
    eng, transport, cfg, store = demo
    cfg.restart_jids = frozenset({JID})
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="Cika"))

    eng.handle_inbound(
        JID, "Cika", "harganya berapa?", sent_at=eng.now() - timedelta(seconds=3)
    )
    assert transport.sent, "a live reply was mistaken for backlog"


def test_an_unknown_timestamp_is_not_treated_as_stale(demo):
    """`sent_at=None` means the transport could not say. Guessing "old" would
    silence the bot against any transport that omits the field."""
    eng, transport, cfg, store = demo
    cfg.restart_jids = frozenset({JID})
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="Cika"))

    eng.handle_inbound(JID, "Cika", "harganya berapa?")
    assert transport.sent


def test_production_still_answers_a_message_sent_during_downtime(tmp_path):
    """A brand who replied while the bot restarted is waiting for an answer —
    dropping that is a lost lead, so the cutoff is demo-only."""
    eng, transport, _, store = _make(tmp_path, demo=False)
    try:
        store.upsert(Conversation(jid=JID, node=Node.QNA, name="Cika"))
        eng.handle_inbound(
            JID, "Cika", "harganya berapa?", sent_at=eng.now() - timedelta(hours=9)
        )
        assert transport.sent
    finally:
        store.close()


# --- our own words coming back ----------------------------------------------

OPENING = (
    "Selamat siang, Kak. Perkenalkan, saya Grace dari Business Development "
    "MCNAsia.biz — Official Partner TikTok & Shopee. Kami mengelola campaign "
    "affiliate untuk brand seperti Unilever dan Mondelez."
)


def test_a_forwarded_copy_of_our_own_message_is_not_answered(demo):
    """Seen live: a contact forwarded the opening back to the bot, which read
    it as a portfolio question and replied with the greeting again."""
    eng, transport, cfg, store = demo
    cfg.restart_jids = frozenset({JID})
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="Cika"))
    store.log_message(JID, "out", OPENING, eng.now())

    transport.sent.clear()
    eng.handle_inbound(JID, "Cika", OPENING)

    assert not transport.sent, "the bot answered its own message"
    assert store.open_escalations(), "the echo was swallowed instead of escalated"


def test_a_quote_with_a_real_question_is_still_answered(demo):
    """A contact quoting one of our lines and asking about it is a real
    message — it stays longer than what it quotes."""
    eng, transport, cfg, store = demo
    cfg.restart_jids = frozenset({JID})
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="Cika"))
    store.log_message(JID, "out", OPENING, eng.now())

    transport.sent.clear()
    eng.handle_inbound(
        JID, "Cika",
        OPENING + " ini maksudnya gimana kak? harganya berapa ya?",
    )
    assert transport.sent, "a quoted question was mistaken for an echo"


def test_a_short_ack_is_never_an_echo(demo):
    """"baik kak" appears in our own texts too; matching on it would silence
    every ordinary acknowledgement."""
    eng, transport, cfg, store = demo
    cfg.restart_jids = frozenset({JID})
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="Cika"))
    store.log_message(JID, "out", "Baik kak, saya siapkan ya.", eng.now())

    assert not eng._is_own_echo(JID, "Baik kak")


# --- backlog in production: escalate, never auto-answer ---------------------


def test_production_escalates_a_days_old_message(tmp_path):
    """A week-old "nanti aja" replayed on reconnect would arm a follow-up
    ladder in the present tense. Too old to act on, too valuable to drop."""
    eng, transport, cfg, store = _make(tmp_path, demo=False)
    try:
        store.upsert(Conversation(jid=JID, node=Node.QNA, name="Cika"))
        eng.handle_inbound(
            JID, "Cika", "nanti aja dulu ya kak",
            sent_at=eng.now() - timedelta(days=6),
        )
        assert not transport.sent, "the bot answered a six-day-old message"
        assert store.open_escalations(), "the lead was dropped instead of escalated"
        assert store.last_inbound_text(JID), "the message was not even recorded"
    finally:
        store.close()


def test_production_still_answers_a_restart_window_message(tmp_path):
    """The common case: the bot was down for an hour and a brand replied."""
    eng, transport, cfg, store = _make(tmp_path, demo=False)
    try:
        store.upsert(Conversation(jid=JID, node=Node.QNA, name="Cika"))
        eng.handle_inbound(
            JID, "Cika", "harganya berapa?", sent_at=eng.now() - timedelta(hours=2)
        )
        assert transport.sent, "a brand who replied during downtime got silence"
    finally:
        store.close()


def test_the_cutoff_is_configurable(tmp_path):
    eng, transport, cfg, store = _make(tmp_path, demo=False)
    try:
        cfg.stale_inbound_hours = 1
        store.upsert(Conversation(jid=JID, node=Node.QNA, name="Cika"))
        eng.handle_inbound(
            JID, "Cika", "harganya berapa?", sent_at=eng.now() - timedelta(hours=3)
        )
        assert not transport.sent
    finally:
        store.close()


# --- "jasa*" — the WhatsApp way of fixing a typo ----------------------------


def test_a_starred_correction_reconsiders_the_previous_turn(demo):
    """Seen live: "kamu menyediakan kasa apa aja ya?" then "jasa*". Read on
    its own the correction is a fragment; read against the turn before it, it
    is the question the contact meant to ask."""
    eng, transport, cfg, store = demo
    cfg.restart_jids = frozenset({JID})
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="Cika"))
    store.log_message(
        JID, "in", "kamu menyediakan kasa apa aja ya?", eng.now(), "unknown"
    )

    merged = eng._apply_correction(JID, "jasa")
    assert merged == "kamu menyediakan jasa apa aja ya?", merged


def test_a_correction_with_nothing_close_is_appended(demo):
    """The correction names the replacement, never the mistake. When nothing
    resembles it the contact is adding a word, not fixing one."""
    eng, _, _, store = demo
    store.log_message(JID, "in", "boleh minta info", eng.now(), "unknown")
    assert eng._apply_correction(JID, "portofolio") == "boleh minta info portofolio"


def test_a_correction_with_no_previous_turn_is_harmless(demo):
    eng, _, _, store = demo
    assert eng._apply_correction(JID, "jasa") == ""


def test_a_starred_message_is_answered_as_the_corrected_question(demo):
    eng, transport, cfg, store = demo
    cfg.restart_jids = frozenset({JID})
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="Cika"))
    store.log_message(
        JID, "in", "kamu menyediakan kasa apa aja ya?", eng.now(), "unknown"
    )

    transport.sent.clear()
    eng.handle_inbound(JID, "Cika", "jasa*")
    assert transport.sent, "the correction was left unanswered"
    assert store.get(JID).unknown_streak == 0, "a correction burned a strike"


# --- one contact's messages are handled in order ----------------------------


def test_two_messages_from_one_contact_do_not_interleave(demo):
    """Every inbound runs on its own thread so the dispatcher never blocks,
    which let two messages from the same person be handled at once — the
    second reading the conversation before the first had written it. Live, a
    contact who sent "/restart" then a question got the new-lead
    qualification form in the middle of an open conversation."""
    import threading

    eng, _, cfg, store = demo
    cfg.restart_jids = frozenset({JID})
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="Cika"))

    concurrent, peak = 0, 0
    guard = threading.Lock()
    real = eng._handle_inbound

    def _slow(jid, pushname, text, sent_at=None):
        nonlocal concurrent, peak
        with guard:
            concurrent += 1
            peak = max(peak, concurrent)
        try:
            time.sleep(0.05)
            return real(jid, pushname, text, sent_at)
        finally:
            with guard:
                concurrent -= 1

    eng._handle_inbound = _slow
    threads = [
        threading.Thread(target=eng.handle_inbound, args=(JID, "Cika", t))
        for t in ("harganya berapa?", "oh iya satu lagi kak")
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=5)

    assert peak == 1, f"{peak} messages from one contact handled at once"


def test_different_contacts_are_still_handled_in_parallel(demo):
    """Per-contact, not global: one slow brand must not hold up another."""
    import threading

    eng, _, cfg, store = demo
    other = "628999@s.whatsapp.net"
    cfg.restart_jids = frozenset({JID, other})
    for j in (JID, other):
        store.upsert(Conversation(jid=j, node=Node.QNA, name="X"))

    inside = threading.Semaphore(0)
    release = threading.Event()
    real = eng._handle_inbound

    def _blocking(jid, pushname, text, sent_at=None):
        inside.release()
        release.wait(2)
        return real(jid, pushname, text, sent_at)

    eng._handle_inbound = _blocking
    a = threading.Thread(target=eng.handle_inbound, args=(JID, "X", "halo"))
    b = threading.Thread(target=eng.handle_inbound, args=(other, "Y", "halo"))
    a.start()
    b.start()
    try:
        assert inside.acquire(timeout=2) and inside.acquire(timeout=2), (
            "the second contact was blocked behind the first"
        )
    finally:
        release.set()
        a.join(timeout=5)
        b.join(timeout=5)
