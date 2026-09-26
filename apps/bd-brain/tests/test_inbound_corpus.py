"""The `inbound/` corpus: the 36 conversations where the BRAND wrote first.

Why this file exists at all: the corpus reaches the bot through a parser, and
a parser that stops matching does not fail — it returns nothing. The whole of
`inbound/` was invisible for exactly that reason on arrival (iPhone's 12-hour
timestamps, `[8/16/26, 2:10:50 PM]`, closed the bracket somewhere the iOS
pattern did not look), and nothing anywhere said so. These tests are the
smoke alarm: if a future export vintage, a rename, or a regex tidy-up drops
the corpus on the floor, something goes red instead of quiet.

They read the real directory rather than a fixture. A fixture would keep
passing while the thing it stands for went silent.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from bd_bot import chat_examples, intents  # noqa: E402
from bd_bot.models import Intent  # noqa: E402

CORPUS = ROOT / "inbound" / "sosmed-ke-wa"

pytestmark = pytest.mark.skipif(
    not CORPUS.is_dir(), reason="inbound/ corpus not present in this checkout"
)


def turns():
    return chat_examples.load_client_turns(str(CORPUS))


def test_the_corpus_parses_at_all():
    """The failure this guards against is silence, so it asserts volume."""
    got = turns()
    assert len(got) >= 350, (
        f"only {len(got)} client turns parsed out of a 36-conversation corpus "
        "— the export format probably changed and the parser is dropping lines"
    )
    assert len({t.source for t in got}) >= 30, "conversations collapsed into one name"


def test_every_conversation_contributes():
    """One transcript per folder, named after the folder.

    Naming them by the file's stem would call all 36 "chat", and `_agent_for`
    works out which side is us by counting how many transcripts a sender
    appears in — one name for everything collapses that to a single file and
    inverts the sides.
    """
    folders = {p.name for p in CORPUS.iterdir() if p.is_dir()}
    sources = {t.source for t in turns()}
    missing = folders - sources
    assert not missing, f"no client turns parsed from: {sorted(missing)[:5]}"


def test_our_own_messages_are_not_taught_as_client_turns():
    """Our side appears under two names in some exports ("Anda" and "Spark
    Mcnasia"). Both are us; a transcript that treats one of them as the brand
    teaches the bot its own words as things brands say."""
    ours = [
        t for t in turns()
        # The qualification form's own opening line, which only we send.
        if "saya nisa dari mcnasia" in t.text.lower()
        and "nama brand:" not in t.text.lower()
        and "nama brand :" not in t.text.lower()
    ]
    assert not ours, (
        f"{len(ours)} of our own messages are in the client corpus, e.g. "
        f"{ours[0].text[:80]!r}"
    )


def test_the_ad_lead_opener_is_recognised():
    """WhatsApp's pre-filled ad text is the most common opening line in the
    corpus. Read as UNKNOWN it burns an unknown strike on every new lead."""
    for text in (
        "Halo! Bisa minta info lebih lanjut tentang ini?",
        "Hello! Can I get more info on this?",
    ):
        assert intents.classify_rules(text) is Intent.LEAD_IKLAN


def test_the_filled_form_is_recognised_and_the_blank_one_is_not():
    filled = "* Nama Brand: brand uji\n* Posisi di Brand: Frozen food\n* Link : x"
    blank = "* Nama Brand:\n* Posisi di Brand:\n* Link TikTok Shop:\n* Link Shopee:"
    assert intents.classify_rules(filled) is Intent.ISI_FORM
    assert intents.classify_rules(blank) is not Intent.ISI_FORM, (
        "our own empty form must never read as the brand's answer"
    )


def test_unknown_rate_does_not_regress():
    """The measuring stick, same as `bd_bot replay`.

    33.0% when the corpus first parsed (Sep 2026), 25.4% after the first
    mining round. The ceiling here is a ratchet: it may fall, never rise.
    """
    got = turns()
    unknown = sum(1 for t in got if intents.classify_rules(t.text) is Intent.UNKNOWN)
    rate = unknown / len(got)
    assert rate <= 0.27, (
        f"UNKNOWN rate {rate:.1%} ({unknown}/{len(got)}) is above the 27% "
        "ratchet — a rule change has cost the inbound corpus recall"
    )


def test_both_corpora_reach_the_prompt():
    """Grounding draws on outbound AND inbound, not whichever loads first.

    The cap is ten pairs and there are 69 transcripts between the two
    corpora; flattening them into one pool takes a pair from each of the
    first ten transcripts and the second corpus never appears — loaded,
    parsed, and silently absent from every prompt.
    """
    from bd_bot import chat_examples

    both = chat_examples.dialogue_block(ROOT / "chat-example", CORPUS)
    outbound_only = chat_examples.dialogue_block(ROOT / "chat-example")
    assert both != outbound_only, "the inbound corpus is not reaching the prompt"
    # The ad-lead opener only exists in the inbound corpus.
    assert "Bisa minta info lebih lanjut" in both


def test_a_missing_corpus_is_not_an_error():
    """It is real customer data and is not in the repo: a checkout without
    it must still generate replies, grounded on what it does have."""
    from bd_bot import chat_examples

    block = chat_examples.dialogue_block(ROOT / "chat-example", ROOT / "tidak-ada")
    assert block, "a missing second corpus emptied the whole block"


# ── The false positives a review found ─────────────────────────────────────
#
# Every rule added in the first mining round traded precision for recall, and
# the UNKNOWN rate cannot see that: a rule that fires on the wrong thing makes
# the number go DOWN. These are the cases an independent review (Fable 5.1,
# Sep 2026) produced by attacking the new patterns. Each one was real — all
# three shipped, and all three are fixed here. Synthetic phrasings belong in a
# test file rather than the gold CSV, which holds real turns only.


@pytest.mark.parametrize(
    "text, must_not_be",
    [
        # A price list is the highest-intent inbound message there is. The
        # first version of the affiliate-data rule answered it with "we don't
        # share the affiliate list before a deal".
        ("boleh minta price list nya kak?", Intent.TANYA_AFFILIATE),
        ("kirim daftar harga dong kak", Intent.TANYA_AFFILIATE),
        ("minta list harga paketnya ya", Intent.TANYA_AFFILIATE),
        ("tolong kirim daftar syarat dan ketentuannya", Intent.TANYA_AFFILIATE),
        ("minta list jadwal meeting yang tersedia dong", Intent.TANYA_AFFILIATE),
    ],
)
def test_asking_for_a_list_is_not_always_about_affiliates(text, must_not_be):
    assert intents.classify_rules(text) is not must_not_be


@pytest.mark.parametrize(
    "text, expected",
    [
        # "nama brand" plus "link/tiktok" in one sentence is not a form.
        ("boleh tau nama brand apa saja yang sudah kerjasama? ada link tiktoknya?",
         Intent.TANYA_PORTOFOLIO),
        # This one booked a Google Meet with a brand that had just closed:
        # ISI_FORM is in the scheduling branch, which books when an email is
        # already on file.
        ("nama brand kami sudah tutup kak, link shopee nya sudah tidak aktif",
         Intent.PRODUK_BERUBAH),
        ("nama brand kami belum ada di tiktok shop, bisa ikut?",
         Intent.TANYA_KECOCOKAN),
        ("nama brand yang di tiktok itu mcnasia atau spark? biar saya cek legalitasnya",
         Intent.TANYA_LEGALITAS),
    ],
)
def test_a_sentence_mentioning_a_brand_name_is_not_a_filled_form(text, expected):
    got = intents.classify_rules(text)
    assert got is not Intent.ISI_FORM
    assert got is expected, f"{text!r} -> {got.value}"


@pytest.mark.parametrize(
    "text",
    [
        # "X aja" also means "even X" / "only X". Read as a day proposal,
        # each of these produced a slot list and counted as ACCEPTANCE on the
        # dashboard — a refusal filed as a won step.
        "jangan besok aja, saya sibuk",
        "hari ini aja saya sibuk banget kak",
        "sabtu aja kami libur kak",
        "hari ini aja belum sempat baca proposalnya",
    ],
)
def test_a_weekday_with_aja_is_not_always_a_proposal(text):
    assert intents.classify_rules(text) is not Intent.SETUJU


@pytest.mark.parametrize(
    "text",
    ["rabu aja kalo gitu", "besok aja ya kak", "senin aja kak kalau begitu"],
)
def test_but_a_real_counter_proposal_still_reads_as_one(text):
    assert intents.classify_rules(text) is Intent.SETUJU


def test_the_new_labels_survive_the_fallback():
    """A label the fallback may return but `classify` then discards is a paid
    API call thrown away — and the prompt entry that offers it is dead."""
    from bd_bot.intents import _LLM_DECIDABLE, _LLM_SYSTEM

    for intent in (Intent.LEAD_IKLAN, Intent.ISI_FORM):
        assert intent.value in _LLM_SYSTEM, f"{intent.value} not offered to the model"
        assert intent in _LLM_DECIDABLE, f"{intent.value} would be discarded"


# ── Second mining round, 24 Sep 2026: the selling turns ────────────────────
#
# The CRM PDF's own worked scripts all open with one of three shapes — a vague
# "tell me more", a "what do you offer", a need named in one word — and the
# corpus adds the objections the team handles best. All of these were UNKNOWN
# after the first round, which answered a warm lead with "boleh dijelaskan
# sedikit lebih detail maksud Kakak?". The real turns are locked in
# tests/data/gold_intents.csv as source `s03`; these are the synthetic
# neighbours and the negative controls, which do not belong in the gold set.


@pytest.mark.parametrize("text, expected", [
    ("affiliate", Intent.BUTUH_AFFILIATE),
    ("iya affiliate", Intent.BUTUH_AFFILIATE),
    ("kami ingin bangun team affiliator", Intent.BUTUH_AFFILIATE),
    ("Sedang mencari Affiliator", Intent.BUTUH_AFFILIATE),
    ("Mau info affiliate", Intent.MINTA_INFO),
    ("Info kak", Intent.MINTA_INFO),
    ("Halo, saya mau konsultasi", Intent.MINTA_INFO),
    ("solusi apa saja yang ada?", Intent.TANYA_LAYANAN),
    ("Ada apa aja ya kaa", Intent.TANYA_LAYANAN),
    ("kerjasama MCN dgn 50 creator tapi belum ada yg konversi", Intent.PERNAH_AGENCY),
])
def test_the_selling_turns_are_recognised(text, expected):
    assert intents.classify_rules(text) is expected


@pytest.mark.parametrize("text, must_be", [
    # A promise to get back to us, not a request for information.
    ("Nanti kami infokan ya kak", Intent.NANTI_AJA),
    ("Saya lg gak di jakarta | Nanti plg saya info lg ya", Intent.NANTI_AJA),
    # Explicit appetite stays SETUJU (gold), even though it names affiliate.
    ("Ak emg butuh banget agency affliate kak", Intent.SETUJU),
    # A volume the tiers do not cover is TANYA_CUSTOM, not the need stated.
    ("butuh 2000 affiliate bisa?", Intent.TANYA_CUSTOM),
    # Creator criteria stay with the creator question.
    ("Saya lagi cari affiliate yang followers nya diatas 10k", Intent.TANYA_AFFILIATE),
    # A price list is a price question, whatever the verb in front of it.
    ("boleh minta price list nya kak?", Intent.TANYA_HARGA),
    ("mau tanya harganya berapa", Intent.TANYA_HARGA),
    # "info selengkapnya" keeps its TANYA_SISTEM gold label.
    ("Halo! Bisakah saya mendapatkan info selengkapnya tentang ini?", Intent.TANYA_SISTEM),
    # The ad opener is a source, never a request.
    ("Halo! Bisa minta info lebih lanjut tentang ini?", Intent.LEAD_IKLAN),
    # "pernah handle" is a portfolio question; "hasilnya kurang" a soft no.
    ("pernah handle brand apa aja?", Intent.TANYA_PORTOFOLIO),
    ("hasilnya kurang kak", Intent.TOLAK_HALUS),
    # "promo" is still a discount ask; "dipromosiin" no longer is.
    ("Lg ramadhan gt promo haha", Intent.NEGO_HARGA),
])
def test_the_neighbours_keep_their_own_labels(text, must_be):
    assert intents.classify_rules(text) is must_be


def test_boleh_minta_info_is_no_longer_consent():
    """"Hallo kak boleh minta info lebih lanjut tentang affiliate ini?" was
    SETUJU off the bare "boleh" — and consent at Node.NEW skips the
    qualification form and proposes meeting slots to someone who only asked
    what we do."""
    got = intents.classify_rules(
        "Hallo kak boleh minta info lebih lanjut tentang affiliate ini? Terima kasih"
    )
    assert got is not Intent.SETUJU
    assert got is Intent.MINTA_INFO


def test_affiliate_dulu_is_not_a_study_first_deferral():
    """"liat" sits inside "affiLIATe": every message naming affiliate and
    ending "dulu" was PELAJARI_DULU — parked on the follow-up ladder instead
    of answered."""
    got = intents.classify_rules(
        "Halo kak, apakah ada paket affiliate yg lebih rendah lagi, untuk percobaan dulu?"
    )
    assert got is not Intent.PELAJARI_DULU
    assert got is Intent.BRAND_KECIL
    # The real deferrals are untouched.
    assert intents.classify_rules("Ok kita pelajari dulu ya") is Intent.PELAJARI_DULU
    assert intents.classify_rules("Bntr kak ak liat jdwl ku dlu kak") is Intent.PELAJARI_DULU


def test_the_second_round_labels_survive_the_fallback():
    from bd_bot.intents import _LLM_DECIDABLE, _LLM_SYSTEM

    for intent in (Intent.MINTA_INFO, Intent.TANYA_LAYANAN, Intent.BUTUH_AFFILIATE,
                   Intent.PERNAH_AGENCY):
        assert intent.value in _LLM_SYSTEM, f"{intent.value} not offered to the model"
        assert intent in _LLM_DECIDABLE, f"{intent.value} would be discarded"


# ── The focus answer (24 Sep 2026, parent testing) ──────────────────────────


@pytest.mark.parametrize("text, focus", [
    ("Lebih ke sales kak", "sales"), ("Lebih ke sale", "sales"),
    ("dua-duanya kak", "keduanya"), ("semuanya kak", "keduanya"),
    ("sales sama awareness", "keduanya"),
    ("branding dulu deh", "awareness"), ("mau dikenal dulu", "awareness"),
    ("Awareness and optimalisasi marketplace", "awareness"),
])
def test_the_focus_answer_and_which_one_it_was(text, focus):
    assert intents.classify_rules(text) is Intent.FOKUS_CAMPAIGN
    assert intents.focus_of(text) == focus


@pytest.mark.parametrize("text", [
    "sales kami sudah ada tim", "penjualan kami turun bulan ini",
    "semua sudah kami coba", "GMV nya berapa?", "keduanya bisa ga?",
    "Kebutuhan: Meningkatkan penjualan, Affiliate yang efektif",
])
def test_a_focus_word_elsewhere_is_not_the_answer(text):
    assert intents.classify_rules(text) is not Intent.FOKUS_CAMPAIGN


def test_every_template_that_asks_the_focus_is_recognised_as_asking():
    """The engine keeps a FOKUS_CAMPAIGN label only when our last message
    asked — so every template that asks must be seen asking, or its answer
    is thrown away; and the ones that do not ask must not be."""
    from bd_bot import templates

    for key in ("REPLY_TANYA_HARGA", "DM_SERVICE_PITCH", "REPLY_GREETING_NEEDS", "REPLY_TANYA_LAYANAN"):
        assert intents.asks_for_focus(getattr(templates, key)), key
    for key in ("REPLY_TANYA_SISTEM", "REPLY_TANYA_LOKASI", "INBOUND_QUALIFY", "OFFER_MEETING",
                "REPLY_FOKUS_SALES", "REPLY_FOKUS_AWARENESS", "REPLY_FOKUS_KEDUANYA"):
        assert not intents.asks_for_focus(getattr(templates, key)), key
    assert Intent.FOKUS_CAMPAIGN in intents._LLM_DECIDABLE


# ── Round 3 (24 Sep 2026): the wider inbound test on real corpus questions ──
# The real turns are gold source `s05`; these are the neighbours and the
# negative controls that guard each widening.


@pytest.mark.parametrize("text, expected", [
    ("Hijab. Kebutuhan campaign affiliate, sama livestream", Intent.BUTUH_AFFILIATE),
    ("Affiliate. Jubah pria - fashion muslim", Intent.BUTUH_AFFILIATE),
    ("Contoh2 livenya ada kak?", Intent.TANYA_PORTOFOLIO),
    ("Berapa harga unt LS nya kak?", Intent.TANYA_HARGA_LIVE),
    ("live streaming nya berapa kak?", Intent.TANYA_HARGA_LIVE),
    ("Kak, %unt affiliator gimana?", Intent.TANYA_KOMISI),
    ("Nama Brand: brand uji, frozen food", Intent.ISI_FORM),
    ("Kalau udh 4 bulan itu vt nya bakal di privasi atau gimana ka?", Intent.TANYA_VIDEO_SETELAH_KONTRAK),
    ("setelah kontrak selesai videonya dihapus?", Intent.TANYA_VIDEO_SETELAH_KONTRAK),
    ("Brand kosmetik apa yg sudah kerja sama dgn kk ya", Intent.TANYA_PORTOFOLIO),
    ("Sy mikir2 dl ya kak", Intent.PELAJARI_DULU),
    ("ada rate card atau company profile?", Intent.MINTA_PROFILE),
    ("boleh minta deck nya kak", Intent.MINTA_PROFILE),
    ("saya dari agency, klien kami butuh affiliate", Intent.AGENCY_VENDOR),
    ("kita handle beberapa klien yang ada kebutuhan affiliate", Intent.AGENCY_VENDOR),
    ("Klo produk digital itu apakah bisa jualan di shopee dan tiktok shop kk?", Intent.TANYA_KATEGORI_PRODUK),
])
def test_round_three_turns_are_recognised(text, expected):
    assert intents.classify_rules(text) is expected


@pytest.mark.parametrize("text, must_be", [
    # A report about their affiliates is not the need stated.
    ("affiliate kami sudah ada tim", Intent.UNKNOWN),
    ("affiliate nya level berapa?", Intent.TANYA_AFFILIATE),
    # Live as a capability question keeps its own answer; a live price does not.
    ("dibantu live juga?", Intent.TANYA_LIVE),
    ("live jualan dari studio kalian?", Intent.TANYA_LIVE),
    # Affiliate prices stay affiliate prices.
    ("Fee nya berapa", Intent.TANYA_HARGA),
    ("harganya berapa kak", Intent.TANYA_HARGA),
    ("boleh minta price list nya kak?", Intent.TANYA_HARGA),
    # Rights are rights; the after-contract question is separate.
    ("videonya boleh kami repost ga?", Intent.TANYA_HAK_KONTEN),
    # A burned brand is not an agency lead, and vice versa.
    ("Aku ragu neh karena ud 2 x pernah d promosiin TPI gak ada hasil", Intent.PERNAH_AGENCY),
    # Credentials/portfolio keep their gold label; "kirim dulu" stays MINTA_CHAT.
    ("Boleh minta company credential/portfolio terbaru kah?", Intent.TANYA_PORTOFOLIO),
    ("kirim kan aja dulu biar aku pertimbangkan", Intent.MINTA_CHAT),
    # The closed-brand sentence must never become a form.
    ("nama brand kami sudah tutup kak, link shopee nya sudah tidak aktif", Intent.PRODUK_BERUBAH),
    ("nama brand yang di tiktok itu mcnasia atau spark? biar saya cek legalitasnya", Intent.TANYA_LEGALITAS),
    # A restricted product is still the category question.
    ("produk rokok bisa?", Intent.TANYA_KATEGORI_PRODUK),
])
def test_round_three_neighbours_keep_their_labels(text, must_be):
    assert intents.classify_rules(text) is must_be


def test_a_bare_percent_sign_reads_as_persen():
    assert "persen" in intents._normalise("Kak, %unt affiliator gimana?")
    assert intents._normalise("12%") == "12 persen"


def test_round_three_labels_survive_the_fallback():
    from bd_bot.intents import _LLM_DECIDABLE, _LLM_SYSTEM

    for intent in (Intent.TANYA_HARGA_LIVE, Intent.MINTA_PROFILE, Intent.AGENCY_VENDOR,
                   Intent.TANYA_VIDEO_SETELAH_KONTRAK):
        assert intent.value in _LLM_SYSTEM, intent
        assert intent in _LLM_DECIDABLE, intent
