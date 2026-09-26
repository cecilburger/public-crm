"""V4 — the exhaustive sweep (ROADMAP.md §3 V4, proving §1.1 F7).

Enumerates every (node × intent) pair through flow.on_inbound and every
(node × timer) pair through flow.on_timer, asserting each produces at least
one substantive action. Silence is allowed only on an explicit, asserted
exception list — never implicitly. If a future change makes an excepted pair
speak (or a covered pair fall silent), a test here fails and the list must be
updated deliberately.

No network, no database — same as test_flow.py.
"""

from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bd_bot import flow  # noqa: E402
from bd_bot.config import Settings  # noqa: E402
from bd_bot.flow import CancelTimers, Escalate  # noqa: E402
from bd_bot.models import (  # noqa: E402
    TERMINAL_NODES,
    Conversation,
    Intent,
    Node,
    Timer,
)

#: A probe that trips none of the text-sensitive branches: not a bare ack,
#: no email, no time/day words (reschedule regex), no "Brand:" field.
NEUTRAL_TEXT = "tolong dijelaskan lebih lanjut mengenai poin tersebut"

#: Designed silences for on_inbound — the only (node, intent) pairs allowed
#: to produce nothing beyond CancelTimers. FLOWCHART.md §3.3: an extra "ok"
#: from an already-booked contact needs no reply (flow._acceptance).
INBOUND_SILENT_PAIRS = frozenset(
    {
        (Node.SCHEDULED, Intent.SETUJU),
        (Node.SCHEDULED, Intent.OK_LANJUT),
    }
)

#: Terminal nodes where inbound must escalate — a human sees every message,
#: the bot never replies. STOPPED is special-cased below: only opt-out is
#:  permanent; a decayed/rejected contact who writes back re-engages.
INBOUND_ESCALATE_ONLY_NODES = frozenset({Node.HANDOVER, Node.MEETING_DONE})


@pytest.fixture
def cfg() -> Settings:
    return Settings()


@pytest.fixture
def now() -> datetime:
    return datetime(2026, 7, 21, 10, 0)


def _convo(node: Node, **kw: str) -> Conversation:
    return Conversation(
        jid="628111@s.whatsapp.net", name="Cika", brand="Brand X", node=node, **kw
    )


def _substantive(result) -> list:
    """Every action except the always-present CancelTimers."""
    return [a for a in result.actions if not isinstance(a, CancelTimers)]


# --- node × intent through on_inbound ---------------------------------------


@pytest.mark.parametrize("node", [n for n in Node if n not in TERMINAL_NODES])
@pytest.mark.parametrize("intent", list(Intent))
def test_inbound_sweep_no_dead_ends(node, intent, cfg, now):
    """F7: every non-terminal (node, intent) pair acts — or is a listed silence."""
    r = flow.on_inbound(_convo(node), intent, NEUTRAL_TEXT, cfg, now)
    if (node, intent) in INBOUND_SILENT_PAIRS:
        assert _substantive(r) == [], (
            f"({node}, {intent}) is on the designed-silence list but spoke — "
            "remove it from INBOUND_SILENT_PAIRS if that is intentional"
        )
    else:
        assert _substantive(r), f"dead end: ({node}, {intent}) produced no action"


@pytest.mark.parametrize("node", sorted(INBOUND_ESCALATE_ONLY_NODES))
@pytest.mark.parametrize("intent", list(Intent))
def test_inbound_terminal_nodes_escalate_never_reply(node, intent, cfg, now):
    """HANDOVER/MEETING_DONE: a human owns the thread — escalate, stay quiet."""
    r = flow.on_inbound(_convo(node), intent, NEUTRAL_TEXT, cfg, now)
    subs = _substantive(r)
    assert len(subs) == 1 and isinstance(subs[0], Escalate), (
        f"({node}, {intent}) must escalate and nothing else, got {subs}"
    )


@pytest.mark.parametrize("intent", list(Intent))
def test_inbound_after_opt_out_escalates_never_replies(intent, cfg, now):
    """F5: opt-out is permanent — even their own later messages get no reply."""
    convo = _convo(Node.STOPPED, stopped_reason="opt_out")
    r = flow.on_inbound(convo, intent, NEUTRAL_TEXT, cfg, now)
    subs = _substantive(r)
    assert len(subs) == 1 and isinstance(subs[0], Escalate)


@pytest.mark.parametrize("intent", list(Intent))
def test_inbound_after_decay_reengages(intent, cfg, now):
    """A decayed (not opted-out) contact who writes back gets an answer."""
    convo = _convo(Node.STOPPED)  # stopped_reason "" = decay/rejection
    r = flow.on_inbound(convo, intent, NEUTRAL_TEXT, cfg, now)
    assert _substantive(r), f"decayed contact ignored on {intent}"


def test_booked_reschedule_text_is_not_silent(cfg, now):
    """The (SCHEDULED, acceptance) silence must not swallow a reschedule ask."""
    r = flow.on_inbound(
        _convo(Node.SCHEDULED),
        Intent.SETUJU,
        "boleh di reschedule gak yaa di jam 4 sore",
        cfg,
        now,
    )
    assert any(isinstance(a, Escalate) for a in r.actions)
    assert _substantive(r)


# --- node × timer through on_timer ------------------------------------------


@pytest.mark.parametrize("node", [n for n in Node if n not in TERMINAL_NODES])
@pytest.mark.parametrize("timer", list(Timer))
def test_timer_sweep_no_dead_ends(node, timer, cfg, now):
    """Every timer firing on a live conversation lands in a defined state."""
    r = flow.on_timer(_convo(node), timer, cfg, now)
    assert r.actions, f"dead end: timer {timer} at {node} produced no action"


@pytest.mark.parametrize("node", sorted(TERMINAL_NODES))
@pytest.mark.parametrize("timer", list(Timer))
def test_timer_sweep_terminal_nodes_stay_silent(node, timer, cfg, now):
    """Straggler timers on terminal conversations are dropped by design."""
    r = flow.on_timer(_convo(node), timer, cfg, now)
    assert r.actions == [], f"terminal {node} acted on straggler timer {timer}"
