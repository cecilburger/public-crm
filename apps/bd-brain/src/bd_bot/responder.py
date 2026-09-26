"""Grounded reply generation.

Static templates always work and are the fallback. When USE_LLM_REPLIES is on,
this module generates a reply instead — grounded in `knowledge.py` and in the
whiteboard's own Q&A pairs, so the bot handles phrasings the templates don't
anticipate without drifting off-message.

Every generated reply is validated before it leaves. Anything that states a
price we didn't authorise, leaks the promo early, runs too long, or comes back
empty is discarded and the static template is sent instead. The LLM can vary
the wording; it cannot invent the offer.
"""

from __future__ import annotations

import logging
import re

from . import chat_examples, knowledge
from .config import Settings
from .models import Conversation, Intent

log = logging.getLogger(__name__)

#: Templates that may be LLM-generated. Operational messages (meeting links,
#: reminders, confirmations) stay static — they carry data, not persuasion.
GENERATIVE_KEYS: frozenset[str] = frozenset(
    {
        "REPLY_TANYA_SISTEM",
        "REPLY_TANYA_HARGA",
        "REPLY_PAKET_DETAIL",
        "REPLY_TANYA_PORTOFOLIO",
        "REPLY_TANYA_LOKASI",
        "REPLY_TANYA_KOMISI",
        "REPLY_TANYA_PEMBAYARAN",
        "REPLY_TANYA_AFFILIATE",
        "REPLY_TANYA_SAMPLE",
        "REPLY_TANYA_TIMELINE",
        "REPLY_NEGO_HARGA",
        "REPLY_MINTA_KONTRAK",
        "REPLY_MINTA_TELEPON",
        # REPLY_TERIMA_KASIH left on 14 Aug too, same reason.
        # REPLY_TOLAK_HALUS, REPLY_TERUSKAN_TIM and REPLY_PELAJARI_DULU left
        # on 14 Aug 2026: the BD team wrote all three verbatim. Paraphrasing
        # operator-authored copy throws away the wording they chose and pays
        # an API call to do it — and a generated REPLY_TERUSKAN_TIM invented
        # an email address that the reply cache then replayed to three other
        # brands. Same reason as REPLY_TOLAK_TEGAS below.
        # REPLY_TOLAK_TEGAS is deliberately absent from 31 Jul 2026: it now
        # carries the named list of other service lines, and a generator asked
        # to vary it will improvise a service, a scope, or a sweetener at the
        # exact moment a brand has said no.
        "REPLY_FREEFORM",
        "REPLY_GREETING_NEEDS",
        "OFFER_MEETING",
        "COLD_FU2",
        "COLD_FU3",
        "WARM_D2",
        "WARM_D5",
    }
)

#: Direct replies to an inbound message — the conversation is already running,
#: so these must not open with another greeting. Follow-ups after a silence
#: (COLD_FU*, WARM_*) may greet: days can have passed.
REPLY_KEYS: frozenset[str] = (
    frozenset(k for k in GENERATIVE_KEYS if k.startswith("REPLY_"))
    | {"OFFER_MEETING"}
) - {"REPLY_GREETING_NEEDS"}  # answering their "halo" with a halo is natural

#: Generated replies that may be saved and reused for other contacts, so a
#: template that has already been generated a few times stops costing API
#: calls. REPLY_FREEFORM is excluded: its content answers the specific inbound
#: message, so a reuse would reply to the wrong question.
CACHEABLE_KEYS: frozenset[str] = GENERATIVE_KEYS - {"REPLY_FREEFORM"}

#: Only these templates are allowed to mention the promo price.
PROMO_KEYS: frozenset[str] = frozenset({"COLD_FU4"})

#: Only these templates may voice the sample-replacement guarantee
#: (knowledge.GUARANTEE); "garansi" anywhere else is treated as invented.
GUARANTEE_KEYS: frozenset[str] = frozenset({"REPLY_TANYA_SAMPLE"})

#: The only shape in which "garansi" may be written outside GUARANTEE_KEYS:
#: one that denies it. See validate().
_REFUSED_GUARANTEE_RE = re.compile(
    r"\b(tidak|tdk|ga|gak|nggak|enggak|bukan|belum|tanpa)\b(?:\s+\w+){0,3}\s+garansi",
    re.IGNORECASE,
)

MAX_REPLY_CHARS = 900

_STYLE = """\
GAYA BAHASA (wajib):
- Bahasa Indonesia, formal namun hangat. Sapa dengan "Kak"/"Kakak" SAJA —
  JANGAN pernah menyebut nama orang kontak. Nama brand boleh disebut.
- Profesional dan informatif — setiap kalimat harus membawa informasi baru.
- RINGKAS. Maksimal 4 kalimat atau 2 paragraf pendek. Jangan bertele-tele.
- Jangan berlebihan memuji, jangan pakai bahasa iklan yang kosong.
- Maksimal satu emoji, dan hanya bila benar-benar wajar. Boleh tanpa emoji.
- Jangan gunakan bullet point kecuali menyebut daftar layanan atau paket.
- Untuk meeting, sebut "meeting singkat" saja — JANGAN pernah menyebut durasi
  dalam menit (mis. "20–30 menit").
- Akhiri dengan satu pertanyaan atau ajakan yang jelas, bila relevan.
"""

