"""The state machine.

Pure logic: every entry point takes a Conversation plus an event and returns a
list of Actions. Nothing here touches WhatsApp, the database, or the clock
beyond the `now` passed in — which makes the whole flow testable without a
network.

Implements FLOWCHART.md, including the fixes for the gaps it documents:
  §6.1 closing gadget never decays  -> gadget_loops + DECAY_STOP
  §6.2 no fallback for unknown      -> unknown_streak -> HANDOVER
  §6.3 no human handover            -> Escalate action + HANDOVER node
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from . import intents, meta
from .config import Settings
from .models import (
    INTENT_OUTCOME,
    Conversation,
    Intent,
    Node,
    Outcome,
    Timer,
)
from .templates import Message, render

# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class Send:
    message: Message


@dataclass(slots=True)
class Schedule:
    timer: Timer
    fire_at: datetime


@dataclass(slots=True)
class CancelTimers:
    """Invariant 1: any inbound reply cancels every pending timer."""


@dataclass(slots=True)
class SetNode:
    node: Node
    outcome: Outcome


@dataclass(slots=True)
class BookMeeting:
    """Create the Calendar event + Meet link. Payload filled by the executor."""

    preferred: str = ""


@dataclass(slots=True)
class ProposeSlots:
    """Offer 1–2 concrete free calendar slots (ROADMAP 2.2).

    The engine resolves the slots — the real agents propose ("kita kosong di
    jam 12:00, possible kak?") and it books in minutes, where the open "hari
    dan jam berapa?" question stalls. When the calendar is unreachable the
    engine sends `fallback` (the open ask) instead, so agreement never goes
    unanswered."""

    fallback: Message


@dataclass(slots=True)
class NotifyGroup:
    text: str


@dataclass(slots=True)
class Escalate:
    reason: str
    inbound_text: str = ""


Action = (
    Send
    | Schedule
    | CancelTimers
    | SetNode
    | BookMeeting
    | ProposeSlots
    | NotifyGroup
    | Escalate
)


@dataclass(slots=True)
class Result:
    actions: list[Action] = field(default_factory=list)

    def send(self, name: str, convo: Conversation, cfg: Settings, **extra: str) -> None:
        self.actions.append(Send(render(name, convo, cfg, **extra)))

    def at(self, timer: Timer, when: datetime) -> None:
        self.actions.append(Schedule(timer, when))

    def go(self, node: Node, outcome: Outcome) -> None:
        self.actions.append(SetNode(node, outcome))


# ---------------------------------------------------------------------------
# Timing helpers
# ---------------------------------------------------------------------------

#: Delays for each timer. FLOWCHART.md §2.5.
DELAYS: dict[Timer, timedelta] = {
    Timer.COLD_FU2: timedelta(days=1),
    Timer.COLD_FU3: timedelta(days=3),
    Timer.COLD_FU4: timedelta(days=5),
    Timer.WARM_D2: timedelta(days=2),
    Timer.WARM_D5: timedelta(days=5),
    Timer.MENUNDA_H1: timedelta(days=1),
    Timer.MENUNDA_H3: timedelta(days=3),
    Timer.NOSHOW_1: timedelta(days=1),
    Timer.NOSHOW_2: timedelta(days=2),
    Timer.REJECT_PROMO: timedelta(days=5),
    Timer.DECAY_STOP: timedelta(days=5),
}


def first_cold_touch(now: datetime, cfg: Settings) -> datetime:
    """COLD_FU1 fires the same day at 16:00, or +4h if that's already past.

    Reconciles the whiteboard's two conflicting cold-track timings
    ("max 4 jam" on the control layer, "H0 Pukul 16.00" on the knowledge
    layer) — see README, Resolved conflicts.
    """
    today_16 = now.replace(hour=16, minute=0, second=0, microsecond=0)
    return today_16 if now < today_16 else now + timedelta(hours=4)


# ---------------------------------------------------------------------------
# Entry point: outbound blast
# ---------------------------------------------------------------------------


def on_blast(convo: Conversation, cfg: Settings, now: datetime) -> Result:
    """FLOWCHART.md §5.1 — the opening message, then arm the cold ladder."""
    r = Result()
    r.send("BLASTING", convo, cfg)
    r.go(Node.BLASTED, Outcome.FOLLOWUP)
    r.at(Timer.COLD_FU1, first_cold_touch(now, cfg))
    return r


# ---------------------------------------------------------------------------
# Entry point: inbound message
# ---------------------------------------------------------------------------


_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")

#: Words that make up a contentless acknowledgement — "halo", "iya kak",
#: "selamat siang". A reply built only from these says nothing to act on.
_ACK_WORDS = frozenset(
    "halo hallo hai hi hello iya ya yaa yah oke ok okay okey baik siap "
    "selamat pagi siang sore malam kak kakak ka min gan tes test p".split()
)

#: Nodes where the brand has not really engaged yet — the blast and the cold
#: follow-up ladder. A bare ack here gets the pitch + needs question, not the
#: scheduling machine.
_EARLY_NODES = frozenset(
    {Node.BLASTED, Node.COLD_FU1, Node.COLD_FU2, Node.COLD_FU3, Node.COLD_FU4}
)

#: Nodes where a reply carrying an email (or an agreement) should drive the
#: booking. MENUNDA is included: the brand agreed, went quiet, got nudged —
#: their email reply is still a booking, not a new topic (gold-set finding).
_SCHEDULING_NODES = frozenset(
    {Node.SCHEDULING, Node.MENUNDA_H1, Node.MENUNDA_H3}
)


def books_on_email(convo: Conversation) -> bool:
    """Is an address arriving now the invitee for a meeting we are booking?

    The same nine characters mean opposite things: inside the scheduling
    machine they are the Google Meet invitee, and everywhere else they are a
    brand saying "send it to this inbox instead of meeting us".
    """
    return convo.node in _SCHEDULING_NODES


#: Greeting words only — no "iya"/"oke"/"baik", which mid-conversation are
#: agreement, not hello. Honorifics ride along so "pagi kak" still counts.
_GREETING_WORDS = frozenset(
    "halo hallo hai hay hi hello hei hey pagi siang sore malam selamat met "
    "salam kenal".split()
)
_GREETING_FILLER = frozenset("kak kakak kaka ka kk min gan bang mba mbak mas bu pak juga semua".split())


def _is_bare_greeting(text: str) -> bool:
    """A hello and nothing else — "siang", "halo kak", "selamat pagi".

    Narrower than `_is_bare_ack` on purpose: that set includes "iya" and
    "oke", which further along a conversation are acceptance and must keep
    reaching the scheduling machine.
    """
    words = re.findall(r"[a-zA-Z']+", text.lower())
    if not words or len(words) > 4:
        return False
    return any(w in _GREETING_WORDS for w in words) and all(
        w in _GREETING_WORDS or w in _GREETING_FILLER for w in words
    )


def _is_bare_ack(text: str) -> bool:
    words = re.findall(r"[a-zA-Z']+", text.lower())
    return 0 < len(words) <= 4 and all(w in _ACK_WORDS for w in words)


#: Asking what is open, rather than naming a time: "bisa di jam brp aja ya
#: kak?", "kalau Sabtu bisa ga ya ka?", "masih ada slot?".
_ASKS_AVAILABILITY_RE = re.compile(
    r"jam ber?apa|jam brp|jam brapa"
    r"|\b(bisa|bs|available|kosong|slot|free|open)\b[^?]*\?"
    r"|\b(senin|selasa|rabu|kamis|jumat|sabtu|minggu|besok|lusa)\b[^?]*\?"
)

#: "boleh di reschedule gak yaa di jam 4 sore" — a booked contact asking to
#: move the meeting. Times, day names, and reschedule verbs all count.
_RESCHEDULE_RE = re.compile(
    r"resched|ganti\s+(jam|hari|jadwal)|ubah\s+(jam|jadwal)|di?undur|mundur"
    r"|maju(in|kan)?\b|\bjam\s*\d{1,2}\b"
    r"|\b(besok|lusa|senin|selasa|rabu|kamis|jumat|sabtu)\b"
)

#: Around the call itself: joining, arriving, running late. Only consulted at
#: Node.SCHEDULED, so "bisa join meeting hari Senin?" earlier in the funnel is
#: still read as the scheduling question it is.
_MEETING_DAY_RE = re.compile(
    r"\b(join|joint|masuk|udah masuk|sudah masuk|telat|terlambat|otw|on my way"
    r"|standby|nunggu di ?room|di ?room|sharelo(k|c)\w*)\b"
    # "Pagi Ka apakah kita jadi meeting" — a booked brand checking we are
    # still on, listed as unplaced after the first inbound round. At
    # Node.SCHEDULED the answer is the link and a human, same as "join".
    r"|\bjadi\b.{0,12}\b(meet|meeting|gmeet)\w*|\b(meet|meeting|gmeet)\w*\b.{0,12}\bjadi\b"
)

#: "Nama Brand: wilica" / "Brand : C'kel" — the filled qualification form.
_BRAND_FIELD_RE = re.compile(
    r"(?:nama\s*brand|brand)\s*[:\-]\s*([^\n•|]+)", re.IGNORECASE
)


# ---------------------------------------------------------------------------
# Channel: is this a Meta DM? (24 Sep 2026)
#
# The BD funnel is comment → DM → WhatsApp → meeting. A DM (Instagram or
# Facebook) is where a lead is qualified and one exchange is had; the moment
# they show interest they are moved to WhatsApp, where the deck can be
# attached and the meeting is arranged. So a DM never runs the scheduling
# machine when a WhatsApp number is configured — its closing move is the
# hand-off, not the slot list. Everything below that says "DM" is gated on
# `dm_channel()`; WhatsApp conversations are untouched by it.
# ---------------------------------------------------------------------------

#: Turns that show interest without asking anything specific — the answer to
#: "sales, awareness, atau keduanya?", a "boleh", the need in one word. In a
#: DM past qualification these are the signal to move to WhatsApp.
_DM_INTEREST = frozenset(
    {
        Intent.UNKNOWN,
        Intent.OK_LANJUT,
        Intent.SETUJU,
        Intent.ISI_FORM,
        Intent.LEAD_IKLAN,
        Intent.MINTA_INFO,
        Intent.BUTUH_AFFILIATE,
        # The answer to DM_SERVICE_PITCH's own question — the interest
        # signal the DM was waiting for.
        Intent.FOKUS_CAMPAIGN,
    }
)


def dm_channel(convo: Conversation) -> str:
    """"instagram" / "facebook" for a Meta DM conversation, "" for WhatsApp.

    Two signals, either is enough: `Conversation.source`, which the Meta
    transport records (and which a CRM fronting this flow can set), and the
    jid prefix, which is there from the very first message. The prefix
    matters because on first contact the source is written only after the
    flow has run — see transport/meta.py — and the first message is exactly
    where the DM opener differs from the WhatsApp form.
    """
    if convo.source in (meta.INSTAGRAM, meta.FACEBOOK):
        return convo.source
    return meta.platform_of(convo.jid)


def handoff_ready(cfg: Settings) -> bool:
    """Is there a WhatsApp number to send a DM lead to?

    Empty means no hand-off: the DM keeps the lead and offers the meeting
    there, as it did before this existed. The number is a business decision
    (the deck prints two), so the bot never invents one.
    """
    return bool(cfg.bd_whatsapp_number.strip())


#: A form typed on ONE line — "Nama Brand: X, Posisi: owner, Link Shopee: …"
#: — has no newline for `_BRAND_FIELD_RE` to stop at, so the whole line was
#: captured as the brand and then read back to them in every reply ("cukup
#: relevan untuk X, Posisi: owner, Link Shopee: …"). Cut at the next field
#: label instead (24 Sep 2026).
_NEXT_FIELD_RE = re.compile(
    r"\s*[,;]?\s*(?=(?:posisi|jabatan|link|shopee|tiktok|tokopedia|email|produk|kebutuhan)\b)",
    re.IGNORECASE,
)


def _capture_brand(convo: Conversation, text: str) -> None:
    if convo.brand:
        return
    m = _BRAND_FIELD_RE.search(text)
    if m:
        brand = _NEXT_FIELD_RE.split(m.group(1), maxsplit=1)[0].strip().strip(".,;")
        if 0 < len(brand) <= 60:
            convo.brand = brand


def on_inbound(
    convo: Conversation, intent: Intent, text: str, cfg: Settings, now: datetime
) -> Result:
    r = Result()

    # Invariant 1 — a reply cancels everything pending.
    r.actions.append(CancelTimers())

    if convo.node is Node.HANDOVER:
        # A human owns this conversation now; the bot stays quiet.
        r.actions.append(Escalate("message during handover", text))
        return r

    if convo.node is Node.MEETING_DONE:
        # Post-meeting is human territory — the recap escalation handed the
        # conversation over, and the closing message promised "tim kami akan
        # menghubungi". Re-pitching a meeting here would be off-script.
        r.actions.append(Escalate("message after completed meeting", text))
        return r

    if convo.node is Node.STOPPED:
        if convo.stopped_reason == "opt_out":
            # Opt-out is permanent: never message them again, even in reply —
            # but a human should see that they wrote.
            r.actions.append(Escalate("message after opt-out", text))
            return r
        # A decayed or rejected contact who comes back has re-engaged —
        # fall through and let the machine answer like any warm reply.

    # Capture an email wherever it appears — booking needs it for the invite.
    email = _EMAIL_RE.search(text)
    if email:
        convo.email = email.group(0)

    outcome = INTENT_OUTCOME[intent]

    # A message asking about several different things gets one intent's
    # answer, so part of it goes unanswered with nothing to show for it.
    # Flag it for a human rather than letting the gap pass silently — the
    # reply below still goes out, this only adds the escalation. Placed after
    # the terminal-node returns so it never doubles up on their escalations.
    topics = intents.question_topics(text)
    if len(topics) >= 2:
        answered = intent.value
        rest = ", ".join(t.value for t in topics if t is not intent)
        r.actions.append(
            Escalate(f"multi-part question (answered {answered}; also asked: {rest})", text)
        )

    if intent is not Intent.UNKNOWN:
        convo.unknown_streak = 0

    # An ad lead's first message (never blasted): run the qualification SOP
    # observed in every inbound export — greeting + data form. ROADMAP 2.1.
    # Rejections still reject, and outright agreement skips straight to
    # scheduling; everything else gets the form first.
    if convo.node is Node.NEW and outcome is not Outcome.REJECTION:
        convo.unknown_streak = 0
        if outcome is Outcome.ACCEPTANCE:
            _acceptance(r, convo, intent, cfg, now)
            return r
        # A DM gets the PDF's IG-DM opener (brand, product, platform); a
        # WhatsApp lead gets the four-line form. Same node either way.
        r.send("INBOUND_QUALIFY_DM" if dm_channel(convo) else "INBOUND_QUALIFY", convo, cfg)
        r.go(Node.INBOUND_QUALIFY, Outcome.FOLLOWUP)
        r.at(Timer.WARM_D2, now + DELAYS[Timer.WARM_D2])
        return r

    # The form reply: capture the brand name, then either answer their
    # question through the normal machine or, for form data / bare acks,
    # send the service summary + meeting ask (the observed next SOP step).
    if convo.node is Node.INBOUND_QUALIFY:
        _capture_brand(convo, text)
        # The need stated in one word ("affiliate") and the vague "mau info"
        # are answers to the form, not questions — they join the menu path.
        # The menu ends with the meeting ask, and BUTUH_AFFILIATE's own reply
        # would ask it a second time in the same breath.
        answered_form = (
            intent in {Intent.UNKNOWN, Intent.OK_LANJUT, Intent.ISI_FORM,
                       Intent.BUTUH_AFFILIATE, Intent.MINTA_INFO, Intent.FOKUS_CAMPAIGN}
            or _is_bare_ack(text)
        )
        if answered_form:
            convo.unknown_streak = 0
            # In a DM the next step is the PDF's pitch-and-dig, not the
            # WhatsApp menu: relate the need to the affiliate campaign and
            # ask what they are after. Their answer is the interest signal
            # that moves them to WhatsApp (see `_dm_interest` below).
            r.send("DM_SERVICE_PITCH" if dm_channel(convo) else "INBOUND_SERVICE_MENU", convo, cfg)
            r.go(Node.QNA, Outcome.FOLLOWUP)
            r.at(Timer.WARM_D2, now + DELAYS[Timer.WARM_D2])
            return r
        # A real question or decision — fall through to normal handling.

    # A DM lead past qualification who shows interest without asking
    # anything: move them to WhatsApp. This sits ahead of the acceptance and
    # follow-up dispatch so a "boleh" in a DM becomes the hand-off, not a
    # slot list — the meeting is arranged on WhatsApp, where the deck can go
    # with it. Only with a number configured; without one the DM behaves as
    # it always did and `_offer_meeting` flags the missing setting.
    if (
        dm_channel(convo)
        and handoff_ready(cfg)
        and convo.node in {Node.QNA, Node.OFFER_MEETING, Node.WARM_D2, Node.WARM_D5,
                           Node.WA_HANDOFF}
        and intent in _DM_INTEREST
        # "halo" on its own is not interest; the greeting branch below
        # answers it and re-asks the pending question.
        and not _is_bare_greeting(text)
    ):
        convo.unknown_streak = 0
        _offer_whatsapp(r, convo, cfg, now)
        return r

    # "halo" / "iya" right after the opening carries no intent worth acting
    # on — "iya" here is politeness, not agreement to a meeting. Pitch the
    # affiliate service in one breath and ask what the brand needs.
    if convo.node in _EARLY_NODES and _is_bare_ack(text):
        convo.unknown_streak = 0
        r.send("REPLY_GREETING_NEEDS", convo, cfg)
        r.go(Node.QNA, Outcome.FOLLOWUP)
        r.at(Timer.WARM_D2, now + DELAYS[Timer.WARM_D2])
        return r

    # The same "halo", further along. Scheduling nodes handle it already (an
    # unclassified turn there re-asks for the slot or the email), but at QNA
    # and after a booking it was falling through to REPLY_FREEFORM — "boleh
    # dijelaskan sedikit lebih detail maksud Kakak?" in answer to "siang" —
    # and burning an unknown strike, so two greetings in a row handed the
    # conversation to a human. Greet back and put the pending question again.
    if _is_bare_greeting(text) and convo.node not in _SCHEDULING_NODES:
        convo.unknown_streak = 0
        r.send("REPLY_SAPAAN", convo, cfg)
        return r

    # §3.3 scheduling machine: once the brand has agreed, affirmative or
    # free-form replies ("jam 15 ya", "email saya …") drive the booking —
    # collect the email, then book. Questions still get answered by the
    # normal Q&A flow below, and rejections still reject. MENUNDA nodes are
    # in the set: an email after a nudge is still a booking.
    # ISI_FORM belongs here for the same reason UNKNOWN does: a brand who
    # sends their details while a meeting is being arranged is answering the
    # booking, not restarting the pitch. Without it, form data at a
    # scheduling node fell through to the service menu — re-introducing the
    # company to somebody who is mid-way through picking a time.
    if convo.node in _SCHEDULING_NODES and (
        outcome is Outcome.ACCEPTANCE
        or intent in {Intent.UNKNOWN, Intent.ISI_FORM}
    ):
        if convo.email:
            r.actions.append(BookMeeting())
        elif _ASKS_AVAILABILITY_RE.search(text.lower()):
            # They asked which times are open. Answering "boleh dibantu
            # alamat email-nya?" ignores the question — and asked twice in a
            # row it is the same sentence twice. The slot proposal answers it
            # and asks for the email in the same breath.
            r.actions.append(ProposeSlots(fallback=render("REPLY_SETUJU", convo, cfg)))
            r.at(Timer.MENUNDA_H1, now + DELAYS[Timer.MENUNDA_H1])
        else:
            r.send("ASK_EMAIL", convo, cfg)
            r.at(Timer.MENUNDA_H1, now + DELAYS[Timer.MENUNDA_H1])
        return r

    # Meeting-day coordination, whatever the classifier made of it: "Sdah
    # bisa join?", "Kak kita sudah mau masuk", "Telat 10menitan ya 🙏". These
    # arrive from contacts who have already booked, in the minutes around the
    # call, and they are the worst possible place for a clarification prompt
    # or a two-strike silence. Intent-agnostic on purpose — the words are
    # short and context-bound, so the node is a better signal than the text.
    if convo.node is Node.SCHEDULED and _MEETING_DAY_RE.search(text.lower()):
        convo.unknown_streak = 0
        if convo.meet_link:
            r.send(
                "RESEND_LINK", convo, cfg,
                link=convo.meet_link,
                tanggal=convo.meeting_at.strftime("%A, %d %B %Y") if convo.meeting_at else "-",
                waktu=_hhmm(convo.meeting_at),
            )
        r.actions.append(
            NotifyGroup(
                f"🔔 {convo.brand or convo.name_or('-')} "
                f"({convo.jid.split('@')[0]}) soal meeting: {text[:120]}"
            )
        )
        return r

    # A booked contact asking to move the meeting must never get silence:
    # acknowledge, and hand the calendar change to a human — the bot cannot
    # move or cancel an existing event. (SARINA really asked this.)
    if (
        convo.node is Node.SCHEDULED
        and outcome is Outcome.ACCEPTANCE
        and _RESCHEDULE_RE.search(text.lower())
    ):
        r.send("REPLY_RESCHEDULE", convo, cfg)
        r.actions.append(Escalate("reschedule requested", text))
        return r

    match outcome:
        case Outcome.REJECTION:
            _rejection(r, convo, intent, cfg, now)
        case Outcome.ACCEPTANCE:
            _acceptance(r, convo, intent, cfg, now)
        case Outcome.FOLLOWUP:
            _followup(r, convo, intent, text, cfg, now)

    return r


def _rejection(
    r: Result, convo: Conversation, intent: Intent, cfg: Settings, now: datetime
) -> None:
    """FLOWCHART.md §4 — reply politely, then one promo rescue before STOP."""
    if intent is Intent.OPT_OUT:
        # Never rescue an opt-out. Honour it immediately and permanently.
        r.send("REPLY_OPT_OUT", convo, cfg)
        r.go(Node.STOPPED, Outcome.REJECTION)
        return

    template = (
        "REPLY_TOLAK_TEGAS" if intent is Intent.TOLAK_TEGAS else "REPLY_TOLAK_HALUS"
    )
    r.send(template, convo, cfg)
    r.go(Node.COLD_FU4, Outcome.REJECTION)
    r.at(Timer.REJECT_PROMO, now + DELAYS[Timer.REJECT_PROMO])


def _acceptance(
    r: Result, convo: Conversation, intent: Intent, cfg: Settings, now: datetime
) -> None:
    """FLOWCHART.md §3 — anything affirmative goes to the scheduling machine.

    Propose-first (ROADMAP 2.2): the engine offers concrete free slots; the
    open "hari dan jam berapa?" ask is carried as the fallback for when the
    calendar is unreachable."""
    if convo.node is Node.SCHEDULED:
        return  # already booked; an extra "ok" needs no reply

    # A DM lead who agrees is moved to WhatsApp rather than booked here: the
    # meeting is arranged on WhatsApp, where the deck can be sent with the
    # invite. Only when a number exists; otherwise the DM books as before.
    if dm_channel(convo) and handoff_ready(cfg) and convo.node not in _SCHEDULING_NODES:
        _offer_whatsapp(r, convo, cfg, now)
        return

    r.actions.append(ProposeSlots(fallback=render("REPLY_SETUJU", convo, cfg)))
    r.go(Node.SCHEDULING, Outcome.ACCEPTANCE)
    # If they agree but then go quiet, fall back to the menunda ladder.
    r.at(Timer.MENUNDA_H1, now + DELAYS[Timer.MENUNDA_H1])


def _followup(
    r: Result,
    convo: Conversation,
    intent: Intent,
    text: str,
    cfg: Settings,
    now: datetime,
) -> None:
    """Everything that defers. This is where the decay rule lives."""

    match intent:
        case Intent.UNKNOWN:
            convo.unknown_streak += 1
            r.actions.append(Escalate("unclassified reply", text))
            if convo.unknown_streak >= cfg.max_unknown_streak:
                r.send("HANDOVER", convo, cfg)
                r.go(Node.HANDOVER, Outcome.FOLLOWUP)
                return
            # Answer anyway — the real agent replies to everything (see the
            # chat-example exports). Grounded generation handles the content;
            # the static fallback politely asks for clarification. The
            # escalation above still surfaces it to a human either way.
            r.send("REPLY_FREEFORM", convo, cfg)
            return

        case Intent.TANYA_SISTEM:
            r.send("REPLY_TANYA_SISTEM", convo, cfg)
            _offer_meeting(r, convo, cfg, now, after_reply=True)
            return

        case Intent.TANYA_HARGA:
            # Two-stage reveal, FLOWCHART.md §5.3.
            if convo.price_stage == 0:
                convo.price_stage = 1
                r.send("REPLY_TANYA_HARGA", convo, cfg)
                # In a DM a price question is the strongest interest signal
                # there is (the CRM PDF files it "High intent"). The anchor
                # goes out — it is private, and a bot that will not confirm
                # its own deck reads as evasive — and the discussion the
                # anchor's questions open moves to WhatsApp, where the deck
                # can follow.
                if dm_channel(convo) and handoff_ready(cfg):
                    _offer_whatsapp(r, convo, cfg, now)
                    return
            else:
                convo.price_stage = 2
                r.send("REPLY_PAKET_DETAIL", convo, cfg)
                _offer_meeting(r, convo, cfg, now, after_reply=True)
                return
            r.go(Node.QNA, Outcome.FOLLOWUP)
            r.at(Timer.WARM_D2, now + DELAYS[Timer.WARM_D2])
            return

        # Question intents from the chat-example exports: answer, then close
        # with the meeting gadget exactly like TANYA_SISTEM does.
        case (
            Intent.TANYA_PORTOFOLIO
            | Intent.TANYA_LOKASI
            | Intent.TANYA_KOMISI
            | Intent.TANYA_KOMISI_ONLY
            | Intent.TANYA_PEMBAYARAN
            | Intent.TANYA_AFFILIATE
            | Intent.TANYA_SAMPLE
            | Intent.TANYA_TIMELINE
            | Intent.TANYA_LIVE
            | Intent.TANYA_KECOCOKAN
            | Intent.TANYA_CUSTOM
            | Intent.TANYA_TARGET
            | Intent.TANYA_KPI
            | Intent.BRAND_KECIL
            | Intent.TANYA_PAKET_LAMA
            | Intent.TANYA_LEGALITAS
            | Intent.TANYA_REFUND
            | Intent.TANYA_HAK_KONTEN
            | Intent.TANYA_EKSKLUSIVITAS
            | Intent.TANYA_REKENING
            | Intent.TANYA_JANGKAUAN
            | Intent.TANYA_STOK
            # Round 3, 24 Sep 2026: a live-streaming price question and the
            # after-contract video question — answered, then the gadget.
            | Intent.TANYA_HARGA_LIVE
            | Intent.TANYA_VIDEO_SETELAH_KONTRAK
        ):
            r.send(f"REPLY_{intent.name}", convo, cfg)
            _offer_meeting(r, convo, cfg, now, after_reply=True)
            return

        # --- the inbound selling turns, mined 24 Sep 2026 -------------------
        # "Mau info affiliate" / "kak mau tanya service": explain in one
        # breath and ask about their product and platform. No meeting gadget
        # — the CRM PDF's row for this is "gali kebutuhan", and nothing has
        # been dug yet. Their answer arrives as BUTUH_AFFILIATE, ISI_FORM or
        # a plain UNKNOWN and the machine takes it from there.
        case Intent.MINTA_INFO:
            convo.unknown_streak = 0
            r.send("REPLY_MINTA_INFO", convo, cfg)
            r.go(Node.QNA, Outcome.FOLLOWUP)
            r.at(Timer.WARM_D2, now + DELAYS[Timer.WARM_D2])
            return

        # "Layanan apa aja?": the six-line menu, names only, and the category
        # + need question. Same reason for no gadget: offering a meeting
        # before they have picked a line is the "bare price list" mistake
        # with services instead of numbers.
        case Intent.TANYA_LAYANAN:
            convo.unknown_streak = 0
            r.send("REPLY_TANYA_LAYANAN", convo, cfg)
            r.go(Node.QNA, Outcome.FOLLOWUP)
            r.at(Timer.WARM_D2, now + DELAYS[Timer.WARM_D2])
            return

        # "Affiliate" / "saya butuh affiliate": the need is on the table, so
        # this is where the corpus pitches and invites in one message. The
        # template ends with the hari/jam question, so — like
        # TANYA_MEETING_DETAIL — no OFFER_MEETING on top of it; the node and
        # timer are the gadget's. (A DM with a number configured never gets
        # here: BUTUH_AFFILIATE is a hand-off signal there, see `_DM_INTEREST`.)
        case Intent.BUTUH_AFFILIATE:
            convo.unknown_streak = 0
            r.send("REPLY_BUTUH_AFFILIATE", convo, cfg)
            r.go(Node.OFFER_MEETING, Outcome.FOLLOWUP)
            r.at(Timer.WARM_D2, now + DELAYS[Timer.WARM_D2])
            return

        # "Lebih ke sales kak" / "dua-duanya": the answer to our own focus
        # question (the engine has already checked we asked it). Acknowledge
        # the need in the team's words, tie it to the fitting service, and
        # invite — the templates end on hari/jam, so no gadget on top. (In a
        # DM with a number configured this is a hand-off signal instead.)
        case Intent.FOKUS_CAMPAIGN:
            convo.unknown_streak = 0
            focus = intents.focus_of(text) or "keduanya"
            r.send(f"REPLY_FOKUS_{focus.upper()}", convo, cfg)
            r.go(Node.OFFER_MEETING, Outcome.FOLLOWUP)
            r.at(Timer.WARM_D2, now + DELAYS[Timer.WARM_D2])
            return

        # "ada rate card atau company profile?": the file goes out with the
        # reply (WhatsApp; a DM transport refuses it and escalates), and the
        # reply asks the need — no gadget, it already offers the meeting.
        case Intent.MINTA_PROFILE:
            convo.unknown_streak = 0
            r.send("REPLY_MINTA_PROFILE", convo, cfg)
            r.go(Node.QNA, Outcome.FOLLOWUP)
            r.at(Timer.WARM_D2, now + DELAYS[Timer.WARM_D2])
            return

        # An agency shopping for a vendor for its clients. Welcome, ask the
        # category and the volume, invite — the template ends on hari/jam.
        # A human is told: this is a different kind of lead (a reseller,
        # possibly several brands), and the meeting is worth preparing for.
        case Intent.AGENCY_VENDOR:
            convo.unknown_streak = 0
            r.send("REPLY_AGENCY_VENDOR", convo, cfg)
            r.actions.append(Escalate("lead dari agency — mencari vendor untuk kliennya", text))
            r.go(Node.OFFER_MEETING, Outcome.FOLLOWUP)
            r.at(Timer.WARM_D2, now + DELAYS[Timer.WARM_D2])
            return

        # "produk digital bisa di shopee?": the template promises "saya bantu
        # cek kesesuaiannya dengan tim kami", so a human has to actually
        # check — the answer is product knowledge the bank does not hold.
        # Answered AND escalated, never left to the unknown streak (whose
        # second strike is the handover, opening "Terima kasih atas
        # waktunya" — a goodbye to an open question; 24 Sep 2026).
        case Intent.TANYA_KATEGORI_PRODUK:
            convo.unknown_streak = 0
            r.send("REPLY_TANYA_KATEGORI_PRODUK", convo, cfg)
            r.actions.append(Escalate("cek kesesuaian produk dengan tim", text))
            _offer_meeting(r, convo, cfg, now, after_reply=True)
            return

        # "Pernah pakai agency, gak ada hasil": BD's own objection handling —
        # agree, name the cause, ask how it was run, promise the case study
        # at the meeting. The reply asks its own question, so no gadget.
        case Intent.PERNAH_AGENCY:
            convo.unknown_streak = 0
            r.send("REPLY_PERNAH_AGENCY", convo, cfg)
            r.go(Node.QNA, Outcome.FOLLOWUP)
            r.at(Timer.WARM_D2, now + DELAYS[Timer.WARM_D2])
            return

        # Meeting logistics. Answers who attends and closes with the slot ask
        # the template already carries — no `_offer_meeting` gadget on top,
        # which would ask for a meeting they are visibly already considering.
        case Intent.TANYA_MEETING_DETAIL:
            convo.unknown_streak = 0
            r.send("REPLY_TANYA_MEETING_DETAIL", convo, cfg)
            r.go(Node.QNA, Outcome.FOLLOWUP)
            r.at(Timer.WARM_D2, now + DELAYS[Timer.WARM_D2])
            return

        # Where we got their number. Answer without claiming a source, offer
        # removal, and hand straight to a human — no meeting gadget, and no
        # follow-up timer: someone questioning why we contacted them is the
        # last person who should be chased by an automated ladder.
        case Intent.TANYA_SUMBER_KONTAK:
            convo.unknown_streak = 0
            r.send("REPLY_TANYA_SUMBER_KONTAK", convo, cfg)
            r.actions.append(Escalate("asked where we got their contact", text))
            r.go(Node.QNA, Outcome.FOLLOWUP)
            return

        # Ads is a different product: answer it, ship the ads deck, and stop
        # there. No `_offer_meeting` gadget on top — REPLY_TANYA_ADS already
        # closes with the offer in BD's own words, and this intent catches
        # "boleh share untuk paket ads", a brand asking to be sent material.
        # Pushing the meeting again is what produced "ko langsung ngajak
        # meeting sih kak" in the 29 Jul pilot.
        case Intent.TANYA_ADS:
            convo.unknown_streak = 0
            r.send("REPLY_TANYA_ADS", convo, cfg)
            r.go(Node.QNA, Outcome.FOLLOWUP)
            r.at(Timer.WARM_D2, now + DELAYS[Timer.WARM_D2])
            return

        # The qualification form, filled in — anywhere outside the two
        # branches above. The corpus answer is the same every time: thank
        # them, introduce the services, ask for the meeting. That is
        # INBOUND_SERVICE_MENU, which was written from these very exchanges.
        case Intent.ISI_FORM:
            convo.unknown_streak = 0
            _capture_brand(convo, text)
            r.send("INBOUND_SERVICE_MENU", convo, cfg)
            r.go(Node.QNA, Outcome.FOLLOWUP)
            r.at(Timer.WARM_D2, now + DELAYS[Timer.WARM_D2])
            return

        # WhatsApp's pre-filled ad text, arriving when the conversation is
        # already under way — the brand tapped the ad a second time, or a
        # colleague did. There is no question in it to answer, so greet back
        # and put the needs question rather than re-sending the form they
        # have already been sent once.
        case Intent.LEAD_IKLAN:
            convo.unknown_streak = 0
            r.send("REPLY_GREETING_NEEDS", convo, cfg)
            r.go(Node.QNA, Outcome.FOLLOWUP)
            r.at(Timer.WARM_D2, now + DELAYS[Timer.WARM_D2])
            return

        # "Bentar saya cek ya" — they are coming back in a moment. Say so
        # and hold the position: no node change, no new ladder, and the
        # unknown streak resets, because this is a perfectly clear message
        # even though it asks for nothing.
        case Intent.TUNGGU:
            convo.unknown_streak = 0
            r.send("REPLY_TUNGGU", convo, cfg)
            return

        # They want to keep it in chat. Answer in chat, and leave the meeting
        # standing as an option rather than pushing it again — pushing is what
        # makes a brand stop replying.
        case Intent.MINTA_CHAT:
            convo.unknown_streak = 0
            r.send("REPLY_MINTA_CHAT", convo, cfg)
            r.go(Node.QNA, Outcome.FOLLOWUP)
            r.at(Timer.WARM_D2, now + DELAYS[Timer.WARM_D2])
            return

        # "link nya ka" — usually a booked contact who has lost the Meet link.
        # Resend it when we have one; otherwise this is someone asking for
        # material, so send the profile and keep the meeting offer alive.
        case Intent.MINTA_LINK:
            convo.unknown_streak = 0
            if convo.meet_link:
                r.send(
                    "RESEND_LINK", convo, cfg,
                    link=convo.meet_link,
                    tanggal=convo.meeting_at.strftime("%A, %d %B %Y") if convo.meeting_at else "-",
                    waktu=_hhmm(convo.meeting_at),
                )
                return
            r.send("REPLY_PELAJARI_DULU", convo, cfg)
            _offer_meeting(r, convo, cfg, now, after_reply=True)
            return

        # Discount asks get the nett-price/negotiate-commission answer, and a
        # human is looped in — only management can actually approve a number
        # (the real chats always say "saya diskusikan dengan manajemen").
        # They named a commission figure. Say it back, take it to management,
        # and get a human involved — only management can approve a number, and
        # a counter-offer left hanging is a deal going quiet.
        case Intent.NEGO_KOMISI:
            convo.unknown_streak = 0
            angka = intents.offered_percent(text)
            if not angka:
                # The rules require a figure to reach here, so this is
                # belt-and-braces: with nothing to quote, ask for it.
                r.send("REPLY_NEGO_HARGA", convo, cfg)
            else:
                r.send("REPLY_NEGO_KOMISI", convo, cfg, angka=angka)
            r.actions.append(
                Escalate(f"commission counter-offer{f' ({angka})' if angka else ''}", text)
            )
            r.go(Node.WARM_D2, Outcome.FOLLOWUP)
            r.at(Timer.WARM_D2, now + DELAYS[Timer.WARM_D2])
            return

        case Intent.NEGO_HARGA:
            r.send("REPLY_NEGO_HARGA", convo, cfg)
            r.actions.append(Escalate("price negotiation", text))
            r.go(Node.WARM_D2, Outcome.FOLLOWUP)
            r.at(Timer.WARM_D2, now + DELAYS[Timer.WARM_D2])
            return

        # A contract request is a buying signal the bot can't fulfil — the
        # draft comes from the legal team. Answer, escalate, keep following up.
        case Intent.MINTA_KONTRAK:
            r.send("REPLY_MINTA_KONTRAK", convo, cfg)
            r.actions.append(Escalate("contract draft requested", text))
            r.go(Node.WARM_D2, Outcome.FOLLOWUP)
            r.at(Timer.WARM_D2, now + DELAYS[Timer.WARM_D2])
            return

        # "Telepon aja" / their own Zoom link: steer to Google Meet per SOP.
        # The template already asks for day, time, and email, so this behaves
        # like an acceptance and enters the scheduling machine.
        case Intent.MINTA_TELEPON:
            r.send("REPLY_MINTA_TELEPON", convo, cfg)
            r.go(Node.SCHEDULING, Outcome.ACCEPTANCE)
            r.at(Timer.MENUNDA_H1, now + DELAYS[Timer.MENUNDA_H1])
            return

        case Intent.KIRIM_EMAIL:
            # An address given so we can send a proposal — NOT the address
            # that books a Meet. The scheduling branch above owns that case,
            # and it runs first, so reaching here means they want the deck by
            # email instead of a meeting. Deliberately no REPLY_MINTA_CHAT
            # afterwards: once they have named an inbox, offering to "bahas
            # lewat chat dulu" answers a question nobody asked.
            # And then stop. An inbox is where they want to be sold to, and
            # it is not this chat: the follow-up ladder that used to run from
            # here nudged Bali Botanica about a meeting they had already
            # replaced with an email address. A human sends the proposal.
            convo.unknown_streak = 0
            r.send("REPLY_EMAIL_PROPOSAL", convo, cfg)
            r.actions.append(Escalate("brand minta proposal via email", text))
            r.actions.append(CancelTimers())
            r.go(Node.HANDOVER, Outcome.FOLLOWUP)
            return

        case Intent.HUBUNGKAN_PIC:
            # A promised introduction is not an introduction. Ask for the
            # contact — that is what turns it into a lead somebody can work.
            convo.unknown_streak = 0
            r.send("REPLY_CONNECT_PIC", convo, cfg)
            r.actions.append(Escalate("brand akan menghubungkan ke PIC", text))
            r.go(Node.WARM_D2, Outcome.FOLLOWUP)
            r.at(Timer.WARM_D2, now + DELAYS[Timer.WARM_D2])
            return

        case Intent.PRODUK_BERUBAH:
            # Not a rejection: the brand is still there, just selling
            # something else. Asking what keeps the conversation open rather
            # than closing it on a product that no longer exists.
            convo.unknown_streak = 0
            r.send("REPLY_PRODUK_BERUBAH", convo, cfg)
            r.go(Node.QNA, Outcome.FOLLOWUP)
            r.at(Timer.WARM_D2, now + DELAYS[Timer.WARM_D2])
            return

        case Intent.TERUSKAN_TIM:
            r.send("REPLY_TERUSKAN_TIM", convo, cfg)
            r.go(Node.WARM_D2, Outcome.FOLLOWUP)
            r.at(Timer.WARM_D2, now + DELAYS[Timer.WARM_D2])
            return

        case Intent.PELAJARI_DULU:
            r.send("REPLY_PELAJARI_DULU", convo, cfg)
            r.go(Node.WARM_D2, Outcome.FOLLOWUP)
            r.at(Timer.WARM_D2, now + DELAYS[Timer.WARM_D2])
            return

        case Intent.TERIMA_KASIH:
            r.send("REPLY_TERIMA_KASIH", convo, cfg)
            r.go(Node.COLD_FU2, Outcome.FOLLOWUP)
            # The board sends the needs-menu at H+1 on this branch.
            r.at(Timer.COLD_FU2, now + DELAYS[Timer.COLD_FU2])
            return

        case Intent.NANTI_AJA:
            _defer_gadget(r, convo, cfg, now)
            return


def _offer_meeting(
    r: Result,
    convo: Conversation,
    cfg: Settings,
    now: datetime,
    *,
    after_reply: bool = False,
) -> None:
    """The closing gadget, FLOWCHART.md §3.1 — one function, used everywhere.

    When it directly follows a generated reply, the reply itself already ends
    with the meeting ask (responder._SITUATIONS demands it) — sending
    OFFER_MEETING on top would ask the same thing twice in a row. The state
    transition and timer still apply either way.

    In a DM the closing move is the WhatsApp hand-off instead (24 Sep 2026):
    an answered question is interest, and interest moves to WhatsApp. With
    no number configured the DM offers the meeting here as before, and says
    so to a human — once per closing, which is rare enough to be a nudge
    rather than noise, and loud enough that the setting gets filled in.
    """
    if dm_channel(convo):
        if handoff_ready(cfg):
            _offer_whatsapp(r, convo, cfg, now)
            return
        r.actions.append(
            Escalate(
                "BD_WHATSAPP_NUMBER belum diisi — lead DM ini tidak bisa "
                "diarahkan ke WhatsApp, meeting ditawarkan di DM"
            )
        )
    if not (after_reply and cfg.use_llm_replies and cfg.anthropic_api_key):
        r.send("OFFER_MEETING", convo, cfg)
    r.go(Node.OFFER_MEETING, Outcome.FOLLOWUP)
    r.at(Timer.WARM_D2, now + DELAYS[Timer.WARM_D2])


def _offer_whatsapp(
    r: Result, convo: Conversation, cfg: Settings, now: datetime
) -> None:
    """The DM's closing gadget: move the lead to WhatsApp (24 Sep 2026).

    First time: the number, why, and what happens there; the conversation
    parks at WA_HANDOFF and a human is told to watch for the lead on
    WhatsApp — the two conversations cannot be linked automatically (an
    IGSID is not a phone number), so a person has to recognise them.

    Already handed off: the pointer is repeated ONCE, shorter, and after
    that only the escalation goes out. Pushing the same line every turn is
    what makes a lead stop replying; questions that keep arriving in the DM
    are still answered by the normal machine, just without this on top.

    No follow-up timer, deliberately. Meta's messaging window closes 24
    hours after the lead's last message, so a WARM_D2 nudge would be refused
    by Graph (or, worse, sent under a tag it does not qualify for). The
    escalation is the follow-up.
    """
    if convo.node is Node.WA_HANDOFF:
        if convo.gadget_loops < 1:
            convo.gadget_loops += 1
            r.send("DM_TO_WA_AGAIN", convo, cfg)
        r.actions.append(
            Escalate("lead DM masih membalas di DM setelah diarahkan ke WhatsApp")
        )
        return
    convo.gadget_loops = 0
    r.send("DM_TO_WA", convo, cfg)
    r.go(Node.WA_HANDOFF, Outcome.FOLLOWUP)
    r.actions.append(
        Escalate(
            f"lead DM ({dm_channel(convo)}) diarahkan ke WhatsApp "
            f"{cfg.bd_whatsapp_number} — pantau kedatangannya di WA"
        )
    )


def _defer_gadget(
    r: Result, convo: Conversation, cfg: Settings, now: datetime
) -> None:
    """'Nanti aja' — the loop the whiteboard never exits (§6.1).

    Each pass increments the counter; past the cap the conversation decays into
    rejection instead of re-offering forever.
    """
    convo.gadget_loops += 1
    if convo.gadget_loops >= cfg.max_gadget_loops:
        r.send("REPLY_TOLAK_HALUS", convo, cfg)
        r.go(Node.STOPPED, Outcome.REJECTION)
        return

    r.send("REPLY_PELAJARI_DULU", convo, cfg)
    r.go(Node.WARM_D2, Outcome.FOLLOWUP)
    r.at(Timer.WARM_D2, now + DELAYS[Timer.WARM_D2])


# ---------------------------------------------------------------------------
# Entry point: timer fired
# ---------------------------------------------------------------------------


def on_timer(
    convo: Conversation, timer: Timer, cfg: Settings, now: datetime
) -> Result:
    r = Result()

    if convo.node in {Node.STOPPED, Node.HANDOVER, Node.MEETING_DONE}:
        return r  # terminal; ignore stragglers

    match timer:
        # --- cold ladder, FLOWCHART.md §2.1/§2.2 ---------------------------
        case Timer.COLD_FU1:
            r.send("COLD_FU1", convo, cfg)
            r.go(Node.COLD_FU1, Outcome.FOLLOWUP)
            r.at(Timer.COLD_FU2, now + DELAYS[Timer.COLD_FU2])
        case Timer.COLD_FU2:
            r.send("COLD_FU2", convo, cfg)
            r.go(Node.COLD_FU2, Outcome.FOLLOWUP)
            r.at(Timer.COLD_FU3, now + DELAYS[Timer.COLD_FU3])
        case Timer.COLD_FU3:
            r.send("COLD_FU3", convo, cfg)
            r.go(Node.COLD_FU3, Outcome.FOLLOWUP)
            r.at(Timer.COLD_FU4, now + DELAYS[Timer.COLD_FU4])
        case Timer.COLD_FU4:
            r.send("COLD_FU4", convo, cfg)
            r.go(Node.COLD_FU4, Outcome.FOLLOWUP)
            r.at(Timer.DECAY_STOP, now + DELAYS[Timer.DECAY_STOP])

        # --- warm stall, §2.3 ----------------------------------------------
        case Timer.WARM_D2:
            r.send("WARM_D2", convo, cfg)
            r.go(Node.WARM_D2, Outcome.FOLLOWUP)
            r.at(Timer.WARM_D5, now + DELAYS[Timer.WARM_D5])
        case Timer.WARM_D5:
            r.send("WARM_D5", convo, cfg)
            r.go(Node.WARM_D5, Outcome.FOLLOWUP)
            r.at(Timer.DECAY_STOP, now + DELAYS[Timer.DECAY_STOP])

        # --- menunda meeting, §2.4 ------------------------------------------
        case Timer.MENUNDA_H1:
            r.send("MENUNDA_H1", convo, cfg)
            r.go(Node.MENUNDA_H1, Outcome.FOLLOWUP)
            r.at(Timer.MENUNDA_H3, now + DELAYS[Timer.MENUNDA_H3])
        case Timer.MENUNDA_H3:
            r.send("MENUNDA_H3", convo, cfg)
            r.go(Node.MENUNDA_H3, Outcome.FOLLOWUP)
            r.at(Timer.DECAY_STOP, now + DELAYS[Timer.DECAY_STOP])

        # --- meeting day, §3.3/§2.4 -----------------------------------------
        case Timer.REMINDER:
            r.send(
                "REMINDER",
                convo,
                cfg,
                waktu=_hhmm(convo.meeting_at),
                link=convo.meet_link,
            )
        case Timer.MEETING_END:
            # The bot cannot observe whether anyone joined the Meet call, so a
            # human confirms. See README, Known limitations.
            r.actions.append(Escalate("confirm whether client joined the meeting"))

        case Timer.NOSHOW_1:
            r.send("NOSHOW_FU1", convo, cfg)
            r.go(Node.NOSHOW_FU1, Outcome.FOLLOWUP)
            r.at(Timer.NOSHOW_2, now + DELAYS[Timer.NOSHOW_2])
        case Timer.NOSHOW_2:
            r.send("NOSHOW_FU2", convo, cfg)
            r.go(Node.NOSHOW_FU2, Outcome.FOLLOWUP)
            r.at(Timer.DECAY_STOP, now + DELAYS[Timer.DECAY_STOP])

        # --- rejection rescue, §4 -------------------------------------------
        case Timer.REJECT_PROMO:
            r.send("COLD_FU4", convo, cfg)
            r.at(Timer.DECAY_STOP, now + DELAYS[Timer.DECAY_STOP])

        # --- the decay rule the board is missing, §6.1 -----------------------
        case Timer.DECAY_STOP:
            r.go(Node.STOPPED, Outcome.REJECTION)

    return r


def _hhmm(dt: datetime | None) -> str:
    return dt.strftime("%H.%M") if dt else "-"


# ---------------------------------------------------------------------------
# Post-scheduling hooks
# ---------------------------------------------------------------------------


def on_meeting_booked(
    convo: Conversation, cfg: Settings, now: datetime
) -> Result:
    """Called once Calendar + Meet succeeded. FLOWCHART.md §3.3 fan-out."""
    r = Result()
    assert convo.meeting_at is not None

    r.send(
        "SCHEDULE_CONFIRM",
        convo,
        cfg,
        tanggal=convo.meeting_at.strftime("%A, %d %B %Y"),
        waktu=_hhmm(convo.meeting_at),
        link=convo.meet_link,
        email=convo.email or "email Kakak",
    )
    r.actions.append(
        NotifyGroup(
            f"📅 Meeting baru\n"
            f"Brand: {convo.brand or '-'}\n"
            f"Kontak: {convo.name_or('-')} ({convo.jid.split('@')[0]})\n"
            f"Email: {convo.email or '-'}\n"
            f"Waktu: {convo.meeting_at:%d %b %Y, %H.%M} WIB\n"
            f"Link: {convo.meet_link}"
        )
    )
    r.go(Node.SCHEDULED, Outcome.ACCEPTANCE)

    # Remind at each configured lead — default 2 hours and 1 hour before.
    for lead in cfg.reminder_leads_minutes:
        reminder_at = convo.meeting_at - timedelta(minutes=lead)
        if reminder_at > now:
            r.at(Timer.REMINDER, reminder_at)
    r.at(
        Timer.MEETING_END,
        convo.meeting_at + timedelta(minutes=cfg.meeting_duration_minutes),
    )
    return r


def on_meeting_outcome(
    convo: Conversation, joined: bool, cfg: Settings, now: datetime
) -> Result:
    """Operator reports whether the client showed up."""
    r = Result()
    if joined:
        r.send("MEETING_DONE", convo, cfg)
        # The template promises "tim kami akan segera menghubungi" — a human
        # keeps that promise. Post-meeting is human territory (the real chats
        # hand over to a director and a coordination group here).
        r.actions.append(Escalate("meeting done — send recap and take over"))
        r.go(Node.MEETING_DONE, Outcome.ACCEPTANCE)
    else:
        r.go(Node.NOSHOW_FU1, Outcome.FOLLOWUP)
        r.at(Timer.NOSHOW_1, now + DELAYS[Timer.NOSHOW_1])
    return r
