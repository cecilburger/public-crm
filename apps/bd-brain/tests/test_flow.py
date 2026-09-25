"""Flow logic tests. No network, no database."""

from __future__ import annotations

import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bd_bot import flow, intents  # noqa: E402
from bd_bot.config import Settings  # noqa: E402
from bd_bot.flow import Escalate, NotifyGroup, Schedule, Send, SetNode  # noqa: E402
from bd_bot.models import Conversation, Intent, Node, Outcome, Timer  # noqa: E402


@pytest.fixture
def cfg() -> Settings:
    return Settings()


@pytest.fixture
def now() -> datetime:
    return datetime(2026, 7, 21, 10, 0)


@pytest.fixture
def convo() -> Conversation:
    # Mid-conversation by default: Node.NEW now means "inbound ad lead,
    # never contacted" and routes to the qualification form (ROADMAP 2.1) —
    # see the dedicated inbound tests below.
    return Conversation(
        jid="628111@s.whatsapp.net", name="Cika", brand="Brand X", node=Node.QNA
    )


def sends(result) -> list[str]:
    return [a.message.text for a in result.actions if isinstance(a, Send)]


def timers(result) -> list[Timer]:
    return [a.timer for a in result.actions if isinstance(a, Schedule)]


def node_of(result) -> Node | None:
    for a in reversed(result.actions):
        if isinstance(a, SetNode):
            return a.node
    return None


# --- blasting ---------------------------------------------------------------


def test_blast_sends_opening_and_arms_ladder(convo, cfg, now):
    r = flow.on_blast(convo, cfg, now)
    assert len(sends(r)) == 1
    assert "MCNAsia.biz" in sends(r)[0]
    assert timers(r) == [Timer.COLD_FU1]
    assert node_of(r) is Node.BLASTED


def test_first_cold_touch_is_same_day_1600(cfg):
    morning = datetime(2026, 7, 21, 10, 0)
    assert flow.first_cold_touch(morning, cfg).hour == 16


def test_first_cold_touch_after_1600_is_plus_4h(cfg):
    evening = datetime(2026, 7, 21, 18, 0)
    assert flow.first_cold_touch(evening, cfg) == evening + timedelta(hours=4)


# --- the cold ladder --------------------------------------------------------


def test_cold_ladder_runs_four_rungs_then_decays(convo, cfg, now):
    chain = [
        (Timer.COLD_FU1, Timer.COLD_FU2),
        (Timer.COLD_FU2, Timer.COLD_FU3),
        (Timer.COLD_FU3, Timer.COLD_FU4),
        (Timer.COLD_FU4, Timer.DECAY_STOP),
    ]
    for fired, expected_next in chain:
        r = flow.on_timer(convo, fired, cfg, now)
        assert sends(r), f"{fired} should send a message"
        assert timers(r) == [expected_next]
        convo.node = node_of(r)


def test_decay_stop_terminates(convo, cfg, now):
    r = flow.on_timer(convo, Timer.DECAY_STOP, cfg, now)
    assert node_of(r) is Node.STOPPED
    assert not sends(r), "decay should be silent, not send another message"


# --- the three states -------------------------------------------------------


def test_acceptance_goes_to_scheduling(convo, cfg, now):
    """Acceptance proposes concrete slots (ROADMAP 2.2); the open
    'hari dan jam berapa?' ask travels along as the calendar-down fallback."""
    r = flow.on_inbound(convo, Intent.SETUJU, "boleh kak", cfg, now)
    assert node_of(r) is Node.SCHEDULING
    proposals = [a for a in r.actions if isinstance(a, flow.ProposeSlots)]
    assert len(proposals) == 1
    assert "09.00" in proposals[0].fallback.text
    assert proposals[0].fallback.key == "REPLY_SETUJU"


def test_rejection_gets_one_promo_rescue_before_stop(convo, cfg, now):
    r = flow.on_inbound(convo, Intent.TOLAK_TEGAS, "maaf belum tertarik", cfg, now)
    assert Timer.REJECT_PROMO in timers(r)
    assert node_of(r) is not Node.STOPPED, "rejection should not stop immediately"

    r2 = flow.on_timer(convo, Timer.REJECT_PROMO, cfg, now)
    # The rescue still happens; it just quotes no price. The 100-affiliate
    # / Rp10 juta package is not in the current deck, and a rejection
    # follow-up is the worst place to name a figure nobody can honour.
    body = sends(r2)[0]
    assert "Rp" not in body, f"the rescue quoted a price: {body!r}"
    assert "Campaign Affiliate" in body, "the rescue stopped making an offer"
    assert Timer.DECAY_STOP in timers(r2)


def test_opt_out_stops_immediately_with_no_rescue(convo, cfg, now):
    r = flow.on_inbound(convo, Intent.OPT_OUT, "stop, jangan hubungi lagi", cfg, now)
    assert node_of(r) is Node.STOPPED
    assert Timer.REJECT_PROMO not in timers(r), "opt-out must never be rescued"


def test_inbound_always_cancels_pending_timers(convo, cfg, now):
    r = flow.on_inbound(convo, Intent.TANYA_HARGA, "berapa harganya?", cfg, now)
    assert any(isinstance(a, flow.CancelTimers) for a in r.actions)


# --- the gap fixes ----------------------------------------------------------


def test_gadget_loop_decays_into_rejection(convo, cfg, now):
    """FLOWCHART.md §6.1 — the whiteboard loops here forever."""
    cfg.max_gadget_loops = 2

    r1 = flow.on_inbound(convo, Intent.NANTI_AJA, "nanti aja kak", cfg, now)
    assert node_of(r1) is Node.WARM_D2
    assert convo.gadget_loops == 1

    r2 = flow.on_inbound(convo, Intent.NANTI_AJA, "nanti aja dulu", cfg, now)
    assert node_of(r2) is Node.STOPPED, "second defer must decay to rejection"
    assert convo.gadget_loops == 2


def test_unknown_replies_escalate_then_hand_over(convo, cfg, now):
    """FLOWCHART.md §6.2 / §6.3 — neither exists on the board."""
    cfg.max_unknown_streak = 2

    r1 = flow.on_inbound(convo, Intent.UNKNOWN, "???", cfg, now)
    assert any(isinstance(a, Escalate) for a in r1.actions)
    assert node_of(r1) is None, "first unknown should not hand over yet"
    keys1 = [a.message.key for a in r1.actions if isinstance(a, Send)]
    assert "REPLY_FREEFORM" in keys1, "the bot must still answer, like the real chats do"

    r2 = flow.on_inbound(convo, Intent.UNKNOWN, "apa maksudnya", cfg, now)
    assert node_of(r2) is Node.HANDOVER
    keys2 = [a.message.key for a in r2.actions if isinstance(a, Send)]
    assert "REPLY_FREEFORM" not in keys2, "at the streak limit a human takes over"


def test_handover_silences_the_bot(convo, cfg, now):
    convo.node = Node.HANDOVER
    r = flow.on_inbound(convo, Intent.SETUJU, "boleh", cfg, now)
    assert not sends(r), "a human owns this conversation now"


def test_recognised_intent_resets_unknown_streak(convo, cfg, now):
    convo.unknown_streak = 1
    flow.on_inbound(convo, Intent.TANYA_HARGA, "berapa?", cfg, now)
    assert convo.unknown_streak == 0


# --- bare acks after the opening ---------------------------------------------


def test_bare_halo_after_blast_gets_pitch_and_needs_question(convo, cfg, now):
    """'halo' / 'iya' after the opening is politeness, not agreement — pitch
    briefly and ask what the brand needs, don't jump to scheduling."""
    convo.node = Node.BLASTED
    for text, intent in (("halo", Intent.UNKNOWN), ("iya", Intent.SETUJU)):
        c = Conversation(jid=convo.jid, brand="Brand X")
        c.node = Node.BLASTED
        r = flow.on_inbound(c, intent, text, cfg, now)
        keys = [a.message.key for a in r.actions if isinstance(a, Send)]
        assert keys == ["REPLY_GREETING_NEEDS"], (text, keys)
        assert node_of(r) is Node.QNA


