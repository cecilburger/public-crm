"""Domain model for the BD acquisition bot.

Mirrors FLOWCHART.md. The three-state model from FLOWCHART.md §1 is the spine:
every node resolves to ACCEPTANCE, REJECTION, or FOLLOWUP, and only the first
two are exits.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


class Outcome(enum.StrEnum):
    """FLOWCHART.md §1 — the three states."""

    ACCEPTANCE = "acceptance"
    REJECTION = "rejection"
    FOLLOWUP = "followup"


class Node(enum.StrEnum):
    """Positions in the state machine.

    Named to match the whiteboard labels so the code stays greppable against
    FLOWCHART.md.
    """

    # --- entry -------------------------------------------------------------
    NEW = "new"
    BLASTED = "blasted"
    INBOUND_QUALIFY = "inbound_qualify"
    """An ad lead messaged us first and was sent the qualification form
    (Nama Brand / Posisi / links) — the SOP observed in every inbound chat
    in chat-example/. Their next reply joins the normal machine."""

    # --- cold ladder, FLOWCHART.md §2.1 + §2.2 (tracks A and B merged) -----
    COLD_FU1 = "cold_fu1"  # same day 16:00  — empati + company profile
    COLD_FU2 = "cold_fu2"  # H+1             — menu kebutuhan
    COLD_FU3 = "cold_fu3"  # H+3             — social proof
    COLD_FU4 = "cold_fu4"  # H+5             — promo, last resort

    # --- conversation ------------------------------------------------------
    QNA = "qna"  # TANYA JAWAB DENGAN CLIENT
    OFFER_MEETING = "offer_meeting"  # the closing gadget, §3.1

    # --- warm stall, §2.3 --------------------------------------------------
    WARM_D2 = "warm_d2"
    WARM_D5 = "warm_d5"

    # --- menunda meeting, §2.4 --------------------------------------------
    MENUNDA_H1 = "menunda_h1"
    MENUNDA_H3 = "menunda_h3"

    # --- scheduling + meeting, §3.3 ---------------------------------------
    SCHEDULING = "scheduling"
    SCHEDULED = "scheduled"
    NOSHOW_FU1 = "noshow_fu1"
    NOSHOW_FU2 = "noshow_fu2"

    # --- channel hand-off, 24 Sep 2026 -------------------------------------
    WA_HANDOFF = "wa_handoff"
    """An Instagram/Facebook DM lead who has been given our WhatsApp number
    and asked to continue there. The BD funnel is comment → DM → WhatsApp →
    meeting (their words: "kalau tertarik lebih lanjut, pindah ke WA supaya
    chat-nya lebih intens, lalu ajak meeting"), so scheduling never happens
    in a DM when a number is configured — the DM's job ends here. Questions
    that still arrive in the DM are answered; the pointer is not repeated
    every turn, because repeating it is what makes a lead stop replying."""

    # --- terminals ---------------------------------------------------------
    MEETING_DONE = "meeting_done"  # END
    STOPPED = "stopped"  # STOP
    HANDOVER = "handover"  # escalated to a human (gap §6.3)


TERMINAL_NODES = frozenset({Node.MEETING_DONE, Node.STOPPED, Node.HANDOVER})


class Intent(enum.StrEnum):
    """The eight intents from FLOWCHART.md §5.2, plus gadget replies and UNKNOWN."""

    # acceptance
    SETUJU = "setuju"  # "Boleh"
    OK_LANJUT = "ok_lanjut"  # "Ok baik ak" — gadget accept

    # follow-up (deferral)
    TANYA_SISTEM = "tanya_sistem"
    TANYA_HARGA = "tanya_harga"
    TERUSKAN_TIM = "teruskan_tim"
    PELAJARI_DULU = "pelajari_dulu"
    TERIMA_KASIH = "terima_kasih"
    NANTI_AJA = "nanti_aja"  # gadget defer

    # follow-up — question intents observed across the chat-example exports.
    # Each one recurs in multiple real conversations; see templates.py for the
    # matching answers.
    TANYA_PORTOFOLIO = "tanya_portofolio"  # "boleh minta portofolio/case study?"
    TANYA_LOKASI = "tanya_lokasi"  # "kantornya dimana?", "bisa visit?", scam worry
    TANYA_KOMISI = "tanya_komisi"  # "komisi MCN gimana? double dong?"
    #: Its own intent, not a shade of TANYA_KOMISI: "how much is the
    #: commission" and "can we pay in commission ONLY" have different
    #: answers, and the second one is a no. Sharing an intent let the
    #: generator answer the same question two contradictory ways in the
    #: same pilot — see REPLY_TANYA_KOMISI_ONLY.
    TANYA_KOMISI_ONLY = "tanya_komisi_only"  # "bisa by commission only?"
    TANYA_PEMBAYARAN = "tanya_pembayaran"  # "per bulan atau per campaign?", "DP?"
    TANYA_AFFILIATE = "tanya_affiliate"  # creator criteria/follower/niche/list
    TANYA_SAMPLE = "tanya_sample"  # sample logistics + "kalau gak bikin video?"
    TANYA_TIMELINE = "tanya_timeline"  # "berapa lama sampai jalan?"
    NEGO_HARGA = "nego_harga"  # "bisa kurang gak?"
    #: A counter-offer with a figure in it: "komisi ke MCNasia nego di 5%?".
    #: Distinct from TANYA_KOMISI, which explains the scheme — answering this
    #: with the scheme recites our 10% opening and ignores the number they
    #: just named, which is the one thing they wanted a response to.
    NEGO_KOMISI = "nego_komisi"  # "kalau komisi MCN 5% gimana?"
    MINTA_KONTRAK = "minta_kontrak"  # "kirim draft kontraknya dulu"
    MINTA_TELEPON = "minta_telepon"  # "bisa telepon aja?" / brand's own Zoom
    TANYA_CUSTOM = "tanya_custom"  # "bisa custom paket ga?", "by request bisa?"
    MINTA_CHAT = "minta_chat"  # "via chat aja ya kak, gak usah meeting"
    TANYA_KECOCOKAN = "tanya_kecocokan"  # "brand saya elektronik, apakah bisa?"
    TANYA_LIVE = "tanya_live"  # "dibantu live juga?", "daily live itu gimana?"
    #: "kaka tau nomor saya dari mana?" — where we got their contact details.
    #: Its own intent because the honest answer is not in the fact sheet and
    #: must never be guessed: on 30 Jul 2026 this fell to UNKNOWN and the
    #: generator answered "dari data publik terkait informasi bisnis", a
    #: data-provenance claim nobody authorised, sent to someone asking about
    #: their own privacy.
    KIRIM_EMAIL = "kirim_email"  # "kirimkan proposal ke email X" — not a booking
    HUBUNGKAN_PIC = "hubungkan_pic"  # "saya hubungkan ke tim sales kami"
    PRODUK_BERUBAH = "produk_berubah"  # "produk itu sudah tidak kami produksi"
    TANYA_SUMBER_KONTAK = "tanya_sumber_kontak"
    #: "apakah ada target penjualan?", "ada garansi penjualan?", "kalau gak
    #: laku gimana?" — asking what results are promised. Its own intent because
    #: the near misses were all worse than silence: "ada garansi penjualan"
    #: landed on TANYA_SAMPLE and answered with the sample-replacement
    #: guarantee, which reads as "yes, we guarantee sales".
    TANYA_TARGET = "tanya_target"
    #: "apa ada KPI nya?" — what is measured, as opposed to TANYA_TARGET's what
    #: is promised. Separate because the honest answers differ: TANYA_TARGET
    #: declines to commit to a number, while this one has something to give —
    #: affiliate quality, owned content, daily performance reporting — and
    #: answering it with a refusal alone reads as having no KPI at all.
    #: Added 31 Jul 2026; it fell to UNKNOWN before, so it was escalated and
    #: answered with the generic "boleh dijelaskan lebih detail?".
    TANYA_KPI = "tanya_kpi"
    #: "aku jualan baru banget dan bukan brand besar", "paket umkm ada ga?" —
    #: a brand ruling itself out on size. Twice in the corpus, once live.
    BRAND_KECIL = "brand_kecil"
    #: "Saya tertarik untuk Paket 150 affiliate" — the tier withdrawn 29 Jul
    #: 2026. Old decks and ads still circulate, so brands still ask for it.
    TANYA_PAKET_LAMA = "tanya_paket_lama"
    #: "meeting brapa orang ka?", "kalau atasan saya berhalangan hadir?"
    TANYA_MEETING_DETAIL = "tanya_meeting_detail"
    # --- facts BD supplied 30 Jul 2026, each closing a question the rules
    # used to answer with something unrelated or improvise entirely.
    TANYA_LEGALITAS = "tanya_legalitas"  # "PT nya apa?", "ada NPWP?"
    TANYA_REFUND = "tanya_refund"  # "berhenti di tengah gimana?", "bisa refund?"
    TANYA_HAK_KONTEN = "tanya_hak_konten"  # "videonya boleh kami repost?"
    TANYA_EKSKLUSIVITAS = "tanya_eksklusivitas"  # "handle kompetitor kami juga?"
    TANYA_REKENING = "tanya_rekening"  # "transfer ke rekening mana?"
    TANYA_KATEGORI_PRODUK = "tanya_kategori_produk"  # "produk rokok bisa?"
    TANYA_JANGKAUAN = "tanya_jangkauan"  # "bisa di luar jakarta?"
    #: The brand's own inventory, not the sample logistics TANYA_SAMPLE covers:
    #: "minimal stok berapa?", "kalau stok habis di tengah campaign gimana?"
    TANYA_STOK = "tanya_stok"
    #: The other service line, not affiliate: TikTok/Shopee ads management.
    #: COLD_FU2 offers it on the menu ("Ads Management"), so brands pick it —
    #: and until 29 Jul 2026 nothing answered them. Ships the GMV MAX deck.
    # --- inbound: they wrote first (inbound/, Sep 2026) --------------------
    #: WhatsApp's own pre-filled text from an ad or a catalogue CTA — the
    #: brand tapped a button, they did not type this. 26 of 430 turns in the
    #: inbound corpus, the single most common thing a new lead "says".
    #: Its own intent because it is a SOURCE, not a question: it means an ad
    #: is running and this person came through it, and the SOP answer is the
    #: qualification form rather than anything about the words themselves.
    LEAD_IKLAN = "lead_iklan"
    #: The qualification form, filled in. Two shapes in the corpus: typed out
    #: ("Nama brand : X / Posisi : owner / link: …") and our own message
    #: copied back with values after the colons. This is the turn the whole
    #: inbound SOP is waiting for.
    ISI_FORM = "isi_form"
    # --- inbound, second mining round (24 Sep 2026) -----------------------
    # The three shapes the CRM PDF's own worked scripts open with, and that
    # the first round left UNKNOWN: a vague "tell me more", a "what do you
    # offer", and a need named in one word. All three are the moment the
    # PDF says to "gali kebutuhan" or "offer", and UNKNOWN answered them
    # with "boleh dijelaskan sedikit lebih detail maksud Kakak?".
    #: "Mau info affiliate", "Kak mau tanya service MCNASIA", "tertarik
    #: dengan service affiliate, bisa info?", "Info kak". Warm, not yet a
    #: question about anything specific. The PDF's answer is a one-breath
    #: explanation and a question back about their product and platform —
    #: NOT the price list and NOT a meeting push; nothing has been dug yet.
    MINTA_INFO = "minta_info"
    #: "Bentuk layanannya apa aja", "selain affiliate ada layanan lain?",
    #: "solusi apa saja". Asking for the menu. The corpus answer is the
    #: six-line service list plus a question about category and need — names
    #: only, no prices (knowledge.SERVICE_MENU).
    TANYA_LAYANAN = "tanya_layanan"
    #: "Affiliate", "Saya butuh affiliate kak", "Colab affiliator", "Cari
    #: pasukan affiliate" — the need, stated. Usually the reply to our own
    #: "kebutuhannya apa?", and the turn the corpus answers with a short
    #: affiliate pitch and the meeting invitation. Not TANYA_AFFILIATE (which
    #: asks ABOUT the creators) and not SETUJU (nobody agreed to anything).
    BUTUH_AFFILIATE = "butuh_affiliate"
    #: "udah 2x pernah dipromosiin tapi gak ada hasil", "affiliate video
    #: banyak tapi gak ke arah sales" — burned by a previous agency or
    #: campaign. The corpus's best-handled objection: BD agrees it is
    #: normal, names the cause (quantity is not the lever), asks how it was
    #: run before, and offers the case study at the meeting. Its own intent
    #: because the near misses were all wrong: "gak ada hasil" read as a
    #: soft no, and UNKNOWN asked them to explain themselves.
    PERNAH_AGENCY = "pernah_agency"
    #: "Lebih ke sales kak", "dua-duanya", "pengen naikin awareness" — the
    #: answer to OUR question "fokus campaign lebih ke awareness, penjualan,
    #: atau keduanya?", which four templates ask. Read as UNKNOWN it burned a
    #: strike ("boleh dijelaskan lebih detail maksud Kakak?") and two of them
    #: handed over a lead who was answering us; "keduanya" was OK_LANJUT and
    #: jumped to a slot list. Context-bound: the engine only lets it stand
    #: when the last thing we sent asked for the focus (24 Sep 2026).
    FOKUS_CAMPAIGN = "fokus_campaign"
    # --- round 3, 24 Sep 2026: real corpus questions the wider test hit ---
    #: "Berapa harga unt LS nya kak?" — a price question about LIVE
    #: STREAMING, not affiliate. Its own intent because TANYA_HARGA answered
    #: it with the affiliate anchor (wrong service), and the sayable answer
    #: is different: the standalone live price is meeting-only, and only the
    #: live that is INCLUDED in the deck's bundle/Full Service figures may be
    #: named (knowledge.OTHER_SERVICES_NOTE).
    TANYA_HARGA_LIVE = "tanya_harga_live"
    #: "ada rate card atau company profile?", "boleh minta deck nya" — a
    #: request for the document. Was TANYA_AFFILIATE (the English-RFP "rate
    #: card" alternative), which answered a deck request with the curation
    #: criteria. The corpus answer: attach it, and ask the need.
    MINTA_PROFILE = "minta_profile"
    #: "saya dari agency", "kita handle beberapa klien yang ada kebutuhan
    #: affiliate", "lgi cr vendor baru" — an agency shopping for a vendor for
    #: ITS clients. A different lead: the team asks the category and the
    #: volume, and invites. Listed as unplaced since the first round.
    AGENCY_VENDOR = "agency_vendor"
    #: "Kalau udh 4 bulan itu vt nya bakal di privasi atau gimana ka?" —
    #: what happens to the affiliate videos after the contract. A process
    #: fact from the corpus (knowledge.CONTENT_AFTER_CONTRACT), not a price;
    #: TANYA_SISTEM gave the generic how-it-works answer instead.
    TANYA_VIDEO_SETELAH_KONTRAK = "tanya_video_setelah_kontrak"

    TANYA_ADS = "tanya_ads"  # "ada service ads juga?", "handle tiktok ads?"
    MINTA_LINK = "minta_link"  # "link nya ka", "tlg reminder-nya ulang"
    TUNGGU = "tunggu"  # "bentar saya cek ya", "sebentar ya" — hold on

    # rejection
    TOLAK_HALUS = "tolak_halus"  # "gak dulu kak"
    TOLAK_TEGAS = "tolak_tegas"  # "Maaf belum tertarik"

    # meta
    UNKNOWN = "unknown"
    OPT_OUT = "opt_out"  # "STOP", "jangan hubungi lagi" — hard stop, always honoured


#: Which of the three states each intent maps to. FLOWCHART.md §5.2.
INTENT_OUTCOME: dict[Intent, Outcome] = {
    Intent.SETUJU: Outcome.ACCEPTANCE,
    Intent.OK_LANJUT: Outcome.ACCEPTANCE,
    Intent.TANYA_SISTEM: Outcome.FOLLOWUP,
    Intent.TANYA_HARGA: Outcome.FOLLOWUP,
    Intent.TERUSKAN_TIM: Outcome.FOLLOWUP,
    # None of these three is a yes or a no: the brand is still there, just
    # pointing us somewhere else or at something else.
    Intent.KIRIM_EMAIL: Outcome.FOLLOWUP,
    Intent.HUBUNGKAN_PIC: Outcome.FOLLOWUP,
    Intent.PRODUK_BERUBAH: Outcome.FOLLOWUP,
    Intent.PELAJARI_DULU: Outcome.FOLLOWUP,
    Intent.TERIMA_KASIH: Outcome.FOLLOWUP,
    Intent.NANTI_AJA: Outcome.FOLLOWUP,
    Intent.TANYA_PORTOFOLIO: Outcome.FOLLOWUP,
    Intent.TANYA_LOKASI: Outcome.FOLLOWUP,
    Intent.TANYA_KOMISI: Outcome.FOLLOWUP,
    Intent.TANYA_KOMISI_ONLY: Outcome.FOLLOWUP,
    Intent.TANYA_PEMBAYARAN: Outcome.FOLLOWUP,
    Intent.TANYA_AFFILIATE: Outcome.FOLLOWUP,
    Intent.TANYA_SAMPLE: Outcome.FOLLOWUP,
    Intent.TANYA_TIMELINE: Outcome.FOLLOWUP,
    Intent.NEGO_HARGA: Outcome.FOLLOWUP,
    Intent.NEGO_KOMISI: Outcome.FOLLOWUP,
    Intent.MINTA_KONTRAK: Outcome.FOLLOWUP,
    Intent.MINTA_TELEPON: Outcome.FOLLOWUP,
    Intent.TANYA_CUSTOM: Outcome.FOLLOWUP,
    Intent.MINTA_CHAT: Outcome.FOLLOWUP,
    Intent.TANYA_KECOCOKAN: Outcome.FOLLOWUP,
    Intent.TANYA_LIVE: Outcome.FOLLOWUP,
    Intent.TANYA_ADS: Outcome.FOLLOWUP,
    # Neither is a yes: an ad lead has asked for information, and a filled
    # form is data. Reading either as ACCEPTANCE would skip the SOP and jump
    # straight to booking a meeting nobody offered yet.
    Intent.LEAD_IKLAN: Outcome.FOLLOWUP,
    Intent.ISI_FORM: Outcome.FOLLOWUP,
    # Interest, not agreement: each of these asks us to explain or offer,
    # and the flow answers then invites — it never books off them.
    Intent.MINTA_INFO: Outcome.FOLLOWUP,
    Intent.TANYA_LAYANAN: Outcome.FOLLOWUP,
    Intent.BUTUH_AFFILIATE: Outcome.FOLLOWUP,
    # An objection is not a rejection: they are telling us why they hesitate,
    # which is an invitation to answer, not a goodbye.
    Intent.PERNAH_AGENCY: Outcome.FOLLOWUP,
    # The need, named. Acknowledged and invited — never booked off it.
    Intent.FOKUS_CAMPAIGN: Outcome.FOLLOWUP,
    # Round 3 (24 Sep 2026): questions and a document request, all follow-up.
    Intent.TANYA_HARGA_LIVE: Outcome.FOLLOWUP,
    Intent.MINTA_PROFILE: Outcome.FOLLOWUP,
    Intent.AGENCY_VENDOR: Outcome.FOLLOWUP,
    Intent.TANYA_VIDEO_SETELAH_KONTRAK: Outcome.FOLLOWUP,
    Intent.TANYA_SUMBER_KONTAK: Outcome.FOLLOWUP,
    Intent.TANYA_TARGET: Outcome.FOLLOWUP,
    Intent.TANYA_KPI: Outcome.FOLLOWUP,
    Intent.BRAND_KECIL: Outcome.FOLLOWUP,
    Intent.TANYA_PAKET_LAMA: Outcome.FOLLOWUP,
    Intent.TANYA_MEETING_DETAIL: Outcome.FOLLOWUP,
    Intent.TANYA_LEGALITAS: Outcome.FOLLOWUP,
    Intent.TANYA_REFUND: Outcome.FOLLOWUP,
    Intent.TANYA_HAK_KONTEN: Outcome.FOLLOWUP,
    Intent.TANYA_EKSKLUSIVITAS: Outcome.FOLLOWUP,
    Intent.TANYA_REKENING: Outcome.FOLLOWUP,
    Intent.TANYA_KATEGORI_PRODUK: Outcome.FOLLOWUP,
    Intent.TANYA_JANGKAUAN: Outcome.FOLLOWUP,
    Intent.TANYA_STOK: Outcome.FOLLOWUP,
    Intent.MINTA_LINK: Outcome.FOLLOWUP,
    Intent.TUNGGU: Outcome.FOLLOWUP,
    Intent.TOLAK_HALUS: Outcome.REJECTION,
    Intent.TOLAK_TEGAS: Outcome.REJECTION,
    Intent.OPT_OUT: Outcome.REJECTION,
    Intent.UNKNOWN: Outcome.FOLLOWUP,
}


class Timer(enum.StrEnum):
    """Timers from FLOWCHART.md §2.5, plus the decay timers that the board is
    missing (§6.1)."""

    COLD_FU1 = "cold_fu1"
    COLD_FU2 = "cold_fu2"
    COLD_FU3 = "cold_fu3"
    COLD_FU4 = "cold_fu4"
    WARM_D2 = "warm_d2"
    WARM_D5 = "warm_d5"
    MENUNDA_H1 = "menunda_h1"
    MENUNDA_H3 = "menunda_h3"
    NOSHOW_1 = "noshow_1"
    NOSHOW_2 = "noshow_2"
    REMINDER = "reminder"
    MEETING_END = "meeting_end"

    #: Rejection gets one promo rescue before STOP (FLOWCHART.md §4).
    REJECT_PROMO = "reject_promo"

    #: Generic "silence after the last rung" -> STOP. This is the decay rule
    #: the whiteboard omits; without it follow-up never becomes rejection.
    DECAY_STOP = "decay_stop"


@dataclass(slots=True)
class Contact:
    jid: str
    """WhatsApp JID, e.g. '628123456789@s.whatsapp.net'."""

    name: str = ""
    """Person's name, used in templates. Falls back to 'Kak' when blank."""

    brand: str = ""
    """Brand/company the person represents."""

    category: str = ""
    """Brand category ("beauty", "fnb", …) — selects which case-study folder
    ships with the portfolio reply. Optional CSV column; blank is fine."""

    created_at: datetime | None = None


@dataclass(slots=True)
class Conversation:
    """Per-contact state. One row per contact."""

    jid: str
    name: str = ""
    brand: str = ""
    category: str = ""
    """Brand category for case-study attachments (see Contact.category)."""

    node: Node = Node.NEW
    outcome: Outcome = Outcome.FOLLOWUP

    gadget_loops: int = 0
    """How many times the closing gadget has been re-offered.

    FLOWCHART.md §6.1: the board has no decay rule here, so the loop is
    infinite as drawn. This counter is the fix — see config.MAX_GADGET_LOOPS.
    """

    email: str = ""
    """Captured from any inbound message; required before booking — the
    Google Calendar invite is sent to it."""

    last_inbound_at: datetime | None = None
    last_outbound_at: datetime | None = None
    meeting_at: datetime | None = None
    meet_link: str = ""

    unknown_streak: int = 0
    """Consecutive unclassifiable replies; triggers human handover (§6.2)."""

    price_stage: int = 0
    """Two-stage price reveal, FLOWCHART.md §5.3.
    0 = not asked, 1 = vague anchor sent, 2 = full price list sent."""

    stopped_reason: str = ""

    source: str = ""
    """Which channel the brand arrived on: "" (WhatsApp, the default and the
    only one before 18 Sep 2026), "instagram", "facebook".

    Recorded rather than inferred from the jid because it answers a question
    the BD team asks every week and this bot could not previously answer:
    which channel is producing leads. It also decides reply policy — a
    comment gets one short public line and a move to DM, never the pitch.
    """

    def display_name(self) -> str:
        return self.name_or("Kak")

    def name_or(self, fallback: str) -> str:
        return self.name.strip() or fallback


@dataclass(slots=True)
class Job:
    """A scheduled timer firing."""

    id: int | None
    jid: str
    timer: Timer
    fire_at: datetime
    payload: dict[str, Any] = field(default_factory=dict)
    fired: bool = False
