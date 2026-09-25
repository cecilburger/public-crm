"""Message bank.

Derived from the Knowledge & Behaviour layer of FLOWCHART.md, rewritten to be
professional, formal and informative while staying noticeably shorter than the
originals on the whiteboard. Substance is unchanged: same offer, same packages,
same sequence — only the phrasing is tightened.

Every template takes the conversation context so names are never hardcoded
(FLOWCHART.md §6.4 flagged "Grrece" and "Kak Cika" baked into the source copy).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from . import knowledge
from .config import Settings
from .models import Conversation


@dataclass(slots=True)
class Message:
    """A rendered outbound message, optionally with a document attachment."""

    text: str
    attach_company_profile: bool = False
    attach_opening: bool = False
    """Ship every file in `Settings.opening_dir` after this message. Only the
    opening blast does this. Currently the service deck alone."""
    attach_case_study: bool = False
    """Ship the contact's category case-study folder (ROADMAP 2.4) — the
    GMV-report screenshots the real agents send at exactly this moment.
    No category or no folder means nothing extra is sent."""
    attach_ads_deck: bool = False
    """Ship `Settings.ads_deck_pdf` — the ads-service deck, sent when a brand
    asks about ads rather than the affiliate campaign. Missing file means the
    answer still goes out as text."""
    key: str = ""
    """Which template produced this. Lets the responder regenerate a grounded
    variant while keeping this rendering as the fallback."""


#: Indonesian time-of-day greeting, by local clock. Boundaries follow
#: everyday usage rather than any standard: "siang" starts at 11, "sore" mid
#: afternoon, and "malam" carries the whole night — a message at 03.00 is
#: "malam", never "pagi".
def salam(now: datetime) -> str:
    """The greeting word that fits the time this is being sent."""
    hour, minute = now.hour, now.minute
    if 5 <= hour < 11:
        return "pagi"
    if 11 <= hour < 15:
        return "siang"
    if 15 <= hour < 18 or (hour == 18 and minute < 30):
        return "sore"
    # Everything else, including the small hours: 03.00 is "malam", not
    # "pagi" and certainly not "sore" — the lower bound matters as much as
    # the upper one.
    return "malam"


def _ctx(convo: Conversation, cfg: Settings, now: datetime | None = None) -> dict[str, str]:
    return {
        # Templates say "Selamat {salam}", never a fixed time of day: the
        # opening went out at 03.27 and at 23.07 saying "Selamat siang".
        "salam": salam(now or datetime.now(tz=cfg.tz)),
        # Always "Kak", never the contact's name — the real chats address
        # everyone as Kak/Kakak, and a wrong or misspelled name reads worse
        # than no name at all.
        "nama": "Kak",
        "brand": convo.brand or "brand Anda",
        "sender": cfg.sender_name,
        "company": cfg.company_name,
        # The six services as the team lists them, from knowledge.py — one
        # list, so the menu cannot drift between the three templates that
        # offer it.
        "menu": knowledge.service_menu_lines(),
        # The client names the deck prints (knowledge.CLIENTS) — the ONLY
        # brands a portfolio answer may name. The corpus names others
        # ("C'Kel", "Perlyco", "Canni") that the deck does not.
        "clients": ", ".join(knowledge.CLIENTS),
        # Our WhatsApp number for the DM → WA hand-off. Empty unless
        # BD_WHATSAPP_NUMBER is set; the flow never renders DM_TO_WA without
        # it, so a template is never sent with a blank where a number goes.
        "wa": cfg.bd_whatsapp_number,
    }


def _f(body: str, convo: Conversation, cfg: Settings) -> str:
    return body.strip().format(**_ctx(convo, cfg))


# ---------------------------------------------------------------------------
# Opening — FLOWCHART.md §5.1
# ---------------------------------------------------------------------------

BLASTING = """
Selamat {salam}, {nama}. Perkenalkan, saya {sender} dari Business Development {company} — Official Partner TikTok & Shopee.

Kami mengelola campaign affiliate untuk brand seperti Unilever, Mondelez, Ultra Milk, Anker, dan Kintakun, dengan rata-rata GMV Rp1–2 miliar per bulan. Pengalaman kami mencakup kategori F&B, Beauty, Mom & Kids, Home Living, Fashion, dan Health.

Kami ingin menawarkan kerja sama Campaign Affiliate untuk meningkatkan awareness sekaligus penjualan {brand}. Company profile kami lampirkan sebagai gambaran awal.

Apabila berkenan, bolehkah kami jadwalkan online meeting singkat untuk membahas lebih lanjut?
"""


# ---------------------------------------------------------------------------
# Inbound ad leads — the qualification SOP observed in every "Client N"
# export: greeting + data form first, then the service summary. ROADMAP 2.1.
# ---------------------------------------------------------------------------

INBOUND_QUALIFY = """
Halo, {nama}, salam kenal 😊 Saya {sender} dari {company}, Official Partner TikTok & Shopee.

Sebelum kami jelaskan layanan yang sesuai dengan kebutuhan brand {nama}, mohon bantu isi data berikut ya:

• Nama Brand:
• Posisi di Brand:
• Link TikTok Shop:
• Link Shopee:

Terima kasih, {nama}. 🙏 Setelah datanya kami terima, kami akan memberikan penjelasan singkat terkait layanan yang relevan dan mengatur jadwal meeting online sesuai kebutuhan brand {nama}.
"""

#: Rewritten 24 Sep 2026 to the message the team actually sends after the
#: form — the same text, near enough verbatim, in 15 of the 36 inbound
#: conversations: intro line, the six-line menu, the meeting invitation, and
#: the "insight either way" reassurance. Two things are deliberately not
#: carried over from the corpus: the "20–30 menit" (the bank never states a
#: duration, see test_no_template_mentions_meeting_duration) and the closing
#: silence — the team's version ends without a question and they then send
#: "possible jam berapa?" as a second message, so the question is folded in.
#: The menu itself comes from knowledge.SERVICE_MENU, names only.
INBOUND_SERVICE_MENU = """
Terima kasih, {nama}. Tim kami akan menganalisis datanya terlebih dahulu 🙏

Perkenalkan, {company} merupakan Official Partner TikTok & Shopee yang membantu brand meningkatkan penjualan melalui strategi digital yang terukur.

Layanan kami meliputi:
{menu}

Jika berkenan, kami ingin mengundang {nama} untuk online meeting singkat. Pada sesi ini kami akan membahas peluang, kendala, serta memberikan rekomendasi strategi dan penawaran yang disesuaikan dengan kebutuhan {brand}. Semoga hasil diskusinya dapat menjadi insight bagi brand, terlepas dari ada atau tidaknya kerja sama 😊

Kira-kira {nama} ada waktu di hari dan jam berapa?
"""


# ---------------------------------------------------------------------------
# Inbound selling — the conversation points mined from inbound/ (24 Sep 2026)
#
# Each of these answers a turn the CRM PDF names and the first mining round
# left UNKNOWN. The wording is the team's own, lifted from the corpus and the
# PDF's worked scripts, with three edits applied everywhere: no meeting
# duration in minutes, no figure that is not in knowledge.py (the corpus
# quotes a "minimal Rp30 juta / 28 hari" curation bar, a "10ribu database"
# and "start di level 3" that the deck does not authorise), and "Kak" for
# every name.
# ---------------------------------------------------------------------------

#: "Mau info affiliate", "kak mau tanya service MCNASIA", "info kak". The
#: PDF's story-reply script, first turn: explain in one breath, then ask
#: about THEIR product and platform. No price, no meeting yet — the PDF row
#: for this is "Warm — gali kebutuhan", and a price list here is the "jangan
#: hanya kirim pricelist" mistake by another route.
REPLY_MINTA_INFO = """
Halo, {nama}, salam kenal 😊 Saya {sender} dari {company}, Official Partner TikTok & Shopee.

Untuk campaign affiliate, kami membantu dari proses kurasi sampai aktivasi affiliate sesuai kategori produk brand. Fokusnya bukan hanya distribusi produk — campaign kami arahkan untuk membantu meningkatkan exposure, konten UGC, traffic, sampai penjualan.

Boleh tahu produknya apa, dan saat ini sudah aktif di TikTok Shop atau Shopee, {nama}?
"""

#: "Bentuk layanannya apa aja", "selain affiliate ada layanan lain?". The
#: corpus answer, every time: the six-line menu and a question about category
#: and need. Names only — the menu carries no price on purpose, because a
#: brand that picks a line from it is then asked what they need, which is
#: the PDF's "gali target → offer" order.
REPLY_TANYA_LAYANAN = """
Baik, {nama} 😊

{company} merupakan Official Partner TikTok & Shopee yang membantu brand meningkatkan penjualan melalui strategi digital yang terukur.

Layanan kami meliputi:
{menu}

Kalau boleh tahu, produk {brand} kategori apa, dan kebutuhannya saat ini lebih ke mana, {nama}? Supaya saya bisa bantu rekomendasikan yang paling sesuai.
"""

#: "Affiliate", "Saya butuh affiliate kak", "Colab affiliator". The need,
#: stated — the turn the corpus answers with a short pitch and the meeting
#: invitation in the same message ("Baik Kak. Untuk kategori produk Kakak,
#: Affiliate Campaign cukup relevan… Kalau berkenan, kita bisa diskusi
#: singkat… Untuk lanjut kerja sama atau tidak tentu tidak masalah"). The
#: reassurance is kept: it is the team's most-used device for getting a
#: hesitant lead into the room. The template asks for the time itself, so
#: the flow does not stack OFFER_MEETING on top of it.
REPLY_BUTUH_AFFILIATE = """
Baik, {nama}. Untuk kebutuhan affiliate, Campaign Affiliate kami cukup relevan untuk {brand} 😊