_RULES = """\
ATURAN KERAS (melanggar = jawaban dibuang):
- HANYA gunakan fakta dari FACT SHEET di bawah. Jangan mengarang angka, klaim,
  diskon, garansi, atau nama klien apa pun.
- Jangan menyebut harga yang tidak ada di FACT SHEET.
- Jangan menjanjikan hasil spesifik (misal "dijamin naik 3x").
- Jangan menyebut promo kecuali diinstruksikan secara eksplisit.
- Jangan meminta data pribadi, pembayaran, atau kredensial.
- Tulis HANYA isi pesan WhatsApp. Tanpa pembuka meta, tanpa tanda kutip,
  tanpa penjelasan tentang jawabanmu.
"""


def _system_prompt(cfg: Settings) -> str:
    prompt = (
        f"Kamu adalah {cfg.sender_name}, staf Business Development "
        f"{knowledge.COMPANY} yang menghubungi brand melalui WhatsApp untuk "
        "menawarkan kerja sama Campaign Affiliate. Jika memperkenalkan diri, "
        f"gunakan nama {cfg.sender_name} — abaikan nama staf yang muncul di "
        "contoh percakapan.\n\n"
        f"{_STYLE}\n{_RULES}\n"
        f"FACT SHEET:\n{knowledge.fact_sheet()}"
    )
    # Real exchanges from exported chats, as style grounding. The block itself
    # instructs the model to copy the tone but take facts from the sheet only —
    # and `validate` below enforces that regardless.
    dialogue = chat_examples.dialogue_block(
        cfg.chat_examples_dir, cfg.inbound_examples_dir
    )
    if dialogue:
        prompt = f"{prompt}\n{dialogue}"
    return prompt


def _few_shot(intent: Intent) -> list[dict[str, str]]:
    """The whiteboard's own Q&A pairs, as demonstration turns."""
    msgs: list[dict[str, str]] = []
    for ex in knowledge.examples_for(intent):
        msgs.append({"role": "user", "content": ex.question})
        msgs.append({"role": "assistant", "content": ex.answer})
    return msgs


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

#: Word forms ("15 juta") must be tried BEFORE bare digits, otherwise the
#: digit branch matches "15" and the unit is lost.
_AMOUNT_RE = re.compile(
    r"rp\s?(\d[\d.,]*\s?(?:juta|jt|miliar|m)\b|\d[\d.,]{1,})", re.IGNORECASE
)


def _normalise_amount(raw: str) -> str:
    # Trailing separators get swept up by the digit class ("Rp25.000.000,").
    cleaned = raw.strip().lower().rstrip(".,")
    cleaned = re.sub(r"\s+", " ", cleaned)
    # "10jt" and "10 juta" are the same number said two ways, and ALLOWED_
    # AMOUNTS is a set of numbers, not spellings. The jt->juta substitution was
    # here from the start but dropped the space, so "10jt" normalised to
    # "10juta" and could never equal the "10 juta" in the allow-set — every
    # shorthand amount was rejected as unauthorised no matter what was
    # published. Real agent turns in chat-example/ use "jt" constantly.
    return re.sub(r"(\d)\s*jt\b", r"\1 juta", cleaned)


#: A greeting clause at the very start of a reply: "Siang Kak Cika,",
#: "Halo Kak,", "Selamat sore Kak Budi!" … up to the first ,/./! separator.
_GREETING_RE = re.compile(
    r"^(?:halo|hai|selamat\s+(?:pagi|siang|sore|malam)|pagi|siang|sore|malam)"
    r"[^,.!\n]{0,40}[,.!]\s*",
    re.IGNORECASE,
)


#: "sekitar 20–30 menit", "15-30 menit", "selama 30 menit" … The word stays
#: out of outbound copy entirely: the ask is always just "meeting singkat".
_DURATION_RE = re.compile(
    r"\s*(?:sekitar|selama|kurang lebih|±)?\s*\d{1,3}\s*(?:[–—-]\s*\d{1,3})?\s*menit\b",
    re.IGNORECASE,
)


def strip_durations(text: str) -> str:
    """Remove meeting-duration mentions ("sekitar 20–30 menit") outright.

    "diskusi singkat sekitar 20–30 menit untuk…" -> "diskusi singkat untuk…"
    """
    return re.sub(r"  +", " ", _DURATION_RE.sub("", text))


