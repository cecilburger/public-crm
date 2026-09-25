"""Telling a brand's switchboard apart from a brand.

Every string here is real — sent by Kino, Indofood, Sosro, Cimory, Kapal Api
and Greenfields on 13 Aug 2026. On that day the intent classifier read them as
buying signals (mostly `minta_telepon`, because they mention a Customer Care
number), the flow walked five of them to `node=scheduling, outcome=acceptance`,
and the dashboard reported seven "interested" brands of which exactly zero
were. The one real lead was buried among them.

So this is checked BEFORE classification: a machine has nothing to say that
the state machine should act on.
"""

from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bd_bot.config import Settings  # noqa: E402
from bd_bot.engine import Engine  # noqa: E402
from bd_bot.models import Conversation, Node  # noqa: E402
from bd_bot.storage import Store  # noqa: E402
from bd_bot.transport.mock import MockTransport  # noqa: E402

JID = "628123@s.whatsapp.net"

# --- verbatim, from the 13 Aug transcripts --------------------------------
KINO = ("Terima kasih telah menghubungi Customer Care PT. Kino Indonesia\n\n"
        "Dapat kami informasikan bahwa untuk penawaran kerjasama seperti yang "
        "dimaksud, Bapak/Ibu dapat mengirimkan ke email berikut")
INDOFOOD = ("Selamat datang di layanan Whatsapp Indofood! Mohon menginformasikan "
            "nama Bapak/Ibu untuk kami proses lebih lanjut")
INDOFOOD_MENU = ("Kamu belum menentukan pilihan menu yang dibutuhkan. Silakan "
                 "menghubungi kami kembali ke nomor WhatsApp atau telepon ke "
                 "0800-1000-000 serta email ke corporate@contoh-fnb.co.id")
SOSRO = "Halo\n\nSelamat Datang Di Call Centre PT Sinar Sosro Gunung Slamat"
CIMORY = ("Hai Cimories, \n Terima kasih sudah menghubungi layanan whatsapp "
          "Cimory . Ada yang bisa kami bantu? Ketik informasi yang Kakak "
          "butuhkan :\n1. Informasi mengenai produk\n2. Kritik dan saran")
KAPAL_API = ("Konsumen yang terhormat, Mohon maaf kami tidak mengerti maksud "
             "Anda. Anda dapat kembali ke Menu.")
GREENFIELDS = ("Hiii Greenfields Friends, Thank you for reaching out to "
               "Greenfields \n\nUntuk mempercepat proses, mohon lengkapi "
               "informasi berikut")
GCAL_ECHO = ("Meeting Online Pip Mim Official X MCN Asia\nSaturday, August 15 · "
             "12:00 – 1:00pm\nTime zone: Asia/Jakarta\nGoogle Meet joining info\n"
             "Video call link: https://meet.google.com/fdu-eswu-xco")

AUTORESPONDERS = [KINO, INDOFOOD, INDOFOOD_MENU, SOSRO, CIMORY, KAPAL_API,
                  GREENFIELDS, GCAL_ECHO]

# --- and the one real lead, verbatim too ----------------------------------
HUMAN = [
    "Hallo kak,",
    "untuk pricenya start di nominal yang sama kak?",
    "boleh kak dijadwalkan online meeting untuk informasi yang lebih detail",
    "kapan kak? sabtu, 15 agustus 2026 pukul 13.-00 bagaimana kak?",
    "dyanjati747@gmail.com",
    "baik kak",
    "okay kak",
    "boleh minta portofolionya kak? kami mau lihat dulu case study nya",
    "harganya bisa nego gak kak kalau ambil paket setahun?",
]


@pytest.fixture
def bot(tmp_path):
    cfg = Settings()
    cfg.db_path = tmp_path / "auto.sqlite3"
    cfg.dry_run = False
    cfg.require_approval = False
    cfg.auto_reply = True
    cfg.min_seconds_between_sends = 0
    cfg.use_llm_replies = False
    cfg.demo_mode = False
    cfg.company_profile_pdf = tmp_path / "p.pdf"
    cfg.company_profile_pdf.write_bytes(b"%PDF-1.4")
    cfg.opening_dir = tmp_path / "opening"
    cfg.opening_dir.mkdir(exist_ok=True)
    (cfg.opening_dir / "d.pdf").write_bytes(b"%PDF-1.4")
    store = Store(cfg.db_path)
    transport = MockTransport(echo=False)
    eng = Engine(cfg, store, transport)
    eng.within_send_window = lambda when: True
    transport.start(eng.handle_inbound)
    yield eng, transport, cfg, store
    store.close()