Sedikit saya jelaskan: affiliate kami berasal dari database yang sudah dikurasi berdasarkan kategori produk, positioning brand, dan histori penjualan 28 hari terakhir — jadi bukan sekadar mengejar jumlah creator, tapi diarahkan untuk mendukung traffic dan potensi sales. Kami yang mengurus mulai dari kurasi affiliate, aktivasi campaign, monitoring konten, hingga evaluasi performanya.

Supaya kami bisa jelaskan sistem campaign dan rekomendasi strateginya lebih detail sesuai kondisi {brand}, boleh kita jadwalkan meeting online singkat? Untuk lanjut kerja sama atau tidak tentu tidak masalah, {nama} — setidaknya {nama} mendapat gambaran yang lebih jelas.

Kira-kira {nama} ada waktu di hari dan jam berapa? 🙏
"""

#: "Aku ragu, udah 2x pernah dipromosiin tapi gak ada hasil", "affiliate
#: video banyak tapi gak ke arah sales". The objection the corpus handles
#: best, and BD's own answer to it (Jul 2026): agree that it is normal, name
#: the cause (quantity is not the lever, curation and monitoring are), and
#: offer the case study at the meeting. No figure anywhere — the temptation
#: here is to quote a GMV, and that is what the guard exists to stop.
REPLY_PERNAH_AGENCY = """
Wajar banget, {nama} — affiliate yang banyak memang belum tentu menghasilkan sales. Yang paling menentukan bukan jumlah videonya, tapi sistem campaign dan kualitas affiliate-nya.

Di {company}, kami tidak hanya mengejar kuantitas, tetapi membangun campaign yang berorientasi pada penjualan: mulai dari seleksi affiliate yang sesuai target market {brand}, briefing konten, monitoring performa harian, hingga optimasi affiliate yang benar-benar menghasilkan konversi.

Kalau boleh tahu, sebelumnya {brand} di-handle dengan skema seperti apa, {nama}? Dan kalau berkenan, saat meeting online singkat nanti kami tunjukkan studi kasus dan dashboard performa campaign dari kategori yang serupa sebagai bahan pertimbangan 🙏
"""


#: The answer to our own "fokus campaign lebih ke awareness, penjualan, atau
#: keduanya?" — three answers, three replies, each tying the focus to the
#: fitting line of knowledge.SERVICE_MENU and ending on the hari/jam ask.
#: Modelled on the CRM PDF's story-reply script ("Siap Kak. Kalau fokus
#: utamanya sales, berarti kami perlu lihat kondisi akun dan produknya
#: terlebih dahulu supaya campaign yang kami rekomendasikan bukan sekadar
#: mengejar banyak affiliate…") and the team's own line in inbound/ ("campaign
#: affiliate untuk percepatan sale … sembari beriringan meningkatkan
#: awareness"). The PDF's version also asks for the shop link at this point;
#: on WhatsApp the form has already collected it, so that ask is left out.
#: Facts only from knowledge.py — the curation basis and the daily
#: monitoring list are CURATION / DIFFERENTIATORS; no figure anywhere.
REPLY_FOKUS_SALES = """
Siap, {nama} 😊 Kalau fokus utamanya penjualan, Campaign Affiliate memang kami arahkan ke sana: affiliate dikurasi sesuai kategori produk dan histori penjualannya, lalu performanya — view, like, komentar, sampai GMV — kami pantau harian. Jadi bukan sekadar mengejar banyak affiliate, tapi yang relevan dengan potensi penjualan {brand}.

Supaya rekomendasinya tepat, tim kami perlu lihat kondisi akun dan produknya terlebih dahulu. Setelah itu kita bahas hasil analisisnya, target sales, dan skema campaign yang paling sesuai lewat meeting online singkat ya, {nama}.

Kira-kira {nama} ada waktu di hari dan jam berapa?
"""

REPLY_FOKUS_AWARENESS = """
Baik, {nama} 😊 Untuk awareness, Campaign Affiliate juga relevan: konten dari para affiliate menjadi UGC yang menambah exposure dan traffic ke produk {brand}, dan affiliate-nya kami kurasi sesuai kategori serta positioning brand supaya kontennya sampai ke audience yang tepat. Kalau perlu, ini bisa dipadukan dengan Branding & Content untuk akun official {brand}.

Supaya strateginya pas dengan target {brand}, izin kami jelaskan skemanya lewat meeting online singkat ya, {nama}. Kira-kira {nama} ada waktu di hari dan jam berapa?
"""

REPLY_FOKUS_KEDUANYA = """
Siap, {nama} 😊 Campaign Affiliate memang kami jalankan untuk keduanya — percepatan penjualan sembari beriringan meningkatkan awareness: affiliate dikurasi sesuai kategori dan histori penjualannya, kontennya menjadi UGC yang menambah exposure produk {brand}, dan performanya kami pantau harian sampai GMV.

Supaya rekomendasinya tepat, tim kami perlu lihat kondisi akun dan produknya terlebih dahulu, lalu kita bahas hasil analisis, target, dan skema campaign yang paling sesuai lewat meeting online singkat ya, {nama}.

Kira-kira {nama} ada waktu di hari dan jam berapa?
"""


# ---------------------------------------------------------------------------
# DM → WhatsApp hand-off (24 Sep 2026)
#
# The BD funnel is comment → DM → WhatsApp → meeting. A DM is where the lead
# is qualified and one exchange is had; the moment they show interest they
# are moved to WhatsApp, where the deck can be attached (IG DM takes no
# documents at all) and the meeting is arranged. The number comes from
# Settings.bd_whatsapp_number and the flow never sends these without it.
#
# Wording follows how the team hands a number over in the corpus ("izin saya
# kirimkan no nya juga", "kalau ada waktu, Kaka bisa hubungi no ini aja ya")
# — the lead does the writing. That is what keeps this inbound: nothing here
# messages anyone on WhatsApp first.
# ---------------------------------------------------------------------------

#: First contact in a DM (IG/FB) — the PDF's IG-DM script, lighter than the
#: WhatsApp form: brand and product, and which platform they sell on. A DM
#: is a smaller box than WhatsApp, and the four-line form reads as a wall
#: there; the full form comes on WhatsApp if it is still needed.
INBOUND_QUALIFY_DM = """
Halo, {nama}, salam kenal 😊 Saya {sender} dari {company}, Official Partner TikTok & Shopee.

Sebelumnya boleh tahu nama brand dan produk yang sedang {nama} develop? Dan saat ini penjualannya lebih fokus di TikTok Shop, Shopee, atau keduanya?
"""

#: Their answer to the DM qualification (brand/product/platform). The PDF's
#: IG-DM script, third turn: relate the need to the affiliate campaign, say
#: what we do, and dig once more — the PDF's story-reply script asks
#: "fokus utamanya lebih ingin meningkatkan sales, awareness, atau
#: keduanya?". Whatever they answer next is the interest signal that moves
#: them to WhatsApp.
DM_SERVICE_PITCH = """
Baik, {nama} 😊 Berarti kebutuhannya cukup relate dengan service Campaign Affiliate {company}.

Kami membantu mulai dari kurasi affiliate sesuai kategori brand, aktivasi campaign, monitoring konten, hingga evaluasi performa. Affiliate juga kami seleksi berdasarkan performanya, sehingga campaign bukan hanya mengejar jumlah creator, tetapi diarahkan untuk mendukung traffic dan potensi sales.

Kalau boleh tahu, saat ini fokus utama {brand} lebih ingin meningkatkan sales, awareness, atau keduanya, {nama}?
"""

#: The hand-off itself. Says why (materials, a proper discussion), gives the
#: number once, and says what happens there (our team continues and arranges
#: the meeting). It does not ask for THEIR number: the lead writes to us, so
#: no WhatsApp message is ever sent to someone who has not written first.
DM_TO_WA = """
Baik, {nama} 😊 Supaya diskusinya lebih enak dan sekalian bisa kami kirimkan materinya, izin kami lanjutkan lewat WhatsApp ya, {nama}.

Ini nomor WhatsApp kami: {wa}

{nama} boleh langsung chat ke nomor tersebut — nanti tim kami yang bantu lanjutkan sekaligus mengatur jadwal meeting online-nya 🙏
"""

#: A lead who keeps talking in the DM after being given the number, without
#: asking anything. Said once more, shorter; after that the flow goes quiet
#: on the pointer and a human is told. Repeating it every turn is what makes
#: a lead stop replying.
DM_TO_WA_AGAIN = """
Siap, {nama} 🙏 Untuk lanjutannya boleh langsung chat ke WhatsApp kami ya: {wa} — nanti tim kami yang bantu di sana.
"""


# ---------------------------------------------------------------------------
# Cold ladder — FLOWCHART.md §2.1 + §2.2
#
# NOTE: the whiteboard describes cold silence twice with conflicting timings
# (control layer: 4 jam / H+1 / H+5; knowledge layer: H0 16:00 / D3). These are
# merged here into one four-rung ladder that preserves every message and every
# timing from both, in escalating order. See README "Resolved conflicts".
# ---------------------------------------------------------------------------

COLD_FU1 = """
Selamat {salam}, {nama}. Izin menindaklanjuti pesan saya sebelumnya.

Saya memahami bila {nama} sedang padat. Sebagai bahan referensi, saya lampirkan company profile {company} — siapa tahu ke depan dapat menjadi opsi untuk kebutuhan affiliate {brand}.
"""

COLD_FU2 = """
Selamat {salam}, {nama}. Izin menindaklanjuti kembali.

Agar rekomendasi kami lebih relevan, boleh saya tahu apakah {brand} saat ini memiliki kebutuhan pada salah satu area berikut?

• Affiliate Campaign untuk mendorong penjualan
• Ads Management (TikTok Ads, Shopee Ads, Meta Ads)
• Koneksi dengan Mega Creator atau KOL
• Layanan digital commerce lainnya

