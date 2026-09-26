"""The hand-labeled gold intent set (ROADMAP 0.2).

tests/data/gold_intents.csv holds 221 real client turns from the chat
exports, anonymized (no personal names, emails, phone numbers; sources are
opaque file ids), each hand-labeled with the intent a correct classifier
SHOULD output from the text alone. Multi-intent turns carry their most
actionable request; pure context (bare emails, form data) is `unknown`.
Newlines inside a turn are stored as " | " — normalisation treats both as
whitespace, so classification is unaffected.

Measured baselines (rules only), the floor ratchets upward with each:
  Phase 0: 128/221 = 57.9%   (dominant miss: bare time proposals)
  Phase 2: 154/221 = 69.7%   (time/day proposals now SETUJU; brp/berapa
                              no longer steals scheduling questions;
                              soft-decline recall added)
  Phase 3: 201/240 = 83.8%   (doubled-letter acks, bare clock times,
                              reschedule/day-part proposals, gmna/spt apa;
                              19 gold cases added from the replay UNKNOWNs)
  Phase 4: 205/240 = 85.4%   (percentages and emails survive normalisation;
                              TUNGGU / MINTA_LINK / TANYA_LIVE added; sharelok,
                              promo, "hari ini keluar", "kurang tertarik")
  Phase 5: 212/250 = 84.8%   (10 rows mined from production inbound, source
                              p01 — all 10 pass; the ratio dips only because
                              the denominator grew. The 6 remaining misses on
                              price/system were checked: no rule for their
                              gold intent matches at all, so they predate
                              this phase rather than regress from it.)
  Phase 6: 240/277 = 86.6%   (source s01: 22 rows from `inbound/`, the 36
                              social-media→WhatsApp conversations where the
                              BRAND wrote first. LEAD_IKLAN and ISI_FORM are
                              new intents; TANYA_AFFILIATE now hears requests
                              for the affiliate data, NANTI_AJA hears "nanti
                              aku wa", BRAND_KECIL hears "belum masuk untuk
                              UMKM", and a weekday with "aja" after it reads
                              as a counter-proposal. 21 of the 22 pass; the
                              miss is kept on purpose — see below.)
  Phase 7: 287/323 = 88.9%   (source s03: 26 more real turns from `inbound/`,
                              the second mining round of 24 Sep 2026 — the
                              SELLING turns. MINTA_INFO ("mau info affiliate"),
                              TANYA_LAYANAN ("layanan apa aja"), BUTUH_AFFILIATE
                              ("saya butuh affiliate") and PERNAH_AGENCY
                              ("pernah pakai agency, gak ada hasil") are new
                              intents; BRAND_KECIL hears a below-floor ask
                              ("50 dulu bisa gk?"), TANYA_TARGET a bare "ada
                              garansi?", TANYA_PEMBAYARAN "2 tahap", and
                              TANYA_MEETING_DETAIL "jam kerja atau bukan?".
                              Two rules lost a false positive: "promo\w*" was
                              matching "dipromosiin", and PELAJARI_DULU's
                              "liat" was matching inside "affiLIATe". All 26
                              pass, including two deliberate negative
                              controls kept UNKNOWN — see below.)
  Phase 8: source s05 (round 3, 24 Sep 2026 — the wider inbound test on
                              real corpus questions). TANYA_HARGA_LIVE ("harga
                              LS?"), MINTA_PROFILE ("ada rate card atau company
                              profile?"), AGENCY_VENDOR and
                              TANYA_VIDEO_SETELAH_KONTRAK are new; BUTUH_AFFILIATE
                              hears the need beside a category, ISI_FORM a
                              single label, TANYA_PORTOFOLIO "contoh live" and
                              "brand kosmetik apa yg sudah kerja sama",
                              PELAJARI_DULU "mikir2 dl", TANYA_KATEGORI_PRODUK
                              "produk digital bisa?", and a bare "%" now reads
                              as "persen". Row s01 "kita handle beberapa
                              klien…" relabelled unknown -> agency_vendor: it
                              has a handler now, same grounds as Phase 6.)
0 rejection false positives at every measurement.

Source `p01` is different in kind from f00-f30: those came from chat exports
before launch, these are live inbound the running bot could not place. They
are the gaps that cost real API calls, so they are the ones worth locking.

Phase 4 relabelled 10 rows from `unknown`. That was a spec change, not a
correction: those turns were unknown because nothing could act on them, and
they now have handlers. "Pure context is unknown" still holds for the rest —
bare emails, attachment captions.

Phase 6 relabelled three more (f06, f10, f11) on the same grounds, and it is
the reason form data dropped out of that sentence: a filled qualification
form was "pure context" only for as long as nothing was waiting for it. The
inbound SOP is waiting for it — it is the turn that moves a lead from the
form to the service summary — so it is now ISI_FORM. The behaviour did not
change with the label: the flow's qualify branch treats ISI_FORM exactly as
it treated the UNKNOWN these rows used to be.

The one deliberate miss in s01 is "arkha art | owner | [link]" — a filled
form with no field labels at all, just the three values. Every rule that
would catch it also catches any three-line message, and answering a stranger
with the service summary because they happened to send three lines is worse
than leaving this one unplaced. It stays in the set, labelled correctly, so
the next mining round can see it is still open.

The two s03 rows left `unknown` are open on purpose: "Kita coba yg buat
konten video dulu kak" names a service (content production for the official
account) that has no template yet, and "Klo produk digital itu apakah bisa
jualan di shopee dan tiktok shop?" turns on the brand's particular product —
the team answered it from knowledge the bot does not hold ("shopee ga bisa,
tiktok bisa"), so a human should.

Row f05 ("open kerjasama with CPS only") moved tanya_komisi ->
tanya_komisi_only on the same grounds: a brand stating it works CPS-only is
proposing a scheme we do not offer, and the answer it needs is the refusal,
not an explanation of how commission is split.
"""