#: "10%", "4-5 %", "7,5%" … A percentage in chat reads as a commitment, so
#: only the figures BD has authorised may be said (knowledge.ALLOWED_PERCENTS
#: — currently the MCN opening cut alone). Everything else is invented, and
#: the final number is still negotiated by a human: flow escalates NEGO_HARGA.
_PERCENT_RE = re.compile(r"\d+(?:[.,]\d+)?\s*%")

#: "5 bulan", "3-4 bulan" … The real chats contradict each other on campaign
#: duration for the same package, so only the authorised lengths may be stated
#: (knowledge.ALLOWED_DURATIONS — one per tier). Anything else is the corpus's
#: disagreement leaking back out. Note this checks the FIGURE only: it cannot
#: catch 6 bulan attached to the wrong package, which is what the situation
#: briefs and the fact sheet are for.
_MONTH_DURATION_RE = re.compile(r"\b\d+\s*(?:[–—-]\s*\d+\s*)?bulan\b", re.IGNORECASE)


#: Clause boundaries — a percentage is judged by the clause it sits in, not by
#: the whole message, or one authorised figure would license every other
#: percentage in the same reply.
_CLAUSE_SPLIT_RE = re.compile(r"[.;\n]|(?<=\s)[—–-](?=\s)|,")

#: The authorised percentage is authorised for ONE claim: the MCN commission
#: opening. The same digits mean something else everywhere they appear in the
#: corpus — "komisi affiliate di 10% dulu ya kak" attaches it to the wrong side
#: of the deal (the affiliate's cut follows the brand's open plan and has no
#: number we may state), and "sekitar 10% di antaranya kami handle secara
#: end-to-end" is a portfolio claim the fact sheet does not make at all. So the
#: clause must name MCN, not merely avoid naming something else.
_MCN_CLAUSE_RE = re.compile(r"\bmcn\w*\b", re.IGNORECASE)


#: The commission on GMV from ads, printed per category on the bundling pages
#: (Beauty 8%, F&B 5%, Fashion 8%, Home Living 8%). It is a DIFFERENT number
#: from the MCN cut, and the guard has to know that: with both sets merged
#: into one list, "Komisi ke MCN biasanya di 5% ya, Kak" passed — the clause
#: named MCN, 5% was in the set, and a brand was told our cut is half what it
#: is. A figure is therefore judged by the clause it sits in, per set.
#: Clauses are cut at commas, so "komisi GMV dari ads, kategori Beauty di 8%"
#: puts the figure in a clause that no longer says GMV. The category name is
#: the other half of the same label and is accepted in its place — it is still
#: specific to these figures, and still cannot name MCN.
_ADS_GMV_CLAUSE_RE = re.compile(
    r"\bgmv\b|\bbeauty\b|\bf ?& ?b\b|\bfashion\b|\bhome ?living\b", re.IGNORECASE
)


def _unauthorised_percents(text: str) -> list[str]:
    mcn_only = {knowledge.MCN_COMMISSION.replace(" ", "")}
    gmv_only = {v.replace(" ", "") for v in knowledge.ADS_GMV_COMMISSION.values()}
    bad: list[str] = []
    for clause in _CLAUSE_SPLIT_RE.split(text):
        names_mcn = bool(_MCN_CLAUSE_RE.search(clause))
        names_gmv = bool(_ADS_GMV_CLAUSE_RE.search(clause))
        for m in _PERCENT_RE.finditer(clause):
            figure = m.group(0).replace(" ", "")
            # The MCN opening cut, in a clause that says so.
            if figure in mcn_only and names_mcn:
                continue
            # A category's commission on GMV from ads — only where the clause
            # says GMV, and never where it also says MCN: that sentence would
            # be attaching a bundling figure to our own cut.
            if figure in gmv_only and names_gmv and not names_mcn:
                continue
            bad.append(m.group(0))
    return bad


#: Any claim about where a contact's details came from. `knowledge.py` does
#: not record this, so a generated answer can only be invented — and it is
#: invented at the worst possible moment, to someone asking about their own
#: privacy. Seen live 30 Jul 2026: "Kontak brand kami dapatkan dari data
#: publik terkait informasi bisnis", which no one at MCNAsia had authorised.
#: REPLY_TANYA_SUMBER_KONTAK answers this instead, without naming a source.
#: Anchored on a *getting* verb, never on "dari" alone — REPLY_TANYA_SUMBER_
#: KONTAK offers to remove them "dari daftar", which is the opposite of a
#: provenance claim and tripped an earlier draft of this rule.
_PROVENANCE_RE = re.compile(
    r"\b(nomor|kontak|data)\w*\b[^.!?]{0,60}"
    r"\b\w*(dapat|dapet|peroleh|ambil|temukan|dpt)\w*\b[^.!?]{0,25}\b(dari|melalui|lewat)\b"
    r"|\b\w*(dapat|dapet|peroleh|ambil)\w*\b[^.!?]{0,30}"
    r"\b(dari|melalui|lewat)\s+(data\s+publik|database|direktori|marketplace)\b",
    re.IGNORECASE,
)

