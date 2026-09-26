"""Command line interface.

    python -m bd_bot simulate            # interactive dry-run, no WhatsApp
    python -m bd_bot brain-serve         # the CRM's brain: flow over HTTP (:4321)
    python -m bd_bot import brands.csv   # load the brand database
    python -m bd_bot campaign --dry-run  # preview the next batch
    python -m bd_bot campaign --live     # blast the day's allowance
    python -m bd_bot report              # deal / no-deal across the database
    python -m bd_bot blast 628123 --name Cika --brand "Brand X"
    python -m bd_bot login               # link the number by QR (once)
    python -m bd_bot run                 # live: connect to WhatsApp
    python -m bd_bot tick                # fire due timers once (for cron)
    python -m bd_bot status
    python -m bd_bot inbox               # open escalations, with SLA age
    python -m bd_bot met <jid> --joined  # record meeting attendance
    python -m bd_bot replay              # backtest intents on chat-example/
    python -m bd_bot kb-check            # lint the message bank for bad prices
    python -m bd_bot resolve-group <link>  # invite link -> BD_GROUP_JID in .env
"""

from __future__ import annotations

import argparse
import collections
import importlib.util
import logging
import os
import sys
import threading
import time
from datetime import datetime, timedelta

from pathlib import Path

from . import config, contacts, flow, intents
from .engine import Engine
from .models import Conversation, Node
from .storage import Store
from .transport.mock import MockTransport

log = logging.getLogger("cli")


def _setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )


def _normalise_jid(raw: str) -> str:
    """Accept a JID as-is, or any way an Indonesian number gets typed."""
    if "@" in raw:
        return raw
    jid = contacts.to_jid(raw)
    if not jid:
        raise SystemExit(
            f"'{raw}' is not a valid Indonesian mobile number.\n"
            "Expected something like 08123456789, +628123456789, or 628123456789."
        )
    return jid


# ---------------------------------------------------------------------------


