"""Executor: turns Actions from `flow` into real side effects.

This is the only place that sends, writes, or books anything. It enforces the
guardrails the whiteboard has no concept of (FLOWCHART.md §6.6):
dry-run, operator approval, sending window, daily cap, and per-message spacing.
"""

from __future__ import annotations

import logging
import random
import re
import sys
import threading
import time as _time
from datetime import datetime, timedelta

from . import flow, gcal, intents, responder, understanding
from .config import Settings
from .flow import (
    BookMeeting,
    CancelTimers,
    Escalate,
    NotifyGroup,
    ProposeSlots,
    Result,
    Schedule,
    Send,
    SetNode,
)
from .models import Conversation, Intent, Node, Timer
from .storage import Store
from .transport.base import Transport

log = logging.getLogger("engine")

#: Consecutive template-fallbacks (with USE_LLM_REPLIES on) before the
#: operator is alerted that generation is degraded. ROADMAP 3.2.
LLM_FALLBACK_ALERT_STREAK = 3


class Engine:
    def __init__(self, cfg: Settings, store: Store, transport: Transport) -> None:
        self.cfg = cfg
        self.store = store
        self.transport = transport
        self._last_send_at: float = 0.0
        self._sends: int = 0
        """Messages actually delivered this process. Lets `blast` report whether
        anything went out, since a send can be silently refused by the cap, the
        window, or the operator."""

        self._ctx = threading.local()
        # The reading of the message being handled right now. Thread-local for
        # the same reason as _ctx: `run` handles two brands on two threads, and
        # the booking code reads this several calls below where it was made.
        self._reading_ctx = threading.local()
        """What triggered the current send: 'reply', 'timer', 'campaign' or
        'blast'. Decides whether operator approval is required (`_approved`),
        whether the daily cap applies (`_send`), and how the message is
        labelled in the transcript.

        Thread-local, and that matters. Conversation locks are per CONTACT, so
        two brands are handled at once by design — and the outreach loop runs
        on a third thread alongside them. A single shared attribute meant
        whichever thread wrote last decided for all of them: a campaign
        opening could be logged as a reply and skip the daily cap, or a reply
        could be held for approval and leave a brand unanswered. Nothing about
        one conversation may ever be visible to another.
        """

        self.paused: bool = False
        """Outbound halt (ROADMAP 3.2). Set on ban/logout events, or by an
        operator through the dashboard's Stop button; every send is refused
        until it is cleared. See `pause` for what a halt does and does not
        keep hold of."""

        self.pause_reason: str = ""

        self.on_referral = None
        """Optional callable(phone, referred_by) -> bool that queues a number a
        brand handed us. Wired to the dashboard's target list in cmd_run; None
        in the simulator, where inventing outreach targets would be wrong."""
        """Why outbound is halted — shown on the dashboard so an operator can
        tell their own Stop click apart from a ban the bot caught itself."""

        self._llm_fallback_streak: int = 0
        self._llm_alerted: bool = False

        self._convo_locks: dict[str, threading.RLock] = {}
        self._convo_locks_guard = threading.Lock()
        """One lock per contact, so their messages are handled in order.

        Every inbound now runs on its own thread (the dispatcher must not
        block), which let two messages from the same person be processed at
        once — the second read the conversation before the first had written
        it. Live, a contact who sent "/restart" and then a question got the
        new-lead qualification form in the middle of an open conversation,
        because the restart's blast had not yet recorded the node.

        Per-contact rather than global: two different brands may be answered
        in parallel, one brand's messages may not overtake each other.
        """

        self._outbound = threading.RLock()
        """Serialises approval-and-send across threads.

        Three threads reach `_send`: the timer loop, whatsmeow's inbound
        dispatcher, and the startup blast hook. Unserialised, two of them can
        sit on `input()` at the same terminal at once — the operator then sees
        two "send? [y/N/q]" prompts and has no way to tell which one their
        keystroke answered. It also makes `_throttle`'s pacing mean what it
        says, instead of two threads each measuring the same gap.
        """

    # -- clock --------------------------------------------------------------

    def now(self) -> datetime:
        return datetime.now(tz=self.cfg.tz)

    # -- guardrails ---------------------------------------------------------

    def within_send_window(self, when: datetime) -> bool:
        return self.cfg.within_window(when)

    def _throttle(self) -> None:
        gap = self.cfg.min_seconds_between_sends
        elapsed = _time.monotonic() - self._last_send_at
        if self._last_send_at and elapsed < gap:
            _time.sleep(gap - elapsed)
        self._last_send_at = _time.monotonic()

    def _approved(self, jid: str, text: str) -> bool:
        # Answering someone who just messaged us needs no confirmation.
        if self._context == "reply" and self.cfg.auto_reply:
            return True
        if not self.cfg.require_approval:
            return True
        # A scheduled follow-up continues a conversation an operator already
        # chose to start; the approval gate is there to stop the bot *starting*
        # conversations unattended, which is `blast`. Gating follow-ups too made
        # the whole ladder (COLD_FU1-4, WARM_*) unsendable on a server, where
        # nothing can answer a prompt — the flow under test simply never ran.
        # Blasts stay gated, so an unattended process still cannot cold-message
        # anybody who is not already in a conversation.
        if self._context == "timer":
            return True
        # "campaign": the opening for a brand an operator queued in the /mcnbd
        # dashboard. Typing the row IS the approval — re-asking at a terminal
        # nobody is watching would just mean no outreach ever leaves. Plain
        # "blast" (an ad-hoc send from the command line) stays gated, so an
        # unattended process still cannot message anybody off-list.
        if self._context == "campaign":
            return True
        # Ask only where there is somebody who can answer. The EOFError branch
        # below assumes a closed stdin, which is what cron and a bare service
        # give you — but under pm2 stdin is an open IPC *socket*, so input()
        # blocked forever instead of raising. On 8 Aug 2026 that froze the timer
        # thread on the first scheduled follow-up: no follow-up ever fired again,
        # while the control API kept cheerfully reporting "connected".
        if not sys.stdin.isatty():
            log.warning(
                "approval required but no interactive terminal; skipping %s to %s",
                self._context, jid.split("@")[0],
            )
            return False
        print(f"\n--- pending {self._context} to {jid.split('@')[0]} ---")
        print(text)
        try:
            answer = input("send? [y/N/q] ").strip().lower()
        except EOFError:
            # Non-interactive (cron, service): fail closed, never guess.
            log.warning("approval required but no TTY; skipping send to %s", jid)
            return False
        if answer == "q":
            raise KeyboardInterrupt
        return answer == "y"

    # -- action application -------------------------------------------------

    def apply(self, convo: Conversation, result: Result) -> None:
        now = self.now()

        for action in result.actions:
            match action:
                case CancelTimers():
                    n = self.store.cancel_all(convo.jid)
                    if n:
                        log.debug("cancelled %d pending timer(s) for %s", n, convo.jid)

                case SetNode(node=node, outcome=outcome):
                    convo.node = node
                    convo.outcome = outcome

                case Schedule(timer=timer, fire_at=fire_at):
                    self._schedule(convo.jid, timer, fire_at, now)

                case Send(message=message):
                    varied = self._vary(convo, message.key)
                    if varied != message.key:
                        from . import templates

                        message = templates.render(varied, convo, self.cfg)
                    text = self._compose(convo, message)
                    # Attachments only follow if the text actually went out
                    # — a declined or capped send must not leak the files.
                    if self._send(convo, text, now, key=message.key):
                        if message.attach_opening:
                            self._send_opening(convo)
                        if message.attach_company_profile:
                            self._send_profile(convo)
                        if message.attach_case_study:
                            self._send_case_studies(convo)
                        if message.attach_ads_deck:
                            self._send_ads_deck(convo)

                case NotifyGroup(text=text):
                    if self.cfg.bd_group_jid:
                        self._raw_send(self.cfg.bd_group_jid, text)
                    else:
                        log.info("[no BD_GROUP_JID set] %s", text)

                case BookMeeting():
                    self._book(convo, now)

                case ProposeSlots(fallback=fallback):
                    self._propose_slots(convo, fallback, now)

                case Escalate(reason=reason, inbound_text=body):
                    self.store.escalate(convo.jid, reason, body, now)
                    log.warning(
                        "ESCALATION %s — %s %s",
                        convo.jid.split("@")[0],
                        reason,
                        f"({body[:80]!r})" if body else "",
                    )

        self.store.upsert(convo)

    # -- scheduling ---------------------------------------------------------

    def _schedule(
        self, jid: str, timer: Timer, fire_at: datetime, now: datetime
    ) -> None:
        """Queue a timer, compressing the wait when demo mode is on.

        Production stores `fire_at` as the flow computed it. In demo mode the
        wait collapses to `demo_gap_seconds`, and the wait it stood in for is
        carried in the job payload so the firing can announce it ("⏩ *1 hari
        kemudian*"). Compressed jobs queue after whatever is already pending
        for this contact rather than all landing on the same second, which is
        what keeps a multi-timer fan-out (reminders, then meeting end) firing
        in the flowchart's order.

        The announced wait is measured from the timer queued before it, not
        from now: booking arms three timers in one breath, and labelling all
        of them from `now` would tell a tester who just read "21 jam kemudian"
        that the next message is "22 jam kemudian" — 22 hours after a moment
        that, as far as the chat is concerned, has already gone by. Each label
        answers the only question the marker is there to answer: how long
        since the message above it.
        """
        if not self.cfg.demo_mode:
            self.store.schedule(jid, timer, fire_at)
            log.debug("scheduled %s at %s for %s", timer, fire_at, jid)
            return

        gap = timedelta(seconds=self.cfg.demo_gap_seconds)
        pending = self.store.pending(jid)
        after = max([j.fire_at for j in pending] + [now])
        compressed = after + gap
        previous = [
            datetime.fromisoformat(j.payload["real_at"])
            for j in pending
            if j.payload.get("real_at")
        ]
        self.store.schedule(
            jid,
            timer,
            compressed,
            wait_label=_wait_label(fire_at - max(previous + [now])),
            real_at=fire_at.isoformat(),
        )
        log.info(
            "[demo] scheduled %s for %s in %ds (real: %s)",
            timer.value,
            jid.split("@")[0],
            int((compressed - now).total_seconds()),
            fire_at.strftime("%d %b %H:%M"),
        )

    def _send_marker(self, jid: str, label: str) -> None:
        """Announce the wait a demo-mode timer just skipped.

        Deliberately outside `_send`: the marker is scaffolding for the test
        session, not a message the bot would ever send a brand, so it must not
        consume the daily cap, wait for approval, or land in the reply cache.
        It is logged under its own direction — kept out of `sent_today`, which
        is what the cap counts, while still leaving a trace in the transcript
        of where each jump happened.
        """
        text = f"⏩ *{label}*"
        if self.paused:
            return
        if self.cfg.dry_run:
            print(f"\n[DRY RUN] would send to {jid.split('@')[0]}:\n{text}\n")
        else:
            with self._outbound:
                self._throttle()
                self.transport.send_text(jid, text)
        self.store.log_message(jid, "demo", text, self.now())

    # -- sending ------------------------------------------------------------

    def _next_window_open(self, now: datetime) -> datetime:
        """Next moment the sending window is open."""
        candidate = now.replace(
            hour=self.cfg.send_window_start.hour,
            minute=self.cfg.send_window_start.minute,
            second=0,
            microsecond=0,
        )
        if candidate <= now:
            candidate += timedelta(days=1)
        # Skip weekends when configured to.
        for _ in range(7):
            if self.within_send_window(candidate):
                return candidate
            candidate += timedelta(days=1)
        return candidate

    #: Templates with a second wording, used when the first has just gone
    #: out. A brand asking the same kind of question twice should not receive
    #: the same paragraph twice — it reads as a machine that did not register
    #: the second question.
    _SECOND_WORDING = {"REPLY_TANYA_CUSTOM": "REPLY_TANYA_CUSTOM_AGAIN"}

    def _vary(self, convo: Conversation, key: str) -> str:
        alt = self._SECOND_WORDING.get(key)
        if not alt:
            return key
        from . import templates

        first = templates.render(key, convo, self.cfg).text[:40]
        recent = self.store.recent_outbound_texts(convo.jid, limit=3)
        return alt if any(r.startswith(first) for r in recent) else key

    def _compose(self, convo: Conversation, message) -> str:
        """Static template, cached generation, or a fresh generation.

        The cache means the API is paid per template a handful of times, not
        per message: once `reply_cache_variants` generations of a template are
        saved, sends of it rotate those variants (re-personalised) for free.
        """
        if not self.cfg.use_llm_replies or not message.key:
            return message.text

        cached = self._cached_reply(convo, message.key)
        if cached is not None:
            log.debug("reply cache hit for %s", message.key)
            return cached

        last_in = self.store.last_inbound_text(convo.jid)
        intent = intents.classify_rules(last_in) if last_in else Intent.UNKNOWN
        text = responder.generate(
            key=message.key,
            intent=intent,
            convo=convo,
            inbound=last_in,
            fallback=message.text,
            cfg=self.cfg,
        )
        # Only keys that were eligible to be generated say anything about the
        # health of generation. A follow-up template is *supposed* to come back
        # as the fallback, and counting those raised "check the API key" against
        # a perfectly good API key after three timer-driven follow-ups.
        if message.key in responder.GENERATIVE_KEYS:
            self._track_llm_health(fell_back=text == message.text)
        # Only real generations are worth saving — the fallback is already free.
        if text != message.text and message.key in responder.CACHEABLE_KEYS:
            leak = self._contact_specific(text)
            if leak:
                # Reuse re-personalises the name and the brand and nothing
                # else, so anything else contact-specific would be replayed
                # verbatim to a different company. On 13-14 Aug a cached
                # REPLY_TERUSKAN_TIM generated for Greenfields carried their
                # own address, and three other brands were told we would send
                # their proposal to consumerfeedback@greenfieldsdairy.com.
                log.warning(
                    "not caching %s — it contains %s, which would leak to the "
                    "next contact", message.key, leak,
                )
            else:
                self.store.cache_reply(
                    message.key, text, convo.name or "", convo.brand or "",
                    self.now(),
                )
        return text

    #: What must never be carried from one contact's reply into another's.
    _LEAKY = (
        ("an email address", re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")),
        ("a phone number", re.compile(r"(?:\+?62|0)[\s.-]?8\d{1,3}(?:[\s.-]?\d{2,4}){2,4}")),
        ("a link", re.compile(r"https?://\S+")),
    )

    def _contact_specific(self, text: str) -> str:
        """Name what makes this reply unsafe to reuse, or "".

        Deliberately broad: a false positive costs one API call next time,
        a false negative sends one brand's contact details to another.
        """
        for label, rx in self._LEAKY:
            if rx.search(text or ""):
                return label
        return ""

    def _track_llm_health(self, *, fell_back: bool) -> None:
        """Alert once when generation keeps falling back to static templates
        (API outage, exhausted key, model errors). The conversation itself is
        never blocked — templates always work — but a human should know the
        bot has quietly lost its generated voice. ROADMAP 3.2."""
        if not fell_back:
            self._llm_fallback_streak = 0
            self._llm_alerted = False
            return
        self._llm_fallback_streak += 1
        if (
            self._llm_fallback_streak >= LLM_FALLBACK_ALERT_STREAK
            and not self._llm_alerted
        ):
            self._llm_alerted = True
            self.alert(
                f"⚠️ LLM reply generation fell back to static templates "
                f"{self._llm_fallback_streak}x in a row — check the API key "
                f"and logs. Conversations continue on templates."
            )

    def _cached_reply(self, convo: Conversation, key: str) -> str | None:
        if key not in responder.CACHEABLE_KEYS or self.cfg.reply_cache_variants <= 0:
            return None
        # Re-validate on read, not just on write. A variant was validated
        # against the knowledge base as it stood when it was generated; when a
        # fact is corrected, every stale variant is still sitting here and
        # would keep going out unchecked. Found on 29 Jul 2026: the cache held
        # a reply quoting "Rp25 juta per bulan" (the fee is per campaign) and
        # another quoting Rp15 juta, a price no longer on offer at all.
        variants = []
        for row in self.store.cached_replies(key):
            ok, reason = responder.validate(row["text"], key)
            if ok:
                variants.append(row)
                continue
            log.warning("evicting stale cached %s (%s)", key, reason)
            self.store.drop_cached_reply(row["id"])

        if len(variants) < self.cfg.reply_cache_variants:
            return None
        row = random.choice(variants)
        text = _personalise(
            row["text"],
            old_name=row["name"],
            old_brand=row["brand"],
            new_name=convo.name_or("Kak"),
            new_brand=convo.brand or "brand Kakak",
        )

        # Belt and braces at the point of use. `_contact_specific` screens what
        # goes INTO the cache, but it only knows the shapes it was taught, and
        # `_personalise` only swaps whole-word name and brand — a variant the
        # model wrote as "Kak Dyan" when the record said "Dyan Jati" would keep
        # the fragment. So before this text can be sent to somebody else,
        # verify no trace of who it was written for survives.
        stale = self._contact_specific(text)
        for field in (row["name"], row["brand"]):
            # Whole string AND each word of it: the swap is whole-word, so a
            # reply the model wrote as "Kak Dyan" when the record said "Dyan
            # Jati" keeps the fragment. Words of four characters or more only,
            # so a brand called "PT X" does not reject every reply.
            for token in {(field or "").strip(), *(field or "").split()}:
                if len(token) >= 4 and re.search(
                    rf"\b{re.escape(token)}", text, re.I
                ):
                    stale = f"the previous contact ({token})"
                    break
        if stale:
            log.warning(
                "discarding cached %s — it still carries %s; generating fresh",
                key, stale,
            )
            self.store.drop_cached_reply(row["id"])
            return None
        return text

    def _send(
        self, convo: Conversation, text: str, now: datetime, key: str = ""
    ) -> bool:
        """Returns True only if the message actually went out.

        Persuasive texts (the generative templates) are delivered as a burst
        of up to three shorter messages (ROADMAP 2.3) — the real agents text
        in short runs, and one long block reads like a bot. The burst is one
        logical send: one approval, one log row, one unit against the cap.
        Operational messages (confirmations, reminders, the blast) stay whole.
        """
        if self.paused:
            log.warning("outbound is PAUSED; refusing send to %s", convo.jid)
            return False
        # The cap governs messages the bot STARTS — on both sides of the
        # question. It counts only those (see `proactive_sent_today`), and it
        # restricts only those: a brand mid-conversation must never be left
        # hanging because the day's outreach budget ran out. Answering someone
        # who just wrote in is the safest message the bot sends.
        if (
            self._context != "reply"
            and self.store.proactive_sent_today(now) >= self.cfg.max_blasts_per_day
        ):
            log.warning(
                "daily cap reached (%d proactive sends); replies still go out",
                self.cfg.max_blasts_per_day,
            )
            return False
        # Last line of defence against a ping-pong, and the only one that sees
        # timer-driven sends as well as replies. Escalated, not dropped
        # silently: something upstream believed this needed saying.
        if self._would_repeat_ourselves(convo.jid, text, now):
            if not self.store.has_open_escalation(convo.jid, self._LOOP_TAG):
                self.store.escalate(
                    convo.jid,
                    f"{self._LOOP_TAG}: would have repeated our own last message",
                    text, now,
                )
            log.warning(
                "LOOP %s — refusing to send the same message twice",
                convo.jid.split("@")[0],
            )
            return False

        chunks = _burst_chunks(text) if key in responder.GENERATIVE_KEYS else [text]

        if self.cfg.dry_run:
            short = convo.jid.split("@")[0]
            for i, chunk in enumerate(chunks, 1):
                part = f" ({i}/{len(chunks)})" if len(chunks) > 1 else ""
                print(f"\n[DRY RUN] would send to {short}{part}:\n{chunk}\n")
        else:
            with self._outbound:
                if not self._approved(convo.jid, text):
                    log.info("operator declined send to %s", convo.jid)
                    return False
                # A transport that only QUEUES (claw: a phone types this
                # later) must not be paced here. The gaps exist to keep a
                # socket from looking like a machine; the phone does its own
                # pacing, at its own speed. Worse, they are paid twice: a
                # phone is holding the chat open waiting for these words, and
                # a ten-second sleep inside the request is ten seconds of a
                # cursor blinking at a brand.
                paced = not getattr(self.transport, "defers", False)
                for i, chunk in enumerate(chunks):
                    if i == 0:
                        if paced:
                            self._throttle()
                    elif paced and self.cfg.min_seconds_between_sends > 0:
                        # Intra-burst pacing: quick, human, not machine-gun.
                        _time.sleep(random.uniform(2.0, 5.0))
                    self.transport.send_text(convo.jid, chunk)

        convo.last_outbound_at = now
        self.store.log_message(convo.jid, "out", text, now, self._context)
        self._sends += 1
        return True

    def _raw_send(self, jid: str, text: str) -> bool:
        if self.paused:
            log.warning("outbound is PAUSED; refusing send to %s", jid)
            return False
        if self.cfg.dry_run:
            print(f"\n[DRY RUN] would send to {jid.split('@')[0]}:\n{text}\n")
            return True
        with self._outbound:
            if not self._approved(jid, text):
                log.info("operator declined send to %s", jid)
                return False
            if not getattr(self.transport, "defers", False):
                self._throttle()
            self.transport.send_text(jid, text)
        return True

    _IMAGE_SUFFIXES = frozenset({".jpg", ".jpeg", ".png", ".webp"})

    def _opening_files(self) -> list[Path]:
        d = self.cfg.opening_dir
        if not d.is_dir():
            return []
        files = [p for p in sorted(d.iterdir()) if p.is_file() and not p.name.startswith(".")]
        # Images first — the pic renders inline in the chat, the deck follows.
        return sorted(files, key=lambda p: p.suffix.lower() not in self._IMAGE_SUFFIXES)

    def _attach(self, jid: str, path: Path, filename: str = "") -> None:
        """Send one attachment. A transport failure is logged, never raised.

        The text it belongs to has already gone out by the time attachments
        are sent, so letting the error escape unwinds `apply` before it saves
        the conversation — the contact is left holding a message the bot has
        no record of sending, un-blasted in the database and eligible to be
        greeted all over again. Observed live: the socket was replaced
        mid-blast and the opening's PDF took the whole conversation with it.
        A missing deck is worth a warning; it is not worth losing the thread.
        """
        # Once per contact, whatever asks for it. The same deck arriving on
        # the opening and again on every follow-up reads as spam, not service
        # — and a brand who wants it again asks, which is a different message
        # with a different answer.
        if self.store.already_sent_file(jid, path.name):
            log.info("%s already sent to %s; not repeating it",
                     path.name, jid.split("@")[0])
            return
        try:
            if path.suffix.lower() in self._IMAGE_SUFFIXES:
                self.transport.send_image(jid, path)
            else:
                self.transport.send_document(jid, path, filename or path.name)
        except Exception:
            log.exception("attachment %s not delivered to %s", path.name, jid)
            return
        self.store.record_file(jid, path.name, self.now())

    def _send_opening(self, convo: Conversation) -> None:
        """Ship every file in `opening/` after the greeting text."""
        files = self._opening_files()
        if not files:
            log.warning("opening dir %s is empty; greeting sent without files", self.cfg.opening_dir)
            return
        for path in files:
            if self.cfg.dry_run:
                print(f"[DRY RUN] would attach {path.name}")
                continue
            self._attach(convo.jid, path)

    def _send_profile(self, convo: Conversation) -> None:
        path = self.cfg.company_profile_pdf
        if not path.is_file():
            # No assets/company-profile.pdf? Fall back to the deck already
            # shipped with greetings, so rejections still leave something behind.
            pdfs = [p for p in self._opening_files() if p.suffix.lower() == ".pdf"]
            if pdfs:
                path = pdfs[0]
        name = path.name if path != self.cfg.company_profile_pdf else "Company Profile MCNAsia.pdf"
        if self.cfg.dry_run:
            missing = "" if path.is_file() else "  (FILE MISSING)"
            print(f"[DRY RUN] would attach {name}{missing}")
            return
        self._attach(convo.jid, path, name)

    def _send_ads_deck(self, convo: Conversation) -> None:
        """Ship the ads-service deck with the ads answer.

        No fallback to the affiliate deck on purpose: a brand asking about ads
        got a different product's pricing, which is worse than getting text
        alone. The text answers the question either way.

        Since 18 Aug 2026 the ads deck and the opening deck are one file, so
        the usual case is a brand that already has it. Nothing extra is needed
        to stop the repeat — `_attach` already drops any file this contact has
        received before — and the ads prices are in the reply text regardless.
        """
        path = self.cfg.ads_deck_pdf
        if self.cfg.dry_run:
            missing = "" if path.is_file() else "  (FILE MISSING)"
            print(f"[DRY RUN] would attach {path.name}{missing}")
            return
        if not path.is_file():
            log.warning(
                "ads deck %s is missing; ads answer sent without the file", path
            )
            return
        self._attach(convo.jid, path)

    def _send_case_studies(self, convo: Conversation) -> None:
        """Ship the contact's category case-study files (ROADMAP 2.4).

        The corpus shows GMV screenshots for a comparable brand are the move
        that converts doubters — this sends whatever the team has curated
        under assets/case-studies/<category>/. No category, no folder, or an
        empty folder means nothing extra goes out, and files never cross
        categories."""
        category = _category_slug(convo.category)
        if not category:
            return
        folder = self.cfg.case_studies_dir / category
        if not folder.is_dir():
            log.debug("no case-study folder for category %r", category)
            return
        files = [
            p for p in sorted(folder.iterdir())
            if p.is_file() and not p.name.startswith(".")
        ]
        for path in files:
            if self.cfg.dry_run:
                print(f"[DRY RUN] would attach case study {category}/{path.name}")
            else:
                self._attach(convo.jid, path)

    # -- operational alerts (ROADMAP 3.2) ------------------------------------

    def alert(self, text: str) -> None:
        """Tell a human something operational, outside any conversation.

        Goes to ALERT_JID, else the BD group, else the log. Never prompts for
        approval and never raises — alerting must not break the caller."""
        target = self.cfg.alert_jid or self.cfg.bd_group_jid
        log.warning("ALERT: %s", text)
        if not target:
            return
        try:
            if self.cfg.dry_run:
                print(f"\n[DRY RUN] would alert {target.split('@')[0]}:\n{text}\n")
            else:
                self.transport.send_text(target, text)
        except Exception:
            log.exception("could not deliver alert")

    def handle_transport_event(self, kind: str, detail: str = "") -> None:
        """Transport trouble: ban, logout, disconnect. ROADMAP 3.2.

        Ban and logout pause ALL outbound immediately — continuing to send
        on a flagged account is how a temporary ban becomes permanent. A
        disconnect alerts but does not pause: neonize reconnects on its own.
        """
        now = self.now()
        if kind in {"banned", "logged_out"}:
            self.pause(f"transport {kind}")
            self.store.escalate("system", f"transport {kind}: {detail}", "", now)
            self.alert(
                f"🛑 WhatsApp transport reported {kind.upper()} — outbound is "
                f"PAUSED. Investigate before restarting. {detail}"
            )
        else:
            log.warning("transport event %s: %s", kind, detail)
            self.alert(f"⚠️ WhatsApp transport {kind}: {detail}")

    # -- operator stop / run -------------------------------------------------

    #: Boot halt for an unattended campaign. The WhatsApp session lives on disk
    #: and whatsmeow reconnects from it about a second after start, so "the bot
    #: is connected" is never evidence that a person meant it to be: on 12 Aug
    #: 2026 a deploy restart put the number back online by itself and the
    #: outreach loop opened five brands before anyone had touched the
    #: dashboard. Sending now waits for a deliberate connect — see cmd_run for
    #: who sets this and http_api for what clears it.
    WAITING_FOR_CONNECT = "menunggu koneksi WhatsApp"

    def pause(self, reason: str = "operator") -> None:
        """Halt the bot without dropping the WhatsApp session.

        Stop has to mean "nothing happens while I am not looking", which is
        more than refusing sends. Three things are held, not skipped:

        * Due timers stay pending. `tick` returns early, so the follow-up
          ladder is not burned against a muted `_send` — a stop over lunch
          would otherwise silently consume every rung and resume into a
          conversation the brand never saw. On resume they are overdue and
          drain paced by `_throttle`, exactly as they do after downtime.
        * Inbound is recorded but not answered, so it surfaces in
          `unanswered_inbound` at the next start rather than vanishing.
        * The socket stays up. Killing the process would mean pm2 restarting
          us seconds later, so a real stop cannot be a stop of the process.
        """
        if not self.paused:
            log.warning("outbound PAUSED (%s)", reason)
        self.paused = True
        self.pause_reason = reason

    def resume(self) -> None:
        """Clear an operator halt. Overdue timers fire on the next tick."""
        if self.paused:
            log.warning("outbound RESUMED (was: %s)", self.pause_reason or "paused")
        self.paused = False
        self.pause_reason = ""

    def release_connect_gate(self) -> bool:
        """Let sending start, but only if the boot gate is what is holding it.

        Wired to the dashboard's Connect button. Deliberately narrow: a halt
        from a ban or a logout must survive somebody clicking Connect, or the
        one control that stops a flagged account sending would be cleared by
        the very action taken to investigate it.
        """
        if not self.paused or self.pause_reason != self.WAITING_FOR_CONNECT:
            return False
        self.resume()
        return True

    # -- scheduling ----------------------------------------------------------

    def _propose_slots(
        self, convo: Conversation, fallback, now: datetime
    ) -> None:
        """Offer 1–2 concrete free slots on agreement (ROADMAP 2.2).

        Falls back to the open "hari dan jam berapa?" ask when the calendar
        is unreachable — agreement must never go unanswered."""
        from . import templates

        try:
            # The whole window, not the first 24 hourly slots: 24 runs out
            # on the third day, so "kalau Sabtu?" filtered against a list that
            # never reached Saturday and silently fell back to the generic
            # three days.
            slots = self._calendar_free_slots(now, limit=100)
        except gcal.CalendarError as exc:
            log.warning("slot proposal unavailable (%s); using the open ask", exc)
            slots = []
        if not slots:
            self._send(convo, self._compose(convo, fallback), now, key=fallback.key)
            return

        # If they already named a time and it is free, take it. Proposing
        # our own slots over theirs reads as not having been listened to at
        # the one turn that matters most — seen in testing: "saya available
        # hari ini di jam 13.00" was answered with "11.00 / 09.00", and the
        # lead dropped their own preference to fit ours.
        # "kalau Sabtu bisa ga ya ka?" — they asked about one day, so answer
        # about that day. Listing the next three instead reads as not having
        # been asked.
        texts = self.store.recent_inbound_texts(convo.jid)

        # "aku gabisa hari ini" and then being offered today is the whole
        # problem restated. Drop the days they excluded before anything else.
        excluded: set = set()
        for text in texts:
            excluded |= _excluded_days(text, now)
        if excluded:
            remaining = [s for s in slots if s.date() not in excluded]
            if remaining:
                slots = remaining

        asked_day = _day_in_context(texts, now)
        if asked_day is not None:
            on_that_day = [s for s in slots if s.date() == asked_day]
            if on_that_day:
                slots = on_that_day

        chosen = self._requested_slot(convo, slots, now)
        if chosen is not None:
            msg = templates.render(
                "CONFIRM_REQUESTED_SLOT", convo, self.cfg, opsi=_fmt_slot(chosen)
            )
            self._send(convo, msg.text, now, key=msg.key)
            return

        opsi = _free_ranges(slots) or " / ".join(
            _fmt_slot(s) for s in _spread_slots(slots)
        )
        # The full preamble once. A brand working through days gets three
        # proposals in a row, and opening each with the same sentence reads as
        # a machine that has not registered anything they said — the second
        # and later ones answer and stop.
        already = any(
            "Kami tersedia Senin" in prior
            for prior in self.store.recent_outbound_texts(convo.jid, limit=8)
        )
        key = "PROPOSE_SLOTS_AGAIN" if already else "PROPOSE_SLOTS"
        # Keep asking for the email until we have one — it is the only thing
        # still missing, and dropping it would stall the booking.
        if already and not convo.email:
            opsi = f"{opsi}\n\nMohon bantu juga alamat email-nya ya, untuk undangan Google Meet-nya."
        msg = templates.render(key, convo, self.cfg, opsi=opsi)
        self._send(convo, msg.text, now, key=msg.key)

    def _requested_slot(
        self, convo: Conversation, slots: list[datetime], now: datetime
    ) -> datetime | None:
        """The free slot the contact actually asked for, if they asked for one.

        Reads the same recent turns `_book` does, with the same date-stripping,
        so "jam 13.00" is honoured identically whether it arrives before or
        after the email. Returns None when they named nothing, or named
        something already taken — the caller then offers alternatives, which
        is the right answer to a slot that is genuinely unavailable.
        """
        texts = self.store.recent_inbound_texts(convo.jid)
        read = self.current_reading()
        day = read.meeting_day or _day_in_context(texts, now)
        hours: set[int] = {read.meeting_hour} if read.meeting_hour is not None else next(
            (
                h
                for t in texts
                if (
                    h := _requested_hours(
                        _strip_dates(t), self.cfg.meeting_hour_start
                    )
                )
            ),
            set(),
        )
        # Both, or nothing. With only an hour the date was guessed, and with
        # only a day the time was — "boleh kak tapi aku gabisa minggu ini"
        # named neither and still got "Kamis 30/07 jam 12.00 saya catat ya".
        # Anything less than a complete choice goes back to them as a
        # question, which is what the proposal does.
        if not hours or not day:
            return None
        pool = [s for s in slots if s.date() == day]
        return next((s for s in pool if s.hour in hours), None)

    def _book(self, convo: Conversation, now: datetime) -> None:
        """Turn an accepted meeting into a real Calendar event + Meet link.

        Availability is the calendar's word, not ours: the invite goes out
        only for a slot Google Calendar confirms is free. A requested hour
        that is busy gets a "that one's taken, here's what's open" reply, and
        a failed availability check books nothing — but the contact still
        gets an acknowledgement and a human gets the escalation, never
        silence (ROADMAP 3.2).
        """
        try:
            # High limit: day filtering needs the whole window, not the first
            # dozen — a truncated list would make later days look full.
            slots = self._calendar_free_slots(now, limit=100)
        except gcal.CalendarError as exc:
            log.error("availability check failed: %s", exc)
            self._booking_failed(
                convo, f"calendar availability check failed: {exc}", now
            )
            return
        if not slots:
            self._booking_failed(convo, "no free calendar slots", now)
            return

        # The preferred day/hour may sit a message earlier than the email did
        # — walk the recent messages newest-first and let the newest mention
        # win outright, so "kalau gitu jam 14 aja" overrides last turn's
        # "jam 13", not merges with it.
        # What the reading found beats what the regex finds. Scanning recent
        # inbound text for a day and an hour is how "Silahkan hubungi kami
        # kembali pada Jam Operasional yaitu hari Senin s/d Jumat pukul 09.00 -
        # 18.00" — a switchboard's opening hours — became "Senin 17/08 jam
        # 09.00 saya catat ya", and how "percakapan ini akan kami akhiri dalam
        # 5 menit kedepan" became a 17.00 booking.
        texts = self.store.recent_inbound_texts(convo.jid)
        read = self.current_reading()
        day = read.meeting_day or _day_in_context(texts, now)
        requested: set[int] = {read.meeting_hour} if read.meeting_hour is not None else next(
            (
                hours
                for t in texts
                # Strip date expressions first so "25/7" or "tanggal 12" is
                # not misread as an hour.
                if (
                    hours := _requested_hours(
                        _strip_dates(t), self.cfg.meeting_hour_start
                    )
                )
            ),
            set(),
        )

        # A named day narrows the calendar pool to that day.
        pool = [s for s in slots if s.date() == day] if day else slots
        if day and not pool:
            # That whole day is full (or a weekend) — offer other days.
            self._offer_slots(
                convo, "SLOT_UNAVAILABLE", slots[:3], now, jam=_day_label(day)
            )
            return

        if not requested:
            # Day but no hour (or nothing at all) — show what is actually
            # open and ask them to pick.
            self._offer_slots(convo, "SLOT_OPTIONS", pool, now)
            return

        chosen = next((s for s in pool if s.hour in requested), None)
        if chosen is None:
            # The hour they want is taken (or outside the window). Name the
            # PM reading only ("jam 2" -> 14.00, not "02.00, 14.00"), and
            # offer the free slots closest to what they wanted.
            shown = {h for h in requested if not (h + 12) in requested}
            jam = "jam " + ", ".join(f"{h:02d}.00" for h in sorted(shown) if h <= 23)
            if day:
                jam = f"{_day_label(day)} {jam}"
            nearest = sorted(
                pool, key=lambda s: min(abs(s.hour - h) for h in shown)
            )[:3]
            nearest.sort()
            self._offer_slots(convo, "SLOT_UNAVAILABLE", nearest, now, jam=jam)
            return

        try:
            booking = self._calendar_book(
                chosen,
                summary=f"Meeting Online {convo.brand or convo.name_or('Brand')} X MCN Asia",
                description="Diskusi kerja sama Campaign Affiliate.",
                attendee_email=convo.email,
            )
        except gcal.CalendarError as exc:
            log.error("booking failed: %s", exc)
            self._booking_failed(convo, f"calendar booking failed: {exc}", now)
            return

        convo.meeting_at = booking.start
        convo.meet_link = booking.meet_link
        self.apply(convo, flow.on_meeting_booked(convo, self.cfg, now))

    # -- the calendar, behind two methods (CRM copy, 25 Sep 2026) ------------
    #
    # `_book` and `_propose_slots` used to call `gcal.free_slots` / `gcal.book`
    # directly. They now go through these two, which do exactly that and
    # nothing more — so `brain_serve.RecordingEngine` can see the `Booking`
    # (event id, Calendar link) that `_book` otherwise keeps to itself and the
    # CRM needs to link the meeting task to the Google event. Tests that
    # monkeypatch `gcal.free_slots` / `gcal.book` still work: the module
    # attribute is looked up at call time, as before.

    def _calendar_free_slots(self, now: datetime, limit: int = 12) -> list[datetime]:
        return gcal.free_slots(self.cfg, now, limit=limit)

    def _calendar_book(self, start: datetime, **kwargs) -> gcal.Booking:
        return gcal.book(self.cfg, start, **kwargs)

    def _booking_failed(self, convo: Conversation, reason: str, now: datetime) -> None:
        """Calendar trouble mid-booking: acknowledge the contact ("jadwalnya
        sedang saya siapkan"), escalate so a human books manually, and alert.
        The lead agreed to a meeting — silence here loses them."""
        from . import templates

        msg = templates.render("BOOKING_DELAY", convo, self.cfg)
        self._send(convo, msg.text, now, key=msg.key)
        self.store.escalate(convo.jid, reason, "", now)
        self.alert(
            f"⚠️ Booking failed for {convo.jid.split('@')[0]} "
            f"({convo.brand or convo.name_or('-')}): {reason}. "
            f"Book manually and confirm to the contact."
        )

    def _offer_slots(
        self,
        convo: Conversation,
        template: str,
        slots: list[datetime],
        now: datetime,
        **extra: str,
    ) -> None:
        """Reply with the nearest genuinely-free slots; conversation stays in
        SCHEDULING so the next reply drives another booking attempt.

        Days the contact ruled out are dropped here too. Offering today's
        remaining hours to someone who opened with "aku gabisa hari ini" is
        the same discourtesy as proposing them in the first place — it just
        arrives by a different route, the one taken when their chosen hour
        turns out to be booked.
        """
        from . import templates

        excluded: set = set()
        for text in self.store.recent_inbound_texts(convo.jid):
            excluded |= _excluded_days(text, now)
        if excluded:
            kept = [s for s in slots if s.date() not in excluded]
            if kept:
                slots = kept

        opsi = " / ".join(_fmt_slot(s) for s in slots[:3])
        msg = templates.render(template, convo, self.cfg, opsi=opsi, **extra)
        if self._send(convo, msg.text, now):
            # Nudge if they go quiet on the choice.
            self._schedule(
                convo.jid, Timer.MENUNDA_H1, now + flow.DELAYS[Timer.MENUNDA_H1], now
            )
        self.store.upsert(convo)

    # -- event entry points -------------------------------------------------

    #: Pilot testers reset their own conversation with this (PILOT.md §3).
    #: Matched before classification: `/restart` is not a brand reply, and the
    #: rules would only ever land it in UNKNOWN and escalate to a human.
    #: Leading quotes are tolerated because a tester typed `"/restart"` during
    #: the pilot: it missed, fell through to unknown, and their reset attempt
    #: was answered by escalating them to a human instead.
    #:
    #: The slash is optional when the message is ONLY the command: on 30 Jul
    #: 2026 a tester tried "Restart", then "Mulai dari awal", and both fell to
    #: unknown — they could not get back to the opening at all. Requiring the
    #: whole message to be the command is what keeps this safe; a brand
    #: writing "kita restart campaign nya ya" is not asking for a replay. The
    #: RESTART_JIDS allowlist gates it to testers regardless.
    #: Vowels are optional in the bare form because the same tester typed
    #: "Restart", "Mulai dari awal", then "RestRt" and never got back to the
    #: opening — four failed attempts at the one command the pilot depends on.
    #: "r+e*s+t+a*r+t+" covers restart/restrt/resttart without matching any
    #: real word, and it only ever fires when the command IS the whole message.
    _RESTART_CMD = re.compile(
        r"^\s*[\"'`]*\s*(?:[/!]\s*r+e*s+t+a*r+t+\b"
        r"|r+e*s+t+a*r+t+[\s.!]*$"
        r"|(?:mulai|ulang|start)\s*(?:dari\s*)?(?:awal|ulang)[\s.!]*$)",
        re.IGNORECASE,
    )

    @property
    def _context(self) -> str:
        return getattr(self._ctx, "value", "reply")

    @_context.setter
    def _context(self, value: str) -> None:
        self._ctx.value = value

    def current_reading(self):
        """How the message being handled was read. Empty outside that."""
        return getattr(self._reading_ctx, "value", None) or understanding.Reading()

    def _convo_lock(self, jid: str) -> threading.RLock:
        with self._convo_locks_guard:
            return self._convo_locks.setdefault(jid, threading.RLock())

    def handle_inbound(
        self, jid: str, pushname: str, text: str, sent_at: datetime | None = None
    ) -> None:
        with self._convo_lock(jid):
            self._handle_inbound(jid, pushname, text, sent_at)

    def _handle_inbound(
        self, jid: str, pushname: str, text: str, sent_at: datetime | None = None
    ) -> None:
        # Backlog, not conversation. WhatsApp delivers everything that arrived
        # while the device was offline the moment it reconnects, and nothing
        # in the payload distinguishes that flood from live replies — during
        # the pilot the bot answered a days-old personal exchange as though it
        # had just been typed. A test session reacts only to what testers send
        # during the session.
        if (
            self.cfg.demo_mode
            and sent_at is not None
            and (self.now() - sent_at).total_seconds() > self.cfg.demo_stale_seconds
        ):
            log.info(
                "[demo] ignoring %s message from %s — sent %s, before this session",
                "backlogged",
                jid.split("@")[0],
                sent_at.strftime("%d %b %H:%M"),
            )
            return

        # Backlog outside demo mode: too old to act on, too valuable to drop.
        # The flow would treat it as current — a week-old "nanti aja" arming a
        # follow-up ladder in the present tense — so record it, put it in
        # front of a human, and answer nothing automatically.
        if (
            not self.cfg.demo_mode
            and sent_at is not None
            and (self.now() - sent_at).total_seconds()
            > self.cfg.stale_inbound_hours * 3600
        ):
            convo = self.store.get(jid) or Conversation(jid=jid)
            if pushname and not convo.name:
                convo.name = pushname
            self.store.log_message(jid, "in", text, self.now(), "stale")
            self.store.escalate(
                jid,
                f"message sent {sent_at:%d %b %H:%M}, delivered late — needs a human",
                text,
                self.now(),
            )
            self.store.upsert(convo)
            log.warning(
                "STALE %s — sent %s, older than %dh; escalated, not answered",
                jid.split("@")[0],
                sent_at.strftime("%d %b %H:%M"),
                self.cfg.stale_inbound_hours,
            )
            return

        # A test session runs on a number that may carry real traffic. With
        # AUTO_REPLY on, a stranger who messages it mid-session gets a cold
        # sales pitch from a bot — during the pilot this number received a
        # payment detail from a real contact while the bot was live. In demo
        # mode nobody outside the tester allowlist is answered, or even
        # recorded as a conversation.
        if self.cfg.demo_mode and jid not in self.cfg.restart_jids:
            log.info(
                "[demo] ignoring message from %s — not a listed tester",
                jid.split("@")[0],
            )
            return

        # Stopped by the operator. Record what they said — losing it is the
        # one thing a pause must not do — but run none of the flow: an answer
        # would be refused by `_send` further down while the node had already
        # moved on, so the reply would be dropped rather than deferred. Logged
        # as an ordinary inbound, which is what puts it in front of a human
        # via `unanswered_inbound` at the next start.
        if self.paused:
            convo = self.store.get(jid) or Conversation(jid=jid)
            if pushname and not convo.name:
                convo.name = pushname
            self.store.log_message(jid, "in", text, self.now())
            self.store.upsert(convo)
            log.warning(
                "PAUSED (%s) — recorded but did not answer %s: %r",
                self.pause_reason or "paused",
                jid.split("@")[0],
                (text or "")[:60],
            )
            return

        if self._RESTART_CMD.match(text or ""):
            if jid in self.cfg.restart_jids:
                self._restart(jid, pushname, text)
                return
            # Not a tester. Fall through and treat it as an ordinary message
            # rather than silently re-blasting a real brand contact.
            log.warning("ignoring /restart from %s (not in RESTART_JIDS)", jid)

        now = self.now()
        self._context = "reply"
        convo = self.store.get(jid) or Conversation(jid=jid)
        if pushname and not convo.name:
            convo.name = pushname
        convo.last_inbound_at = now

        # Our own words, forwarded back. Seen live: a contact forwarded the
        # opening to the bot, which read it as a portfolio question and
        # answered with the greeting again. Classifying our own copy is
        # meaningless — whatever the contact meant by it, a human should
        # decide, so record it and stop rather than reply.
        if self._is_own_echo(jid, text):
            self.store.log_message(jid, "in", text, now, "echo")
            self.store.escalate(convo.jid, "forwarded our own message back", text, now)
            self.store.upsert(convo)
            log.warning(
                "ECHO %s — our own message came back; escalated, not answered",
                jid.split("@")[0],
            )
            return

        # A machine on the other end. Checked before classification and before
        # the flow runs, so the node does not advance either: the conversation
        # is left exactly where a human will need to pick it up.
        loop = self._looping_with_a_machine(jid, text, now)
        if loop:
            self.store.log_message(jid, "in", text, now, "loop")
            # One item per episode. An autoresponder answers every time, and
            # a row per canned reply would bury the very inbox this protects.
            first = not self.store.has_open_escalation(convo.jid, self._LOOP_TAG)
            if first:
                self.store.escalate(convo.jid, f"{self._LOOP_TAG}: {loop}", text, now)
            self.store.upsert(convo)
            log.warning(
                "LOOP %s — %s; %s, not answered",
                jid.split("@")[0], loop,
                "escalated" if first else "already escalated",
            )
            return

        # Read the message before deciding anything about it. Claude sees the
        # last few turns, not just this one, and answers the questions the
        # flow keeps getting wrong on its own: is a person typing, is this
        # only politeness, did they hand over an email or a number, did they
        # really pick a meeting time. `understood` is False whenever no model
        # ran — no key, no package, a timeout, unusable JSON — and every
        # branch below then falls back to the rules it used before.
        reading = self.read_message(convo, text, now)
        self._reading_ctx.value = reading

        # "hubungi Pak Jo di +62 878…" — a warm introduction, and the best
        # lead the list will ever get. Read BEFORE the autoresponder check,
        # and that order is the whole fix: the message that hands over a PIC
        # is usually a canned one ("Terima kasih atas ketertarikannya … PIC
        # Digital Marketing kami: Luthfi +62 856…"), and "terima kasih atas
        # ketertarikan" is on the autoresponder marker list. So on 14 Aug the
        # auto branch swallowed the Marimas referral whole — the number was
        # never queued, the thread was never handed over, and the flow walked
        # on to three meeting slots and asked a receptionist for her email.
        # A machine that gives us a number is still giving us the number.
        #
        # The reading decides when there is one: it can tell a PIC's mobile
        # from the brand's own hotline by what the sentence is doing, which no
        # amount of prefix arithmetic can. The regex is the fallback.
        referred = (
            reading.phones if reading.understood
            else self._referred_numbers(text, jid)
        )
        if referred:
            from . import templates

            # Queued before we answer, so "akan segera kami hubungi" is
            # already in motion by the time it is read. The queue is a side
            # effect, though — never the gate. Recognising "I am not your
            # contact" does not depend on a dashboard being reachable, and on
            # a failed POST the old code fell through to the ordinary flow,
            # which is the same wrong conversation by another route.
            added, failed = [], []
            for number in referred:
                queued = False
                if self.on_referral is not None:
                    try:
                        queued = bool(
                            self.on_referral(number, convo.name or convo.brand))
                    except Exception:
                        log.exception(
                            "could not queue the referred number %s", number)
                (added if queued else failed).append(number)

            self.store.log_message(jid, "in", text, now, "referral")
            reason = f"brand memberi nomor lain: {', '.join(referred)}"
            if failed:
                # Say so plainly: nobody is going to call a number that only
                # exists in a log line.
                reason += (f" — belum masuk antrean, mohon ditambahkan manual: "
                           f"{', '.join(failed)}")
            self.store.escalate(convo.jid, reason, text, now)

            self._context = "reply"
            msg = templates.render("REPLY_REFERRAL", convo, self.cfg)
            self._send(convo, msg.text, now, key=msg.key)

            # And then stop. "Hubungi PIC kami di Luthfi" means "I am not your
            # contact" — every further turn is spent on the wrong person. On
            # 14 Aug the bot carried on: it read the sign-off "baik kak good
            # luck yaa" as agreement, offered meeting slots, and then asked a
            # receptionist for her email address. HANDOVER is the existing
            # terminal for "a human owns this now", so later messages are
            # recorded and escalated, never answered.
            self.store.cancel_all(jid)
            convo.node = Node.HANDOVER
            convo.stopped_reason = f"rujukan ke {', '.join(referred)}"
            self.store.upsert(convo)
            log.info("REFERRAL %s -> %s; conversation handed over",
                     jid.split("@")[0],
                     ", ".join(f"{n} queued" for n in added)
                     + ("; " if added and failed else "")
                     + ", ".join(f"{n} NOT queued" for n in failed))
            return

        # "Boleh langsung ke email marketing@… aja ya kak." They have named
        # the channel they want to be sold to on, and it is not this one. The
        # answer is the operator's, 21 Aug 2026: thank them, say the address
        # will be contacted — and stop. What went out instead was three
        # meeting slots followed by "boleh dibantu alamat email-nya?", asked
        # of the brand who had just given us one.
        #
        # Inside the scheduling machine the same address means the opposite —
        # it is the invitee for a meeting already agreed — so that case is
        # left to the flow.
        if reading.email and not flow.books_on_email(convo):
            from . import templates

            convo.email = reading.email
            self.store.log_message(jid, "in", text, now, "kirim_email")
            self.store.escalate(
                convo.jid,
                f"brand minta penawaran dikirim ke {reading.email}", text, now,
            )
            self._context = "reply"
            msg = templates.render("REPLY_EMAIL_PROPOSAL", convo, self.cfg)
            self._send(convo, msg.text, now, key=msg.key)
            self.store.cancel_all(jid)
            convo.node = Node.HANDOVER
            convo.stopped_reason = f"penawaran dikirim ke {reading.email}"
            self.store.upsert(convo)
            log.info("EMAIL %s -> %s; conversation handed over",
                     jid.split("@")[0], reading.email)
            return

        # They have said, in whatever words, that this thread is finished —
        # a bot closing the chat ("percakapan ini akan kami akhiri dalam 5
        # menit kedepan"), a refusal, a redirect. Nothing here is a reply
        # worth sending; a human reads it instead.
        #
        # Deliberately narrow. A model that decides a live conversation is
        # over costs a real lead, so its verdict counts only when the message
        # carries something that ends a thread on its own terms: a machine
        # wrote it, or it hands us somewhere else to go, or it is one of the
        # intents that already end conversations. Ordinary hesitation —
        # "nanti dipelajari", "kami diskusikan dulu" — stays with the flow and
        # keeps its follow-up ladder.
        if self._reading_ends_it(reading):
            self.store.log_message(jid, "in", text, now, "selesai")
            self.store.escalate(
                convo.jid,
                f"brand menutup percakapan: {reading.reason or 'tidak dilanjutkan'}",
                text, now,
            )
            self.store.cancel_all(jid)
            convo.node = Node.HANDOVER
            convo.stopped_reason = reading.reason or "brand menutup percakapan"
            self.store.upsert(convo)
            log.info("END %s — %s; not answered",
                     jid.split("@")[0], reading.reason or "closed")
            return

        # A corporate autoresponder. Checked BEFORE classification, which is
        # the whole point: left to the classifier, "Customer Care … dapat
        # menghubungi" reads as `minta_telepon` and walks the flow to
        # scheduling. Recorded and left alone — a machine has nothing to say
        # that the state machine should act on, and answering it is how the
        # ping-pong starts.
        machine = (
            reading.automated if reading.understood
            else self._looks_automated(text, self.transport_number())
        )
        if machine:
            self.store.log_message(jid, "in", text, now, "auto")
            if not self.store.has_open_escalation(convo.jid, self._LOOP_TAG):
                self.store.escalate(
                    convo.jid,
                    f"{self._LOOP_TAG}: balasan otomatis dari nomor brand — "
                    f"perlu dicek manusia",
                    text, now,
                )
            # One closing card, then silence. The BD team wants the deck left
            # with the switchboard rather than nothing said — but exactly once:
            # answering an autoresponder conversationally is what drew eight
            # replies in twelve minutes on 12 Aug and cost the account. The
            # count of what we have already sent them IS the guard, so no
            # second message can slip out however many times they answer.
            from . import templates

            if self._auto_card_sent(jid):
                log.info("AUTO %s — already carded; staying quiet",
                         jid.split("@")[0])
            else:
                self._context = "reply"
                msg = templates.render("REPLY_AUTORESPONDER", convo, self.cfg)
                if self._send(convo, msg.text, now, key=msg.key):
                    self._send_profile(convo)
                    log.info("AUTO %s — left the deck once and stopped",
                             jid.split("@")[0])
            self.store.upsert(convo)
            return

        # "Baik kak 😊🙏🏻 -sa". They read what we sent; there is nothing in it
        # to answer. The rules called this `ok_lanjut` — agreement — and Kymm
        # Skin got a slot list, then an email request, then the same email
        # request five more times, each one triggered by another polite
        # acknowledgement of the last. Politeness is not interest.
        #
        # Silence here, not a reply: the pending follow-up ladder is left
        # alone, so a real nudge still goes out on its own schedule. A second
        # one in a row means the exchange is going nowhere and a human should
        # look.
        if reading.understood and reading.politeness_only:
            self.store.log_message(jid, "in", text, now, "basa_basi")
            run = self.store.recent_inbound_intents(jid, limit=2)
            if run.count("basa_basi") >= 2 and not self.store.has_open_escalation(
                convo.jid, self._POLITE_TAG
            ):
                self.store.escalate(
                    convo.jid,
                    f"{self._POLITE_TAG}: brand hanya membalas basa-basi, "
                    f"tidak ada keputusan", text, now,
                )
            self.store.upsert(convo)
            log.info("BASA-BASI %s — %s; tidak dijawab",
                     jid.split("@")[0], reading.reason or text[:60])
            return

        # "jasa*" fixing the "kasa" a moment ago. Classified alone it is a
        # fragment; read against the previous turn it is the question the
        # contact meant to ask, so reconsider that instead.
        subject = text
        match = self._CORRECTION_RE.match(text)
        if match and "*" in text:
            merged = self._apply_correction(jid, match.group(1))
            if merged:
                subject = merged
                log.info(
                    "correction %r applied to the previous turn -> %r",
                    text.strip(), merged[:70],
                )

        # The reading has already looked at this message in context; the
        # rules only get the last one, on their own.
        intent = (
            reading.intent if reading.understood and reading.intent is not None
            else intents.classify(subject, self.cfg)
        )
        # "Selasa aja yaa, solnya hari Selasa sy libur kerja" — they picked a
        # day for our meeting. Whatever label the message would otherwise
        # carry, naming a time IS the acceptance, and it has to reach the
        # scheduling branch or the choice is simply dropped: Green Angelica
        # named Tuesday and was answered with who attends our meetings.
        if (
            reading.understood
            and (reading.meeting_day or reading.meeting_hour is not None)
            and intent not in self._NOT_A_BOOKING
        ):
            intent = Intent.SETUJU
        # "Lebih ke sales kak" is the answer to OUR question — but only when
        # we asked it. The rule sees one message and cannot know; the store
        # can. When the last thing we sent did not ask for the focus, the
        # honest label is UNKNOWN and the flow asks what they meant, rather
        # than answering a question of ours that was never put (24 Sep 2026).
        if intent is Intent.FOKUS_CAMPAIGN:
            last_out = self.store.recent_outbound_texts(jid, limit=1)
            if not (last_out and intents.asks_for_focus(last_out[0])):
                log.info("focus answer %r with no focus question before it — unknown", text[:40])
                intent = Intent.UNKNOWN
        self.store.log_message(jid, "in", text, now, intent.value)
        log.info("IN  %s [%s] %s", jid.split("@")[0], intent.value, text[:80])

        self.apply(convo, flow.on_inbound(convo, intent, subject, self.cfg, now))

    #: "jasa*" — the WhatsApp convention for correcting a word in the message
    #: just sent. On its own it means nothing; read against the previous turn
    #: it is that turn, spelled right.
    _CORRECTION_RE = re.compile(r"^\s*\*?([\w'-]{2,})\*?\s*$")

    def _apply_correction(self, jid: str, word: str) -> str:
        """The previous inbound with `word` swapped in, or "" if there is none.

        The correction names the replacement, never the mistake, so the word
        it replaces is found by similarity. Nothing close enough means the
        contact is adding a word rather than fixing one, and it is appended —
        either way the previous turn gets reconsidered instead of a bare
        fragment being classified on its own.
        """
        import difflib

        previous = self.store.last_inbound_text(jid)
        if not previous:
            return ""
        words = previous.split()
        best, score = None, 0.0
        for i, existing in enumerate(words):
            ratio = difflib.SequenceMatcher(
                None, existing.strip(".,?!").lower(), word.lower()
            ).ratio()
            if ratio > score:
                best, score = i, ratio
        if best is not None and score >= 0.5:
            words[best] = word
            return " ".join(words)
        return f"{previous} {word}"

    #: Below this an "echo" is more likely a coincidence than a forward — a
    #: short ack like "baik kak" appears in our own texts too.
    _ECHO_MIN_CHARS = 60

    #: How much a message may add to our own text and still be a forward
    #: rather than a reply. WhatsApp wraps forwards and quotes in a little
    #: decoration; a real question adds more than that.
    _ECHO_EXTRA_CHARS = 30

    def _is_own_echo(self, jid: str, text: str) -> bool:
        """Is this substantially a copy of something we recently sent them?

        Containment rather than equality, because forwards and quotes carry
        decoration around the copied body. The two directions are not
        symmetric: a message *inside* ours is a copy, possibly truncated,
        while a message *containing* ours is only a forward if it adds
        practically nothing — quote one of our lines and ask a question about
        it and that is a real message, which classifies as normal.
        """
        probe = " ".join(text.split()).lower()
        if len(probe) < self._ECHO_MIN_CHARS:
            return False
        for sent in self.store.recent_outbound_texts(jid):
            ours = " ".join(sent.split()).lower()
            if not ours:
                continue
            if probe in ours:
                return True
            if ours in probe and len(probe) - len(ours) <= self._ECHO_EXTRA_CHARS:
                return True
        return False

    #: Below this, a repeated inbound is a human being terse — "ya", "halo",
    #: "ok kak" — not a canned reply. Autoresponders introduce themselves.
    _CANNED_MIN_CHARS = 40

    #: Marks every escalation this guard raises, so a second one for the same
    #: contact can be recognised and skipped while the first is still open.
    _LOOP_TAG = "auto-loop"
    _POLITE_TAG = "basa-basi"

    #: Phrases that only a corporate autoresponder says. Taken from what real
    #: brand numbers actually sent on 13 Aug 2026 — Kino, Indofood, Sosro,
    #: Cimory, Kapal Api, Greenfields — not invented.
    #:
    #: This matters far more than the tracker it feeds. The intent classifier
    #: read "Customer Care PT Kino Indonesia … dapat menghubungi" as
    #: `minta_telepon`, a buying signal, so the flow walked five machines all
    #: the way to `node=scheduling, outcome=acceptance` and started trying to
    #: book meetings with them.
    _AUTO_MARKERS = (
        "terima kasih telah menghubungi", "terima kasih sudah menghubungi",
        # Variants that slipped through on 13 Aug — every one of these is a
        # real brand hotline: Quantum, OFFO, Sanken, Taro, Interlac, Tango,
        # Cerebrofort, Makaroni Ngehe.
        "selamat datang di", "chat akan segera kami respon",
        "akan segera menghubungi anda", "meminta perwakilan untuk merespons",
        "akan dibalas pada jam kerja", "sesi chat sementara kami tutup",
        "dikarenakan tidak ada jawaban", "silakan memilih",
        "silakan pilih salah satu", "silahkan pilih salah satu",
        "pilihan yang anda kirimkan tidak tersedia",
        "belum berhasil menyusun jawaban", "put together an answer",
        "mencari jawaban", "mohon menunggu", "antrian",
        "thank you for reaching out", "selamat datang di layanan",
        "selamat datang di call cent", "customer care", "call centre",
        "call center", "layanan pelanggan", "konsumen yang terhormat",
        "pelanggan yang terhormat", "mohon maaf kami tidak mengerti",
        "silakan pilih menu", "silahkan pilih menu", "kembali ke menu",
        # Short menu prompts: under the length gate, but nobody types these.
        "silakan memilih", "silahkan memilih", "mencari jawaban",
        "belum memilih", "informasi apa yang bisa kami bantu",
        "apa yang bisa kami bantu",
        "pilihan menu", "ketik informasi", "ketik angka", "balas dengan angka",
        "mohon lengkapi informasi", "jam operasional kami",
        "di luar jam operasional",
        # Brand hotlines directing enquiries elsewhere — Greenfields' opener.
        "informasi seputar kerja sama", "silakan mengirimkan proposal",
        # Found by replaying every stored inbound through the rules on
        # 14 Aug: each of these was costing an LLM call AND drawing a reply.
        "pesanmu telah kami terima", "pesan kamu telah kami terima",
        "informasi apa yang bisa kami bantu", "tidak mengerti dengan pertanyaan",
        "semoga pengajuan kerja sama", "welcome to",
        # A second replay after the first round of markers. Each of these is a
        # brand hotline greeting or an AI persona, and each was still costing
        # a call plus a reply.
        "terima kasih atas ketertarikan", "terima kasih atas ketertarikannya",
        "atas tawaran kerjasama", "atas tawaran kerja sama",
        "hai sahabat", "hii ", "halo sahabat",
        "silahkan mengirimkan proposal", "akan terhubung dengan tim",
        "bantu isi data berikut",
        # Our own Google invite bouncing back off a team member's phone.
        "google meet joining info", "video call link:",
    )

    #: Phrases no human types, at any length. The length gate below exists so
    #: a person asking "call center?" is not mistaken for one — but a menu
    #: prompt is three words and still unmistakably a machine.
    _AUTO_STRONG = (
        "konsumen yang terhormat", "pelanggan yang terhormat",
        "mohon sebutkan nama", "informasi apa yang anda butuhkan",
        "silakan pilih menu", "silahkan pilih menu", "kembali ke menu",
        # Short menu prompts: under the length gate, but nobody types these.
        "silakan memilih", "silahkan memilih", "mencari jawaban",
        "belum memilih", "informasi apa yang bisa kami bantu",
        "apa yang bisa kami bantu",
        "pesan ini dikirim otomatis", "balasan otomatis",
        "ketik angka", "balas dengan angka",
        "mengetik angkanya", "ketik angkanya", "balas dengan mengetik",
    )

    #: "Terima kasih ... sudah/telah menghubungi" with anything in between —
    #: brands write "terima kasih banyak sudah menghubungi kami", and a literal
    #: phrase misses on the one inserted word.
    _THANKS_RE = re.compile(
        r"terima kasih[^.!?]{0,24}\b(sudah|telah)\b[^.!?]{0,16}menghubungi")

    #: Two or more numbered options — the shape of a menu, whatever it says.
    _MENU_RE = re.compile(r"(?m)^\s*[*•\-]?\s*\d+[.)]\s*\*?\s*\S")

    #: The same menu written on one line — "select your product: 1 Rumah
    #: Tangga 2 Pencukur elektrik 3 Lainnya". Three or more numbered items in
    #: a row is a keypad, not prose.
    _INLINE_MENU_RE = re.compile(r"(?:\b[1-9]\s+\w[^\d]{2,40}){3,}")

    #: Short enough to be a person typing, even if it trips a phrase.
    _AUTO_MIN_CHARS = 50

    #: An Indonesian mobile in any of the shapes brands actually type:
    #: "+62 878-8496-2002", "0878 8496 2002", "628784962002".
    _PHONE_RE = re.compile(r"(?:\+?62|0)[\s.-]?8\d{1,3}(?:[\s.-]?\d{2,4}){2,4}")

    def _referred_numbers(self, text: str, sender_jid: str) -> list[str]:
        """Other people's numbers a brand has pointed us at.

        Brands routinely answer "hubungi Pak Jo +62 878-8496-2002" — a warm
        introduction, and the best lead in the list. Their own number is
        excluded: plenty of signatures repeat it, and re-adding it would put
        the same contact back in the queue.
        """
        own = sender_jid.split("@")[0].lstrip("+")
        out: list[str] = []
        for raw in self._PHONE_RE.findall(text or ""):
            digits = re.sub(r"\D", "", raw)
            if digits.startswith("0"):
                digits = "62" + digits[1:]
            # 62 + 9-13 more is the real range; anything else is an order
            # number or a price that happens to start with 62.
            if not (11 <= len(digits) <= 15) or not digits.startswith("62"):
                continue
            # An Indonesian MOBILE prefix, specifically: 62 8 followed by
            # 1/2/3/5/7/8/9. This check earns its keep now that a referral is
            # read before the autoresponder branch — switchboards print their
            # own contact details, and "Customer Care 0800-1-234567" (62800…)
            # or a Jakarta landline (021 → 6221…) would otherwise be queued as
            # a warm lead and end a conversation nobody redirected.
            if digits[2:3] != "8" or digits[3:4] not in "1235789":
                continue
            if digits == own or digits in out:
                continue
            out.append(digits)
        return out

    def transport_number(self) -> str:
        """Our own WhatsApp number, or "".

        Used to spot a hotline greeting the number rather than a person —
        "Hai Kak 6281900000001!" is a template with a variable in it.
        """
        raw = getattr(self.transport, "paired_user", "") or ""
        return raw.split(":")[0].split("@")[0]

    def _auto_card_sent(self, jid: str) -> bool:
        """Have we already left our card with this switchboard?

        Asked of the transcript rather than a flag on the conversation: the
        message either went out or it did not, and a flag can drift from that
        after a restart or a rollback. Any outbound text at all counts — if we
        have spoken to this number, the card is spent.
        """
        return bool(self.store.recent_outbound_texts(jid, limit=1))

    #: "Marlina akan mencatat…", "Marlina memahami bahwa Grace…" — an
    #: assistant narrating itself in the third person while addressing us by
    #: name. People do not write about themselves this way; bots with a
    #: persona do it in every turn.
    _PERSONA_RE = re.compile(
        # The persona's name must stay case-SENSITIVE (a capitalised word is
        # what makes it a name), but who it addresses need not be.
        r"\b([A-Z][a-z]{2,12})\s+(akan|juga|telah|sudah|memahami|mencatat|"
        r"senang|siap|tunggu|dapat)\b[^.!?]{0,60}\b(?i:grace|kakak|ibu|bapak)\b",
    )

    def read_message(self, convo, text: str, now: datetime):
        """What this message means, read against the turns before it.

        Thought about once, then remembered. A case the bot has met before —
        the same autoresponder, another "baik kak" after the same question of
        ours — comes back out of the `readings` table without an API call, and
        every new case that carries nothing message-specific is learned on the
        way out. The pilot's traffic is overwhelmingly repeats, so this is most
        of the cost.

        A method rather than a call so a test can hand the engine a fixed
        reading, and so one failure mode — anything at all going wrong in the
        reader — can never keep an inbound message from being answered.
        """
        try:
            last_out = self.store.recent_outbound_texts(convo.jid, limit=1)
            context = understanding.normalize(last_out[0] if last_out else "")[:200]
            normalized = understanding.normalize(text)
            fingerprint = understanding.fingerprint(context, normalized)

            if normalized:
                known = self.store.recall_reading(context, normalized, fingerprint)
                if known is not None:
                    payload, hits = known
                    reading = understanding.from_dict(payload)
                    log.info(
                        "RECALL %s [%s] %s — kasus ke-%d, tanpa panggilan model",
                        convo.jid.split("@")[0],
                        reading.intent.value if reading.intent else "-",
                        reading.reason or normalized[:50], hits,
                    )
                    return reading

            reading = understanding.read(
                self.cfg,
                text,
                self.store.recent_turns(convo.jid, understanding.HISTORY_TURNS),
                brand=convo.brand or convo.name,
                now=now,
            )
            if normalized and reading.understood and reading.reusable():
                self.store.remember_reading(
                    fingerprint, context, normalized, text,
                    understanding.to_dict(reading), reading.automated, now,
                )
                learned, reused = self.store.reading_stats()
                log.info("LEARNED %s — %d kasus tersimpan, %d kali dipakai ulang",
                         normalized[:50], learned, reused)
            return reading
        except Exception:
            log.exception("could not read the message; falling back to rules")
            return understanding.Reading()

    #: Intents that end a conversation on their own terms. The reading's
    #: verdict that a thread is over is only acted on alongside one of these,
    #: or a machine, or a forwarding address/number — a model deciding by
    #: itself that a live lead is finished is the expensive mistake.
    _ENDING_INTENTS = frozenset(
        {Intent.OPT_OUT, Intent.TOLAK_TEGAS, Intent.KIRIM_EMAIL,
         Intent.HUBUNGKAN_PIC}
    )

    #: A named day does not turn these into a meeting: somebody can decline
    #: while mentioning a date ("bulan depan aja kak"), and reading that as
    #: acceptance books a meeting nobody agreed to.
    _NOT_A_BOOKING = frozenset(
        {Intent.OPT_OUT, Intent.TOLAK_TEGAS, Intent.TOLAK_HALUS,
         Intent.NANTI_AJA, Intent.KIRIM_EMAIL, Intent.HUBUNGKAN_PIC}
    )

    def _reading_ends_it(self, reading) -> bool:
        if not (reading.understood and reading.ends_conversation):
            return False
        return bool(
            reading.automated
            or reading.phones
            or reading.email
            or reading.intent in self._ENDING_INTENTS
        )

    def _looks_automated(self, text: str, own_number: str = "") -> bool:
        """Is this a machine talking, rather than somebody at the brand?

        A phrase list alone kept losing: brands word their hotlines
        differently, spell "terimakasih" without the space, and wrap menu
        items in asterisks. So two structural checks carry most of the weight
        and do not care about wording at all —

        * the message greets our own phone number, or "Whatsapp User". Nobody
          at a brand types that; it is a template with a variable in it.
        * it is a numbered menu, however it is decorated.

        Reply latency was measured as a third signal and rejected: real brand
        bots on this list answer with a median of 59 seconds, and only 12%
        inside ten, so it separates nothing.
        """
        raw = text or ""
        probe = " ".join(raw.split()).lower()
        # "Terimakasih" / "terima kasih" are the same word to a reader and to
        # the marker list; collapse it before matching.
        squashed = probe.replace("terimakasih", "terima kasih")

        # Addressed to a placeholder, not a person.
        if "whatsapp user" in squashed:
            return True
        digits = re.sub(r"\D", "", own_number)
        if len(digits) >= 9 and digits in re.sub(r"\D", "", raw):
            return True

        if any(m in squashed for m in self._AUTO_STRONG):
            return True
        # A menu is a menu at any length — "*1. Harga* *2. Katalog*" is 25
        # characters and unmistakable.
        if len(self._MENU_RE.findall(raw)) >= 2:
            return True
        if self._INLINE_MENU_RE.search(probe):
            return True
        if self._THANKS_RE.search(squashed):
            return True
        if self._PERSONA_RE.search(raw):
            return True
        if len(probe) < self._AUTO_MIN_CHARS:
            return False
        return any(m in squashed for m in self._AUTO_MARKERS)

    @staticmethod
    def _same_text(a: str, b: str) -> bool:
        return " ".join((a or "").split()).lower() == " ".join((b or "").split()).lower()

    def _looping_with_a_machine(self, jid: str, text: str, now: datetime) -> str:
        """Are we ping-ponging with an autoresponder? Returns why, or "".

        Three independent nets, because no single one holds:

        * The contact repeated themselves verbatim. This is the autoresponder
          signature — Cimory sent the same "Hai Cimories, chat kakak akan kami
          lanjutkan sesuai jadwal operasional" to every one of our replies. A
          person who repeats a question rephrases it.
        * We are about to repeat ourselves. Independent of what came in: the
          bot sent "Boleh dibantu alamat email-nya?" six times to that same
          number. Saying the identical thing twice in a row is never the right
          move, whatever provoked it.
        * Plain counting. Some autoresponders stamp a ticket number or the
          time into the text, which defeats both checks above — but a machine
          cannot get past a cap on how many messages one contact may draw.

        Detection is separate from what to do about it: every hit escalates
        rather than going quiet, because a brand with an autoresponder is
        still a brand, and a human should read the thread.
        """
        window = now - timedelta(minutes=self.cfg.loop_guard_window_minutes)

        previous = self.store.recent_inbound_texts(jid, limit=1)
        if (
            previous
            and len(" ".join(text.split())) >= self._CANNED_MIN_CHARS
            and self._same_text(text, previous[0])
        ):
            return "contact repeated the same message verbatim — autoresponder"

        recent = self.store.outbound_since(jid, window)
        if recent >= self.cfg.loop_guard_max_replies:
            return (
                f"{recent} messages sent to this contact in "
                f"{self.cfg.loop_guard_window_minutes} min — loop breaker"
            )
        return ""

    def _would_repeat_ourselves(self, jid: str, text: str, now: datetime) -> bool:
        """Is this byte-for-byte what we last told them, just now?

        Bounded by the loop window so a legitimate re-ask days later still
        goes out — it is the immediate repetition that reads as a machine.
        """
        last = self.store.last_outbound(jid)
        if last is None:
            return False
        body, at = last
        if (now - at) > timedelta(minutes=self.cfg.loop_guard_window_minutes):
            return False
        return self._same_text(text, body)

    def _restart(self, jid: str, pushname: str, text: str) -> bool:
        """Wipe a tester's conversation and replay it from the opening.

        A full `Store.reset` — the same thing `simulate --fresh` does — rather
        than only rewinding the node. Leaving the old messages behind would
        feed a stale run's text back into slot detection and reply grounding,
        which reads to a tester as a bot flaw when it is really a dirty
        fixture. The tester's own WhatsApp thread keeps the transcript they
        are grading; nothing they need to review lives only in the database.
        """
        prior = self.store.get(jid)
        name = (prior.name if prior else "") or pushname
        brand = prior.brand if prior else ""
        category = prior.category if prior else ""

        self.store.reset(jid)
        self.store.log_message(jid, "in", text, self.now(), "restart")
        log.info("RESTART %s — conversation wiped, replaying opening", jid.split("@")[0])

        # Sent as a "reply", not a "blast": the tester asked for it in the
        # message we are answering, so it should not sit waiting for the
        # operator's y/n the way real cold outreach must. The RESTART_JIDS
        # allowlist is what keeps this from becoming a blasting route.
        return self.blast(jid, name=name, brand=brand, category=category, context="reply")

    #: Timers that must fire regardless of the sending window — either they
    #: send nothing, or they are time-critical.
    _WINDOW_EXEMPT = frozenset({Timer.DECAY_STOP, Timer.MEETING_END, Timer.REMINDER})

    def handle_timer(
        self, job_id: int, jid: str, timer: Timer, payload: dict | None = None
    ) -> None:
        now = self.now()
        payload = payload or {}
        wait_label = payload.get("wait_label", "")
        convo = self.store.get(jid)
        if convo is None:
            self.store.mark_fired(job_id)
            return

        # Demo only: hold the ladder while the conversation is still warm —
        # measured on the last message either way, not just theirs.
        #
        # Every delay this mode collapses means "they went quiet on us". Two
        # ways that goes wrong live, both seen in the pilot: a tester typing a
        # reply takes longer than the compressed gap and gets chased
        # mid-sentence; and a tester who has not replied *at all* has no
        # inbound to measure, so the whole ladder empties onto them — opening
        # plus three follow-ups inside ninety seconds. Timing from our own
        # last message covers the second: each rung then waits for a real
        # chance to answer, which is what the delay means in production.
        last_activity = max(
            filter(None, (convo.last_inbound_at, convo.last_outbound_at)),
            default=None,
        )
        if (
            self.cfg.demo_mode
            and last_activity
            and (now - last_activity).total_seconds() < self.cfg.demo_idle_seconds
        ):
            self.store.mark_fired(job_id)
            self.store.schedule(
                jid,
                timer,
                now + timedelta(seconds=self.cfg.demo_gap_seconds),
                **payload,
            )
            log.info(
                "[demo] %s still talking; holding %s",
                jid.split("@")[0],
                timer.value,
            )
            return

        # Proactive follow-ups respect business hours (FLOWCHART.md §6.6).
        # Re-queue rather than dropping, so the ladder keeps its shape.
        # A demo session runs whenever the testers are free, so re-queueing to
        # tomorrow morning would just end the test — the window is the one
        # guardrail demo mode drops.
        if (
            timer not in self._WINDOW_EXEMPT
            and not self.cfg.demo_mode
            and not self.within_send_window(now)
        ):
            when = self._next_window_open(now)
            self.store.mark_fired(job_id)
            self.store.schedule(jid, timer, when)
            log.info(
                "outside send window; re-queued %s for %s -> %s",
                timer.value,
                jid.split("@")[0],
                when,
            )
            return

        self.store.mark_fired(job_id)
        self._context = "timer"
        log.info("TIMER %s %s", jid.split("@")[0], timer.value)
        result = flow.on_timer(convo, timer, self.cfg, now)
        # Before the follow-up itself, tell the tester which wait was skipped
        # — otherwise a ladder that really spans a week reads as the bot
        # spamming four messages in a minute. Silent timers (meeting end,
        # decay-to-stop) get no marker: a jump announcing nothing would read
        # as a message that failed to arrive.
        if self.cfg.demo_mode and wait_label and any(
            isinstance(a, Send) for a in result.actions
        ):
            self._send_marker(jid, wait_label)
        self.apply(convo, result)

    def blast(
        self,
        jid: str,
        name: str = "",
        brand: str = "",
        category: str = "",
        *,
        context: str = "blast",
    ) -> bool:
        """Send the opening message. True only if it actually went out.

        `context` is the approval class (see `_approved`); only `_restart`
        overrides it, because a tester-requested replay is an answer to an
        inbound message, not unsolicited outreach.
        """
        now = self.now()
        self._context = context
        convo = self.store.get(jid) or Conversation(jid=jid)

        # Never-contact list, checked again at the last possible moment. The
        # outreach loop screens rows before they get here, but a blast can also
        # arrive from the command line or a /restart, and "we asked you not to
        # contact them" is not a mistake worth making twice.
        blocked = self.cfg.is_blocked(name, brand, convo.name, convo.brand, jid)
        if blocked:
            log.warning(
                "BLOCKED %s — %r is on the do-not-contact list; not blasting",
                jid.split("@")[0], blocked,
            )
            return False

        if convo.node is not Node.NEW:
            log.warning("%s already in flow (%s); skipping", jid, convo.node)
            return False
        convo.name = name or convo.name
        convo.brand = brand or convo.brand
        convo.category = category or convo.category
        was = (convo.node, convo.outcome)
        before = self._sends
        self.apply(convo, flow.on_blast(convo, self.cfg, now))
        if self._sends > before:
            return True

        # The opening never left — declined at the prompt, capped, paused, or
        # the socket was down. `apply` still ran SetNode and Schedule, which
        # leaves the contact looking blasted: the retry is then refused as
        # "already in flow", and the armed COLD_FU1 later chases someone who
        # was never greeted. Both stale conversations found during the pilot
        # got there this way. Put it back the way it was found.
        self.store.cancel_all(jid)
        convo.node, convo.outcome = was
        self.store.upsert(convo)
        log.warning(
            "opening not delivered to %s — conversation left unblasted so it "
            "can be retried", jid.split("@")[0]
        )
        return False

    def preview_blast(self, convo: Conversation) -> str:
        """Render the opening message without sending, storing, or scheduling.

        `blast` in dry-run mode still advances the conversation to BLASTED and
        arms the cold ladder — which is what the simulator wants, but not what a
        campaign preview wants: previewing a batch would quietly consume it.
        This is the read-only path.
        """
        result = flow.on_blast(convo, self.cfg, self.now())
        return "\n".join(
            self._compose(convo, action.message)
            for action in result.actions
            if isinstance(action, Send)
        )

    def tick(self) -> int:
        """Fire all due timers. Returns how many fired.

        Live sends inside the drain are paced by `_throttle`, so a backlog
        after downtime drips out at MIN_SECONDS_BETWEEN_SENDS instead of
        machine-gunning (ROADMAP 3.1). Also posts the daily escalation
        digest at window open (ROADMAP 3.5).

        A paused bot fires nothing. Draining the queue into a muted `_send`
        would mark every due job fired and advance the conversation past a
        follow-up the brand never received — see `pause`.
        """
        if self.paused:
            return 0
        now = self.now()
        self._maybe_send_digest(now)
        due = self.store.due(now)
        for job in due:
            assert job.id is not None
            self.handle_timer(job.id, job.jid, job.timer, job.payload)
        return len(due)

    def _maybe_send_digest(self, now: datetime) -> None:
        """Once per day, at window open: list escalations past their SLA."""
        if not self.within_send_window(now):
            return
        today = now.date().isoformat()
        if self.store.get_meta("digest_date") == today:
            return
        self.store.set_meta("digest_date", today)

        sla = self.cfg.escalation_sla_hours
        stale = [
            r
            for r in self.store.open_escalations()
            if business_hours_between(
                datetime.fromisoformat(r["at"]), now, self.cfg
            ) > sla
        ]
        if not stale:
            return
        lines = [
            f"⏰ {len(stale)} escalation(s) past the {sla} business-hour SLA:"
        ]
        for r in stale[:10]:
            lines.append(
                f"  [{r['id']}] {r['at'][:16]}  {r['jid'].split('@')[0]}  "
                f"{r['reason'][:60]}"
            )
        lines.append("Resolve with: python -m bd_bot resolve <id>")
        self.alert("\n".join(lines))


#: Category wordings seen in the brand lists, mapped to the folder that
#: holds their case studies. The CSV is filled in by hand, so "F&B", "f & b",
#: "Food & Beverage" and "kuliner" all arrive meaning the same thing — folder
#: names cannot track that, and an unmatched category silently sends nothing.
_CATEGORY_ALIASES: dict[str, str] = {
    "skincare": "beauty", "make up": "beauty", "makeup": "beauty",
    "kosmetik": "beauty", "cosmetic": "beauty", "cosmetics": "beauty",
    "personal care": "beauty", "kecantikan": "beauty",
    "f b": "fnb", "food": "fnb", "food beverage": "fnb", "beverage": "fnb",
    "makanan": "fnb", "minuman": "fnb", "snack": "fnb", "kuliner": "fnb",
    "mom kids": "mom-kids", "ibu anak": "mom-kids", "baby": "mom-kids",
    "bayi": "mom-kids", "mainan": "mom-kids", "toys": "mom-kids",
    "home living": "home-living", "furniture": "home-living",
    "peralatan rumah": "home-living", "dekorasi": "home-living",
    "home": "home-living", "rumah tangga": "home-living",
    "apparel": "fashion", "hijab": "fashion", "sepatu": "fashion",
    "tas": "fashion", "baju": "fashion", "pakaian": "fashion",
    "supplement": "health", "suplemen": "health", "herbal": "health",
    "vitamin": "health", "kesehatan": "health", "obat": "health",
}


def _category_slug(category: str) -> str:
    """A contact's category -> the case-study folder that serves it.

    Punctuation and spacing are flattened first, so "F&B", "f & b" and "F  B"
    all reduce to the same key. Returns "" when there is nothing to match,
    which the caller reads as "send no attachment" — never as a wrong folder.
    """
    flat = re.sub(r"[^a-z0-9]+", " ", category.strip().lower()).strip()
    if not flat:
        return ""
    if flat in _CATEGORY_ALIASES:
        return _CATEGORY_ALIASES[flat]
    return flat.replace(" ", "-")


def _wait_label(delay: timedelta) -> str:
    """Name a skipped wait the way a person would: "1 hari kemudian".

    Rounded to the unit that reads naturally rather than reported exactly —
    the marker is there to tell a tester "time passed here, this much", and
    "1 hari kemudian" carries that where "23 jam 47 menit kemudian" does not.
    """
    seconds = delay.total_seconds()
    if seconds < 60:
        return ""
    minutes = round(seconds / 60)
    if minutes < 60:
        return f"{minutes} menit kemudian"
    hours = round(minutes / 60)
    if hours < 24:
        return f"{hours} jam kemudian"
    return f"{round(hours / 24)} hari kemudian"


def _burst_chunks(text: str, max_chunks: int = 3) -> list[str]:
    """Split a long message into ≤3 shorter ones at paragraph boundaries.

    ≤2 paragraphs stay as one message. More get grouped into contiguous,
    roughly length-balanced chunks — order preserved, nothing reworded.
    """
    paras = [p for p in text.split("\n\n") if p.strip()]
    if len(paras) <= 2:
        return [text]

    n_chunks = min(max_chunks, len(paras))
    target = sum(len(p) for p in paras) / n_chunks
    chunks: list[list[str]] = [[]]
    size = 0.0
    for para in paras:
        remaining_chunks = n_chunks - len(chunks)
        remaining_paras = len(paras) - sum(len(c) for c in chunks)
        # Start a new chunk when this one is full — but never leave more
        # chunks open than there are paragraphs left to fill them.
        if chunks[-1] and size >= target and remaining_chunks >= 1 and remaining_paras >= 1:
            chunks.append([])
            size = 0.0
        chunks[-1].append(para)
        size += len(para)
    return ["\n\n".join(c) for c in chunks]


def _spread_slots(slots: list[datetime], count: int = 3) -> list[datetime]:
    """Pick up to `count` slots to propose, preferring distinct days —
    "besok jam 10 atau Jumat jam 13" gives a real choice, two hours on the
    same morning does not.

    Three rather than two: the window is Senin–Sabtu 09.00–19.00, so two
    options read as the only times we have. The template says the window out
    loud alongside these, and invites the brand to name their own hour."""
    if not slots:
        return []
    picked = [slots[0]]
    for slot in slots[1:]:
        if len(picked) >= count:
            break
        if slot.date() != picked[-1].date():
            picked.append(slot)
    # Top up to `count` from whatever is left, in order: when everything
    # free is on one day, three times that day beats offering only one.
    for slot in slots[1:]:
        if len(picked) >= count:
            break
        if slot not in picked:
            picked.append(slot)
    return sorted(picked)


def business_hours_between(start: datetime, end: datetime, cfg: Settings) -> float:
    """Hours between `start` and `end` that fall inside the sending window.

    Half-hour resolution — plenty for a 4-hour SLA. Spans beyond 30 days
    short-circuit: that escalation is stale beyond argument."""
    if end <= start:
        return 0.0
    if (end - start).days > 30:
        return 24.0 * 30

    step = timedelta(minutes=30)
    total = 0.0
    cur = start
    while cur < end:
        if cfg.within_window(cur):
            total += 0.5
        cur += step
    return total


def _personalise(
    text: str, *, old_name: str, old_brand: str, new_name: str, new_brand: str
) -> str:
    """Swap the name/brand baked into a cached reply for this contact's.

    The brand goes first: a brand like "Cika Beauty" may contain the old name,
    and replacing the name first would corrupt it. Whole-word matches only, so
    a short name can't rewrite the middle of another word.
    """
    for old, new in ((old_brand, new_brand), (old_name, new_name)):
        if old and old != new:
            text = re.sub(rf"\b{re.escape(old)}\b", new, text)
    return text


_TIME_RE = re.compile(r"\b([01]?\d|2[0-3])(?:[.:](\d{2}))?\b")

_HARI = ("Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu")


def _fmt_slot(s: datetime) -> str:
    return f"{_HARI[s.weekday()]} {s:%d/%m} jam {s:%H.%M}"


def _free_ranges(slots: list[datetime], days: int = 3, slot_hours: int = 1) -> str:
    """Free time stated as spans per day, not as a handful of single hours.

    The calendar is mostly empty, so picking one hour out of each free day
    ("Kamis 30/07 jam 09.00") reads as though that is the only time we have —
    and offering 09.00 twice in a row reads as a machine. A brand needs to
    know the shape of the week to pick a time that suits them, so contiguous
    hours are collapsed into "Kamis 30/07 jam 09.00-19.00" and the end is the
    end of the last bookable slot, not its start.
    """
    if not slots:
        return ""
    by_day: dict[object, list[datetime]] = {}
    for slot in sorted(slots):
        by_day.setdefault(slot.date(), []).append(slot)

    parts: list[str] = []
    for day in sorted(by_day)[:days]:
        hours = by_day[day]
        runs: list[list[datetime]] = [[hours[0]]]
        for slot in hours[1:]:
            if slot.hour == runs[-1][-1].hour + slot_hours:
                runs[-1].append(slot)
            else:
                runs.append([slot])
        spans = ", ".join(
            f"{run[0]:%H.%M}-{run[-1].hour + slot_hours:02d}.00"
            if len(run) > 1
            else f"{run[0]:%H.%M}"
            for run in runs
        )
        parts.append(f"{_HARI[day.weekday()]} {day:%d/%m} jam {spans}")
    return " • ".join(parts)


def _day_label(day) -> str:
    return f"{_HARI[day.weekday()]} {day:%d/%m}"


#: Times of day, as hours a brand would accept. Boundaries follow ordinary
#: usage, and the prayer times are the ones people actually schedule around.
_TIME_OF_DAY = {
    "pagi": (9, 10, 11),
    "siang": (12, 13),
    "sore": (15, 16, 17),
    "malam": (18, 19),
    "malem": (18, 19),
    "subuh": (9,),
    "dzuhur": (12, 13),
    "zuhur": (12, 13),
    "ashar": (16, 17),
    "ashr": (16, 17),
    "maghrib": (18, 19),
    "magrib": (18, 19),
    "isya": (19,),
    "makan siang": (13, 14),
    "lunch": (13, 14),
    "jam makan": (13, 14),
}

#: "jam setengah 3" is 14.30 — half an hour BEFORE three, not after. The
#: digit in the text is one greater than the hour, so a parser that reads the
#: number after "jam" books an hour late. "jam 3 kurang" is the same trap.
_HALF_PAST_RE = re.compile(r"\b(setengah|stgh|1/2)\s*(\d{1,2})\b")
_ALMOST_RE = re.compile(r"\bjam\s*(\d{1,2})\s*kurang\b")


def _requested_hours(reply: str, window_start: int) -> set[int]:
    """Hours the contact asked for.

    "jam 13" / "13.00" -> {13}. "jam 2" means 14.00 — a small hour inside a
    09–19 window is afternoon shorthand, so both readings are kept and matched
    against what is actually free. "setengah 3" is 14.30, and "besok pagi" is
    a range rather than a point.
    """
    if not reply:
        return set()
    low = reply.lower()

    # Half-hours first, and remove them so the digit is not read again as an
    # hour: "setengah 3" must not also yield 3.
    hours: set[int] = set()
    for m in _HALF_PAST_RE.finditer(low):
        hours.add(int(m.group(2)) - 1)
    for m in _ALMOST_RE.finditer(low):
        hours.add(int(m.group(1)) - 1)
    low_clean = _ALMOST_RE.sub(" ", _HALF_PAST_RE.sub(" ", low))

    # Spans expand to every hour inside them.
    for m in _HOUR_SPAN_RE.finditer(low_clean):
        a, b = int(m.group(1)), int(m.group(2))
        if a < window_start and a + 12 <= 23:
            a += 12
        if b < window_start and b + 12 <= 23:
            b += 12
        if a <= b <= a + 12:
            hours |= set(range(a, b + 1))
    # Open-ended bounds. Each match is consumed so the bound's own digit is
    # not scanned again as a plain hour — "sebelum jam 11" must not also
    # yield 11 — and so "paling telat mulai jam 2" is read once, as an upper
    # bound, rather than also as "from 2 onward".
    spanned = bool(hours)
    if not spanned:
        for m in _BEFORE_HOUR_RE.finditer(low_clean):
            end = int(m.group(2) or m.group(3))
            if end < window_start and end + 12 <= 23:
                end += 12
            # "sebelum jam 11" stops before 11; "paling telat jam 2" includes it.
            inclusive = m.group(3) is not None
            hours |= set(range(window_start, end + (1 if inclusive else 0)))
        low_clean = _BEFORE_HOUR_RE.sub(" ", low_clean)

        for m in _AFTER_HOUR_RE.finditer(low_clean):
            start = int(m.group(2) or m.group(3))
            if start < window_start and start + 12 <= 23:
                start += 12
            hours |= set(range(start, 19))
        low_clean = _AFTER_HOUR_RE.sub(" ", low_clean)

    hours |= {int(m.group(1)) for m in _TIME_RE.finditer(low_clean)}
    # "jam 2" in a 09-19 window means 14.00. Keep the afternoon reading and
    # drop the morning one: 02.00 can never be booked, so carrying it only
    # muddies what the contact asked for.
    shifted = {h + 12 for h in hours if h < window_start and h + 12 <= 23}
    hours = {h for h in hours if h >= window_start} | shifted

    # A time of day, when no clock time was given. "besok pagi bisa kak?" is
    # a real answer that produced no hour at all before this. Longest phrase
    # wins, so "sehabis makan siang" is 13-14 and not also "siang" 12-13.
    if not hours:
        matched_span = False
        for word in sorted(_TIME_OF_DAY, key=len, reverse=True):
            m = re.search(rf"\b{re.escape(word)}\w*\b", low)
            if not m:
                continue
            if matched_span and " " not in word:
                continue
            # "asal jangan pagi", "pagi aku gabisa", "jangan siang2" name a
            # time only to refuse it. Offering it back is the same rudeness
            # as proposing a day they just ruled out.
            if _time_is_refused(low, m.start(), m.end()):
                continue
            # "sorean"/"siangan" carry their own marking — a greeting is
            # never written that way, so the suffix settles it and position
            # does not matter. Otherwise "siang, saya interested kak" opens
            # with the hello, and a bare time word needs a scheduling cue
            # somewhere before it counts as a request.
            suffixed = bool(
                re.match(rf"{re.escape(word)}(an|nya)\b", low[m.start():])
            )
            if not suffixed:
                if _time_is_greeting(low, m.start()):
                    continue
                if not _TIME_CUE_RE.search(low):
                    continue
            hours |= set(_TIME_OF_DAY[word])
            matched_span = matched_span or " " in word
    return hours


#: A time of day only counts as a REQUEST when something marks it as one.
#: "siang" is overwhelmingly the greeting — "siang, saya interested kak" was
#: read as asking for 12.00-13.00, and the bot confirmed a slot in that range
#: to someone who had named no time at all.
_TIME_CUE_RE = re.compile(
    r"\b(jam|nanti|ntar|abis|habis|sehabis|setelah|pas|sekitar|sekitaran"
    r"|bisa|bisanya|available|free|kosong|slot|jadwal|meeting|ketemu|mulai"
    r"|prefer|maunya|enaknya)\b"
)
#: A greeting sits at the front, on its own or behind "selamat"/"met".
_GREETING_POSITION_RE = re.compile(
    r"^\s*(selamat\s+|met\s+|halo[, ]+|hai[, ]+|hi[, ]+)?$"
)


def _time_is_greeting(low: str, start: int) -> bool:
    """Is this time word the hello rather than a request?"""
    return bool(_GREETING_POSITION_RE.match(low[:start]))


#: A refusal attached to a time of day, on either side.
_TIME_REFUSAL_RE = re.compile(
    r"\b(jangan|jgn|bukan|kecuali|selain|asal jangan|hindari)\b"
    r"|\b(ga|gak|gk|nggak|engga|tidak|tdk|blm|belum)\s*(bisa|bs|sempat|sempet|free)\b"
    r"|\b(gabisa|gbs|gbisa|gakbisa)\b"
)


def _time_is_refused(low: str, start: int, end: int) -> bool:
    """Is this time of day named only to rule it out?

    Looks both ways, like the day version: "jangan pagi" and "pagi aku gabisa"
    say the same thing.
    """
    before = low[max(0, start - 22):start]
    after = low[end:end + 22]
    return bool(_TIME_REFUSAL_RE.search(before) or _TIME_REFUSAL_RE.search(after))


_WEEKDAY_NAMES = {
    "senin": 0,
    "selasa": 1,
    "rabu": 2,
    "kamis": 3,
    "jumat": 4,
    "jum'at": 4,
    "sabtu": 5,
    "minggu": 6,
    "ahad": 6,
}

_RELATIVE_DAYS = {
    "hari ini": 0, "besok lusa": 2, "besok": 1, "bsk": 1, "bsok": 1,
    "lusa": 2, "hr ini": 0,
    # "ntar sore", "nanti siang", "malem ini" — later today.
    "ntar": 0, "nanti siang": 0, "nanti sore": 0, "nanti malam": 0,
    "malem ini": 0, "malam ini": 0, "siang ini": 0, "sore ini": 0,
}

#: A negation just before a day name excludes that day: "ga available hari
#: ini", "belum bisa besok".
_NEGATION_RE = re.compile(
    r"\b(ga|gak|gk|nggak|engga|enggak|tidak|tdk|belum|blm|bukan|kecuali|selain)\b"
    # Written solid, as they usually are: "gabisa hari ini", "gbs besok".
    r"|\b(ga|gk|gak|nggak|blm|belum|tdk|tidak)(bisa|bs|isa|available)\b"
    r"|\bgbs\b|\bgbisa\b|\bgakbisa\b"
    # Said without a negation word at all: "hari ini penuh", "besok aku full".
    r"|\b(penuh|full|packed|padat|sibuk|booked)\b"
)

#: Only these count when the refusal comes AFTER the day. A bare "ga" there is
#: usually the question particle — "besok bisa ga ya?" is asking, not refusing
#: — so the loose forms are excluded in that direction.
_AFTER_NEGATION_RE = re.compile(
    r"\b(gbs|gbisa|gabisa|gakbisa|ga bisa|gak bisa|blm bisa|belum bisa"
    r"|penuh|full|packed|padat|sibuk|booked|libur|off)\b"
)
#: …but only up to the next pivot. In "ga available hari ini mungkin lusa"
#: the negation owns "hari ini" and stops at "mungkin", leaving "lusa" as the
#: day actually being offered.
#: Any day mention, used to tell whether a negation has already been spent
#: on an earlier day in the same breath.
#: "minggu depan", "pekan depan", "next week" — said before a weekday name
#: it moves that weekday into the following week.
_NEXT_WEEK_RE = re.compile(r"\b(minggu|pekan) (depan|dpn)\b|\bnext week\b")

_DAY_MENTION_RE = re.compile(
    r"\b(hari ini|besok|bsk|lusa|senin|selasa|rabu|kamis|jumat|sabtu|minggu)\b"
)

_DAY_PIVOT_RE = re.compile(r"\b(mungkin|tapi|tp|atau|kalau|kalo|klo|kl|klu|gimana|gmn)\b|[,;?]")

_DDMM_RE = re.compile(r"\b(\d{1,2})[/-](\d{1,2})\b")
_TANGGAL_RE = re.compile(r"\b(?:tanggal|tgl)\s+(\d{1,2})\b")

#: A span of clock times — "13.00-15.00", "13:00 – 15:00". Split before the
#: date stripper runs, or it reads the "00-15" in the middle as a day/month
#: and leaves "jam 13. .00" behind. Seen live: a contact offering
#: "jam 13.00-15.00" was booked at 12.00, an hour they never mentioned.
_TIME_RANGE_RE = re.compile(
    r"\b(\d{1,2}[.:]\d{2})\s*[-–—]\s*(\d{1,2}[.:]\d{2})\b"
    # Bare-hour spans too: "jam 9-11 aku free" resolved to 9 November,
    # because to the date stripper "9-11" is a day and a month.
    r"|\bjam\s*(\d{1,2})\s*[-–—]\s*(\d{1,2})\b"
)

#: Every hour in a stated span, not just its ends. "dari jam 10 sampe 12"
#: means 10, 11 and 12 — offering only the ends loses the middle of it.
_HOUR_SPAN_RE = re.compile(
    r"\b(?:jam\s*)?(\d{1,2})(?:[.:]\d{2})?\s*"
    r"(?:[-–—]|sampe|sampai|s/d|sd|hingga)\s*"
    r"(?:jam\s*)?(\d{1,2})(?:[.:]\d{2})?\b"
)

#: Open-ended: "abis jam 4" is 16 onward, "sebelum jam 11" is up to 11.
_AFTER_HOUR_RE = re.compile(
    r"\b(abis|habis|setelah|after|mulai|dari)\s*jam\s*(\d{1,2})\b"
    # "jam 3 ke atas bebas" — the bound trails the hour instead of leading it.
    r"|\bjam\s*(\d{1,2})\s*(?:ke\s*atas|keatas|onwards?|dst)\b"
)
_BEFORE_HOUR_RE = re.compile(
    r"\b(sebelum|sblm|before)\s*jam\s*(\d{1,2})\b"
    # "paling telat mulai jam 2" — start by 2 at the latest.
    r"|\b(?:paling telat|maks|maksimal|paling lambat)\s*(?:mulai\s*)?jam\s*(\d{1,2})\b"
)

#: Dates written with a month name — "31 juli", "3 agustus". Without these the
#: day number was read as an hour: "3 agustus" yielded 15.00.
_MONTHS = {
    "januari": 1, "februari": 2, "maret": 3, "april": 4, "mei": 5, "juni": 6,
    "juli": 7, "agustus": 8, "september": 9, "oktober": 10, "november": 11,
    "desember": 12, "jan": 1, "feb": 2, "mar": 3, "apr": 4, "jun": 6,
    "jul": 7, "agu": 8, "sep": 9, "okt": 10, "nov": 11, "des": 12,
}
_DATE_WORD_RE = re.compile(r"\b(\d{1,2})\s+(" + "|".join(_MONTHS) + r")\b")


def _strip_dates(text: str) -> str:
    """Remove date expressions so they cannot be misread as clock times.

    "tgl 1 aja" yielded hour 13 and "3 agustus" yielded 15 — the day number
    read as a time. Time ranges are protected first, since "jam 9-11" looks
    exactly like a date to the stripper.
    """
    protected = _TIME_RANGE_RE.sub(
        lambda m: " sampai ".join(g for g in m.groups() if g), text
    )
    return _DATE_WORD_RE.sub(
        " ", _DDMM_RE.sub(" ", _TANGGAL_RE.sub(" ", protected))
    )


def _day_in_context(texts: list[str], now: datetime):
    """The day being asked for, read across the recent turns.

    A brand sets the week in one message and names the weekday in the next:

        "kalau minggu depan apakah bisa?"
        "kamis jam 14.00 ya kak"

    Taken message by message, "minggu depan" carries no day of its own and is
    discarded, so the bare "kamis" resolves to tomorrow — the bot confirmed
    Kamis 30/07 for someone who had just said next week. The week qualifier
    is therefore carried forward onto a later bare weekday.

    Only onto a *weekday*: if they follow up with "besok" or "hari ini" they
    have changed their mind to something explicitly near, and that wins.
    """
    for text in texts:
        day = _requested_day(text, now)
        if day is None:
            continue
        # An explicitly-near day, or one already resolved as next week, stands.
        low = text.lower()
        names_weekday = any(n in low for n in _WEEKDAY_NAMES)
        says_near = any(p in low for p in ("besok", "bsk", "lusa", "hari ini", "hr ini"))
        if not names_weekday or says_near or _NEXT_WEEK_RE.search(low):
            return day
        # A bare weekday: honour a week qualifier from an earlier turn.
        for earlier in texts:
            if earlier is text:
                continue
            if _NEXT_WEEK_RE.search(earlier.lower()):
                monday_next = now.date() + timedelta(days=7 - now.weekday())
                wd = next(w for n, w in _WEEKDAY_NAMES.items() if n in low)
                return monday_next + timedelta(days=wd)
        return day
    return None


def _excluded_days(reply: str, now: datetime) -> set:
    """Days the contact said will not work — the mirror of `_requested_day`.

    Offering a slot on a day someone has just ruled out is the rudest thing
    the scheduler can do, and it happened live: "aku gabisa hari ini" was
    answered with today among the three options.
    """
    if not reply:
        return set()
    raw = reply.lower()
    low = re.sub(r"minggu\s+(depan|ini|lalu)", " ", raw)
    out: set = set()

    # A week named rather than a day. "ga available minggu ini" and "maunya
    # minggu depan" both mean the same thing for scheduling: nothing before
    # next Monday. Neither resolves to a day, so nothing was excluded and the
    # bot kept offering today.
    wants_next_week = _NEXT_WEEK_RE.search(raw)
    rules_out_this_week = re.search(
        r"\b(ga|gak|gk|nggak|engga|tidak|tdk|blm|belum|penuh|full|padat|sibuk)\b"
        r"[^.?!]{0,24}\b(minggu|pekan) ini\b"
        r"|\b(minggu|pekan) ini\b[^.?!]{0,24}"
        r"\b(ga|gak|nggak|engga|tidak|penuh|full|padat|sibuk|kosong)\b",
        raw,
    )
    if wants_next_week or rules_out_this_week:
        for offset in range(0, 7 - now.weekday()):
            out.add((now + timedelta(days=offset)).date())
    for phrase, offset in _RELATIVE_DAYS.items():
        pos = low.find(phrase)
        if pos >= 0 and _day_is_ruled_out(low, pos):
            out.add((now + timedelta(days=offset)).date())
    for name, wd in _WEEKDAY_NAMES.items():
        pos = low.find(name)
        if pos >= 0 and _day_is_ruled_out(low, pos):
            out.add((now + timedelta(days=(wd - now.weekday()) % 7)).date())
    return out


def _day_is_ruled_out(low: str, at: int) -> bool:
    """Is the day at `at` named only to say it will not work?

    Looks both ways. Indonesian puts the refusal on either side — "gbs hari
    ini" and "hari ini penuh" say the same thing — and reading only leftward
    let "besok gbs, lusa ya" resolve to tomorrow, the day being refused.

    A negation rules out the FIRST day named after it and nothing further:
    "gbs hari ini besok aja" excludes today and offers tomorrow, and "ga
    available hari ini mungkin lusa" excludes today and offers Friday. A pivot
    ("mungkin", "kalau", a comma) hands the day back, and another day mention
    in between means the negation has already been spent.
    """
    for m in _NEGATION_RE.finditer(low):
        # Negation before the day: "gbs hari ini".
        if 0 <= at - m.end() <= 34:
            between = low[m.end():at]
            if not _DAY_PIVOT_RE.search(between) and not _DAY_MENTION_RE.search(
                between
            ):
                return True
    # Refusal after the day: "besok gbs", "hari ini penuh". Short reach, and
    # only the explicit forms — see _AFTER_NEGATION_RE.
    for m in _AFTER_NEGATION_RE.finditer(low):
        if 0 <= m.start() - at <= 18:
            between = low[at:m.start()]
            if not _DAY_PIVOT_RE.search(between) and not _DAY_MENTION_RE.search(
                between[1:]
            ):
                return True
    return False


def _requested_day(reply: str, now: datetime):
    """The day the contact asked for, or None.

    Understands "hari ini" / "besok" / "lusa", weekday names ("jumat" -> the
    next Friday, today included), "tanggal 25", and "25/7". When several
    appear, the earliest match in the text wins — `reply` is newest-message-
    first, so that is the most recent thing they said.
    """
    if not reply:
        return None
    low = reply.lower()
    # Where "next week" was said, before the mask below removes it.
    next_week = [m.start() for m in _NEXT_WEEK_RE.finditer(low)]
    # "minggu depan/ini/lalu" means "week", not Sunday — mask it out.
    low = re.sub(r"minggu\s+(depan|ini|lalu)", " ", low)

    candidates: list[tuple[int, "datetime.date"]] = []

    def _ruled_out(at: int) -> bool:
        return _day_is_ruled_out(low, at)

    for phrase, offset in _RELATIVE_DAYS.items():
        pos = low.find(phrase)
        if pos >= 0 and not _ruled_out(pos):
            candidates.append((pos, (now + timedelta(days=offset)).date()))

    for name, wd in _WEEKDAY_NAMES.items():
        pos = low.find(name)
        if pos >= 0 and _ruled_out(pos):
            continue
        if pos >= 0:
            # "minggu depan" may sit on either side: "minggu depan hari rabu"
            # and "rabu minggu depan" mean the same thing.
            near_next_week = any(abs(pos - at) <= 30 for at in next_week)
            followed_by_depan = re.match(
                r"\s*(depan|dpn)\b", low[pos + len(name):]
            )
            if near_next_week or followed_by_depan:
                # Next week's Monday, then the weekday within it. Adding 7 to
                # "the next Tuesday" overshoots by a week when that Tuesday is
                # already next week — "senin depan" landed on the 10th.
                monday_next = now.date() + timedelta(days=7 - now.weekday())
                target = monday_next + timedelta(days=wd)
            else:
                target = (now + timedelta(days=(wd - now.weekday()) % 7)).date()
            candidates.append((pos, target))

    m = _TANGGAL_RE.search(low)
    if m:
        day_num = int(m.group(1))
        for months_ahead in (0, 1):
            month = now.month + months_ahead
            year = now.year + (month - 1) // 12
            month = (month - 1) % 12 + 1
            try:
                cand = now.date().replace(year=year, month=month, day=day_num)
            except ValueError:
                continue
            if cand >= now.date():
                candidates.append((m.start(), cand))
                break

    # Month-name dates: "31 juli", "3 agustus".
    m = _DATE_WORD_RE.search(low)
    if m:
        month = _MONTHS[m.group(2)]
        for year in (now.year, now.year + 1):
            try:
                cand = now.date().replace(
                    year=year, month=month, day=int(m.group(1))
                )
            except ValueError:
                continue
            if cand >= now.date():
                candidates.append((m.start(), cand))
                break

    # An hour span is not a date — see _TIME_RANGE_RE.
    low_no_times = _TIME_RANGE_RE.sub(" ", low)
    m = _DDMM_RE.search(low_no_times)
    if m and int(m.group(2)) <= 12:
        day_num, month = int(m.group(1)), int(m.group(2))
        for year in (now.year, now.year + 1):
            try:
                cand = now.date().replace(year=year, month=month, day=day_num)
            except ValueError:
                continue
            if cand >= now.date():
                candidates.append((m.start(), cand))
                break

    if not candidates:
        return None
    return min(candidates)[1]
