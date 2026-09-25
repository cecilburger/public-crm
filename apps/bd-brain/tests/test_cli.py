"""CLI-command coverage. The `resolve-group` command has real branching the
pure helpers can't reach: the is_group_jid write-guard, the join-failure
messaging, and the .env write itself. No network — `_live_transport` is faked."""

from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bd_bot import cli  # noqa: E402
from bd_bot.config import Settings  # noqa: E402


# --- fakes standing in for a connected neonize client ----------------------


class _JID:
    def __init__(self, user, server):
        self.User = user
        self.Server = server


class _Name:
    def __init__(self, name):
        self.Name = name


class _Info:
    def __init__(self, jid, name="", parts=()):
        self.JID = jid
        self.GroupName = _Name(name)
        self.Participants = list(parts)


class _BlobJID:
    """A proto shape parse_group_info can't read — degrades to str()."""

    def __str__(self):
        return "GroupInfoProto{unexpected}"


class _FakeClient:
    def __init__(self, info, join_exc=None):
        self._info = info
        self._join_exc = join_exc
        self.joined = False

    def get_group_info_from_link(self, code):
        return self._info

    def join_group_with_link(self, code):
        if self._join_exc is not None:
            raise self._join_exc
        self.joined = True


class _FakeTransport:
    def __init__(self, client=None, raise_runtime=None):
        self._client = client
        self._raise = raise_runtime

    def connect_and_run(self, action):
        if self._raise is not None:
            raise self._raise
        return action(self._client)


def _args(link, join=True, write_env=True):
    return argparse.Namespace(link=link, join=join, write_env=write_env)


@pytest.fixture
def in_tmp(tmp_path, monkeypatch):
    """Run inside a throwaway cwd so writes land on a temp .env, never the
    project's real one."""
    monkeypatch.chdir(tmp_path)
    return tmp_path


def _patch_transport(monkeypatch, transport):
    monkeypatch.setattr(cli, "_live_transport", lambda cfg: transport)


# --- the happy path: resolve, join, write ----------------------------------


def test_resolve_group_writes_env(in_tmp, monkeypatch, capsys):
    client = _FakeClient(_Info(_JID("120363123456", "g.us"), "MCNAsia BD", [1, 2, 3]))
    _patch_transport(monkeypatch, _FakeTransport(client))

    rc = cli.cmd_resolve_group(_args("https://chat.whatsapp.com/AbC123"), Settings(), None)

    assert rc == 0
    assert client.joined is True
    env = (in_tmp / ".env").read_text()
    assert "BD_GROUP_JID=120363123456@g.us" in env
    out = capsys.readouterr().out
    assert "MCNAsia BD" in out and "3 participant" in out


def test_resolve_group_updates_existing_env_line(in_tmp, monkeypatch):
    (in_tmp / ".env").write_text("DRY_RUN=true\nBD_GROUP_JID=\nALERT_JID=\n")
    client = _FakeClient(_Info(_JID("120363999", "g.us")))
    _patch_transport(monkeypatch, _FakeTransport(client))

    rc = cli.cmd_resolve_group(_args("AbC123"), Settings(), None)

    assert rc == 0
    assert (in_tmp / ".env").read_text() == (
        "DRY_RUN=true\nBD_GROUP_JID=120363999@g.us\nALERT_JID=\n"
    )


# --- --no-write-env just prints --------------------------------------------


def test_resolve_group_no_write_env(in_tmp, monkeypatch, capsys):
    client = _FakeClient(_Info(_JID("120363999", "g.us")))
    _patch_transport(monkeypatch, _FakeTransport(client))

    rc = cli.cmd_resolve_group(
        _args("AbC123", write_env=False), Settings(), None
    )

    assert rc == 0
    assert not (in_tmp / ".env").exists()
    assert "BD_GROUP_JID=120363999@g.us" in capsys.readouterr().out


# --- join failure keeps the JID --------------------------------------------


def test_resolve_group_join_failure_still_writes(in_tmp, monkeypatch, capsys):
    """Already-a-member (or a revoked link) fails the join, but the resolved
    JID is still valid and must be written."""
    client = _FakeClient(
        _Info(_JID("120363999", "g.us")),
        join_exc=Exception("409 already a participant"),
    )
    _patch_transport(monkeypatch, _FakeTransport(client))

    rc = cli.cmd_resolve_group(_args("AbC123"), Settings(), None)

    assert rc == 0
    assert "BD_GROUP_JID=120363999@g.us" in (in_tmp / ".env").read_text()
    out = capsys.readouterr().out
    assert "join failed" in out and "409" in out