from __future__ import annotations

import csv
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bd_bot import intents  # noqa: E402
from bd_bot.models import Intent  # noqa: E402

GOLD = Path(__file__).resolve().parent / "data" / "gold_intents.csv"

#: The gold set is real client turns — anonymised, but the brands and their
#: words are real — so it is not published with the CRM copy (see README,
#: "what is not here"). Only the four tests that read the file are gated;
#: the rule tests below need nothing but the rules, and skipping them too
#: (trained-cb's whole-module skip) would hide regressions in this copy.
_needs_gold = pytest.mark.skipif(
    not GOLD.is_file(), reason="gold_intents.csv is not published with this repo"
)

#: Measured 0.889 on 24 Sep 2026 (287/323), after the second inbound round
#: added the `s03` rows; 0.874 on 18 Sep (257/294) after the deck swap. The
#: floor sits just below the measurement, and only ever moves up — Phase 6
#: measured 0.866 and floored at 0.85.
ACCURACY_FLOOR = 0.87

REJECTIONS = {Intent.TOLAK_HALUS, Intent.TOLAK_TEGAS, Intent.OPT_OUT}


def _rows() -> list[dict[str, str]]:
    with GOLD.open(encoding="utf-8") as f:
        return list(csv.DictReader(f))


@_needs_gold
def test_gold_set_is_large_and_well_formed():
    rows = _rows()
    assert len(rows) >= 200
    valid = {i.value for i in Intent}
    for r in rows:
        assert r["intent"] in valid, r
        assert r["text"].strip(), r


@_needs_gold
def test_gold_set_is_anonymised():
    blob = "\n".join(r["text"] for r in _rows())
    assert "@" not in blob.replace("[email]", ""), "email leaked into fixture"
    assert not re.search(r"(?:\+?62|08)\d[\d\s.-]{7,}\d", blob), "phone leaked"


@_needs_gold
def test_rules_accuracy_meets_the_floor():
    rows = _rows()
    correct = sum(
        1 for r in rows if intents.classify_rules(r["text"]).value == r["intent"]
    )
    accuracy = correct / len(rows)
    assert accuracy >= ACCURACY_FLOOR, (
        f"rules accuracy {accuracy:.1%} ({correct}/{len(rows)}) fell below "
        f"the Phase-0 floor {ACCURACY_FLOOR:.0%}"
    )


@_needs_gold
def test_no_false_rejections():
    """Q2: a live lead misread as a rejection gets a goodbye instead of an
    answer. Zero tolerance — measured zero at Phase 0."""
    for r in _rows():
        if r["intent"] in {i.value for i in REJECTIONS}:
            continue
        pred = intents.classify_rules(r["text"])
        assert pred not in REJECTIONS, (
            f"non-rejection turn classified {pred.value}: {r['text'][:80]!r}"
        )


def test_ad_lead_opener_is_never_a_rejection():
    """'Saya tertarik…' contains 'tertarik' — the TOLAK_TEGAS negation rules
    must never fire on it. This opener starts every inbound ad lead."""
    pred = intents.classify_rules(
        "[Spesial offer] Saya tertarik untuk Paket 150 affiliate Mcnasia.biz?"
    )
    assert pred not in REJECTIONS


#: No real opt-out exists in the corpus (nobody said STOP), so recall is
#: proven on synthetic phrasings instead — missing one means the bot keeps
#: messaging someone who told it to stop.
@pytest.mark.parametrize(
    "text",
    [
        "STOP",
        "Stop!",
        "stop dulu ya",
        "jangan hubungi saya lagi",
        "tolong jangan chat lagi ya",
        "hapus nomor saya",
        "unsubscribe",
        "blokir aja kalau gitu",
    ],
)
def test_synthetic_opt_out_recall(text):
    assert intents.classify_rules(text) is Intent.OPT_OUT


# --- the Claude fallback may guess at questions, not at decisions ------------


