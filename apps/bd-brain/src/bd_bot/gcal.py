"""Google Calendar + Meet.

FLOWCHART.md §3.3: check availability, offer slots, create the event, generate
the Meet link. Uses OAuth user credentials (not a service account) because Meet
link generation requires a real calendar owner.

First run opens a browser for consent and writes a token file; afterwards it
refreshes silently.
"""

from __future__ import annotations

import logging
import sys
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from .config import Settings

log = logging.getLogger(__name__)

SCOPES = ["https://www.googleapis.com/auth/calendar"]


@dataclass(slots=True)
class Booking:
    start: datetime
    end: datetime
    meet_link: str
    event_id: str
    html_link: str = ""


class CalendarError(RuntimeError):
    pass


def _service(cfg: Settings):
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from google_auth_oauthlib.flow import InstalledAppFlow
        from googleapiclient.discovery import build
    except ImportError as exc:
        raise CalendarError(
            "Google libraries missing. pip install google-api-python-client "
            "google-auth-httplib2 google-auth-oauthlib"
        ) from exc

    creds = None
    if cfg.google_token.is_file():
        creds = Credentials.from_authorized_user_file(str(cfg.google_token), SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            # A refresh token expires (unverified apps: 7 days) and can be
            # revoked from the Google account page. Google raises RefreshError
            # for both, which is NOT a CalendarError — so it sailed past every
            # `except CalendarError` in the engine and out of the inbound
            # handler, and a brand who agreed to a meeting got no reply at all
            # instead of the "jadwalnya sedang saya siapkan" fallback.
            try:
                creds.refresh(Request())
            except Exception as exc:
                raise CalendarError(
                    f"Google token at {cfg.google_token} is expired or revoked "
                    f"({exc}). Re-authorise with `python -m bd_bot gcal-auth` "
                    f"on a machine with a browser, then copy the token here."
                ) from exc
        else:
            if not cfg.google_credentials.is_file():
                raise CalendarError(
                    f"Missing OAuth client secrets at {cfg.google_credentials}. "
                    "Create an OAuth client (Desktop app) in Google Cloud Console "
                    "and download the JSON there."
                )
            # run_local_server opens a browser and blocks on a callback. On the
            # VPS there is neither, so this would hang the thread that called
            # it — the timer sweep, or a brand's reply — rather than failing.
            if not sys.stdin.isatty():
                raise CalendarError(
                    "No usable Google token and no interactive terminal to "
                    "authorise in. Run `python -m bd_bot gcal-auth` locally and "
                    f"copy the result to {cfg.google_token}."
                )
            flow = InstalledAppFlow.from_client_secrets_file(
                str(cfg.google_credentials), SCOPES
            )
            creds = flow.run_local_server(port=0)
        cfg.google_token.parent.mkdir(parents=True, exist_ok=True)
        cfg.google_token.write_text(creds.to_json(), encoding="utf-8")

    return build("calendar", "v3", credentials=creds, cache_discovery=False)


MIN_LEAD_HOURS = 2
"""Same-day booking is allowed (the real chats do it constantly), but never
closer than this — someone has to actually show up to the call."""


def candidate_slots(cfg: Settings, now: datetime, days_ahead: int = 14) -> list[datetime]:
    """Every whole hour in the meeting window: 09.00–19.00, one brand per hour.

    Includes today's remaining hours — the exported chats book same-day
    ("possible hari ini jam 17:00?") — with a small lead time.

    Two weeks ahead, not five days: brands ask for "minggu depan hari rabu",
    which is seven days out, and a five-day horizon had no slot to offer for
    it — so the request silently fell back to this week.
    """
    earliest = now + timedelta(hours=MIN_LEAD_HOURS)
    slots: list[datetime] = []
    for offset in range(0, days_ahead + 1):
        day: date = (now + timedelta(days=offset)).date()
        if day.weekday() not in cfg.meeting_weekdays:
            continue
        for hour in range(cfg.meeting_hour_start, cfg.meeting_hour_end):
            slot = datetime.combine(day, time(hour, 0), tzinfo=cfg.tz)
            if slot >= earliest:
                slots.append(slot)
    return slots


def free_slots(cfg: Settings, now: datetime, limit: int = 12) -> list[datetime]:
    """FLOWCHART.md §3.3 'CEK GOOGLE CALENDER' — filter out busy times.

    A slot already holding a meeting shows as busy, which is what enforces
    one brand per hour."""
    candidates = candidate_slots(cfg, now)
    if not candidates:
        return []
    try:
        svc = _service(cfg)
        window_start = candidates[0]
        window_end = candidates[-1] + timedelta(
            minutes=cfg.meeting_duration_minutes
        )
        body = {
            "timeMin": window_start.isoformat(),
            "timeMax": window_end.isoformat(),
            "items": [{"id": cfg.google_calendar_id}],
        }
        resp = svc.freebusy().query(body=body).execute()
        busy_raw = resp["calendars"][cfg.google_calendar_id].get("busy", [])
        busy = [
            (datetime.fromisoformat(b["start"]), datetime.fromisoformat(b["end"]))
            for b in busy_raw
        ]
    except Exception as exc:
        # Fail closed. Availability MUST come from the calendar — guessing
        # "probably free" invites a double booking, and the invite email goes
        # out the moment we book.
        raise CalendarError(f"free/busy lookup failed: {exc}") from exc

    out: list[datetime] = []
    for slot in candidates:
        slot_end = slot + timedelta(minutes=cfg.meeting_duration_minutes)
        if any(slot < b_end and b_start < slot_end for b_start, b_end in busy):
            continue
        out.append(slot)
        if len(out) >= limit:
            break
    return out


def book(
    cfg: Settings,
    start: datetime,
    summary: str,
    description: str = "",
    attendee_email: str = "",
) -> Booking:
    """Create the event and generate a Meet link."""
    svc = _service(cfg)
    end = start + timedelta(minutes=cfg.meeting_duration_minutes)

    event: dict = {
        "summary": summary,
        "description": description,
        "start": {"dateTime": start.isoformat(), "timeZone": str(cfg.tz)},
        "end": {"dateTime": end.isoformat(), "timeZone": str(cfg.tz)},
        "conferenceData": {
            "createRequest": {
                "requestId": f"bd-{int(start.timestamp())}",
                "conferenceSolutionKey": {"type": "hangoutsMeet"},
            }
        },
    }
    # The brand first, then whoever the BD team wants on every booking. Order
    # is what Google shows on the invite. Deduplicated case-insensitively so a
    # CC address that is also the brand's does not appear twice.
    attendees: list[str] = []
    for email in (attendee_email, *cfg.meeting_cc_emails):
        email = (email or "").strip()
        if email and email.lower() not in {a.lower() for a in attendees}:
            attendees.append(email)
    if attendees:
        event["attendees"] = [{"email": a} for a in attendees]

    try:
        created = (
            svc.events()
            .insert(
                calendarId=cfg.google_calendar_id,
                body=event,
                conferenceDataVersion=1,
                # "all" is what actually emails the invite out. Keyed on the
                # full attendee list, not just the brand: a booking with only
                # CC addresses still has someone who needs telling.
                sendUpdates="all" if attendees else "none",
            )
            .execute()
        )
    except CalendarError:
        raise
    except Exception as exc:
        # A rejected attendee address, a quota, an expired grant mid-call:
        # googleapiclient raises HttpError, which is not a CalendarError, so
        # this used to escape `_book`'s handler and leave a brand who had just
        # agreed to a meeting with no reply at all. Now it takes the
        # BOOKING_DELAY path — acknowledge, escalate, alert.
        raise CalendarError(f"could not create the event: {exc}") from exc

    link = created.get("hangoutLink", "")
    if not link:
        for entry in created.get("conferenceData", {}).get("entryPoints", []):
            if entry.get("entryPointType") == "video":
                link = entry.get("uri", "")
                break
    if not link:
        raise CalendarError("event created but no Meet link was returned")

    return Booking(
        start=start,
        end=end,
        meet_link=link,
        event_id=created["id"],
        html_link=created.get("htmlLink", ""),
    )


#: Meet link handed out by the simulated calendar. Obviously not a real room —
#: a tester who clicks it should find nothing, not somebody else's meeting.
SIMULATED_MEET_LINK = "https://meet.google.com/sim-ulasi-aja"


def use_simulated() -> None:
    """Swap the module's two entry points for in-memory fakes.

    Testing only. `use_real` puts them back — the swap used to be permanent
    for the life of the process, which is fine for the two callers below but
    leaked between tests: once any test had simulated the calendar, every
    later test in the same session got the fake and could no longer check
    what the real code does when Google fails. Two callers:
    `simulate`, where touching the real calendar would be plainly wrong, and a
    demo run on a host with no Google credentials — there the alternative is
    every tester hitting the "jadwalnya sedang saya siapkan" degradation path
    and none of them ever seeing the booking flow they were asked to grade.

    13.00 is held busy on purpose so the "slot penuh" branch can be walked.
    """
    global free_slots, book

    def _free_slots(cfg: Settings, now: datetime, limit: int = 12) -> list[datetime]:
        return [s for s in candidate_slots(cfg, now) if s.hour != 13][:limit]

    def _book(
        cfg: Settings,
        start: datetime,
        summary: str,
        description: str = "",
        attendee_email: str = "",
    ) -> Booking:
        log.info(
            "[simulated calendar] booked %r at %s%s",
            summary,
            start.strftime("%d %b %H:%M"),
            f" — invite to {attendee_email}" if attendee_email else "",
        )
        return Booking(
            start=start,
            end=start + timedelta(minutes=cfg.meeting_duration_minutes),
            meet_link=SIMULATED_MEET_LINK,
            event_id="simulated",
        )

    free_slots = _free_slots
    book = _book


#: The real implementations, captured before anything can swap them out.
_REAL_FREE_SLOTS = free_slots
_REAL_BOOK = book


def use_real() -> None:
    """Undo `use_simulated`. Only tests need this."""
    global free_slots, book
    free_slots = _REAL_FREE_SLOTS
    book = _REAL_BOOK