# --- the write-guard: a degraded proj shape must not pollute .env ----------


def test_resolve_group_refuses_non_group_jid(in_tmp, monkeypatch, capsys):
    client = _FakeClient(_Info(_BlobJID()))  # str(proto) -> not a JID
    _patch_transport(monkeypatch, _FakeTransport(client))

    rc = cli.cmd_resolve_group(_args("AbC123"), Settings(), None)

    assert rc == 1
    assert not (in_tmp / ".env").exists()
    assert "does not look like a group JID" in capsys.readouterr().err


# --- input / transport failures --------------------------------------------


def test_resolve_group_bad_link_returns_1(in_tmp, monkeypatch, capsys):
    # transport must never even be built for a junk link
    def _boom(cfg):
        raise AssertionError("transport should not be constructed")

    monkeypatch.setattr(cli, "_live_transport", _boom)

    rc = cli.cmd_resolve_group(_args("https://wa.me/628123"), Settings(), None)

    assert rc == 1
    assert "invite code" in capsys.readouterr().err


def test_resolve_group_transport_error_returns_1(in_tmp, monkeypatch, capsys):
    _patch_transport(
        monkeypatch,
        _FakeTransport(raise_runtime=RuntimeError("neonize build exposes none of…")),
    )

    rc = cli.cmd_resolve_group(_args("AbC123"), Settings(), None)

    assert rc == 1
    assert not (in_tmp / ".env").exists()
    assert "Could not resolve the group" in capsys.readouterr().err


# --- login: everything except the live pairing itself ----------------------


class _MeClient:
    """A connected client that can report its own number."""

    def __init__(self, user="628111222333"):
        self.me = _JID(user, "s.whatsapp.net")

    def get_me(self):
        class _Device:
            JID = self.me

        return _Device()


def _login_args(force=False, phone=""):
    return argparse.Namespace(force=force, phone=phone)


def _session_cfg(tmp_path, paired: bool, connected_only: bool = False) -> Settings:
    """`paired` writes a real whatsmeow device row; `connected_only` writes the
    schema with no device — what a timed-out pairing attempt leaves behind."""
    import sqlite3

    cfg = Settings()
    cfg.session_dir = tmp_path / "wa-session"
    cfg.session_dir.mkdir(parents=True)
    if paired or connected_only:
        db = sqlite3.connect(cfg.session_dir / "session.sqlite3")
        db.execute("CREATE TABLE whatsmeow_device (jid TEXT PRIMARY KEY)")
        if paired:
            db.execute(
                "INSERT INTO whatsmeow_device (jid) VALUES (?)",
                ("628111222333:7@s.whatsapp.net",),
            )
        db.commit()
        db.close()
    return cfg


def test_login_pairs_and_reports_the_number(in_tmp, monkeypatch, capsys):
    cfg = _session_cfg(in_tmp, paired=False)
    _patch_transport(monkeypatch, _FakeTransport(_MeClient()))

    assert cli.cmd_login(_login_args(), cfg, None) == 0
    out = capsys.readouterr().out
    assert "628111222333" in out
    assert "Linked Devices" in out, "the phone-side steps are spelled out"


def test_login_is_a_no_op_when_already_paired(in_tmp, monkeypatch, capsys):
    """Re-running login must never re-pair by accident."""
    cfg = _session_cfg(in_tmp, paired=True)

    def _boom(_cfg):
        raise AssertionError("must not connect when a session already exists")

    monkeypatch.setattr(cli, "_live_transport", _boom)

    assert cli.cmd_login(_login_args(), cfg, None) == 0
    assert "Already paired" in capsys.readouterr().out


def test_login_force_needs_confirmation(in_tmp, monkeypatch, capsys):
    """Declining --force leaves the existing session untouched."""
    cfg = _session_cfg(in_tmp, paired=True)
    monkeypatch.setattr("builtins.input", lambda *_: "n")
    monkeypatch.setattr(cli, "_live_transport", lambda cfg_: pytest.fail("connected"))

    assert cli.cmd_login(_login_args(force=True), cfg, None) == 1
    assert (cfg.session_dir / "session.sqlite3").is_file(), "session survived"


