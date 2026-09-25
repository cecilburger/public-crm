"""The replies the BD team actually wants, in the situations they named.

Every brand line here is verbatim from a real thread they reviewed on
14 Aug 2026, and every assertion encodes a correction they made. Three of
those corrections are negative — a message that must NOT be sent — and those
are the easy ones to lose, because nothing visibly breaks when a bot says one
sentence too many.
"""

from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bd_bot import flow, intents, templates  # noqa: E402
from bd_bot.config import Settings  # noqa: E402
from bd_bot.models import Conversation, Intent, Node, Outcome  # noqa: E402

NOW = datetime(2026, 8, 14, 11, 0)


@pytest.fixture
def cfg():
    c = Settings()
    c.use_llm_intents = False
    return c


def _reply(cfg, text, node=Node.QNA):
    """Classify like production, run the flow, return everything it would say.

    Reads the rendered text off each Send action rather than re-rendering by
    key: that is the string the brand receives, so an assertion about it is an
    assertion about what actually goes out.
    """
    convo = Conversation(jid="628123@s.whatsapp.net", node=node)
    convo.name, convo.brand = "Kak", "BrandX"
    intent = intents.classify(text, cfg)
    r = flow.on_inbound(convo, intent, text, cfg, NOW)
    said = " ".join(
        a.message.text for a in r.actions if hasattr(a, "message")
    )
    return intent, said


# -- what each situation should draw --------------------------------------


def test_a_soft_no_gets_the_service_list_and_an_open_door(cfg):
    """"halo kak saat ini belum" — not a door closing, so it must not sound
    like one."""
    _, said = _reply(cfg, "halo kak saat ini belum")
    assert "terima kasih atas feedback" in said.lower()
    assert "Campaign Affiliate" in said
    assert "kebutuhan lain" in said, "the open-ended invitation was dropped"


def test_an_explicit_no_gets_the_six_services(cfg):
    """"sudah ada team yang mengelola affiliate" — a no to affiliate, not to
    us."""
    _, said = _reply(
        cfg,
        "Untuk saat ini kami belum membutuhkan karna sudah ada team yang "
        "mengelola affiliate. Semoga bisa bekerja sama dilain waktu yaa")
    low = said.lower()
    for service in ("campaign affiliate", "live streaming", "tvc",
                    "full service", "berbasis ai", "ads"):
        assert service in low, f"{service} missing"


@pytest.mark.parametrize("text", [
    "Halo kak, sebelumnya terima kasih yaa atas penawaran kerjasamanya yaa. "
    "Aku diskusikan dulu dengan team ya kak",
    "Sudah kami sampaikan ke tim marketing ya",
    "Baik. Saat ini telah kami bantu sampaikan ke tim terkait. Apabila tim "
    "kami berminat untuk bekerjasama, maka tim kami akan menghubungi kakak",
])
def test_forwarded_to_their_team_waits_well(cfg, text):
    """The brand has not said no — so the reply waits, offers a meeting, and
    leaves the other services where the team will see them."""
    _, said = _reply(cfg, text)
    assert "tunggu kabar baik" in said.lower()
    assert "meeting online" in said.lower()
    assert "Live Streaming" in said


def test_an_email_is_thanked_and_left_at_that(cfg):
    """Otten Coffee: they named an inbox, so the answer is thanks and a
    promise to use it.

    The reply used to ask for a PIC on top. Dropped 21 Aug 2026 on the
    operator's instruction — "kalau udah dikasih email atau no telp alternatif
    jawab dengan terima kasih dan bilang kalau akan segera menghubungi" — after
    Bali Botanica, who had written "Boleh langsung ke email marketing@… aja ya
    kak", was answered with three meeting slots and then asked for their email
    address.
    """
    intent, said = _reply(
        cfg,
        "Mengenai usulan kerjasama, mohon kirimkan proposal kakak melalui "
        "email clarita.pinky@ottencoffee.co.id")
    assert intent is Intent.KIRIM_EMAIL
    assert "terima kasih" in said.lower()
    assert "akan segera kami kirimkan" in said.lower()
    assert "kontak pic" not in said.lower(), "an address is not an invitation"


def test_a_promised_introduction_asks_for_the_contact(cfg):
    """Being promised an introduction is not having one."""
    intent, said = _reply(
        cfg,
        "Terima kasih atas penawaran kerjasamanya, Kak Grace. Untuk kebutuhan "
        "B2B dan negosiasi, saya akan hubungkan Kakak dengan tim sales kami.")
    assert intent is Intent.HUBUNGKAN_PIC
    assert "kontak pic" in said.lower()