#: The one sourcing claim BD has authorised (knowledge.CONTACT_SOURCE). A
#: clause naming it is allowed to say where the contact came from; anything
#: else claiming a source is invented, whatever it names.
_AUTHORISED_SOURCE_RE = re.compile(
    r"tiktok\s*affiliate\s*partner|\btap\b", re.IGNORECASE
)


def _invents_provenance(text: str) -> bool:
    """True when the text claims a contact source other than the authorised one."""
    for clause in _CLAUSE_SPLIT_RE.split(text):
        if _PROVENANCE_RE.search(clause) and not _AUTHORISED_SOURCE_RE.search(clause):
            return True
    return False


def _unauthorised_durations(text: str) -> list[str]:
    allowed = {d.lower().replace(" ", "") for d in knowledge.ALLOWED_DURATIONS}
    return [
        m.group(0)
        for m in _MONTH_DURATION_RE.finditer(text)
        if m.group(0).lower().replace(" ", "") not in allowed
    ]

#: A price followed by a monthly unit: "Rp10 juta per bulan",
#: "Rp5.000.000/bulan", "8jt sebulan". Anchored on the amount so the
#: client-GMV claim ("Rp1–2 miliar per bulan") and affiliate counts ("setiap
#: bulan") stay legal — only a *price* followed by a monthly unit matches.
#:
#: The amount is captured because since 18 Aug 2026 the answer depends on
#: WHICH price: the affiliate fee is per campaign (on 29 Jul 2026 a generated
#: reply billed it monthly to a tester, setting them up to plan around a
#: recurring cost we do not charge), while the ads packages on page 2 of the
#: deck genuinely ARE monthly. A flat ban would now block the bot from stating
#: ads pricing correctly.
_MONTHLY_PRICE_RE = re.compile(
    r"(?:rp\s?)?(\d[\d.,]*\s?(?:juta|jt))\s*(?:/|per\s+|se)bulan\b"
    r"|rp\s?(\d[\d.,]{4,})\s*(?:/|per\s+|se)bulan\b",
    re.IGNORECASE,
)


def _wrongly_monthly(text: str) -> str:
    """The first per-campaign price quoted with a monthly unit, or "".

    An amount that is neither per-campaign nor per-month is not judged here —
    it is already rejected wholesale by the ALLOWED_AMOUNTS loop in validate,
    and double-reporting it would give a misleading reason.
    """
    per_month = {_normalise_amount(a) for a in knowledge.PER_MONTH_AMOUNTS}
    for m in _MONTHLY_PRICE_RE.finditer(text):
        raw = m.group(1) or m.group(2)
        if _normalise_amount(raw) not in per_month:
            return m.group(0)
    return ""

#: Content that disqualifies a real agent turn from teaching style: guarantee
#: phrasing the validator rejects as output, and the tax-workaround habit
#: ("non pajak juga bisa") that knowledge.py deliberately does not authorise.
_UNTEACHABLE = (
    "garansi",
    "jamin",  # "kami jamin", "dijamin", "menjamin"
    "pasti akan",
    "pasti naik",
    "100%",
    "non pajak",
    "non-pajak",
    "tanpa pajak",
)


def teaches_safely(text: str) -> bool:
    """May this real agent turn be shown to the model as a style example?

    Shared with chat_examples.py so the prompt and the validator can never
    disagree: nothing enters the prompt that the validator would reject if
    the model reproduced it."""
    lowered = text.lower()
    if any(banned in lowered for banned in _UNTEACHABLE):
        return False
    if _unauthorised_percents(text) or _unauthorised_durations(text):
        return False
    # The exports are full of "mulai dari Rp25 juta per bulan" — the wording
    # that taught the generator to bill monthly. Keep them out of the prompt.
    if _wrongly_monthly(text):
        return False
    return True


def strip_reply_greeting(text: str) -> str:
    """Drop a leading greeting clause from a mid-conversation reply.

    The opening blast already greeted; replying "Siang Kak" again reads like
    the bot forgot it was mid-conversation (and real agents don't do it —
    see chat-example/). Only the clause is dropped, never content: if what
    remains is suspiciously short, the text goes out untouched.
    """
    m = _GREETING_RE.match(text.strip())
    if not m:
        return text
    rest = text.strip()[m.end():].lstrip()
    if len(rest) < 40:
        return text
    return rest[0].upper() + rest[1:]