def test_iya_mid_conversation_still_accepts(convo, cfg, now):
    """The bare-ack shortcut is for the cold stage only — 'iya' when the
    meeting was just offered IS agreement."""
    convo.node = Node.OFFER_MEETING
    r = flow.on_inbound(convo, Intent.SETUJU, "iya", cfg, now)
    assert node_of(r) is Node.SCHEDULING


def test_substantive_first_reply_is_not_treated_as_ack(convo, cfg, now):
    convo.node = Node.BLASTED
    r = flow.on_inbound(convo, Intent.TANYA_HARGA, "halo, harganya berapa?", cfg, now)
    keys = [a.message.key for a in r.actions if isinstance(a, Send)]
    assert "REPLY_TANYA_HARGA" in keys


def test_rejection_replies_ask_for_current_needs(convo, cfg, now):
    r = flow.on_inbound(convo, Intent.TOLAK_HALUS, "gak dulu kak", cfg, now)
    texts = sends(r)
    assert any("kebutuhan" in t for t in texts), "must ask what they need now"


def test_no_template_mentions_meeting_duration():
    """'20–30 menit' is banned — the ask is always 'meeting singkat'."""
    import re as _re

    from bd_bot import knowledge, templates

    for name, value in vars(templates).items():
        if name.isupper() and isinstance(value, str):
            assert not _re.search(r"\d+\s*[–—-]?\s*\d*\s*menit", value), name
    for ex in knowledge.EXAMPLES:
        assert "menit" not in ex.answer, ex.intent


# --- scheduling: email before booking ---------------------------------------


def test_agreement_asks_for_hour_and_email(convo, cfg, now):
    r = flow.on_inbound(convo, Intent.SETUJU, "boleh", cfg, now)
    assert node_of(r) is Node.SCHEDULING
    assert not any(isinstance(a, flow.BookMeeting) for a in r.actions)
    assert any(isinstance(a, flow.ProposeSlots) for a in r.actions)


def test_no_email_yet_means_ask_not_book(convo, cfg, now):
    convo.node = Node.SCHEDULING
    r = flow.on_inbound(convo, Intent.UNKNOWN, "jam 15 aja ya", cfg, now)
    keys = [a.message.key for a in r.actions if isinstance(a, Send)]
    assert keys == ["ASK_EMAIL"]
    assert not any(isinstance(a, flow.BookMeeting) for a in r.actions)


def test_email_reply_triggers_booking(convo, cfg, now):
    convo.node = Node.SCHEDULING
    r = flow.on_inbound(
        convo, Intent.UNKNOWN, "email saya nana88.kap@gmail.com ya", cfg, now
    )
    assert convo.email == "nana88.kap@gmail.com"
    assert any(isinstance(a, flow.BookMeeting) for a in r.actions)


def test_email_is_captured_from_any_message(convo, cfg, now):
    """Even outside scheduling — e.g. volunteered early — keep it."""
    flow.on_inbound(convo, Intent.TANYA_HARGA, "info ke budi@brand.co.id", cfg, now)
    assert convo.email == "budi@brand.co.id"


def test_question_during_scheduling_is_answered_not_booked(convo, cfg, now):
    convo.node = Node.SCHEDULING
    convo.email = "x@y.co"
    r = flow.on_inbound(convo, Intent.TANYA_HARGA, "harganya berapa?", cfg, now)
    assert not any(isinstance(a, flow.BookMeeting) for a in r.actions)
    assert sends(r), "the question deserves an answer"


def test_rejection_during_scheduling_still_rejects(convo, cfg, now):
    convo.node = Node.SCHEDULING
    convo.email = "x@y.co"
    r = flow.on_inbound(convo, Intent.TOLAK_TEGAS, "gak jadi deh", cfg, now)
    assert not any(isinstance(a, flow.BookMeeting) for a in r.actions)


def test_booking_confirm_schedules_two_reminders(convo, cfg, now):
    from datetime import timedelta

    convo.meeting_at = now + timedelta(hours=5)
    convo.meet_link = "https://meet.google.com/abc"
    convo.email = "x@y.co"
    r = flow.on_meeting_booked(convo, cfg, now)
    reminders = [t for t in timers(r) if t is Timer.REMINDER]
    assert len(reminders) == 2, "H-2 and H-1 reminders"
    fire_ats = sorted(
        a.fire_at for a in r.actions
        if isinstance(a, flow.Schedule) and a.timer is Timer.REMINDER
    )
    assert fire_ats[0] == convo.meeting_at - timedelta(minutes=120)
    assert fire_ats[1] == convo.meeting_at - timedelta(minutes=60)


def test_no_reminder_scheduled_in_the_past(convo, cfg, now):
    from datetime import timedelta

    convo.meeting_at = now + timedelta(minutes=90)  # H-2 already past
    convo.meet_link = "https://meet.google.com/abc"
    r = flow.on_meeting_booked(convo, cfg, now)
    reminders = [t for t in timers(r) if t is Timer.REMINDER]
    assert len(reminders) == 1, "only the H-1 reminder fits"


# --- inbound ad leads, ROADMAP 2.1 -------------------------------------------


def test_first_inbound_gets_qualification_form(cfg, now):
    """A contact we never blasted messages first: qualification SOP."""
    c = Conversation(jid="628111@s.whatsapp.net")  # Node.NEW
    r = flow.on_inbound(c, Intent.UNKNOWN, "halo, saya tertarik", cfg, now)
    keys = [a.message.key for a in r.actions if isinstance(a, Send)]
    assert keys == ["INBOUND_QUALIFY"]
    assert "Nama Brand" in sends(r)[0]
    assert node_of(r) is Node.INBOUND_QUALIFY
    assert not any(isinstance(a, Escalate) for a in r.actions), (
        "an ad lead's opener is expected, not an anomaly"
    )


def test_form_reply_captures_brand_and_pitches(cfg, now):
    c = Conversation(jid="628111@s.whatsapp.net", node=Node.INBOUND_QUALIFY)
    r = flow.on_inbound(
        c,
        Intent.UNKNOWN,
        "• Nama Brand: wilica\n• Posisi di Brand: pemilik\n• Link Shopee: toko",
        cfg,
        now,
    )
    assert c.brand == "wilica"
    keys = [a.message.key for a in r.actions if isinstance(a, Send)]
    assert keys == ["INBOUND_SERVICE_MENU"]
    assert node_of(r) is Node.QNA


def test_question_at_qualify_is_answered_not_pitched(cfg, now):
    """A real question in the form reply falls through to normal Q&A."""
    c = Conversation(jid="628111@s.whatsapp.net", node=Node.INBOUND_QUALIFY)
    r = flow.on_inbound(c, Intent.TANYA_HARGA, "fee berapa ya?", cfg, now)
    keys = [a.message.key for a in r.actions if isinstance(a, Send)]
    assert keys == ["REPLY_TANYA_HARGA"]


def test_rejection_at_new_still_rejects(cfg, now):
    """Someone's first message can be 'stop' — never answer that with a form."""
    c = Conversation(jid="628111@s.whatsapp.net")
    r = flow.on_inbound(c, Intent.OPT_OUT, "jangan hubungi saya", cfg, now)
    assert node_of(r) is Node.STOPPED


def test_acceptance_at_new_skips_the_form(cfg, now):
    c = Conversation(jid="628111@s.whatsapp.net")
    r = flow.on_inbound(c, Intent.SETUJU, "boleh, kapan bisa meeting?", cfg, now)
    assert node_of(r) is Node.SCHEDULING


def test_existing_brand_is_not_overwritten_by_form(cfg, now):
    c = Conversation(
        jid="628111@s.whatsapp.net", brand="Asli", node=Node.INBOUND_QUALIFY
    )
    flow.on_inbound(c, Intent.UNKNOWN, "Nama Brand: Lain", cfg, now)
    assert c.brand == "Asli"


# --- scheduling reach, ROADMAP 2.1 flow gaps ---------------------------------


