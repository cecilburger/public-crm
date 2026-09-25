"""Nothing from one conversation may ever appear in another.

Two separate leaks made this its own file:

* A cached REPLY_TERUSKAN_TIM generated for Greenfields carried their email,
  and three other brands were told their proposal would go to
  consumerfeedback@greenfieldsdairy.com (13-14 Aug 2026).
* `Engine._context` was one shared attribute while conversation locks are per
  CONTACT — so two brands handled at once, plus the outreach loop on a third
  thread, could overwrite each other's send context.
"""

from __future__ import annotations

import sys
import threading
from datetime import datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bd_bot import responder  # noqa: E402
from bd_bot.config import Settings  # noqa: E402
from bd_bot.engine import Engine  # noqa: E402
from bd_bot.models import Conversation, Node  # noqa: E402
from bd_bot.storage import Store  # noqa: E402
from bd_bot.transport.mock import MockTransport  # noqa: E402

NOW = datetime(2026, 8, 14, 11, 0)


@pytest.fixture
def eng(tmp_path):
    cfg = Settings()
    cfg.db_path = tmp_path / "x.sqlite3"
    cfg.dry_run = False
    cfg.require_approval = False
    cfg.min_seconds_between_sends = 0
    cfg.reply_cache_variants = 1          # reuse after a single variant
    store = Store(cfg.db_path)
    e = Engine(cfg, store, MockTransport(echo=False))
    yield e
    store.close()


KEY = sorted(responder.CACHEABLE_KEYS)[0]


# -- the cache may not carry one contact into another ----------------------


def test_a_cached_reply_with_an_email_is_never_reused(eng):
    """The exact leak: Greenfields' address, replayed to three brands."""
    eng.store.cache_reply(
        KEY,
        "Baik, Kak. Saya kirimkan proposal ke email "
        "consumerfeedback@greenfieldsdairy.com ya.",
        "Greenfields", "Greenfields", NOW)
    other = Conversation(jid="628999@s.whatsapp.net", node=Node.QNA)
    other.name, other.brand = "Maicih", "Maicih"
    assert eng._cached_reply(other, KEY) is None


def test_the_poisoned_variant_is_evicted_not_just_skipped(eng):
    """Left in place it would be re-examined, and re-rejected, for ever."""
    eng.store.cache_reply(
        KEY, "kirim ke consumerfeedback@greenfieldsdairy.com",
        "Greenfields", "Greenfields", NOW)
    other = Conversation(jid="628999@s.whatsapp.net", node=Node.QNA)
    other.name, other.brand = "Maicih", "Maicih"
    eng._cached_reply(other, KEY)
    assert eng.store.cached_replies(KEY) == []


def test_a_name_fragment_the_swap_cannot_reach_is_caught(eng):
    """`_personalise` swaps whole words: a reply written as "Kak Dyan" when
    the record says "Dyan Jati" keeps the fragment."""
    eng.store.cache_reply(
        KEY, "Baik Kak Dyan, terima kasih atas informasinya ya.",
        "Dyan Jati", "Pip Mim", NOW)
    other = Conversation(jid="628999@s.whatsapp.net", node=Node.QNA)
    other.name, other.brand = "Maicih", "Maicih"
    assert eng._cached_reply(other, KEY) is None


def test_a_clean_variant_is_still_reused(eng):
    """The guard must not switch reuse off altogether — that is the whole
    saving."""
    eng.store.cache_reply(
        KEY, "Baik, Kak. Terima kasih atas informasinya, kami tunggu kabarnya.",
        "Greenfields", "Greenfields", NOW)
    other = Conversation(jid="628999@s.whatsapp.net", node=Node.QNA)
    other.name, other.brand = "Maicih", "Maicih"
    assert eng._cached_reply(other, KEY) is not None


def test_the_brand_is_still_swapped_on_reuse(eng):
    eng.store.cache_reply(
        KEY, "Baik, Kak. Semoga Greenfields tertarik ya.",
        "Greenfields", "Greenfields", NOW)
    other = Conversation(jid="628999@s.whatsapp.net", node=Node.QNA)
    other.name, other.brand = "Maicih", "Maicih"
    # Either swapped cleanly, or refused — never sent carrying the old brand.
    got = eng._cached_reply(other, KEY)
    assert got is None or "Greenfields" not in got


# -- threads must not share a send context --------------------------------


def test_two_conversations_keep_their_own_send_context(eng):
    """Locks are per contact, so these really do run at once — and the
    outreach loop makes a third thread alongside them."""
    seen, barrier = {}, threading.Barrier(2)

    def worker(name, ctx):
        eng._context = ctx
        barrier.wait(timeout=5)        # force the interleaving
        seen[name] = eng._context

    threads = [threading.Thread(target=worker, args=(n, c))
               for n, c in (("brandA", "reply"), ("brandB", "campaign"))]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=5)
    assert seen == {"brandA": "reply", "brandB": "campaign"}, seen


def test_a_campaign_opening_is_never_logged_as_a_reply(eng):
    """The consequence that mattered: a blast mislabelled as a reply skips the
    daily cap entirely."""
    done = threading.Event()

    def noisy_replies():
        while not done.is_set():
            eng._context = "reply"

    t = threading.Thread(target=noisy_replies, daemon=True)
    t.start()
    try:
        jid = "628777@s.whatsapp.net"
        eng.store.upsert(Conversation(jid=jid, node=Node.NEW))
        eng._context = "campaign"
        convo = eng.store.get(jid)
        eng._send(convo, "Selamat siang, Kak.", NOW, key="COLD_FU2")
    finally:
        done.set()
        t.join(timeout=5)
    labels = [r["intent"] for r in eng.store.db.execute(
        "SELECT intent FROM messages WHERE jid = ? AND direction = 'out'", (jid,))]
    assert labels == ["campaign"], labels


def test_the_default_context_is_the_safe_one(eng):
    """A thread that never set one must not inherit another thread's."""
    got = {}

    def fresh():
        got["v"] = eng._context

    eng._context = "campaign"
    t = threading.Thread(target=fresh)
    t.start()
    t.join(timeout=5)
    assert got["v"] == "reply"