def _with_llm(monkeypatch, guess: Intent):
    """Pretend the fallback returned `guess`, without an API call."""
    from bd_bot.config import Settings

    cfg = Settings()
    cfg.use_llm_intents = True
    cfg.anthropic_api_key = "test"
    monkeypatch.setattr(intents, "classify_llm", lambda text, c: guess)
    return cfg


@pytest.mark.parametrize(
    "guess",
    [Intent.SETUJU, Intent.OK_LANJUT, Intent.NANTI_AJA, Intent.PELAJARI_DULU,
     Intent.TERUSKAN_TIM, Intent.MINTA_TELEPON, Intent.TERIMA_KASIH],
)
def test_a_decisive_guess_is_refused(monkeypatch, guess):
    """Measured on the gold set, the fallback answers with a confident label
    where `unknown` is correct, and the labels it invents are the decisive
    ones. A wrong SETUJU books a meeting; a wrong TOLAK_TEGAS ends the
    conversation. Those stay with a human."""
    cfg = _with_llm(monkeypatch, guess)
    got = intents.classify("kalimat yang tidak cocok aturan apa pun", cfg)
    assert got is Intent.UNKNOWN, f"{guess.value} was accepted from the fallback"


@pytest.mark.parametrize(
    "guess",
    [Intent.TANYA_HARGA, Intent.TANYA_SISTEM, Intent.TANYA_KOMISI,
     Intent.TANYA_AFFILIATE, Intent.TANYA_PORTOFOLIO,
     Intent.OPT_OUT, Intent.TOLAK_HALUS, Intent.TOLAK_TEGAS],
)
def test_a_question_guess_is_accepted(monkeypatch, guess):
    """Answering a price question that was really about commissions sends
    slightly-off information and the brand asks again — cheap.

    Refusals are here for the opposite reason, and it took a live failure to
    see it: backing off from a brand who was still interested costs a
    follow-up they can restart, while MISSING a refusal means continuing to
    sell to someone who said no. "gak minat ka" reached the fallback, which
    read it correctly as a refusal, and the constraint threw that away — so
    the bot asked them for their email address."""
    cfg = _with_llm(monkeypatch, guess)
    assert intents.classify("kalimat yang tidak cocok aturan apa pun", cfg) is guess


def test_the_fallback_never_overrides_a_rule(monkeypatch):
    cfg = _with_llm(monkeypatch, Intent.TANYA_HARGA)
    assert intents.classify("stop jangan hubungi saya lagi", cfg) is Intent.OPT_OUT


# --- "can you handle my brand?" ---------------------------------------------


@pytest.mark.parametrize(
    "text",
    ["pagi, brand saya elektronik kak apakah bisa?",
     "elektronik kak, apakah bisa? brand saya colokan terminal",
     "brand saya skincare apakah bisa?",
     "kami brand fnb, bisa handle ga?",
     "cocok ga buat brand kecil?"],
)
def test_a_category_fit_question_is_answered(text):
    """A brand naming its category and asking whether we can take it on is a
    buying signal. It dead-ended twice in live testing, and two dead ends in
    a row is the handover threshold."""
    assert intents.classify_rules(text) is Intent.TANYA_KECOCOKAN


@pytest.mark.parametrize(
    "text,expected",
    [("Jika Shopee nya sudah punya toko tinggal jalani aja sistem kalian, itu bagaimana?",
      Intent.TANYA_SISTEM),
     ("brand saya mau meeting jam 3 bisa?", Intent.SETUJU),
     ("affiliate nya kriteria apa kak?", Intent.TANYA_AFFILIATE),
     ("harganya berapa kak?", Intent.TANYA_HARGA)],
)
def test_the_fit_rule_does_not_steal_its_neighbours(text, expected):
    """It sits between the creator questions and the greedy price rule, and
    an unbounded "bisa … handle" once matched across three sentences."""
    assert intents.classify_rules(text) is expected


# --- typo repair -------------------------------------------------------------


def _rules_only() -> "Settings":
    from bd_bot.config import Settings

    cfg = Settings()
    cfg.use_llm_intents = False
    return cfg


@pytest.mark.parametrize(
    "typo,expected",
    [("brand saya elektrokin kak apakah bisa?", Intent.TANYA_KECOCOKAN),
     ("affiliat nya kriteria apa kak?", Intent.TANYA_AFFILIATE),
     ("berapa komisinya kak?", Intent.TANYA_KOMISI)],
)
def test_a_typo_in_a_domain_word_is_repaired(typo, expected):
    assert intents.classify(typo, _rules_only()) is expected


def test_repair_only_runs_after_a_miss():
    """It is a second pass on purpose: a correction may rescue an unmatched
    turn, never re-route one the rules already placed."""
    cfg = _rules_only()
    for text, want in [
        ("stop jangan hubungi saya lagi", Intent.OPT_OUT),
        ("harganya berapa kak?", Intent.TANYA_HARGA),
        ("besok jam 10 bisa kak?", Intent.SETUJU),
    ]:
        assert intents.classify(text, cfg) is want