def validate(text: str, key: str) -> tuple[bool, str]:
    """Returns (ok, reason). Anything not ok falls back to the static template."""
    stripped = text.strip()

    if not stripped:
        return False, "empty"
    if len(stripped) > MAX_REPLY_CHARS:
        return False, f"too long ({len(stripped)} chars)"
    if "{" in stripped or "}" in stripped:
        return False, "unrendered placeholder"

    allowed = {_normalise_amount(a) for a in knowledge.ALLOWED_AMOUNTS}
    for match in _AMOUNT_RE.finditer(stripped):
        amount = _normalise_amount(match.group(1))
        # "Rp1–2 miliar" is a client-GMV claim, not a price.
        if "miliar" in amount:
            continue
        if amount not in allowed:
            return False, f"unauthorised amount: Rp{match.group(1)}"

    # Only meaningful while a promo exists. With none published, any amount
    # outside ALLOWED_AMOUNTS is already rejected above — including the
    # withdrawn Rp10 juta rescue, wherever it appears.
    if knowledge.PROMO is not None:
        promo_price = knowledge.PROMO.price_label.lower().replace("rp", "").strip()
        if key not in PROMO_KEYS and promo_price in stripped.lower():
            return False, "leaked promo price outside the rescue follow-up"

    # Commission (and any other) percentages: the fact sheet states none, so
    # a percent figure can only be invented — and a number said in chat reads
    # as a commitment. flow.py escalates negotiation to a human instead.
    stray_percents = _unauthorised_percents(stripped)
    if stray_percents:
        return False, f"unauthorised percentage: {stray_percents[0]}"

    stray_durations = _unauthorised_durations(stripped)
    if stray_durations:
        return False, f"unauthorised campaign duration: {stray_durations[0]}"

    if _invents_provenance(stripped):
        return False, (
            "claims the contact came from somewhere other than TikTok Affiliate Partner"
        )

    monthly = _wrongly_monthly(stripped)
    if monthly:
        return False, f"price quoted per bulan — the fee is per campaign: {monthly!r}"

    lowered = stripped.lower()
    # The sample-replacement guarantee is an authorised fact (knowledge.
    # GUARANTEE) — only its own template may voice it; everywhere else
    # "garansi"/"dijamin" means the model invented a promise.
    banned_words = ("dijamin", "pasti naik", "100% ")
    for banned in banned_words:
        if banned in lowered:
            return False, f"unsupported guarantee: {banned!r}"

    # "garansi" is judged by the phrase around it, not by its presence. A
    # substring check cannot tell a promise from its refusal, and the refusal
    # is the answer we actually want: "dijamin naik gak GMV nya?" was answered
    # "kami tidak bisa memberikan garansi angka spesifik…" and thrown away for
    # containing the word, so the brand got the blander static template
    # instead of a straight no. The window is three words wide on purpose —
    # "tidak ada minimal order dan garansi kami berikan" must still be
    # rejected, and it sits just outside it.
    if key not in GUARANTEE_KEYS and "garansi" in lowered:
        if len(_REFUSED_GUARANTEE_RE.findall(lowered)) != lowered.count("garansi"):
            return False, "unsupported guarantee: 'garansi'"

    # Every generated text answers someone who has already had the opening —
    # the blast is a static template and is not generated here. Introducing
    # the company again restarts the pitch and reads as though the bot forgot
    # the conversation. Seen live: a tester answered the opening with "siang"
    # and was introduced to MCNAsia a second time, ninety seconds after the
    # first, which they reported as the bot not understanding them.
    for phrase in ("perkenalkan", "salam kenal", "izin memperkenal"):
        if phrase in lowered:
            return False, f"re-introduces the company: {phrase!r}"

    return True, ""


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------