Cukup sebutkan yang paling sesuai, nanti saya siapkan penawaran yang spesifik.
"""

COLD_FU3 = """
Selamat {salam}, {nama}.

Kami telah membantu sejumlah brand meningkatkan penjualan melalui Affiliate Campaign yang terukur — mulai dari perekrutan creator, distribusi sample, hingga monitoring performa harian.

Apabila {nama} berkenan, saya dapat mengirimkan studi kasus singkat yang paling mendekati kategori {brand}.
"""

# Still no figure, but the reason has changed. This used to advertise "100
# affiliate creator, minimal 100 video, Rp10.000.000", which was withdrawn on
# 29 Jul 2026 — and reinstated on 18 Aug 2026 as the ONLY package in the new
# deck. So the price is honourable again and the original objection is gone.
# Left out pending BD sign-off on the copy: this is the last rung of the cold
# ladder and the rescue after a rejection, reaching people who already said no,
# and what to lead with there is a sales decision, not a data one.
COLD_FU4 = """
Selamat {salam}, {nama}.

Kami masih membuka kerja sama Campaign Affiliate untuk periode ini, dan cakupannya dapat kami sesuaikan dengan skala serta target {brand}.

Apabila relevan dengan rencana {brand}, saya dapat menyiapkan penawaran beserta estimasi target yang dapat dicapai — cukup kabari saya ya, {nama}.
"""


# ---------------------------------------------------------------------------
# Intent replies — FLOWCHART.md §5.2
# ---------------------------------------------------------------------------

REPLY_SETUJU = """
Terima kasih, {nama}. Saya akan siapkan jadwalnya.

Kami tersedia untuk online meeting Senin–Sabtu, setiap jam antara 09.00–19.00 WIB. Mohon informasikan hari dan jam yang paling nyaman, beserta alamat email untuk kami kirimkan undangan Google Meet-nya ya, {nama}.
"""

CONFIRM_REQUESTED_SLOT = """
Baik, {nama}. {opsi} saya catat ya.

Mohon bantu alamat email-nya untuk kami kirimkan undangan Google Meet-nya.
"""

ASK_EMAIL = """
Baik, {nama}. Boleh dibantu alamat email-nya? Undangan Google Meet akan kami kirimkan ke email tersebut sesuai jadwal yang dipilih.
"""

SLOT_UNAVAILABLE = """
Mohon maaf, {nama}, untuk {jam} jadwal kami sudah terisi.

Slot terdekat yang masih tersedia: {opsi}.

Apakah salah satunya sesuai?
"""

SLOT_OPTIONS = """
Baik, {nama}. Slot terdekat kami yang tersedia: {opsi}.

Mohon informasikan hari dan jam yang paling sesuai, nanti langsung saya kirimkan undangan Google Meet-nya.
"""

PROPOSE_SLOTS = """
Baik, {nama}. Saya siapkan jadwalnya ya.

Kami tersedia Senin–Sabtu, jam 09.00–19.00 WIB. Yang masih kosong terdekat:

{opsi}

Silakan pilih jam yang paling nyaman untuk {nama} — atau sebutkan hari lain, nanti saya cek ketersediaannya. Mohon bantu juga alamat email-nya ya, untuk undangan Google Meet-nya.
"""

PROPOSE_SLOTS_AGAIN = """
Baik, {nama}. Yang masih kosong:

{opsi}

Silakan pilih jam yang paling nyaman ya, {nama}.
"""

REPLY_RESCHEDULE = """
Baik, {nama}. Permintaan perubahan jadwalnya saya terima ya — saya cek dulu ketersediaan slotnya, segera saya konfirmasi jadwal barunya ke {nama}. 🙏
"""

BOOKING_DELAY = """
Baik, {nama}. Jadwal meeting-nya sedang saya siapkan ya — segera saya konfirmasi beserta undangan Google Meet-nya. Terima kasih, {nama}. 🙏
"""

#: BD revision, 30 Jul 2026. The close used to read "Karena brand Kakak masih
#: baru…" — the generator's own inference about the brand, offered back to
#: them as the reason to take a meeting. It is presumptuous when true and
#: wrong when it is not. BD swapped it for a claim about US: we have handled
#: brands like theirs. See the note on `_SITUATIONS["REPLY_TANYA_SISTEM"]`.
REPLY_TANYA_SISTEM = """
Baik, {nama}. Saya jelaskan sedikit ya terkait penawaran kami di campaign affiliate.

Kami akan mencarikan affiliate sesuai kategori dan kebutuhan {brand}, lalu affiliate tersebut membuat video konten promosi produk di TikTok atau Shopee. Kami yang memonitor pengiriman sample, progres pembuatan konten, hingga performa harian campaign seperti view, like, komentar, dan GMV.

Karena kami sudah menangani brand yang serupa dengan {brand}, akan lebih mudah jika kami jelaskan alurnya secara detail lewat meeting online singkat — kira-kira {nama} ada waktu di hari dan jam berapa?
"""

#: BD revision, 31 Jul 2026. Two changes, both BD's wording: the deck pointer
#: is dropped (the brand already has the file; repeating it read as deflecting
#: the price question), and the anchor is now followed by an opening on price
#: plus a question about how many affiliate they need — the volume answer is
#: what decides which paket to steer them to.
REPLY_TANYA_HARGA = """
Baik {nama}, untuk campaign affiliate kami mulai Rp10 juta per campaign — isinya 100 affiliate dan minimal 100 video, dengan durasi kerja 2 bulan. Di atasnya ada paket 200 dan 300 affiliate dengan periode yang lebih panjang ya, {nama} 😊

Kalau boleh tahu, untuk kebutuhan affiliate-nya berapa, {nama}?

Supaya saya bisa siapkan gambaran yang paling sesuai, boleh diinfokan fokus campaign Kakak lebih ke awareness, peningkatan penjualan, atau keduanya? 😊🙏🏼
"""

#: BD revision, 29 Jul 2026. Opens by refusing to promise a GMV number: this
#: is the second price question, and the corpus shows it is usually asked as
#: "berapa naiknya?". The client-GMV range is a fact about our clients, never
#: a forecast for theirs — the distinction is the whole point of the opening
#: sentence, so keep it ahead of the figure.
REPLY_PAKET_DETAIL = """
Baik, {nama}. Untuk pertumbuhan GMV, kami tidak bisa memberikan angka pasti karena hasilnya bergantung pada kategori produk, kesiapan konten, dan respons pasar. Namun sebagai gambaran, rata-rata klien kami saat ini berada di kisaran GMV Rp1–2 miliar per bulan melalui campaign affiliate.

Untuk paketnya:

*100 Affiliate* + minimal 100 video — Rp10.000.000 (durasi campaign 2 bulan)
*200 Affiliate* + minimal 200 video — Rp18.000.000 (durasi campaign 4 bulan)
*300 Affiliate* + minimal 300 video — Rp25.000.000 (durasi campaign 6 bulan)

Selama periode campaign tersebut, seluruh affiliate dimaintain oleh tim kami agar campaign berjalan optimal ya, {nama}.

Yang membedakan kami: creator disaring sesuai kebutuhan brand, status sample dipantau harian hingga diterima creator, dan performa konten (view, like, komentar, GMV) dilaporkan setiap hari. Kami juga membantu penyusunan script dan storyboard bila diperlukan.
"""

#: The brand has passed us upward and not said no — so this waits well,
#: and leaves the other service lines where the team will see them.
REPLY_TERUSKAN_TIM = """
Kami tunggu kabar baiknya ya, Kak 😊

Jika dari tim Kakak berkenan untuk berdiskusi lebih lanjut, saya dengan senang hati bisa bantu aturkan meeting online untuk menjelaskan detail sistem kerja sama serta benefit yang bisa kami berikan.

Sedikit informasi, selain Campaign Affiliate, kami juga memiliki beberapa layanan lainnya yang dapat disesuaikan dengan kebutuhan dan objective brand, di antaranya:

1. Live Streaming di Akun Official Brand
2. Produksi Konten TVC & Video Konten
3. Full Service dengan Garansi ROI
4. Layanan Berbasis AI
5. Ads Management

Kami dapat menyesuaikan layanan yang paling sesuai dengan kebutuhan dan objective brand saat ini, Kak. 🙏🏻
"""

#: "Aku diskusikan dulu dengan team" is the same moment as TERUSKAN_TIM,
#: and the BD team gave both the same revision.
REPLY_PELAJARI_DULU = """
Kami tunggu kabar baiknya ya, Kak 😊

Jika dari tim Kakak berkenan untuk berdiskusi lebih lanjut, saya dengan senang hati bisa bantu aturkan meeting online untuk menjelaskan detail sistem kerja sama serta benefit yang bisa kami berikan.

Sedikit informasi, selain Campaign Affiliate, kami juga memiliki beberapa layanan lainnya yang dapat disesuaikan dengan kebutuhan dan objective brand, di antaranya:

1. Live Streaming di Akun Official Brand
2. Produksi Konten TVC & Video Konten
3. Full Service dengan Garansi ROI
4. Layanan Berbasis AI
5. Ads Management

Kami dapat menyesuaikan layanan yang paling sesuai dengan kebutuhan dan objective brand saat ini, Kak. 🙏🏻
"""

#: "Sore ka, terimakasih atas penawarannya" — polite, but not a no and not a
#: yes. The BD team's answer re-offers the meeting and names the other service
#: lines rather than treating it as a goodbye. Static: they wrote it.
REPLY_TERIMA_KASIH = """
Baik, Kak. Apakah Kakak tertarik dengan service yang kami berikan?

Jika dari tim Kakak berkenan untuk berdiskusi lebih lanjut, saya dengan senang hati bisa bantu aturkan meeting online untuk menjelaskan lebih detail mengenai sistem kerja sama serta benefit yang bisa didapatkan oleh brand.