def test_shorthand_is_left_alone():
    """Half of what brands type is deliberate abbreviation the rules are
    written against — "bs", "gk", "brp" must not be "corrected"."""
    from bd_bot.intents import _despell

    for shorthand in ("bs ka", "gk dulu ya", "brp harganya", "sy cek dl"):
        assert _despell(shorthand) == shorthand


# --- declining the meeting without declining the offer ----------------------


@pytest.mark.parametrize(
    "text",
    ["apakah bisa via chat saja? saya sdg tidak available",
     "chat aja ya kak", "gak usah meeting, lewat wa aja",
     "boleh di wa aja kak infonya"],
)
def test_prefer_chat_is_recognised(text):
    """A brand saying "let's keep this in chat" is not rejecting the offer,
    and there was no handler for it — MINTA_TELEPON covers wanting a call,
    nothing covered wanting no call."""
    assert intents.classify_rules(text) is Intent.MINTA_CHAT


@pytest.mark.parametrize(
    "text,expected",
    [("bisa telepon aja?", Intent.MINTA_TELEPON),
     ("bisa zoom besok jam 10?", Intent.MINTA_TELEPON),
     ("nah disini brlaku untuk itu gk ka?", Intent.UNKNOWN)],
)
def test_prefer_chat_does_not_steal_its_neighbours(text, expected):
    """"di sini" is an ordinary "here" — as a chat-request trigger it took
    two unrelated gold turns."""
    assert intents.classify_rules(text) is expected


@pytest.mark.parametrize(
    "text",
    ["kalau by request apakah bisa? seperti custom gitu",
     "bisa custom paket ga kak?", "paketnya bisa disesuaikan?", "ada paket khusus?"],
)
def test_asking_whether_packages_bend_is_recognised(text):
    """Packages do scale with affiliate count (knowledge.py), so this is
    answerable — it was falling to unknown and escalating instead."""
    assert intents.classify_rules(text) is Intent.TANYA_CUSTOM


@pytest.mark.parametrize(
    "text,expected",
    [("harganya berapa kak?", Intent.TANYA_HARGA),
     ("detail paketnya apa aja?", Intent.TANYA_HARGA)],
)
def test_the_custom_rule_leaves_price_questions_alone(text, expected):
    """It sits ahead of TANYA_HARGA, whose paket rules would otherwise answer
    the price ladder instead of the question actually asked."""
    assert intents.classify_rules(text) is expected


#: Intents that honour "send the material, stop pushing the meeting": both
#: answer in chat and neither adds the meeting gadget on top. TANYA_ADS is
#: here because it is the *more* specific read of an ads request — it ships
#: the ads deck rather than the company profile.
_SEND_IT_OVER = (Intent.MINTA_CHAT, Intent.TANYA_ADS)


@pytest.mark.parametrize(
    "text",
    ["kirim kan aja dulu biar aku pertimbangkan. ko langsung ngajak meeting sih kak",
     "boleh share untuk paket ads", "kirim paket yah kak",
     "lewat chat dulu aja ka , detail paket nya", "kok langsung ngajak meeting sih",
     "share detailnya dulu aja ya"],
)
def test_send_it_over_first_is_not_an_agreement(text):
    """All six are one request — send the material, stop pushing the meeting.

    Every line here is verbatim from the 29 Jul pilot. "boleh share untuk paket
    ads" was read as SETUJU and answered with meeting slots; the tester wrote
    back "ko langsung ngajak meeting sih kak", which fell to unknown and was
    answered by asking for their email address for the Meet invite. What must
    never come back is an acceptance — which of the two chat-answering intents
    wins matters less than that."""
    assert intents.classify_rules(text) in _SEND_IT_OVER


@pytest.mark.parametrize(
    "text",
    ["apakah ada target sales", "apakah ada target penjualan",
     "ada garansi penjualan ga kak?", "dijamin naik berapa persen kak?",
     "kalau gak laku gimana kak?", "berapa kenaikan gmv nya?"],
)
def test_results_questions_are_not_answered_with_the_sample_guarantee(text):
    """The near misses were worse than silence. "ada garansi penjualan ga
    kak?" reached TANYA_SAMPLE and came back with the sample-replacement
    guarantee — a confident yes to a question about guaranteed sales."""
    assert intents.classify_rules(text) is Intent.TANYA_TARGET


@pytest.mark.parametrize(
    "text",
    ["Apa ada Kpi nya apa ya ?", "ada kpi nya ga kak", "kpi nya apa aja?",
     "apa indikator keberhasilan campaign nya?"],
)
def test_kpi_questions_reach_the_kpi_answer(text):
    """Added 31 Jul 2026. "Apa ada Kpi nya apa ya?" fell to UNKNOWN, so it was
    escalated and answered with "boleh dijelaskan lebih detail maksud Kakak?"
    — asking a brand to explain a one-word question the bot should be able to
    answer."""
    assert intents.classify_rules(text) is Intent.TANYA_KPI