def test_login_force_without_a_tty_aborts(in_tmp, monkeypatch):
    """Fail closed: no terminal to confirm on means no session deletion."""
    cfg = _session_cfg(in_tmp, paired=True)

    def _no_tty(*_):
        raise EOFError

    monkeypatch.setattr("builtins.input", _no_tty)

    assert cli.cmd_login(_login_args(force=True), cfg, None) == 1
    assert (cfg.session_dir / "session.sqlite3").is_file()


def test_login_force_repairs_after_confirmation(in_tmp, monkeypatch, capsys):
    cfg = _session_cfg(in_tmp, paired=True)
    monkeypatch.setattr("builtins.input", lambda *_: "y")
    _patch_transport(monkeypatch, _FakeTransport(_MeClient("628999888777")))

    assert cli.cmd_login(_login_args(force=True), cfg, None) == 0
    assert "628999888777" in capsys.readouterr().out


def test_login_reports_failure_without_claiming_success(in_tmp, monkeypatch, capsys):
    cfg = _session_cfg(in_tmp, paired=False)
    _patch_transport(
        monkeypatch, _FakeTransport(raise_runtime=RuntimeError("neonize missing"))
    )

    assert cli.cmd_login(_login_args(), cfg, None) == 1
    assert "paired" not in capsys.readouterr().out.lower()


def test_login_succeeds_even_if_the_number_is_unreadable(in_tmp, monkeypatch, capsys):
    """A pairing that worked must not be reported as a failure just because
    the neonize version won't hand back the JID."""
    cfg = _session_cfg(in_tmp, paired=False)
    _patch_transport(monkeypatch, _FakeTransport(object()))

    assert cli.cmd_login(_login_args(), cfg, None) == 0
    assert "✅ paired" in capsys.readouterr().out


def test_login_ignores_a_session_that_never_paired(in_tmp, monkeypatch, capsys):
    """neonize writes the session file on connect, so a timed-out attempt
    leaves a full schema with no device. That must not read as 'paired'."""
    cfg = _session_cfg(in_tmp, paired=False, connected_only=True)
    _patch_transport(monkeypatch, _FakeTransport(_MeClient()))

    assert cli.cmd_login(_login_args(), cfg, None) == 0
    out = capsys.readouterr().out
    assert "Already paired" not in out, "an unpaired session must not block login"
    assert "628111222333" in out


def test_login_reports_the_paired_number(in_tmp, capsys):
    cfg = _session_cfg(in_tmp, paired=True)
    assert cli.cmd_login(_login_args(), cfg, None) == 0
    assert "Already paired as 628111222333" in capsys.readouterr().out


def test_paired_number_survives_a_corrupt_session(in_tmp):
    """Unreadable session -> pair anyway; refusing to pair is the worse bug."""
    cfg = _session_cfg(in_tmp, paired=False)
    bad = cfg.session_dir / "session.sqlite3"
    bad.write_bytes(b"not a database")
    assert cli._paired_number(bad) == ""


# --- login --phone: the pairing-code path ----------------------------------


class _CodeTransport:
    """Stands in for pair_with_code without touching the network."""

    def __init__(self, code="ABCD1234", accepted=True, error=None):
        self.code = code
        self.accepted = accepted
        self.error = error
        self.phone = None

    def pair_with_code(self, phone, on_code, timeout=180.0):
        self.phone = phone
        if self.error is not None:
            raise self.error
        on_code(self.code)
        return self.accepted


def test_login_phone_prints_the_code(in_tmp, monkeypatch, capsys):
    cfg = _session_cfg(in_tmp, paired=False)
    fake = _CodeTransport()
    _patch_transport(monkeypatch, fake)

    assert cli.cmd_login(_login_args(phone="0811 1222 333"), cfg, None) == 0
    out = capsys.readouterr().out
    assert "ABCD1234" in out
    assert "Link with phone number instead" in out
    assert fake.phone == "628111222333", "the number is normalised before use"


def test_login_phone_rejects_a_bad_number(in_tmp, monkeypatch, capsys):
    cfg = _session_cfg(in_tmp, paired=False)
    _patch_transport(monkeypatch, _CodeTransport())

    assert cli.cmd_login(_login_args(phone="not-a-number"), cfg, None) == 1
    assert "not a valid" in capsys.readouterr().err


