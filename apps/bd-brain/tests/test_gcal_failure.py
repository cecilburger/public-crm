"""What happens to a conversation when Google Calendar is not usable.

The failure is invisible from outside: an expired token leaves the bot
chatting happily, and only a brand who agrees to a meeting finds out. On
12 Aug 2026 the server's token was expired or revoked and nothing said so.

The rule these cover: every calendar failure must arrive as a CalendarError,
because that is the only thing the engine catches. A RefreshError from a dead
token, or an HttpError from a rejected attendee address, used to sail past
`except gcal.CalendarError` and out of the inbound handler — the brand got no
reply at all instead of the holding message.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bd_bot import gcal  # noqa: E402
from bd_bot.config import Settings  # noqa: E402
from bd_bot.engine import Engine  # noqa: E402
from bd_bot.models import Conversation, Node  # noqa: E402
from bd_bot.storage import Store  # noqa: E402
from bd_bot.transport.mock import MockTransport  # noqa: E402

JID = "628123@s.whatsapp.net"


class RefreshError(Exception):
    """Stand-in for google.auth.exceptions.RefreshError."""


class HttpError(Exception):
    """Stand-in for googleapiclient.errors.HttpError."""


@pytest.fixture(autouse=True)
def real_calendar():
    """Undo any earlier `use_simulated`.

    It swaps the module's entry points globally, so a test that ran first and
    simulated the calendar would leave these tests checking the fake — they
    would pass alone and pass vacuously in the suite.
    """
    gcal.use_real()
    yield


@pytest.fixture
def bot(tmp_path):
    cfg = Settings()
    cfg.db_path = tmp_path / "gc.sqlite3"
    cfg.dry_run = False
    cfg.require_approval = False
    cfg.auto_reply = True
    cfg.min_seconds_between_sends = 0
    cfg.use_llm_replies = False
    cfg.demo_mode = False
    cfg.company_profile_pdf = tmp_path / "profile.pdf"
    cfg.company_profile_pdf.write_bytes(b"%PDF-1.4 fake")
    cfg.opening_dir = tmp_path / "opening"
    cfg.opening_dir.mkdir(exist_ok=True)
    (cfg.opening_dir / "deck.pdf").write_bytes(b"%PDF-1.4 fake deck")
    store = Store(cfg.db_path)
    transport = MockTransport(echo=False)
    eng = Engine(cfg, store, transport)
    eng.within_send_window = lambda when: True
    transport.start(eng.handle_inbound)
    yield eng, transport, cfg, store
    store.close()


# -- everything must surface as CalendarError ------------------------------


def test_a_dead_token_is_a_calendar_error(monkeypatch, tmp_path):
    """The 12 Aug case: 'Token has been expired or revoked'."""
    cfg = Settings()
    cfg.google_token = tmp_path / "token.json"
    cfg.google_token.write_text("{}")
    cfg.google_credentials = tmp_path / "creds.json"
    cfg.google_credentials.write_text("{}")

    class DeadCreds:
        valid = False
        expired = True
        refresh_token = "rt"

        def refresh(self, _request):
            raise RefreshError("invalid_grant: Token has been expired or revoked.")

    # _service imports Credentials inside the function, so the real class is
    # the thing to patch — patching a name on the gcal module would miss it.
    import google.oauth2.credentials as goc
    monkeypatch.setattr(
        goc.Credentials, "from_authorized_user_file",
        staticmethod(lambda *a, **k: DeadCreds()),
    )

    with pytest.raises(gcal.CalendarError) as err:
        gcal._service(cfg)
    assert "expired or revoked" in str(err.value)
    assert "gcal-auth" in str(err.value), "must say how to fix it"


def test_free_slots_wraps_everything(monkeypatch):
    cfg = Settings()
    monkeypatch.setattr(gcal, "_service",
                        lambda c: (_ for _ in ()).throw(HttpError("500 backend")))
    with pytest.raises(gcal.CalendarError):
        gcal.free_slots(cfg, datetime.now(cfg.tz))


def test_book_wraps_api_errors(monkeypatch):
    """A rejected attendee address must not escape as HttpError."""
    cfg = Settings()

    class Svc:
        def events(self):
            return self

        def insert(self, **_kw):
            return self

        def execute(self):
            raise HttpError("400 Invalid attendee email")

    monkeypatch.setattr(gcal, "_service", lambda c: Svc())
    with pytest.raises(gcal.CalendarError) as err:
        gcal.book(cfg, datetime.now(cfg.tz), "Meeting",
                  attendee_email="not-an-email")
    assert "could not create the event" in str(err.value)


def test_a_calendar_error_is_not_double_wrapped(monkeypatch):
    cfg = Settings()
    monkeypatch.setattr(
        gcal, "_service",
        lambda c: (_ for _ in ()).throw(gcal.CalendarError("token gone")))
    with pytest.raises(gcal.CalendarError) as err:
        gcal.book(cfg, datetime.now(cfg.tz), "Meeting")
    assert str(err.value) == "token gone"


# -- the conversation survives it ------------------------------------------


def test_agreement_still_gets_an_answer_when_the_calendar_is_dead(bot, monkeypatch):
    """The lead agreed to a meeting. Silence here loses them."""
    eng, transport, cfg, store = bot
    store.upsert(Conversation(jid=JID, node=Node.SCHEDULING, name="Cika",
                              brand="BrandCo"))
    monkeypatch.setattr(
        gcal, "free_slots",
        lambda c, n, limit=12: (_ for _ in ()).throw(
            gcal.CalendarError("token expired")))
    transport.sent.clear()
    eng._propose_slots(store.get(JID), _fallback(), eng.now())
    assert transport.sent, "a dead calendar left the brand with no reply"


def test_a_dead_token_does_not_escape_the_inbound_handler(bot, monkeypatch):
    """The regression that mattered: RefreshError propagating out of a reply."""
    eng, transport, cfg, store = bot
    store.upsert(Conversation(jid=JID, node=Node.SCHEDULING, name="Cika",
                              brand="BrandCo"))

    def dead(*_a, **_k):
        raise gcal.CalendarError("Token has been expired or revoked")

    monkeypatch.setattr(gcal, "free_slots", dead)
    monkeypatch.setattr(gcal, "book", dead)
    # Must not raise.
    eng.handle_inbound(JID, "Cika", "boleh kak, kita meeting aja")


def _fallback():
    """The open "hari dan jam berapa?" ask `_propose_slots` falls back to."""
    from bd_bot import templates
    return templates.render(
        "REPLY_SETUJU", Conversation(jid=JID, brand="BrandCo"), Settings()
    )


# -- who gets invited -------------------------------------------------------
# MEETING_CC_EMAILS puts the BD team on every booking, so the meeting lands in
# their own calendar without anyone sharing one by hand.


class _Capture:
    """Records the event body `book` would send to Google."""

    def __init__(self):
        self.body = None

    def events(self):
        return self

    def insert(self, **kw):
        self.body = kw["body"]
        self.send_updates = kw["sendUpdates"]
        return self

    def execute(self):
        return {"id": "evt", "hangoutLink": "https://meet.google.com/abc-defg-hij"}


@pytest.fixture
def capture(monkeypatch):
    svc = _Capture()
    monkeypatch.setattr(gcal, "_service", lambda c: svc)
    return svc


def _book(cfg, capture, email=""):
    gcal.book(cfg, datetime.now(cfg.tz), "Meeting", attendee_email=email)
    return [a["email"] for a in (capture.body.get("attendees") or [])]


def test_the_brand_comes_first(capture):
    cfg = Settings()
    cfg.meeting_cc_emails = ("bd@mcnasia.net",)
    assert _book(cfg, capture, "brand@example.com") == [
        "brand@example.com", "bd@mcnasia.net",
    ]


def test_cc_addresses_are_invited_even_with_no_brand_email(capture):
    cfg = Settings()
    cfg.meeting_cc_emails = ("bd@mcnasia.net",)
    assert _book(cfg, capture) == ["bd@mcnasia.net"]
    assert capture.send_updates == "all", "nobody would have been emailed"


def test_no_cc_configured_behaves_as_before(capture):
    cfg = Settings()
    cfg.meeting_cc_emails = ()
    assert _book(cfg, capture, "brand@example.com") == ["brand@example.com"]


def test_nobody_to_invite_sends_no_mail(capture):
    cfg = Settings()
    cfg.meeting_cc_emails = ()
    assert _book(cfg, capture) == []
    assert capture.send_updates == "none"


def test_a_cc_that_is_also_the_brand_is_not_duplicated(capture):
    cfg = Settings()
    cfg.meeting_cc_emails = ("Brand@Example.com",)
    assert _book(cfg, capture, "brand@example.com") == ["brand@example.com"]


def test_email_parsing(monkeypatch):
    from bd_bot.config import _env_emails

    monkeypatch.setenv("X", "a@b.com, c@d.com ,, a@b.com")
    assert _env_emails("X") == ("a@b.com", "c@d.com"), "order kept, dupes dropped"
    monkeypatch.setenv("X", "not-an-email, ok@x.com")
    assert _env_emails("X") == ("ok@x.com",)
    monkeypatch.delenv("X")
    assert _env_emails("X") == ()
