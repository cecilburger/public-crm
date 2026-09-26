"""Chat-export parsing → few-shot grounding.

The zips in chat-example/ are real conversations; these tests use a synthetic
export in the same format so the suite doesn't depend on that folder's
contents staying put.
"""

from __future__ import annotations

import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bd_bot import chat_examples  # noqa: E402

AGENT = "Spark Konsultan Official"

TRANSCRIPT_A = """\
19/07/26 16.26 - Bisnis Anda menggunakan layanan yang aman dari Meta untuk mengelola obrolan ini.
19/07/26 16.26 - ‎Client Satu kini menjadi kontak
19/07/26 16.29 - Client Satu: Harganya berapa ya kak?
19/07/26 16.30 - Spark Konsultan Official: Baik kak, paket kami mulai dari Rp10 juta per campaign, menyesuaikan kebutuhan brand Kakak ya 😊
19/07/26 16.31 - Client Satu: Sistemnya gimana?
19/07/26 16.32 - Spark Konsultan Official: Kami handle rekrutmen affiliate, distribusi sample,
dan monitoring performa hariannya kak.
Semua terukur dan bisa dipantau ya kak 🙏
19/07/26 16.40 - Client Satu: coba kirim contoh
19/07/26 16.41 - Spark Konsultan Official: <Media tidak disertakan>
"""

TRANSCRIPT_B = """\
20/07/26 10.00 - ‎Client Dua kini menjadi kontak
20/07/26 10.01 - Client Dua: paket 300 berapa?
20/07/26 10.02 - Spark Konsultan Official: Untuk paket 300 investasinya Rp30 juta kak, ada promo jadi Rp27 juta bulan ini ya kak.
20/07/26 10.05 - Client Dua: boleh minta link meeting?
20/07/26 10.06 - Spark Konsultan Official: Ini link nya kak https://meet.google.com/abc-defg-hij ditunggu yah kak, sampai ketemu nanti 🙏
20/07/26 10.09 - Client Dua: infonya lengkap gak?
20/07/26 10.10 - Spark Konsultan Official: Lengkap kak, semua scope kerjasama kami jelaskan detail saat meeting nanti yah kak 🙂
"""


@pytest.fixture
def export_dir(tmp_path):
    d = tmp_path / "chat-example"
    d.mkdir()
    for name, body in (("Chat A", TRANSCRIPT_A), ("Chat B", TRANSCRIPT_B)):
        with zipfile.ZipFile(d / f"{name}.zip", "w") as zf:
            zf.writestr(f"{name}.txt", body)
    return d


def test_parses_pairs_and_detects_the_business_side(export_dir):
    pairs = chat_examples.load_pairs(str(export_dir))
    assert pairs, "should have extracted at least one exchange"
    # Every answer is an agent turn, never a client turn.
    assert all("kak" in p.agent.lower() for p in pairs)
    clients = {p.client for p in pairs}
    assert "Harganya berapa ya kak?" in clients


def test_multiline_messages_are_joined(export_dir):
    pairs = chat_examples.load_pairs(str(export_dir))
    system = next(p for p in pairs if p.client == "Sistemnya gimana?")
    assert "monitoring performa hariannya" in system.agent
    assert "terukur" in system.agent, "continuation lines must be kept"


def test_unauthorised_amounts_are_dropped(export_dir):
    """The old chats quote prices that aren't in today's price list — those
    turns must not become grounding, or the model learns the wrong prices."""
    pairs = chat_examples.load_pairs(str(export_dir))
    assert not any("Rp30 juta" in p.agent for p in pairs)
    assert not any("Rp27 juta" in p.agent for p in pairs)
    # The allowlisted Rp10 juta answer survives.
    assert any("Rp10 juta" in p.agent for p in pairs)


def test_turns_with_links_are_dropped(export_dir):
    pairs = chat_examples.load_pairs(str(export_dir))
    assert not any("meet.google.com" in p.agent for p in pairs)


def test_media_placeholders_are_not_answers(export_dir):
    pairs = chat_examples.load_pairs(str(export_dir))
    assert not any("Media tidak disertakan" in p.agent for p in pairs)


def test_dialogue_block_renders_and_caps(export_dir):
    block = chat_examples.dialogue_block(export_dir)
    assert "CONTOH PERCAKAPAN NYATA" in block
    assert "HANYA boleh diambil dari FACT SHEET" in block
    assert "Rp10 juta" in block
    assert len(block) <= chat_examples.MAX_BLOCK_CHARS


def test_missing_dir_is_harmless(tmp_path):
    assert chat_examples.dialogue_block(tmp_path / "nope") == ""
    assert chat_examples.load_pairs(str(tmp_path / "nope")) == ()


# --- system-line noise, every observed export wording (ROADMAP 1.1) ----------