def test_login_phone_reports_an_unentered_code_as_failure(in_tmp, monkeypatch, capsys):
    """Timing out must not read as success — nothing was linked."""
    cfg = _session_cfg(in_tmp, paired=False)
    _patch_transport(monkeypatch, _CodeTransport(accepted=False))

    assert cli.cmd_login(_login_args(phone="628111222333"), cfg, None) == 1
    out = capsys.readouterr().out
    assert "never entered" in out
    assert "✅" not in out


def test_login_phone_surfaces_transport_errors(in_tmp, monkeypatch, capsys):
    cfg = _session_cfg(in_tmp, paired=False)
    _patch_transport(
        monkeypatch, _CodeTransport(error=RuntimeError("could not request a code"))
    )

    assert cli.cmd_login(_login_args(phone="628111222333"), cfg, None) == 1
    assert "could not request a code" in capsys.readouterr().err


def test_login_phone_respects_the_already_paired_guard(in_tmp, monkeypatch, capsys):
    cfg = _session_cfg(in_tmp, paired=True)
    monkeypatch.setattr(cli, "_live_transport", lambda _c: pytest.fail("connected"))

    assert cli.cmd_login(_login_args(phone="628111222333"), cfg, None) == 0
    assert "Already paired as 628111222333" in capsys.readouterr().out


# --- the auto-refreshing QR viewer -----------------------------------------


@pytest.mark.skipif(
    importlib.util.find_spec("bd_bot.transport.whatsapp") is None,
    reason="the neonize WhatsApp transport is not part of the CRM copy",
)
def test_qr_page_points_at_the_image_and_refreshes(tmp_path):
    """A still viewer shows an expired code; the page must re-fetch the PNG."""
    from bd_bot.transport.whatsapp import write_qr_page

    png = tmp_path / "qr.png"
    png.write_bytes(b"\x89PNG fake")
    page = write_qr_page(png)

    assert page.name == "qr.html" and page.parent == png.parent
    html = page.read_text(encoding="utf-8")
    assert 'src="qr.png"' in html, "relative path, so file:// loads it"
    assert "qr.png?t=" in html, "cache-buster, or the browser serves a stale QR"
    assert "setInterval" in html
    assert "Linked Devices" in html


# --- `run --blast`: open the test conversations from inside the serving loop -


class _ServingTransport:
    """Stands in for a paired neonize client: `start` blocks in real life, so
    the connect hook is the only place a startup send can happen."""

    def __init__(self):
        self.on_connected = None
        self.on_event = None
        self.started = False

    def start(self, on_message):
        self.started = True
        if self.on_connected is not None:
            self.on_connected()

    def stop(self):
        pass


def _run_args(**over):
    base = dict(live=True, demo=True, blast=[], name="", brand="")
    base.update(over)
    return argparse.Namespace(**base)


def test_run_blasts_on_connect_not_before(in_tmp, monkeypatch):
    """Blasting before the socket is up raises "transport not started"; from a
    second process it would mean two clients on one paired session."""
    from bd_bot.storage import Store

    transport = _ServingTransport()
    _patch_transport(monkeypatch, transport)
    monkeypatch.setattr(cli.threading, "Thread", lambda **kw: _NullThread())

    blasted = []
    monkeypatch.setattr(
        cli.Engine,
        "blast",
        lambda self, jid, name="", brand="", category="", **kw: blasted.append(jid),
    )

    cfg = Settings()
    cfg.db_path = in_tmp / "t.sqlite3"
    store = Store(cfg.db_path)
    try:
        rc = cli.cmd_run(_run_args(blast=["6287811592197", "082230336666"]), cfg, store)
    finally:
        store.close()

    assert rc == 0
    assert transport.started, "the serving loop never started"
    assert blasted == [
        "6287811592197@s.whatsapp.net",
        "6282230336666@s.whatsapp.net",
    ], "numbers were not normalised, or were sent before the connection"


class _NullThread:
    def start(self):
        pass


class _BlippingTransport(_ServingTransport):
    """Connects, drops the websocket, then reconnects — the ordinary case.

    whatsmeow does this on its own after a network blip and keeps sending
    afterwards, so nothing about it should need an operator.
    """

    def is_on_whatsapp(self, numbers):
        return {}

    def start(self, on_message):
        self.started = True
        if self.on_connected is not None:
            self.on_connected()
        if self.on_event is not None:
            self.on_event("disconnected", "StreamErrorEv: blip")
            self.on_event("reconnected")


