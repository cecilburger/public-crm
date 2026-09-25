"""The sending window: which hours, and which days.

A boolean could only say "weekends: both, or neither". The BD team works
Monday to Saturday, so the schedule is a set of days now. These cover the
parsing (an operator types this into .env) and the one predicate every caller
shares — the point of which is that the engine, the SLA clock and the outreach
loop can no longer disagree about whether it is a working moment.
"""

from __future__ import annotations

import sys
from datetime import datetime, time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bd_bot.config import Settings, _env_days, _env_time  # noqa: E402
from bd_bot.engine import business_hours_between  # noqa: E402

MON, SAT, SUN = 10, 15, 16          # Aug 2026: 10th is a Monday


def at(day: int, hh: int, mm: int = 0) -> datetime:
    return datetime(2026, 8, day, hh, mm)


@pytest.fixture()
def cfg():
    c = Settings()
    c.send_window_start = time(12, 0)
    c.send_window_end = time(18, 0)
    c.send_days = frozenset(range(6))       # Mon-Sat
    return c


# -- parsing ----------------------------------------------------------------


@pytest.mark.parametrize("raw,expected", [
    ("mon-sat", {0, 1, 2, 3, 4, 5}),
    ("mon-fri", {0, 1, 2, 3, 4}),
    ("0-5",     {0, 1, 2, 3, 4, 5}),
    ("mon,wed,fri", {0, 2, 4}),
    ("monday-saturday", {0, 1, 2, 3, 4, 5}),
    ("MON-SAT", {0, 1, 2, 3, 4, 5}),
    ("sun", {6}),
    ("sat-mon", {5, 6, 0}),                 # wraps rather than meaning nothing
    ("mon-sat, sun", set(range(7))),
])
def test_day_parsing(monkeypatch, raw, expected):
    monkeypatch.setenv("SEND_DAYS", raw)
    assert _env_days("SEND_DAYS", frozenset()) == expected


@pytest.mark.parametrize("raw", ["", "   ", "nonsense", "9-12"])
def test_unreadable_days_fall_back(monkeypatch, raw):
    """A typo must not silently mean 'never send' or 'send every day'."""
    monkeypatch.setenv("SEND_DAYS", raw)
    assert _env_days("SEND_DAYS", frozenset({0, 1})) == {0, 1}


@pytest.mark.parametrize("raw,expected", [
    ("12:00", time(12, 0)),
    ("12.00", time(12, 0)),                 # how the hour is written in Indonesian
    ("9:30", time(9, 30)),
    ("18", time(18, 0)),
])
def test_time_parsing(monkeypatch, raw, expected):
    monkeypatch.setenv("SEND_WINDOW_START", raw)
    assert _env_time("SEND_WINDOW_START", time(0, 0)) == expected


def test_an_unreadable_time_keeps_the_default(monkeypatch, capsys):
    monkeypatch.setenv("SEND_WINDOW_START", "noon")
    assert _env_time("SEND_WINDOW_START", time(9, 0)) == time(9, 0)
    assert "not HH:MM" in capsys.readouterr().out


def test_the_old_boolean_still_works(monkeypatch):
    """An existing .env with SEND_ON_WEEKENDS must not change behaviour."""
    monkeypatch.delenv("SEND_DAYS", raising=False)
    monkeypatch.setenv("SEND_ON_WEEKENDS", "true")
    assert Settings().send_days == frozenset(range(7))
    monkeypatch.setenv("SEND_ON_WEEKENDS", "false")
    assert Settings().send_days == frozenset(range(5))


# -- the window -------------------------------------------------------------


def test_inside_the_window(cfg):
    assert cfg.within_window(at(MON, 12, 0)) is True
    assert cfg.within_window(at(MON, 15, 30)) is True
    assert cfg.within_window(at(MON, 18, 0)) is True


def test_outside_the_hours(cfg):
    assert cfg.within_window(at(MON, 11, 59)) is False
    assert cfg.within_window(at(MON, 18, 1)) is False
    assert cfg.within_window(at(MON, 9, 0)) is False, "the old 09:00 start"
    assert cfg.within_window(at(MON, 18, 30)) is False, "the old 19:00 end"


def test_saturday_is_a_working_day(cfg):
    assert cfg.within_window(at(SAT, 13, 0)) is True


def test_sunday_is_not(cfg):
    """The case the old boolean could not express."""
    assert cfg.within_window(at(SUN, 13, 0)) is False


def test_no_days_configured_sends_nothing(cfg):
    cfg.send_days = frozenset()
    assert cfg.within_window(at(MON, 13, 0)) is False


# -- everyone asks the same question ---------------------------------------


def test_the_sla_clock_uses_the_same_window(cfg):
    """business_hours_between must count Saturday now, and stop at 18:00."""
    # Sat 12:00 -> Sat 18:00 is the whole six-hour window.
    assert business_hours_between(at(SAT, 12, 0), at(SAT, 18, 0), cfg) == 6.0
    # Sunday contributes nothing.
    assert business_hours_between(at(SUN, 12, 0), at(SUN, 18, 0), cfg) == 0.0


def test_the_sla_clock_skips_the_closed_hours(cfg):
    """Mon 17:00 -> Tue 13:00 counts only the open hours in between.

    1.5 on Monday and 1.0 on Tuesday: the half-hour steps land on 17:00, 17:30
    and 18:00, and the window's end is inclusive, so 18:00 itself is open.
    """
    assert business_hours_between(at(MON, 17, 0), at(MON + 1, 13, 0), cfg) == 2.5


def test_the_engine_delegates(cfg, tmp_path):
    from bd_bot.engine import Engine
    from bd_bot.storage import Store
    from bd_bot.transport.mock import MockTransport

    cfg.db_path = tmp_path / "w.sqlite3"
    store = Store(cfg.db_path)
    try:
        eng = Engine(cfg, store, MockTransport(echo=False))
        assert eng.within_send_window(at(SAT, 13, 0)) is True
        assert eng.within_send_window(at(SUN, 13, 0)) is False
        assert eng.within_send_window(at(MON, 19, 0)) is False
    finally:
        store.close()


# -- the banner -------------------------------------------------------------


@pytest.mark.parametrize("days,label", [
    (range(6), "Mon–Sat"),
    (range(5), "Mon–Fri"),
    (range(7), "every day"),
    ([0], "Mon"),
    ([0, 2, 4], "Mon, Wed, Fri"),
])
def test_days_label(cfg, days, label):
    cfg.send_days = frozenset(days)
    assert cfg.days_label() == label
