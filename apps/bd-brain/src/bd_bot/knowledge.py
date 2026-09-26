"""Knowledge base extracted from the Knowledge & Behaviour layer of FLOWCHART.md.

This is the single source of truth for what the bot is allowed to say. It has
two parts:

  FACTS       — every hard claim (prices, volumes, clients) the bot may make.
                Nothing outside this may appear in a generated reply; the
                responder validates against ALLOWED_AMOUNTS and falls back to a
                static template on any violation.

  EXAMPLES    — the whiteboard's actual question/answer pairs, used as few-shot
                grounding so generated replies stay on-message.

Editing this file changes the bot's behaviour. Editing prompts does not.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass

from .models import Intent

# ---------------------------------------------------------------------------
# Hard facts — FLOWCHART.md §5.3
# ---------------------------------------------------------------------------

COMPANY = "MCNAsia.biz"
POSITIONING = "Official Partner TikTok & Shopee"

CLIENTS = ["Unilever", "Mondelez", "Ultra Milk", "Anker", "Kintakun", "GAGA"]

CATEGORIES = [
    "F&B",
    "Beauty",
    "Mom & Kids",
    "Home Living",
    "Fashion",
    "Health",
]

AVERAGE_GMV = "Rp1–2 miliar per bulan"


@dataclass(frozen=True, slots=True)
class Package:
    name: str
    price_idr: int
    accounts: int
    min_videos: int
    #: Campaign length for THIS tier. Not shared: BD corrected the 500 to six
    #: months on 31 Jul 2026, and the bot had been telling brands "keduanya
    #: berjalan 4 bulan" — a two-month understatement on the tier we most want
    #: them to take.
    duration: str

    @property
    def price_label(self) -> str:
        return f"Rp{self.price_idr:,}".replace(",", ".")


# Page 4 of "DECK SERVICE AFF, ADS. FULL & KONTEN DIVISI OPTIMASI MCNASIA
# -OK2026.pdf", the deck shipped with the opening from 18 Sep 2026.
#
# THE LADDER IS BACK, and it is not the old one. Between 18 Aug and 18 Sep the
# catalogue was a single package (100 @ Rp10jt / 2 bulan); before that it was
# 300 @ Rp25jt / 4 bulan and 500 @ Rp45jt / 6 bulan. The deck now sells three
# tiers whose periods grow with them, and the 300 that used to run four months
# runs six. Anything that says "paket kami satu", "belum ada paket lain", or
# quotes the old 4-month 300 is now false.
#
# The struck-through figures on the deck (Rp20jt on the 200, Rp30jt on the
# 300) are NOT here on purpose: same rule as the ads cards — a brand hears the
# list price as the real one and the discount as pressure. Quote what is
# payable.
PACKAGES = [
    Package("100 Affiliate", 10_000_000, 100, 100, "2 bulan"),
    Package("200 Affiliate", 18_000_000, 200, 200, "4 bulan"),
    Package("300 Affiliate", 25_000_000, 300, 300, "6 bulan"),
]

#: Still none. The tiers above are the PUBLISHED catalogue, so every path may
#: quote them and the leak guard in responder.py has nothing to police. Set
#: this only if BD publishes a genuine promo priced away from the catalogue.
PROMO: Package | None = None


@dataclass(frozen=True, slots=True)
class Offer:
    """A deck price that is not one of the affiliate tiers.

    Separate from `Package` because none of these is "N affiliate for one
    campaign fee": one is a floor ("start from"), one bundles ads with store
    management and bills per month, one is a whole-operation retainer. They
    share only the thing that matters to the guard — an amount the bot is
    allowed to say out loud.
    """

    name: str
    price_idr: int
    #: True when the deck prints START FROM: the figure is a floor, and the
    #: bot must say so. A brand told "Rp50 juta" for something quoted as
    #: "start from Rp50 juta" has been given a number that cannot hold.
    start_from: bool = False
    #: "per campaign" | "per bulan" — decides which guard set it lands in.
    unit: str = "per campaign"
    duration: str = ""
    note: str = ""

    @property
    def price_label(self) -> str:
        return f"Rp{self.price_idr:,}".replace(",", ".")


#: Everything else on the deck that carries a price. Authorised for chat
#: 18 Sep 2026: the brand receives this deck with the opening, so every figure
#: here is already in their hands — refusing to confirm one reads as evasion.
OFFERS = [
    Offer("Paket Custom Eksklusif (minimal +500 akun affiliate)", 50_000_000,
          start_from=True,
          note="isi menyesuaikan kebutuhan brand; laporan detail + action plan, "
               "free konsultasi selama periode kontrak"),
    Offer("Special Bundle 500 Affiliate + minimal 500 video", 55_000_000,
          duration="6 bulan",
          note="termasuk free optimasi TikTok Ads selama 6 bulan, di luar budget iklan"),
    Offer("Special Bundle Shopee Ads + Manage Ecommerce", 19_899_000,
          unit="per bulan", duration="minimal kontrak 6 bulan",
          note="termasuk free live streaming minimal 30 jam per bulan "
               "(studio, talent, equipment); budget iklan di luar service"),
    # The deck titles this one "Full Service (Garansi Sale)". The two words in
    # brackets are deliberately NOT carried here: every string in OFFERS is fed
    # to the model as fact, and responder.validate rejects any generated reply
    # containing "garansi" (only REPLY_TANYA_SAMPLE may voice a guarantee). So
    # the deck name made the model write a sentence that was then thrown away,
    # and a brand asking about Full Service got "boleh dijelaskan sedikit lebih
    # detail maksud Kakak?" instead of a price. Name and price are quotable;
    # what the guarantee actually covers is a meeting topic either way —
    # see OTHER_SERVICES_NOTE.
    Offer("Full Service", 55_000_000, start_from=True,
          note="live streaming 4 jam/hari selama 30 hari, service affiliate "
               "minimal 150 affiliate + video per bulan, manage ecommerce "
               "TikTok & Shopee, maintenance ads, 15 video/bulan untuk akun official"),
    Offer("TVC Production", 500_000_000, start_from=True,
          note="produksi TVC dengan talent/selebriti; partner broadcast MNCTV, "
               "RCTI, Indosiar"),
]


@dataclass(frozen=True, slots=True)
class AdsPackage:
    name: str
    price_idr: int
    #: What the deck strikes through above the payable price, or None when the
    #: package is not discounted. Never quoted — a brand hears the list price
    #: as the real one and the discount as pressure.
    list_price_idr: int | None = None

    @property
    def price_label(self) -> str:
        return f"Rp{self.price_idr:,}".replace(",", ".")


#: Page 2 of the new deck. Authorised for chat on 18 Aug 2026, reversing the
#: previous rule that ads pricing was meeting-only — the deck the brand now
#: receives states these figures, so refusing to confirm them in chat reads as
#: evasion.
#:
#: BILLED PER BULAN, unlike the affiliate fee which is per campaign. That
#: split is why ALLOWED_AMOUNTS is built from two sets below: the monthly
#: guard in responder.py must reject "Rp10 juta per bulan" (affiliate) while
#: allowing "Rp5 juta per bulan" (ads). Quote the payable figure only.
ADS_PACKAGES = [
    AdsPackage("TikTok Ads", 5_000_000),
    AdsPackage("Shopee Ads", 5_000_000),
    AdsPackage("Meta Ads - CPAS", 13_000_000),
    AdsPackage("Paket Hemat (TikTok + Shopee Ads)", 8_000_000, 10_000_000),
    AdsPackage("Paket Cuan (TikTok + Shopee + Meta CPAS)", 15_000_000, 23_000_000),
]

#: Stated with every ads price. The fee buys the management work; the ad spend
#: itself is the brand's and sits outside it — the deck says DILUAR BUDGET
#: IKLAN on every card, and a brand that misses it budgets Rp5 juta for a
#: month of TikTok Ads and expects media on top of nothing.
ADS_PRICE_NOTE = "harga di luar budget iklan, dan dihitung per bulan"

#: Per CAMPAIGN, not per month. Corrected 29 Jul 2026 after a generated reply
#: quoted "Rp25 juta per bulan" to a tester — a brand reading that plans
#: around a recurring monthly fee that is not what we charge.
PRICE_ANCHOR = "mulai Rp10 juta per campaign"

DIFFERENTIATORS = [
    "creator disaring sesuai kebutuhan dan profil brand",
    "status sample dipantau harian, dari pengiriman sampai diterima creator",
    "follow up creator agar konten benar-benar tayang",
    "monitoring harian view, like, komentar, dan GMV affiliate",
    "bantuan penyusunan script dan storyboard bila brand belum punya",
    "creator berperforma terbaik diajak lanjut di bulan berikutnya",
]

#: Expanded 31 Jul 2026: BD's answer to "belum tertarik" offers the other
#: lines, and the four listed here were not enough to carry it. Names only —
#: no pricing, no scope, no guarantee is sayable for any of these in chat; a
#: brand that picks one goes to a meeting. See OTHER_SERVICES_NOTE.
OTHER_SERVICES = [
    "Affiliate Campaign",
    "Live Streaming di akun official brand",
    "produksi TVC dan video konten untuk akun official brand",
    "Full Service Management",
    "layanan berbasis AI",
    "Ads Management (TikTok Ads, Shopee Ads, Meta Ads)",
    "koneksi dengan Mega Creator atau KOL",
    "layanan digital commerce lainnya",
]

#: The menu as the BD team actually sends it — six lines, this order, these
#: names — in 15 of the 36 inbound conversations (the "Layanan kami
#: meliputi:" message that follows the filled form). Added 24 Sep 2026 so the
#: inbound templates offer what we have from one list instead of three
#: hand-typed variants. Names only, by design: "Marketplace Management" and
#: "Official Livestream" have no standalone price in the 18 Sep deck, and the
#: rule for unpriced lines is OTHER_SERVICES_NOTE — name it, then take it to
#: the meeting. OTHER_SERVICES above is the wider list the rejection replies
#: use; this is the short one a warm lead is offered.
SERVICE_MENU = [
    "Campaign Affiliate",
    "Official Livestream",
    "TikTok & Shopee Ads",
    "Meta CPAS Ads",
    "Branding & Content",
    "Marketplace Management",
]


def service_menu_lines() -> str:
    """The six services as WhatsApp bullets, ready to drop into a template."""
    return "\n".join(f"• {name}" for name in SERVICE_MENU)


#: The guard that travels with the list above. The affiliate line is the only
#: one with authorised pricing and an authorised scope; every other name is a
#: door to a conversation, not an offer. Stated explicitly because the list is
#: shown at the moment a brand has just said no, which is exactly when an
#: improvised sweetener is most tempting.
#: Widened 18 Sep 2026, and only as far as the deck goes. The brand receives
#: that deck with the opening, so a price printed in it is already in their
#: hands and refusing to confirm it reads as evasion — the same reasoning that
#: opened ads pricing on 18 Aug. Everything the deck does NOT price is
#: unchanged: name it, then take it to the meeting.
OTHER_SERVICES_NOTE = (
    "untuk layanan selain Affiliate Campaign, yang BOLEH disebut hanyalah "
    "angka yang tercantum di daftar PAKET ADS dan PAKET LAIN DI DECK di atas, "
    "persis seperti tertulis — dan bila angkanya bertanda 'mulai', kata "
    "'mulai' wajib ikut disebut karena itu batas bawah, bukan harga pasti. "
    "Layanan yang tidak punya angka di daftar itu (mis. layanan berbasis AI, "
    "koneksi Mega Creator/KOL, live streaming yang berdiri sendiri) hanya "
    "boleh DISEBUT NAMANYA. Di luar angka paket, JANGAN menyebut cakupan "
    "kerja detail, target, atau jaminan hasil apa pun — termasuk ROI, GMV, "
    "dan garansi dalam bentuk apa pun; bila brand ingin lebih detail, "
    "arahkan ke meeting agar dibahas bersama tim"
)

#: The second service line. All three platforms are real (BD, 29 Jul 2026),
#: but the demand is lopsided: TikTok is what brands actually ask about,
#: Shopee follows, and Meta is rare enough that BD called it "sangat kecil
#: kemungkinan". So TikTok leads every list, and Meta is mentioned rather than
#: led with. The deck we send covers TikTok and Shopee only.
#: Revised 18 Aug 2026. The old rule sent every ads question to a meeting,
#: which made sense while the deck the brand held said nothing about ads
#: pricing. Page 2 of the new deck prints all five figures, so declining to
#: confirm them now reads as evasion rather than discipline. Scope of work
#: still goes to a meeting — only the published price is sayable.
ADS_SERVICE = (
    "layanan Ads Management mencakup TikTok Ads, Shopee Ads, dan Meta Ads — "
    "sebutkan dalam urutan itu, karena TikTok yang paling sering ditanyakan "
    "dan Meta paling jarang; harga paket ads BOLEH disebutkan persis seperti "
    "pada daftar PAKET ADS, selalu bersama catatan bahwa harga di luar budget "
    "iklan dan dihitung per bulan; cakupan kerja detail, target, dan jaminan "
    "hasil tetap TIDAK dibahas di chat — arahkan ke meeting"
)

#: Where brand contacts come from. Stated by BD on 30 Jul 2026, after the
#: generator invented "dari data publik terkait informasi bisnis" for a tester
#: who asked. This is the ONLY sourcing claim the bot may make — the guard in
#: responder.py rejects every other one, because a wrong answer here is a
#: compliance problem, not a sales one.
CONTACT_SOURCE = (
    "kontak brand diperoleh melalui TikTok Affiliate Partner (TAP); MCNAsia "
    "adalah Official Partner TikTok & Shopee. JANGAN pernah menyebut sumber "
    "lain — bukan data publik, bukan database, bukan direktori"
)

# --- facts stated by BD on 30 Jul 2026 -------------------------------------
# Each of these answers a question the corpus shows brands asking and the
# knowledge base could not answer, so the generator improvised or the rules
# sent it somewhere unrelated.

#: The NPWP number itself is not in this copy (25 Sep 2026). The CRM repo
#: has a GitHub remote, and a tax id is a document detail, not a sales fact:
#: the legality answer says the papers exist and are shown at contract time,
#: which is what REPLY_TANYA_LEGALITAS already promises. `whatsapp-bot-bd`
#: keeps the number; a sync must not bring it back here.
LEGAL_ENTITY = (
    "MCNASIA beroperasi di bawah badan hukum PT. MULTI BISNIS ASIA; legalitas "
    "lengkap termasuk Akta Pendirian dan NPWP Perusahaan; nomor NPWP "
    "dilampirkan bersama dokumen legalitas saat pembahasan kontrak, "
    "JANGAN menyebutkan nomornya di chat"
)

REFUND_TERMS = (
    "apabila kerja sama dihentikan di tengah periode, pertanggungjawaban, "
    "penghentian layanan, dan ketentuan refund mengikuti klausul yang "
    "disepakati dalam kontrak kerja sama — JANGAN menjanjikan refund, "
    "persentase, atau jangka waktu apa pun di chat"
)

CONTENT_RIGHTS = (
    "hak cipta konten mengikuti ketentuan dalam perjanjian kerja sama; secara "
    "umum brand berhak menggunakan konten yang dihasilkan untuk kebutuhan "
    "pemasaran sesuai ruang lingkup penggunaan yang disepakati dalam kontrak"
)

EXCLUSIVITY = (
    "kami dapat menangani beberapa brand dalam kategori yang sama tanpa "
    "konflik operasional; setiap brand dikelola tim berbeda dengan strategi, "
    "target KPI, dan workflow terpisah; insight performa dipakai untuk "
    "evaluasi dan optimasi, TANPA membagikan informasi atau data rahasia "
    "antar brand. JANGAN menjanjikan eksklusivitas kategori"
)

#: Full details, kept here so the fact exists in one place. The reply template
#: deliberately withholds the ACCOUNT NUMBER: payment happens after contract
#: and invoice (see PAYMENT_TERMS), and a bot that hands account numbers to
#: anyone who asks teaches brands to accept them over WhatsApp — the habit
#: payment-fraud impersonation depends on. Put `PAYMENT_ACCOUNT_NUMBER` into
#: REPLY_TANYA_REKENING if BD decides otherwise.
PAYMENT_ACCOUNT_HOLDER = "PT. MULTI BISNIS ASIA"
PAYMENT_ACCOUNT_BANK = "Mandiri"
#: Read from the environment rather than written here (25 Sep 2026): this
#: copy lives in a repository with a GitHub remote, and the number is never
#: sent by the bot anyway — `test_the_bank_account_number_never_goes_out_in_chat`
#: pins that. Empty means "not configured", which changes nothing the bot
#: says. `whatsapp-bot-bd` keeps the literal; a sync must not bring it back.
PAYMENT_ACCOUNT_NUMBER = os.getenv("PAYMENT_ACCOUNT_NUMBER", "")

RESTRICTED_CATEGORIES = (
    "kami hanya menerima produk yang sesuai kebijakan platform (TikTok Shop, "
    "Shopee, dan marketplace terkait) serta peraturan perundang-undangan yang "
    "berlaku di Indonesia; produk yang memerlukan izin khusus wajib memenuhi "
    "persyaratan legal sebelum campaign dijalankan. JANGAN memutuskan sendiri "
    "apakah sebuah produk boleh — arahkan ke tim bila ragu"
)

#: Distinct from SAMPLE_RULE, which covers sending samples to affiliates.
#: This is about the brand's own inventory holding up once the campaign runs.
MINIMUM_STOCK = (
    "brand sebaiknya menyiapkan stok secara matang; minimal stok sample untuk "
    "para affiliate; campaign affiliate umumnya berdampak cukup besar pada "
    "peningkatan penjualan sehingga kesiapan stok perlu diperhatikan; "
    "apabila stok sold out di tengah campaign, kami dapat melakukan HOLD "
    "campaign sementara hingga stok kembali tersedia. JANGAN menyebut jumlah "
    "pcs atau nilai stok minimum — tidak ada angka yang ditetapkan"
)

GEOGRAPHY = (
    "MCNASIA melayani brand di seluruh wilayah Indonesia; seluruh proses dapat "
    "dilakukan online — konsultasi, onboarding, perencanaan campaign, "
    "distribusi affiliate, monitoring performa, hingga pelaporan berkala; "
    "meeting atau kunjungan langsung dimungkinkan sesuai kebutuhan"
)

#: What happens to the affiliate videos once the campaign period ends. From
#: inbound/ (24 Sep 2026): a brand asked "kalau udh 4 bulan itu vt nya bakal
#: di privasi?" and BD answered that every distributed video stays up and
#: keeps performing after the contract, provided the product link (SKU) is
#: not taken down in seller center. Corpus-sourced, one conversation; kept
#: because it is a platform mechanic, not a price or a promise of results —
#: and stated as a condition ("selama link produknya tidak di-takedown"),
#: never as a guarantee.
CONTENT_AFTER_CONTRACT = (
    "video affiliate yang sudah tayang TETAP tayang dan tetap bekerja "
    "setelah periode kontrak selesai — tidak diprivat dan tidak dihapus — "
    "dengan catatan link/SKU produknya tidak di-takedown di seller center; "
    "JANGAN menjanjikan performa tertentu sesudah kontrak"
)

MEETING_LENGTH = "meeting singkat"
MEETING_WINDOW = (
    "Senin–Sabtu, setiap jam antara 09.00–19.00 WIB (satu brand per jam); "
    "selalu minta HARI dan JAM"
)

# --- facts recurring across the chat-example exports -----------------------
# Each of these is stated consistently in multiple real conversations; they
# back the question-intent templates (portfolio, lokasi, komisi, dst).

OFFICE_ADDRESS = (
    "Ruko Mall Seasons City Blok B No. 10, Tambora, Jakarta Barat 11320 "
    "(area Grogol)"
)
OFFICE_NOTE = (
    "brand dipersilakan berkunjung; beberapa brand yang kami handle "
    "menjalankan live streaming dari studio kami"
)

#: The opening figure for the MCN cut, authorised by BD on 29 Jul 2026. Until
#: then the bot said no number at all and the responder rejected every
#: percentage as invented. It is an OPENING, not a final rate — the negotiation
#: still escalates to a human (flow.py, NEGO_HARGA), and no other percentage
#: is sayable: see ALLOWED_PERCENTS.
MCN_COMMISSION = "10%"

#: Campaign length. The chat corpus contradicts itself here (3/4/5 bulan for
#: the same package), which is why every template used to defer duration to
#: the contract.
#:
#: Global again as of 18 Aug 2026: the per-tier split existed only because the
#: old deck sold a 4-month 300 and a 6-month 500. The new deck sells one
#: package, so there is exactly one duration and nothing to keep in step.
#: Per tier now, not one number — the periods grow with the package (2/4/6
#: bulan). Kept as a string for the prompt; anything that needs one tier's
#: length reads `Package.duration`.
CAMPAIGN_DURATION = "; ".join(f"{p.name} = {p.duration}" for p in PACKAGES)

COMMISSION_SCHEME = (
    "biaya per campaign + komisi ke MCN; komisi affiliate mengikuti open plan "
    f"yang ditetapkan brand; komisi ke MCN dibuka di {MCN_COMMISSION} dan masih "
    "dapat dinegosiasikan (bukan angka final — negosiasi diteruskan ke "
    "manajemen); settlement kedua komisi otomatis melalui "
    "sistem TikTok Affiliate Partner (TAP) dan hanya berlaku untuk penjualan "
    "yang dihasilkan affiliate MCN — tanpa penjualan, tanpa komisi; skema komisi saja / commission-only / CPS-only TIDAK tersedia — biaya per campaign tetap berlaku"
)

#: Why commission-only is declined, in the words BD uses (Alfath, 29 Jul 2026).
#: The basic rate covers work that happens before the first sale exists, so
#: there is nothing for a commission to be a percentage of yet.
COMMISSION_ONLY_REASON = (
    "basic rate di awal menutup tahapan yang tetap memakan effort dan resource "
    "tim sebelum penjualan pertama muncul: (1) filtering affiliate — screening "
    "performa (GMV, konversi, engagement), kesesuaian niche, track record "
    "penjualan, dan validasi kualitas traffic; (2) seeding & outreach — "
    "outreach, negosiasi, dan follow up sampai affiliate siap posting, dengan "
    "kurasi dan menjaga relasi, bukan sekadar blast; (3) monitoring & "
    "optimization — monitoring performa harian, scale yang perform dan cut "
    "yang tidak, serta koordinasi konten dan timing posting"
)

PAYMENT_TERMS = (
    "biaya dihitung PER CAMPAIGN, bukan biaya bulanan berulang; pembayaran "
    "dilakukan satu kali di awal, SETELAH kontrak ditandatangani dan invoice "
    "diterbitkan; seluruh komitmen dituangkan dalam kontrak kerja sama "
    "sebelum pembayaran apa pun"
)

GUARANTEE = (
    "apabila affiliate yang sudah menerima sample tidak membuat video sesuai "
    "kesepakatan, biaya sample diganti dan affiliate pengganti dicarikan "
    "tanpa biaya tambahan"
)

#: What we will and will not guarantee on results, in BD's own framing (31 Jul
#: 2026). The distinction is the whole answer: no number on GMV, because the
#: factors that move it sit largely on the brand's side — but the quality of
#: the affiliate accounts and the running of the campaign are ours, and those
#: we do commit to.
GMV_GUARANTEE = (
    "TIDAK ada garansi angka GMV/penjualan — hasil dipengaruhi harga produk, "
    "kualitas produk, daya saing di marketplace, promo yang berjalan, dan "
    "respon market. Yang kami pastikan adalah kualitas akun affiliate, "
    "peningkatan exposure produk, optimalisasi performa affiliate, dan "
    "campaign berjalan sesuai rencana"
)

#: Expectation-setting BD asks for on every results question (31 Jul 2026).
#: Affiliate compounds: the first month is usually quiet, and a brand that
#: was not told so reads a slow month one as the campaign failing. Stated as
#: a tendency ("biasanya"), never as a schedule.
RAMP_UP = (
    "campaign affiliate bersifat jangka panjang (long-term effect) — di bulan "
    "pertama biasanya penjualan belum signifikan, karena konten butuh waktu "
    "untuk tersebar dan terbaca algoritma, audience membangun trust terhadap "
    "produk, dan performa video affiliate (views serta conversion) naik "
    "bertahap. Sebagian brand memang sudah terlihat hasilnya sejak awal, "
    "biasanya karena didukung promo atau push dari sisi brand — sampaikan ini "
    "sebagai kecenderungan, JANGAN sebagai janji waktu"
)

#: What the brand must do for the campaign to work, stated by BD on 31 Jul
#: 2026 as part of the KPI answer. Named plainly on purpose: the corpus shows
#: brands treating a campaign as fully outsourced, then reading a flat month
#: as our failure when stock ran out or the price was not competitive.
BRAND_SUPPORT = (
    "keberhasilan campaign juga membutuhkan dukungan brand: mengaktifkan "
    "fitur GMV Max, menjaga ketersediaan stok, harga yang kompetitif, promo "
    "yang menarik, dan operasional toko yang berjalan baik"
)

PREPARATION = (
    "setelah pembayaran, persiapan campaign 7–14 hari sebelum mulai berjalan"
)

SAMPLE_RULE = (
    "brand menyiapkan stok produk dan pengiriman sample; satu produk per "
    "affiliate sudah cukup"
)

#: BD revision, 29 Jul 2026: the list is shared after the deal is closed, not
#: after an SOW discussion. It used to read "setelah diskusi SOW/kriteria",
#: which a brand could satisfy by having one call — the list is the asset, and
#: it does not leave before the agreement does.
CURATION = (
    "affiliate dikurasi berdasarkan kategori produk, positioning brand, dan "
    "histori penjualan (GMV) 28 hari terakhir; kategori akun affiliate nano "
    "dan micro; list affiliate dibagikan setelah DEAL kerja sama dan diskusi "
    "kriteria brand — tidak di awal, dan tidak sebelum deal"
)

VIDEO_RULE = (
    "jumlah video adalah angka MINIMAL satu video per affiliate; banyak "
    "affiliate membuat 2 video atau lebih dari satu sample"
)

PLATFORM_RULE = (
    "paket 150 affiliate difokuskan pada satu marketplace (TikTok ATAU "
    "Shopee); paket yang lebih besar dapat menggabungkan keduanya"
)

MEETING_SOP = (
    "diskusi detail dilakukan via Google Meet (bukan telepon) agar tim dan "
    "manajemen dapat bergabung serta share screen materi"
)

def _amount_forms(rupiah: int) -> set[str]:
    """Both ways a price is written in chat: "10.000.000" and "10 juta".

    The short form is only produced for whole millions. Rp19.899.000 written
    as "19 juta" is not an abbreviation, it is a different (cheaper) number,
    and the guard would then be permitting a figure nobody authorised.
    """
    forms = {f"{rupiah:,}".replace(",", ".")}
    if rupiah % 1_000_000 == 0:
        forms.add(f"{rupiah // 1_000_000} juta")
    return forms


#: Per CAMPAIGN or per contract period, one payment. Saying any of these with
#: a monthly unit is a factual error, which is what _MONTHLY_PRICE_RE in
#: responder.py catches.
PER_CAMPAIGN_AMOUNTS: frozenset[str] = frozenset(
    form
    for item in [*PACKAGES, *(o for o in OFFERS if o.unit == "per campaign")]
    for form in _amount_forms(item.price_idr)
)

#: Per BULAN, recurring. These are the only amounts a monthly unit is correct
#: for. List prices are deliberately excluded — only what a brand pays.
PER_MONTH_AMOUNTS: frozenset[str] = frozenset(
    form
    for item in [*ADS_PACKAGES, *(o for o in OFFERS if o.unit == "per bulan")]
    for form in _amount_forms(item.price_idr)
)

#: Every digit-group the bot is permitted to state. The responder rejects a
#: generated reply containing any Rp amount outside this set — that is the
#: guard against an LLM inventing a discount.
ALLOWED_AMOUNTS: frozenset[str] = PER_CAMPAIGN_AMOUNTS | PER_MONTH_AMOUNTS

#: The only percentages the bot may state. Everything else is rejected: a
#: percentage in chat reads as a commitment, and the corpus shows agents
#: quoting affiliate splits ("komisi affiliate di 10% dulu ya kak") the
#: business never authorised. This set exists so the ONE authorised figure —
#: the MCN opening cut — can be said without reopening the door to the rest.
#: The category commission on GMV FROM ADS, printed on both bundling pages of
#: the deck. Added 18 Sep 2026 with those bundles. It is not the affiliate
#: commission and not the MCN cut — a brand that reads it as either has been
#: quoted a number we do not charge, so the system instruction names it
#: explicitly and the templates always say "komisi GMV dari ads".
ADS_GMV_COMMISSION = {
    "Beauty": "8%",
    "F&B": "5%",
    "Fashion": "8%",
    "Home Living": "8%",
}

ALLOWED_PERCENTS: frozenset[str] = frozenset(
    {MCN_COMMISSION, *ADS_GMV_COMMISSION.values()}
)

#: The only campaign durations the bot may state, for the same reason. One per
#: package tier — a month count outside this set is invented.
#: Bare month counts only. `Offer.duration` carries prose ("minimal kontrak
#: 6 bulan") and the guard's regex reads the figure out of it, so putting the
#: phrase in here would add nothing and hide what the set actually contains.
ALLOWED_DURATIONS: frozenset[str] = frozenset(
    {p.duration for p in PACKAGES}
    | {m.group(0) for o in OFFERS if o.duration
       for m in [re.search(r"\d+\s*bulan", o.duration)] if m}
)


# ---------------------------------------------------------------------------
# Few-shot grounding — the whiteboard's own Q&A pairs
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Example:
    intent: Intent
    question: str
    answer: str


EXAMPLES: list[Example] = [
    Example(
        Intent.SETUJU,
        "Boleh",
        "Terima kasih, Kak. Saya akan siapkan jadwalnya. Kami tersedia "
        "Senin–Sabtu, setiap jam antara 09.00–19.00 WIB — hari dan jam berapa "
        "yang paling nyaman? Mohon bantu alamat email-nya juga ya Kak, untuk "
        "undangan Google Meet-nya.",
    ),
    Example(
        Intent.TANYA_SISTEM,
        "Sistem nya Bagaimana?",
        "Baik, Kak. Saya jelaskan sedikit ya terkait penawaran kami di "
        "campaign affiliate. Kami akan mencarikan affiliate sesuai kategori "
        "dan kebutuhan brand Kakak, lalu affiliate tersebut membuat video "
        "konten promosi produk di TikTok atau Shopee. Kami yang memonitor "
        "pengiriman sample, progres pembuatan konten, hingga performa harian "
        "campaign seperti view, like, komentar, dan GMV. Karena kami sudah "
        "menangani brand yang serupa, akan lebih mudah jika kami jelaskan "
        "alurnya lewat meeting online singkat — kira-kira Kakak ada waktu di "
        "hari dan jam berapa?",
    ),
    Example(
        Intent.TANYA_HARGA,
        "Harganya berapa yah?",
        "Baik, Kak. Paket campaign affiliate kami Rp10 juta per campaign, "
        "isinya 100 affiliate dan minimal 100 video, dengan durasi kerja 2 "
        "bulan ya, Kak. Kalau boleh tahu, untuk kebutuhan affiliate-nya "
        "berapa, Kak? Supaya saya bisa siapkan gambaran yang paling sesuai, "
        "apakah fokus utama Kakak lebih ke awareness, peningkatan penjualan, "
        "atau keduanya?",
    ),
    Example(
        Intent.TERUSKAN_TIM,
        "Ok kak, aku teruskan ke team aku yah kak?",
        "Baik, Kak. Terima kasih sudah bersedia meneruskan ke tim. Apabila tim "
        "membutuhkan informasi tambahan terkait layanan, strategi, ataupun "
        "estimasi target campaign, saya siap membantu.",
    ),
    Example(
        Intent.PELAJARI_DULU,
        "Nanti aja kak, saya pelajari dulu",
        "Baik, Kak. Silakan dipelajari terlebih dahulu. Apabila nanti ada "
        "pertanyaan atau ingin membandingkan paket yang paling sesuai untuk "
        "brand Kakak, saya siap membantu.",
    ),
    Example(
        Intent.TERIMA_KASIH,
        "Terimakasih Penawarannya..",
        "Sama-sama, Kak. Terima kasih atas waktunya. Saya titipkan company "
        "profile kami sebagai referensi — apabila ke depan ada kebutuhan "
        "terkait affiliate campaign, creator, atau digital commerce, dengan "
        "senang hati kami bantu.",
    ),
    Example(
        Intent.TOLAK_HALUS,
        "gak dulu kak?",
        "Baik, Kak. Tidak masalah. Kalau boleh tahu, saat ini kebutuhan brand "
        "Kakak lebih fokus ke arah mana — peningkatan penjualan, awareness, "
        "atau ada prioritas lain? Siapa tahu ada yang bisa kami bantu "
        "sesuaikan. Saya juga titipkan company profile kami sebagai referensi.",
    ),
    Example(
        Intent.TOLAK_TEGAS,
        "Maaf belum Tertarik",
        "Baik, Kak. Terima kasih atas responsnya. Sebelum saya tutup, boleh "
        "tahu kebutuhan brand Kakak saat ini seperti apa? Jika suatu saat "
        "relevan dengan layanan kami, dengan senang hati kami bantu. Saya "
        "titipkan company profile kami sebagai referensi.",
    ),
    Example(
        Intent.NANTI_AJA,
        "Nanti aja kak,",
        "Baik, Kak. Agar pembahasannya lebih spesifik, apabila berkenan kami "
        "dapat menjelaskan detailnya melalui meeting singkat sesuai kebutuhan "
        "brand Kakak.",
    ),
    Example(
        Intent.OK_LANJUT,
        "Ok baik ak",
        "Baik, Kak. Saya siapkan jadwal meeting-nya ya. Boleh diinformasikan "
        "hari dan jam yang paling sesuai (Senin–Sabtu, 09.00–19.00 WIB), "
        "beserta alamat email untuk undangan Google Meet-nya?",
    ),
    # --- question intents observed in the chat-example exports --------------
    Example(
        Intent.TANYA_PORTOFOLIO,
        "Boleh minta company credential/portfolio terbaru kah?",
        "Tentu, Kak. Kami berpengalaman menangani brand di berbagai kategori, "
        "termasuk kategori yang serupa dengan brand Kakak. Apabila berkenan, "
        "kami dapat mempresentasikan company profile beserta studi kasus dan "
        "report performa campaign dari kategori terkait melalui meeting "
        "singkat — sekaligus menjawab pertanyaan Kakak secara langsung.",
    ),
    Example(
        Intent.TANYA_LOKASI,
        "Ini kantornya dimana? apakah bisa visit kantor?",
        "Kantor kami berada di Ruko Mall Seasons City Blok B No. 10, Tambora, "
        "Jakarta Barat (area Grogol). Kakak dipersilakan berkunjung — "
        "beberapa brand yang kami handle juga menjalankan live streaming dari "
        "studio kami, jadi Kakak bisa melihat langsung operasional kami.",
    ),
    Example(
        Intent.TANYA_KOMISI,
        "Itu kan komisi ada komisi 10% utk MCN. Dan komisi utk affiliate sendiri. "
        "Jadi double dong?",
        "Baik, Kak, saya jelaskan. Untuk komisi affiliate, besarannya "
        "mengikuti open plan yang ditetapkan brand. Sementara komisi ke "
        "MCNASIA dibuka di 10%, dan sifatnya masih bisa dinegosiasikan. "
        "Settlement kedua komisi ini berjalan otomatis melalui sistem TikTok "
        "Affiliate Partner dan hanya berlaku bila affiliate benar-benar "
        "menghasilkan penjualan — tanpa penjualan, tidak ada komisi.",
    ),
    Example(
        Intent.TANYA_PEMBAYARAN,
        "ini per bulan atau per 2 bulan ya kak? kalau mau DP apa full payment?",
        "Baik, Kak. Biayanya dihitung per campaign, bukan tagihan bulanan "
        "berulang. Pembayaran dilakukan satu kali di awal, setelah kontrak "
        "kerja sama ditandatangani dan invoice kami terbitkan — jadi seluruh "
        "komitmen tertuang dalam kontrak terlebih dahulu. Durasi campaign "
        "mengikuti paketnya: 100 Affiliate 2 bulan, 200 Affiliate 4 bulan, "
        "dan 300 Affiliate 6 bulan ya, Kak.",
    ),
    Example(
        Intent.TANYA_AFFILIATE,
        "mau tanya rata rata views dan follower affiliate yang kka manage berapa ya?",
        "Baik, Kak. Affiliate yang kami libatkan dikurasi berdasarkan "
        "kategori produk, positioning brand, dan histori penjualan (GMV) 28 "
        "hari terakhir, dengan kategori akun affiliate nano dan micro — jadi "
        "bukan sekadar jumlah follower. Untuk list affiliate secara detail, "
        "baru kami bagikan setelah kita deal bekerja sama dan diskusi terkait "
        "kriteria brand Kakak, agar hasil kurasinya lebih sesuai.",
    ),
    Example(
        Intent.TANYA_SAMPLE,
        "misal ud kirim sample trs affiliatenya gk review malah hilang. Itu gimana ka?",
        "Di sinilah garansi kami, Kak. Apabila affiliate yang sudah menerima "
        "sample tidak membuat video sesuai kesepakatan, biaya sample kami "
        "ganti dan kami carikan affiliate pengganti tanpa biaya tambahan. Tim "
        "kami juga memonitor status sample dan progress video setiap hari.",
    ),
    Example(
        Intent.TANYA_TIMELINE,
        "Ka kl aku deal ini prosesnya brp lama? Sampe itu eksekusi ka?",
        "Baik, Kak. Setelah kontrak ditandatangani dan pembayaran diterima, "
        "kami memerlukan persiapan 7–14 hari — kurasi affiliate, koordinasi "
        "sample, dan penyusunan brief — lalu campaign langsung berjalan "
        "dengan monitoring harian.",
    ),
    Example(
        Intent.NEGO_HARGA,
        "Trs untuk harga aku minta dikurangi bs gak y ka?",
        "Baik, Kak. Harga paket campaign affiliate kami sudah nett: 100 "
        "Affiliate Rp10 juta, 200 Affiliate Rp18 juta, dan 300 Affiliate "
        "Rp25 juta. Namun "
        "untuk komisi ke MCNASIA masih bisa didiskusikan lebih lanjut. Boleh "
        "Kakak share angka yang diharapkan dari sisi brand, nanti saya "
        "sampaikan ke manajemen kami untuk dipertimbangkan ya, Kak 🙏",
    ),
    Example(
        Intent.MINTA_KONTRAK,
        "apakah kita bisa minta agreement untuk dipelajari tim legal kita kak?",
        "Tentu, Kak. Tim legal kami akan menyiapkan draft kontrak kerja sama "
        "untuk direview tim Kakak terlebih dahulu — tidak ada pembayaran "
        "apa pun sebelum kontrak disepakati. Apabila ada poin yang ingin "
        "disesuaikan, kami terbuka untuk mendiskusikannya.",
    ),
    Example(
        Intent.MINTA_TELEPON,
        "bisa aku hubungi kah? Mungkin kita bisa by tlf dulu ya kk",
        "Terima kasih, Kak. Sesuai SOP kami, diskusi detail dilakukan via "
        "Google Meet agar tim dan manajemen kami dapat bergabung sekaligus "
        "share screen materi penawarannya. Boleh diinformasikan hari dan jam "
        "yang paling sesuai (Senin–Sabtu, 09.00–19.00 WIB), beserta alamat "
        "email untuk undangannya?",
    ),
]


def examples_for(intent: Intent) -> list[Example]:
    return [e for e in EXAMPLES if e.intent is intent]


# ---------------------------------------------------------------------------
# Rendered fact sheet, injected into the responder's system prompt
# ---------------------------------------------------------------------------


def fact_sheet() -> str:
    packages = "\n".join(
        f"  - {p.name}: {p.price_label}/campaign — {p.accounts} akun affiliate, "
        f"minimal {p.min_videos} video (durasi campaign {p.duration})"
        for p in PACKAGES
    )
    durations = "; ".join(f"{p.name} = {p.duration}" for p in PACKAGES)
    ads_packages = "\n".join(
        f"  - {a.name}: {a.price_label}/bulan" for a in ADS_PACKAGES
    )
    offers = "\n".join(
        f"  - {o.name}: {'mulai ' if o.start_from else ''}{o.price_label}"
        f"{'/bulan' if o.unit == 'per bulan' else ''}"
        + (f" ({o.duration})" if o.duration else "")
        + (f" — {o.note}" if o.note else "")
        for o in OFFERS
    )
    ADS_GMV_COMMISSION_LINE = ", ".join(
        f"{k} {v}" for k, v in ADS_GMV_COMMISSION.items()
    )
    diffs = "\n".join(f"  - {d}" for d in DIFFERENTIATORS)
    return f"""\