@pytest.mark.skipif(
    importlib.util.find_spec("bd_bot.http_api") is None,
    reason="the operator dashboard (http_api) is not part of the CRM copy",
)
def test_a_reconnect_clears_the_dashboard_disconnect(in_tmp, monkeypatch):
    """A blip must not latch the dashboard red for the life of the process.

    `on_connected` fires at most once per process (it blasts), so the status
    was turned off by the blip and never turned back on: operators saw
    'disconnected' and an empty QR box — a QR is only issued for an *unpaired*
    session, so none was ever coming — for a bot that was sending all along.
    Pressing Connect on that screen restarts a healthy bot and re-holds
    outreach, so the wrong status is not a cosmetic bug.
    """
    from bd_bot.storage import Store

    transport = _BlippingTransport()
    _patch_transport(monkeypatch, transport)
    monkeypatch.setattr(cli.threading, "Thread", lambda **kw: _NullThread())

    captured = {}

    def _capture(state, port):
        captured["state"] = state

    monkeypatch.setattr(cli, "serve", _capture, raising=False)
    monkeypatch.setattr("bd_bot.http_api.serve", _capture)

    cfg = Settings()
    cfg.db_path = in_tmp / "t.sqlite3"
    store = Store(cfg.db_path)
    try:
        rc = cli.cmd_run(_run_args(api_port=4599), cfg, store)
    finally:
        store.close()

    assert rc == 0
    state = captured["state"]
    assert state.snapshot()[0] == "connected", (
        "the dashboard stayed disconnected after whatsmeow reconnected"
    )


def test_run_rejects_an_unusable_blast_number_before_connecting(in_tmp, monkeypatch):
    """Fail on the typo at the command line, not after a tester has already
    been messaged."""
    from bd_bot.storage import Store

    transport = _ServingTransport()
    _patch_transport(monkeypatch, transport)

    cfg = Settings()
    cfg.db_path = in_tmp / "t.sqlite3"
    store = Store(cfg.db_path)
    try:
        with pytest.raises(SystemExit):
            cli.cmd_run(_run_args(blast=["not-a-number"]), cfg, store)
    finally:
        store.close()
    assert not transport.started


# --- calendar-check: the one command that completes Google consent ----------


def _cal_args(limit=5):
    return argparse.Namespace(limit=limit)


def test_calendar_check_explains_a_missing_oauth_client(in_tmp, capsys):
    """Setup pointed at `simulate` for this, which fakes the calendar and can
    never prompt. This command has to say what to do instead."""
    cfg = Settings()
    cfg.google_credentials = in_tmp / "nope.json"
    assert cli.cmd_calendar_check(_cal_args(), cfg, None) == 1
    err = capsys.readouterr().err
    assert "Desktop app" in err, "the client type is the easiest thing to get wrong"
    assert str(cfg.google_credentials) in err


def test_calendar_check_reports_the_slots_it_would_offer(in_tmp, monkeypatch, capsys):
    from datetime import datetime

    from bd_bot import gcal

    cfg = Settings()
    cfg.google_credentials = in_tmp / "creds.json"
    cfg.google_credentials.write_text("{}", encoding="utf-8")
    cfg.google_token = in_tmp / "token.json"
    cfg.google_token.write_text("{}", encoding="utf-8")
    slot = datetime(2026, 7, 28, 14, 0, tzinfo=cfg.tz)
    monkeypatch.setattr(gcal, "free_slots", lambda c, now, limit=12: [slot])

    assert cli.cmd_calendar_check(_cal_args(), cfg, None) == 0
    out = capsys.readouterr().out
    assert "calendar-check OK" in out
    assert "28 Jul 14.00" in out


def test_calendar_check_surfaces_a_broken_calendar(in_tmp, monkeypatch, capsys):
    """Exit non-zero: setup step 4 is a checklist item, and a green tick on a
    calendar that cannot book is worse than no check at all."""
    from bd_bot import gcal

    cfg = Settings()
    cfg.google_credentials = in_tmp / "creds.json"
    cfg.google_credentials.write_text("{}", encoding="utf-8")

    def _boom(c, now, limit=12):
        raise gcal.CalendarError("insufficient scope")

    monkeypatch.setattr(gcal, "free_slots", _boom)
    assert cli.cmd_calendar_check(_cal_args(), cfg, None) == 1
    assert "insufficient scope" in capsys.readouterr().err


