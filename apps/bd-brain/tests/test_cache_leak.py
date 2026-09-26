"""One brand's details must never be replayed to another.

Generated replies are cached and reused so a template stops costing API calls
once it has a few variants. Reuse re-personalises the NAME and the BRAND —
and nothing else.

On 13-14 Aug 2026 a cached REPLY_TERUSKAN_TIM generated for Greenfields
carried their own address, and three other brands were told their proposal
would be sent to consumerfeedback@greenfieldsdairy.com.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bd_bot import responder  # noqa: E402
from bd_bot.config import Settings  # noqa: E402
from bd_bot.engine import Engine  # noqa: E402
from bd_bot.storage import Store  # noqa: E402
from bd_bot.transport.mock import MockTransport  # noqa: E402


@pytest.fixture
def eng(tmp_path):
    cfg = Settings()
    cfg.db_path = tmp_path / "c.sqlite3"
    store = Store(cfg.db_path)
    e = Engine(cfg, store, MockTransport(echo=False))
    yield e
    store.close()


@pytest.mark.parametrize("text,what", [
    ("Saya akan kirimkan proposal ke email consumerfeedback@greenfieldsdairy.com",
     "an email address"),
    ("Silakan hubungi Pak Jo di 0878-8496-2002 ya kak", "a phone number"),
    ("Link meeting-nya https://meet.google.com/abc-defg-hij", "a link"),
])
def test_contact_details_make_a_reply_unreusable(eng, text, what):
    assert eng._contact_specific(text) == what


@pytest.mark.parametrize("text", [
    "Baik, Kak. Terima kasih atas informasinya. Kami tunggu kabar baiknya ya.",
    "Kami menyediakan creator affiliate yang dikurasi sesuai kategori brand.",
    "Boleh dibantu alamat email-nya ya, Kak?",   # asks for one, carries none
])
def test_ordinary_prose_is_still_reusable(eng, text):
    assert eng._contact_specific(text) == ""


def test_the_exact_leak_is_caught(eng):
    """The message three brands actually received."""
    leaked = ("Baik, Kak. Terima kasih atas informasinya. Saya akan kirimkan "
              "proposal kerja sama Campaign Affiliate ke email "
              "consumerfeedback@greenfieldsdairy.com agar dapat ditinjau tim "
              "terkait.")
    assert eng._contact_specific(leaked) == "an email address"


# -- and the copy the operator wrote is never paraphrased ------------------


@pytest.mark.parametrize("key", [
    "REPLY_TOLAK_HALUS",
    "REPLY_TOLAK_TEGAS",
    "REPLY_TERUSKAN_TIM",
    "REPLY_PELAJARI_DULU",
    "REPLY_EMAIL_PROPOSAL",
    "REPLY_CONNECT_PIC",
    "REPLY_PRODUK_BERUBAH",
    "REPLY_AUTORESPONDER",
    "REPLY_REFERRAL",
])
def test_operator_authored_copy_is_static(key):
    """The BD team wrote these word for word. A generator asked to vary them
    discards the wording they chose, pays an API call to do it, and is free to
    invent — which is how an email address ended up in a cached reply."""
    assert key not in responder.GENERATIVE_KEYS
    assert key not in responder.CACHEABLE_KEYS
