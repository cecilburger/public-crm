"""Reading a brand's reply the way a person would — in context, before answering.

The rule classifier reads one message at a time and matches words. That is how
the bot came to answer a switchboard's opening hours ("Silahkan hubungi kami
kembali pada Jam Operasional yaitu hari Senin s/d Jumat pukul 09.00 - 18.00")
with *"Senin 17/08 jam 09.00 saya catat ya"*, how "baik kak 😊 -okt" became
agreement to a meeting six times in a row, and how "Boleh langsung ke email
marketing@… aja ya kak" was classified `setuju` — so the brand who had just
handed over an address was asked for their address.

This module asks Claude to read the last few turns and answer the questions the
flow actually needs answered, before anything is sent:

* is a **person** typing, or is this the brand's own bot?
* is it **mere politeness** — "baik kak", "oooh okeyy" — carrying no decision?
* did they hand over an **email** or somebody else's **number**?
* did they choose a **meeting time**, or is that a time that belongs to some
  other sentence entirely (their office hours, "5 menit kedepan", a delivery
  estimate)?
* have they, in effect, told us to **stop**?

Everything here degrades to "no opinion": no key, no package, a timeout, bad
JSON — `read()` returns a `Reading` with `understood=False` and the caller
falls back to the rules it used before. It can slow a reply down; it can never
stop one going out.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass, field
from datetime import date, datetime

from .config import Settings
from .models import Intent

log = logging.getLogger(__name__)

#: Sonnet, on the operator's instruction (21 Aug 2026): "use sonnet to
#: understand and think first before replying". The intent *fallback* still
#: runs on Haiku — it answers a much narrower question about a single message.
MODEL = "claude-sonnet-5"

#: Turns of history shown to the model, newest last. Four exchanges is enough
#: to tell "baik kak" answering a slot proposal from "baik kak" answering a
#: price, and short enough to stay cheap on every inbound message.
HISTORY_TURNS = 8

#: Room for the JSON *and* the model's own thinking, which is billed against
#: the same ceiling: at 700 a reading occasionally spent it all on thinking and
#: returned an empty text block, which reads here as a format failure and
#: silently drops back to the rules.
MAX_TOKENS = 2000

TIMEOUT_SECONDS = 20.0


@dataclass(frozen=True)
class Reading:
    """What one inbound message means, read against the turns before it."""

    understood: bool = False
    """False when no model was consulted, or its answer could not be used.
    Every other field is then meaningless and the caller must fall back."""

    intent: Intent | None = None
    automated: bool = False
    """A machine wrote this — the brand's WhatsApp Business bot, a queue
    notice, an out-of-hours notice, a menu."""

    politeness_only: bool = False
    """"Baik kak 😊🙏🏻", "Oooh okeyy" — acknowledgement, not a decision. It is
    not agreement, and answering it with a slot list reads as not listening."""

    ends_conversation: bool = False
    """They have told us, in whatever words, that this thread is over: a
    refusal, a redirect elsewhere, or a bot closing the chat."""

    reason: str = ""
    """One line, in Indonesian or English, for the log and the escalation."""

    email: str = ""
    """An address they handed us to send the offer to. NOT the address for a
    Google Meet invitation — those arrive when we asked for one."""

    phones: list[str] = field(default_factory=list)
    """Other people's numbers they pointed us at."""

    meeting_day: date | None = None
    meeting_hour: int | None = None
    """A time they chose for OUR meeting — never their opening hours, never a
    number that happens to look like a clock."""

    remembered: bool = False
    """This reading came out of the learned cases, not out of a fresh call."""

    def picked_a_time(self) -> bool:
        return self.meeting_day is not None and self.meeting_hour is not None

    def reusable(self) -> bool:
        """May this reading be learned and replayed for a similar message?

        Only when it says nothing that belongs to one message alone. An
        address, a number, a chosen day: those are read out of the words in
        front of us every time, never recalled — replaying a remembered
        address would send the proposal to the wrong brand.
        """
        return not (
            self.email or self.phones
            or self.meeting_day or self.meeting_hour is not None
        )