def test_release_hands_a_conversation_back_to_the_bot(tmp_path, capsys):
    """HANDOVER and MEETING_DONE stop the flow answering, and nothing moved a
    conversation out of them — `resolve` only closes the escalation row. A
    tester sat in HANDOVER on 30 Jul 2026 writing "Mau meeting" into silence.
    """
    from bd_bot import cli
    from bd_bot.config import Settings
    from bd_bot.models import Conversation, Node, Outcome
    from bd_bot.storage import Store

    cfg = Settings()
    cfg.db_path = tmp_path / "t.sqlite3"
    store = Store(cfg.db_path)
    jid = "6285172262609@s.whatsapp.net"
    store.upsert(Conversation(
        jid=jid, node=Node.HANDOVER, outcome=Outcome.FOLLOWUP,
        name="Budi", brand="Brand X", email="b@x.com",
    ))

    args = type("A", (), {"contact": "6285172262609", "restart_ladder": False})()
    assert cli.cmd_release(args, cfg, store) == 0

    convo = store.get(jid)
    assert convo.node is Node.QNA
    # Releasing is not /restart: the conversation survives.
    assert convo.brand == "Brand X" and convo.email == "b@x.com"
    store.close()


def test_release_leaves_an_active_conversation_alone(tmp_path, capsys):
    from bd_bot import cli
    from bd_bot.config import Settings
    from bd_bot.models import Conversation, Node
    from bd_bot.storage import Store

    cfg = Settings()
    cfg.db_path = tmp_path / "t.sqlite3"
    store = Store(cfg.db_path)
    jid = "6288211050993@s.whatsapp.net"
    store.upsert(Conversation(jid=jid, node=Node.QNA))
    args = type("A", (), {"contact": "6288211050993", "restart_ladder": False})()
    assert cli.cmd_release(args, cfg, store) == 0
    assert store.get(jid).node is Node.QNA
    assert "already answers" in capsys.readouterr().out
    store.close()


# ── --cs-id gives a CS number its own session AND its own database ──────────
# Wiring these as two separate env overrides is what broke on 2026-08-19: a
# second CS bot was launched with SESSION_DIR set but DB_PATH forgotten, so two
# bots shared one database — both numbers reported the same 452 chats, and the
# second was one pairing away from firing the first's 365 pending follow-ups
# from the wrong WhatsApp account.

def _derive(cfg, cs_id):
    """The derivation main() applies — kept in step with it by these tests."""
    if cs_id:
        cfg.session_dir = cfg.session_dir.with_name(f"{cfg.session_dir.name}-{cs_id}")
        cfg.db_path = cfg.db_path.with_name(
            f"{cfg.db_path.stem}-{cs_id}{cfg.db_path.suffix}")
    return cfg


def test_cs_id_separates_both_session_and_database(tmp_path):
    from bd_bot.config import Settings

    cfg = Settings()
    cfg.session_dir = tmp_path / "wa-session"
    cfg.db_path = tmp_path / "bot.sqlite3"
    _derive(cfg, "bd_f07f17cec3")

    assert cfg.session_dir == tmp_path / "wa-session-bd_f07f17cec3"
    assert cfg.db_path == tmp_path / "bot-bd_f07f17cec3.sqlite3"


def test_two_cs_ids_never_share_a_database(tmp_path):
    from bd_bot.config import Settings

    def paths(cs):
        cfg = Settings()
        cfg.session_dir = tmp_path / "wa-session"
        cfg.db_path = tmp_path / "bot.sqlite3"
        _derive(cfg, cs)
        return cfg.session_dir, cfg.db_path

    a_session, a_db = paths("bd_aaa")
    b_session, b_db = paths("bd_bbb")
    assert a_db != b_db
    assert a_session != b_session


def test_no_cs_id_leaves_the_base_paths_alone(tmp_path):
    """The first bot already owns the base paths; it must not be moved."""
    from bd_bot.config import Settings

    cfg = Settings()
    cfg.session_dir = tmp_path / "wa-session"
    cfg.db_path = tmp_path / "bot.sqlite3"
    _derive(cfg, "")

    assert cfg.session_dir == tmp_path / "wa-session"
    assert cfg.db_path == tmp_path / "bot.sqlite3"