def test_email_after_menunda_nudge_still_books(convo, cfg, now):
    """Agreed, went quiet, got the MENUNDA nudge, replied with the email —
    that is a booking, not a new topic (gold-set finding)."""
    convo.node = Node.MENUNDA_H1
    r = flow.on_inbound(convo, Intent.UNKNOWN, "email saya x@y.co ya", cfg, now)
    assert convo.email == "x@y.co"
    assert any(isinstance(a, flow.BookMeeting) for a in r.actions)


def test_reschedule_after_booking_is_acknowledged_and_escalated(convo, cfg, now):
    """SARINA really asked this and the old flow answered with silence."""
    convo.node = Node.SCHEDULED
    r = flow.on_inbound(
        convo, Intent.SETUJU, "boleh di reschedule ke jam 4 sore?", cfg, now
    )
    keys = [a.message.key for a in r.actions if isinstance(a, Send)]
    assert keys == ["REPLY_RESCHEDULE"]
    assert any(isinstance(a, Escalate) for a in r.actions)


def test_plain_ok_after_booking_stays_silent(convo, cfg, now):
    convo.node = Node.SCHEDULED
    r = flow.on_inbound(convo, Intent.OK_LANJUT, "oke siap", cfg, now)
    assert not sends(r), "an extra 'ok' on a booked meeting needs no reply"


# --- pricing ----------------------------------------------------------------


def test_price_reveal_is_two_stage(convo, cfg, now):
    """FLOWCHART.md §5.3 — vague anchor first, full list only on a second ask."""
    # Since 18 Aug 2026 there is one package, so the two stages are told apart
    # by FORM, not by how many tiers they list: the anchor says "Rp10 juta",
    # the detail reply spells the figure out alongside the GMV framing.
    r1 = flow.on_inbound(convo, Intent.TANYA_HARGA, "harganya berapa?", cfg, now)
    assert "Rp10 juta" in sends(r1)[0]
    assert "Rp10.000.000" not in sends(r1)[0], "full list leaked too early"

    r2 = flow.on_inbound(convo, Intent.TANYA_HARGA, "detail paketnya?", cfg, now)
    assert "Rp10.000.000" in sends(r2)[0]


# --- meeting ----------------------------------------------------------------


def test_booking_schedules_reminder_and_notifies_group(convo, cfg, now):
    convo.meeting_at = now + timedelta(days=1)
    convo.meet_link = "https://meet.google.com/abc-defg-hij"
    r = flow.on_meeting_booked(convo, cfg, now)
    assert Timer.REMINDER in timers(r)
    assert Timer.MEETING_END in timers(r)
    assert any(isinstance(a, flow.NotifyGroup) for a in r.actions)
    assert node_of(r) is Node.SCHEDULED


def test_meeting_done_escalates_and_makes_no_unattended_promise(convo, cfg, now):
    """ROADMAP 1.5 — the old template promised a recap nothing would send.
    Now the promise is 'tim kami akan menghubungi', and an escalation makes
    sure a human actually does."""
    r = flow.on_meeting_outcome(convo, joined=True, cfg=cfg, now=now)
    assert node_of(r) is Node.MEETING_DONE
    assert any(isinstance(a, Escalate) for a in r.actions)
    text = sends(r)[0].lower()
    assert "ringkasan" not in text and "menyusul" not in text


def test_noshow_runs_two_followups_then_decays(convo, cfg, now):
    r = flow.on_meeting_outcome(convo, joined=False, cfg=cfg, now=now)
    assert Timer.NOSHOW_1 in timers(r)

    r1 = flow.on_timer(convo, Timer.NOSHOW_1, cfg, now)
    assert Timer.NOSHOW_2 in timers(r1)
    r2 = flow.on_timer(convo, Timer.NOSHOW_2, cfg, now)
    assert Timer.DECAY_STOP in timers(r2)


def test_terminal_nodes_ignore_stray_timers(convo, cfg, now):
    convo.node = Node.STOPPED
    r = flow.on_timer(convo, Timer.WARM_D2, cfg, now)
    assert not r.actions


# --- intent classification --------------------------------------------------


@pytest.mark.parametrize(
    "text,expected",
    [
        ("Boleh kak", Intent.SETUJU),
        ("boleh, kapan bisa meeting?", Intent.SETUJU),
        ("harganya berapa yah?", Intent.TANYA_HARGA),
        ("brp biayanya ka", Intent.TANYA_HARGA),
        # Package questions in either word order — a very common second ask
        # after the price anchor, and the trigger for the full price list.
        ("detail paketnya dong", Intent.TANYA_HARGA),
        ("paket detailnya apa aja", Intent.TANYA_HARGA),
        ("ada paket apa aja?", Intent.TANYA_HARGA),
        ("opsi paketnya gimana", Intent.TANYA_HARGA),
        ("paketnya dong", Intent.TANYA_HARGA),
        ("sistemnya bagaimana?", Intent.TANYA_SISTEM),
        ("gimana cara kerjanya", Intent.TANYA_SISTEM),
        ("ok kak, aku teruskan ke team aku yah", Intent.TERUSKAN_TIM),
        ("nanti aja kak, saya pelajari dulu", Intent.PELAJARI_DULU),
        ("maaf belum tertarik", Intent.TOLAK_TEGAS),
        ("blm tertarik ka", Intent.TOLAK_TEGAS),
        ("gak dulu kak", Intent.TOLAK_HALUS),
        ("terima kasih penawarannya", Intent.TERIMA_KASIH),
        ("nanti aja ya", Intent.NANTI_AJA),
        ("STOP", Intent.OPT_OUT),
        ("jangan hubungi saya lagi", Intent.OPT_OUT),
        ("Ok baik ak", Intent.OK_LANJUT),
        ("asdfghjkl", Intent.UNKNOWN),
        # --- question intents from the chat-example exports (real phrasings) --
        ("Boleh minta company credential/portfolio terbaru kah?", Intent.TANYA_PORTOFOLIO),
        ("bisa lihat langsung dashboard brand yg dihandle juga?", Intent.TANYA_PORTOFOLIO),
        ("Apakah ada contoh brand yg gmv 1 Bln pendapatan mrka kak", Intent.TANYA_PORTOFOLIO),
        ("ini kantornya dimana? apakah bisa visit kantor?", Intent.TANYA_LOKASI),
        ("Posisi kalian di mana ya", Intent.TANYA_LOKASI),
        ("Soalny ky bnyk penipuan gt ka. Jd aku agak takut", Intent.TANYA_LOKASI),
        ("komisi utk MCN itu double dong?", Intent.TANYA_KOMISI),
        ("Commission based atau seperti apa yah?", Intent.TANYA_KOMISI),
        ("ini per bulan atau per 4 bulan ya kak ?", Intent.TANYA_PEMBAYARAN),
        ("Ini kl mau DP apa full payment ka?", Intent.TANYA_PEMBAYARAN),
        ("itu pakai ppn kan?", Intent.TANYA_PEMBAYARAN),
        ("rata rata views dan follower affiliate yang kka manage berapa ya?", Intent.TANYA_AFFILIATE),
        ("itu 150 video per 1 affiliate atau gimanaa?", Intent.TANYA_AFFILIATE),
        ("untuk affiliate ini di TikTok atau Shopee ya?", Intent.TANYA_AFFILIATE),
        ("utk list kreatornya seperti apa ya kak?", Intent.TANYA_AFFILIATE),
        ("kirim sample ke affiliate itu kirimnya brp produk?", Intent.TANYA_SAMPLE),
        ("misal ud kirim sample trs affiliatenya gk review malah hilang. Itu gimana ka?", Intent.TANYA_SAMPLE),
        ("kl aku deal ini prosesnya brp lama?", Intent.TANYA_TIMELINE),
        ("untuk harga aku minta dikurangi bs gak y ka?", Intent.NEGO_HARGA),
        ("gk bs kurang lg komisinya?", Intent.NEGO_HARGA),
        # "kurang paham" is a systems question, not a discount ask.
        ("kurang paham kak, bisa dijelasin lagi?", Intent.TANYA_SISTEM),
        ("bisa minta agreement untuk dipelajari tim legal kita kak?", Intent.MINTA_KONTRAK),
        ("kirimkan dulu saja draft nya", Intent.MINTA_KONTRAK),
        ("Mungkin kita bisa by tlf dulu ya kk", Intent.MINTA_TELEPON),
        ("apakah possible untuk set quick call ya?", Intent.MINTA_TELEPON),
        ("Apakah kita bisa ngobrol via Zoom nantinya", Intent.MINTA_TELEPON),
    ],
)
def test_intent_rules(text, expected, cfg):
    assert intents.classify_rules(text) is expected


