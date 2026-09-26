"""Golden-conversation tests (ROADMAP 0.3).

Eight real conversations from chat-example/, replayed against the flow:
each step feeds a real (anonymized) client turn through the rule classifier
and asserts the intent, the reply templates, and the node transition the
system produces today. They pin current behaviour — where the desired
behaviour (per the transcript) is not yet built, the assertion lives in an
`xfail(strict=True)` test that will flip loudly when the fix lands.

Emails here are anonymized stand-ins; the wording of every turn is verbatim
from the exports.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bd_bot import flow, intents  # noqa: E402
from bd_bot.config import Settings  # noqa: E402
from bd_bot.flow import (  # noqa: E402
    BookMeeting,
    Escalate,
    NotifyGroup,
    ProposeSlots,
    Schedule,
    Send,
    SetNode,
)
from bd_bot.models import Conversation, Intent, Node, Timer  # noqa: E402


@pytest.fixture
def cfg() -> Settings:
    return Settings()


@pytest.fixture
def now() -> datetime:
    return datetime(2026, 7, 21, 10, 0)


def sends(result) -> list[str]:
    return [a.message.text for a in result.actions if isinstance(a, Send)]


def keys(result) -> list[str]:
    return [a.message.key for a in result.actions if isinstance(a, Send)]


def timers(result) -> list[Timer]:
    return [a.timer for a in result.actions if isinstance(a, Schedule)]


def node_of(result) -> Node | None:
    for a in reversed(result.actions):
        if isinstance(a, SetNode):
            return a.node
    return None


def say(convo, text, cfg, now, expect: Intent):
    """One client turn: classify the real text, assert the intent, drive the
    flow, and apply the node transition the engine would."""
    intent = intents.classify_rules(text)
    assert intent is expect, f"{text[:60]!r} classified {intent}, expected {expect}"
    r = flow.on_inbound(convo, intent, text, cfg, now)
    if (n := node_of(r)) is not None:
        convo.node = n
    return r


def fire(convo, timer, cfg, now):
    r = flow.on_timer(convo, timer, cfg, now)
    if (n := node_of(r)) is not None:
        convo.node = n
    return r


def book(convo, cfg, now):
    """Simulate the engine's booking step after a BookMeeting action."""
    convo.meeting_at = (now + timedelta(days=1)).replace(hour=13, minute=0)
    convo.meet_link = "https://meet.google.com/gold-test-link"
    r = flow.on_meeting_booked(convo, cfg, now)
    if (n := node_of(r)) is not None:
        convo.node = n
    return r


def booked(result) -> bool:
    return any(isinstance(a, BookMeeting) for a in result.actions)


def proposed(result) -> bool:
    """Acceptance now offers concrete slots (ROADMAP 2.2); the engine
    resolves them, so at flow level the marker action is what to assert."""
    return any(isinstance(a, ProposeSlots) for a in result.actions)


# --- 1. "Client 7 Kak Daniel": dashboard doubt -> booked in minutes ----------


def test_golden_daniel_question_to_booked_meeting(cfg, now):
    convo = Conversation(jid="628@s.whatsapp.net", brand="Nestlab", node=Node.QNA)

    r = say(convo, "Sebelum kita lanjut apakah kita bisa lihat langsung dashboard "
            "brand yg dihandle juga?", cfg, now, Intent.TANYA_PORTOFOLIO)
    assert keys(r) == ["REPLY_TANYA_PORTOFOLIO", "OFFER_MEETING"]
    assert convo.node is Node.OFFER_MEETING

    r = say(convo, "Ok pas", cfg, now, Intent.OK_LANJUT)
    assert proposed(r), "agreement gets concrete slot options"
    assert convo.node is Node.SCHEDULING

    r = say(convo, "boleh, email saya daniel@example.com ya", cfg, now, Intent.SETUJU)
    assert convo.email == "daniel@example.com"
    assert booked(r)

    r = book(convo, cfg, now)
    assert keys(r)[0] == "SCHEDULE_CONFIRM"
    assert any(isinstance(a, NotifyGroup) for a in r.actions)
    assert convo.node is Node.SCHEDULED

    r = flow.on_meeting_outcome(convo, joined=True, cfg=cfg, now=now)
    assert node_of(r) is Node.MEETING_DONE
    # ROADMAP 1.5: the post-meeting promise is kept by a human.
    assert any(isinstance(a, Escalate) for a in r.actions)
    assert "ringkasan" not in sends(r)[0].lower()