def generate(
    key: str,
    intent: Intent,
    convo: Conversation,
    inbound: str,
    fallback: str,
    cfg: Settings,
) -> str:
    """Return a grounded reply, or `fallback` if anything is off.

    Never raises: a failure here must not stop the conversation.
    """
    if key not in GENERATIVE_KEYS:
        return fallback
    if not cfg.anthropic_api_key:
        return fallback

    try:
        import anthropic
    except ImportError:
        log.warning("anthropic not installed; using static template")
        return fallback

    brand = convo.brand or "brand Kakak"

    no_greeting = (
        "\nCATATAN: percakapan sudah berjalan — JANGAN membuka dengan salam "
        "(halo/hai/selamat pagi/siang/sore). Langsung ke isi, misalnya "
        "'Baik, Kak …'."
        if key in REPLY_KEYS
        else ""
    )
    from datetime import datetime as _dt

    from .templates import salam

    task = (
        f"Sapaan kontak: Kak (jangan gunakan nama)\n"
        # The generator opened a reply with "Siang, Kak" at 23.08 because
        # nothing told it what time it was.
        f"Waktu sekarang: {salam(_dt.now(tz=cfg.tz))} "
        f"(gunakan sapaan waktu ini bila menyapa)\n"
        f"Brand: {brand}\n"
        f"Pesan terakhir dari brand: {inbound or '(tidak ada — ini follow-up)'}\n\n"
        f"Tulis balasan untuk situasi: {_situation(key)}{no_greeting}"
        # The opening has already been sent by the time anything here is
        # generated; the validator rejects a re-introduction outright, so say
        # it here too rather than paying for a generation that gets thrown away.
        "\nCATATAN: brand sudah menerima pesan pembuka — JANGAN memperkenalkan "
        "diri atau perusahaan lagi ('Perkenalkan, saya … dari …')."
    )

    try:
        client = anthropic.Anthropic(api_key=cfg.anthropic_api_key)
        resp = client.messages.create(
            model="claude-sonnet-5",
            # 700, not 500: the longest legitimate reply is REPLY_PAKET_DETAIL,
            # which since the 18 Sep deck lists all three affiliate tiers and
            # measured 377 output tokens. MAX_REPLY_CHARS (900) is what really
            # governs length; this only has to sit far enough above it that
            # stopping here means something went wrong.
            max_tokens=700,
            system=_system_prompt(cfg),
            messages=[*_few_shot(intent), {"role": "user", "content": task}],
        )
        # A reply that ran out of tokens ends mid-sentence, and NOTHING below
        # catches that: validate() checks for text that is too long, invented
        # figures and banned words, all of which a half sentence passes. The
        # brand would be sent "...dengan durasi kerja bisa mencapai" and left
        # to guess. The static template says less but always finishes.
        if resp.stop_reason == "max_tokens":
            log.warning("generation hit max_tokens (cut mid-sentence); using static template")
            return fallback
        # The model may emit a thinking block before the text — take only
        # the text blocks, not content[0] blindly.
        text = "".join(
            block.text
            for block in resp.content
            if getattr(block, "type", "") == "text"
        ).strip()
    except Exception:
        log.exception("reply generation failed; using static template")
        return fallback

    if key in REPLY_KEYS:
        text = strip_reply_greeting(text)
    text = strip_durations(text)

    ok, reason = validate(text, key)
    if not ok:
        log.warning("generated reply rejected (%s); using static template", reason)
        return fallback

    log.debug("generated reply for %s", key)
    return text