def test_question_intents_answer_then_offer_meeting(convo, cfg, now):
    """The seven chat-example question intents answer, then close with the
    meeting gadget — same shape as TANYA_SISTEM."""
    for intent in (
        Intent.TANYA_PORTOFOLIO,
        Intent.TANYA_LOKASI,
        Intent.TANYA_KOMISI,
        Intent.TANYA_PEMBAYARAN,
        Intent.TANYA_AFFILIATE,
        Intent.TANYA_SAMPLE,
        Intent.TANYA_TIMELINE,
    ):
        c = Conversation(jid=convo.jid, node=Node.QNA)
        r = flow.on_inbound(c, intent, "pertanyaan", cfg, now)
        keys = [a.message.key for a in r.actions if isinstance(a, flow.Send)]
        assert keys == [f"REPLY_{intent.name}", "OFFER_MEETING"], intent


def test_nego_and_kontrak_escalate_to_human(convo, cfg, now):
    for intent, key in (
        (Intent.NEGO_HARGA, "REPLY_NEGO_HARGA"),
        (Intent.MINTA_KONTRAK, "REPLY_MINTA_KONTRAK"),
    ):
        c = Conversation(jid=convo.jid, node=Node.QNA)
        r = flow.on_inbound(c, intent, "pertanyaan", cfg, now)
        keys = [a.message.key for a in r.actions if isinstance(a, flow.Send)]
        assert keys == [key]
        assert any(isinstance(a, flow.Escalate) for a in r.actions), intent


def test_minta_telepon_enters_scheduling(convo, cfg, now):
    convo.node = Node.QNA
    r = flow.on_inbound(convo, Intent.MINTA_TELEPON, "bisa telepon aja?", cfg, now)
    keys = [a.message.key for a in r.actions if isinstance(a, flow.Send)]
    assert keys == ["REPLY_MINTA_TELEPON"]
    nodes = [a.node for a in r.actions if isinstance(a, flow.SetNode)]
    assert nodes == [Node.SCHEDULING]


def test_every_intent_maps_to_an_outcome():
    from bd_bot.models import INTENT_OUTCOME

    for intent in Intent:
        assert intent in INTENT_OUTCOME, f"{intent} has no outcome mapping"


def test_only_acceptance_and_rejection_are_exits():
    """FLOWCHART.md §1 — follow-up is a deferral, never a terminal state."""
    from bd_bot.models import INTENT_OUTCOME

    terminal_intents = {
        i for i, o in INTENT_OUTCOME.items() if o is not Outcome.FOLLOWUP
    }
    assert Intent.SETUJU in terminal_intents
    assert Intent.TOLAK_TEGAS in terminal_intents
    assert Intent.NANTI_AJA not in terminal_intents


# --- intents added in Phase 4 ------------------------------------------------


def _keys(result) -> list[str]:
    return [a.message.key for a in result.actions if isinstance(a, Send)]


JID4 = "628111@s.whatsapp.net"


def test_tunggu_holds_the_position(cfg, now):
    """"Bentar saya cek ya" asks for nothing, but it is not unclassifiable.
    Before this it burned an unknown strike, so two errands in a row handed
    the conversation to a human while the brand was simply busy."""
    convo = Conversation(jid=JID4, node=Node.QNA, unknown_streak=1)
    r = flow.on_inbound(convo, Intent.TUNGGU, "Bentar saya cek ya", cfg, now)

    assert _keys(r) == ["REPLY_TUNGGU"]
    assert convo.unknown_streak == 0, "a clear message left the strike standing"
    assert node_of(r) is None, "holding on should not move the conversation"
    assert not timers(r), "no new ladder — they said they are coming back"


def test_minta_link_resends_a_booked_meeting_link(cfg, now):
    convo = Conversation(
        jid=JID4, node=Node.SCHEDULED,
        meet_link="https://meet.google.com/abc-defg-hij",
        meeting_at=now + timedelta(hours=3),
    )
    r = flow.on_inbound(convo, Intent.MINTA_LINK, "link nya ka", cfg, now)

    assert _keys(r) == ["RESEND_LINK"]
    assert "meet.google.com/abc-defg-hij" in sends(r)[0]


def test_minta_link_without_a_meeting_offers_one(cfg, now):
    """"nanti bs kirimkan linknya aja kak" before anything is booked is a
    request for material, not for a Meet link we do not have."""
    convo = Conversation(jid=JID4, node=Node.QNA)
    r = flow.on_inbound(
        convo, Intent.MINTA_LINK, "nanti bs kirimkan linknya aja kak", cfg, now
    )
    assert "RESEND_LINK" not in _keys(r)
    assert "OFFER_MEETING" in _keys(r)


def test_tanya_live_answers_and_offers_a_meeting(cfg, now):
    convo = Conversation(jid=JID4, node=Node.QNA)
    r = flow.on_inbound(
        convo, Intent.TANYA_LIVE,
        "Untuk Daily live ini dengan Live affiliate atau official brand account?",
        cfg, now,
    )
    assert _keys(r) == ["REPLY_TANYA_LIVE", "OFFER_MEETING"]


# --- coordination around the call itself -------------------------------------


def _booked(now):
    return Conversation(
        jid=JID4, brand="Brand X", node=Node.SCHEDULED,
        meet_link="https://meet.google.com/abc-defg-hij",
        meeting_at=now + timedelta(minutes=10),
    )


@pytest.mark.parametrize(
    "text",
    ["Sdah bisa join?", "Sorry\nSy join skr bisa?", "Kak kita sudah mau masuk",
     "Telat 10menitan ya 🙏🏻🙏🏻", "otw ya kak", "Minta sharelock nya kak"],
)
def test_meeting_day_messages_get_the_link_and_a_human(cfg, now, text):
    """These arrive in the minutes around a booked call. A clarification
    prompt or a two-strike silence there is the worst possible answer."""
    convo = _booked(now)
    r = flow.on_inbound(convo, intents.classify_rules(text), text, cfg, now)

    assert "RESEND_LINK" in _keys(r), f"no link resent for {text!r}"
    assert any(isinstance(a, NotifyGroup) for a in r.actions), "nobody was told"
    assert convo.unknown_streak == 0


def test_the_gate_only_applies_once_a_meeting_is_booked(cfg, now):
    """"bisa join meeting hari Senin?" earlier in the funnel is a scheduling
    question, not someone standing outside the room."""
    convo = Conversation(jid=JID4, node=Node.QNA)
    r = flow.on_inbound(
        convo, Intent.SETUJU, "bisa join meeting hari Senin?", cfg, now
    )
    assert "RESEND_LINK" not in _keys(r)


def test_a_rejection_after_booking_still_rejects(cfg, now):
    """The gate is intent-agnostic, so it must not swallow a real decision."""
    convo = _booked(now)
    r = flow.on_inbound(
        convo, Intent.TOLAK_TEGAS, "maaf kami tidak tertarik lagi", cfg, now
    )
    assert "RESEND_LINK" not in _keys(r)