# --- 2. "Client 3 Nana": inbound ad lead, price staging, Zoom steer ----------


def test_golden_nana_qna_to_booking(cfg, now):
    """Full inbound journey: ad opener -> qualification form -> brand capture
    -> service pitch -> Q&A -> Zoom steer -> email -> booked. ROADMAP 2.1."""
    convo = Conversation(jid="628@s.whatsapp.net")  # Node.NEW, never blasted

    # The intent is now TANYA_PAKET_LAMA (the 150 tier was withdrawn 29 Jul
    # 2026), but a first inbound still gets the qualification form: Node.NEW
    # routing runs ahead of intent, so the ad-lead SOP is unchanged.
    r = say(convo, "[Spesial offer] Saya tertarik untuk Paket 150 affiliate "
            "Mcnasia.biz?", cfg, now, Intent.TANYA_PAKET_LAMA)
    assert keys(r) == ["INBOUND_QUALIFY"]
    assert "Nama Brand" in sends(r)[0]
    assert convo.node is Node.INBOUND_QUALIFY

    # ISI_FORM since Sep 2026, when the inbound corpus made the filled form
    # its own intent. A relabel, not a behaviour change: the reply is the
    # same INBOUND_SERVICE_MENU it always was — the flow's qualify branch
    # treats ISI_FORM exactly as it treated the UNKNOWN this used to be.
    r = say(convo, "• Nama Brand: C'kel\n• Posisi di Brand: pemilik\n"
            "• Link Shopee: shopee.co.id/ckel", cfg, now, Intent.ISI_FORM)
    assert keys(r) == ["INBOUND_SERVICE_MENU"]
    assert convo.brand == "C'kel", "the form reply names the brand"
    assert convo.node is Node.QNA

    r = say(convo, "Kalo pun tidak end to end emang nya ada paket apa saja ?\n"
            "Bisa gak di jelaskan ,supaya lebih rinci dan lebih mengerti",
            cfg, now, Intent.TANYA_HARGA)
    assert keys(r) == ["REPLY_TANYA_HARGA"], "first ask gets the anchor only"
    assert "Rp10 juta" in sends(r)[0] and "Rp10.000.000" not in sends(r)[0]
    assert convo.price_stage == 1

    r = say(convo, "Berapa ya utk jasa end to end\nSaya masi pemula umkm",
            cfg, now, Intent.TANYA_HARGA)
    assert keys(r) == ["REPLY_PAKET_DETAIL", "OFFER_MEETING"]
    assert convo.price_stage == 2

    r = say(convo, "Posisi kalian di mana ya", cfg, now, Intent.TANYA_LOKASI)
    assert keys(r) == ["REPLY_TANYA_LOKASI", "OFFER_MEETING"]
    assert "Seasons City" in sends(r)[0]

    r = say(convo, "Apakah kita bisa ngobrol via Zoom nantinya",
            cfg, now, Intent.MINTA_TELEPON)
    assert keys(r) == ["REPLY_MINTA_TELEPON"], "steer to Google Meet per SOP"
    assert convo.node is Node.SCHEDULING

    # A day without an email: the bot asks for it — exactly what the real
    # agent did ("bantu email-nya juga yah kak"). The slot proposal now
    # classifies as agreement (Phase-2 time-proposal patterns).
    r = say(convo, "Bole deh senin di jam 15.30 ya", cfg, now, Intent.SETUJU)
    assert keys(r) == ["ASK_EMAIL"]
    assert not booked(r)

    r = say(convo, "Brand : C'kel\nEmail : nana@example.com", cfg, now, Intent.UNKNOWN)
    assert convo.email == "nana@example.com"
    assert booked(r)

    r = book(convo, cfg, now)
    assert "meet.google.com" in sends(r)[0]