#: What each template is for, in the model's own working language.
_SITUATIONS: dict[str, str] = {
    "REPLY_TANYA_SISTEM": (
        "brand menanyakan bagaimana sistem kerja sama ini berjalan — jelaskan "
        "ringkas: kami mencarikan affiliate sesuai kategori dan kebutuhan "
        "brand, affiliate membuat video konten di TikTok/Shopee, dan kami "
        "memonitor sample, progres konten, serta performa harian. Alasan "
        "untuk meeting adalah PENGALAMAN KAMI menangani brand serupa — "
        "JANGAN pernah beralasan dengan kondisi brand mereka ('karena brand "
        "Kakak masih baru/masih kecil'), itu tebakan tentang mereka. WAJIB "
        "akhiri dengan ajakan meeting online singkat (tanpa menyebut durasi)"
    ),
    "REPLY_TANYA_CUSTOM": (
        "brand menanyakan apakah paket bisa disesuaikan (custom, digabung, "
        "dipecah, volume di luar paket) — jawab BISA, tapi JANGAN menjanjikan "
        "susunan atau kombinasi apa pun. SATU pengecualian untuk angka: bila "
        "brand menyebut 'Paket Custom Eksklusif' (produk di deck, minimal "
        "+500 akun affiliate), batas bawahnya boleh disebut sebagai 'mulai "
        "Rp50.000.000' — kata 'mulai' wajib ikut. Di luar itu tidak ada angka "
        "sama sekali; katakan detailnya dibahas bersama tim di meeting, lalu "
        "ajak meeting online singkat"
    ),
    "REPLY_TANYA_HARGA": (
        # The label is "tanya_harga" and the rule that produces it fires on a
        # bare "berapa" — so since the 18 Sep deck it also catches "full
        # service itu berapa kak? terus kalau TVC?", a question this brief
        # used to answer with the affiliate ladder and not one word about
        # either service the brand named. There is no separate label for the
        # other priced services; the fact sheet carries their figures and the
        # validator guards them, so the brief branches instead.
        "PERTAMA, periksa apakah brand menyebut NAMA layanan selain Campaign "
        "Affiliate (Full Service, TVC Production, Special Bundle, Shopee Ads "
        "+ Manage Ecommerce, Paket Custom Eksklusif). Bila ya: jawab harga "
        "layanan ITU dari FACT SHEET — lengkap dengan kata 'mulai' bila "
        "angkanya batas bawah — jangan menggantinya dengan paket affiliate, "
        "lalu tutup dengan ajakan meeting singkat. Bila brand menyebut lebih "
        "dari satu layanan, jawab semuanya. SELEBIHNYA, untuk pertanyaan "
        "harga affiliate: "
        "brand menanyakan harga untuk PERTAMA kali — sebutkan paket terkecil "
        "saja sebagai anchor: mulai Rp10 juta PER CAMPAIGN (jangan pernah "
        "'per bulan'), isinya 100 affiliate dan minimal 100 video, durasi "
        "kerja 2 bulan. Sebutkan bahwa DI ATASNYA ada paket 200 dan 300 "
        "affiliate dengan periode lebih panjang, TANPA menyebut harganya — "
        "daftar harga lengkap baru dikirim setelah tahu kebutuhan mereka. "
        "Sampaikan harga masih bisa kami sesuaikan, TANPA menyebut angka, "
        "diskon, atau potongan apa pun, lalu tanyakan berapa kebutuhan "
        "affiliate mereka. Tutup dengan pertanyaan fokus mereka (awareness, "
        "penjualan, atau keduanya)"
    ),
    "REPLY_PAKET_DETAIL": (
        "brand menanyakan detail paket (sering dalam bentuk 'berapa naiknya "
        "GMV?') setelah sebelumnya sudah diberi anchor harga — mulai dengan "
        "menolak menjanjikan angka pertumbuhan, sebutkan kisaran GMV klien "
        "kami hanya sebagai gambaran (BUKAN proyeksi untuk mereka), lalu "
        "sebutkan KETIGA paket affiliate lengkap dengan durasinya: 100 "
        "Affiliate + minimal 100 video Rp10.000.000 (2 bulan), 200 Affiliate "
        "+ minimal 200 video Rp18.000.000 (4 bulan), 300 Affiliate + minimal "
        "300 video Rp25.000.000 (6 bulan). Ini pertanyaan KEDUA soal harga, "
        "jadi daftar lengkapnya memang sudah boleh dibuka — jangan berhenti "
        "di satu paket saja"
    ),
    "REPLY_TANYA_PORTOFOLIO": (
        "brand meminta portofolio, credential, studi kasus, atau bukti "
        "performa (GMV/dashboard) — sampaikan pengalaman kami di kategori "
        "serupa TANPA mengarang nama klien di luar FACT SHEET, lalu tawarkan "
        "mempresentasikan studi kasus dan report melalui meeting singkat"
    ),
    "REPLY_TANYA_LOKASI": (
        "brand menanyakan lokasi kantor, ingin berkunjung, atau meragukan "
        "legitimasi kami — sebutkan alamat kantor dari FACT SHEET, persilakan "
        "berkunjung, dan tenangkan bahwa kerja sama selalu diawali kontrak "
        "resmi sebelum pembayaran apa pun; akhiri dengan ajakan meeting "
        "singkat atau kunjungan"
    ),
    "REPLY_TANYA_KOMISI": (
        "brand menanyakan skema komisi (komisi affiliate vs komisi MCN, atau "
        "menganggapnya dobel) — jelaskan skema dari FACT SHEET: komisi "
        "affiliate mengikuti open plan yang ditetapkan brand, komisi ke MCN "
        "dibuka di 10% dan masih bisa dinegosiasikan, settlement otomatis via "
        "TAP dan hanya saat ada penjualan. 10% adalah SATU-SATUNYA persentase "
        "yang boleh disebut; akhiri dengan ajakan meeting singkat"
    ),
    "REPLY_TANYA_PEMBAYARAN": (
        "brand menanyakan cara pembayaran (per bulan atau per campaign, DP "
        "atau full, pajak) — jelaskan sesuai FACT SHEET: biaya dihitung per "
        "campaign (bukan tagihan bulanan), dibayar satu kali di awal "
        "setelah kontrak ditandatangani dan invoice terbit, dengan durasi "
        "campaign 2 bulan; hal pajak "
        "arahkan ke diskusi dengan tim; akhiri dengan ajakan meeting singkat"
    ),
    "REPLY_TANYA_AFFILIATE": (
        "brand menanyakan kriteria/profil affiliate (follower, niche, list, "
        "jumlah video per creator, TikTok vs Shopee) — jelaskan kurasi "
        "sesuai FACT SHEET tanpa menjanjikan angka follower/GMV spesifik, "
        "dan sampaikan list affiliate baru dibagikan setelah DEAL kerja sama "
        "dan diskusi kriteria — jangan pernah menjanjikannya lebih awal; "
        "akhiri dengan "
        "ajakan meeting singkat"
    ),
    "REPLY_TANYA_SAMPLE": (
        "brand menanyakan pengiriman sample atau apa yang terjadi bila "
        "affiliate tidak membuat video — jelaskan alur sample dan garansi "
        "penggantian sesuai FACT SHEET; akhiri dengan ajakan meeting singkat"
    ),
    "REPLY_TANYA_TIMELINE": (
        "brand menanyakan berapa lama sampai campaign berjalan — jelaskan "
        "alur kontrak → invoice → pembayaran → persiapan 7–14 hari → campaign "
        "berjalan, sesuai FACT SHEET; akhiri dengan ajakan meeting singkat"
    ),
    "REPLY_NEGO_HARGA": (
        "brand meminta harga diturunkan — sebutkan ketiga paket yang ada "
        "(100 Affiliate Rp10.000.000, 200 Affiliate Rp18.000.000, 300 "
        "Affiliate Rp25.000.000), sampaikan "
        "dengan sopan bahwa harganya sudah nett, namun komisi ke "
        "MCNASIA masih bisa didiskusikan; minta angka yang diharapkan untuk "
        "disampaikan ke manajemen. JANGAN menyetujui atau menyebut angka "
        "diskon apa pun"
    ),
    "REPLY_MINTA_KONTRAK": (
        "brand meminta draft kontrak untuk direview — sampaikan tim legal "
        "kami akan menyiapkan draft-nya, tidak ada pembayaran sebelum "
        "kontrak disepakati, dan kami terbuka atas revisi"
    ),
    "REPLY_MINTA_TELEPON": (
        "brand ingin ditelepon atau memakai link Zoom mereka sendiri — "
        "arahkan dengan sopan ke Google Meet sesuai SOP (tim dan manajemen "
        "ikut bergabung, bisa share screen), lalu minta hari, jam, dan email "
        "untuk undangannya"
    ),
    "REPLY_TERUSKAN_TIM": "brand akan meneruskan penawaran ke timnya",
    "REPLY_PELAJARI_DULU": "brand ingin mempelajari materinya terlebih dahulu",
    "REPLY_TERIMA_KASIH": (
        "brand berterima kasih namun belum berkomitmen — tutup dengan sopan dan "
        "tawarkan company profile sebagai referensi"
    ),
    "REPLY_TOLAK_HALUS": (
        "brand menolak secara halus (belum butuh sekarang) — terima dengan "
        "lapang, lalu tanyakan kebutuhan brand saat ini lebih fokus ke mana "
        "(penjualan, awareness, atau lainnya), dan titipkan company profile. "
        "Jangan memaksa"
    ),
    # Kept though REPLY_TOLAK_TEGAS left GENERATIVE_KEYS on 31 Jul 2026: an
    # unused brief costs nothing, and it is the description to restore from if
    # the service list ever moves out of the template again.
    "REPLY_TOLAK_TEGAS": (
        "brand menyatakan tidak tertarik — terima dengan sopan, jangan "
        "membujuk lagi, namun tanyakan kebutuhan brand saat ini seperti apa "
        "sebagai penutup, sebutkan NAMA layanan lain kami tanpa harga/cakupan/"
        "jaminan apa pun, dan titipkan company profile sebagai referensi"
    ),
    "REPLY_GREETING_NEEDS": (
        "brand hanya membalas singkat ('halo', 'iya') setelah pesan pembuka — "
        "jelaskan singkat bahwa kami menawarkan kerja sama Campaign Affiliate "
        "untuk meningkatkan penjualan dan awareness produk brand, lalu "
        "tanyakan kebutuhan brand saat ini lebih fokus ke mana"
    ),
    "REPLY_FREEFORM": (
        "pesan brand tidak cocok dengan kategori standar mana pun — jawab isi "
        "pesannya secara langsung dan relevan, seperti pada contoh percakapan "
        "nyata. Jika brand menceritakan kondisi atau kategori brand-nya, "
        "respons dengan relevan lalu arahkan ke meeting singkat. Jika ada "
        "pertanyaan yang jawabannya tidak ada di FACT SHEET, jangan mengarang "
        "— tawarkan membahasnya di meeting. Jika pesannya benar-benar tidak "
        "jelas, minta klarifikasi dengan sopan"
    ),
    "OFFER_MEETING": (
        "ajak brand untuk meeting singkat agar pembahasan lebih spesifik, "
        "lalu tanyakan kesediaannya dijadwalkan"
    ),
    "COLD_FU2": (
        "follow-up untuk brand yang belum membalas — tanyakan area kebutuhan "
        "mereka saat ini agar penawaran lebih relevan"
    ),
    "COLD_FU3": (
        "follow-up untuk brand yang belum membalas — sampaikan bukti pengalaman "
        "kami dan tawarkan studi kasus yang relevan"
    ),
    "WARM_D2": (
        "brand sempat merespons lalu berhenti — tindak lanjuti, tawarkan meeting "
        "singkat, sampaikan kami terbuka menyesuaikan paket dan budget"
    ),
    "WARM_D5": (
        "brand masih belum memberi kabar — tanyakan apakah sudah sempat "
        "berdiskusi dengan tim, tanpa menekan"
    ),
}


def _situation(key: str) -> str:
    return _SITUATIONS.get(key, "balas pesan brand dengan sopan dan relevan")