# -- detection --------------------------------------------------------------


@pytest.mark.parametrize("text", AUTORESPONDERS)
def test_real_autoresponders_are_recognised(bot, text):
    eng, _, _, _ = bot
    assert eng._looks_automated(text) is True


@pytest.mark.parametrize("text", HUMAN)
def test_a_real_person_is_not_mistaken_for_one(bot, text):
    eng, _, _, _ = bot
    assert eng._looks_automated(text) is False


def test_a_short_message_is_never_automated(bot):
    """"call center?" from a human is four words, not a switchboard."""
    eng, _, _, _ = bot
    assert eng._looks_automated("call center?") is False


def test_a_numbered_menu_is_automated_whatever_it_says(bot):
    eng, _, _, _ = bot
    menu = ("Silakan pilih:\n1. Kerja sama\n2. Komplain\n3. Lainnya\n"
            "Balas dengan nomor yang sesuai ya")
    assert eng._looks_automated(menu) is True


def test_one_numbered_line_is_not_a_menu(bot):
    """A human writing "1. harga" as a single point is not a switchboard."""
    eng, _, _, _ = bot
    assert eng._looks_automated(
        "boleh kak, tapi saya mau tanya dulu:\n1. harganya berapa ya kak?"
    ) is False


# -- what it does to the flow ----------------------------------------------


def test_an_autoresponder_never_reaches_the_flow(bot):
    """The 13 Aug bug: five machines walked to node=scheduling.

    The bot does leave one closing card (see the card tests below), but the
    state machine must not move — a switchboard has agreed to nothing.
    """
    eng, transport, _, store = bot
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Kino"))
    eng.handle_inbound(JID, "Kino", KINO)
    assert store.get(JID).node is Node.BLASTED, "a machine advanced the flow"


def test_it_is_not_classified_as_a_buying_signal(bot):
    """`minta_telepon` is what these used to be read as."""
    eng, _, _, store = bot
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Kino"))
    eng.handle_inbound(JID, "Kino", KINO)
    intents = [r["intent"] for r in store.db.execute(
        "SELECT intent FROM messages WHERE jid = ? AND direction = 'in'", (JID,))]
    assert intents == ["auto"]


def test_the_text_is_still_kept(bot):
    eng, _, _, store = bot
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Kino"))
    eng.handle_inbound(JID, "Kino", KINO)
    assert KINO in store.recent_inbound_texts(JID)


def test_a_human_after_the_autoresponder_is_still_served(bot):
    """Plenty of brands answer with a canned line first, then a real person."""
    eng, transport, _, store = bot
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Kino"))
    eng.handle_inbound(JID, "Kino", KINO)
    transport.sent.clear()
    eng.handle_inbound(JID, "Bu Ani", "halo kak, boleh minta detail paketnya?")
    assert transport.sent != [], "a real person was ignored after a canned reply"


# -- what it does to the tracker -------------------------------------------


def test_a_switchboard_is_not_reported_as_interested(bot):
    eng, _, _, store = bot
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Cimory"))
    for text in (CIMORY, CIMORY, CIMORY):
        eng.handle_inbound(JID, "Cimory", text)
    [c] = store.conversation_summaries()
    assert c["status"] == "auto", f"reported as {c['status']}"


def test_the_real_lead_still_reads_as_interested(bot):
    """Pip Mim's actual words. Production runs USE_LLM_INTENTS=true, which read
    "untuk pricenya start di nominal yang sama kak?" as tanya_harga; the static
    classifier this fixture uses does not, so the assertion rides on the line
    both agree on rather than on the classifier being clever."""
    eng, _, _, store = bot
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="Pip Mim Official"))
    eng.handle_inbound(
        JID, "Pip Mim",
        "boleh kak dijadwalkan online meeting untuk informasi yang lebih detail")
    [c] = store.conversation_summaries()
    assert c["status"] == "minat"