Sedikit informasi, selain *Campaign Affiliate*, kami juga memiliki beberapa layanan lainnya yang dapat disesuaikan dengan kebutuhan dan objective brand, di antaranya:

1. Live Streaming di Akun Official Brand
2. Produksi Konten TVC & Video Konten
3. Full Service dengan Garansi ROI
4. Layanan Berbasis AI
5. Ads Management

Kami dapat menyesuaikan layanan yang paling sesuai dengan kebutuhan dan objective brand Kakak saat ini. 🙏🏻
"""

REPLY_TOLAK_HALUS = """
Baik, {nama}. Terima kasih atas feedback-nya 🙏🏻

Mungkin aku share beberapa service yang bisa kami provide, di antaranya:

1. Campaign Affiliate
2. Live Streaming di akun official brand
3. Produksi konten TVC & video untuk di-upload di akun official brand
4. Full Service dengan garansi ROI
5. Layanan berbasis AI
6. Service Ads

Jika ke depannya brand Kakak membutuhkan salah satu service tersebut, boleh langsung hubungi kami ya, Kak 😊

Atau jika dari sisi Kakak ada kebutuhan lain yang sedang ingin dikembangkan, kami juga sangat terbuka untuk berdiskusi dan menyesuaikan service yang bisa kami provide sesuai dengan kebutuhan dan objective brand Kakak.
"""

#: BD rewrite, 31 Jul 2026; replaced 13 Aug 2026 with the copy the BD team
#: actually uses. "Belum tertarik" is usually a no to affiliate specifically,
#: not to us — so the close names the other service lines and leaves the door
#: open. Static (kept out of `responder.GENERATIVE_KEYS`): this is a list of
#: product names, and the one thing a generator must not do at the moment a
#: brand says no is improvise an extra service, a scope, or a sweetener.
#: Names only, no pricing — see knowledge.OTHER_SERVICES_NOTE.
REPLY_TOLAK_TEGAS = """
Baik ka, terima kasih atas feedback-nya 🙏

Mungkin aku share beberapa service yang bisa kami berikan:
1. Campaign Affiliate
2. Live streaming di akun official brand
3. Produksi konten TVC & video konten untuk di-upload akun official brand
4. Full service dengan garansi ROI
5. Layanan berbasis AI
6. Service Ads

Jika nanti brand kakak membutuhkan service yang bisa kami provide, boleh langsung hubungi kami ya ka 😊
"""

#: Sent ONCE when a brand number answers with a switchboard or an out-of-hours
#: notice. Leaving the deck and stepping back is the whole point: on 12 Aug
#: 2026 answering an autoresponder conversationally drew eight replies in
#: twelve minutes and cost the account. One card, then silence — the engine
#: enforces the "once" (see Engine._AUTO_REPLY_TAG).
REPLY_AUTORESPONDER = """
Baik ka, terima kasih yaa 🙏🤗

Aku titip file untuk service Campaign Affiliate-nya ya ka. Selain service tersebut, kami juga memiliki beberapa service lainnya yang mungkin bisa membantu kebutuhan brand kakak.

Kalau dari brand kakak tertarik atau ingin mengetahui lebih detail terkait service lainnya, boleh langsung hubungi kami kembali ya ka. Dengan senang hati nanti kami bantu informasikan 😊
"""

#: A brand handing us somebody else's number. Acknowledged in the past tense
#: on purpose — by the time this goes out the number really has been added to
#: the outreach list, so the sentence is true rather than a promise.
#: The brand asks for a proposal by email instead of a meeting. Two things
#: matter: say the proposal is going, and ask for the PIC — an inbox is a
#: Thank them, say the address will be used — and stop there. The follow-up
#: question ("boleh minta kontak PIC-nya?") was dropped on the operator's
#: instruction, 21 Aug 2026: an address is not interest, and Bali Botanica,
#: who had just written "Boleh langsung ke email marketing@… aja ya kak", was
#: answered with three meeting slots and then asked for their email address.
#: Never paired with REPLY_MINTA_CHAT either — once they have named an inbox,
#: "boleh kita bahas lewat chat dulu" answers a question nobody asked.
REPLY_EMAIL_PROPOSAL = """
Baik ka, terima kasih banyak informasinya 🙏🏻

Penawaran dan company profile-nya akan segera kami kirimkan ke email tersebut ya ka 😊
"""

#: "Saya akan hubungkan Kakak dengan tim sales kami." Thank them, then ask for
#: the contact — being promised an introduction is not the same as having one,
#: and the ask is what turns it into a lead.
REPLY_CONNECT_PIC = """
Baik, Kak, terima kasih banyak sudah membantu menghubungkan dengan tim yang tepat 🙏

Kalau boleh, apakah memungkinkan saya mendapatkan kontak PIC yang menangani bidang tersebut, Kak? Supaya dari sisi kami bisa langsung berkomunikasi dengan PIC terkait untuk memberikan penawaran yang lebih sesuai dengan kebutuhan brand Kakak sekaligus berdiskusi lebih lanjut mengenai potensi kerja samanya.

Dengan begitu, kami juga bisa menjelaskan secara langsung mengenai service dan benefit yang dapat kami berikan untuk brand Kakak. 🙏🏻
"""

#: "Produk yang sebelumnya kami miliki sudah tidak diproduksi lagi." Not a
#: rejection — the brand is still there, just doing something else. Asking
#: what keeps the conversation open instead of closing it on a dead product.
REPLY_PRODUK_BERUBAH = """
Baik, Kak. Kalau boleh tahu, saat ini brand Kakak bergerak di bidang apa ya, Kak?

Supaya dari sisi kami bisa memberikan insight yang lebih sesuai terkait penawaran yang saya sampaikan untuk brand Kakak. 🙏🏻
"""

#: A reply too vague to act on — "Iya kak gimna". Re-state the offer in one
#: breath and ask for a time, rather than asking them to repeat themselves.
REPLY_VAGUE_REPITCH = """
Hai Kak, kami ingin menawarkan service Campaign Affiliate beserta beberapa service lainnya yang dapat disesuaikan dengan kebutuhan brand Kakak.

Jika Kakak tertarik, apakah besok kami boleh aturkan meeting online untuk menjelaskan lebih detail mengenai sistem kerja sama serta benefit yang bisa didapatkan oleh brand Kakak?

Kira-kira besok Kakak ada waktu di jam berapa ya? 😊
"""

#: The brand hands us somebody else's number. Thank them and say the contact
#: will be reached — then say nothing else, ever (the engine hands the thread
#: over). Future tense on the operator's instruction, 21 Aug 2026: "sudah kami
#: hubungi" claimed a call that had not happened yet, and the queue it was
#: based on can fail.
REPLY_REFERRAL = """
Baik ka, terima kasih banyak informasinya 🙏🏻

Kontak tersebut akan segera kami hubungi ya ka 😊
"""

REPLY_OPT_OUT = """
Baik, {nama}. Mohon maaf atas ketidaknyamanannya — kami tidak akan menghubungi kembali.

Terima kasih atas waktunya.
"""


REPLY_FREEFORM = """
Baik, {nama}. Terima kasih atas responsnya.

Agar saya dapat membantu dengan tepat, boleh dijelaskan sedikit lebih detail maksud {nama}? Atau bila berkenan, kami dapat menjadwalkan meeting singkat untuk membahasnya langsung.
"""

REPLY_GREETING_NEEDS = """
Halo, {nama} 😊 Terima kasih sudah merespons.

Kami dari {company} ingin menawarkan kerja sama Campaign Affiliate untuk membantu meningkatkan penjualan sekaligus awareness produk {brand}.

Kalau boleh tahu, saat ini kebutuhan {brand} lebih fokus ke mana — peningkatan penjualan, awareness, atau keduanya?
"""


# ---------------------------------------------------------------------------
# Question intents observed across the chat-example exports.
#
# Every hard claim below mirrors knowledge.py (single source of truth); the
# real chats contradict each other on campaign duration (3/4/5 bulan for the
# same package), so none of these state a month count — duration is deferred
# to the proposal/contract.
# ---------------------------------------------------------------------------

#: Names clients since 24 Sep 2026 — "Brand kosmetik apa yg sudah kerja sama
#: dgn kk ya" got the generic "berbagai kategori" and read as having none.
#: Only knowledge.CLIENTS (the deck's list); the case studies and reports
#: by category are shown at the meeting, as the team does.
REPLY_TANYA_PORTOFOLIO = """
Tentu, {nama}. Kami berpengalaman menangani brand di berbagai kategori — termasuk kategori yang serupa dengan {brand}. Beberapa brand yang kami tangani di antaranya {clients}.

Apabila berkenan, kami dapat mempresentasikan company profile beserta studi kasus, contoh konten, dan report performa campaign dari kategori terkait melalui meeting singkat, sekaligus menjawab pertanyaan {nama} secara langsung.
"""

#: "Berapa harga unt LS nya kak?" — live streaming's own price is NOT
#: sayable in chat (knowledge fact sheet: "harga tersendiri untuk live
#: streaming TIDAK boleh disebut"); what may be named is the live that is
#: included in two deck offers, with those offers' figures exactly. So the
#: reply says that, names the two, and takes the standalone price to the
#: meeting — instead of the affiliate anchor it used to get (24 Sep 2026).
#: Figures mirror knowledge.OFFERS; change both together.
REPLY_TANYA_HARGA_LIVE = """
Baik, {nama}. Untuk live streaming yang berdiri sendiri, biayanya kami sesuaikan dengan kebutuhan {brand} (durasi live, talent, dan studio), jadi angkanya belum bisa saya sebutkan di chat ya — lebih tepat kami hitung bersama tim.

