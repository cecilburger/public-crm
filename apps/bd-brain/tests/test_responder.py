"""Responder guardrails.

The LLM may vary wording. It may not invent the offer. These tests pin that
boundary — every one of them describes something a plausible generation could
do that must never reach a contact.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bd_bot import knowledge, responder  # noqa: E402
from bd_bot.config import Settings  # noqa: E402
from bd_bot.models import Conversation, Intent  # noqa: E402


# --- validation: what must be rejected --------------------------------------


def test_accepts_a_clean_reply():
    ok, reason = responder.validate(
        "Baik, Kak. Paket kami Rp10 juta per campaign, menyesuaikan "
        "kebutuhan brand. Apakah fokus utama Kakak ke awareness atau penjualan?",
        "REPLY_TANYA_HARGA",
    )
    assert ok, reason


def test_rejects_a_price_billed_monthly():
    """The fee is per campaign; "per bulan" invents a recurring cost.

    Live on 29 Jul 2026: a generated REPLY_TANYA_HARGA quoted "Rp25 juta per
    bulan" to a tester.

    Only the AFFILIATE fee is per campaign. Since 18 Aug 2026 the ads packages
    are billed monthly and must survive this guard — see the ads case below.
    """
    for bad in (
        "Paket kami Rp10 juta per bulan, Kak.",
        "100 Affiliate Rp10.000.000/bulan.",
        "Biayanya 10jt sebulan ya Kak.",
    ):
        ok, reason = responder.validate(bad, "REPLY_TANYA_HARGA")
        assert not ok, f"should have rejected: {bad}"
        assert "per campaign" in reason


def test_ads_packages_may_be_quoted_per_bulan():
    """Ads are billed monthly; the per-campaign guard must not swallow them.

    Added 18 Aug 2026 with the new deck. A flat ban on "price + bulan" was
    correct while affiliate was the only priced service, and would now stop
    the bot stating the one thing page 2 of the deck puts in front of the
    brand in writing.
    """
    for good in (
        "Untuk TikTok Ads Rp5 juta per bulan ya, Kak — di luar budget iklan.",
        "Paket Cuan Rp15.000.000/bulan.",
        "Paket Hemat 8jt sebulan, Kak.",
        "Meta Ads CPAS Rp13 juta per bulan.",
    ):
        ok, reason = responder.validate(good, "REPLY_TANYA_ADS")
        assert ok, f"should have accepted: {good} ({reason})"


def test_ads_list_prices_are_not_quotable():
    """The deck strikes through Rp10jt and Rp23jt above the payable figures.

    Rp23jt is not in ALLOWED_AMOUNTS at all. Rp10jt is — but as the AFFILIATE
    package, which is per campaign, so quoting it monthly still fails. Both
    routes keep the struck-through number out of chat.
    """
    ok, reason = responder.validate("Normalnya Rp23.000.000/bulan, Kak.", "REPLY_TANYA_ADS")
    assert not ok and "unauthorised amount" in reason, reason

    ok, reason = responder.validate("Normalnya Rp10.000.000/bulan, Kak.", "REPLY_TANYA_ADS")
    assert not ok and "per campaign" in reason, reason


def test_monthly_guard_leaves_non_price_monthly_figures_alone():
    """Client GMV and affiliate volume are legitimately per month."""
    for good in (
        "Klien kami rata-rata mencatat GMV Rp1–2 miliar per bulan, Kak.",
        "Kami menyediakan 300–500 akun affiliate setiap bulan.",
    ):
        ok, reason = responder.validate(good, "REPLY_TANYA_SISTEM")
        assert ok, f"should have accepted {good!r}: {reason}"


def test_rejects_invented_price():
    ok, reason = responder.validate(
        "Baik, Kak. Untuk Kakak kami berikan harga khusus Rp7.500.000 saja.",
        "REPLY_TANYA_HARGA",
    )
    assert not ok
    assert "unauthorised amount" in reason


def test_rejects_invented_discount_phrasing():
    ok, _ = responder.validate(
        "Kami bisa berikan diskon menjadi Rp12 juta untuk bulan ini.",
        "REPLY_TANYA_HARGA",
    )
    assert not ok


def test_rejects_promo_leaked_outside_the_rescue_followup():
    """The promo is a last-resort rescue (FLOWCHART.md §4), never an opener.

    The figure flipped on 18 Aug 2026: Rp10jt became the published package and
    Rp25jt (the old 300 tier) became the withdrawn one. What is under test is
    the mechanism — a price that is no longer sold must not resurface — so the
    case is rewritten around whichever price is currently retired.
    """
    # Rp25jt/300 was the retired example until the 18 Sep 2026 deck brought
    # that tier back at exactly that price. Rebuilt on the old 500 @ Rp45jt,
    # which the deck replaced with a Rp55jt bundle — so Rp45jt is a figure
    # nobody sells.
    promo_text = (
        "Kebetulan ada promo Rp45.000.000 untuk 500 creator, Kak. Berminat?"
    )
    # With no promo published, the figure is simply an unauthorised amount —
    # the same protection by a stronger route, and now it is blocked in the
    # rescue follow-up too, which is where it used to be allowed.
    ok, reason = responder.validate(promo_text, "REPLY_TANYA_HARGA")
    assert not ok
    assert "unauthorised amount" in reason

    ok_in_rescue, reason_rescue = responder.validate(promo_text, "COLD_FU4")
    assert not ok_in_rescue, "a withdrawn price must not survive in the rescue"
    assert "unauthorised amount" in reason_rescue


def test_rejects_guarantees():
    for bad in (
        "Penjualan dijamin naik setelah campaign ini.",
        "Kami berikan garansi hasil, Kak.",
        "Omzet pasti naik dalam sebulan.",
    ):
        ok, _ = responder.validate(bad, "OFFER_MEETING")
        assert not ok, f"should have rejected: {bad}"


def test_rejects_percentages():
    """One figure is authorised — the MCN commission opening (10%). Every
    other percentage, and that same figure attached to any other claim, is
    invented; a number said in chat reads as a commitment."""
    for bad in (
        "Komisi ke MCN biasanya di 5% ya, Kak.",
        # Right digits, wrong side of the deal: the affiliate's cut follows
        # the brand's open plan and has no number we may state.
        "Untuk kategori beauty kami sarankan komisi affiliate 10% dulu, Kak.",
        "Fee kami hanya 4-5 % dari penjualan, Kak.",
        # Right digits, a claim the fact sheet never makes. Verbatim from the
        # corpus (Client 3 Nana).
        "Dari seluruh portofolio client, sekitar 10% kami handle end-to-end.",
    ):
        ok, reason = responder.validate(bad, "REPLY_TANYA_KOMISI")
        assert not ok, bad
        assert "percentage" in reason


def test_accepts_the_authorised_mcn_commission():
    """BD put an opening figure on the MCN cut on 29 Jul 2026."""
    ok, reason = responder.validate(
        "Untuk komisi affiliate, besarannya mengikuti open plan yang "
        "ditetapkan brand. Sementara komisi ke MCNASIA dibuka di 10%, dan "
        "sifatnya masih bisa dinegosiasikan.",
        "REPLY_TANYA_KOMISI",
    )
    assert ok, reason


def test_campaign_duration_matches_the_ladder_and_nothing_else():
    """The corpus quotes 3, 4 and 5 bulan for the same package. BD settled it
    at four on 29 Jul 2026, the 18 Aug deck moved it to two with a single
    package, and the 18 Sep deck restored a ladder: 2, 4 and 6 bulan, one per
    tier. So 4 and 6 are authorised FIGURES again — what this still catches is
    a month count that appears on no tier at all.

    The figure is all this guard sees; it cannot catch 6 bulan attached to the
    100. That pairing is held by `test_kb_check.py` and by the fact sheet."""
    for good in (
        "Paket ini berjalan dengan durasi 2 bulan ya, Kak.",
        "Untuk yang 200 Affiliate periodenya 4 bulan ya, Kak.",
        "Yang 300 Affiliate berjalan 6 bulan, Kak.",
    ):
        ok, reason = responder.validate(good, "REPLY_TANYA_HARGA")
        assert ok, (good, reason)

    for bad in (
        "Campaign berjalan selama 5 bulan ya ka.",
        "3-4 bulan maksimalnya.",
        "Paket ini berjalan 12 bulan ya, Kak.",
        "Minimal kontraknya 3 bulan.",
    ):
        ok, reason = responder.validate(bad, "REPLY_TANYA_HARGA")
        assert not ok, bad
        assert "duration" in reason

    ok, _ = responder.validate(
        "Komisi ke MCN masih dapat dinegosiasikan, dan hanya berlaku bila ada "
        "penjualan, Kak. Boleh sampaikan angka yang diharapkan?",
        "REPLY_TANYA_KOMISI",
    )
    assert ok, "the number-free commission answer must pass"


def test_teaches_safely_shares_the_validator_boundary():
    """ROADMAP 1.2 — nothing enters the style prompt that the validator would
    reject as output. The phrasings here are real agent turns from the
    corpus (guarantee, percentages, month durations, the tax workaround)."""
    for bad in (
        "nah disini ka garansi kami ya ka, kami jamin pasti akan dibuatkan videonya",
        "komisi affiliate di 10% dulu ya kak",
        "campaign berjalan selama 5 bulan ya ka",
        "3-4 bulan maksimal nya ya ka",
        "kaka mau pakai pajak atau non pajak juga bisa ya ka",
        # The corpus is full of this one, and it is what taught the generator
        # to bill monthly on 29 Jul 2026. The fee is per campaign.
        "Baik kak, mulai dari Rp25 juta per bulan ya kak.",
    ):
        assert not responder.teaches_safely(bad), bad

    for good in (
        "Baik kak, mulai dari Rp25 juta per campaign ya kak.",
        "kurasi berdasarkan histori penjualan 28 hari terakhir ya kak",
        "kami pantau performanya setiap bulan ya kak",
    ):
        assert responder.teaches_safely(good), good


def test_rejects_invented_contact_provenance():
    """Where we got someone's number is a compliance statement. BD authorised
    exactly one answer — TikTok Affiliate Partner — and every other sourcing
    claim is invented.

    Live on 30 Jul 2026: a tester asked "kaka tau nomor saya dari mana?", the
    message reached UNKNOWN, and REPLY_FREEFORM answered "dari data publik
    terkait informasi bisnis". Nobody had authorised that.
    """
    for bad in (
        "Kontak brand kami dapatkan dari data publik terkait informasi bisnis.",
        "Nomor Kakak kami peroleh dari database internal kami.",
        "kami dapatkan kontaknya dari marketplace ya kak",
        "Kontak Kakak kami peroleh melalui direktori bisnis online.",
    ):
        ok, reason = responder.validate(bad, "REPLY_FREEFORM")
        assert not ok, bad
        assert "TikTok Affiliate Partner" in reason


def test_accepts_the_authorised_contact_source():
    """The one sourcing claim BD stated (30 Jul 2026)."""
    ok, reason = responder.validate(
        "Kami mendapatkan kontak Kakak melalui TikTok Affiliate Partner ya, Kak.",
        "REPLY_TANYA_SUMBER_KONTAK",
    )
    assert ok, reason


def test_provenance_guard_allows_removal_and_ordinary_dari():
    """"hapus dari daftar" is the opposite of a provenance claim, and an
    earlier draft of the rule blocked our own privacy answer with it."""
    for good in (
        "Kontak Kak akan kami hapus dari daftar ya.",
        "Rincian paket bisa Kakak dapatkan dari deck yang kami kirim.",
    ):
        ok, reason = responder.validate(good, "REPLY_TANYA_SUMBER_KONTAK")
        assert ok, f"{good!r}: {reason}"


def test_rejects_empty_and_overlong():
    assert not responder.validate("   ", "OFFER_MEETING")[0]
    assert not responder.validate("a" * 1000, "OFFER_MEETING")[0]


def test_rejects_unrendered_placeholder():
    ok, reason = responder.validate("Halo {nama}, apa kabar?", "OFFER_MEETING")
    assert not ok
    assert "placeholder" in reason


def test_allows_client_gmv_claim():
    """'Rp1–2 miliar' is a client GMV figure, not one of our prices."""
    ok, reason = responder.validate(
        "Klien kami rata-rata mencatat GMV Rp1–2 miliar per bulan, Kak.",
        "REPLY_TANYA_SISTEM",
    )
    assert ok, reason


@pytest.mark.parametrize("package", knowledge.PACKAGES)
def test_every_real_package_price_passes_validation(package):
    ok, reason = responder.validate(
        f"Paket {package.name} {package.price_label} per campaign, Kak.",
        "REPLY_PAKET_DETAIL",
    )
    assert ok, reason


def test_prices_followed_by_punctuation_still_pass():
    """The digit class sweeps up a trailing ',' or '.' — strip it, or the whole
    real price list gets rejected and generation silently stops working."""
    ok, reason = responder.validate(
        "100 Affiliate Rp10.000.000, dan Paket Cuan Rp15.000.000.",
        "REPLY_PAKET_DETAIL",
    )
    assert ok, reason


# --- mid-conversation greetings ---------------------------------------------


def test_strips_leading_greeting_from_replies():
    """The blast already said selamat siang — replies must not greet again."""
    out = responder.strip_reply_greeting(
        "Siang Kak Cika, izin jelaskan singkat ya 🙏\n\n"
        "Sistemnya, kami menyediakan akun affiliate sesuai paket."
    )
    assert out.startswith("Izin jelaskan singkat")
    assert "Siang" not in out

    out2 = responder.strip_reply_greeting(
        "Halo Kak, paket kami mulai dari Rp25 juta per campaign sesuai kebutuhan."
    )
    assert out2.startswith("Paket kami mulai dari Rp25 juta")


def test_greeting_strip_never_eats_content():
    """If dropping the clause would leave almost nothing, leave it alone."""
    short = "Selamat siang, Kak. Terima kasih ya."
    assert responder.strip_reply_greeting(short) == short


def test_strip_durations():
    assert responder.strip_durations(
        "kami undang diskusi singkat sekitar 20–30 menit untuk membahasnya"
    ) == "kami undang diskusi singkat untuk membahasnya"
    assert responder.strip_durations(
        "meeting online 15-30 menit ya kak"
    ) == "meeting online ya kak"
    assert responder.strip_durations("meeting singkat saja") == "meeting singkat saja"


def test_non_greeting_replies_pass_through():
    text = "Baik, Kak. Paket kami Rp10 juta per campaign."
    assert responder.strip_reply_greeting(text) == text


def test_followup_keys_may_still_greet():
    """COLD_FU*/WARM_* fire after days of silence — greeting is correct there."""
    assert "COLD_FU2" not in responder.REPLY_KEYS
    assert "WARM_D2" not in responder.REPLY_KEYS
    assert "REPLY_TANYA_SISTEM" in responder.REPLY_KEYS
    assert "OFFER_MEETING" in responder.REPLY_KEYS


# --- fallback behaviour -----------------------------------------------------


def _convo() -> Conversation:
    return Conversation(jid="628@s.whatsapp.net", name="Cika", brand="Brand X")


def test_falls_back_when_no_api_key():
    cfg = Settings()
    cfg.anthropic_api_key = ""
    out = responder.generate(
        "REPLY_TANYA_HARGA", Intent.TANYA_HARGA, _convo(), "berapa?", "STATIC", cfg
    )
    assert out == "STATIC"


def test_operational_templates_are_never_generated():
    """Meeting links and reminders carry data, not persuasion."""
    cfg = Settings()
    cfg.anthropic_api_key = "sk-fake"
    for key in ("SCHEDULE_CONFIRM", "REMINDER", "BLASTING"):
        assert key not in responder.GENERATIVE_KEYS
        out = responder.generate(
            key, Intent.SETUJU, _convo(), "ok", "STATIC", cfg
        )
        assert out == "STATIC"


def test_generation_failure_falls_back(monkeypatch):
    cfg = Settings()
    cfg.anthropic_api_key = "sk-fake"

    import builtins

    real_import = builtins.__import__

    def boom(name, *a, **k):
        if name == "anthropic":
            raise ImportError("no anthropic")
        return real_import(name, *a, **k)

    monkeypatch.setattr(builtins, "__import__", boom)
    out = responder.generate(
        "OFFER_MEETING", Intent.NANTI_AJA, _convo(), "nanti aja", "STATIC", cfg
    )
    assert out == "STATIC"


def test_rejected_generation_falls_back(monkeypatch):
    """A reply that fails validation must never reach the contact."""
    cfg = Settings()
    cfg.anthropic_api_key = "sk-fake"

    class FakeBlock:
        type = "text"
        text = "Harga khusus Rp3.000.000 saja Kak, dijamin naik!"

    class FakeMessages:
        def create(self, **_):
            return type("R", (), {"content": [FakeBlock()], "stop_reason": "end_turn"})()

    class FakeClient:
        def __init__(self, **_):
            self.messages = FakeMessages()

    import bd_bot.responder as r

    fake_mod = type("M", (), {"Anthropic": FakeClient})
    monkeypatch.setitem(sys.modules, "anthropic", fake_mod)

    out = r.generate(
        "REPLY_TANYA_HARGA", Intent.TANYA_HARGA, _convo(), "berapa?", "STATIC", cfg
    )
    assert out == "STATIC", "invented price must be discarded"


@pytest.mark.parametrize("body", [
    "kami tidak bisa memberikan garansi angka spesifik",
    "kami tidak memberikan garansi penjualan",
    "kerja sama ini tanpa garansi angka",
    "belum ada garansi untuk hasil penjualan",
])
def test_a_refused_guarantee_may_be_written(body):
    """Denying a guarantee is the answer we want, and the substring check used
    to throw it away for containing the word. "dijamin naik gak GMV nya?" was
    answered "kami tidak bisa memberikan garansi angka spesifik" and rejected,
    so the brand got a blander template instead of a straight no. 18 Sep 2026."""
    ok, why = responder.validate(
        f"Untuk GMV, {body} ya, Kak. Boleh kita atur meeting singkat?",
        "REPLY_TANYA_TARGET",
    )
    assert ok, why


@pytest.mark.parametrize("body", [
    "ada garansi penjualan untuk brand Kakak",
    "kami berikan garansi hasil",
    # The negation is present but attached to something else — the window is
    # three words wide precisely so this still fails.
    "tidak ada minimal order dan garansi kami berikan penuh",
])
def test_a_promised_guarantee_is_still_rejected(body):
    ok, why = responder.validate(
        f"Tenang Kak, {body}. Boleh kita atur meeting singkat?",
        "REPLY_TANYA_TARGET",
    )
    assert not ok and "garansi" in why


def test_generation_cut_off_at_max_tokens_falls_back(monkeypatch):
    """A reply that ran out of tokens ends mid-sentence, and every other guard
    lets it through: it is short, quotes nothing, promises nothing. Added
    18 Sep 2026 after the deck grew and REPLY_PAKET_DETAIL started listing
    three tiers — the longest reply we generate, and the one closest to the
    cap. A half sentence is worse than the template it replaced."""
    cfg = Settings()
    cfg.anthropic_api_key = "sk-fake"

    class FakeBlock:
        type = "text"
        # Nothing here is invalid — that is the point.
        text = "Baik, Kak. Paket kami Rp10 juta per campaign, dengan durasi kerja bisa mencapai"

    class FakeMessages:
        def create(self, **_):
            return type(
                "R", (), {"content": [FakeBlock()], "stop_reason": "max_tokens"}
            )()

    class FakeClient:
        def __init__(self, **_):
            self.messages = FakeMessages()

    monkeypatch.setitem(
        sys.modules, "anthropic", type("M", (), {"Anthropic": FakeClient})
    )
    out = responder.generate(
        "REPLY_TANYA_HARGA", Intent.TANYA_HARGA, _convo(), "berapa?", "STATIC", cfg
    )
    assert out == "STATIC", "a reply cut off mid-sentence must not be sent"


def test_valid_generation_is_used(monkeypatch):
    cfg = Settings()
    cfg.anthropic_api_key = "sk-fake"
    good = (
        "Baik, Kak. Paket kami Rp10 juta per campaign. Apakah fokus "
        "utama Brand X ke awareness atau penjualan?"
    )

    class FakeBlock:
        type = "text"
        text = good

    class FakeMessages:
        def create(self, **_):
            return type("R", (), {"content": [FakeBlock()], "stop_reason": "end_turn"})()

    class FakeClient:
        def __init__(self, **_):
            self.messages = FakeMessages()

    monkeypatch.setitem(
        sys.modules, "anthropic", type("M", (), {"Anthropic": FakeClient})
    )
    out = responder.generate(
        "REPLY_TANYA_HARGA", Intent.TANYA_HARGA, _convo(), "berapa?", "STATIC", cfg
    )
    assert out == good


# --- knowledge base integrity -----------------------------------------------


def test_fact_sheet_lists_every_package():
    sheet = knowledge.fact_sheet()
    for p in knowledge.PACKAGES:
        assert p.name in sheet
        assert p.price_label in sheet


def test_every_package_price_is_in_the_allowlist():
    """Otherwise the bot could not quote its own price list."""
    for p in knowledge.PACKAGES:
        bare = p.price_label.replace("Rp", "")
        assert bare in knowledge.ALLOWED_AMOUNTS, f"{p.name} price not allowlisted"


def test_examples_cover_the_generative_intents():
    covered = {e.intent for e in knowledge.EXAMPLES}
    for intent in (
        Intent.TANYA_SISTEM,
        Intent.TANYA_HARGA,
        Intent.TOLAK_HALUS,
        Intent.TOLAK_TEGAS,
        Intent.PELAJARI_DULU,
    ):
        assert intent in covered, f"no grounding example for {intent}"


# --- a generated reply must not restart the pitch ---------------------------


def test_reintroduction_is_rejected():
    """Seen live: a tester answered the opening with "siang" and was
    introduced to the company a second time, ninety seconds after the first.
    They reported it as the bot not understanding them.

    The blast is a static template, so nothing generated here is ever the
    first message — an introduction can only mean the model restarted the
    pitch, and falling back to the static template is the safer reply."""
    from bd_bot import responder

    for text in (
        "Siang, Kak 😊\n\nPerkenalkan, saya Grace dari MCNAsia.biz, "
        "Official Partner TikTok & Shopee.",
        "Halo Kak, salam kenal ya. Boleh kami jadwalkan meeting?",
        "Izin memperkenalkan tim kami terlebih dahulu.",
    ):
        ok, reason = responder.validate(text, "REPLY_GREETING_NEEDS")
        assert not ok, f"re-introduction accepted: {text[:40]!r}"
        assert "re-introduces" in reason


def test_an_ordinary_greeting_reply_still_passes():
    """Greeting back is natural and deliberately allowed — only introducing
    the company again is the problem."""
    from bd_bot import responder

    ok, reason = responder.validate(
        "Siang, Kak 😊 Boleh dibantu, kebutuhan brand Kakak lebih ke "
        "peningkatan penjualan atau awareness?",
        "REPLY_GREETING_NEEDS",
    )
    assert ok, reason


def test_the_static_greeting_template_would_pass_its_own_validator():
    """The fallback has to survive the rule that rejects the generation, or a
    rejection would swap one bad reply for another."""
    from bd_bot import responder, templates

    ok, reason = responder.validate(
        templates.REPLY_GREETING_NEEDS.format(
            nama="Kak", company="MCNAsia.biz", brand="Brand Uji"
        ),
        "REPLY_GREETING_NEEDS",
    )
    assert ok, reason


# --- the greeting has to match the clock ------------------------------------


@pytest.mark.parametrize(
    "hour,expected",
    [(3, "malam"), (5, "pagi"), (7, "pagi"), (10, "pagi"), (11, "siang"),
     (14, "siang"), (15, "sore"), (17, "sore"), (19, "malam"), (23, "malam")],
)
def test_greeting_follows_the_clock(hour, expected):
    """The opening went out at 03.27 and at 23.07 both saying "Selamat
    siang" — the time of day was hardcoded into the templates."""
    from datetime import datetime
    from zoneinfo import ZoneInfo

    from bd_bot.templates import salam

    when = datetime(2026, 7, 29, hour, 0, tzinfo=ZoneInfo("Asia/Jakarta"))
    assert salam(when) == expected