def test_a_human_turning_up_later_lifts_it_out_of_auto(bot):
    eng, _, _, store = bot
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="Kino"))
    eng.handle_inbound(JID, "Kino", KINO)
    assert store.conversation_summaries()[0]["status"] == "auto"
    eng.handle_inbound(JID, "Bu Ani", "harganya berapa kak?")
    assert store.conversation_summaries()[0]["status"] == "minat"


# -- the ones that slipped through the first pass --------------------------
# Found by re-running the detector over the 13 Aug transcripts: short menu
# prompts fell under the length gate, and Greenfields' opener uses none of the
# usual phrases at all.

GREENFIELDS_OPENER = (
    "Hi Greenfields Friends!\n\nUntuk informasi seputar kerja sama, kolaborasi, "
    "atau sponsorship dengan Greenfields, silakan mengirimkan proposal atau "
    "pertanyaan ke email berikut")
GREENFIELDS_QUEUE = (
    "Hallo Greenfields Friends! \nTerima kasih sudah menghubungi Greenfields\n"
    "Sesaat lagi kamu akan terhubung dengan Tim Greenfields Consumer Feedback.")
KAPAL_PROMPTS = [
    "Mohon sebutkan nama lengkap Anda",
    "Informasi apa yang Anda butuhkan saat ini?",
    "Mohon maaf telah terjadi kesalah, silahkan pilih menu kembali",
    "Pelanggan yang terhormat,\n\nTerima kasih telah menghubungi layanan "
    "pelanggan Kapal Api Group!",
]


@pytest.mark.parametrize(
    "text", [GREENFIELDS_OPENER, GREENFIELDS_QUEUE, *KAPAL_PROMPTS])
def test_the_stragglers_are_caught_too(bot, text):
    eng, _, _, _ = bot
    assert eng._looks_automated(text) is True


@pytest.mark.parametrize("text", [
    "call center?",                       # a person asking where to call
    "boleh minta nomor telepon kak?",
    "menu paketnya apa aja kak?",         # "menu" without the machine around it
    "kembali lagi kak, jadi gimana?",
])
def test_short_human_lines_are_still_safe(bot, text):
    eng, _, _, _ = bot
    assert eng._looks_automated(text) is False


# -- one closing card, then silence ----------------------------------------
# The BD team wants the deck left with the switchboard rather than nothing
# said. Exactly once: answering an autoresponder conversationally is what drew
# eight replies in twelve minutes on 12 Aug and cost the account.


def test_the_first_autoresponder_gets_one_card(bot):
    eng, transport, _, store = bot
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Kino"))
    transport.sent.clear()
    eng.handle_inbound(JID, "Kino", KINO)
    bodies = [t for _, t in transport.sent]
    assert bodies, "nothing was left with the brand"
    assert "titip file" in bodies[0].lower()


def test_it_is_left_exactly_once(bot):
    """Ten canned replies must still produce one card."""
    eng, transport, _, store = bot
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Kino"))
    transport.sent.clear()
    for _ in range(10):
        eng.handle_inbound(JID, "Kino", KINO)
    texts = [t for _, t in transport.sent if "titip file" in t.lower()]
    assert len(texts) == 1, f"{len(texts)} cards went out"


def test_no_card_if_we_have_already_spoken(bot):
    """A brand mid-conversation that emits a canned line gets silence, not a
    cold closing card in the middle of a live thread."""
    eng, transport, _, store = bot
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="Kino"))
    store.log_message(JID, "out", "Selamat siang, Kak.", eng.now(), "campaign")
    transport.sent.clear()
    eng.handle_inbound(JID, "Kino", KINO)
    assert [t for _, t in transport.sent if "titip file" in t.lower()] == []


def test_the_card_still_leaves_the_deck(bot):
    eng, transport, _, store = bot
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Kino"))
    transport.sent.clear()
    eng.handle_inbound(JID, "Kino", KINO)
    assert any("[document:" in t or "[image:" in t for _, t in transport.sent), \
        "the card went out without the file it promises"


