"""The corpus replay harness (ROADMAP 0.1).

`bd_bot replay` classifies every real client turn from the chat exports —
the measuring stick for every classifier change. These tests cover the turn
extraction and the aggregation on synthetic exports, then smoke-test and
regression-guard against the real chat-example/ folder when it exists.
"""

from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bd_bot import chat_examples, intents  # noqa: E402
from bd_bot.cli import replay_stats  # noqa: E402
from bd_bot.models import Intent  # noqa: E402

REAL_DIR = Path(__file__).resolve().parents[1] / "chat-example"
BASELINE = Path(__file__).resolve().parent / "data" / "replay_baseline.json"

AGENT = "Spark Konsultan Official"

TRANSCRIPT = """\
19/07/26 16.26 - ‎Client Satu kini menjadi kontak
19/07/26 16.29 - Client Satu: Harganya berapa ya kak?
19/07/26 16.30 - Spark Konsultan Official: Baik kak, mulai dari Rp15 juta per bulan ya kak 😊
19/07/26 16.31 - Client Satu: oke deh
19/07/26 16.31 - Client Satu: email saya budi@brand.co.id ya
19/07/26 16.32 - Spark Konsultan Official: Siap kak, segera saya kirimkan undangannya yah kak 🙏
"""


@pytest.fixture
def export_dir(tmp_path):
    d = tmp_path / "chat-example"
    d.mkdir()
    with zipfile.ZipFile(d / "Chat A.zip", "w") as zf:
        zf.writestr("Chat A.txt", TRANSCRIPT)
    with zipfile.ZipFile(d / "Chat B.zip", "w") as zf:
        zf.writestr(
            "Chat B.txt",
            "20/07/26 10.01 - Client Dua: sistemnya gimana kak?\n"
            "20/07/26 10.02 - Spark Konsultan Official: Kami handle semua ya kak, "
            "dari kurasi sampai monitoring hariannya kak 🙏\n",
        )
    return d


def test_extracts_client_turns_only(export_dir):
    turns = chat_examples.load_client_turns(str(export_dir))
    texts = [t.text for t in turns]
    assert "Harganya berapa ya kak?" in texts
    assert not any("Rp15 juta" in t for t in texts), "agent turns must not leak in"


def test_consecutive_client_messages_merge_into_one_turn(export_dir):
    turns = chat_examples.load_client_turns(str(export_dir))
    merged = next(t for t in turns if "oke deh" in t.text)
    assert "[email]" in merged.text, "the follow-on message joins the same turn"


def test_client_turns_mask_contact_data(export_dir):
    turns = chat_examples.load_client_turns(str(export_dir))
    blob = " ".join(t.text for t in turns)
    assert "budi@brand.co.id" not in blob
    assert "[email]" in blob


def test_replay_stats_aggregates(export_dir):
    turns = chat_examples.load_client_turns(str(export_dir))
    stats = replay_stats(turns, intents.classify_rules)
    assert stats["files"] == 2
    assert stats["turns"] == len(turns) == sum(stats["intents"].values())
    assert stats["intents"]["tanya_harga"] >= 1
    assert 0.0 <= stats["unknown_rate"] <= 1.0
    assert stats["unknown"] == stats["intents"].get("unknown", 0)


def test_replay_stats_empty_corpus():
    stats = replay_stats((), intents.classify_rules)
    assert stats["turns"] == 0 and stats["unknown_rate"] == 0.0


def test_missing_dir_yields_no_turns(tmp_path):
    assert chat_examples.load_client_turns(str(tmp_path / "nope")) == ()


# --- against the real corpus -------------------------------------------------


@pytest.mark.skipif(not REAL_DIR.is_dir(), reason="no chat-example/ folder")
def test_real_corpus_replays_every_export():
    """ROADMAP 0.1 acceptance: runs clean over all exports, including the
    filenames with U+00A0 / U+2011 / U+FFFD in them."""
    exports = [
        p for p in REAL_DIR.iterdir() if p.suffix.lower() in {".zip", ".txt"}
    ]
    turns = chat_examples.load_client_turns(str(REAL_DIR))
    stats = replay_stats(turns, intents.classify_rules)
    assert stats["files"] == len(exports), "every export must yield client turns"
    assert stats["turns"] >= 300, "the corpus holds hundreds of client turns"


@pytest.mark.skipif(not REAL_DIR.is_dir(), reason="no chat-example/ folder")
def test_real_corpus_turns_are_masked():
    for t in chat_examples.load_client_turns(str(REAL_DIR)):
        # Social handles ("@dfancystuff") are brand data and may stay;
        # anything shaped like an email must not.
        assert not chat_examples._EMAIL_RE.search(t.text), "emails must be masked"
        assert not chat_examples._PHONE_RE.search(t.text), "phones must be masked"


@pytest.mark.skipif(
    not (REAL_DIR.is_dir() and BASELINE.is_file()),
    reason="needs chat-example/ and the committed baseline",
)
def test_unknown_rate_does_not_regress_past_baseline():
    """The committed Phase-0 baseline is a ratchet: rule changes may improve
    the UNKNOWN rate, never quietly worsen it by more than 2pp."""
    baseline = json.loads(BASELINE.read_text())
    turns = chat_examples.load_client_turns(str(REAL_DIR))
    stats = replay_stats(turns, intents.classify_rules)
    assert stats["unknown_rate"] <= baseline["unknown_rate"] + 0.02, (
        f"UNKNOWN rate {stats['unknown_rate']:.1%} regressed past the "
        f"baseline {baseline['unknown_rate']:.1%}"
    )
    for label in stats["intents"]:
        assert label in {i.value for i in Intent}