def test_a_kpi_question_asking_for_a_number_is_still_a_target_question():
    """The two are a hair apart and the safe side is the refusal: "KPI target
    sales-nya berapa?" wants a committed figure, and TANYA_TARGET is the reply
    that declines to give one."""
    assert intents.classify_rules(
        "KPI target sales nya berapa?"
    ) is Intent.TANYA_TARGET


def test_kpi_inside_a_compound_question_does_not_hijack_it():
    """Gold f11 asks five things at once and is routed on the package/system
    question. KPI is one clause of it, not what the message is about — but it
    must still show up in the multi-part escalation a human reads."""
    compound = (
        "Saya tertarik untuk Paket 150 affiliate Mcnasia.biz? tata cara "
        "gimana ? apa hasil yg di dapatkan ? adakah KPI ? cost ?"
    )
    assert intents.classify_rules(compound) is not Intent.TANYA_KPI
    assert Intent.TANYA_KPI in intents.question_topics(compound)


def test_the_sample_guarantee_question_still_reaches_its_own_answer():
    """The disambiguation must cut both ways."""
    assert intents.classify_rules(
        "misal ud kirim sample trs affiliatenya gk review gimana?"
    ) is Intent.TANYA_SAMPLE


@pytest.mark.parametrize(
    "text,expected",
    [("Soalny ka aku jualan baru banget dan bukan brand besar", Intent.BRAND_KECIL),
     ("brand saya masih kecil kak", Intent.BRAND_KECIL),
     ("masih ada paket 150 kak?", Intent.TANYA_PAKET_LAMA),
     ("Jd ini meeting brapa orang ka?", Intent.TANYA_MEETING_DETAIL),
     # A brand INTRODUCING itself is not objecting to its own size, and a
     # price objection mentioning umkm belongs to the price rules.
     ("saya punya brand baru, nama : perlyco.id", Intent.UNKNOWN),
     ("Ok dengan angka fee yang menurut aku sebagai pelaku umkm agak pricing",
      Intent.TANYA_HARGA)],
)
def test_size_and_legacy_package_routing(text, expected):
    assert intents.classify_rules(text) is expected


@pytest.mark.parametrize(
    "text,expected",
    [("PT nya apa namanya kak?", Intent.TANYA_LEGALITAS),
     ("ada NPWP?", Intent.TANYA_LEGALITAS),
     ("kalau di tengah jalan mau berhenti gimana?", Intent.TANYA_REFUND),
     ("bisa refund ga kalau gak sesuai?", Intent.TANYA_REFUND),
     ("videonya boleh kami repost ga?", Intent.TANYA_HAK_KONTEN),
     ("hak cipta kontennya punya siapa?", Intent.TANYA_HAK_KONTEN),
     ("kakak handle kompetitor kami juga ga?", Intent.TANYA_EKSKLUSIVITAS),
     ("transfer ke rekening mana?", Intent.TANYA_REKENING),
     ("kalau produk rokok bisa?", Intent.TANYA_KATEGORI_PRODUK),
     ("harus halal ga?", Intent.TANYA_KATEGORI_PRODUK),
     ("bisa untuk brand di luar jakarta?", Intent.TANYA_JANGKAUAN),
     ("kami di bali, bisa ga kak?", Intent.TANYA_JANGKAUAN)],
)
def test_facts_bd_supplied_are_routed(text, expected):
    """Each of these used to be answered with something unrelated, or left to
    the generator to improvise (BD supplied the facts 30 Jul 2026)."""
    assert intents.classify_rules(text) is expected


@pytest.mark.parametrize(
    "text,expected",
    [("minimal stok berapa yang harus disiapkan?", Intent.TANYA_STOK),
     ("kalau stok habis di tengah campaign gimana?", Intent.TANYA_STOK),
     ("produk kami sold out gimana?", Intent.TANYA_STOK),
     # Sample logistics stay with TANYA_SAMPLE — the two overlap in wording
     # but not in answer.
     ("sample nya berapa pcs?", Intent.TANYA_SAMPLE),
     ("misal ud kirim sample trs affiliatenya gk review gimana?",
      Intent.TANYA_SAMPLE)],
)
def test_stock_questions_split_from_sample_questions(text, expected):
    """"minimal stok berapa?" used to reach TANYA_HARGA through the bare
    "berapa" rule and came back with the price ladder."""
    assert intents.classify_rules(text) is expected


def test_the_stock_answer_states_no_minimum_figure():
    """BD sets no minimum, so any number here would be invented."""
    import re

    from bd_bot import templates

    body = templates.REPLY_TANYA_STOK
    assert not re.search(r"\b\d+\s*(pcs|buah|unit|produk)\b", body, re.I), body
    assert "hold campaign" in body.lower(), "the sold-out reassurance is the point"