# --- 3. "Xiaofen brand SARINA": agreement from the blast, reminders ----------


def test_golden_sarina_agreement_and_reminders(cfg, now):
    convo = Conversation(jid="628@s.whatsapp.net", brand="SARINA", node=Node.BLASTED)

    r = say(convo, "Hi kak, sorry slow respon\nBoleh kapan bisa meeting ya\n"
            "Saya cek jadwal saya jg 🙏🏻", cfg, now, Intent.SETUJU)
    assert proposed(r), "agreement gets concrete slot options"
    assert convo.node is Node.SCHEDULING

    r = say(convo, "sarina@example.com", cfg, now, Intent.UNKNOWN)
    assert booked(r)

    r = book(convo, cfg, now)
    reminders = [t for t in timers(r) if t is Timer.REMINDER]
    assert len(reminders) == 2, "H-2 and H-1 reminders armed"
    assert Timer.MEETING_END in timers(r)


def test_post_booking_reschedule_is_answered(cfg, now):
    """A reschedule request after booking used to get silence (SCHEDULED
    swallowed acceptance intents) — SARINA really asked this. Fixed in 2.1:
    acknowledged, and the calendar change goes to a human."""
    convo = Conversation(jid="628@s.whatsapp.net", node=Node.SCHEDULED)
    text = ("Kakk sorry bangett boleh di reschedule gak yaa di jam 4 sore "
            "sampai jam 5 sore?")
    r = flow.on_inbound(convo, intents.classify_rules(text), text, cfg, now)
    assert keys(r) == ["REPLY_RESCHEDULE"]
    assert any(isinstance(a, Escalate) for a in r.actions)


# --- 4. "NORDES": mixed-language RFP, quick-call steer, email, booking -------


def test_golden_nordes_mixed_language_rfp(cfg, now):
    convo = Conversation(jid="628@s.whatsapp.net", brand="NORDES", node=Node.QNA)

    # The English RFP asks several things at once; "Process & timeline"
    # wins the rule order (gold labels it tanya_affiliate — the residual
    # error is recorded there). Behaviour is safe either way: a substantive
    # answer plus the meeting ask, no rejection.
    rfp = (
        "Hi MCNAsia,\nI'm Nina from NORDES — a local skincare brand. We're "
        "interested in exploring a partnership for creator sourcing and "
        "TikTok Live support.\nCould you kindly help share:\n"
        "- Creator pool availability matching the criteria above, along with "
        "rate cards\n- Historical performance data (GMV, average viewers, "
        "conversion rate) for Live creator candidates\n"
        "- Process & timeline if we move forward"
    )
    r = say(convo, rfp, cfg, now, Intent.TANYA_TIMELINE)
    assert keys(r) == ["REPLY_TANYA_TIMELINE", "OFFER_MEETING"]
    assert convo.node is not Node.STOPPED

    r = say(convo, "Hi kak, kira kira kita bisa quick call untuk discuss lebih "
            "lanjut tidak yaa?\nI have several questions and wanted to explore "
            "MCN Asia in products details", cfg, now, Intent.MINTA_TELEPON)
    assert keys(r) == ["REPLY_MINTA_TELEPON"]
    assert convo.node is Node.SCHEDULING

    # "di hari senin possible kak?" asks what is open on Monday. Answering
    # with a bare "boleh dibantu alamat email-nya?" ignores the question; the
    # slot proposal answers it and asks for the email in the same breath.
    r = say(convo, "boleh kak, di hari senin possible kak?", cfg, now, Intent.SETUJU)
    assert proposed(r), "an availability question gets the times, not just an email ask"

    # SETUJU since `_normalise` started canonicalising addresses to the token
    # "email": the existing `^email…berikut` rule was written for that shape
    # but, before the fix, only ever saw it in the redacted chat exports — a
    # real address arrived as "syabina example com" and matched nothing. The
    # flow is unchanged either way (the address is captured and the meeting
    # books); the label is simply now the honest one.
    r = say(convo, "syabina@example.com\nberikut yaa kak emailnya",
            cfg, now, Intent.SETUJU)
    assert booked(r)


