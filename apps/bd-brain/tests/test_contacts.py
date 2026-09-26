"""Brand-database loading and the campaign queue."""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from bd_bot import contacts
from bd_bot.models import Contact, Conversation, Node
from bd_bot.storage import Store

NOW = datetime(2026, 7, 22, 10, 0)


# --- phone normalisation ---------------------------------------------------


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("08123456789", "628123456789"),
        ("+62 812-3456-789", "628123456789"),
        ("628123456789", "628123456789"),
        ("8123456789", "628123456789"),
        ("0812 3456 789", "628123456789"),
        ("(0812) 3456-789", "628123456789"),
    ],
)
def test_every_way_a_number_gets_typed_lands_on_one_jid(raw, expected):
    assert contacts.normalise_phone(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "n/a",
        "0217654321",  # Jakarta landline, not a mobile
        "0812345",  # too short
        "081234567890123",  # too long
        "+1 555 0100",  # not Indonesian
    ],
)
def test_bad_numbers_are_rejected_not_guessed_at(raw):
    """A wrong number here means cold-messaging a stranger."""
    assert contacts.normalise_phone(raw) == ""


# --- CSV parsing -----------------------------------------------------------


def test_parses_a_normal_export():
    report = contacts.parse(
        "name,phone,brand\n"
        "Cika,08123456789,Brand X\n"
        "Dewi,+628987654321,Brand Y\n"
    )
    assert report.ok == 2
    assert report.contacts[0] == Contact(
        jid="628123456789@s.whatsapp.net", name="Cika", brand="Brand X"
    )
    assert not report.skipped


def test_indonesian_headers_are_understood():
    report = contacts.parse("Nama PIC;No HP;Perusahaan\nBudi;081234567891;Toko Z\n")
    c = report.contacts[0]
    assert (c.name, c.brand) == ("Budi", "Toko Z")


def test_headerless_list_of_numbers_still_loads():
    report = contacts.parse("08123456789\n08123456781\n")
    assert report.ok == 2


def test_duplicates_collapse_to_one_contact():
    """The same brand appearing twice must not be messaged twice."""
    report = contacts.parse("phone\n08123456789\n+628123456789\n")
    assert report.ok == 1
    assert report.duplicates == 1


def test_bad_rows_are_reported_with_their_line_number():
    report = contacts.parse("phone,name\n08123456789,Ok\nnot-a-number,Bad\n")
    assert report.ok == 1
    assert report.skipped == [(3, "not-a-number", "not a valid Indonesian mobile")]


# --- the queue -------------------------------------------------------------


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "t.sqlite3")
    yield s
    s.close()


def _contacts(n: int) -> list[Contact]:
    return [
        Contact(jid=f"62812345678{i}@s.whatsapp.net", brand=f"Brand {i}")
        for i in range(n)
    ]


def test_import_is_idempotent(store):
    assert store.add_contacts(_contacts(3), "list", NOW) == (3, 0)
    assert store.add_contacts(_contacts(3), "list", NOW) == (0, 0)
    assert store.contact_stats()["total"] == 3


def test_reimport_fills_in_blanks_without_clobbering(store):
    store.add_contacts([Contact(jid="628123456789@s.whatsapp.net")], "l", NOW)
    added, enriched = store.add_contacts(
        [Contact(jid="628123456789@s.whatsapp.net", name="Cika", brand="X")], "l", NOW
    )
    assert (added, enriched) == (0, 1)
    assert store.queue(10)[0].name == "Cika"


def test_queue_respects_its_limit_and_order(store):
    store.add_contacts(_contacts(5), "list", NOW)
    queue = store.queue(2)
    assert [c.brand for c in queue] == ["Brand 0", "Brand 1"]


def test_blasted_contacts_leave_the_queue(store):
    store.add_contacts(_contacts(3), "list", NOW)
    first = store.queue(1)[0]
    store.mark_blasted(first.jid, NOW)
    assert first.jid not in {c.jid for c in store.queue(10)}
    assert store.contact_stats() == {"total": 3, "blasted": 1, "waiting": 2}


def test_a_contact_who_messaged_us_first_is_never_cold_blasted(store):
    """The queue must not interrupt a live conversation with an opener."""
    store.add_contacts(_contacts(2), "list", NOW)
    convo = Conversation(jid="628123456780@s.whatsapp.net", node=Node.QNA)
    store.upsert(convo)
    assert [c.jid for c in store.queue(10)] == ["628123456781@s.whatsapp.net"]


def test_preview_consumes_nothing(tmp_path, monkeypatch, capsys):
    """A preview that eats the queue would silently skip real brands.

    Dry-run `blast` still advances the conversation and arms the ladder, which
    is right for the simulator and wrong here — `campaign --dry-run` must be
    safe to run as many times as you like.
    """
    from bd_bot import cli

    db = tmp_path / "preview.sqlite3"
    monkeypatch.setenv("DB_PATH", str(db))
    monkeypatch.setenv("DRY_RUN", "true")
    monkeypatch.chdir(tmp_path)  # no .env to pick up

    s = Store(db)
    s.add_contacts(_contacts(3), "list", NOW)
    s.close()

    for _ in range(2):
        assert cli.main(["campaign", "--dry-run"]) == 0

    s = Store(db)
    try:
        assert s.contact_stats() == {"total": 3, "blasted": 0, "waiting": 3}
        assert len(s.queue(10)) == 3
        assert s.all_conversations() == []  # no state written at all
    finally:
        s.close()

    assert "628123456780" in capsys.readouterr().out


def test_daily_count_only_covers_today(store):
    store.add_contacts(_contacts(2), "list", NOW)
    store.mark_blasted("628123456780@s.whatsapp.net", NOW - timedelta(days=1))
    store.mark_blasted("628123456781@s.whatsapp.net", NOW)
    assert store.blasted_today(NOW) == 1
