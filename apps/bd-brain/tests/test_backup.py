"""Backup + restore (ROADMAP 3.3).

Runs deploy/backup.sh against a temporary database and rehearses the restore
— the backup that has never been restored is not a backup.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bd_bot.models import Conversation, Node  # noqa: E402
from bd_bot.storage import Store  # noqa: E402

SCRIPT = Path(__file__).resolve().parents[1] / "deploy" / "backup.sh"

#: Two conditions, one list — assigning `pytestmark` twice silently keeps
#: only the second, which is how this file ran its backup script tests in a
#: checkout that has no `deploy/` at all.
pytestmark = [
    pytest.mark.skipif(
        shutil.which("sqlite3") is None or shutil.which("bash") is None,
        reason="needs the sqlite3 and bash CLIs",
    ),
    # `deploy/` is the VPS side of whatsapp-bot-bd and is not part of the
    # CRM copy — the CRM has its own deploy (ops/). Same guard as trained-cb.
    pytest.mark.skipif(
        not SCRIPT.is_file(), reason="deploy/backup.sh is not part of this repo"
    ),
]


def _run(env_overrides: dict[str, str]) -> subprocess.CompletedProcess:
    env = os.environ | env_overrides
    return subprocess.run(
        ["bash", str(SCRIPT)], env=env, capture_output=True, text=True
    )


@pytest.fixture
def layout(tmp_path):
    db = tmp_path / "data" / "bot.sqlite3"
    store = Store(db)
    convo = Conversation(jid="628123@s.whatsapp.net", brand="Brand X")
    convo.node = Node.QNA
    store.upsert(convo)
    store.close()
    session = tmp_path / "data" / "wa-session"
    session.mkdir()
    (session / "session.sqlite3").write_bytes(b"fake session")
    return {
        "DB_PATH": str(db),
        "SESSION_DIR": str(session),
        "BACKUP_DIR": str(tmp_path / "backups"),
        "RETENTION_DAYS": "14",
    }


def test_backup_snapshots_db_and_session(layout, tmp_path):
    result = _run(layout)
    assert result.returncode == 0, result.stderr
    snapshots = list((tmp_path / "backups").iterdir())
    assert len(snapshots) == 1
    snap = snapshots[0]
    assert (snap / "bot.sqlite3").is_file()
    assert (snap / "wa-session" / "session.sqlite3").read_bytes() == b"fake session"


def test_restore_rehearsal_round_trips_the_state(layout, tmp_path):
    """Copy the snapshot back over a wiped data dir and read the state."""
    assert _run(layout).returncode == 0
    snap = next((tmp_path / "backups").iterdir())

    restored = tmp_path / "restored.sqlite3"
    shutil.copy(snap / "bot.sqlite3", restored)
    store = Store(restored)
    convo = store.get("628123@s.whatsapp.net")
    assert convo is not None and convo.brand == "Brand X"
    assert convo.node is Node.QNA
    store.close()


def test_retention_prunes_old_snapshots(layout, tmp_path):
    backups = tmp_path / "backups"
    stale = backups / "2020-01-01_000000"
    stale.mkdir(parents=True)
    (stale / "bot.sqlite3").write_bytes(b"old")
    old = time.time() - 60 * 60 * 24 * 30  # 30 days ago
    os.utime(stale, (old, old))

    assert _run(layout).returncode == 0
    assert not stale.exists(), "30-day-old snapshot must be pruned (14d retention)"
    assert len(list(backups.iterdir())) == 1, "today's snapshot remains"


def test_missing_db_is_not_an_error(layout, tmp_path):
    layout["DB_PATH"] = str(tmp_path / "nope.sqlite3")
    result = _run(layout)
    assert result.returncode == 0
    assert "nothing to back up yet" in result.stdout
