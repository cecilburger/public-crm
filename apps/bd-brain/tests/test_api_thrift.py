"""Not asking Claude what we already know.

Intent classification is rules-first and only falls back to the model, so the
bill is set by how often the rules miss. Replaying every stored inbound on
14 Aug 2026 showed a fifth still reaching the LLM — and most of it was brand
hotlines and empty openers, neither of which the model can place any better
than a regex can.

These pin the shortcut: it must skip the messages that carry nothing, and
must never skip one that carries a question.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bd_bot import intents  # noqa: E402
from bd_bot.config import Settings  # noqa: E402
from bd_bot.models import Intent  # noqa: E402


def _shortcut_swallows(text: str) -> bool:
    """True if the no-LLM shortcut would drop this without asking anyone."""
    probe = intents._normalise(text)
    return any(p.match(probe) for p in intents._NO_LLM_RE)


def _would_call_llm(text: str) -> bool:
    """True if this message would cost an API call."""
    if intents.classify_rules(text) is not Intent.UNKNOWN:
        return False
    return not _shortcut_swallows(text)


@pytest.mark.parametrize("text", [
    "hallo kak,",                       # an opener with nothing in it
    "hai kak grace",
    "halo",
    "selamat siang kak",
    "selamat pagi",
    "dyanjati747@gmail.com",            # normalises to "email"
    "https://s.shopee.co.id/8pkwpiqGB9",  # normalises to "link"
    "😊🙏",                              # normalises to nothing
    ".",
])
def test_empty_turns_cost_nothing(text):
    assert _would_call_llm(text) is False, f"{text!r} paid for an UNKNOWN"


@pytest.mark.parametrize("text", [
    "untuk pricenya start di nominal yang sama kak?",
    "halo kak, ini gimana ya?",
    "hai kak, boleh minta detail?",
    "email saya budi@brand.co.id ya kak",
    "selamat siang, kami tertarik dengan penawarannya",
])
def test_a_real_question_is_never_swallowed(text):
    """The shortcut must never drop a turn that carries meaning — saving a
    call by misreading a customer is not a saving.

    Being placed by the RULES is the best outcome of all (free and decided),
    so this asserts only that the shortcut kept its hands off; whether the
    rules or the model then place it is a separate question.
    """
    assert _shortcut_swallows(text) is False, f"{text!r} was silently skipped"


def test_the_shortcut_never_changes_the_answer():
    """It only skips work whose result is already known: every shortcut
    message is one the rules had already left as UNKNOWN."""
    cfg = Settings()
    cfg.use_llm_intents = False
    for text in ("hallo kak,", "halo", "dyanjati747@gmail.com", "😊🙏"):
        assert intents.classify(text, cfg) is Intent.UNKNOWN