def test_a_brand_self_description_is_not_an_exclusivity_question():
    """"exclusive" appears in brands' own copy. Matching it turned the NORDES
    self-introduction into an answer about competitor conflicts."""
    assert intents.classify_rules(
        "I'm from NORDES, a local skincare brand with a premium minimalist "
        "approach and an exclusive formula"
    ) is not Intent.TANYA_EKSKLUSIVITAS


@pytest.mark.parametrize(
    "text", ["STOP", "stop", "stop dong kak", "jangan kirim pesan lagi ya, stop"]
)
def test_opt_out_still_fires(text):
    assert intents.classify_rules(text) is Intent.OPT_OUT


@pytest.mark.parametrize(
    "text",
    ["di tengah periode mau stop bisa?", "kalau mau stop campaign nya gimana?",
     "stop kontrak bisa?"],
)
def test_stopping_a_campaign_is_not_opting_out(text):
    """Opt-out is permanent and irreversible — a contract question that trips
    it kills the lead for good."""
    assert intents.classify_rules(text) is Intent.TANYA_REFUND


def test_the_bank_account_number_never_goes_out_in_chat():
    """Payment follows contract and invoice. A bot handing account numbers to
    whoever asks teaches brands to accept them over WhatsApp, which is the
    habit payment-fraud impersonation depends on."""
    from bd_bot import knowledge, templates

    # In the CRM copy the number comes from PAYMENT_ACCOUNT_NUMBER in the
    # environment and is empty by default (25 Sep 2026); "" is a substring of
    # every template, so the check only means something when it is set.
    if not knowledge.PAYMENT_ACCOUNT_NUMBER:
        pytest.skip("PAYMENT_ACCOUNT_NUMBER is not configured in this checkout")
    for name in dir(templates):
        body = getattr(templates, name)
        if isinstance(body, str) and not name.startswith("_"):
            assert knowledge.PAYMENT_ACCOUNT_NUMBER not in body, name


def test_an_ads_request_gets_the_ads_deck_not_the_profile():
    """The one line in that set that names a product routes to it."""
    assert intents.classify_rules("boleh share untuk paket ads") is Intent.TANYA_ADS


@pytest.mark.parametrize(
    "text,expected",
    [("kirim sample dulu ya kak", Intent.TANYA_SAMPLE),
     ("boleh saya share ke tim dulu", Intent.TERUSKAN_TIM),
     ("nanti saya share ke atasan saya", Intent.TERUSKAN_TIM),
     ("boleh minta portofolionya", Intent.TANYA_PORTOFOLIO),
     ("minta pl dong", Intent.TANYA_HARGA),
     ("oke boleh kak besok jam 2", Intent.SETUJU)],
)
def test_the_send_it_over_rule_stays_in_its_lane(text, expected):
    """It sits high in the order, so it is the one most able to steal.

    Each of these was stolen by a draft of it: a sample request, forwarding to
    the team, a portfolio ask, a price-list ask, and a genuine booking."""
    assert intents.classify_rules(text) is expected


@pytest.mark.parametrize(
    "text",
    ["untuk plnya apakah bisa didiskusikan", "minta pl dong", "pl nya berapa kak",
     "price list nya ada?", "pricelist kak"],
)
def test_pl_is_the_price_list(text):
    """Both the team and the brands write "pl". Checked against all 356 real
    client turns before adding it: it never appears as anything else."""
    assert intents.classify_rules(text) is Intent.TANYA_HARGA


def test_pl_does_not_match_inside_other_words():
    """A two-letter token is the easy one to get wrong."""
    assert intents.classify_rules("plis dong kak") is not Intent.TANYA_HARGA


def test_the_price_reply_asks_for_the_affiliate_volume():
    """BD rewrote this reply on 31 Jul 2026. It used to point back at the
    shipped deck; it now answers the price question and asks how many
    affiliate the brand needs, because that answer is what decides which
    paket to steer them to."""
    from bd_bot import templates
    from bd_bot.config import Settings
    from bd_bot.models import Conversation

    text = templates.render(
        "REPLY_TANYA_HARGA", Conversation(jid="628@s.whatsapp.net", brand="X"),
        Settings(),
    ).text
    assert "kebutuhan affiliate" in text.lower()
    assert "deck" not in text.lower()


# --- answering the question the bot itself asked -----------------------------


@pytest.mark.parametrize(
    "answer",
    ["keduanya", "dua duanya kak", "both", "awareness", "peningkatan penjualan",
     # The shapes parent testing found still unread on 24 Sep 2026: "lebih
     # ke sales kak" was UNKNOWN (a strike towards handover, for answering
     # us) and "dua-duanya kak" was OK_LANJUT (straight to a slot list).
     "Lebih ke sales kak", "dua-duanya kak", "pengen naikin sales",
     "fokus ke penjualan dulu", "mau dikenal dulu", "semuanya kak"],
)
def test_the_bot_understands_its_own_multiple_choice(answer):
    """REPLY_TANYA_HARGA ends "awareness, peningkatan penjualan, atau
    keduanya?" — and "keduanya" came back unclassified, so the bot asked the
    brand what it meant by an option the bot had just offered.

    OK_LANJUT until 24 Sep 2026, which proposed meeting slots off the
    answer and skipped the need. Now FOKUS_CAMPAIGN: the rule reads the
    answer, `focus_of` says which one, and the engine keeps the label only
    when our last message actually asked (see test_engine.py)."""
    assert intents.classify_rules(answer) is Intent.FOKUS_CAMPAIGN
    assert intents.focus_of(answer) in {"sales", "awareness", "keduanya"}