Yang sudah tercantum di deck kami adalah live streaming yang termasuk dalam paket:
• *Special Bundle Shopee Ads + Manage Ecommerce* — Rp19.899.000/bulan (minimal kontrak 6 bulan), sudah termasuk free live streaming minimal 30 jam per bulan (studio, talent, dan equipment); budget iklan di luar service.
• *Full Service* — mulai Rp55.000.000, mencakup live streaming 4 jam/hari selama 30 hari beserta affiliate, manage ecommerce, dan konten untuk akun official.

Kalau berkenan, boleh kita bahas skema live yang paling pas untuk {brand} lewat meeting online singkat, {nama}? Kira-kira {nama} ada waktu di hari dan jam berapa?
"""

#: "ada rate card atau company profile?" — the document, attached (WhatsApp
#: only; the Meta transport refuses documents and escalates), then the
#: team's own next question: the need. Nothing about curation here — that
#: was the wrong answer this used to get.
REPLY_MINTA_PROFILE = """
Tentu, {nama} 🙏 Company profile dan penawaran layanan kami saya lampirkan ya.

Supaya rekomendasinya pas, boleh tahu kebutuhannya untuk kategori produk apa, dan kira-kira berapa affiliate yang dibutuhkan, {nama}? Kalau berkenan, kita juga bisa bahas langsung lewat meeting online singkat.
"""

#: "saya dari agency, kita handle beberapa klien yang ada kebutuhan
#: affiliate" — the team's reply in the corpus, near verbatim: welcome it,
#: "kebutuhan berapa affiliate?", "kategori produk apa?", then the meeting.
REPLY_AGENCY_VENDOR = """
Boleh banget, {nama} 🙏 Kami terbuka bekerja sama dengan agency untuk kebutuhan klien-kliennya — skema campaign affiliate-nya bisa kami sesuaikan per brief.

Kalau boleh tahu, klien yang sedang dicarikan affiliate-nya bergerak di kategori produk apa, dan kira-kira kebutuhannya berapa affiliate, {nama}?

Supaya lebih jelas, boleh kita bahas skemanya lewat meeting online singkat? Kira-kira {nama} ada waktu di hari dan jam berapa?
"""

#: "Kalau udh 4 bulan itu vt nya bakal di privasi atau gimana?" — BD's own
#: answer (knowledge.CONTENT_AFTER_CONTRACT): the videos stay, as long as the
#: product link is not taken down. Static: it is a statement about what
#: happens after the contract, and the one thing a generator would add is
#: a promise about how well they keep performing.
REPLY_TANYA_VIDEO_SETELAH_KONTRAK = """
Tidak, {nama} 😊 Seluruh video affiliate yang sudah tayang selama campaign tetap tayang dan tetap bekerja setelah periode kontrak selesai — tidak diprivat dan tidak kami hapus.

Satu catatannya: link produk (SKU) yang ditautkan affiliate jangan sampai di-takedown di seller center ya, {nama}, supaya video-videonya tetap bisa mengarah ke produk {brand}.
"""

REPLY_TANYA_LOKASI = """
Kantor kami berada di Ruko Mall Seasons City Blok B No. 10, Tambora, Jakarta Barat (area Grogol), {nama}.

{nama} dipersilakan berkunjung — beberapa brand yang kami handle juga menjalankan live streaming dari studio kami, jadi bisa melihat langsung operasional kami. Seluruh kerja sama juga selalu diawali kontrak resmi sebelum pembayaran apa pun, jadi {nama} tidak perlu khawatir.
"""

#: BD revision, 29 Jul 2026: the MCN cut now opens at a stated 10% instead of
#: "dapat dinegosiasikan" with no number. Still an opening, not a final rate —
#: NEGO_HARGA escalates the actual negotiation to a human. 10% is the only
#: percentage anywhere in the bank; see knowledge.ALLOWED_PERCENTS.
REPLY_TANYA_KOMISI = """
Baik, {nama}, saya jelaskan skemanya.

Untuk komisi affiliate, besarannya mengikuti open plan yang ditetapkan brand. Sementara komisi ke MCNASIA dibuka di 10%, dan sifatnya masih bisa dinegosiasikan.

Settlement kedua komisi ini berjalan otomatis melalui sistem TikTok Affiliate Partner dan hanya berlaku bila affiliate benar-benar menghasilkan penjualan — tanpa penjualan, tidak ada komisi.
"""

#: Deliberately NOT in `responder.GENERATIVE_KEYS`. Every other answer may be
#: reworded, but this one is a commercial no, and during the 29 Jul pilot the
#: generator gave one tester two different answers to it four minutes apart —
#: once correctly ("belum tersedia opsi komisi saja"), once by explaining
#: commission rates and never addressing the question. A brand that reads the
#: wrong one plans around a fee that is not on offer.
#:
#: The three-point reason is BD's own wording (Alfath, 29 Jul 2026), condensed
#: from a page of chat to something that reads on a phone. Mirrors
#: knowledge.COMMISSION_ONLY_REASON — change both together.
REPLY_TANYA_KOMISI_ONLY = """
Terima kasih atas usulannya, {nama} 🙏 Untuk saat ini kami belum bisa menjalankan skema komisi saja tanpa basic rate di awal, karena ada tahapan yang tetap memakan effort tim sebelum penjualan pertama muncul:

1. *Filtering affiliate* — screening performa (GMV, konversi, engagement), kesesuaian niche, dan kualitas traffic, agar yang terpilih memang berpotensi menghasilkan penjualan.
2. *Seeding & outreach* — negosiasi dan follow up sampai affiliate siap posting. Kami mengurasi dan menjaga relasi, bukan sekadar blast.
3. *Monitoring & optimization* — monitoring harian, scale yang perform dan cut yang tidak, serta koordinasi konten dan timing posting.

Yang masih dapat dinegosiasikan adalah besaran komisi ke MCN, sesuai skala campaign {brand} — komisi untuk affiliate sendiri tetap ditentukan brand.

Kalau berkenan, saya bantu carikan paket yang paling pas dengan budget {brand} ya, {nama}.
"""

#: BD's own wording (Alfath, 29 Jul 2026). Deliberately NOT in
#: `responder.GENERATIVE_KEYS`: this is a service line the fact sheet barely
#: covers and there is no grounding for it in the chat corpus, so a generated
#: version would be inventing. Add it once the corpus has real ads exchanges.
#:
#: Rewritten 18 Aug 2026. The old copy apologised that Meta was "belum
#: tercakup di file ini" and named no price, both of which the new deck
#: contradicts: page 2 lists Meta CPAS and all five figures. Prices are now
#: stated here rather than deferred, because the brand is reading them off the
#: attachment either way and a bot that will not confirm its own deck reads as
#: evasive. What still defers to a meeting is scope, targets and guarantees.
#:
#: "Di luar budget iklan" is not optional garnish — the deck stamps it on
#: every card, and a brand that misses it budgets Rp5 juta for a month of
#: TikTok Ads and expects the media spend to come out of that.
#: --- comments: the one place the bot speaks in public ----------------------
#:
#: The BD team's own rule, from the CRM analysis: "Jangan jelaskan panjang di
#: komentar." A long answer under a post gives the pitch away to everyone
#: scrolling past, including competitors, and kills the DM that is the actual
#: goal — the commenter has no reason to write once they have been answered.
#:
#: So this is deliberately almost empty of information. It says we replied,
#: names nothing, prices nothing, and points at the inbox. Everything the
#: brand asked for is in COMMENT_DM_OPENER, which arrives privately.
#:
#: It is also the only text in this file that strangers read without having
#: messaged us, so it carries no {nama}: a comment's display name is public
#: and using it reads as being watched, not served.
#: Wording aligned 24 Sep 2026 to the BD team's own comment script in the
#: CRM PDF ("Halo Kak, siap, detailnya kami kirim melalui DM ya Kak"). The
#: PDF's version goes on to ask for the brand in public; that ask lives in
#: the DM opener instead, so nothing about the commenter's business is
#: solicited where everyone can read it.
REPLY_KOMENTAR_PUBLIK = """
Halo Kak, siap 😊 Detailnya sudah kami kirim lewat DM ya, Kak 🙏
"""

#: What actually answers them, in private. Opens by naming the comment so it
#: does not read as an unprompted sales DM — which is what a cold DM from a
#: business account looks like, and the reason people report them.
COMMENT_DM_OPENER = """
Halo Kak 😊 Terima kasih sudah komen di postingan kami ya.

Perkenalkan, saya dari *MCNAsia.biz* — Official Partner TikTok & Shopee. Kami bantu brand menjalankan campaign affiliate, live streaming, ads, sampai produksi konten.

Supaya saya bisa bantu dengan tepat, boleh diinfokan:
1. Nama brand
2. Posisi Kakak di brand
3. Link toko (TikTok/Shopee)
4. Produk yang ingin difokuskan

Nanti saya siapkan penjelasan yang paling sesuai dengan kebutuhan Kakak ya 🙏
"""

REPLY_TANYA_ADS = """
Berikut file service kami ya, {nama} — untuk Ads Management, paketnya:

1. *TikTok Ads* — Rp5.000.000/bulan
2. *Shopee Ads* — Rp5.000.000/bulan
3. *Meta Ads (CPAS)* — Rp13.000.000/bulan
4. *Paket Hemat* (TikTok + Shopee Ads) — Rp8.000.000/bulan
5. *Paket Cuan* (TikTok + Shopee + Meta CPAS) — Rp15.000.000/bulan
6. *Special Bundle* (Shopee Ads + Manage Ecommerce) — Rp19.899.000/bulan, minimal kontrak 6 bulan, sudah termasuk free live streaming minimal 30 jam per bulan (studio, talent, dan equipment)

Seluruh harga di atas di luar budget iklan ya, {nama}, dan dihitung per bulan.