# --- 5. "Client 2 Wiwi Whendra": price anchor, stall, warm ladder, decay -----


def test_golden_wiwi_price_then_stall_decays(cfg, now):
    convo = Conversation(jid="628@s.whatsapp.net", brand="wilica", node=Node.BLASTED)

    r = say(convo, "Utk harganya gmn y utk layannnya", cfg, now, Intent.TANYA_HARGA)
    assert keys(r) == ["REPLY_TANYA_HARGA"]
    assert convo.node is Node.QNA

    r = say(convo, "Coba sy pelajarin dl ya kak\nTar klo mau meeting online sy "
            "kabarin lg ya", cfg, now, Intent.PELAJARI_DULU)
    assert keys(r) == ["REPLY_PELAJARI_DULU"]
    assert convo.node is Node.WARM_D2
    assert timers(r) == [Timer.WARM_D2]

    # She never came back. The warm ladder runs out, then decays silently.
    r = fire(convo, Timer.WARM_D2, cfg, now)
    assert keys(r) == ["WARM_D2"] and timers(r) == [Timer.WARM_D5]
    r = fire(convo, Timer.WARM_D5, cfg, now)
    assert keys(r) == ["WARM_D5"] and timers(r) == [Timer.DECAY_STOP]
    r = fire(convo, Timer.DECAY_STOP, cfg, now)
    assert convo.node is Node.STOPPED and not sends(r)


def test_wiwi_rundingkan_defers_not_accepts():
    """'Ok sip sy rundingkan dl ya kak' is a deferral (discuss internally
    first) — the leading 'ok' must not read as acceptance. Wiwi said exactly
    this and was NOT agreeing to a meeting. Fixed in Phase 2."""
    pred = intents.classify_rules("Ok sip sy rundingkan dl ya kak")
    assert pred in {Intent.TERUSKAN_TIM, Intent.PELAJARI_DULU}


# --- 6. "+62 815…0803": cold ladder, komisi objection, email, booking --------


def test_golden_0803_cold_ladder_and_komisi(cfg, now):
    convo = Conversation(jid="628@s.whatsapp.net", brand="Haruka")

    r = flow.on_blast(convo, cfg, now)
    convo.node = node_of(r)
    assert convo.node is Node.BLASTED
    assert timers(r) == [Timer.COLD_FU1]

    r = fire(convo, Timer.COLD_FU1, cfg, now)
    assert keys(r) == ["COLD_FU1"] and timers(r) == [Timer.COLD_FU2]
    first_send = next(a for a in r.actions if isinstance(a, Send))
    assert not first_send.message.attach_company_profile, (
        "COLD_FU1 no longer ships the profile — the opening already sent the "
        "deck, and repeating a PDF at every rung reads as spam rather than "
        "service. It now goes where a brand would want it open: the portfolio "
        "answer, the keep-it-in-chat answer, and a firm no."
    )

    r = say(convo, "Itu kan komisi ada komisi 10% utk MCN. Dan komisi utk "
            "affiliate sendiri. Jadi double dong?", cfg, now, Intent.TANYA_KOMISI)
    assert any(isinstance(a, flow.CancelTimers) for a in r.actions)
    assert keys(r) == ["REPLY_TANYA_KOMISI", "OFFER_MEETING"]

    r = say(convo, "Ya boleh", cfg, now, Intent.SETUJU)
    assert convo.node is Node.SCHEDULING

    r = say(convo, "Bisa", cfg, now, Intent.UNKNOWN)
    assert keys(r) == ["ASK_EMAIL"]

    r = say(convo, "finda@example.com ya", cfg, now, Intent.UNKNOWN)
    assert booked(r)


# --- 7. "+62 851…6865": the objection gauntlet -------------------------------