def test_a_bare_greeting_mid_conversation_does_not_dead_end(cfg, now):
    """"siang" at QNA used to answer "boleh dijelaskan sedikit lebih detail
    maksud Kakak?" and burn an unknown strike, so two greetings in a row
    handed the conversation to a human."""
    convo = Conversation(jid=JID4, brand="Brand X", node=Node.QNA, unknown_streak=1)
    r = flow.on_inbound(convo, intents.classify_rules("siang"), "siang", cfg, now)

    assert _keys(r) == ["REPLY_SAPAAN"]
    assert convo.unknown_streak == 0
    assert node_of(r) is None, "a greeting should not move the conversation"


def test_two_greetings_no_longer_trigger_handover(cfg, now):
    convo = Conversation(jid=JID4, brand="Brand X", node=Node.QNA)
    for text in ("halo kak", "siang"):
        r = flow.on_inbound(convo, intents.classify_rules(text), text, cfg, now)
        assert "HANDOVER" not in _keys(r), f"{text!r} handed off"
    assert convo.node is not Node.HANDOVER


def test_a_greeting_after_booking_keeps_the_meeting(cfg, now):
    convo = Conversation(
        jid=JID4, node=Node.SCHEDULED, meeting_at=now + timedelta(days=1),
        meet_link="https://meet.google.com/abc-defg-hij",
    )
    r = flow.on_inbound(convo, intents.classify_rules("pagi kak"), "pagi kak", cfg, now)
    assert _keys(r) == ["REPLY_SAPAAN"]
    assert node_of(r) is None


def test_a_greeting_with_a_question_is_still_the_question(cfg, now):
    """The bare-ack branch must not swallow "halo kak, harganya berapa?"."""
    convo = Conversation(jid=JID4, brand="Brand X", node=Node.QNA)
    text = "halo kak, harganya berapa?"
    r = flow.on_inbound(convo, intents.classify_rules(text), text, cfg, now)
    assert "REPLY_SAPAAN" not in _keys(r)
    assert "REPLY_TANYA_HARGA" in _keys(r)


def test_minta_chat_answers_in_chat_and_leaves_the_meeting_open(cfg, now):
    """Pushing the meeting again at someone who just asked not to have one
    is how a brand stops replying."""
    convo = Conversation(jid=JID4, brand="Brand X", node=Node.QNA, unknown_streak=1)
    r = flow.on_inbound(
        convo, Intent.MINTA_CHAT, "via chat saja ya kak", cfg, now
    )
    assert _keys(r) == ["REPLY_MINTA_CHAT"]
    assert "OFFER_MEETING" not in _keys(r), "re-pitched the meeting anyway"
    assert convo.unknown_streak == 0
    assert timers(r) == [Timer.WARM_D2], "the conversation was left with no follow-up"


def test_asking_which_times_are_open_gets_times_not_an_email_request(cfg, now):
    """Live: "kalau Sabtu bisa ga ya ka?" and "bisa di jam brp aja ya kak?"
    both got "boleh dibantu alamat email-nya?" — the same sentence twice, and
    neither answered the question. The proposal answers it and asks for the
    email in one breath."""
    from bd_bot.flow import ProposeSlots

    for text in ("kalau Sabtu bisa ga ya ka?", "bisa di jam brp aja ya kak?",
                 "masih ada slot besok?"):
        convo = Conversation(jid=JID4, brand="X", node=Node.SCHEDULING)
        r = flow.on_inbound(convo, Intent.SETUJU, text, cfg, now)
        assert any(isinstance(a, ProposeSlots) for a in r.actions), text
        assert "ASK_EMAIL" not in _keys(r), text


def test_a_settled_slot_still_just_asks_for_the_email(cfg, now):
    """When they have named a time and asked nothing, repeating availability
    would be noise."""
    convo = Conversation(jid=JID4, brand="X", node=Node.SCHEDULING)
    r = flow.on_inbound(convo, Intent.SETUJU, "oke senin jam 10 aja", cfg, now)
    assert _keys(r) == ["ASK_EMAIL"]


# --- inbound selling, and the DM → WhatsApp hand-off (24 Sep 2026) -----------
#
# Mined from inbound/ and the BD team's CRM PDF. The funnel the team runs is
# comment → DM → WhatsApp → meeting, and every step below moves a lead one
# step along it without skipping one: the DM never books, the WhatsApp side
# never hands off, and nothing here quotes a price that knowledge.py does not
# carry.

IG = "ig:9090909090"


@pytest.fixture
def wa_cfg() -> Settings:
    """A number configured — the hand-off is switched on."""
    cfg = Settings()
    cfg.bd_whatsapp_number = "+62 800-0000-0000"
    return cfg


def _texts(result) -> list[str]:
    return [a.message.text for a in result.actions if isinstance(a, Send)]


def _escalations(result) -> list[str]:
    return [a.reason for a in result.actions if isinstance(a, Escalate)]


# -- WhatsApp: the selling turns ----------------------------------------------


def test_the_need_stated_gets_the_pitch_and_the_meeting_ask(cfg, now):
    """"Saya butuh affiliate kak" — the corpus answers with a short pitch and
    the invitation in one message, ending on the hari/jam question. So no
    OFFER_MEETING stacked on top, which would ask the same thing twice."""
    convo = Conversation(jid=JID4, brand="Brand X", node=Node.QNA)
    r = flow.on_inbound(convo, Intent.BUTUH_AFFILIATE, "Saya butuh affiliate kak", cfg, now)
    assert _keys(r) == ["REPLY_BUTUH_AFFILIATE"]
    text = _texts(r)[0]
    assert "hari dan jam berapa" in text
    assert "Rp" not in text, "the need is not a price question"
    assert "tidak masalah" in text, "the no-obligation reassurance is the team's device"
    assert node_of(r) is Node.OFFER_MEETING
    assert timers(r) == [Timer.WARM_D2]


def test_the_need_at_qualify_joins_the_menu_path(cfg, now):
    """A form answered with a single word ("affiliate") is still the form
    being answered: the menu goes out once, not the menu and then a second
    invitation."""
    convo = Conversation(jid=JID4, node=Node.INBOUND_QUALIFY)
    r = flow.on_inbound(convo, Intent.BUTUH_AFFILIATE, "Affiliate", cfg, now)
    assert _keys(r) == ["INBOUND_SERVICE_MENU"]
    assert node_of(r) is Node.QNA


def test_asking_for_the_menu_lists_the_six_services_without_prices(cfg, now):
    """"Layanan apa aja?" gets the list the team sends, names only, and the
    category + need question — not a meeting push and not a price."""
    from bd_bot import knowledge

    convo = Conversation(jid=JID4, brand="Brand X", node=Node.QNA)
    r = flow.on_inbound(convo, Intent.TANYA_LAYANAN, "Bentuk layanannya apa aja", cfg, now)
    assert _keys(r) == ["REPLY_TANYA_LAYANAN"]
    text = _texts(r)[0]
    for name in knowledge.SERVICE_MENU:
        assert name in text, f"menu is missing {name!r}"
    low = text.lower()
    assert "rp" not in low and "juta" not in low
    assert "kategori" in low and "kebutuhan" in low, "the menu must dig for the need"
    assert "OFFER_MEETING" not in _keys(r)


def test_the_service_menu_comes_from_knowledge():
    """One list. Three templates offer it, and a menu typed three times had
    already drifted (the corpus alone has three spellings of it)."""
    from bd_bot import knowledge, templates

    for name in knowledge.SERVICE_MENU:
        assert name in templates.INBOUND_SERVICE_MENU.replace("{menu}", knowledge.service_menu_lines())
        assert not any(ch.isdigit() for ch in name), "the menu carries names, never figures"
    assert "{menu}" in templates.INBOUND_SERVICE_MENU
    assert "{menu}" in templates.REPLY_TANYA_LAYANAN


def test_a_vague_info_ask_digs_before_it_sells(cfg, now):
    """"Mau info affiliate" is the CRM PDF's "Warm — gali kebutuhan" row.
    Explain in one breath, ask about their product and platform. No price
    (that is the "jangan hanya kirim pricelist" mistake by another route)
    and no meeting yet."""
    convo = Conversation(jid=JID4, node=Node.QNA)
    r = flow.on_inbound(convo, Intent.MINTA_INFO, "Mau info affiliate", cfg, now)
    assert _keys(r) == ["REPLY_MINTA_INFO"]
    text = _texts(r)[0]
    assert "TikTok Shop atau Shopee" in text
    assert "Rp" not in text
    assert "meeting" not in text.lower()
    assert node_of(r) is Node.QNA