Apabila {nama} ada waktu, saya bisa jelaskan cakupan kerjanya melalui meeting online singkat, sekaligus menyesuaikan dengan kebutuhan {brand}.
"""

#: BD's own answer, 30 Jul 2026 — the source is TikTok Affiliate Partner.
#:
#: Deliberately NOT in `responder.GENERATIVE_KEYS`. This one sentence is a
#: compliance statement, and the generator has already proved it will invent
#: one: on 30 Jul it told a tester "dari data publik terkait informasi
#: bisnis", which nobody had authorised. Mirrors knowledge.CONTACT_SOURCE —
#: change both together, and the guard in responder.py with them.
#:
#: The closing opt-out is not in BD's draft. It is kept because the question
#: is a privacy question, and a brand who asks it should not have to work out
#: how to be left alone. Drop it if BD would rather it went.
REPLY_TANYA_SUMBER_KONTAK = """
Kami mendapatkan kontak {nama} melalui TikTok Affiliate Partner ya, {nama}. Kebetulan MCNASIA merupakan Official Partner TikTok & Shopee yang membantu brand dalam meningkatkan penjualan maupun brand awareness melalui berbagai strategi digital.

Kalau {nama} berkenan dan ada waktu, boleh banget kita jadwalkan meeting online sebentar. Nanti saya jelaskan lebih detail mengenai layanan kami dan strategi yang bisa kami tawarkan untuk {brand} 🙏

Apabila {nama} tidak berkenan dihubungi, cukup sampaikan kepada saya — kontak {nama} akan kami hapus dari daftar.
"""

#: "apakah ada target penjualan?" — the answer is no, and it has to be said
#: plainly before anything encouraging follows.
#:
#: Static, and NOT in `responder.GUARANTEE_KEYS`: the words the validator
#: bans ("garansi", "dijamin") are exactly the ones a generator would reach
#: for here. What we do commit to is effort and volume — never an outcome.
#: The client GMV range stays out of this answer entirely; quoted against
#: "what will I get", an illustration reads as a forecast.
#:
#: BD rewrite, 31 Jul 2026 (knowledge.GMV_GUARANTEE + knowledge.RAMP_UP). Two
#: additions: the refusal now names what we DO guarantee — affiliate account
#: quality and the running of the campaign — so a "no" is not the whole
#: answer; and the ramp-up is stated up front, because a brand not told that
#: month one is usually quiet reads a slow month one as the campaign failing.
REPLY_TANYA_TARGET = """
Terima kasih pertanyaannya, {nama} — ini penting supaya ekspektasinya sama sejak awal.

Untuk jaminan GMV, kami tidak bisa memberikan garansi angka tertentu ya, {nama}, karena hasil penjualan dipengaruhi beberapa faktor seperti harga produk, kualitas produk, daya saing di marketplace, promo yang berjalan, serta respons market terhadap produk tersebut.

Namun yang bisa kami pastikan adalah dari sisi kualitas akun affiliate-nya. Tim kami fokus pada peningkatan exposure produk, optimalisasi performa affiliate, serta memastikan campaign berjalan sesuai rencana.

Perlu kami sampaikan juga, campaign affiliate ini sifatnya jangka panjang, jadi di bulan pertama biasanya penjualan belum langsung signifikan — konten butuh waktu untuk tersebar dan terbaca algoritma, audience mulai trust dengan produk, dan performa video affiliate (views dan conversion) naik bertahap. Ada juga brand yang sudah terlihat hasilnya sejak awal, biasanya karena didukung promo atau push dari sisi brand.

Kalau Kakak berkenan, boleh kita jadwalkan meeting online singkat — di sana saya jelaskan lebih detail strategi yang bisa diterapkan untuk {brand} beserta histori campaign brand yang sudah kami handle. 🙏
"""

#: What gets measured, added 31 Jul 2026 from BD's own answer. Static for the
#: same reason as REPLY_TANYA_TARGET: the honest answer contains a "no" on GMV,
#: and a generator asked for a KPI list will fill the gap with numbers.
#:
#: The order is BD's and it matters — what we measure first, then the two
#: things the brand actually keeps (curated creators and owned content), then
#: the GMV caveat, and only then what we need from their side. Leading with
#: the caveat reads as excuse-making before anything has been offered.
REPLY_TANYA_KPI = """
Baik, {nama}. Untuk KPI campaign ini, fokus utama kami ada pada kualitas affiliate yang bergabung, karena campaign affiliate merupakan strategi jangka panjang. Selain itu, konten yang dibuat affiliate juga menjadi aset (owned content) yang bisa {brand} manfaatkan untuk kebutuhan marketing ke depannya.

Creator affiliate yang kami sediakan disesuaikan dengan kategori produk dan positioning {brand}, dan performanya — view, like, komentar, hingga GMV — kami monitor serta laporkan harian.

Perlu kami sampaikan juga bahwa kami memang tidak dapat memberikan jaminan angka GMV, karena pertumbuhannya bertahap dan membutuhkan optimasi berkelanjutan. Keberhasilan campaign juga memerlukan dukungan dari sisi brand, seperti mengaktifkan fitur GMV Max, menjaga ketersediaan stok, harga yang kompetitif, promo yang menarik, serta operasional toko yang berjalan baik.

Kolaborasi antara tim kami, affiliate, dan {brand} inilah yang membuka peluang hasil paling optimal ya, {nama}. 🙏
"""

#: A brand ruling itself out on size. The one thing this must not do is invent
#: a smaller tier: `knowledge.PROMO` is None and the 100 is the FLOOR of the
#: ladder, not a lone package — the deck of 18 Sep 2026 adds a 200 and a 300
#: above it, and nothing below. Saying so plainly beats implying something
#: cheaper might exist.
REPLY_BRAND_KECIL = """
Justru tidak masalah, {nama} 🙏 Kami terbiasa menangani brand yang sedang membangun awareness, bukan hanya brand besar — affiliate-nya kami kurasi menyesuaikan kategori dan positioning {brand}, jadi pendekatannya memang berbeda-beda.

Paket kami mulai dari *100 Affiliate* + minimal 100 video di Rp10.000.000 dengan durasi 2 bulan, dan belum ada paket khusus di bawah itu ya, {nama} — supaya saya tidak memberi gambaran yang keliru.

Kalau berkenan, boleh kita bahas dulu kebutuhan dan target {brand} lewat meeting online singkat, supaya sama-sama tahu apakah kerja sama ini memang pas untuk tahap {brand} sekarang.
"""

#: Withdrawn tiers a brand may still be holding. The 150 has been gone since
#: 29 Jul 2026 and stays gone. The 300 and 500 were dropped on 18 Aug 2026 and
#: are BACK on the 18 Sep deck — the 300 as a tier (Rp25jt / 6 bulan, not the
#: old 4), the 500 as a special bundle — so this template no longer speaks for
#: them; it answers the 150 and anything else nobody sells.
#: Old decks and ad creatives circulate for months, so correct it explicitly —
#: answering with today's package alone leaves the brand thinking theirs
#: still exists. Deliberately does not name which tier they asked about, so
#: the one template covers all three.
REPLY_TANYA_PAKET_LAMA = """
Terima kasih, {nama}. Mohon maaf, paket tersebut sudah tidak tersedia di penawaran kami saat ini ya — kemungkinan {nama} melihatnya dari materi kami yang lama.

Paket yang berjalan sekarang:

*100 Affiliate* + minimal 100 video — Rp10.000.000 (durasi campaign 2 bulan)
*200 Affiliate* + minimal 200 video — Rp18.000.000 (durasi campaign 4 bulan)
*300 Affiliate* + minimal 300 video — Rp25.000.000 (durasi campaign 6 bulan)

Kalau berkenan, saya bantu jelaskan cakupannya dan lihat apakah sudah pas dengan kebutuhan {brand} ya, {nama}.
"""

#: Logistics of the meeting, not a request for one. The reassurance that they
#: need not bring a decision-maker is the point: the corpus shows brands
#: stalling on exactly this ("jika atasan saya berhalangan hadir…").
#: The hours were added 24 Sep 2026: "Untuk waktunya di jam kerja atau
#: bukan?" is in the inbound corpus, and the team answered "jam kerja kak"
#: plus the slot question — the same two things this already ends with.
REPLY_TANYA_MEETING_DETAIL = """
Dari sisi kami biasanya saya dan rekan dari tim Business Development yang bergabung, {nama} — meeting-nya via Google Meet supaya bisa sekalian share screen materinya. Kami tersedia di jam kerja, Senin–Sabtu antara 09.00–19.00 WIB.

Dari sisi {brand} bebas, {nama}. Tidak harus lengkap dan tidak harus ada pengambil keputusan — kalau {nama} dulu yang ikut untuk mendengarkan juga tidak masalah, nanti materinya kami kirimkan supaya bisa diteruskan ke tim.

Kira-kira hari dan jam berapa yang paling nyaman untuk {nama}?
"""

# ---------------------------------------------------------------------------
# Facts BD supplied 30 Jul 2026. Every one of these questions used to be
# answered with something unrelated, or improvised by the generator.
#
# All static, none in `responder.GENERATIVE_KEYS`: these are contractual and
# legal statements where a reworded version is a different promise.
# ---------------------------------------------------------------------------

REPLY_TANYA_LEGALITAS = """
Tentu, {nama}. MCNASIA beroperasi di bawah badan hukum *PT. MULTI BISNIS ASIA*, dengan legalitas perusahaan yang lengkap — termasuk Akta Pendirian dan NPWP Perusahaan.

Dokumen legalitasnya bisa kami lampirkan saat pembahasan kontrak ya, {nama}. Kantor kami juga terbuka untuk dikunjungi apabila {nama} ingin melihat operasionalnya langsung.
"""

#: Says where the answer lives (the contract) without inventing terms. Refund
#: percentages and notice periods are exactly what a generator would fill in.
REPLY_TANYA_REFUND = """
Baik, {nama}. Apabila kerja sama dihentikan di tengah periode, proses pertanggungjawaban, penghentian layanan, maupun ketentuan refund akan mengikuti klausul yang disepakati dalam kontrak kerja sama.