def test_the_opening_greets_by_the_hour_it_is_sent():
    from datetime import datetime
    from zoneinfo import ZoneInfo

    from bd_bot import templates
    from bd_bot.config import Settings
    from bd_bot.models import Conversation

    cfg = Settings()
    convo = Conversation(jid="628@s.whatsapp.net", brand="Brand Uji")
    tz = ZoneInfo("Asia/Jakarta")

    night = templates.render("BLASTING", convo, cfg, datetime(2026, 7, 29, 3, 27, tzinfo=tz))
    noon = templates.render("BLASTING", convo, cfg, datetime(2026, 7, 29, 13, 0, tzinfo=tz))
    assert "Selamat malam" in night.text, night.text[:60]
    assert "Selamat siang" in noon.text, noon.text[:60]


def test_no_template_hardcodes_a_time_of_day():
    """A new template must not reintroduce the bug."""
    import re
    from pathlib import Path

    src = Path(__file__).resolve().parents[1] / "src" / "bd_bot" / "templates.py"
    # Only salam() may name the times of day, and comments may discuss them.
    body = src.read_text(encoding="utf-8").split("def _ctx", 1)[1]
    code = "\n".join(
        line for line in body.splitlines() if not line.lstrip().startswith("#")
    )
    stray = re.findall(r"Selamat (pagi|siang|sore|malam)", code)
    assert not stray, f"hardcoded greeting(s): {stray}"


def test_the_generator_is_told_to_ask_for_the_affiliate_volume():
    """BD's 31 Jul 2026 rewrite (deck pointer out, price-flexibility opening
    and the volume question in) lived only in the static template, so every
    successful generation dropped it — and generation is the normal path with
    USE_LLM_REPLIES on."""
    from bd_bot import responder

    situation = responder._situation("REPLY_TANYA_HARGA").lower()
    assert "kebutuhan affiliate" in situation
    assert "deck" not in situation