# -- round two: what got through on 13 Aug evening -------------------------
# Nine more hotlines, each worded differently enough to miss the phrase list.
# The two structural checks below carry most of these, which is the point:
# they do not care how a brand words its switchboard.

ROUND_TWO = [
    "Selamat datang di Quantum Springbed. Chat akan segera kami respon sesuai "
    "antrian ya kak, mohon menunggu",
    "Maaf Anda belum memilih, silakan memilih",
    "Mohon maaf, saya belum berhasil menyusun jawaban untuk permintaan ini. "
    "Boleh coba lagi sebentar?",
    "Sorry, I couldn't put together an answer for this - please try again",
    "Dikarenakan tidak ada jawaban sesi chat sementara kami tutup.\n\nJika "
    "Bapak/Ibu masih memerlukan bantuan, silakan chat kami kembali",
    "Poink bisa bantu Anda memberikan layanan berikut:\n\n*1. Daftar KPoin*\n"
    "*2. Event*\n*3. Lainnya*",
    "Maaf, pilihan yang Anda kirimkan tidak tersedia. Silakan pilih salah satu "
    "opsi yang sudah kami sediakan.",
    "*Hi #maheaddicts*\n*Pesan kamu akan dibalas pada jam kerja yaa "
    "(Senin - Jumat, 09.00 - 16:00 WIB)*",
    "🔍 Mencari jawaban...",
]


@pytest.mark.parametrize("text", ROUND_TWO)
def test_round_two_hotlines_are_caught(bot, text):
    eng, _, _, _ = bot
    assert eng._looks_automated(text) is True


def test_a_greeting_addressed_to_our_own_number_is_a_template(bot):
    """"Hai Kak 6281900000001!" — nobody types a phone number as a name."""
    eng, _, _, _ = bot
    assert eng._looks_automated(
        "Hai Kak 6281900000001 ! Selamat datang di OFFO Living",
        own_number="6281900000001") is True


def test_whatsapp_user_is_a_placeholder_not_a_name(bot):
    eng, _, _, _ = bot
    assert eng._looks_automated(
        "Baik kak Whatsapp User , Terimakasih banyak sudah menghubungi kami"
    ) is True


def test_terimakasih_without_the_space_still_matches(bot):
    eng, _, _, _ = bot
    assert eng._looks_automated(
        "Terimakasih banyak sudah menghubungi layanan kami ya kak, mohon "
        "ditunggu") is True


def test_an_asterisk_wrapped_menu_is_still_a_menu(bot):
    eng, _, _, _ = bot
    assert eng._looks_automated("*1. Harga*\n*2. Katalog*\n*3. Lainnya*") is True


@pytest.mark.parametrize("text", [
    "saya pilih paket yang 300 ya kak",
    "menu paketnya apa aja kak?",
    "boleh minta portofolionya kak?",
    "nomor saya 628119000002 ya kak",     # their OWN number, not ours
])
def test_round_two_does_not_catch_people(bot, text):
    eng, _, _, _ = bot
    assert eng._looks_automated(text, own_number="6281900000001") is False


# -- the tracker must not trust machine-driven flow state ------------------


def test_a_machine_that_walked_the_flow_is_still_auto(bot):
    """The 13 Aug failure exactly: node=scheduling, outcome=acceptance, set by
    a switchboard. Trusting that is trusting a conclusion a machine reached on
    our behalf."""
    from bd_bot.models import Outcome

    eng, _, _, store = bot
    c = Conversation(jid=JID, node=Node.SCHEDULING, name="Sanken")
    c.outcome = Outcome.ACCEPTANCE
    store.upsert(c)
    for text in (KINO, CIMORY, SOSRO):
        eng.handle_inbound(JID, "Sanken", text)
    assert store.conversation_summaries()[0]["status"] == "auto"


def test_one_unmatched_line_does_not_rescue_a_hotline(bot):
    """Interlac got through on eight unmatched lines out of twelve."""
    eng, _, _, store = bot
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="Interlac"))
    for text in (KINO, CIMORY, SOSRO, KAPAL_API):
        eng.handle_inbound(JID, "Interlac", text)
    store.log_message(JID, "in", "hmm", eng.now(), "unknown")
    assert store.conversation_summaries()[0]["status"] == "auto"