#: iOS attributes system lines to whichever bubble they appeared under, so
#: they arrive looking like real turns — with wording that varies by export
#: vintage, and sometimes a trailing period the old exact-match missed.
TRANSCRIPT_NOISE = """\
[14/07/26, 11.12.08] Client Tiga: ‎Pesan sementara dinyalakan. ‎Pesan baru akan hilang dari chat ini ‎90 hari setelah dikirim. ‎Ubah timer
[14/07/26, 11.12.09] Client Tiga: ‎Pesan dan panggilan kini terenkripsi secara end-to-end.
[14/07/26, 11.12.10] Client Tiga: Harganya berapa kak?
[14/07/26, 11.13.00] Spark Konsultan Official: ‎‎Anda mematikan pesan sementara. ‎Ubah timer
[14/07/26, 11.13.05] Spark Konsultan Official: Baik kak, mulai dari Rp10 juta per campaign ya kak, menyesuaikan kebutuhan brand kakak 🙏
[14/07/26, 11.14.00] Client Tiga: ‎AI Anda sedang mempelajari obrolan bisnis ini agar bisa mengirim tanggapan yang lebih baik.
[14/07/26, 11.14.10] Client Tiga: oke lanjut kak
[14/07/26, 11.15.00] Spark Konsultan Official: ‎Anda menghapus pesan ini.
[14/07/26, 11.15.05] Spark Konsultan Official: Siap kak, saya jadwalkan meeting singkat untuk bahas detail kebutuhannya ya kak 🙏
"""

NOISE_MARKERS = (
    "terenkripsi",
    "pesan sementara",
    "menghapus pesan",
    "Ubah timer",
    "sedang mempelajari",
)


@pytest.fixture
def noisy_dir(tmp_path):
    d = tmp_path / "chat-example"
    d.mkdir()
    with zipfile.ZipFile(d / "Chat Noise.zip", "w") as zf:
        zf.writestr("_chat.txt", TRANSCRIPT_NOISE)
    # A second file so the agent recurs across exports.
    with zipfile.ZipFile(d / "Chat Other.zip", "w") as zf:
        zf.writestr("Chat Other.txt", TRANSCRIPT_A)
    return d


def test_system_lines_never_become_turns(noisy_dir):
    pairs = chat_examples.load_pairs(str(noisy_dir))
    assert pairs, "the real exchanges must survive the filtering"
    blob = "\n".join(f"{p.client}\n{p.agent}" for p in pairs)
    for marker in NOISE_MARKERS:
        assert marker.lower() not in blob.lower(), f"leaked system line: {marker}"
    # The real content around the noise is intact.
    assert any("Rp10 juta" in p.agent for p in pairs)


def test_deleted_message_with_trailing_period_is_noise():
    assert chat_examples._is_noise("‎Anda menghapus pesan ini.")
    assert chat_examples._is_noise("Pesan dan panggilan kini terenkripsi secara end-to-end.")
    assert not chat_examples._is_noise("Baik kak, saya jelaskan ya")


# --- agent-detection guard (ROADMAP 1.4) -------------------------------------


def test_unrecognised_single_file_agent_is_skipped(tmp_path, caplog):
    """A chat where an unknown sender simply out-talks the other must not get
    its sides inverted — volume alone is not evidence of being the agent."""
    d = tmp_path / "chat-example"
    d.mkdir()
    with zipfile.ZipFile(d / "Chat X.zip", "w") as zf:
        zf.writestr(
            "Chat X.txt",
            "19/07/26 10.00 - Random Person: Halo, saya mau menawarkan produk saya ke toko kakak ya, ini katalognya lengkap sekali\n"
            "19/07/26 10.01 - Other Person: oke\n"
            "19/07/26 10.02 - Random Person: Terima kasih kak, saya kirimkan detail lengkap produknya sekarang ya kak 🙏\n",
        )
    with caplog.at_level("WARNING"):
        pairs = chat_examples.load_pairs(str(d))
    assert pairs == ()
    assert "skipping transcript" in caplog.text


def test_known_agent_name_is_trusted_even_in_one_file(tmp_path):
    d = tmp_path / "chat-example"
    d.mkdir()
    with zipfile.ZipFile(d / "Chat Y.zip", "w") as zf:
        zf.writestr(
            "Chat Y.txt",
            "19/07/26 10.00 - Client Y: Harganya berapa kak?\n"
            "19/07/26 10.01 - MCNASIA.BIZ: Baik kak, paket kami mulai dari Rp10 juta per campaign ya kak 🙏\n",
        )
    pairs = chat_examples.load_pairs(str(d))
    assert len(pairs) == 1 and "Rp10 juta" in pairs[0].agent


# --- style-pair / validator parity (ROADMAP 1.2) -----------------------------