Karena itu seluruh ketentuannya kami tuangkan lebih dulu di kontrak, sebelum ada pembayaran apa pun — jadi {nama} bisa mereview poin ini bersama tim {nama} terlebih dahulu. Kalau ada klausul yang ingin disesuaikan, kami terbuka untuk mendiskusikannya.
"""

REPLY_TANYA_HAK_KONTEN = """
Baik, {nama}. Hak cipta konten mengikuti ketentuan yang tercantum dalam perjanjian kerja sama.

Secara umum, {brand} berhak menggunakan konten yang dihasilkan untuk kebutuhan pemasaran, sesuai ruang lingkup penggunaan yang disepakati dalam kontrak. Detail ruang lingkupnya kami bahas bersama saat penyusunan kontrak ya, {nama}, supaya sesuai dengan rencana pemakaian {brand}.
"""

#: Answers honestly that we do work with competitors — and explains the
#: separation, rather than implying an exclusivity we do not offer.
REPLY_TANYA_EKSKLUSIVITAS = """
Terima kasih pertanyaannya, {nama} — ini wajar ditanyakan.

Secara umum kami memang dapat menangani beberapa brand dalam kategori yang sama tanpa menimbulkan konflik operasional. Setiap brand dikelola oleh tim yang berbeda, dengan strategi, target KPI, dan workflow yang terpisah. Informasi maupun data yang bersifat rahasia tidak kami bagikan antar brand.

Yang justru menjadi nilai tambah: insight dan performa dari campaign yang kami jalankan menjadi bahan evaluasi dan optimasi, sehingga pendekatan untuk {brand} disusun berdasarkan data dan pengalaman implementasi.
"""

#: Confirms the mechanism, withholds the account NUMBER. Payment happens after
#: contract and invoice (knowledge.PAYMENT_TERMS), and a bot that hands account
#: numbers to whoever asks trains brands to accept them over WhatsApp — the
#: habit payment-fraud impersonation depends on. The number lives in
#: knowledge.PAYMENT_ACCOUNT_NUMBER if BD decides it should go out here.
REPLY_TANYA_REKENING = """
Baik, {nama}. Pembayaran dilakukan melalui transfer ke rekening perusahaan atas nama *PT. MULTI BISNIS ASIA* (Bank Mandiri) — jadi bukan ke rekening pribadi.

Nomor rekeningnya kami cantumkan pada invoice resmi yang diterbitkan setelah kontrak kerja sama ditandatangani, supaya {nama} menerimanya dari dokumen resmi kami. Mohon berhati-hati apabila ada pihak yang mengatasnamakan kami dan meminta transfer ke rekening di luar itu ya, {nama} 🙏
"""

REPLY_TANYA_KATEGORI_PRODUK = """
Baik, {nama}. Kami menerima produk yang sesuai dengan kebijakan platform — TikTok Shop, Shopee, dan marketplace terkait — serta peraturan perundang-undangan yang berlaku di Indonesia.

Untuk produk yang memerlukan izin khusus, persyaratan legalnya perlu dipenuhi terlebih dahulu sebelum campaign dijalankan. Kalau {nama} sampaikan produk {brand} secara spesifik, saya bantu cek kesesuaiannya dengan tim kami ya.
"""

#: No number anywhere on purpose — BD sets no minimum, and "berapa pcs?" is
#: exactly the question a generator would answer with an invented figure.
#: The sold-out hold is the reassurance that makes the ask land.
REPLY_TANYA_STOK = """
Untuk stok, sebaiknya memang dipersiapkan secara matang dari sisi brand ya, {nama}. Minimalnya, {brand} menyediakan stok sample yang akan diberikan kepada para affiliate.

Hal ini karena campaign affiliate umumnya memberikan dampak yang cukup besar terhadap peningkatan penjualan, sehingga kesiapan stok produk perlu menjadi perhatian agar campaign dapat berjalan optimal.

Namun {nama} tidak perlu khawatir. Apabila di tengah campaign stok produk mengalami sold out, kami dapat membantu dengan melakukan hold campaign sementara hingga stok kembali tersedia 😊
"""

REPLY_TANYA_JANGKAUAN = """
Bisa, {nama}. MCNASIA melayani brand di seluruh wilayah Indonesia.

Seluruh proses kerja samanya dapat dilakukan secara online — mulai dari konsultasi, onboarding, perencanaan campaign, distribusi affiliate, monitoring performa, hingga pelaporan berkala. Jadi lokasi {brand} tidak menjadi kendala.

Untuk kebutuhan tertentu, kami juga dapat melakukan meeting atau kunjungan secara langsung ya, {nama}.
"""

REPLY_TANYA_PEMBAYARAN = """
Baik, {nama}. Biayanya dihitung per campaign, bukan tagihan bulanan berulang. Pembayaran dilakukan satu kali di awal — setelah kontrak kerja sama ditandatangani dan invoice kami terbitkan. Seluruh komitmen campaign tertuang dalam kontrak terlebih dahulu, sehingga {nama} dapat mereview semuanya sebelum pembayaran apa pun.

Durasi campaign-nya mengikuti paket: 100 Affiliate 2 bulan, 200 Affiliate 4 bulan, dan 300 Affiliate 6 bulan — selama periode tersebut kami yang me-maintain affiliate-nya ya, {nama}.
"""

REPLY_TANYA_AFFILIATE = """
Baik, {nama}. Affiliate yang kami libatkan dikurasi berdasarkan kategori produk, positioning brand, dan histori penjualan (GMV) 28 hari terakhir, dengan kategori akun affiliate nano dan micro — jadi bukan sekadar jumlah follower.

Jumlah video yang tercantum di paket adalah angka minimal (satu video per affiliate); pada praktiknya banyak affiliate membuat lebih dari satu. Untuk list affiliate secara detail, baru kami bagikan setelah kita deal bekerja sama dan diskusi terkait kriteria {brand}, agar hasil kurasinya lebih sesuai.
"""

REPLY_TANYA_SAMPLE = """
Baik, {nama}. Dari sisi brand cukup menyiapkan stok produk dan pengiriman sample — satu produk per affiliate sudah cukup. Proses lainnya kami yang handle: kurasi, distribusi, follow up, hingga monitoring harian.

Kami juga memberikan garansi: apabila affiliate yang sudah menerima sample tidak membuat video sesuai kesepakatan, biaya sample kami ganti dan kami carikan affiliate pengganti tanpa biaya tambahan.
"""

REPLY_TANYA_TIMELINE = """
Baik, {nama}. Alurnya: kontrak ditandatangani → invoice terbit → pembayaran → persiapan campaign 7–14 hari (kurasi affiliate, koordinasi sample, penyusunan brief) → campaign berjalan dengan monitoring harian.

Progress dapat dipantau melalui spreadsheet monitoring yang kami bagikan, dan di akhir periode kami sertakan report evaluasi.
"""

REPLY_SAPAAN = """
Selamat {salam}, {nama} 😊

Ada yang bisa saya bantu terkait rencana kerja sama Campaign Affiliate untuk {brand}?
"""

REPLY_TANYA_CUSTOM_AGAIN = """
Untuk yang itu juga bisa, {nama} — hanya saja angkanya perlu kami hitung dulu bersama tim, supaya tidak meleset.

Kalau berkenan, kami bahas sekalian di meeting ya, {nama}. Kira-kira {nama} lebih nyaman hari apa dan jam berapa?
"""

REPLY_TANYA_CUSTOM = """
Bisa, {nama} 🙏 Penyesuaian seperti itu memang memungkinkan.

Untuk kebutuhan volume besar, kami punya *Paket Custom Eksklusif* mulai Rp50.000.000 — isinya menyesuaikan kebutuhan brand, minimal 500 akun affiliate, dengan laporan detail beserta action plan dan free konsultasi selama periode kontrak.

Hanya saja detailnya — cakupan, jumlah affiliate, dan skemanya — perlu kami bahas langsung bersama tim, supaya yang kami tawarkan benar-benar sesuai kebutuhan {brand} dan tidak salah hitung.

Boleh kita atur meeting online singkat untuk membahasnya, {nama}?
"""

#: Still answers in chat (the 29 Jul 2026 pilot decision: pushing the
#: meeting at someone who just asked not to is what produced "ko langsung
#: ngajak meeting sih"). What changed on 24 Sep 2026 is the way the door is
#: left open — the team's own framing from inbound/: chat has its limits
#: ("beberapa poin cukup terbatas… khawatir miskom"), and the meeting "tidak
#: mengharuskan langsung deal". No slot ask, no OFFER_MEETING stacked.
REPLY_MINTA_CHAT = """
Tentu, {nama}, boleh kita bahas lewat chat dulu 🙏

Singkatnya: kami menyediakan creator affiliate yang dikurasi sesuai kategori dan positioning {brand}, mengurus pengiriman sample dan pembuatan konten di TikTok maupun Shopee, lalu memantau performanya harian sampai GMV.

Silakan tanyakan apa pun di sini ya, {nama}. Sebenarnya lewat chat ada beberapa poin yang cukup terbatas untuk kami jelaskan — kalau nanti dirasa lebih enak dibahas langsung, meeting online singkatnya tetap bisa kami siapkan kapan pun {nama} siap, dan tidak mengharuskan langsung deal ya 😊
"""

REPLY_TANYA_KECOCOKAN = """
Bisa, {nama}. Model campaign affiliate kami tidak terbatas pada satu kategori — sistem kurasinya menyesuaikan creator dengan kategori produk dan positioning brand, jadi pendekatannya kami sesuaikan dengan {brand}.

Sebagai gambaran, brand yang kami tangani mencakup kategori F&B, Beauty, Mom & Kids, Home Living, Fashion, dan Health.