@pytest.mark.parametrize("text", [
    "sales kami sudah ada tim", "penjualan kami turun bulan ini",
    "semua sudah kami coba", "keduanya bisa ga?", "target sales nya berapa?",
    "ok baik kak", "Sipp", "iya",
])
def test_a_focus_word_in_another_sentence_is_not_the_answer(text):
    """The rule is whole-message on purpose: a focus word with anything
    else around it is a different sentence, and the plain acks stay acks."""
    assert intents.classify_rules(text) is not Intent.FOKUS_CAMPAIGN


def test_an_option_plus_a_question_is_still_the_question():
    assert intents.classify_rules(
        "keduanya, tapi harganya berapa?"
    ) is Intent.TANYA_HARGA


# --- thanks: a close, or an acknowledgement that happens to thank ------------


@pytest.mark.parametrize(
    "text",
    ["nuhun ya kak", "makasi loh kak udh diingetin", "thanks a lot ya kak",
     "thankyou penjelasannya kakk", "mkasih ya kak"],
)
def test_bare_thanks_is_a_polite_close(text):
    assert intents.classify_rules(text) is Intent.TERIMA_KASIH


@pytest.mark.parametrize(
    "text",
    ["Ok mas. Thank you update nya ya", "oke tq kak", "Ok.tks.", "Ok thanks.",
     "oke thank you ya kak", "well noted thanks!",
     "thankyou untuk reminder nya ya kakk"],
)
def test_an_acknowledgement_that_thanks_still_proceeds(text):
    """One closes the conversation, the other carries it forward — flattening
    them cost six gold cases and the accuracy floor caught it."""
    assert intents.classify_rules(text) is Intent.OK_LANJUT


# --- package variations and fit ---------------------------------------------


@pytest.mark.parametrize(
    "text",
    ["diluar 3 paket itu ada opsi lain ga?",
     "bs mix ga kak, 100 affiliate plus live 2x seminggu?",
     "misal kita udh punya creator sendiri 50 org, bs digabung ke program kalian ga?",
     "bulan pertama 150 dl trs bulan kedua naik ke 300, gt bs diatur ga kak?"],
)
def test_asking_for_a_shape_the_packages_do_not_have(text):
    assert intents.classify_rules(text) is Intent.TANYA_CUSTOM


def test_custom_does_not_match_inside_customer():
    """"lg ngurusin customer dl" was reading as a package-customisation
    question — \\bcustom\\w* matches "customer"."""
    assert intents.classify_rules(
        "hold on kak, lg ngurusin customer dl"
    ) is not Intent.TANYA_CUSTOM


@pytest.mark.parametrize(
    "text",
    ["kategori mom n kids handle jg kah?",
     "kita brand fashion muslimah, creator kalian ada yg sesuai ga?",
     "harga produk kita 15rban kak, apa ga kekecilan buat program gini?"],
)
def test_is_this_for_us_questions(text):
    assert intents.classify_rules(text) is Intent.TANYA_KECOCOKAN


def test_the_fit_rules_stay_bounded():
    """An unbounded .* matched "sesuai" in one sentence against a "ga" three
    sentences later."""
    assert intents.classify_rules(
        "Jika Shopee nya sudah punya toko tinggal jalani aja sistem kalian | "
        "Itu bagaimana ? | Hanya TikTok sudah ada akun nya namun blm sesuai "
        "semua ga tau kenapa"
    ) is not Intent.TANYA_KECOCOKAN


def test_the_normaliser_does_not_eat_digits():
    """The elongation collapse that fixes "okeee" was applied to every
    character, so "2000 affiliate" became "20 affiliate" and "15000000"
    became "150" — any volume or budget with a repeated digit was silently
    rewritten before a single rule saw it."""
    from bd_bot.intents import _normalise

    assert _normalise("butuh 2000 affiliate") == "butuh 2000 affiliate"
    assert _normalise("1000 affiliate ya") == "1000 affiliate ya"
    assert _normalise("budget 15000000") == "budget 15000000"
    assert _normalise("okeee kak") == "oke kak", "letters must still collapse"


@pytest.mark.parametrize(
    "text",
    ["baik, kurang lebih saya membutuhkan 2000 affiliate apakah possible?",
     "kalau campaign request 2000 bisa kah kak?",
     "butuh 1000 affiliate bisa ga kak?"],
)
def test_a_volume_beyond_the_tiers_is_a_customisation_question(text):
    """The deck sells 300 and 500. Asking for 2000 is asking whether the
    packages bend — it was answered as agreement, or not at all."""
    assert intents.classify_rules(text) is Intent.TANYA_CUSTOM