def test_golden_851_objection_gauntlet(cfg, now):
    convo = Conversation(jid="628@s.whatsapp.net", brand="Honnete", node=Node.QNA)

    r = say(convo, "Bisa ka\nTelepon aja dulu y ka", cfg, now, Intent.MINTA_TELEPON)
    assert keys(r) == ["REPLY_MINTA_TELEPON"]
    assert convo.node is Node.SCHEDULING

    r = say(convo, "Ini lokasi kantor dimana y ka", cfg, now, Intent.TANYA_LOKASI)
    assert keys(r) == ["REPLY_TANYA_LOKASI", "OFFER_MEETING"]

    r = say(convo, "Soalny ky bnyk penipuan gt ka. Jd aku agak takut, sblmnya "
            "sorry y ka", cfg, now, Intent.TANYA_LOKASI)
    assert "kontrak" in sends(r)[0].lower(), "the scam worry is met with the contract-first fact"

    r = say(convo, "Ok ka, ka aku mau tanya nih misal ud kirim sample trs "
            "affiliatenya gk review malah hilang. Itu gimana ka?",
            cfg, now, Intent.TANYA_SAMPLE)
    assert keys(r) == ["REPLY_TANYA_SAMPLE", "OFFER_MEETING"]
    assert "garansi" in sends(r)[0].lower()

    r = say(convo, "Ini kl mau DP apa full payment ka?", cfg, now,
            Intent.TANYA_PEMBAYARAN)
    assert keys(r) == ["REPLY_TANYA_PEMBAYARAN", "OFFER_MEETING"]

    # Price pressure goes to a human — the real agent said "saya diskusikan
    # dengan manajemen".
    r = say(convo, "Trs untuk harga aku minta dikurangi bs gak y ka?",
            cfg, now, Intent.NEGO_HARGA)
    assert keys(r) == ["REPLY_NEGO_HARGA"]
    assert any(isinstance(a, Escalate) for a in r.actions)


# --- 8. "Client Asal - beauty": own Zoom link steered to our Meet ------------


def test_golden_asal_own_zoom_steered_to_meet(cfg, now):
    # Her opener carried real questions, so the qualify node lets it fall
    # through to Q&A instead of pitching over the question.
    convo = Conversation(
        jid="628@s.whatsapp.net", brand="Perlyco", node=Node.INBOUND_QUALIFY
    )

    r = say(convo, "[Spesial offer] Saya tertarik untuk Paket 150 affiliate "
            "Mcnasia.biz?\ntata cara gimana ?\napa hasil yg di dapatkan ?\n"
            "adakah KPI ?\ncost ?", cfg, now, Intent.TANYA_AFFILIATE)
    assert keys(r) == ["REPLY_TANYA_AFFILIATE", "OFFER_MEETING"]

    r = say(convo, "besok siang jam 2 , saya ijin call ya", cfg, now,
            Intent.MINTA_TELEPON)
    assert convo.node is Node.SCHEDULING

    # She sent her own Zoom invite; the real agent re-steered ("untuk link nya
    # biar kami yg setup") — and so does the flow.
    r = say(convo, "Asal is inviting you to a scheduled Zoom meeting.\n"
            "jumat tgl 17 juli , jam 14:00 wib\nJoin Zoom Meeting\n"
            "https://example.zoom.us/j/000", cfg, now, Intent.MINTA_TELEPON)
    assert keys(r) == ["REPLY_MINTA_TELEPON"]
    assert convo.node is Node.SCHEDULING

    r = say(convo, "ok\nemail :\nkolosal@example.net", cfg, now, Intent.OK_LANJUT)
    assert convo.email == "kolosal@example.net"
    assert booked(r)


# --- the inbound entry (ROADMAP 2.1, was xfail until built) ------------------


def test_inbound_first_contact_gets_qualification_form(cfg, now):
    """An inbound ad lead's first message gets the qualification form
    (Nama Brand / Posisi / links) — the SOP observed in all six 'Client N'
    exports."""
    convo = Conversation(jid="628@s.whatsapp.net")  # Node.NEW, never blasted
    text = "[Spesial offer] Saya tertarik untuk Paket 150 affiliate Mcnasia.biz?"
    r = flow.on_inbound(convo, intents.classify_rules(text), text, cfg, now)
    assert any("Nama Brand" in t for t in sends(r))