def test_a_real_person_taking_over_still_wins(bot):
    """Two thirds is a tolerance, not a trap: enough human turns and the
    thread belongs to the human again."""
    eng, _, _, store = bot
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="Kino"))
    eng.handle_inbound(JID, "Kino", KINO)
    for q in ("harganya berapa kak?", "boleh minta portofolionya kak?",
              "boleh kak dijadwalkan online meeting untuk informasi detail"):
        eng.handle_inbound(JID, "Bu Ani", q)
    assert store.conversation_summaries()[0]["status"] == "minat"


def test_the_loop_breakers_verdict_is_trusted(bot):
    """Interlac runs an AI assistant writing flawless Indonesian in the third
    person — no phrase list catches it, but the loop breaker did. That verdict
    outranks the ratio."""
    eng, _, _, store = bot
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="Interlac"))
    # The real thread: six canned/looping turns among twelve. One or two would
    # be a switchboard handing over — six means nobody ever did.
    eng.handle_inbound(JID, "Marlina", KINO)          # raises the auto-loop flag
    for text in (CIMORY, SOSRO, KAPAL_API, INDOFOOD, GREENFIELDS):
        eng.handle_inbound(JID, "Marlina", text)
    for text in ("Baik, Grace. Terima kasih atas informasinya mengenai jadwal.",
                 "Marlina akan mencatat bahwa Grace memerlukan alamat email.",
                 "Tentu, Grace. Alamat email yang bisa digunakan adalah redaksi@x.id",
                 "Marlina tunggu konfirmasi jadwalnya ya."):
        store.log_message(JID, "in", text, eng.now(), "setuju")
    assert store.conversation_summaries()[0]["status"] == "auto"


def test_a_real_person_asking_the_price_is_still_minat(bot):
    """Widya Alfares, verbatim — late apology, stretched vowels, a real
    question about a real number. Exactly what must not be swept up."""
    eng, _, _, store = bot
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="Widya Alfares"))
    eng.handle_inbound(
        JID, "Widya",
        "Hallo kaaaa maaf baru sempat balas , btw harga yang di tawarkan "
        "itu bener 10 juta ka?")
    assert store.conversation_summaries()[0]["status"] == "minat"


# -- round three: found by replaying every stored message ------------------
# Not from a complaint this time — from measuring where the API key went. A
# fifth of all inbound was still reaching the LLM, and most of it was hotline
# greetings. Each marker here removes a call AND a pointless reply.

ROUND_THREE = [
    "Hai Sahabat GarudaFood Group (DILAN, Gery, Chocolatos, Garuda, Clevo)",
    "Hii Beefams, informasi apa yang bisa kami bantu 😊",
    "Halo kak 👋 Terima kasih atas ketertarikannya dan penawarannya 🙏✨",
    "Hi kak! Sebelumnya terima kasih atas tawaran kerjasama untuk Unilever",
    "Hi, Kak. Terima kasih atas ketertarikan Kakak untuk bergabung sebagai mitra",
    "Mohon balas dengan mengetik angkanya saja pada pilihan yang tersedia",
    "Welcome to Aurora Saffron Collagen! Pesanmu telah kami terima",
    "Mohon maaf, Putri tidak mengerti dengan pertanyaan yang kamu tanyakan",
]


@pytest.mark.parametrize("text", ROUND_THREE)
def test_round_three_hotlines_are_caught(bot, text):
    eng, _, _, _ = bot
    assert eng._looks_automated(text) is True


@pytest.mark.parametrize("text", [
    "hai kak, kami tertarik dengan penawarannya",
    "terima kasih infonya kak",
    "boleh minta detail paketnya kak?",
    "hi kak boleh tanya harga?",
    "ada yang bisa saya bantu kak?",
    "sama-sama kak",
])
def test_round_three_does_not_catch_people(bot, text):
    eng, _, _, _ = bot
    assert eng._looks_automated(text) is False