PERUSAHAAN: {COMPANY} — {POSITIONING}
KLIEN: {", ".join(CLIENTS)}
RATA-RATA GMV KLIEN: {AVERAGE_GMV}
KATEGORI PENGALAMAN: {", ".join(CATEGORIES)}

PAKET (harga hanya boleh disebut persis seperti ini):
{packages}

PAKET LAIN DI DECK (harga persis seperti ini; "mulai" berarti angka LANTAI,
selalu sebut kata "mulai" — jangan pernah menyebutnya sebagai harga pasti):
{offers}

KOMISI GMV DARI ADS (khusus paket bundling): {ADS_GMV_COMMISSION_LINE}

ANCHOR HARGA (untuk pertanyaan harga pertama kali): {PRICE_ANCHOR}
Jangan sebutkan daftar harga lengkap sebelum brand bertanya kedua kalinya.
Biaya paket dihitung PER CAMPAIGN. JANGAN pernah menulis harga sebagai "per
bulan", "/bulan", atau "sebulan" — itu keliru dan membuat brand mengira ada
tagihan bulanan berulang.

PAKET ADS (harga per BULAN, boleh disebut di chat):
{ads_packages}
CATATAN HARGA ADS: {ADS_PRICE_NOTE}
Harga affiliate dihitung PER CAMPAIGN, harga ads PER BULAN — jangan tertukar.