def test_an_opening_ack_still_acknowledges():
    """Guarding OK_LANJUT against trailing questions was unnecessary once the
    digit bug was fixed, and it cost a real gold case."""
    assert intents.classify_rules(
        "oke kak possible yaa | untuk link meetingnya masih sama kah?"
    ) is Intent.OK_LANJUT


# --- "commission only?" is not "how does commission work?" -------------------


@pytest.mark.parametrize(
    "text",
    ["kalo by komisi aja bisa ga?", "apakah bisa by commission only?",
     "apakah bisa by cps only?", "bisa nya cuma komisi aja kak",
     "bagi hasil aja gimana?", "profit sharing aja bisa?",
     "tanpa biaya campaign bisa?",
     "bayar nya berapa ya ? atau cuma kasi komisi saja"],
)
def test_a_commission_only_proposal_is_its_own_question(text):
    """The answer is no, and it has to be the same no every time.

    Sharing TANYA_KOMISI, one pilot tester got two contradictory answers four
    minutes apart: "belum tersedia opsi komisi saja" at 16:18, then a plain
    recital of commission rates at 16:21 that never addressed the question."""
    assert intents.classify_rules(text) is Intent.TANYA_KOMISI_ONLY


@pytest.mark.parametrize(
    "text",
    ["komisi nya berapa", "komisi MCN gimana? double dong?",
     "untuk komisi affiliate ditentukan siapa?"],
)
def test_an_ordinary_commission_question_is_untouched(text):
    assert intents.classify_rules(text) is Intent.TANYA_KOMISI


def test_the_commission_only_answer_is_never_generated():
    """Every other reply may be reworded. This one states what is not on offer,
    and a reworded version that softens it would have a brand planning around
    a fee structure that does not exist."""
    from bd_bot import responder

    assert "REPLY_TANYA_KOMISI_ONLY" not in responder.GENERATIVE_KEYS


@pytest.mark.parametrize(
    "text,expected",
    [("untuk 500 affiliate detailnya bagaimana", Intent.TANYA_HARGA),
     ("paket 300 affiliate isinya apa aja", Intent.TANYA_HARGA),
     ("sistemnya gimana ya kak", Intent.TANYA_SISTEM),
     ("gimana cara kerjanya", Intent.TANYA_SISTEM)],
)
def test_naming_a_package_asks_about_that_package(text, expected):
    """"untuk 500 affiliate detailnya bagaimana" was answered with the generic
    "we curate creators" explanation, which never mentions the 500 at all."""
    assert intents.classify_rules(text) is expected


# A day word only proposes a slot when it OPENS its clause. Sitting straight
# after a content noun it is describing that noun instead — a tester's
# "cuaca hari ini gimana kak?" was read as SETUJU on 8 Aug 2026, so the bot
# answered a weather question by asking for their email to send a Meet invite.
@pytest.mark.parametrize("text", [
    "cuaca hari ini gimana kak?",
    "berita hari ini gimana kak",
    "kabar hari ini gimana",
])
def test_a_day_word_after_a_topic_noun_is_not_a_slot_proposal(text):
    assert intents.classify_rules(text) is not Intent.SETUJU


# The other half of the same rule: these must keep working.
@pytest.mark.parametrize("text", [
    "besok jam 10 bisa kak?",
    "besok di jam 11 aman yaa kak",
    "siang kak untuk hari ini bisa quick meet di jam berapaaa?",
    "Kalo hari ini gak bisa, besok ya",
    "Halooo kak boleh banget hari ini apaa ada available time to discuss?",
    "Malam ka, bsk bs ka?",
    "Ka jd gimana, bsk bs ka?",
    "kalau besok jam 1 gmn?",
])
def test_naming_a_slot_is_still_agreement(text):
    assert intents.classify_rules(text) is Intent.SETUJU


# A day-part next to an availability word is a slot proposal: "mungkin bisa
# ka sore nanti" reached the LLM on every occurrence before 14 Aug 2026.
@pytest.mark.parametrize("text", [
    "mungkin bisa ka sore nanti",
    "bisa nya besok pagi",
    "sore aja kak",
    "bisa sore?",
    "boleh besok pagi ya",
])
def test_a_daypart_beside_an_availability_word_is_agreement(text):
    assert intents.classify_rules(text) is Intent.SETUJU


# Only particles may sit between the two. A content noun in the gap means the
# sentence is about that noun, and the day-part is just when: "bisa kirim
# proposal pagi ini?" is a document request with a deadline on it.
@pytest.mark.parametrize("text", [
    "bisa kirim proposal pagi ini?",
    "boleh info harga malam ini",
    "bisa minta pricelist siang ini",
])
def test_a_content_noun_in_the_gap_is_not_a_slot_proposal(text):
    assert intents.classify_rules(text) is not Intent.SETUJU