def test_a_burned_brand_is_answered_not_dismissed(cfg, now):
    """"Pernah pakai agency, gak ada hasil" is an objection, not a no. BD's
    answer: agree it is normal, name the cause, ask how it was run, promise
    the case study at the meeting — and no figure anywhere, because a GMV
    quoted here is exactly what the guard exists to stop."""
    convo = Conversation(jid=JID4, brand="Brand X", node=Node.QNA)
    r = flow.on_inbound(
        convo, Intent.PERNAH_AGENCY,
        "Aku ragu, udah 2x pernah dipromosiin tapi gak ada hasil", cfg, now,
    )
    assert _keys(r) == ["REPLY_PERNAH_AGENCY"]
    text = _texts(r)[0]
    assert "Wajar" in text
    assert not any(ch.isdigit() for ch in text), "no numbers in the objection answer"
    assert "studi kasus" in text
    assert node_of(r) is Node.QNA
    assert convo.unknown_streak == 0


def test_a_booked_brand_asking_if_we_are_still_on_gets_the_link(cfg, now):
    """"Pagi Ka apakah kita jadi meeting" — listed as unplaced after the
    first inbound round. At SCHEDULED it is the same as "bisa join?"."""
    convo = _booked(now)
    r = flow.on_inbound(convo, Intent.UNKNOWN, "Pagi Ka apakah kita jadi meeting", cfg, now)
    assert "RESEND_LINK" in _keys(r)
    assert any(isinstance(a, NotifyGroup) for a in r.actions)


def test_no_inbound_selling_template_states_a_price_outside_knowledge():
    """The corpus quotes figures the deck does not carry (a Rp30 juta
    curation bar, a 10.000 database, "level 3"). None of them may travel
    into the templates that were written from it."""
    import re

    from bd_bot import knowledge, templates

    for key in ("REPLY_MINTA_INFO", "REPLY_TANYA_LAYANAN", "REPLY_BUTUH_AFFILIATE",
                "REPLY_PERNAH_AGENCY", "INBOUND_SERVICE_MENU", "INBOUND_QUALIFY_DM",
                "DM_SERVICE_PITCH", "DM_TO_WA", "DM_TO_WA_AGAIN"):
        body = getattr(templates, key)
        for amount in re.findall(r"Rp\s?[\d.,]+(?:\s*juta)?", body):
            digits = amount.replace("Rp", "").strip()
            assert digits in knowledge.ALLOWED_AMOUNTS, f"{key} quotes {amount!r}"
        assert "menit" not in body, f"{key} states a meeting duration"
        assert "30 juta" not in body and "level" not in body.lower(), key


# -- the DM: qualify, one exchange, then WhatsApp ----------------------------


def test_dm_channel_reads_the_source_or_the_jid():
    assert flow.dm_channel(Conversation(jid=IG)) == "instagram"
    assert flow.dm_channel(Conversation(jid="fb:1")) == "facebook"
    assert flow.dm_channel(Conversation(jid="uuid-from-a-crm", source="facebook")) == "facebook"
    assert flow.dm_channel(Conversation(jid=JID4)) == ""


def test_a_dm_first_contact_gets_the_dm_opener_not_the_form(wa_cfg, now):
    """The PDF's IG-DM script asks brand, product and platform — lighter than
    the four-line WhatsApp form, which reads as a wall in a DM."""
    convo = Conversation(jid=IG)
    r = flow.on_inbound(convo, Intent.MINTA_INFO, "Kak mau tanya service MCNASIA", wa_cfg, now)
    assert _keys(r) == ["INBOUND_QUALIFY_DM"]
    assert "Nama Brand:" not in _texts(r)[0]
    assert "TikTok Shop, Shopee" in _texts(r)[0]
    assert node_of(r) is Node.INBOUND_QUALIFY


def test_a_dm_qualification_answer_gets_the_pitch_and_the_dig(wa_cfg, now):
    """Their brand/product/platform is answered with the PDF's third turn —
    relate the need to the affiliate campaign, say what we do — and one more
    question (sales, awareness, keduanya?). Not the hand-off yet: the user's
    funnel says "DM to discuss, THEN WhatsApp", and this is the discussing."""
    convo = Conversation(jid=IG, node=Node.INBOUND_QUALIFY)
    r = flow.on_inbound(convo, Intent.UNKNOWN, "Wonderish, skincare, fokus di TikTok", wa_cfg, now)
    assert _keys(r) == ["DM_SERVICE_PITCH"]
    assert "sales, awareness, atau keduanya" in _texts(r)[0]
    assert node_of(r) is Node.QNA


def test_interest_in_a_dm_moves_to_whatsapp(wa_cfg, now):
    """The answer to "sales, awareness, atau keduanya?" is interest, and
    interest moves to WhatsApp: the number, once, with why and what happens
    there. The DM parks at WA_HANDOFF, a human is told to watch for the
    lead, and no timer is armed — Meta's messaging window would refuse it."""
    convo = Conversation(jid=IG, node=Node.QNA)
    r = flow.on_inbound(convo, Intent.UNKNOWN, "Lebih ke sales kak", wa_cfg, now)
    assert _keys(r) == ["DM_TO_WA"]
    assert wa_cfg.bd_whatsapp_number in _texts(r)[0]
    assert "meeting" in _texts(r)[0].lower(), "the hand-off says the meeting is arranged there"
    assert node_of(r) is Node.WA_HANDOFF
    assert not timers(r)
    assert any("WhatsApp" in e for e in _escalations(r))


def test_the_hand_off_never_asks_for_their_number():
    """Inbound only: the lead writes to us. Nothing on a Meta channel may
    collect a number for someone to WhatsApp first."""
    from bd_bot import templates

    for key in ("DM_TO_WA", "DM_TO_WA_AGAIN"):
        low = getattr(templates, key).lower()
        assert "{wa}" in low
        for ask in ("nomor kakak", "nomor kak", "no wa kakak", "boleh minta nomor", "share nomor", "nomornya"):
            assert ask not in low, f"{key} asks for their number ({ask!r})"


@pytest.mark.parametrize("intent, text", [
    (Intent.OK_LANJUT, "boleh kak"),
    (Intent.SETUJU, "boleh, kapan bisa meeting?"),
    (Intent.BUTUH_AFFILIATE, "Saya butuh affiliate kak"),
    (Intent.MINTA_INFO, "mau info affiliate dong"),
])
def test_agreement_or_the_need_in_a_dm_is_a_hand_off_not_a_slot_list(wa_cfg, now, intent, text):
    from bd_bot.flow import ProposeSlots

    convo = Conversation(jid=IG, brand="Brand X", node=Node.QNA)
    r = flow.on_inbound(convo, intent, text, wa_cfg, now)
    assert _keys(r) == ["DM_TO_WA"], (intent, _keys(r))
    assert not any(isinstance(a, ProposeSlots) for a in r.actions), "the DM must not book"
    assert node_of(r) is Node.WA_HANDOFF


def test_a_price_question_in_a_dm_gets_the_anchor_then_whatsapp(wa_cfg, now):
    """"High intent" in the CRM PDF. The anchor is private and goes out —
    refusing to confirm our own deck reads as evasion — and the discussion
    its questions open moves to WhatsApp, where the deck can follow."""
    convo = Conversation(jid=IG, brand="Brand X", node=Node.QNA)
    r = flow.on_inbound(convo, Intent.TANYA_HARGA, "harganya berapa kak?", wa_cfg, now)
    assert _keys(r) == ["REPLY_TANYA_HARGA", "DM_TO_WA"]
    assert "Rp10 juta" in _texts(r)[0]
    assert convo.price_stage == 1
    assert node_of(r) is Node.WA_HANDOFF


