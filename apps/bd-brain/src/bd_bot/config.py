"""Configuration, loaded from environment / .env."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import datetime, time
from pathlib import Path
from zoneinfo import ZoneInfo


def _env_bool(key: str, default: bool) -> bool:
    raw = os.getenv(key)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(key: str, default: int) -> int:
    raw = os.getenv(key)
    return int(raw) if raw and raw.strip() else default


def _env_time(key: str, default: time) -> time:
    """"HH:MM" (or "HH.MM", the way the hour is written in Indonesian)."""
    raw = (os.getenv(key) or "").strip().replace(".", ":")
    if not raw:
        return default
    try:
        hh, _, mm = raw.partition(":")
        return time(int(hh), int(mm or 0))
    except ValueError:
        # A typo here would silently move the campaign's hours, so say so and
        # keep the default rather than crashing a running bot.
        print(f"warning: {key}={raw!r} is not HH:MM — using {default:%H:%M}")
        return default


def _env_emails(key: str) -> tuple[str, ...]:
    """Comma-separated addresses. Anything without an "@" is dropped.

    A tuple, not a set: attendee order is what Google shows on the invite, and
    an operator who lists the BD lead first means it.
    """
    out: list[str] = []
    for part in (os.getenv(key) or "").split(","):
        part = part.strip()
        if not part:
            continue
        if "@" not in part or part.startswith("@") or part.endswith("@"):
            print(f"warning: {key}: {part!r} is not an email address — ignored")
            continue
        if part not in out:
            out.append(part)
    return tuple(out)


#: Monday is 0, matching datetime.weekday().
_DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def _env_days(key: str, default: frozenset[int]) -> frozenset[int]:
    """Which weekdays proactive messages may go out.

    Accepts "mon-sat", "mon,wed,fri", "0-5", or a mix. Ranges are inclusive.
    A boolean was not enough: "Monday to Saturday" is the schedule the BD team
    actually works, and `SEND_ON_WEEKENDS` could only say both weekend days or
    neither.
    """
    raw = (os.getenv(key) or "").strip().lower()
    if not raw:
        return default

    def one(tok: str) -> int | None:
        tok = tok.strip()[:3]
        if tok in _DAY_NAMES:
            return _DAY_NAMES.index(tok)
        if tok.isdigit() and 0 <= int(tok) <= 6:
            return int(tok)
        return None

    days: set[int] = set()
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, _, b = part.partition("-")
            lo, hi = one(a), one(b)
            if lo is None or hi is None:
                print(f"warning: {key}: cannot read range {part!r} — ignored")
                continue
            # Wrap around, so "sat-mon" means Sat, Sun, Mon rather than nothing.
            days.update((lo + i) % 7 for i in range((hi - lo) % 7 + 1))
        else:
            d = one(part)
            if d is None:
                print(f"warning: {key}: cannot read day {part!r} — ignored")
                continue
            days.add(d)
    if not days:
        print(f"warning: {key}={raw!r} named no valid days — using the default")
        return default
    return frozenset(days)


def _env_jids(key: str) -> frozenset[str]:
    """Comma-separated phone numbers -> JIDs. Unparseable entries are dropped."""
    from . import contacts

    out = set()
    for part in os.getenv(key, "").split(","):
        part = part.strip()
        if not part:
            continue
        out.add(part if "@" in part else contacts.to_jid(part))
    return frozenset(j for j in out if j)


@dataclass(slots=True)
class Settings:
    # --- identity ----------------------------------------------------------
    sender_name: str = field(default_factory=lambda: os.getenv("SENDER_NAME", "Grace"))
    company_name: str = field(
        default_factory=lambda: os.getenv("COMPANY_NAME", "MCNAsia.biz")
    )

    # --- safety ------------------------------------------------------------
    dry_run: bool = field(default_factory=lambda: _env_bool("DRY_RUN", True))
    """When True nothing is sent — messages are logged only. Default ON.

    This is deliberate: the bot must never blast real contacts on first run.
    """

    require_approval: bool = field(
        default_factory=lambda: _env_bool("REQUIRE_APPROVAL", True)
    )
    """When True, outbound messages wait for operator confirmation.

    Scoped by `auto_reply`: replying to someone who just messaged you is
    expected behaviour and low-risk, while unsolicited blasting is what gets
    numbers banned. The two are gated separately.
    """

    auto_reply: bool = field(default_factory=lambda: _env_bool("AUTO_REPLY", True))
    """When True the bot answers inbound messages without asking first.

    Blasts and proactive follow-ups still respect `require_approval`.
    """

    restart_jids: frozenset[str] = field(
        default_factory=lambda: _env_jids("RESTART_JIDS")
    )
    """Numbers allowed to reset their own conversation by sending `/restart`.

    Pilot testers only, and empty by default. The command wipes the
    conversation and re-sends the opening — deliberately re-blasting a number
    the bot has already blasted, which PILOT.md §5 calls the top ban trigger.
    An explicit list keeps that reachable for the handful of people hunting
    flaws and for nobody else; a real brand typing `/restart` is handled as an
    ordinary message.
    """

    demo_mode: bool = field(default_factory=lambda: _env_bool("DEMO_MODE", False))
    """Collapse every wait in the flow so a tester can walk a whole path in
    one sitting (PILOT.md §3.2).

    A timer scheduled for "H+1" fires `demo_gap_seconds` from now instead, and
    the message it sends is preceded by a marker naming the wait it stands in
    for — "⏩ *1 hari kemudian*". Follow-ups also ignore the business-hours
    window, since a test session rarely lines up with it. Everything else
    (templates, intents, booking, caps, approval) behaves exactly as in
    production: this changes *when* messages go out, never *what* goes out.

    Testing only. Left on in production it would fire the entire cold ladder
    at one contact inside a couple of minutes.
    """

    demo_gap_seconds: int = field(
        default_factory=lambda: _env_int("DEMO_GAP_SECONDS", 20)
    )
    """What a compressed wait becomes in demo mode. Timers queue back-to-back
    at this spacing, so a ladder of three follow-ups plays out in about a
    minute and stays in the order the flowchart puts it in."""

    demo_stale_seconds: int = field(
        default_factory=lambda: _env_int("DEMO_STALE_SECONDS", 300)
    )
    """How old an inbound message may be before demo mode ignores it.

    WhatsApp delivers everything that arrived while the device was offline the
    moment it reconnects, and the bot cannot tell that flood from live replies
    — it answered a days-old personal conversation during the pilot as though
    it had just been sent. A test session must only react to what testers type
    during the session; anything older belongs to whoever owns the number.

    Demo mode only. In production a reply that landed during a restart is
    still worth answering, and the operator sees it in `status` either way.
    """

    stale_inbound_hours: int = field(
        default_factory=lambda: _env_int("STALE_INBOUND_HOURS", 12)
    )
    """How old an inbound message may be before a human answers it instead.

    WhatsApp delivers everything that arrived while the device was offline the
    moment it reconnects, and nothing marks it as backlog. A reply that landed
    during a restart is still worth answering — the brand is waiting — but a
    message from days ago is not: the flow would act on it as though it had
    just been sent, so a week-old "nanti aja" would arm a follow-up ladder in
    the present tense. Past this age the message is recorded and escalated,
    never auto-answered. Demo mode ignores backlog outright instead; see
    `demo_stale_seconds`.
    """

    demo_idle_seconds: int = field(
        default_factory=lambda: _env_int("DEMO_IDLE_SECONDS", 120)
    )
    """How quiet a demo contact must be before a compressed timer may fire.

    The delays this mode collapses all mean "they went quiet on us" — a day of
    silence, then a nudge. Collapsed to `demo_gap_seconds` that meaning is
    lost: a tester still typing their answer gets chased mid-sentence, which
    reads as a bug in the bot rather than the compression it is. A timer whose
    contact has spoken more recently than this is pushed back instead of
    fired, so the nudge still means what it means in production. Independent
    of `demo_gap_seconds` on purpose — chained events (a booking's reminders)
    should stay quick while nudges wait for a real silence."""

    max_gadget_loops: int = field(
        default_factory=lambda: _env_int("MAX_GADGET_LOOPS", 2)
    )
    """FLOWCHART.md §6.1 — the board's closing gadget never decays into
    rejection, so it loops forever. This is the missing decay rule."""

    max_unknown_streak: int = field(
        default_factory=lambda: _env_int("MAX_UNKNOWN_STREAK", 2)
    )
    """FLOWCHART.md §6.2 — after N unclassifiable replies, hand to a human."""

    # --- sending window, FLOWCHART.md §6.6 ---------------------------------
    tz: ZoneInfo = field(
        default_factory=lambda: ZoneInfo(os.getenv("TZ_NAME", "Asia/Jakarta"))
    )
    send_window_start: time = field(
        default_factory=lambda: _env_time("SEND_WINDOW_START", time(9, 0))
    )
    send_window_end: time = field(
        default_factory=lambda: _env_time("SEND_WINDOW_END", time(19, 0))
    )
    """When proactive messages may go out — blasts and follow-up rungs.

    Replies to an inbound message are NOT gated by this: someone who writes at
    20.00 still gets answered. The window only decides when the bot may speak
    first, which is the ban-prone half."""

    send_days: frozenset[int] = field(
        default_factory=lambda: _env_days(
            "SEND_DAYS",
            # Falls back to the older boolean so an existing .env keeps working.
            frozenset(range(7)) if _env_bool("SEND_ON_WEEKENDS", False)
            else frozenset(range(5)),
        )
    )
    """Weekdays proactive messages may go out. Monday is 0."""
    max_blasts_per_day: int = field(
        default_factory=lambda: _env_int("MAX_BLASTS_PER_DAY", 30)
    )
    """Rate limit. Aggressive blasting is the fastest way to get a number
    banned; the whiteboard has no limit at all."""

    min_seconds_between_sends: int = field(
        default_factory=lambda: _env_int("MIN_SECONDS_BETWEEN_SENDS", 45)
    )

    blocked_brands: tuple[str, ...] = field(default_factory=lambda: tuple(
        b for b in (
            (os.getenv("BLOCKED_BRANDS") or
             "garudafood,orang tua,my skoonheid,monde,honnete,marlov,"
             "kojiesan,mayasi,junny,tepung super,sakara,manohara")
        ).lower().split(",") if b.strip()
    ))
    """Brands the BD team has asked never to contact.

    Matched as a substring against a target's name AND its notes, because the
    brand that must not be touched is often not the row's own name: GarudaFood
    reaches the list as "Gery / Chocolatos", with the group only mentioned in
    the shared-number note. Matching the name alone would have sent to it.

    Checked at send time, not only when the list is loaded, so a row added
    later — by paste, by import, or by a referral the bot picked up — is
    caught too."""

    # --- loop breaker ------------------------------------------------------
    # Brand numbers run their own WhatsApp autoresponders. The bot reads the
    # canned reply as a real answer, answers it, and triggers the same canned
    # reply again. On 12 Aug 2026 that sent 8 messages to one brand in 12
    # minutes and cost the account: WhatsApp removed the device 14 seconds
    # after the last one. See Engine._looping_with_a_machine.

    loop_guard_max_replies: int = field(
        default_factory=lambda: _env_int("LOOP_GUARD_MAX_REPLIES", 6)
    )
    loop_guard_window_minutes: int = field(
        default_factory=lambda: _env_int("LOOP_GUARD_WINDOW_MINUTES", 15)
    )
    """Circuit breaker: at most this many messages to one contact in this many
    minutes, after which the bot stops answering them and escalates.

    Deliberately generous. It is the backstop for autoresponders that vary
    their text — a ticket number or a timestamp defeats matching, but nothing
    defeats counting. The verbatim checks catch the common case long before
    this does; a brand engaged enough to earn six replies inside a quarter of
    an hour is worth a human anyway."""

    outreach_interval_seconds: int = field(
        default_factory=lambda: _env_int("OUTREACH_INTERVAL_SECONDS", 70)
    )
    """Gap between cold openings. This IS the campaign's send rate — the
    dashboard hands out one pending brand per call, so there is no batch to
    pace and no second place to configure it.

    Not a round minute on purpose: a message landing exactly every 60.0s is a
    machine signature, and cold openings to strangers are the most ban-prone
    thing the bot does."""

    # --- meeting slots, FLOWCHART.md §3.3 ----------------------------------
    meeting_hour_start: int = field(
        default_factory=lambda: _env_int("MEETING_HOUR_START", 9)
    )
    meeting_hour_end: int = field(
        default_factory=lambda: _env_int("MEETING_HOUR_END", 19)
    )
    """Meetings can start at any whole hour from `meeting_hour_start` up to
    (but not including) `meeting_hour_end` — default 09:00–19:00 WIB. Each
    slot is an hour, so one brand per hour; availability is checked against
    Google Calendar before offering."""

    meeting_duration_minutes: int = 60
    """One brand per one-hour slot: the calendar event blocks the full hour."""

    meeting_weekdays: frozenset[int] = field(
        default_factory=lambda: frozenset(
            int(d)
            for d in os.getenv("MEETING_WEEKDAYS", "0,1,2,3,4,5").split(",")
            if d.strip()
        )
    )
    """Days meetings can be held, Python weekday numbers (0=Senin … 6=Minggu).
    Default Senin–Sabtu. Separate from the blast sending window — offering a
    Saturday meeting is fine even when cold blasts stay weekday-only."""

    reminder_leads_minutes: tuple[int, ...] = field(
        default_factory=lambda: tuple(
            int(x)
            for x in os.getenv("REMINDER_LEAD_MINUTES", "120,60").split(",")
            if x.strip()
        )
    )
    """Reminders before the meeting, in minutes — default 2 hours and 1 hour."""

    # --- paths -------------------------------------------------------------
    db_path: Path = field(
        default_factory=lambda: Path(os.getenv("DB_PATH", "data/bot.sqlite3"))
    )
    company_profile_pdf: Path = field(
        default_factory=lambda: Path(
            os.getenv("COMPANY_PROFILE_PDF", "assets/company-profile.pdf")
        )
    )
    ads_deck_pdf: Path = field(
        default_factory=lambda: Path(
            os.getenv(
                "ADS_DECK_PDF",
                "opening/MCNAsia Service Deck - Affiliate, Ads, Full Service & Konten 2026.pdf",
            )
        )
    )
    """The ads-service deck, shipped with the answer to an ads question
    (REPLY_TANYA_ADS). Missing file = the answer still goes out as text.

    Repointed 18 Aug 2026 from assets/service-ads-gmv-max.pdf (the GMV-Max
    maintenance one-pager) to the full deck, whose page 2 carries the ads
    pricing the bot may now quote, and again on 18 Sep 2026 to the deck that
    replaced it. Note what a stale value here does: the file simply is not
    there, `_send_ads_deck` writes one log line and sends the text alone. No
    error, no escalation, and the ads answer looks fine in the transcript —
    which is how this spent the swap pointing at an archived filename.
    test_config.py now fails if the default names a file that does not exist. That makes it the SAME file the opening
    sends, which is safe: Engine._attach already drops a file the contact has
    received before, so a blasted brand asking about ads gets the text only."""

    opening_dir: Path = field(
        default_factory=lambda: Path(os.getenv("OPENING_DIR", "opening"))
    )
    """Everything in this folder is sent right after the opening blast text,
    images first. Falls back silently to nothing if the folder is missing.

    Holds the service deck alone since 19 Aug 2026 — the greeting image was
    retired to assets/archive/. Adding a file here is all it takes to put it
    in front of every brand, which is why deploy.sh mirrors this directory
    rather than merging into it: a file deleted locally must not survive on
    the server."""

    chat_examples_dir: Path = field(
        default_factory=lambda: Path(os.getenv("CHAT_EXAMPLES_DIR", "chat-example"))
    )
    """WhatsApp chat-export zips of real conversations. Parsed by
    `chat_examples.py` into few-shot grounding for generated replies."""
    case_studies_dir: Path = field(
        default_factory=lambda: Path(os.getenv("CASE_STUDIES_DIR", "assets/case-studies"))
    )
    """Per-category case-study folders (ROADMAP 2.4): files under
    `<dir>/<category>/` ship with the portfolio reply and the social-proof
    follow-up for contacts of that category. Missing dir = nothing extra."""
    inbound_examples_dir: Path = field(
        default_factory=lambda: Path(
            os.getenv("INBOUND_EXAMPLES_DIR", "inbound/sosmed-ke-wa")
        )
    )
    """Conversations where the BRAND wrote first (see inbound/README.md).

    Grounds generated replies alongside `chat_examples_dir`, and it is a
    separate setting because the two corpora are separate things: one teaches
    how we open, the other how we answer somebody who arrived from an ad,
    a comment or a link in a bio. A missing directory is not an error — the
    corpus is real customer data and is not in the repo."""

    session_dir: Path = field(
        default_factory=lambda: Path(os.getenv("SESSION_DIR", "data/wa-session"))
    )

    # --- meta: Instagram DM, Facebook DM, and comments on both -------------
    # None of this is read unless `run --meta` is used. The bot answers
    # WhatsApp with or without it.
    meta_app_secret: str = field(default_factory=lambda: os.getenv("META_APP_SECRET", ""))
    """The app secret, used to verify every webhook's signature.

    Empty means every delivery is refused, on purpose. The webhook endpoint
    is public by necessity — Meta has to reach it — so an unverified endpoint
    lets anyone who finds the URL make the bot answer as us, to an account
    id of their choosing."""

    meta_verify_token: str = field(default_factory=lambda: os.getenv("META_VERIFY_TOKEN", ""))
    """Our half of the subscription handshake. Any string, kept secret;
    Meta echoes it back when the webhook is first registered."""

    meta_page_token: str = field(default_factory=lambda: os.getenv("META_PAGE_TOKEN", ""))
    """Page access token. One token serves both platforms: an Instagram
    professional account is reached through the Page it is connected to."""

    meta_page_ids: tuple[str, ...] = field(
        default_factory=lambda: tuple(
            x.strip() for x in os.getenv("META_PAGE_IDS", "").split(",") if x.strip()
        )
    )
    """Every id we post as — the Page id and the IG business account id.

    Used to recognise our own voice coming back. DMs carry an echo flag, but
    a comment we posted carries nothing at all, and answering it is a public
    loop between the bot and itself."""

    meta_webhook_host: str = field(default_factory=lambda: os.getenv("META_WEBHOOK_HOST", "127.0.0.1"))
    meta_webhook_port: int = field(default_factory=lambda: _env_int("META_WEBHOOK_PORT", 4320))
    """Where the webhook listens. Bound to loopback by default: Meta requires
    public HTTPS, which means a reverse proxy in front, and the proxy is the
    right place for the certificate. Binding this to 0.0.0.0 publishes an
    HTTP endpoint that accepts brand conversations."""

    meta_graph_version: str = field(default_factory=lambda: os.getenv("META_GRAPH_VERSION", "v21.0"))

    bd_whatsapp_number: str = field(
        default_factory=lambda: os.getenv("BD_WHATSAPP_NUMBER", "")
    )
    """The WhatsApp number an Instagram/Facebook DM lead is sent to.

    The BD funnel is comment → DM → WhatsApp → meeting: a DM lead who shows
    interest is asked to continue on WhatsApp, where the deck can actually be
    attached and the meeting is arranged. This is the number the DM gives
    them, written exactly as it should appear in the message ("+62 8xx-xxxx-
    xxxx" or "0812…" — the template does not reformat it).

    EMPTY BY DEFAULT, ON PURPOSE. The 18 Sep 2026 deck prints two WhatsApp
    numbers and nobody has said which one takes inbound DM leads, so the bot
    does not guess: with this unset the DM flow keeps the lead in the DM,
    offers the meeting there as before, and escalates once so a human sees
    that a lead could not be moved. Set it and the hand-off switches on —
    no code change, nothing else to restart."""

    meta_comment_public_reply: bool = field(
        default_factory=lambda: _env_bool("META_COMMENT_PUBLIC_REPLY", True)
    )
    """Whether to post the short public reply to a comment at all.

    The BD team's rule is one short line in public and the rest in DM. Turn
    this off and the bot still sends the DM — useful while nobody has
    reviewed what the public line says, because a public reply is the one
    thing here that cannot be taken back quietly."""

    # --- claw: when the hand is a phone, not a socket ----------------------
    # See CLAW.md. None of this is read unless `run --claw` is used; the
    # neonize path is untouched by all of it.

    claw_token: str = field(default_factory=lambda: os.getenv("CLAW_TOKEN", ""))
    """Shared secret every phone must present (`x-claw-token`).

    Empty means the brain refuses to start. The endpoints hand out brands to
    contact and accept "this was typed" as fact; an open port with those
    powers is worse than no claw at all."""

    claw_port: int = field(default_factory=lambda: _env_int("CLAW_PORT", 4310))
    claw_host: str = field(default_factory=lambda: os.getenv("CLAW_HOST", "127.0.0.1"))
    """Loopback by default. Phones reach it through an SSH tunnel — the same
    shape claw uses against the affiliate bot, and the reason the token is not
    the only thing between a stranger and the queue."""

    claw_row_id: str = field(default_factory=lambda: os.getenv("CLAW_ROW_ID", "bd"))
    """What this bot calls itself when a phone registers (claw's `brandId`).

    One bd_bot process serves one CS row, so this is that row's id — it ends
    up in the phone's own logs and in `claw status`, which is the only place
    an operator can tell two identical-looking fleets apart."""

    claw_outbox_max_per_number: int = field(
        default_factory=lambda: _env_int("CLAW_OUTBOX_MAX", 3)
    )
    """How deep the queue for one phone may get.

    The bot's daily cap is tens of brands; a phone types about one chat every
    90 seconds and manages a few dozen a day. Without a ceiling the flow
    queues an afternoon's work in a minute and the brands at the back are held
    hostage in a queue instead of being offered to a phone that is free."""

    claw_reply_max_per_hour: int = field(
        default_factory=lambda: _env_int("CLAW_REPLY_MAX_PER_HOUR", 12)
    )
    """Answers to one number per hour. A phone sweeping its own screen can
    re-read the same chat; this is what stops a misread turning into a
    conversation with itself."""

    claw_media_dir: Path = field(
        default_factory=lambda: Path(os.getenv("CLAW_MEDIA_DIR", "assets/claw"))
    )
    """Where image versions of the PDFs live, one folder per deck.

    A phone attaches from the gallery, which cannot see documents. Put page
    images in `assets/claw/<pdf name without .pdf>/` and the deck goes out as
    pictures; leave it empty and the deck is refused loudly (an escalation,
    not a silent gap) so somebody sends it by hand."""

    claw_stale_beat_minutes: int = field(
        default_factory=lambda: _env_int("CLAW_STALE_BEAT_MINUTES", 15)
    )
    """A registered phone that has not been heard from for this long, inside
    working hours, is reported as silent. Outreach through that phone is not
    happening, and nothing else in the system can tell."""

    # --- integrations ------------------------------------------------------
    google_credentials: Path = field(
        default_factory=lambda: Path(
            os.getenv("GOOGLE_CREDENTIALS", "secrets/google-credentials.json")
        )
    )
    google_token: Path = field(
        default_factory=lambda: Path(os.getenv("GOOGLE_TOKEN", "secrets/google-token.json"))
    )
    google_calendar_id: str = field(
        default_factory=lambda: os.getenv("GOOGLE_CALENDAR_ID", "primary")
    )

    meeting_cc_emails: tuple[str, ...] = field(default_factory=lambda: _env_emails(
        "MEETING_CC_EMAILS"
    ))
    """Also invited to every meeting the bot books, alongside the brand.

    Google puts them on the event, emails them the invite, and the meeting
    lands in their own calendar — which is the point: the BD team sees the
    booking without anyone sharing a calendar by hand.

    They appear on the invite, so the brand can read these addresses. If that
    is not wanted, share the calendar in Google Calendar's own settings
    instead and leave this empty — same visibility for the team, none for the
    brand."""

    bd_group_jid: str = field(default_factory=lambda: os.getenv("BD_GROUP_JID", ""))
    """Group to broadcast confirmed meetings to (FLOWCHART.md §3.3 fan-out)."""

    alert_jid: str = field(default_factory=lambda: os.getenv("ALERT_JID", ""))
    """Where operational alerts go (ban events, calendar failures, LLM
    degradation, the escalation digest). Falls back to `bd_group_jid`, then
    to the log. ROADMAP 3.2."""

    escalation_sla_hours: int = field(
        default_factory=lambda: _env_int("ESCALATION_SLA_HOURS", 4)
    )
    """Business-hours SLA for open escalations (ROADMAP 3.5): items older
    than this land in the daily digest at window open."""

    anthropic_api_key: str = field(
        default_factory=lambda: os.getenv("ANTHROPIC_API_KEY", "")
    )
    use_llm_intents: bool = field(
        default_factory=lambda: _env_bool("USE_LLM_INTENTS", False)
    )
    use_llm_replies: bool = field(
        default_factory=lambda: _env_bool("USE_LLM_REPLIES", False)
    )
    """Generate replies grounded in knowledge.py instead of sending fixed
    templates. Falls back to the template whenever generation or validation
    fails, so this can never leave a conversation unanswered."""

    reply_cache_variants: int = field(
        default_factory=lambda: _env_int("REPLY_CACHE_VARIANTS", 3)
    )
    """Generated replies are saved; once a template has this many saved
    variants, sending it reuses one at random (re-personalised with the
    contact's name and brand) instead of calling the API again. Rotating a few
    variants also avoids every contact receiving byte-identical text — a spam
    signal. 0 disables reuse and generates every time. REPLY_FREEFORM (answers
    to unclassified messages) is never reused: it answers the specific inbound
    text."""

    # --- the sending window, asked in one place ----------------------------
    # Four call sites used to re-implement "is it a working day and are we
    # inside the hours" — the engine's check, the SLA clock, the outreach loop,
    # and three printed banners. They can no longer disagree.

    def is_blocked(self, *fields: str) -> str:
        """The blocked brand this row matches, or "" — check every field.

        Takes several because the name is not where the answer usually is:
        the note carries the group ("nomor bersama 5 brand: …"), and a shared
        hotline reaches a blocked brand through a sibling's row.
        """
        hay = " | ".join(f.lower() for f in fields if f)
        if not hay:
            return ""
        for brand in self.blocked_brands:
            b = brand.strip()
            if b and b in hay:
                return b
        return ""

    def within_window(self, when: datetime) -> bool:
        """May the bot speak first at this moment?"""
        if when.weekday() not in self.send_days:
            return False
        return self.send_window_start <= when.time() <= self.send_window_end

    def days_label(self) -> str:
        """The working days, short enough for a startup banner: "Mon–Sat"."""
        days = sorted(self.send_days)
        if not days:
            return "no days"
        if len(days) == 7:
            return "every day"
        titled = [_DAY_NAMES[d].title() for d in days]
        # Contiguous runs read as a range; anything else is listed.
        if days == list(range(days[0], days[-1] + 1)):
            return titled[0] if len(days) == 1 else f"{titled[0]}–{titled[-1]}"
        return ", ".join(titled)


def load() -> Settings:
    """Load settings, reading a local .env first if present."""
    env_file = Path(".env")
    if env_file.is_file():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip("\"'"))
    return Settings()