PROMO: TIDAK ADA paket promo yang berlaku saat ini.
Jangan pernah menyebut angka, kuota, atau paket khusus apa pun di luar daftar
paket di atas — termasuk pada follow-up setelah penolakan.

PEMBEDA KAMI:
{diffs}

LAYANAN LAIN: {", ".join(OTHER_SERVICES)}
BATAS LAYANAN LAIN: {OTHER_SERVICES_NOTE}
LAYANAN ADS: {ADS_SERVICE}
MEETING: tawarkan "{MEETING_LENGTH}" — JANGAN pernah menyebut durasi dalam
menit (mis. "20–30 menit")
SLOT MEETING: {MEETING_WINDOW}
Untuk booking meeting, minta jam yang diinginkan DAN alamat email — undangan
Google Meet dikirim ke email tersebut setelah slot dicek di kalender.

SUMBER KONTAK: {CONTACT_SOURCE}
KANTOR: {OFFICE_ADDRESS} — {OFFICE_NOTE}
BADAN HUKUM: {LEGAL_ENTITY}
REFUND / PENGHENTIAN: {REFUND_TERMS}
HAK KONTEN: {CONTENT_RIGHTS}
VIDEO SETELAH KONTRAK: {CONTENT_AFTER_CONTRACT}
EKSKLUSIVITAS: {EXCLUSIVITY}
REKENING: pembayaran via transfer ke rekening perusahaan {PAYMENT_ACCOUNT_HOLDER}
(Bank {PAYMENT_ACCOUNT_BANK}). JANGAN menyebutkan nomor rekening di chat —
nomor dikirim bersama invoice resmi setelah kontrak.
KATEGORI PRODUK: {RESTRICTED_CATEGORIES}
STOK: {MINIMUM_STOCK}
JANGKAUAN: {GEOGRAPHY}
SKEMA KOMISI: {COMMISSION_SCHEME}
ALASAN KOMISI-SAJA DITOLAK: {COMMISSION_ONLY_REASON}
PEMBAYARAN: {PAYMENT_TERMS}
DURASI CAMPAIGN: {CAMPAIGN_DURATION}. Selama periode itu affiliate dimaintain
oleh tim kami. Periode mengikuti paketnya — JANGAN menukar durasi antar paket
dan JANGAN menyebut durasi di luar daftar itu.
KOMISI KE MCN: dibuka di {MCN_COMMISSION}, masih dapat dinegosiasikan. Satu-
satunya persentase LAIN yang boleh disebut adalah komisi GMV dari ads pada
paket bundling ({ADS_GMV_COMMISSION_LINE}) — dan harus selalu disebut sebagai
"komisi GMV dari ads", bukan komisi affiliate dan bukan komisi ke MCN. Komisi
affiliate sendiri mengikuti open plan yang ditetapkan brand, dan angkanya
TIDAK boleh disebut.
GARANSI: {GUARANTEE}
GARANSI GMV / PENJUALAN: {GMV_GUARANTEE}
RAMP-UP: {RAMP_UP}
DUKUNGAN DARI BRAND: {BRAND_SUPPORT}
PERSIAPAN: {PREPARATION}
SAMPLE: {SAMPLE_RULE}
KURASI AFFILIATE: {CURATION}
Jangan menjanjikan angka follower atau GMV minimal spesifik untuk affiliate.
VIDEO: {VIDEO_RULE}
MARKETPLACE: {PLATFORM_RULE}
SOP MEETING: {MEETING_SOP}
LIVE STREAMING: harga tersendiri untuk live streaming TIDAK boleh disebut di
chat — arahkan ke meeting. Yang boleh disebut hanyalah live streaming yang
sudah TERMASUK di paket bundling dan Full Service di atas, dengan angka paket
itu apa adanya.
PAKET LAMA: paket 150 Affiliate dan paket 500 Affiliate versi lama
sudah TIDAK berlaku (harga lamanya sengaja tidak dicantumkan di sini — jangan pernah
menyebut angka yang tidak ada di daftar PAKET / PAKET LAIN di atas). Kalau
brand menyebut salah satunya, katakan paket itu sudah tidak tersedia lalu
sebutkan paket yang berjalan sekarang.
"""