def test_a_question_answered_in_a_dm_closes_with_whatsapp_not_a_meeting(wa_cfg, now):
    convo = Conversation(jid=IG, brand="Brand X", node=Node.QNA)
    r = flow.on_inbound(convo, Intent.TANYA_SISTEM, "sistemnya gimana kak?", wa_cfg, now)
    assert _keys(r) == ["REPLY_TANYA_SISTEM", "DM_TO_WA"]
    assert "OFFER_MEETING" not in _keys(r)


def test_after_the_hand_off_the_pointer_is_repeated_once_then_a_human(wa_cfg, now):
    """Pushing the same line every turn is what makes a lead stop replying:
    once more, shorter; after that only the escalation."""
    convo = Conversation(jid=IG, node=Node.WA_HANDOFF)
    r1 = flow.on_inbound(convo, Intent.OK_LANJUT, "ok siap", wa_cfg, now)
    assert _keys(r1) == ["DM_TO_WA_AGAIN"]
    assert wa_cfg.bd_whatsapp_number in _texts(r1)[0]
    assert _escalations(r1)
    r2 = flow.on_inbound(convo, Intent.OK_LANJUT, "oke", wa_cfg, now)
    assert _keys(r2) == [], "the pointer was repeated a third time"
    assert _escalations(r2)
    assert node_of(r2) is None, "still parked at the hand-off"


def test_a_question_after_the_hand_off_is_still_answered(wa_cfg, now):
    convo = Conversation(jid=IG, brand="Brand X", node=Node.WA_HANDOFF, gadget_loops=1)
    r = flow.on_inbound(convo, Intent.TANYA_LOKASI, "kantornya dimana?", wa_cfg, now)
    assert _keys(r) == ["REPLY_TANYA_LOKASI"]
    assert "Seasons City" in _texts(r)[0]


def test_a_rejection_in_a_dm_still_rejects(wa_cfg, now):
    convo = Conversation(jid=IG, node=Node.QNA)
    r = flow.on_inbound(convo, Intent.TOLAK_TEGAS, "maaf belum tertarik", wa_cfg, now)
    assert _keys(r) == ["REPLY_TOLAK_TEGAS"]
    assert "DM_TO_WA" not in _keys(r)


def test_a_bare_greeting_in_a_dm_is_not_interest(wa_cfg, now):
    convo = Conversation(jid=IG, node=Node.QNA)
    r = flow.on_inbound(convo, Intent.UNKNOWN, "halo kak", wa_cfg, now)
    assert _keys(r) == ["REPLY_SAPAAN"]


def test_without_a_number_the_dm_offers_the_meeting_and_says_so(cfg, now):
    """BD_WHATSAPP_NUMBER is empty by default — the deck prints two numbers
    and nobody has said which takes DM leads. Unset, the DM behaves as it
    did before the hand-off existed, and a human is told why."""
    from bd_bot.flow import ProposeSlots

    assert cfg.bd_whatsapp_number == ""
    convo = Conversation(jid=IG, brand="Brand X", node=Node.QNA)
    r = flow.on_inbound(convo, Intent.TANYA_SISTEM, "sistemnya gimana?", cfg, now)
    assert _keys(r) == ["REPLY_TANYA_SISTEM", "OFFER_MEETING"]
    assert any("BD_WHATSAPP_NUMBER" in e for e in _escalations(r))

    convo = Conversation(jid=IG, brand="Brand X", node=Node.QNA)
    r = flow.on_inbound(convo, Intent.SETUJU, "boleh, kapan?", cfg, now)
    assert any(isinstance(a, ProposeSlots) for a in r.actions)
    assert "DM_TO_WA" not in _keys(r)


def test_whatsapp_conversations_never_see_the_hand_off(wa_cfg, now):
    """A number configured changes nothing on WhatsApp — the lead is already
    there. Agreement books, questions close with the meeting."""
    from bd_bot.flow import ProposeSlots

    convo = Conversation(jid=JID4, brand="Brand X", node=Node.QNA)
    r = flow.on_inbound(convo, Intent.SETUJU, "boleh, kapan?", wa_cfg, now)
    assert any(isinstance(a, ProposeSlots) for a in r.actions)
    assert node_of(r) is Node.SCHEDULING

    convo = Conversation(jid=JID4, brand="Brand X", node=Node.QNA)
    r = flow.on_inbound(convo, Intent.TANYA_SISTEM, "sistemnya gimana?", wa_cfg, now)
    assert _keys(r) == ["REPLY_TANYA_SISTEM", "OFFER_MEETING"]
    assert not _escalations(r)

    convo = Conversation(jid=JID4)
    r = flow.on_inbound(convo, Intent.LEAD_IKLAN, "Halo! Bisa minta info lebih lanjut tentang ini?", wa_cfg, now)
    assert _keys(r) == ["INBOUND_QUALIFY"], "WhatsApp keeps the four-line form"


def test_a_one_line_form_captures_only_the_brand(cfg, now):
    """"Nama Brand: X, Posisi di Brand: owner, Link Shopee: …" typed on one
    line used to be captured whole, and then read back in every reply."""
    convo = Conversation(jid=JID4, node=Node.INBOUND_QUALIFY)
    flow.on_inbound(
        convo, Intent.ISI_FORM,
        "Nama Brand: Brand Uji, Posisi di Brand: owner, Link Shopee: [link]", cfg, now,
    )
    assert convo.brand == "Brand Uji"
    # The multi-line shape, and a name with a comma in it, are unchanged.
    convo = Conversation(jid=JID4, node=Node.INBOUND_QUALIFY)
    flow.on_inbound(convo, Intent.ISI_FORM, "• Nama Brand: Kopi, Roti & Co\n• Posisi: owner", cfg, now)
    assert convo.brand == "Kopi, Roti & Co"


# --- the answer to our own focus question (24 Sep 2026) ----------------------
#
# Parent testing: after REPLY_TANYA_HARGA's "awareness, peningkatan penjualan,
# atau keduanya?", "Lebih ke sales kak" was UNKNOWN (freeform + a strike) and
# "dua-duanya kak" was OK_LANJUT (a slot list). Modelled on the CRM PDF's
# story-reply script ("Siap Kak. Kalau fokus utamanya sales…") and the team's
# "percepatan sale … beriringan meningkatkan awareness".


@pytest.mark.parametrize("text, key, must_say", [
    ("Lebih ke sales kak", "REPLY_FOKUS_SALES", "penjualan"),
    ("dua-duanya kak", "REPLY_FOKUS_KEDUANYA", "keduanya"),
    ("keduanya", "REPLY_FOKUS_KEDUANYA", "awareness"),
    ("pengen naikin awareness", "REPLY_FOKUS_AWARENESS", "UGC"),
])
def test_the_focus_answer_is_acknowledged_and_invited_on_whatsapp(cfg, now, text, key, must_say):
    from bd_bot.flow import ProposeSlots

    convo = Conversation(jid=JID4, brand="Glow", node=Node.QNA, unknown_streak=1)
    r = flow.on_inbound(convo, Intent.FOKUS_CAMPAIGN, text, cfg, now)
    assert _keys(r) == [key], _keys(r)
    body = _texts(r)[0]
    assert must_say in body
    assert "Campaign Affiliate" in body, "the need is tied to the fitting service"
    assert "hari dan jam berapa" in body, "then it moves forward: the meeting ask"
    assert "Rp" not in body and not any(ch.isdigit() for ch in body), "no new figures"
    assert not any(isinstance(a, ProposeSlots) for a in r.actions), "acknowledge, do not book"
    assert node_of(r) is Node.OFFER_MEETING
    assert timers(r) == [Timer.WARM_D2]
    assert convo.unknown_streak == 0, "answering us is not an unknown strike"
    assert not _escalations(r)