def test_a_discontinued_product_asks_what_they_do_now(cfg):
    """Not a rejection: the brand is still there, selling something else."""
    intent, said = _reply(
        cfg,
        "Untuk produk yg sblm nya kami miliki mohon maaf kami sdh tidak "
        "produksi lagi ka")
    assert intent is Intent.PRODUK_BERUBAH
    assert "bergerak di bidang apa" in said.lower()


# -- and what must NOT be said --------------------------------------------
# The corrections that are easy to lose: nothing visibly breaks when a bot
# says one sentence too many, it just reads as not listening.


def test_an_email_request_does_not_get_the_lets_chat_reply(cfg):
    """"boleh kita bahas lewat chat dulu" answers a question nobody asked
    once they have named an inbox."""
    _, said = _reply(
        cfg,
        "mohon kirimkan proposal kakak melalui email clarita.pinky@otten.co.id")
    assert "bahas lewat chat" not in said.lower()


def test_an_email_request_does_not_start_scheduling(cfg):
    _, said = _reply(
        cfg, "mohon kirimkan proposal melalui email halo@brand.co.id")
    low = said.lower()
    assert "kami tersedia" not in low and "pilih jam" not in low


def test_forwarded_to_team_does_not_thank_them_for_their_time_instead(cfg):
    """The long "terima kasih atas waktu dan bantuannya" close was replaced —
    it reads as goodbye when the brand has not said goodbye."""
    _, said = _reply(cfg, "Sudah kami sampaikan ke tim marketing ya")
    assert "menunggu kabar baik dari tim" not in said.lower()


def test_a_promised_introduction_does_not_start_scheduling(cfg):
    _, said = _reply(cfg, "saya akan hubungkan Kakak dengan tim sales kami")
    assert "kami tersedia" not in said.lower()


@pytest.mark.parametrize("text", [
    "Baik, kami akan hubungi kembali ya",       # verbatim, Kacang Ijo 20 Aug
    "Ok nanti kami kontak lagi ya kak",
    "jika nanti sudah ada kebutuhan akan kami coba hubungi kembali ya",
])
def test_we_will_get_back_to_you_is_a_no_not_a_yes(cfg, text):
    """"Kami akan hubungi kembali" is the brush-off, and on 20 Aug 2026 the
    bot read it as agreement: it offered three days of slots and asked for an
    email, then chased a meeting the brand had never agreed to. The leading
    "Baik" was doing it — no soft-decline rule matched the promise itself, so
    the bare acknowledgement carried the message to OK_LANJUT."""
    intent, said = _reply(cfg, text)
    assert intent is Intent.TOLAK_HALUS
    low = said.lower()
    assert "kami tersedia" not in low and "pilih jam" not in low
    assert "email" not in low, "asked for an email to invite them to nothing"


# -- a polite thank-you is not a goodbye ----------------------------------


@pytest.mark.parametrize("text", [
    "sore ka, terimaksih atas penawaran nya",   # verbatim, one letter short
    "terimakasih atas penawarannya kak",
    "makasih ya kak",
    "trims kak",
    "siang ka terimaksih infonya",
])
def test_a_thank_you_is_recognised_however_it_is_spelled(cfg, text):
    """"terimaksih" defeated every spelling in the rules, so the message fell
    to REPLY_FREEFORM — which asked a brand who had just thanked us to explain
    what they meant."""
    from bd_bot.models import Intent

    intent, _ = _reply(cfg, text)
    assert intent is Intent.TERIMA_KASIH, f"{text!r} -> {intent}"


def test_a_thank_you_re_offers_the_meeting(cfg):
    """Polite, but neither a yes nor a no — so it is not treated as a close."""
    _, said = _reply(cfg, "sore ka, terimaksih atas penawaran nya")
    low = said.lower()
    assert "tertarik dengan service" in low
    assert "meeting online" in low
    assert "live streaming" in low


def test_it_never_asks_them_to_explain_themselves(cfg):
    """The old fallback did exactly that."""
    _, said = _reply(cfg, "sore ka, terimaksih atas penawaran nya")
    assert "dijelaskan sedikit lebih detail" not in said.lower()


def test_the_meeting_is_offered_once_per_message(cfg):
    """A message that offers the same meeting twice reads as a bot that lost
    its place — the thing this whole round of fixes is about."""
    for text in ("sore ka, terimaksih atas penawaran nya",
                 "Sudah kami sampaikan ke tim marketing ya",
                 "Aku diskusikan dulu dengan team ya kak"):
        _, said = _reply(cfg, text)
        assert said.lower().count("aturkan meeting online") <= 1, (
            f"{text!r} produced a duplicated offer"
        )