def test_unteachable_agent_turns_are_dropped(tmp_path):
    """Turns the validator would reject as output must not become style
    examples either: guarantees, commission percentages, month durations,
    and the tax-workaround phrasing observed in the corpus."""
    d = tmp_path / "chat-example"
    d.mkdir()
    bad_turns = [
        "nah disini ka garansi kami ya ka, kami jamin affiliate pasti akan membuatkan videonya ya ka",
        "kalau untuk kategori beauty biasanya komisi affiliate di 10% dulu ya kak, supaya menarik kak",
        "untuk campaign nya berjalan selama 3-4 bulan maksimal ya ka, menyesuaikan total video affiliate",
        "untuk ini bisa disesuaikan ya ka, kaka mau pakai pajak atau non pajak juga bisa ya ka",
    ]
    lines = ["19/07/26 09.59 - ‎Client Z kini menjadi kontak"]
    t = 0
    for bad in bad_turns:
        lines.append(f"19/07/26 10.{t:02d} - Client Z: pertanyaan saya nomor {t} apa ya kak?")
        lines.append(f"19/07/26 10.{t + 1:02d} - Spark Konsultan Official: {bad}")
        t += 2
    lines.append(f"19/07/26 10.{t:02d} - Client Z: kalau sistemnya gimana kak?")
    lines.append(
        f"19/07/26 10.{t + 1:02d} - Spark Konsultan Official: "
        "Kami kurasi affiliate sesuai kategori brand kakak dan pantau performanya setiap hari ya kak 🙏"
    )
    for name in ("Chat P", "Chat Q"):  # two files so the agent recurs
        with zipfile.ZipFile(d / f"{name}.zip", "w") as zf:
            zf.writestr(f"{name}.txt", "\n".join(lines))

    pairs = chat_examples.load_pairs(str(d))
    agents = " ".join(p.agent for p in pairs)
    assert "garansi" not in agents and "jamin" not in agents
    assert "%" not in agents
    assert "bulan" not in agents
    assert "pajak" not in agents
    assert "kurasi affiliate" in agents, "the clean turn survives"


def test_real_exports_parse_if_present():
    """Smoke test against the actual chat-example/ folder when it exists."""
    real = Path(__file__).resolve().parents[1] / "chat-example"
    if not real.is_dir():
        pytest.skip("no chat-example/ folder")
    pairs = chat_examples.load_pairs(str(real))
    assert pairs, "real exports should yield at least one usable exchange"
    for p in pairs:
        assert "meet.google.com" not in p.agent
        assert "@" not in p.agent, "emails must never enter the prompt"


def test_real_exports_carry_no_noise_or_unteachable_content():
    """ROADMAP 1.1/1.2 acceptance, run against the real corpus: zero pairs
    contain system-line text, unauthorised numbers, or guarantees.

    "Unauthorised" moved on 29 Jul 2026, when BD settled the campaign length
    at four months and put an opening figure on the MCN commission. A corpus
    turn stating either is now teachable — it agrees with the fact sheet.
    Everything else still goes: the corpus quotes 3/4/5 bulan for the same
    package, an affiliate cut of 10%, and a portfolio "sekitar 10%" that no
    fact sheet ever claimed.

    Widened again on 31 Jul 2026, when BD put the 500 tier at six months. The
    duration guard checks the FIGURE, not which package it is attached to, so
    a corpus turn saying "6 bulan" about the 300 is now teachable where it was
    not before. The tier-to-duration mapping is held by the fact sheet and the
    situation briefs instead.

    NARROWED on 18 Aug 2026 with the new deck: one package, one duration. Both
    4 and 6 bulan are retired, so most of the corpus's price-and-duration turns
    stop being teachable — which is the point. The exports were recorded while
    the old ladder was being sold, and every one of those turns would teach the
    generator to quote a package we no longer have."""
    from bd_bot import knowledge, responder

    real = Path(__file__).resolve().parents[1] / "chat-example"
    if not real.is_dir():
        pytest.skip("no chat-example/ folder")
    for p in chat_examples.load_pairs(str(real)):
        blob = f"{p.client}\n{p.agent}"
        for marker in NOISE_MARKERS:
            assert marker.lower() not in blob.lower(), (marker, p.source)
        assert not responder._unauthorised_percents(p.agent), p.source
        assert not responder._unauthorised_durations(p.agent), p.source
        for banned in ("garansi", "jamin", "non pajak"):
            assert banned not in p.agent.lower(), (banned, p.source)

    # The exemptions are exactly two figures, not a general amnesty.
    # The MCN cut, plus the per-category commission on GMV from ads that the
    # 18 Sep 2026 deck prints on both bundling pages. Merging the two sets is
    # what let "Komisi ke MCN biasanya di 5%" through, so `responder.
    # _unauthorised_percents` judges each figure by the clause it sits in —
    # this only pins WHICH figures exist.
    assert knowledge.ALLOWED_PERCENTS == {"10%", "8%", "5%"}
    # One per tier since the 18 Sep 2026 deck restored the ladder.
    assert knowledge.ALLOWED_DURATIONS == {"2 bulan", "4 bulan", "6 bulan"}