def test_the_focus_answer_in_a_dm_moves_to_whatsapp(wa_cfg, now):
    """DM_SERVICE_PITCH asks the same question; the answer is the interest
    signal, and interest moves to WhatsApp — the acknowledgement happens
    there, with the deck."""
    convo = Conversation(jid=IG, brand="Glow", node=Node.QNA)
    r = flow.on_inbound(convo, Intent.FOKUS_CAMPAIGN, "Lebih ke sales kak", wa_cfg, now)
    assert _keys(r) == ["DM_TO_WA"]
    assert node_of(r) is Node.WA_HANDOFF


def test_the_focus_answer_in_a_dm_without_a_number_is_acknowledged(cfg, now):
    convo = Conversation(jid=IG, brand="Glow", node=Node.QNA)
    r = flow.on_inbound(convo, Intent.FOKUS_CAMPAIGN, "dua-duanya kak", cfg, now)
    assert _keys(r) == ["REPLY_FOKUS_KEDUANYA"]


def test_a_focus_line_in_the_form_reply_joins_the_menu_path(cfg, now):
    """"Kebutuhan: meningkatkan penjualan" under the form is the form being
    answered — the menu (which invites) goes out once."""
    convo = Conversation(jid=JID4, node=Node.INBOUND_QUALIFY)
    r = flow.on_inbound(convo, Intent.FOKUS_CAMPAIGN, "penjualan", cfg, now)
    assert _keys(r) == ["INBOUND_SERVICE_MENU"]


# --- round 3 (24 Sep 2026): the wider inbound test, real corpus questions ---


def test_a_live_streaming_price_question_is_not_answered_with_the_affiliate_price(cfg, now):
    """"Berapa harga unt LS nya kak?" got the Rp10 juta affiliate anchor —
    the wrong service. The standalone live price is meeting-only; what may
    be named is the live INCLUDED in the deck's bundle and Full Service, with
    those figures exactly (knowledge.OFFERS)."""
    from bd_bot import knowledge

    convo = Conversation(jid=JID4, brand="Hijab X", node=Node.QNA)
    r = flow.on_inbound(convo, Intent.TANYA_HARGA_LIVE, "Berapa harga unt LS nya kak?", cfg, now)
    assert _keys(r) == ["REPLY_TANYA_HARGA_LIVE", "OFFER_MEETING"]
    body = _texts(r)[0]
    assert "Rp10" not in body and "100 affiliate" not in body.lower()
    assert "19.899.000" in body and "55.000.000" in body and "mulai Rp55" in body
    assert "belum bisa saya sebutkan" in body, "the standalone live price stays with the meeting"
    for amount in ("19.899.000", "55.000.000"):
        assert amount in knowledge.ALLOWED_AMOUNTS


def test_a_deck_request_gets_the_file_and_the_needs_question(cfg, now):
    """"ada rate card atau company profile?" got the curation criteria."""
    from bd_bot import templates

    convo = Conversation(jid=JID4, node=Node.QNA)
    r = flow.on_inbound(convo, Intent.MINTA_PROFILE, "saya dari agency, ada rate card atau company profile?", cfg, now)
    assert _keys(r) == ["REPLY_MINTA_PROFILE"]
    msg = [a.message for a in r.actions if isinstance(a, Send)][0]
    assert msg.attach_company_profile, "they asked for the file"
    assert "REPLY_MINTA_PROFILE" in templates._WITH_PROFILE
    assert "kategori produk apa" in _texts(r)[0] and "berapa affiliate" in _texts(r)[0]
    assert "dikurasi" not in _texts(r)[0]


def test_an_agency_looking_for_a_vendor_is_welcomed_asked_and_invited(cfg, now):
    convo = Conversation(jid=JID4, node=Node.QNA, unknown_streak=1)
    r = flow.on_inbound(convo, Intent.AGENCY_VENDOR, "kita handle beberapa klien yang ada kebutuhan affiliate", cfg, now)
    assert _keys(r) == ["REPLY_AGENCY_VENDOR"]
    body = _texts(r)[0]
    assert "agency" in body and "kategori produk apa" in body and "berapa affiliate" in body
    assert "hari dan jam berapa" in body
    assert node_of(r) is Node.OFFER_MEETING
    assert convo.unknown_streak == 0
    assert any("agency" in e for e in _escalations(r)), "a reseller lead is worth a human's eye"


def test_the_after_contract_video_question_gets_the_corpus_fact(cfg, now):
    from bd_bot import knowledge

    convo = Conversation(jid=JID4, brand="Ngemil", node=Node.QNA)
    r = flow.on_inbound(convo, Intent.TANYA_VIDEO_SETELAH_KONTRAK,
                        "Kalau udh 4 bulan itu vt nya bakal di privasi atau gimana ka?", cfg, now)
    assert _keys(r) == ["REPLY_TANYA_VIDEO_SETELAH_KONTRAK", "OFFER_MEETING"]
    body = _texts(r)[0]
    assert "tetap tayang" in body and "seller center" in body
    assert "takedown" in knowledge.CONTENT_AFTER_CONTRACT
    assert "VIDEO SETELAH KONTRAK" in knowledge.fact_sheet()
    assert not any(ch.isdigit() for ch in body)


def test_a_product_fit_question_is_answered_and_escalated_not_handed_over(cfg, now):
    """"Klo produk digital itu apakah bisa jualan di shopee dan tiktok shop?"
    was the second UNKNOWN in a row, and the second UNKNOWN is the handover —
    which opens "Terima kasih atas waktunya", a goodbye to an open question.
    The template promises a check with the team; the escalation is that check."""
    convo = Conversation(jid=JID4, node=Node.QNA, unknown_streak=1)
    r = flow.on_inbound(convo, Intent.TANYA_KATEGORI_PRODUK,
                        "Klo produk digital itu apakah bisa jualan di shopee dan tiktok shop kk?", cfg, now)
    assert _keys(r) == ["REPLY_TANYA_KATEGORI_PRODUK", "OFFER_MEETING"]
    assert "HANDOVER" not in _keys(r)
    assert node_of(r) is not Node.HANDOVER
    assert convo.unknown_streak == 0
    assert any("produk" in e for e in _escalations(r))
    assert "shopee" not in _texts(r)[0].lower().replace("tiktok shop, shopee", ""), (
        "no platform verdict from one conversation's product knowledge")


def test_the_portfolio_answer_names_only_the_decks_clients(cfg, now):
    from bd_bot import knowledge

    convo = Conversation(jid=JID4, brand="Kosmetik X", node=Node.QNA)
    r = flow.on_inbound(convo, Intent.TANYA_PORTOFOLIO, "Brand kosmetik apa yg sudah kerja sama dgn kk ya", cfg, now)
    assert _keys(r) == ["REPLY_TANYA_PORTOFOLIO", "OFFER_MEETING"]
    body = _texts(r)[0]
    for name in knowledge.CLIENTS:
        assert name in body
    for leak in ("C'Kel", "Perlyco", "Canni", "Corolla", "Elvicto"):
        assert leak not in body, f"{leak} is in the corpus, not the deck"


def test_chat_first_still_leaves_the_meeting_open_the_teams_way(cfg, now):
    """Still answered in chat (29 Jul decision). The door is left open with
    the team's framing — chat is limited, and the meeting "tidak mengharuskan
    langsung deal" — and no slot ask or OFFER_MEETING is stacked on top."""
    convo = Conversation(jid=JID4, brand="Brand Uji", node=Node.QNA)
    r = flow.on_inbound(convo, Intent.MINTA_CHAT, "Harus meeting kah kak? Atau bisa by chat saja?", cfg, now)
    assert _keys(r) == ["REPLY_MINTA_CHAT"]
    body = _texts(r)[0]
    assert "boleh kita bahas lewat chat" in body
    assert "tidak mengharuskan" in body and "terbatas" in body
    assert "hari dan jam" not in body


def test_a_single_form_label_mid_chat_is_read_as_the_form(cfg, now):
    convo = Conversation(jid=JID4, node=Node.QNA)
    r = flow.on_inbound(convo, Intent.ISI_FORM, "Nama Brand: brand uji, frozen food", cfg, now)
    assert _keys(r) == ["INBOUND_SERVICE_MENU"]
    assert convo.brand == "brand uji, frozen food"