Agar bisa kami pastikan pendekatan yang paling sesuai untuk {brand}, boleh kita atur meeting online singkat ya, {nama}?
"""

REPLY_TANYA_LIVE = """
Betul, {nama}. Selain affiliate, kami juga menjalankan live streaming — beberapa brand yang kami handle live langsung dari studio kami, dan affiliate yang membantu live tetap masuk dalam program yang sama.

Untuk detail paket live-nya, lebih enak kami jelaskan langsung ya. Boleh kami jadwalkan online meeting singkat?
"""

REPLY_TUNGGU = """
Baik, {nama}, saya standby ya 🙏
"""

RESEND_LINK = """
Baik, {nama}. Berikut link meeting kita ya:

🔗 {link}

Sampai bertemu di sana 🙏
"""

REPLY_NEGO_HARGA = """
Baik, {nama}. Untuk harga paketnya sudah nett ya, {nama} — 100 Affiliate di Rp10.000.000, 200 Affiliate di Rp18.000.000, dan 300 Affiliate di Rp25.000.000.

Namun, untuk komisi ke MCNASIA masih bisa didiskusikan lebih lanjut. Jika {nama} berkenan, boleh share angka yang diharapkan dari sisi brand, nanti akan saya sampaikan ke manajemen kami untuk dipertimbangkan ya, {nama} 🙏
"""

#: Answers a counter-offer by name: the brand said a number, so the reply says
#: it back. `{angka}` is filled from their own message (intents.offered_percent)
#: — never from the model, which is why this is static and not in
#: `responder.GENERATIVE_KEYS`. Deliberately promises nothing: management
#: rules on the figure, and flow.py escalates so a human actually does.
REPLY_NEGO_KOMISI = """
Baik, {nama}. Untuk komisi MCNasia sebesar {angka}, akan saya coba sampaikan terlebih dahulu kepada manajemen kami ya, {nama}.

Selain itu, apabila memungkinkan, apakah saya boleh mengatur jadwal meeting online dengan {nama}? Melalui meeting tersebut kami dapat menjelaskan lebih detail mengenai sistem kerja sama MCNasia — termasuk benefit yang didapatkan {brand} dengan adanya service fee serta komisi yang diberikan kepada MCNasia — sehingga {nama} mendapat gambaran yang lebih jelas mengenai value dan strategi kami untuk meningkatkan performa campaign affiliate.
"""

REPLY_MINTA_KONTRAK = """
Tentu, {nama}. Tim legal kami akan menyiapkan draft kontrak kerja sama untuk direview tim {nama} terlebih dahulu — tidak ada pembayaran apa pun sebelum kontrak disepakati bersama.

Apabila ada poin yang ingin disesuaikan, kami terbuka untuk mendiskusikannya. Draft-nya segera kami kirimkan ya, {nama}.
"""

REPLY_MINTA_TELEPON = """
Terima kasih, {nama}. Sesuai SOP kami, diskusi detail dilakukan melalui Google Meet agar tim dan manajemen kami dapat bergabung sekaligus share screen materi penawarannya.

Boleh diinformasikan hari dan jam yang paling sesuai (Senin–Sabtu, 09.00–19.00 WIB), beserta alamat email untuk kami kirimkan undangannya, {nama}?
"""


# ---------------------------------------------------------------------------
# The closing gadget — FLOWCHART.md §3.1
# ---------------------------------------------------------------------------

OFFER_MEETING = """
Agar pembahasannya lebih spesifik, apabila {nama} berkenan kami dapat menjelaskan detailnya melalui meeting singkat, sekaligus menjawab hal-hal yang ingin ditanyakan sesuai kebutuhan {brand}.

Apakah {nama} bersedia kami jadwalkan?
"""


# ---------------------------------------------------------------------------
# Warm stall — FLOWCHART.md §2.3
# ---------------------------------------------------------------------------

WARM_D2 = """
Selamat {salam}, {nama}. Izin menindaklanjuti pembahasan kita sebelumnya.

Apabila berkenan, kami dapat menjadwalkan meeting singkat untuk membantu menganalisis peluang dan menyusun strategi yang sesuai untuk {brand}. Kami juga terbuka menyesuaikan paket maupun budget agar lebih pas dengan kebutuhan.

Boleh saya mendapatkan tanggapan {nama} hari ini?
"""

WARM_D5 = """
Selamat {salam}, {nama}.

Apakah sudah ada kesempatan untuk mendiskusikan penawaran kami dengan tim? Bila masih dalam proses review, tidak masalah — saya hanya ingin memastikan materinya sudah diterima dengan baik.

Apabila diperlukan, saya dapat menyesuaikan rekomendasi paket sesuai target {brand}.
"""


# ---------------------------------------------------------------------------
# Menunda meeting — FLOWCHART.md §2.4
# ---------------------------------------------------------------------------

MENUNDA_H1 = """
Selamat {salam}, {nama}. Izin menindaklanjuti rencana meeting kita.

Apabila {nama} sudah memiliki gambaran waktu yang sesuai, saya siap menyiapkan jadwalnya.
"""

MENUNDA_H3 = """
Selamat {salam}, {nama}.

Saya izin menindaklanjuti sekali lagi terkait rencana diskusi kita. Bila waktunya belum memungkinkan, mohon informasikan saja — kami dapat menyesuaikan.
"""


# ---------------------------------------------------------------------------
# Scheduling + meeting — FLOWCHART.md §3.3
# ---------------------------------------------------------------------------

SCHEDULE_CONFIRM = """
Baik, {nama}. Jadwal meeting kita sudah saya konfirmasi:

🗓️ {tanggal}
🕐 {waktu} WIB
🔗 {link}

Undangan Google Calendar juga sudah kami kirimkan ke {email}. Sampai bertemu, {nama}.
"""

REMINDER = """
Halo, {nama}. Izin mengingatkan, kita ada jadwal meeting hari ini pukul {waktu} WIB ya.

🔗 {link}

Tim kami akan standby di room sesuai jadwal. Sampai bertemu, {nama}.
"""

NOSHOW_FU1 = """
Selamat {salam}, {nama}. Sepertinya kita belum sempat terhubung pada jadwal tadi.

Tidak masalah bila ada agenda mendadak. Apabila berkenan, saya dapat menjadwalkan ulang di waktu yang lebih sesuai.
"""

NOSHOW_FU2 = """
Selamat {salam}, {nama}.

Izin menindaklanjuti sekali lagi terkait penjadwalan ulang meeting kita. Bila {nama} masih berminat, cukup informasikan waktu yang sesuai dan saya siapkan kembali undangannya.
"""

MEETING_DONE = """
Terima kasih atas waktunya hari ini, {nama}. Senang bisa berdiskusi.

Untuk tindak lanjut pembahasan kita, tim kami akan segera menghubungi {nama} kembali. Apabila sementara itu ada yang ingin ditanyakan, silakan langsung saja ya, {nama}.
"""


# ---------------------------------------------------------------------------
# Handover — fills gap FLOWCHART.md §6.2 / §6.3
# ---------------------------------------------------------------------------

#: BD revision, 30 Jul 2026: now closes the loop. The old wording said the
#: question would be "diteruskan" and left it there, which reads as a brush-off
#: — the brand is not told anyone will actually come back to them.
HANDOVER = """
Terima kasih atas waktunya, {nama}.

Agar penjelasannya bisa lebih detail dan sesuai, pertanyaan {nama} akan saya teruskan ke tim Business Development untuk ditindaklanjuti. Nanti tim kami akan menghubungi {nama} secara langsung untuk memberikan penjelasan lebih lanjut 🤗🙏
"""


# ---------------------------------------------------------------------------
# Public renderers
# ---------------------------------------------------------------------------

def render(
    name: str, convo: Conversation, cfg: Settings, now: datetime | None = None, **extra: str
) -> Message:
    """Render a template by module-level constant name."""
    body = globals()[name]
    ctx = _ctx(convo, cfg, now) | extra
    text = body.strip().format(**ctx)
    return Message(
        text=text,
        attach_company_profile=name in _WITH_PROFILE,
        attach_opening=name in _WITH_OPENING,
        attach_case_study=name in _WITH_CASE_STUDY,
        attach_ads_deck=name in _WITH_ADS_DECK,
        key=name,
    )


#: The ads answer ships the ads deck — a different product from the affiliate
#: campaign, so the affiliate deck would be the wrong file.
_WITH_ADS_DECK = frozenset({"REPLY_TANYA_ADS"})


#: The greeting ships everything in `opening/`, whatever that happens to be.
#: The real chats opened with an intro image and the deck; the image was
#: retired on 19 Aug 2026, so the blast is now text + the deck alone. The
#: image-first ordering in `Engine._opening_files` is deliberately kept — it
#: costs nothing and is what makes dropping an image back in Just Work.
_WITH_OPENING = frozenset({"BLASTING"})

#: Templates that ship the company-profile PDF alongside the text.
#: FLOWCHART.md §5.4 — used on first cold follow-up and on every rejection.
_WITH_PROFILE = frozenset(
    {
        # Asked for it, or being told what we do — the moments a brand
        # actually wants a document open in front of them.
        "REPLY_TANYA_PORTOFOLIO",
        "REPLY_MINTA_CHAT",
        # "ada rate card atau company profile?" — they asked for the file.
        "REPLY_MINTA_PROFILE",
        # A parting reference on a firm no, so the file is there if they come
        # back later. Deliberately not on the soft declines or the polite
        # brush-off, which are still live conversations.
        "REPLY_TOLAK_TEGAS",
    }
)

#: Templates that ship the contact's category case studies (ROADMAP 2.4):
#: the portfolio answer and the social-proof cold follow-up — the two moments
#: the corpus shows real agents sending GMV screenshots.
_WITH_CASE_STUDY = frozenset({"REPLY_TANYA_PORTOFOLIO", "COLD_FU3"})