_SYSTEM = """\
Kamu membaca balasan WhatsApp dari perwakilan brand Indonesia kepada tim
Business Development MCNAsia (Grace), yang menawarkan kerja sama Campaign
Affiliate. Tugasmu BUKAN membalas. Tugasmu memahami pesan terakhir dengan
membaca percakapan sebelumnya, lalu menjawab dalam JSON.

Balas HANYA satu objek JSON, tanpa penjelasan, tanpa markdown fence:

{
  "intent": "<label>",
  "automated": true/false,
  "politeness_only": true/false,
  "ends_conversation": true/false,
  "email": "<alamat email yang mereka berikan, atau kosong>",
  "phones": ["<nomor orang lain yang mereka rujuk>"],
  "meeting_day": "YYYY-MM-DD atau kosong",
  "meeting_hour": <0-23 atau null>,
  "reason": "<satu kalimat singkat: apa maksud mereka>"
}

Label `intent` yang boleh dipakai:
{labels}

Cara membaca — ini bagian yang paling sering salah:

1. `automated`: true kalau yang menulis MESIN, bukan orang. Ciri: pemberitahuan
   antrean ("sedang dihubungkan dengan Customer Service"), jam operasional,
   ucapan selamat datang otomatis, menu bernomor, sapaan berbahasa Inggris yang
   sama persis tiap kali, atau pesan yang mengancam menutup chat sendiri
   ("percakapan ini akan kami akhiri dalam 5 menit"). Tanda tangan pendek dari
   admin ("-okt", "-sa") justru menandakan MANUSIA.

2. `politeness_only`: true kalau isinya cuma basa-basi/tanda terima — "baik
   kak", "oooh okeyy", "baik kak 😊🙏🏻", "siap kak" — tanpa keputusan,
   pertanyaan, atau janji baru. Ini BUKAN persetujuan meeting. Kalau pesan
   sebelumnya dari kami menawarkan jadwal atau meminta email, "baik kak" hanya
   berarti mereka membaca, bukan setuju dan bukan memberi email.

3. `meeting_day` / `meeting_hour`: HANYA kalau orang tersebut memilih waktu
   untuk meeting KITA. Jangan pernah mengambil angka jam dari: jam operasional
   mereka ("Senin s/d Jumat pukul 09.00 - 18.00", "open daily 9 AM to 9 PM"),
   batas waktu chat ("5 menit kedepan"), harga, tanggal kedaluwarsa, atau
   estimasi pengiriman. Kalau mereka menyebut hari saja ("Selasa aja yaa"),
   isi meeting_day dan biarkan meeting_hour null. Ambil HANYA dari pesan
   terakhir — hari yang disebut beberapa turn lalu bukan pilihan baru. Kalau
   ragu, kosongkan keduanya.

4. `email`: alamat yang mereka berikan supaya kami mengirim penawaran ke sana.
   Kalau kami yang meminta email untuk undangan Google Meet dan mereka
   menjawabnya, tetap isi — pemanggil yang memutuskan artinya.

5. `phones`: nomor ORANG LAIN yang mereka rujuk ("hubungi PIC kami di 0856…").
   Jangan masukkan nomor mereka sendiri, nomor hotline/CS, atau nomor kami.

6. `ends_conversation`: true kalau setelah pesan ini tidak ada gunanya kami
   melanjutkan penawaran ke orang ini: mereka menolak, mengarahkan ke pihak
   lain, meminta kami berhenti, memberi email/nomor sebagai jalur resmi, atau
   bot mereka menutup percakapan. False kalau mereka masih bertanya, masih
   mempertimbangkan, atau menunggu jawaban internal.

Kalau pesan terakhir tidak jelas, pakai intent "unknown" — jangan menebak
label yang menentukan (setuju, ok_lanjut, tolak_tegas).
"""


#: Trailing admin initials — "-okt", "-sa", "-dl". Three CS people signing the
#: same sentence must not be three different cases to learn.
_SIGNATURE_RE = re.compile(r"[\s\-–—]*-\s*[a-z]{1,4}\s*$")

#: Emoji and the punctuation people decorate with. "Baik kak 😊🙏🏻" and "baik
#: kak" are the same message and deserve the same answer.
_NOISE_RE = re.compile(
    r"[^\w@.+\-/: ]|[\U0001F000-\U0001FAFF\u2600-\u27BF\uFE0F\u200D]",
    re.UNICODE,
)


def normalize(text: str) -> str:
    """The message stripped to what makes it that message.

    Case, emoji, decoration and the signing initials come off; digits, "@" and
    "." stay, because an address or a phone number is exactly what must not be
    matched loosely.
    """
    probe = _NOISE_RE.sub(" ", (text or "").lower())
    probe = " ".join(probe.split())
    return _SIGNATURE_RE.sub("", probe).strip()


def fingerprint(context: str, text: str) -> str:
    """One key for "this message, arriving after that message of ours"."""
    return hashlib.sha1(
        f"{context}\n--\n{text}".encode("utf-8", "replace")
    ).hexdigest()


def to_dict(reading: Reading) -> dict:
    return {
        "intent": reading.intent.value if reading.intent else "",
        "automated": reading.automated,
        "politeness_only": reading.politeness_only,
        "ends_conversation": reading.ends_conversation,
        "reason": reading.reason,
    }


def from_dict(data: dict) -> Reading:
    """A remembered reading. Never carries per-message specifics — see
    `Reading.reusable`."""
    return Reading(
        understood=True,
        intent=_as_intent(data.get("intent")),
        automated=bool(data.get("automated")),
        politeness_only=bool(data.get("politeness_only")),
        ends_conversation=bool(data.get("ends_conversation")),
        reason=str(data.get("reason", ""))[:300],
        remembered=True,
    )


