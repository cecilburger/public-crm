"""kb-check — the price-drift lint (ROADMAP 3.4).

The corpus proved prices drift (decks quoting Rp30jt, ad-hoc Rp20jt
specials). This lint fails the build whenever the message bank states an
amount knowledge.py does not authorise.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bd_bot import cli, templates  # noqa: E402


def test_current_message_bank_is_clean():
    assert cli.kb_violations() == []


def test_unauthorised_template_amount_is_caught(monkeypatch):
    monkeypatch.setattr(
        templates,
        "REPLY_TANYA_HARGA",
        "Paket spesial hanya Rp12.500.000 untuk bulan ini, {nama}!",
    )
    problems = cli.kb_violations()
    assert any("REPLY_TANYA_HARGA" in p and "12.500.000" in p for p in problems)


def test_unauthorised_example_answer_is_caught(monkeypatch):
    from bd_bot import knowledge
    from bd_bot.models import Intent

    bad = knowledge.Example(
        Intent.TANYA_HARGA, "berapa?", "Mulai Rp9 juta saja, Kak."
    )
    monkeypatch.setattr(knowledge, "EXAMPLES", [bad])
    problems = cli.kb_violations()
    assert any("9 juta" in p for p in problems)


def test_affiliate_list_is_never_promised_before_the_deal():
    """BD tightened this on 29 Jul 2026: the list used to be promised "setelah
    diskusi SOW/kriteria", which a brand satisfies by taking one call. The
    list is the asset — it does not leave before the agreement does.

    Pinned across every place the rule is stated, because a generated reply
    is only as careful as the fact sheet behind it."""
    from bd_bot import knowledge, responder
    from bd_bot.models import Intent

    surfaces = {
        "knowledge.CURATION": knowledge.CURATION,
        "REPLY_TANYA_AFFILIATE": templates.REPLY_TANYA_AFFILIATE,
        "situation": responder._SITUATIONS["REPLY_TANYA_AFFILIATE"],
        "example": knowledge.examples_for(Intent.TANYA_AFFILIATE)[0].answer,
    }
    for name, text in surfaces.items():
        lowered = text.lower()
        assert "sow" not in lowered, f"{name} still gates the list on an SOW talk"
        assert "deal" in lowered, f"{name} does not gate the list on the deal"


def test_no_surface_quotes_a_retired_duration():
    """Guards the tier ladder against the wrong months, whichever way it moves.

    Three states so far: a 4-month 300 and a 6-month 500 (until 18 Aug 2026);
    ONE package at two months (18 Aug – 18 Sep); and, since the 18 Sep deck,
    a ladder of three whose periods grow with them — 100 = 2 bulan,
    200 = 4 bulan, 300 = 6 bulan. Note the 300 changed length between the
    first state and the third: four months then, six now. That is the trap
    this guards, because copy written in either era reads plausibly.

    What is retired today: the 150 tier, and the old 500 @ Rp45jt. The 500 on
    the current deck is a special bundle at Rp55jt, not that one.

    Pinned on the surfaces, not just the constants, because that is where the
    months are hardcoded in prose.
    """
    from bd_bot import knowledge, responder

    assert [p.duration for p in knowledge.PACKAGES] == ["2 bulan", "4 bulan", "6 bulan"]
    assert knowledge.CAMPAIGN_DURATION == (
        "100 Affiliate = 2 bulan; 200 Affiliate = 4 bulan; 300 Affiliate = 6 bulan"
    )
    # The pairing, not just the set: "300 Affiliate ... 4 bulan" is every
    # figure authorised and still the old catalogue.
    assert {p.name: p.duration for p in knowledge.PACKAGES}["300 Affiliate"] == "6 bulan"

    retired = ("150 Affiliate", "45.000.000", "45 juta")
    surfaces = {
        "REPLY_TANYA_HARGA": templates.REPLY_TANYA_HARGA,
        "REPLY_PAKET_DETAIL": templates.REPLY_PAKET_DETAIL,
        "REPLY_TANYA_PAKET_LAMA": templates.REPLY_TANYA_PAKET_LAMA,
        "REPLY_TANYA_PEMBAYARAN": templates.REPLY_TANYA_PEMBAYARAN,
        "REPLY_NEGO_HARGA": templates.REPLY_NEGO_HARGA,
        "REPLY_BRAND_KECIL": templates.REPLY_BRAND_KECIL,
        "situation": responder._SITUATIONS["REPLY_PAKET_DETAIL"],
    }
    for name, text in surfaces.items():
        for gone in retired:
            assert gone not in text, f"{name} still sells the retired {gone}"

    # The fact sheet is the one place the retired tiers may be NAMED, because
    # it names them to forbid them.
    assert "sudah TIDAK berlaku" in knowledge.fact_sheet()


def test_affiliate_and_ads_prices_do_not_share_a_billing_unit():
    """The two catalogues bill differently and the sets must not overlap.

    An amount in both would be unjudgeable by the monthly guard: it could not
    tell a correct "Rp5 juta per bulan" from a wrong "Rp10 juta per bulan".
    """
    from bd_bot import knowledge

    assert not (knowledge.PER_CAMPAIGN_AMOUNTS & knowledge.PER_MONTH_AMOUNTS)
    assert knowledge.ALLOWED_AMOUNTS == (
        knowledge.PER_CAMPAIGN_AMOUNTS | knowledge.PER_MONTH_AMOUNTS
    )


def test_the_rejection_reply_names_other_services_without_selling_them():
    """"Belum tertarik" is usually a no to affiliate, not to us, so the close
    lists the other service lines.

    Copy replaced 13 Aug 2026 with the BD team's own wording. It names "Full
    service dengan garansi ROI", which OTHER_SERVICES_NOTE forbids for
    GENERATED text — that rule exists so a model cannot invent a guarantee at
    the moment one is most tempting. This template is static and was written
    by the people who sell the thing, so the service NAME is allowed; the
    numbers that would turn a name into an offer are still not.

    The note itself widened on 18 Sep 2026: the deck now prices Full Service,
    TVC and two bundles, and a price the brand is already holding may be
    confirmed. THIS template still carries no number — a rejection is the
    wrong moment to start quoting, and the assertions below keep it that way.
    """
    from bd_bot import knowledge, responder

    text = templates.REPLY_TOLAK_TEGAS
    assert "REPLY_TOLAK_TEGAS" not in responder.GENERATIVE_KEYS, (
        "a generator must never improvise this list"
    )
    for service in (
        "Campaign Affiliate",
        "Live streaming",
        "TVC",
        "Full service",
        "berbasis AI",
        "Ads",
    ):
        assert service in text, f"{service} missing from the menu"

    # No prices, no durations, no scope — the things that turn a service name
    # into a commitment nobody has signed off.
    for sold in ("rp", "juta", "%", "per bulan", "diskon", "promo"):
        assert sold not in text.lower(), f"the rejection reply sells: {sold}"

    # And the rule still stands where the generator can see it — in the form
    # it took on 18 Sep 2026, when the deck started carrying prices for Full
    # Service, TVC and the bundles. Those figures became quotable (the brand
    # holds the deck), so a blanket "jangan menyebut harga" is no longer what
    # the note says. What it still forbids is what turns a name into a
    # commitment: scope, targets, guarantees — and a price for anything the
    # deck does not price.
    note = knowledge.OTHER_SERVICES_NOTE.lower()
    assert "hanya boleh disebut namanya" in note, "unpriced services must stay names"
    assert "jaminan hasil" in note and "roi" in note
    assert "'mulai'" in note, "a START FROM figure must be quoted as a floor"

def test_gmv_claims_are_not_flagged():
    """'Rp1–2 miliar per bulan' is a client GMV figure, not a price."""
    assert not any("miliar" in p for p in cli.kb_violations())


def test_cli_exit_codes(monkeypatch, capsys):
    from bd_bot.config import Settings

    assert cli.cmd_kb_check(None, Settings(), None) == 0
    assert "OK" in capsys.readouterr().out

    # Rp5jt became an authorised ads price on 18 Aug 2026 — pick an amount
    # that is in no catalogue, or this asserts nothing.
    monkeypatch.setattr(templates, "BLASTING", "Harga cuma Rp7.500.000 kak!")
    assert cli.cmd_kb_check(None, Settings(), None) == 1
    assert "FAILED" in capsys.readouterr().out


# --- the 18 Sep deck reaches the STATIC templates too -----------------------
#
# The keys below are not in responder.GENERATIVE_KEYS: their text ships
# verbatim, so a fact sheet that knows about a new offer changes nothing for
# them. Both were found empty-handed after the deck swap — a brand asking
# about ads was shown five packages and never the new bundle, and "bisa
# custom?" was answered without the deck's own custom package.

def test_the_ads_template_lists_the_shopee_bundle():
    from bd_bot import templates, responder

    assert "REPLY_TANYA_ADS" not in responder.GENERATIVE_KEYS, (
        "this template ships verbatim — if that changes, the assertions below "
        "stop guarding what a brand actually receives"
    )
    t = templates.REPLY_TANYA_ADS
    assert "Rp19.899.000" in t, "the Special Bundle is missing from the ads list"
    assert "minimal kontrak 6 bulan" in t, "the contract minimum travels with the price"
    assert "di luar budget iklan" in t


def test_the_custom_template_names_the_deck_package_and_its_floor():
    from bd_bot import templates, responder

    assert "REPLY_TANYA_CUSTOM" not in responder.GENERATIVE_KEYS
    t = templates.REPLY_TANYA_CUSTOM
    assert "Paket Custom Eksklusif" in t
    # "mulai" is not decoration: the deck prints START FROM, and a brand told
    # "Rp50 juta" has been given a number that cannot hold.
    assert "mulai Rp50.000.000" in t
    assert "500 akun affiliate" in t