def cmd_simulate(args, cfg, store) -> int:
    """Drive the whole flow from the keyboard. Never touches WhatsApp."""
    # The mock transport IS the safety here: it prints instead of sending.
    # dry_run stays off so the output reads like the actual chat — full
    # messages and attachments, not "[DRY RUN] would send" placeholders.
    cfg.dry_run = False
    cfg.require_approval = False
    cfg.auto_reply = True
    cfg.min_seconds_between_sends = 0  # don't pace a keyboard conversation
    cfg.max_blasts_per_day = 10**6  # the cap is for real campaigns, not sims
    if args.demo:
        cfg.demo_mode = True
    transport = MockTransport()
    engine = Engine(cfg, store, transport)
    transport.start(engine.handle_inbound)

    # Fake the calendar: a keyboard test must never touch the real one, and
    # without this the booking path would just error out on missing OAuth.
    from . import gcal as _gcal

    _gcal.use_simulated()

    # A Meta id ("ig:…", "fb:…") is a conversation key, not a phone number,
    # and normalising it would dial digits that are an account id.
    jid = (
        args.jid if args.jid.startswith(("ig:", "fb:"))
        else _normalise_jid(args.jid or "628000000001")
    )
    # /restart is allowlisted in production because it re-blasts a number.
    # Nothing here reaches WhatsApp, so the sandbox always allows it.
    cfg.restart_jids = cfg.restart_jids | {jid}
    if args.fresh:
        store.reset(jid)
    convo = store.get(jid) or Conversation(jid=jid)
    convo.name = args.name or convo.name or "Cika"
    # Inbound leads have not told us their brand yet — that is what the
    # qualification form is for — so no placeholder is planted for them.
    convo.brand = args.brand or convo.brand or ("" if args.inbound else "Brand Uji")
    store.upsert(convo)

    print("=" * 68)
    print("SIMULATOR — local only, nothing reaches WhatsApp")
    print("=" * 68)
    mode = (
        "grounded generation (knowledge.py + chat-example/)"
        if cfg.use_llm_replies and cfg.anthropic_api_key
        else "static templates"
    )
    print(f"Replies: {mode}")
    print("Calendar: simulated — every hour free EXCEPT 13.00 (to test 'penuh')")
    if cfg.demo_mode:
        print(f"Waits:    DEMO — every delay is {cfg.demo_gap_seconds}s; /tick after "
              f"that fires the next rung")
    print("You are the brand. Type replies; the bot answers. Commands:")
    print("  /tick           fire any due timers")
    print("  /fire <timer>   fire a specific timer now")
    print("  /state          show conversation state")
    print("  /kb             show the fact sheet the bot is grounded on")
    print("  /blast          re-send the opening (new conversations only)")
    print("  /restart        wipe this conversation and replay from the opening")
    print("  /quit           (restart fresh later with: simulate --fresh)")
    print()

    # The bot speaks first — it's an outreach flow. Auto-blast a new
    # conversation; a resumed one picks up where it left off. With
    # --inbound the brand speaks first instead (an ad lead, a DM), so the
    # opening is never sent and the first thing typed runs the inbound SOP.
    if convo.node is Node.NEW and not args.inbound:
        engine.blast(jid, convo.name, convo.brand)
    elif convo.node is Node.NEW:
        print("(inbound — you write first; the bot has sent nothing yet)\n")
    else:
        print(f"(resuming existing conversation — node={convo.node.value}; "
              f"use --fresh to start over)\n")

    while True:
        try:
            raw = input("brand> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return 0
        if not raw:
            continue

        if raw == "/quit":
            return 0
        if raw == "/blast":
            engine.blast(jid, convo.name, convo.brand)
            continue
        if raw == "/tick":
            n = engine.tick()
            print(f"  {n} timer(s) fired")
            continue
        if raw == "/kb":
            from . import chat_examples, knowledge

            print(knowledge.fact_sheet())
            pairs = chat_examples.load_pairs(str(cfg.chat_examples_dir))
            sources = {p.source for p in pairs}
            print(
                f"CONTOH CHAT NYATA: {len(pairs)} exchange dari "
                f"{len(sources)} percakapan ({cfg.chat_examples_dir}/)"
            )
            continue
        if raw == "/state":
            c = store.get(jid)
            assert c is not None
            print(f"  node={c.node.value} outcome={c.outcome.value} "
                  f"gadget_loops={c.gadget_loops} price_stage={c.price_stage} "
                  f"unknown_streak={c.unknown_streak}")
            for job in store.pending(jid):
                print(f"  pending: {job.timer.value} at {job.fire_at:%Y-%m-%d %H:%M}")
            continue
        if raw.startswith("/fire "):
            from .models import Timer

            name = raw.split(maxsplit=1)[1].strip()
            try:
                timer = Timer(name)
            except ValueError:
                print(f"  unknown timer: {name}")
                print(f"  choices: {', '.join(t.value for t in Timer)}")
                continue
            c = store.get(jid)
            assert c is not None
            engine.apply(c, flow.on_timer(c, timer, cfg, engine.now()))
            continue

        # The engine handles /restart itself. Classifying it here would only
        # print a misleading intent and spend an API call on a command.
        if not Engine._RESTART_CMD.match(raw):
            intent = intents.classify(raw, cfg)
            print(f"  [intent: {intent.value}]")
        transport.feed(jid, raw)

    return 0


def _engine_send(cfg, store, work):
    """Run `work(engine)` against a transport that is actually connected.

    One-shot commands used to build a live `WhatsAppTransport` and call the
    engine on it without ever connecting, so the first real send raised
    "transport not started". Only `run` worked, because it goes through
    `transport.start()`. Dry runs keep the mock and never touch the network.
    """
    if cfg.dry_run:
        return work(Engine(cfg, store, MockTransport()))

    transport = _live_transport(cfg)
    engine = Engine(cfg, store, transport)
    return transport.connect_and_run(lambda _client: work(engine))


def cmd_blast(args, cfg, store) -> int:
    if args.live:
        cfg.dry_run = False
    if args.demo:
        cfg.demo_mode = True

    def _work(engine) -> int:
        for raw in args.jid:
            engine.blast(_normalise_jid(raw), args.name or "", args.brand or "")
        return 0

    return _engine_send(cfg, store, _work)


def cmd_import(args, cfg, store) -> int:
    """Load the brand database from a CSV export."""
    path = Path(args.path)
    if not path.is_file():
        print(f"no such file: {path}", file=sys.stderr)
        return 1

    report = contacts.load_file(path)
    added, enriched = store.add_contacts(
        report.contacts, args.list or path.stem, datetime.now(tz=cfg.tz)
    )

    print(f"read {path}")
    print(f"  {report.ok} valid row(s): {added} new, {enriched} enriched, "
          f"{report.ok - added - enriched} already known")

    if report.skipped:
        print(f"  {len(report.skipped)} skipped:")
        for line, raw, reason in report.skipped[: args.show_skipped]:
            print(f"    line {line}: {reason}{f' — {raw!r}' if raw else ''}")
        if len(report.skipped) > args.show_skipped:
            print(f"    … and {len(report.skipped) - args.show_skipped} more "
                  f"(--show-skipped N to see them)")

    stats = store.contact_stats()
    print(f"\ndatabase: {stats['total']} contacts, {stats['waiting']} not yet approached")
    print("next: python -m bd_bot campaign --dry-run")
    return 0


def cmd_campaign(args, cfg, store) -> int:
    """Work through the brand database, blasting the daily allowance."""
    if args.live:
        cfg.dry_run = False
    preview = args.dry_run or cfg.dry_run
    now = datetime.now(tz=cfg.tz)
    already = store.blasted_today(now)
    allowance = max(0, cfg.max_blasts_per_day - already)
    limit = min(args.limit, allowance) if args.limit else allowance

    stats = store.contact_stats()
    print(f"database: {stats['total']} contacts, {stats['waiting']} waiting")
    print(f"today:    {already} blasted, {allowance} left of "
          f"{cfg.max_blasts_per_day}/day")

    if limit <= 0:
        print("\ndaily cap reached — nothing to do")
        return 0

    transport = MockTransport() if preview else _live_transport(cfg)
    engine = Engine(cfg, store, transport)

    if not preview and not engine.within_send_window(now):
        print(f"\noutside the sending window "
              f"({cfg.send_window_start:%H:%M}–{cfg.send_window_end:%H:%M}, "
              f"{cfg.days_label()}) — refusing to blast.")
        print("Cold outreach at odd hours is both ineffective and a ban signal.")
        return 1

    queue = store.queue(limit)
    if not queue:
        print("\nno contacts waiting")
        return 0

    # A preview must leave the database exactly as it found it — otherwise
    # checking a batch would silently consume it, and those brands would never
    # actually be messaged.
    if preview:
        print(f"\nPREVIEW — {len(queue)} contact(s), nothing is sent or recorded\n")
        for contact in queue:
            convo = store.get(contact.jid) or Conversation(
                jid=contact.jid, name=contact.name, brand=contact.brand
            )
            print(f"--- to {contact.jid.split('@')[0]} "
                  f"({contact.brand or contact.name or 'no label'}) ---")
            print(engine.preview_blast(convo))
            print()
        print(f"{len(queue)} contact(s) still waiting — none were consumed")
        print("send for real with: python -m bd_bot campaign --live")
        return 0

    print(f"\nblasting {len(queue)} contact(s), "
          f"{cfg.min_seconds_between_sends}s apart\n")

    def _send_batch(_client=None) -> int:
        sent = 0
        try:
            for contact in queue:
                if engine.blast(
                    contact.jid, contact.name, contact.brand, contact.category
                ):
                    # Only a delivered message counts — a declined or capped
                    # send must leave the contact in the queue for next run.
                    store.mark_blasted(contact.jid, engine.now())
                    sent += 1
                else:
                    log.info("not blasted: %s", contact.jid)
        except KeyboardInterrupt:
            print("\nstopped by operator")

        print(f"\n{sent} blasted, {len(queue) - sent} left in the queue")
        return 0

    # The transport has to be connected before anything can go out; `engine`
    # holds this same instance, so connecting it here is enough.
    return transport.connect_and_run(_send_batch)


def cmd_report(args, cfg, store) -> int:
    """Deal / no-deal across the whole database."""
    stats = store.contact_stats()
    counts = store.outcome_counts()
    convos = store.all_conversations()

    def n(*nodes: Node) -> int:
        return sum(counts.get(node.value, 0) for node in nodes)

    booked = n(Node.SCHEDULED, Node.MEETING_DONE)
    talking = n(
        Node.INBOUND_QUALIFY,
        Node.QNA, Node.OFFER_MEETING, Node.SCHEDULING, Node.WARM_D2, Node.WARM_D5,
        Node.MENUNDA_H1, Node.MENUNDA_H3, Node.NOSHOW_FU1, Node.NOSHOW_FU2,
    )
    chasing = n(Node.BLASTED, Node.COLD_FU1, Node.COLD_FU2, Node.COLD_FU3, Node.COLD_FU4)
    closed = n(Node.STOPPED)
    handover = n(Node.HANDOVER)
    approached = len(convos) - n(Node.NEW)

    print("BRAND DATABASE")
    print(f"  {stats['total']:>5}  total contacts")
    print(f"  {stats['waiting']:>5}  not yet approached")
    print()
    print("PIPELINE")
    print(f"  {chasing:>5}  blasted, awaiting a reply")
    print(f"  {talking:>5}  in conversation")
    print(f"  {handover:>5}  handed to a human")
    print()
    print("OUTCOMES")
    print(f"  {booked:>5}  DEAL — meeting booked")
    print(f"  {closed:>5}  no — rejected or decayed")
    if approached:
        print(f"\n  {booked / approached:.1%} of {approached} approached converted "
              f"to a meeting")

    meetings = store.meetings()
    if meetings:
        print("\nMEETINGS")
        for c in meetings:
            when = f"{c.meeting_at:%a %d %b %H:%M}" if c.meeting_at else "?"
            label = c.brand or c.display_name()
            flag = "" if c.node is Node.MEETING_DONE else "  (upcoming)"
            print(f"  {when}  {label}{flag}")
    return 0


def cmd_tick(args, cfg, store) -> int:
    def _work(engine) -> int:
        n = engine.tick()
        print(f"{n} timer(s) fired")
        return 0

    return _engine_send(cfg, store, _work)


def _claw_has_room(store, cfg) -> bool:
    """Is there space in the phones' queue for another opening?

    A bot's daily cap is tens of brands; one phone types a few dozen a day.
    Left alone the outreach loop fills the queue in minutes, and the brands at
    the back sit in a lease nobody is draining instead of being handed to a
    phone that is free. Checked BEFORE a dashboard row is claimed: asking for
    a row claims it, and a row claimed for a message that was never queued is
    a brand nobody contacts.
    """
    hands = max(1, len(store.claw_registered()))
    room = cfg.claw_outbox_max_per_number * hands
    depth = store.claw_depth()
    if depth >= room:
        log.info("claw queue is full (%d/%d) — not claiming another brand",
                 depth, room)
        return False
    return True


def cmd_run(args, cfg, store) -> int:
    """Connect to WhatsApp and serve, with a background timer loop."""
    claw_mode = getattr(args, "claw", False)
    meta_mode = getattr(args, "meta", False)
    if claw_mode and meta_mode:
        print("--claw and --meta are different hands; pick one.", file=sys.stderr)
        return 1
    # The claw fleet and the dashboard API are not in the CRM copy; refuse
    # here, before anything is printed or opened, rather than at the lazy
    # import halfway through start-up (25 Sep 2026).
    if claw_mode and importlib.util.find_spec("bd_bot.transport.claw") is None:
        raise RuntimeError(_NO_TRANSPORT)
    if getattr(args, "api_port", 0) and importlib.util.find_spec("bd_bot.http_api") is None:
        raise RuntimeError(_NO_TRANSPORT)
    if args.live:
        cfg.dry_run = False
    if args.demo:
        cfg.demo_mode = True

    # A demo on a host with no Google OAuth would send every tester down the
    # "jadwalnya sedang saya siapkan" failure path — they would grade the
    # degradation instead of the booking flow they were asked to look at.
    simulated_calendar = False
    if cfg.demo_mode and not (
        cfg.google_credentials.is_file() or cfg.google_token.is_file()
    ):
        from . import gcal

        gcal.use_simulated()
        simulated_calendar = True

    reply_mode = (
        "AUTO — answers inbound messages by itself"
        if cfg.auto_reply
        else "asks y/N before each reply"
    )
    blast_mode = "asks y/N first" if cfg.require_approval else "AUTO"

    print()
    print("=" * 60)
    if cfg.dry_run:
        print("  MODE: DRY RUN — connects and reads, sends NOTHING")
        print("  Run with --live (or DRY_RUN=false) to actually send.")
    else:
        print("  MODE: LIVE — messages will really be sent")
        print(f"  Replies:  {reply_mode}")
        print(f"  Blasts:   {blast_mode}")
        print(f"  Window:   {cfg.send_window_start:%H:%M}–{cfg.send_window_end:%H:%M}, "
              f"{cfg.days_label()}")
        print(f"  Cap:      {cfg.max_blasts_per_day}/day, "
              f"{cfg.min_seconds_between_sends}s apart")
    if cfg.demo_mode:
        print("-" * 60)
        print(f"  DEMO:     every wait collapses to ~{cfg.demo_gap_seconds}s and is")
        print("            announced as '⏩ *1 hari kemudian*'. Business-hours")
        print("            window OFF. Testing only — never leave this on.")
        if simulated_calendar:
            print("  Calendar: SIMULATED (no Google credentials) — bookings are")
            print("            fake and the Meet link goes nowhere.")
        else:
            print(f"  Calendar: REAL — events land in {cfg.google_calendar_id!r}.")
        # This number may carry real traffic; say out loud who can reach the
        # bot, because everyone else is silently dropped.
        if cfg.restart_jids:
            listed = ", ".join(sorted(j.split("@")[0] for j in cfg.restart_jids))
            print(f"  Answers:  ONLY these testers — {listed}")
            print("            Anyone else who messages this number is ignored.")
        else:
            print("  Answers:  NOBODY — RESTART_JIDS is empty, so every inbound")
            print("            message is ignored. Set it before testing.")
    if claw_mode:
        print("-" * 60)
        print("  HAND:     claw — an Android phone types this, over adb.")
        print("            Nothing is sent here: messages are queued and a")
        print("            registered phone types them minutes later.")
        print("            Group messages and PDFs cannot be typed by a")
        print("            phone — both are escalated, see CLAW.md.")
    print("=" * 60)
    print()

    # Attachments are configured by dropping files in, so a missing one is
    # silent: the bot keeps talking and simply never sends the evidence. Say
    # so once, at startup, where an operator will see it.
    if not cfg.dry_run:
        if not cfg.company_profile_pdf.is_file():
            print(f"note: no {cfg.company_profile_pdf} — follow-ups and "
                  f"rejections will attach the opening deck instead")
        stocked = [
            d.name
            for d in sorted(cfg.case_studies_dir.glob("*"))
            if d.is_dir() and any(
                f.is_file() and not f.name.startswith(".") for f in d.iterdir()
            )
        ]
        if not stocked:
            print(f"note: no case studies in {cfg.case_studies_dir}/ — the "
                  f"portfolio answer and COLD_FU3 will go out as text only")
        else:
            print(f"case studies ready for: {', '.join(stocked)}")

        # Say at boot whether meetings can actually be booked. A dead OAuth
        # token is invisible from outside — the bot keeps chatting, and only a
        # brand who agrees to a meeting discovers the booking never happens.
        # The server's token was expired for twelve days before anybody looked.
        if not simulated_calendar:
            from . import gcal

            try:
                gcal.free_slots(cfg, datetime.now(cfg.tz), limit=1)
                print(f"calendar: OK — bookings land in {cfg.google_calendar_id}")
            except gcal.CalendarError as exc:
                print()
                print("⚠️  CALENDAR UNAVAILABLE — meetings cannot be booked.")
                print(f"    {exc}")
                print("    Brands who agree to a meeting get the holding reply")
                print("    and an escalation; nothing is lost, but somebody has")
                print("    to book by hand until this is fixed.")
                log.error("calendar unavailable at startup: %s", exc)
        print()

    sys.stdout.flush()

    if meta_mode:
        # Inbound only, and deliberately so: Instagram and Facebook have no
        # equivalent of the outreach blast, and a business account that DMs
        # strangers first is reported rather than answered. Everything below
        # is unchanged — same engine, same flow, same calendar — because the
        # only thing that differs is who carries the message.
        from .transport.meta import MetaTransport

        def _escalate(jid: str, note: str) -> None:
            store.escalate(jid, note, "", datetime.now(tz=cfg.tz))

        transport = MetaTransport(cfg, store=store, escalate=_escalate)
    elif claw_mode:
        # No socket, no QR, no paired account: the phones are the account.
        # Everything below is unchanged — the same engine, the same timer
        # loop, the same outreach loop — because the only thing that differs
        # is who does the typing.
        from .transport.claw import ClawTransport

        transport = ClawTransport(store, cfg, media_root=Path.cwd())
    else:
        try:
            transport = _live_transport(cfg)
        except RuntimeError as exc:
            print(f"Cannot start WhatsApp transport:\n\n{exc}\n", file=sys.stderr)
            return 1

    engine = Engine(cfg, store, transport)
    if hasattr(transport, "on_event"):
        transport.on_event = engine.handle_transport_event

    # Dashboard control API (--api-port). Chained onto the transport's existing
    # hooks rather than replacing them: the engine still needs handle_transport_event,
    # and --blast still needs on_connected, so this only observes.
    api_state = None
    if getattr(args, "api_port", 0):
        from .http_api import _State, serve

        api_state = _State(
            qr_png=cfg.session_dir / "qr.png",
            bind_file=cfg.session_dir / "dashboard_bind.json",
        )
        # Unpaired sessions emit a QR the moment the socket opens, so 'connecting'
        # from the start is what the dashboard should see while it polls.
        api_state.set_status("connecting")

        engine_on_event = transport.on_event

        def _on_event(kind: str, detail: str = "") -> None:
            # 'banned' and 'logged_out' both mean this number can no longer send;
            # the dashboard has one red state, so both read as disconnected.
            if kind in ("disconnected", "logged_out", "banned"):
                api_state.set_status("disconnected")
            # Every reconnect, not just the first. Kept off on_connected below,
            # which fires once per process: a blip flipped the dashboard red and
            # nothing could flip it back, so an operator saw 'disconnected' and
            # an empty QR box while the bot went on sending. Not forwarded to
            # the engine — its default branch alerts on any unrecognised kind,
            # which would fire a WhatsApp alert on every routine reconnect.
            if kind == "reconnected":
                api_state.set_status(
                    "connected", user=getattr(transport, "paired_user", "")
                )
                return
            if engine_on_event is not None:
                engine_on_event(kind, detail)

        transport.on_event = _on_event

        # Re-pairing needs a new whatsmeow client, and the only one this process
        # ever builds is the one transport.start() is already blocked on. Rather
        # than tear that down from another thread mid-socket, exit and let the
        # supervisor (pm2) start us again — pending timers live in SQLite and
        # resume on the next boot, so nothing is lost by cycling. Only ever
        # reached when there is no live session, so no connected number is
        # dropped by it.
        def _relink() -> None:
            log.warning("relink requested from the dashboard — restarting to "
                        "issue a fresh pairing QR")

            def _bye() -> None:
                time.sleep(0.5)     # let the HTTP response reach the dashboard
                os._exit(0)         # 0: a clean, expected cycle, not a crash

            threading.Thread(target=_bye, daemon=True, name="relink").start()

        api_state.on_relink = _relink

        # Stop/Run. Deliberately a halt, not a process kill: pm2 restarts this
        # within seconds, so killing would read to the operator as a Stop
        # button that does not work. `Engine.pause` holds the timer queue and
        # records inbound instead — see its docstring.
        def _set_paused(paused: bool) -> None:
            engine.pause("dashboard") if paused else engine.resume()

        api_state.on_set_paused = _set_paused
        # Connect is the operator saying "this number is mine and it is ready",
        # which is exactly the signal the boot gate is waiting for.
        api_state.on_connect_release = engine.release_connect_gate

        # The dashboard's chat panel reads from here. Shares the one Store on
        # purpose — see its constructor: the connection is already used from
        # the transport and timer threads, and a second connection to the same
        # file would only add lock contention.
        # A brand pointing us at somebody else's number is the warmest lead
        # the list gets. Queued straight into the dashboard so it is picked up
        # by the normal campaign rather than living in a log nobody reads.
        if getattr(args, "outreach", ""):
            _referral_base = args.outreach.rstrip("/")

            def _queue_referral(phone: str, referred_by: str = "") -> bool:
                from . import outreach_targets as _ot

                if cfg.is_blocked(referred_by, phone):
                    log.warning("referred number %s belongs to a blocked brand"
                                " — not queued", phone)
                    return False
                return _ot.add_referral(_referral_base, phone, referred_by)

            engine.on_referral = _queue_referral

        api_state.conversations_source = store.conversation_summaries
        api_state.thread_source = store.thread
        # Contact-list validation for the BD harvest. Bound to the transport,
        # not the engine: it asks WhatsApp a question and sends nothing, so it
        # is unaffected by Stop — an operator who has halted outreach can still
        # find out which of ten thousand harvested numbers are reachable.
        # Not wired under claw: a phone screen cannot answer "does this
        # number have WhatsApp". The dashboard says so honestly (503) rather
        # than being handed a guess it would file as fact.
        api_state.on_check_numbers = None if claw_mode else transport.is_on_whatsapp
        # Read the flag off the engine rather than caching a copy: it pauses
        # itself on a ban or logout, and the page must show that.
        api_state.paused_source = lambda: engine.paused
        api_state.reason_source = lambda: engine.pause_reason

        serve(api_state, args.api_port)
        print(f"control panel: http://127.0.0.1:{args.api_port}/ui  "
              f"(Stop/Run once the number is connected)")

    claw_brain = None
    if claw_mode:
        from .claw_api import ClawBrain
        from .claw_api import serve as claw_serve

        claw_brain = ClawBrain(
            engine, transport,
            project_root=Path.cwd(),
            outreach_base=(getattr(args, "outreach", "") or "").rstrip("/"),
        )
        try:
            claw_serve(claw_brain, cfg.claw_port, cfg.claw_host)
        except (RuntimeError, OSError) as exc:
            print(f"\nclaw brain did not start: {exc}\n", file=sys.stderr)
            return 1
        print(f"claw brain: http://{cfg.claw_host}:{cfg.claw_port}  "
              f"(row {cfg.claw_row_id})")
        print("  point a phone at it:  CLAW_BRAIN_URL=http://127.0.0.1:"
              f"{cfg.claw_port} CLAW_BRAIN_TOKEN=… node claw/bin/agent.mjs "
              f"--brand {cfg.claw_row_id}")
        registered = [r["number"] for r in store.claw_registered()]
        queued = store.claw_depth()
        print(f"  phones registered: {', '.join(registered) or 'none yet'}"
              f"   queued: {queued}")
        if cfg.dry_run:
            print("  DRY RUN — the flow prints instead of queueing, so the "
                  "phones will be handed nothing. Add --live.")
        print()
        # Flushed, not left to the buffer: pm2 owns stdout in production, and
        # block-buffered output leaves the operator staring at nothing for
        # hours while the brain is in fact up. Logged as well, which is what
        # survives in pm2's own log file.
        sys.stdout.flush()
        log.info("claw brain up on %s:%d as row %s — %d phone(s) registered, "
                 "%d task(s) queued", cfg.claw_host, cfg.claw_port,
                 cfg.claw_row_id, len(registered), queued)

    if args.blast:
        # Blasting from a second process would mean two clients on one paired
        # session, and would leave a gap where a tester replies to an opening
        # nothing is listening for. Send from inside the serving process, as
        # soon as it has a socket.
        targets = [_normalise_jid(raw) for raw in args.blast]

        def _open_the_conversations() -> None:
            for jid in targets:
                engine.blast(jid, args.name or "", args.brand or "")

        transport.on_connected = _open_the_conversations

    # Set AFTER --blast above, which assigns on_connected outright: chaining
    # here keeps whichever hook that branch installed.
    if api_state is not None:
        blast_hook = transport.on_connected

        def _on_connected() -> None:
            api_state.set_status(
                "connected", user=getattr(transport, "paired_user", "")
            )
            if blast_hook is not None:
                blast_hook()

        transport.on_connected = _on_connected

    # Restart safety (ROADMAP 3.1): pending timers live in SQLite and are
    # picked up by the first tick — say so, so an operator can see the
    # resume happened. Overdue ones drain paced by MIN_SECONDS_BETWEEN_SENDS.
    pending = sum(len(store.pending(c.jid)) for c in store.all_conversations())
    if pending:
        print(f"resuming {pending} pending timer(s) from the previous run")

    # Timers resume, but a message the previous process died holding does not.
    # Say whose, so the operator can answer by hand — see
    # `Store.unanswered_inbound` for why this reports instead of replaying.
    dropped = store.unanswered_inbound(engine.now() - timedelta(hours=6))
    if dropped:
        print(f"\n⚠️  {len(dropped)} message(s) left unanswered by the previous "
              f"run — reply by hand or ask the tester to resend:")
        for jid, body, at in dropped:
            print(f"      {at[11:16]}  {jid.split('@')[0]}  {body[:60]!r}")
        print()

    stop = threading.Event()

    # Demo waits are seconds long, so a 60s poll would be the slowest thing in
    # the session; a real run keeps the cheap once-a-minute sweep.
    tick_every = 5 if cfg.demo_mode else 60

    def timer_loop() -> None:
        while not stop.wait(tick_every):
            try:
                if claw_mode:
                    # One turn: a sweep that wakes three contacts becomes
                    # three chat screens, not nine — and each one carries its
                    # own undo point, so a phone that never types a rung
                    # leaves that contact's ladder where it was.
                    with transport.turn("followup") as t:
                        # The undo points are taken BEFORE the sweep, not when
                        # the first message is composed: a rung schedules the
                        # next one, and a mark taken after that would roll back
                        # to a ladder that had already moved.
                        for job in store.due(engine.now()):
                            t.bundle(job.jid)
                        engine.tick()
                else:
                    engine.tick()
            except Exception:
                logging.getLogger("cli").exception("timer loop error")

    threading.Thread(target=timer_loop, daemon=True).start()

    # Outreach: one queued brand every OUTREACH_INTERVAL_SECONDS, once there
    # is a socket. Its own
    # thread, so a slow dashboard or a send that takes a while cannot delay the
    # timer sweep — and it starts only when --outreach was asked for.
    if getattr(args, "outreach", ""):
        from . import outreach_targets

        # Hold everything until somebody connects. The session on disk means
        # this process comes back online by itself after any restart, so
        # without the gate a `pm2 restart` is enough to resume cold-messaging
        # an unattended list — which is how five brands were opened on 12 Aug
        # 2026 with an empty dashboard and nobody watching.
        engine.pause(Engine.WAITING_FOR_CONNECT)
        print("outreach is ARMED but HELD — nothing sends until you press "
              "Connect on the dashboard (or Run on the control panel).")

        api_base = args.outreach.rstrip("/")
        # Logged, not printed: stdout is block-buffered when pm2 owns it, so a
        # bare print sits invisible in the buffer for hours and the operator
        # cannot tell whether outreach is armed.
        log.info(
            "outreach ARMED — brands queued at %s, 1 per %ds, %s–%s %s, max %d/day",
            api_base,
            cfg.outreach_interval_seconds,
            cfg.send_window_start.strftime("%H:%M"),
            cfg.send_window_end.strftime("%H:%M"),
            cfg.days_label(),
            cfg.max_blasts_per_day,
        )

        def outreach_loop() -> None:
            # The gap between attempts IS the send rate: the dashboard hands
            # out a single pending row per call, so there is no batch to pace.
            while not stop.wait(cfg.outreach_interval_seconds):
                try:
                    # Which CS row owns the session. The daily cap belongs to
                    # the number, and only this process knows which row that
                    # is — so it tells the dashboard rather than the dashboard
                    # calling back into the bot that is calling it.
                    cs_id = api_state.snapshot()[2] if api_state else ""
                    if claw_mode and not _claw_has_room(store, cfg):
                        continue
                    outreach_targets.send_next(
                        engine, cfg, api_base, cs_id=cs_id or ""
                    )
                except Exception:
                    logging.getLogger("cli").exception("outreach loop error")

        threading.Thread(target=outreach_loop, daemon=True).start()

    try:
        transport.start(engine.handle_inbound)  # blocks
    except KeyboardInterrupt:
        print("\nstopping…")
    except RuntimeError as exc:
        print(f"\n{exc}\n", file=sys.stderr)
        return 1
    finally:
        stop.set()
        transport.stop()
    return 0


def cmd_claw(args, cfg, store) -> int:
    """What the phones are doing, and how to lean on them.

    Reads the bot's own database rather than the HTTP brain: an operator on
    the server should not need a token and a curl to answer "is anything
    happening", and this works when the brain is not even running.
    """
    import json as _json

    now = datetime.now(cfg.tz)
    stale = timedelta(minutes=cfg.claw_stale_beat_minutes)

    if args.pause or args.resume or args.cap is not None:
        number = "".join(c for c in (args.phone or "") if c.isdigit())
        if not number:
            print("which phone? pass --phone 628…", file=sys.stderr)
            return 1
        if not store.claw_is_registered(number):
            print(f"{number} has never registered with this bot", file=sys.stderr)
            return 1
        if args.pause:
            store.claw_command(number, "pause", {}, now)
        if args.resume:
            store.claw_command(number, "resume", {}, now)
        if args.cap is not None:
            store.claw_command(number, "cap", {"cap": args.cap}, now)
        # Queued, not applied: the phone collects it on its next heartbeat
        # (~20s) and reports back. Saying "done" here would be a claim about
        # a machine in another building.
        print(f"queued for {number} — it picks this up on its next heartbeat")
        return 0

    beats = {r["number"]: r for r in store.claw_fleet()}
    phones = store.claw_registered()
    if not phones:
        print("no phones have registered with this bot yet")
    for reg in phones:
        beat = beats.get(reg["number"])
        payload = _json.loads(beat["payload"]) if beat else {}
        at = datetime.fromisoformat(beat["at"]) if beat else None
        age = "never" if at is None else f"{int((now - at).total_seconds() // 60)}m ago"
        silent = at is None or (now - at) > stale
        openers = payload.get("openers") or {}
        line = (f"  {reg['label'] or '-':10} {reg['number']:15} "
                f"beat {age:>9}{'  SILENT' if silent else ''}")
        if openers:
            line += f"   openers {openers.get('sent', '?')}/{openers.get('cap', '?')}"
        if payload.get("battery") is not None:
            line += f"   batt {payload['battery']}%"
        if payload.get("paused"):
            line += "   PAUSED"
        print(line)
        trouble = payload.get("trouble")
        if trouble:
            print(f"             trouble: {trouble.get('kind', '?')}"
                  f" — {trouble.get('detail') or trouble.get('pesan') or ''}")

    depth = store.claw_depth()
    kinds = {k: store.claw_depth(kind=k) for k in ("materials", "followup", "opener")}
    if depth:
        breakdown = ", ".join(f"{k} {v}" for k, v in kinds.items() if v)
        print(f"\nqueued: {depth}  ({breakdown})")
    else:
        print("\nqueued: nothing waiting")
    for r in store.claw_usb():
        payload = _json.loads(r["payload"] or "{}")
        seen = payload.get("devices")
        print(f"cable:  {r['host']} reported {len(seen) if isinstance(seen, list) else '?'}"
              f" phone(s) at {r['at'][11:16]}")

    if args.queue:
        print()
        for row in store.claw_queue(limit=args.queue):
            parts = _json.loads(row["parts"] or "[]")
            media = _json.loads(row["media"] or "[]")
            who = row["name"] or row["brand"] or row["phone"]
            state = "leased" if row["leased_at"] else "waiting"
            print(f"  {row['kind']:9} {row['phone']:15} {who[:22]:22} {state}"
                  f"  {len(parts)} msg  {len(media)} file"
                  + (f"  fails {row['fails']}" if row["fails"] else ""))
            if args.queue and parts:
                print(f"             {parts[0][:90]!r}")
    return 0


def cmd_status(args, cfg, store) -> int:
    convos = store.all_conversations()
    if not convos:
        print("no conversations yet")
        return 0
    print(f"{'contact':<16} {'node':<16} {'outcome':<11} {'loops':>5}  next timer")
    print("-" * 78)
    for c in convos:
        pending = store.pending(c.jid)
        nxt = (
            f"{pending[0].timer.value} @ {pending[0].fire_at:%d %b %H:%M}"
            if pending
            else "-"
        )
        print(
            f"{c.jid.split('@')[0]:<16} {c.node.value:<16} "
            f"{c.outcome.value:<11} {c.gadget_loops:>5}  {nxt}"
        )
    return 0


def cmd_inbox(args, cfg, store) -> int:
    from .engine import business_hours_between

    rows = store.open_escalations()
    if not rows:
        print("no open escalations")
        return 0
    now = datetime.now(tz=cfg.tz)
    for r in rows:
        age = business_hours_between(datetime.fromisoformat(r["at"]), now, cfg)
        flag = "  ⚠ SLA" if age > cfg.escalation_sla_hours else ""
        print(
            f"[{r['id']}] {r['at'][:16]}  {age:>4.1f}bh{flag}  "
            f"{r['jid'].split('@')[0]}  {r['reason']}"
        )
        if r["body"]:
            print(f"      {r['body'][:100]}")
    print(f"\n(bh = business hours in the send window; SLA "
          f"{cfg.escalation_sla_hours}bh)")
    print("resolve with: python -m bd_bot resolve <id>")
    return 0


def cmd_resolve(args, cfg, store) -> int:
    store.resolve_escalation(args.id)
    print(f"escalation {args.id} resolved")
    return 0


def cmd_release(args, cfg, store) -> int:
    """Hand a conversation back to the bot after a human is done with it.

    HANDOVER and MEETING_DONE are where the flow stops answering, and nothing
    moved a conversation out of them: `resolve` only closes the escalation
    row, so the contact stayed silent forever. Found 30 Jul 2026 when a
    tester in HANDOVER wrote "Mau meeting" and got nothing back, then spent
    four messages trying to type /restart to escape it.

    Unlike /restart this keeps the conversation — history, brand, email and
    any booked meeting all survive. Use --restart-ladder to re-arm follow-ups.
    """
    from .models import Node, Outcome

    jid = contacts.to_jid(args.contact)
    if not jid:
        print(f"not a phone number: {args.contact!r}", file=sys.stderr)
        return 1

    convo = store.get(jid)
    if convo is None:
        print(f"no conversation for {args.contact}", file=sys.stderr)
        return 1

    was = convo.node
    if was not in {Node.HANDOVER, Node.MEETING_DONE, Node.STOPPED}:
        print(f"{args.contact} is in {was.value}, which the bot already answers")
        return 0

    convo.node = Node.QNA
    convo.outcome = Outcome.FOLLOWUP
    convo.unknown_streak = 0
    store.upsert(convo)
    print(f"{args.contact}: {was.value} -> qna — the bot will answer them again")
    if args.restart_ladder:
        from .flow import DELAYS, Timer

        store.schedule(
            jid, Timer.WARM_D2, datetime.now(tz=cfg.tz) + DELAYS[Timer.WARM_D2]
        )
        print("  re-armed the warm follow-up ladder")
    return 0


def cmd_reclassify(args, cfg, store) -> int:
    """Re-read the history with the current reader, and fix the labels.

    Every inbound message carries the label the classifier gave it *at the
    time*, and the dashboard counts brands with those labels. The old rules
    called "baik kak 😊" agreement and read a switchboard's marketing greeting
    as a question about our office — so on 21 Aug the board showed 27
    interested brands of which two were.

    Cheap despite the volume: readings are cached, and the traffic is mostly
    repeats. `--dry-run` shows what would change without touching anything.
    """
    from . import understanding

    if not cfg.use_llm_intents or not cfg.anthropic_api_key:
        print("USE_LLM_INTENTS and ANTHROPIC_API_KEY are needed to re-read.")
        return 1

    jids = store.jids_with_inbound()
    if args.limit:
        jids = jids[: args.limit]
    print(f"re-reading {len(jids)} conversation(s)…\n")

    changed = collections.Counter()
    calls_before = [0]
    seen, fixed = 0, 0
    for n, jid in enumerate(jids, 1):
        convo = store.get(jid)
        brand = (convo.name or convo.brand) if convo else ""
        for mid, body, old in store.inbound_messages(jid):
            if not (body or "").strip():
                continue
            seen += 1
            reading = _reread(store, cfg, jid, mid, body, brand)
            if reading is None:
                continue
            new = _tag_for(reading)
            if new and new != old:
                fixed += 1
                changed[f"{old or '-'} -> {new}"] += 1
                if not args.dry_run:
                    store.retag_message(mid, new)
        if n % 25 == 0:
            print(f"  {n}/{len(jids)} — {fixed} label(s) corrected so far")

    print(f"\n{seen} message(s) read, {fixed} label(s) "
          f"{'would change' if args.dry_run else 'corrected'}")
    for move, count in changed.most_common(20):
        print(f"  {count:>4}  {move}")
    learned, reused = store.reading_stats()
    print(f"\n{learned} case(s) learned, {reused} reuse(s) — "
          f"that many model calls not made.")
    return 0


def _tag_for(reading) -> str:
    """The label a re-read message should carry.

    The same vocabulary the engine writes live, so the dashboard's rules do
    not have to know which pass wrote a row.
    """
    # Order matters, and it is the engine's own: a number or an address wins
    # over "this was written by a machine". The reply that hands over a PIC is
    # usually canned, and re-labelling those `auto` would undo the 14 Aug fix
    # in the history — the dry run wanted to do it to 72 messages.
    if reading.phones:
        return "referral"
    if reading.email:
        return "kirim_email"
    if reading.automated:
        return "auto"
    if reading.ends_conversation:
        return "selesai"
    if reading.politeness_only:
        return "basa_basi"
    return reading.intent.value if reading.intent else ""


def _reread(store, cfg, jid: str, message_id: int, body: str, brand: str):
    """One message, read against the turns that preceded it back then."""
    from . import understanding

    context = understanding.normalize(
        next((b for d, b in reversed(store.turns_before(jid, message_id, 4))
              if d == "out"), "")
    )[:200]
    normalized = understanding.normalize(body)
    if not normalized:
        return None
    fingerprint = understanding.fingerprint(context, normalized)
    known = store.recall_reading(context, normalized, fingerprint)
    if known is not None:
        return understanding.from_dict(known[0])
    reading = understanding.read(
        cfg, body, store.turns_before(jid, message_id, understanding.HISTORY_TURNS),
        brand=brand,
    )
    if reading.understood and reading.reusable():
        store.remember_reading(
            fingerprint, context, normalized, body,
            understanding.to_dict(reading), reading.automated, datetime.now(),
        )
    return reading if reading.understood else None


def cmd_readings(args, cfg, store) -> int:
    """What the bot has learned to recognise without asking the model.

    Worth looking at when a reply reads wrong the same way twice: a case is
    remembered until somebody forgets it, so one bad reading repeats forever.
    `--forget` takes it out and the next message of that kind is thought about
    again.
    """
    if args.forget:
        n = store.forget_readings(None if args.forget == "all" else args.forget)
        print(f"forgot {n} learned case(s)")
        return 0

    rows = store.learned_readings(limit=args.limit)
    if not rows:
        print("nothing learned yet — every message is still being read fresh")
        return 0
    print(f"{'id':>4}  {'hits':>4}  {'intent':16}  message")
    for r in rows:
        flags = "".join(
            f for f, on in (
                ("A", r["automated"]), ("B", r["politeness_only"]),
                ("E", r["ends_conversation"]),
            ) if on
        )
        print(f"{r['id']:>4}  {r['hits']:>4}  {r['intent'][:16]:16}  "
              f"{flags:3} {r['sample'][:60]}")
    learned, reused = store.reading_stats()
    print(f"\n{learned} case(s) learned, reused {reused} time(s) — that many "
          f"model calls not made.")
    print("A=mesin  B=basa-basi  E=percakapan selesai")
    print("Forget one: python -m bd_bot readings --forget <id>   (or --forget all)")
    return 0


def cmd_cache(args, cfg, store) -> int:
    """Inspect or clear the generated-reply cache."""
    from . import responder

    if args.clear:
        n = store.clear_reply_cache()
        print(f"cleared {n} cached repl{'y' if n == 1 else 'ies'}")
        return 0

    total = 0
    for key in sorted(responder.CACHEABLE_KEYS):
        variants = store.cached_replies(key)
        total += len(variants)
        state = (
            "FULL — reused, no API calls"
            if len(variants) >= cfg.reply_cache_variants
            else f"{len(variants)}/{cfg.reply_cache_variants} — still generating"
        )
        print(f"{key:22} {state}")
    print(f"\n{total} cached variant(s). Clear with: python -m bd_bot cache --clear")
    return 0


def kb_violations() -> list[str]:
    """Every Rp figure in the message bank must be an authorised amount.

    The corpus proved price drift happens (old decks quoting Rp30jt, ad-hoc
    Rp20jt specials); this is the lint that keeps templates, examples, and
    the fact sheet in lock-step with knowledge.ALLOWED_AMOUNTS. ROADMAP 3.4.
    """
    from . import knowledge, responder, templates

    allowed = {responder._normalise_amount(a) for a in knowledge.ALLOWED_AMOUNTS}
    sources: dict[str, str] = {
        f"templates.{name}": value
        for name, value in vars(templates).items()
        if name.isupper() and isinstance(value, str)
    }
    for ex in knowledge.EXAMPLES:
        sources[f"knowledge.EXAMPLES[{ex.intent.value}]"] = ex.answer
    sources["knowledge.fact_sheet()"] = knowledge.fact_sheet()

    problems: list[str] = []
    for name, text in sources.items():
        for m in responder._AMOUNT_RE.finditer(text):
            amount = responder._normalise_amount(m.group(1))
            if "miliar" in amount:
                continue  # GMV claims, not prices
            if amount not in allowed:
                problems.append(
                    f"{name}: Rp{m.group(1)} is not in knowledge.ALLOWED_AMOUNTS"
                )
    return problems


def cmd_gcal_check(args, cfg, store) -> int:
    """Is the calendar actually usable? Read-only — books nothing.

    Worth its own command because the failure is invisible from the outside:
    an expired token still leaves the bot chatting happily, and only a brand
    who agrees to a meeting discovers the booking never happens.
    """
    from datetime import datetime as _dt

    from . import gcal

    print(f"calendar:    {cfg.google_calendar_id}")
    print(f"credentials: {cfg.google_credentials} "
          f"{'✓' if cfg.google_credentials.is_file() else '✗ MISSING'}")
    print(f"token:       {cfg.google_token} "
          f"{'✓' if cfg.google_token.is_file() else '✗ MISSING'}")
    print()
    try:
        slots = gcal.free_slots(cfg, _dt.now(cfg.tz), limit=5)
    except gcal.CalendarError as exc:
        print(f"FAILED: {exc}\n")
        print("Bookings will not happen. A brand who agrees to a meeting gets")
        print("the 'jadwalnya sedang saya siapkan' holding reply and an")
        print("escalation for somebody to book by hand.")
        return 1
    print(f"OK — {len(slots)} free slot(s) the bot could offer right now:")
    for s in slots:
        print(f"  {s:%a %d %b %H:%M}")
    return 0


def cmd_gcal_auth(args, cfg, store) -> int:
    """Run the OAuth flow and write the token file.

    Must be run where a browser can open — the VPS has none, which is why the
    token is authorised locally and copied across.
    """
    from . import gcal

    if not cfg.google_credentials.is_file():
        print(f"No OAuth client secrets at {cfg.google_credentials}.", file=sys.stderr)
        print("Create an OAuth client (Desktop app) in Google Cloud Console and "
              "download the JSON there.", file=sys.stderr)
        return 1
    if not sys.stdin.isatty():
        print("This needs an interactive terminal and a browser.", file=sys.stderr)
        return 1

    # A stale token is exactly the thing being replaced; leaving it in place
    # makes _service try to refresh it and fail before reaching the flow.
    if cfg.google_token.is_file():
        backup = cfg.google_token.with_suffix(".json.old")
        cfg.google_token.replace(backup)
        print(f"moved the old token to {backup}")

    try:
        gcal._service(cfg)
    except gcal.CalendarError as exc:
        print(f"authorisation failed: {exc}", file=sys.stderr)
        return 1
    print(f"\nToken written to {cfg.google_token}")
    print("Copy it to the server:")
    print(f"  scp -i ~/.ssh/deploy_key {cfg.google_token} "
          f"root@72.62.244.186:/root/bd-bot/secrets/google-token.json")
    print("then check it there with:  python -m bd_bot gcal-check")
    return 0


def cmd_kb_check(args, cfg, store) -> int:
    problems = kb_violations()
    if problems:
        print("KB CHECK FAILED — unauthorised amounts in the message bank:")
        for p in problems:
            print(f"  ✗ {p}")
        print("\nFix knowledge.py/templates.py, then rerun. See README "
              "'When prices change'.")
        return 1
    print("kb-check OK — every stated amount is authorised by knowledge.py")
    return 0


def cmd_calendar_check(args, cfg, store) -> int:
    """Complete Google consent if needed, then prove the calendar works.

    Setup used to point at `simulate` for this, which cannot work: the
    simulator swaps the calendar for a fake precisely so a keyboard test never
    touches the real one, so the consent browser never opens and the first
    booking a real lead asks for is the first time anyone finds out the OAuth
    was never finished. This is the command that actually talks to Google.
    """
    from . import gcal

    if not cfg.google_credentials.is_file():
        print(f"No OAuth client at {cfg.google_credentials}\n", file=sys.stderr)
        print("Google Cloud Console → APIs & Services → Credentials →", file=sys.stderr)
        print("Create credentials → OAuth client ID → Desktop app → download", file=sys.stderr)
        print(f"the JSON and save it as {cfg.google_credentials}.", file=sys.stderr)
        print("Full walkthrough: PILOT.md §1 step 4.", file=sys.stderr)
        return 1

    fresh = not cfg.google_token.is_file()
    if fresh:
        print("No saved token — a browser will open for consent.")
        print("Sign in as the account that OWNS the meeting calendar.\n")

    try:
        slots = gcal.free_slots(cfg, datetime.now(tz=cfg.tz), limit=args.limit)
    except gcal.CalendarError as exc:
        print(f"\nCalendar is not usable: {exc}", file=sys.stderr)
        return 1

    print(f"calendar-check OK — token saved at {cfg.google_token}")
    print(f"  calendar: {cfg.google_calendar_id}")
    print(f"  meetings: {cfg.meeting_hour_start:02d}.00–{cfg.meeting_hour_end:02d}.00, "
          f"days {sorted(cfg.meeting_weekdays)} (0=Senin)")
    if slots:
        print(f"\nnext {len(slots)} free slot(s) the bot would offer:")
        for slot in slots:
            print(f"  {slot:%a %d %b %H.%M}")
    else:
        print("\nNo free slots in the next few days — the calendar is fully "
              "booked, or MEETING_HOUR_*/MEETING_WEEKDAYS exclude everything.")

    # Availability proves credentials, scope, and calendar id. It does not
    # prove Meet-link generation, which is a separate policy on some Workspace
    # accounts and degrades to an escalation rather than an error.
    print("\nThis checks availability only. The Meet link is generated at "
          "booking time —\nrehearse one against a throwaway GOOGLE_CALENDAR_ID "
          "before going live.")
    return 0


def replay_stats(turns, classify) -> dict:
    """Classify every real client turn; aggregate per file and overall.

    Pure so the replay report is testable without the CLI: `turns` is any
    iterable of chat_examples.ClientTurn, `classify` any text -> Intent.
    """
    intents_total: dict[str, int] = {}
    per_file: dict[str, dict] = {}
    for turn in turns:
        label = classify(turn.text).value
        intents_total[label] = intents_total.get(label, 0) + 1
        f = per_file.setdefault(turn.source, {"turns": 0, "unknown": 0, "intents": {}})
        f["turns"] += 1
        f["intents"][label] = f["intents"].get(label, 0) + 1
        if label == "unknown":
            f["unknown"] += 1

    total = sum(intents_total.values())
    unknown = intents_total.get("unknown", 0)
    return {
        "files": len(per_file),
        "turns": total,
        "unknown": unknown,
        "unknown_rate": round(unknown / total, 4) if total else 0.0,
        "intents": dict(sorted(intents_total.items(), key=lambda kv: -kv[1])),
        "per_file": per_file,
    }


def cmd_replay(args, cfg, store) -> int:
    """Backtest the intent rules against the real chat exports (ROADMAP 0.1).

    Reads nothing but chat-example/ and sends nothing — this is the measuring
    stick for every classifier change.
    """
    from . import chat_examples

    directory = args.dir or str(cfg.chat_examples_dir)
    turns = chat_examples.load_client_turns(directory)
    if not turns:
        print(f"no client turns found in {directory}/", file=sys.stderr)
        return 1

    if args.llm:
        classify = lambda text: intents.classify(text, cfg)  # noqa: E731
    else:
        classify = intents.classify_rules
    stats = replay_stats(turns, classify)

    if args.json:
        import json

        print(json.dumps(stats, indent=2, ensure_ascii=False))
        return 0

    print(f"replayed {stats['turns']} client turn(s) from {stats['files']} "
          f"transcript(s) in {directory}/  "
          f"({'rules + LLM fallback' if args.llm else 'rules only'})")
    print(f"UNKNOWN rate: {stats['unknown_rate']:.1%} "
          f"({stats['unknown']}/{stats['turns']})")
    print("\nintent distribution:")
    for label, count in stats["intents"].items():
        print(f"  {count:>5}  {label}")
    if args.per_file:
        print("\nper transcript:")
        for name, f in sorted(
            stats["per_file"].items(), key=lambda kv: -kv[1]["unknown"]
        ):
            print(f"  {f['unknown']:>3}/{f['turns']:<3} unknown  {name}")
    print("\nmachine-readable: python -m bd_bot replay --json")
    return 0


def cmd_met(args, cfg, store) -> int:
    jid = _normalise_jid(args.jid)
    convo = store.get(jid)
    if convo is None:
        print(f"unknown contact: {jid}")
        return 1
    def _work(engine) -> int:
        engine.apply(
            convo, flow.on_meeting_outcome(convo, args.joined, cfg, engine.now())
        )
        print(f"recorded: {'joined' if args.joined else 'no-show'}")
        return 0

    return _engine_send(cfg, store, _work)


def cmd_resolve_group(args, cfg, store) -> int:
    """Turn a chat.whatsapp.com invite link into the BD_GROUP_JID the engine
    needs (FLOWCHART.md §3.3). Connects once, resolves, optionally joins, and
    can write the JID straight into .env."""
    from . import groups

    try:
        code = groups.invite_code(args.link)
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 1

    action = "resolve + JOIN" if args.join else "resolve only (no join)"
    print(f"invite code: {code}")
    print(f"action:      {action}")
    print("Connecting to WhatsApp — scan the QR if prompted…\n")

    transport = _live_transport(cfg)
    try:
        ref = transport.connect_and_run(
            lambda client: groups.resolve_via_client(client, code, args.join)
        )
    except RuntimeError as exc:
        print(f"\nCould not resolve the group:\n\n{exc}\n", file=sys.stderr)
        return 1

    print("\nresolved group:")
    print(f"  JID:   {ref.jid}")
    if ref.name:
        print(f"  name:  {ref.name}")
    if ref.size:
        print(f"  size:  {ref.size} participant(s)")
    if ref.joined:
        print("  joined: yes")
    elif ref.join_error:
        # The JID is already resolved — a failed join (commonly: the account
        # is already a member) must not throw that away.
        print(f"  joined: no — join failed: {ref.join_error}")
        print("  (if the account is already in the group this is harmless; "
              "the JID above is still valid)")
    else:
        print("  joined: no (used --no-join)")
        print("  note: the bot must be a member to POST into the group — "
              "re-run without --no-join, or add its number by hand.")

    if not args.write_env:
        print(f"\nadd to .env manually:\n  BD_GROUP_JID={ref.jid}")
        return 0

    if not groups.is_group_jid(ref.jid):
        # parse_group_info degrades to str(proto) on an unexpected shape —
        # never let that blob become BD_GROUP_JID.
        print(f"\nNOT writing .env: {ref.jid!r} does not look like a group JID "
              "(expected digits@g.us). Set BD_GROUP_JID by hand.",
              file=sys.stderr)
        return 1

    env_path = Path(".env")
    text = env_path.read_text(encoding="utf-8") if env_path.is_file() else ""
    env_path.write_text(
        groups.set_env_var(text, "BD_GROUP_JID", ref.jid), encoding="utf-8"
    )
    print(f"\n✓ wrote BD_GROUP_JID={ref.jid} to {env_path}")
    return 0


def _own_number(client) -> str:
    """The paired number, read back off the client. "" if unavailable.

    neonize exposes this differently across versions, and none of it is worth
    failing a successful pairing over — hence the defensive walk.
    """
    for attr in ("get_me", "me"):
        source = getattr(client, attr, None)
        if source is None:
            continue
        try:
            device = source() if callable(source) else source
        except Exception:  # pragma: no cover - version-dependent
            continue
        jid = getattr(device, "JID", None) or getattr(device, "jid", None)
        user = getattr(jid, "User", "") if jid is not None else ""
        if user:
            return str(user)
    return ""


def _paired_number(session_db: Path) -> str:
    """The linked number from a neonize session, or "" if not paired.

    The session file existing proves nothing: neonize creates it the moment it
    connects, so an abandoned or timed-out pairing attempt leaves a complete
    schema behind with no device in it. whatsmeow writes a `whatsmeow_device`
    row only once pairing actually completes, which is the real signal.
    """
    if not session_db.is_file():
        return ""
    import sqlite3

    try:
        db = sqlite3.connect(f"file:{session_db}?mode=ro", uri=True)
        try:
            row = db.execute("SELECT jid FROM whatsmeow_device LIMIT 1").fetchone()
        finally:
            db.close()
    except sqlite3.Error:
        # Unreadable or an unexpected schema — treat as unpaired and let the
        # pairing run. Refusing to pair is the worse failure here.
        return ""
    if row is None:
        return ""
    # Stored as "628123456789:7@s.whatsapp.net" — user part, no device suffix.
    return str(row[0] or "").split("@")[0].split(":")[0]


def cmd_login(args, cfg, store) -> int:
    """Link the WhatsApp number by QR, then exit (PILOT.md §1 step 8).

    Pairing used to mean starting `run` — the whole serving loop — just to get
    a QR on screen. This does only the pairing, so the number can be linked
    before anything is live.
    """
    session_db = cfg.session_dir / "session.sqlite3"
    paired = _paired_number(session_db)

    if paired and not args.force:
        print(f"Already paired as {paired} — session at {session_db}")
        print("The bot reuses it on every run; you do not scan again.")
        print("\nTo link a different number:  python -m bd_bot login --force")
        return 0

    if args.force and paired:
        print(f"⚠️  --force deletes the session at {cfg.session_dir}/")
        print(f"   {paired} will stop being driven by this bot.")
        try:
            if input("continue? [y/N] ").strip().lower() != "y":
                print("aborted")
                return 1
        except EOFError:
            print("aborted: --force needs a terminal to confirm", file=sys.stderr)
            return 1
        for path in sorted(cfg.session_dir.glob("*")):
            if path.is_file():
                path.unlink()
        print("old session removed\n")

    print("Link the number that will RUN THE BOT — a secondary number, not the")
    print("main business line (PILOT.md §1 step 2: automation gets numbers banned).")
    print()

    transport = _live_transport(cfg)

    if args.phone:
        phone = contacts.normalise_phone(args.phone)
        if not phone:
            print(f"'{args.phone}' is not a valid Indonesian mobile number.",
                  file=sys.stderr)
            return 1

        def _show(code: str) -> None:
            print("\n" + "=" * 60)
            print(f"  PAIRING CODE:   {code}")
            print("=" * 60)
            print(f"  On the phone holding {phone}:")
            print("  WhatsApp → Settings → Linked Devices")
            print("  → Link a Device → Link with phone number instead")
            print("  Then enter the code above. It expires in a few minutes.\n")

        try:
            ok = transport.pair_with_code(phone, _show)
        except KeyboardInterrupt:
            print("\naborted — nothing was linked")
            return 1
        except RuntimeError as exc:
            print(f"\nPairing failed:\n\n{exc}\n", file=sys.stderr)
            return 1

        if not ok:
            print("\nThe code was never entered — nothing was linked.")
            print("Run the command again for a fresh one.")
            return 1

        number = _paired_number(session_db)
        print(f"\n✅ paired{f' as {number}' if number else ''}")
        print(f"Session saved to {cfg.session_dir}/ — you link once, not daily.")
        print("\nNext:  python -m bd_bot resolve-group <invite-link>")
        return 0

    print("On that phone:  WhatsApp → Settings → Linked Devices → Link a Device")
    print("The QR prints below and also opens as an image. Ctrl-C to abort.")
    print("Phone not nearby?  python -m bd_bot login --phone 628xxxxxxxxxx\n")

    try:
        number = transport.connect_and_run(_own_number)
    except KeyboardInterrupt:
        print("\naborted — nothing was linked")
        return 1
    except RuntimeError as exc:
        print(f"\nPairing failed:\n\n{exc}\n", file=sys.stderr)
        return 1

    print(f"\n✅ paired{f' as {number}' if number else ''}")
    print(f"Session saved to {cfg.session_dir}/ — you scan once, not daily.")
    print("\nNext:  python -m bd_bot resolve-group <invite-link>")
    return 0


def claim_session(cfg):
    """Take an exclusive lock on the WhatsApp session, or explain who has it.

    One pairing is one device: WhatsApp allows a single live connection per
    linked device, so a second process does not queue — it *replaces* the
    first, which then reconnects and replaces it back. The pair ping-pong each
    other off the socket and sends fail mid-flight with "websocket not
    connected". This happened during the pilot: a `run` that a Ctrl-C had not
    actually killed was still holding the session a day later, and the next
    run's blast died halfway through, delivering the greeting text with no
    attachments and no record of the conversation.

    The lock is an open file handle — the caller must keep the returned object
    alive for as long as it wants the session. The OS drops it when the
    process exits, however it exits, so a crash cannot leave it stuck.
    """
    import fcntl

    cfg.session_dir.mkdir(parents=True, exist_ok=True)
    handle = (cfg.session_dir / "run.lock").open("a+")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.seek(0)
        owner = handle.read().strip() or "unknown"
        handle.close()
        raise RuntimeError(
            f"another bd_bot process (pid {owner}) already holds this WhatsApp "
            f"session.\n\nTwo connections on one pairing knock each other "
            f"offline, so this one is refusing to start.\nStop the other one "
            f"first:\n    kill {owner}\n\nIf Ctrl-C appeared to stop it, check "
            f"anyway — it survives a Ctrl-C sent to a pipeline:\n"
            f"    ps -eo pid,lstart,args | grep '[b]d_bot'"
        ) from None
    handle.seek(0)
    handle.truncate()
    handle.write(str(os.getpid()))
    handle.flush()
    return handle


#: What the CRM copy says when a command needs a hand this copy does not have.
#: `apps/bd-brain` is the brain only (25 Sep 2026): the CRM's own bridges
#: deliver messages, so the neonize transport, the claw fleet and the
#: operator dashboard were left in `whatsapp-bot-bd`. The commands stay in
#: the parser so the two copies diff cleanly; they refuse with this instead
#: of a traceback.
_NO_TRANSPORT = (
    "This copy of bd_bot (apps/bd-brain in the CRM) has no WhatsApp transport:\n"
    "the CRM delivers messages through its own bridges and asks this bot what\n"
    "to say over HTTP (`python -m bd_bot brain-serve`). To pair a number, run a\n"
    "campaign or open the dashboard, use whatsapp-bot-bd. `simulate` works here."
)


def _live_transport(cfg):
    try:
        from .transport.whatsapp import WhatsAppTransport
    except ModuleNotFoundError as exc:
        raise RuntimeError(_NO_TRANSPORT) from exc

    transport = WhatsAppTransport(
        session_db=cfg.session_dir / "session.sqlite3",
        qr_png=cfg.session_dir / "qr.png",
    )
    # Parked on the transport so it lives exactly as long as the connection.
    transport._session_lock = claim_session(cfg)
    return transport


def cmd_brain_serve(args, cfg, store) -> int:
    """Serve the flow to the CRM over HTTP. See `brain_serve.py`."""
    from .brain_serve import serve

    return serve(cfg, host=args.host, port=args.port)


# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="bd_bot", description=__doc__)
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("simulate", help="interactive dry run")
    p.add_argument("--jid", default="")
    p.add_argument("--name", default="")
    p.add_argument("--brand", default="")
    p.add_argument(
        "--fresh",
        action="store_true",
        help="forget this conversation's previous state and start from the blast",
    )
    p.add_argument(
        "--demo",
        action="store_true",
        help="collapse every wait to seconds so /tick walks the ladder, "
             "each rung announced as '⏩ *1 hari kemudian*'",
    )
    p.add_argument(
        "--inbound",
        action="store_true",
        help="the brand writes first (ad lead, IG/FB DM): no opening is sent. "
             "Use --jid ig:<id> or fb:<id> to walk the DM → WhatsApp hand-off",
    )
    p.set_defaults(func=cmd_simulate)

    # The CRM's brain (25 Sep 2026). Defaults come from the environment so
    # `npm run dev:bd-brain` and a container need no flags; the flags exist
    # for running two brains side by side while comparing training rounds.
    p = sub.add_parser(
        "brain-serve",
        help="answer the CRM's /v1/step, /v1/book, /v1/propose-slots and "
             "/v1/comment-reply over HTTP (stateless; BD_BRAIN_SECRET required)",
    )
    p.add_argument("--host", default=os.getenv("BD_BRAIN_HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=int(os.getenv("BD_BRAIN_PORT") or 4321))
    p.set_defaults(func=cmd_brain_serve)

    p = sub.add_parser("blast", help="send the opening message")
    p.add_argument("jid", nargs="+")
    p.add_argument("--name", default="")
    p.add_argument("--brand", default="")
    p.add_argument(
        "--live", action="store_true", help="actually send (overrides DRY_RUN)"
    )
    p.add_argument(
        "--demo",
        action="store_true",
        help="testing: collapse every wait to seconds, announced in-chat "
             "as '⏩ *1 hari kemudian*' (see PILOT.md §3.2)",
    )
    p.set_defaults(func=cmd_blast)

    p = sub.add_parser("import", help="load the brand database from a CSV")
    p.add_argument("path", help="CSV with phone/name/brand columns")
    p.add_argument("--list", default="", help="label for this batch")
    p.add_argument("--show-skipped", type=int, default=10, metavar="N")
    p.set_defaults(func=cmd_import)

    p = sub.add_parser("campaign", help="blast the next batch from the database")
    p.add_argument(
        "--limit", type=int, default=0,
        help="how many to blast (default: whatever the daily cap allows)",
    )
    p.add_argument(
        "--dry-run", action="store_true",
        help="preview the batch — sends nothing, consumes nothing (default)",
    )
    p.add_argument(
        "--live", action="store_true", help="actually send (overrides DRY_RUN)"
    )
    p.set_defaults(func=cmd_campaign)

    p = sub.add_parser("report", help="deal / no-deal across the database")
    p.set_defaults(func=cmd_report)

    p = sub.add_parser(
        "calendar-check",
        help="finish Google consent and show the slots the bot would offer",
    )
    p.add_argument("--limit", type=int, default=5, metavar="N")
    p.set_defaults(func=cmd_calendar_check)

    p = sub.add_parser("tick", help="fire due timers once")
    p.set_defaults(func=cmd_tick)

    p = sub.add_parser("run", help="connect to WhatsApp and serve")
    p.add_argument(
        "--live",
        action="store_true",
        help="actually send messages (overrides DRY_RUN)",
    )
    p.add_argument(
        "--demo",
        action="store_true",
        help="testing: collapse every wait to seconds, announced in-chat "
             "as '⏩ *1 hari kemudian*' (see PILOT.md §3.2)",
    )
    p.add_argument(
        "--blast",
        nargs="+",
        default=[],
        metavar="NUMBER",
        help="open with these numbers as soon as the connection is up, then "
             "serve — one process for a whole test session",
    )
    p.add_argument("--name", default="", help="contact name for --blast")
    p.add_argument("--brand", default="", help="brand name for --blast")
    p.add_argument(
        "--api-port",
        type=int,
        default=0,
        metavar="PORT",
        help="serve the /mcnbd dashboard control API on this loopback port "
             "(status + QR + connect), plus a Stop/Run panel at /ui. Off "
             "unless given, so a plain `run` behaves exactly as before.",
    )
    p.add_argument(
        "--cs-id",
        default="",
        metavar="CS_ID",
        help="run as this /mcnbd CS row: gives the process its OWN WhatsApp "
             "session AND its own database, derived from the base paths. Use "
             "this for every CS number after the first.",
    )
    p.add_argument(
        "--outreach",
        nargs="?",
        const="http://127.0.0.1:4000/mcnbd/api",
        default="",
        metavar="API_BASE",
        help="send the opening to brands queued in the /mcnbd dashboard, one "
             "every OUTREACH_INTERVAL_SECONDS (default 70), inside the "
             "business-hours window. Off unless given.",
    )
    p.add_argument(
        "--meta",
        action="store_true",
        help="answer Instagram DMs, Facebook DMs and comments on both, "
             "instead of WhatsApp: serve the Meta webhook on "
             "META_WEBHOOK_PORT. Inbound only — there is no outreach on "
             "these channels, and a comment gets one short public reply and "
             "a move to DM. See docs/INBOUND.md.",
    )
    p.add_argument(
        "--claw",
        action="store_true",
        help="the hand is an Android phone, not a socket: serve the claw "
             "brain on CLAW_PORT instead of pairing a WhatsApp account. "
             "Nothing sends until a phone running claw/bin/agent.mjs "
             "registers and types it. See CLAW.md.",
    )
    p.set_defaults(func=cmd_run)

    p = sub.add_parser(
        "claw", help="what the phones are doing (see CLAW.md)"
    )
    p.add_argument("--queue", nargs="?", type=int, const=20, default=0,
                   metavar="N", help="also list the N tasks waiting")
    p.add_argument("--phone", default="", metavar="NUMBER",
                   help="which phone a command is for")
    p.add_argument("--pause", action="store_true",
                   help="tell that phone to stop sending (it keeps replying)")
    p.add_argument("--resume", action="store_true", help="let it send again")
    p.add_argument("--cap", type=int, default=None, metavar="N",
                   help="set that phone's daily opener cap")
    p.set_defaults(func=cmd_claw)

    p = sub.add_parser("status", help="show all conversations")
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("inbox", help="open escalations needing a human")
    p.set_defaults(func=cmd_inbox)

    p = sub.add_parser(
        "gcal-auth",
        help="authorise Google Calendar and write the token (needs a browser)",
    )
    p.set_defaults(func=cmd_gcal_auth)

    p = sub.add_parser(
        "gcal-check",
        help="verify the calendar token works, without writing anything",
    )
    p.set_defaults(func=cmd_gcal_check)

    p = sub.add_parser("resolve", help="mark an escalation handled")
    p.add_argument("id", type=int)
    p.set_defaults(func=cmd_resolve)

    p = sub.add_parser(
        "release",
        help="hand a conversation back to the bot after handover",
    )
    p.add_argument("contact", help="phone number, e.g. 6285172262609")
    p.add_argument(
        "--restart-ladder",
        action="store_true",
        help="also re-arm the warm follow-up timers",
    )
    p.set_defaults(func=cmd_release)

    p = sub.add_parser(
        "reclassify",
        help="re-read every stored message and fix the labels the dashboard counts")
    p.add_argument("--limit", type=int, default=0, help="only the first N chats")
    p.add_argument("--dry-run", action="store_true", help="show, change nothing")
    p.set_defaults(func=cmd_reclassify)

    p = sub.add_parser(
        "readings", help="what the bot has learned to recognise on its own")
    p.add_argument("--limit", type=int, default=40)
    p.add_argument("--forget", metavar="ID|all",
                   help="unlearn one case, so it is read fresh next time")
    p.set_defaults(func=cmd_readings)

    p = sub.add_parser("cache", help="show or clear the generated-reply cache")
    p.add_argument("--clear", action="store_true", help="forget all cached replies")
    p.set_defaults(func=cmd_cache)

    p = sub.add_parser(
        "kb-check",
        help="lint: every Rp amount in the message bank must be authorised",
    )
    p.set_defaults(func=cmd_kb_check)

    p = sub.add_parser(
        "replay", help="backtest intent rules against the chat exports"
    )
    p.add_argument("--dir", default="", help="export folder (default: CHAT_EXAMPLES_DIR)")
    p.add_argument("--json", action="store_true", help="machine-readable output")
    p.add_argument("--per-file", action="store_true", help="per-transcript breakdown")
    p.add_argument(
        "--llm", action="store_true",
        help="also use the Claude fallback for turns the rules can't place "
             "(costs API calls; needs ANTHROPIC_API_KEY)",
    )
    p.set_defaults(func=cmd_replay)

    p = sub.add_parser("met", help="record whether a client joined the meeting")
    p.add_argument("jid")
    p.add_argument("--joined", action="store_true")
    p.set_defaults(func=cmd_met)

    p = sub.add_parser("login", help="link the WhatsApp number by QR, then exit")
    p.add_argument(
        "--phone",
        default="",
        help="link by pairing code instead of QR — prints an 8-character code "
             "to type on that number's phone. Use when the phone is not next "
             "to this screen.",
    )
    p.add_argument(
        "--force",
        action="store_true",
        help="delete the existing session and pair a different number",
    )
    p.set_defaults(func=cmd_login)

    p = sub.add_parser(
        "resolve-group",
        help="turn a chat.whatsapp.com invite link into BD_GROUP_JID",
    )
    p.add_argument("link", help="the https://chat.whatsapp.com/<code> invite link")
    p.add_argument(
        "--join",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="join the group so the bot can post into it (default: join). "
             "--no-join only resolves the JID.",
    )
    p.add_argument(
        "--write-env",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="write BD_GROUP_JID into .env (default: write). "
             "--no-write-env just prints it.",
    )
    p.set_defaults(func=cmd_resolve_group)

    args = parser.parse_args(argv)
    _setup_logging(args.verbose)

    cfg = config.load()

    # --cs-id: one flag that makes a process fully its own CS number.
    #
    # Each CS runs its own bot, and each needs BOTH its own WhatsApp session and
    # its own database. Wiring those as two separate env overrides is what went
    # wrong on 2026-08-19: a second CS was launched with SESSION_DIR set but
    # DB_PATH forgotten, so two bots shared one database. The dashboard showed
    # both numbers an identical 452 chats, and the moment the second number
    # paired it would have fired the first number's 365 pending follow-ups from
    # the wrong WhatsApp account. Deriving both from one flag removes the chance
    # to set half of it.
    #
    # Applied here rather than in cmd_run because `store` below is opened from
    # cfg.db_path — changing it any later would open the shared database anyway.
    cs_id = getattr(args, "cs_id", "")
    if cs_id:
        cfg.session_dir = cfg.session_dir.with_name(f"{cfg.session_dir.name}-{cs_id}")
        cfg.db_path = cfg.db_path.with_name(
            f"{cfg.db_path.stem}-{cs_id}{cfg.db_path.suffix}"
        )
        log.info("CS %s — session %s, db %s", cs_id, cfg.session_dir, cfg.db_path)

    # `brain-serve` keeps nothing between calls — each request opens its own
    # store on `:memory:` — so it must not create data/bot.sqlite3 on the
    # way in (25 Sep 2026). Every other command still gets the shared store.
    store = None if args.command == "brain-serve" else Store(cfg.db_path)
    try:
        return args.func(args, cfg, store)
    except RuntimeError as exc:
        # Operator-facing refusals (session already held, transport missing)
        # carry their own instructions; a traceback buries them.
        print(f"\n{exc}\n", file=sys.stderr)
        return 1
    finally:
        if store is not None:
            store.close()


if __name__ == "__main__":
    sys.exit(main())