def _labels() -> str:
    return "\n".join(f"- {i.value}" for i in Intent)


def _history_block(history: list[tuple[str, str]]) -> str:
    """The recent turns, oldest first, labelled by who spoke."""
    lines = []
    for direction, body in history[-HISTORY_TURNS:]:
        who = "KAMI (Grace)" if direction == "out" else "BRAND"
        text = " ".join((body or "").split())[:600]
        lines.append(f"[{who}] {text}")
    return "\n".join(lines) or "(belum ada percakapan sebelumnya)"


def _json_object(raw: str) -> dict | None:
    """The first JSON object in the reply, or None.

    Fenced or prefixed output is common enough that failing on it would throw
    away a good answer; anything else is a real format failure.
    """
    match = re.search(r"\{.*\}", raw, re.DOTALL)
    if not match:
        return None
    try:
        got = json.loads(match.group(0))
    except ValueError:
        return None
    return got if isinstance(got, dict) else None


def _as_intent(value) -> Intent | None:
    try:
        return Intent(str(value).strip().lower())
    except ValueError:
        return None


def _as_day(value) -> date | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.strptime(text[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def _as_hour(value) -> int | None:
    try:
        hour = int(value)
    except (TypeError, ValueError):
        return None
    return hour if 0 <= hour <= 23 else None


def _as_phones(value) -> list[str]:
    if not isinstance(value, list):
        return []
    out = []
    for item in value:
        digits = re.sub(r"\D", "", str(item))
        if digits.startswith("0"):
            digits = "62" + digits[1:]
        if 11 <= len(digits) <= 15 and digits.startswith("62"):
            out.append(digits)
    return out


_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]{2,}")


def _as_email(value, text: str) -> str:
    """The address, checked against the message it supposedly came from.

    A model that paraphrases an address ("marketing@contoh-brand") or invents a
    plausible one would have us send a proposal into the void, so only an
    address that appears verbatim in what they wrote is accepted.
    """
    candidate = str(value or "").strip().strip("<>").lower()
    if not candidate or not _EMAIL_RE.fullmatch(candidate):
        return ""
    return candidate if candidate in (text or "").lower() else ""


def read(
    cfg: Settings,
    text: str,
    history: list[tuple[str, str]],
    *,
    brand: str = "",
    now: datetime | None = None,
) -> Reading:
    """Read one inbound message in context. Never raises.

    `history` is (direction, body) oldest first, our own messages included —
    "baik kak" means nothing without the question it answers.
    """
    if not cfg.use_llm_intents or not cfg.anthropic_api_key:
        return Reading()
    try:
        import anthropic
    except ImportError:
        log.warning("anthropic package not installed; reading without it")
        return Reading()

    stamp = (now or datetime.now()).strftime("%A, %d %B %Y %H:%M")
    prompt = (
        f"Hari ini: {stamp} WIB\n"
        f"Brand: {brand or '(tidak diketahui)'}\n\n"
        f"Percakapan sebelumnya (terlama di atas):\n{_history_block(history)}\n\n"
        f"Pesan terakhir dari brand yang harus kamu pahami:\n"
        f"<pesan>\n{(text or '')[:2000]}\n</pesan>"
    )
    try:
        client = anthropic.Anthropic(
            api_key=cfg.anthropic_api_key, timeout=TIMEOUT_SECONDS
        )
        resp = client.messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            # No `temperature`: claude-sonnet-5 rejects the parameter outright
            # (400, "deprecated for this model") and every reading would fall
            # back to the rules — silently, because falling back is the
            # designed behaviour on any error.
            system=_SYSTEM.replace("{labels}", _labels()),
            messages=[{"role": "user", "content": prompt}],
        )
        raw = "".join(
            block.text for block in resp.content if getattr(block, "type", "") == "text"
        )
    except Exception:
        log.exception("could not read the message with %s", MODEL)
        return Reading()

    data = _json_object(raw)
    if data is None:
        log.warning("reading was not JSON: %r", raw[:200])
        return Reading()

    reading = Reading(
        understood=True,
        intent=_as_intent(data.get("intent")),
        automated=bool(data.get("automated")),
        politeness_only=bool(data.get("politeness_only")),
        ends_conversation=bool(data.get("ends_conversation")),
        reason=str(data.get("reason", ""))[:300],
        email=_as_email(data.get("email"), text),
        phones=_as_phones(data.get("phones")),
        meeting_day=_as_day(data.get("meeting_day")),
        meeting_hour=_as_hour(data.get("meeting_hour")),
    )
    log.info(
        "READ %s | auto=%s basa-basi=%s selesai=%s email=%s jadwal=%s %s | %s",
        reading.intent.value if reading.intent else "-",
        reading.automated, reading.politeness_only, reading.ends_conversation,
        reading.email or "-", reading.meeting_day or "-",
        reading.meeting_hour if reading.meeting_hour is not None else "-",
        reading.reason,
    )
    return reading
