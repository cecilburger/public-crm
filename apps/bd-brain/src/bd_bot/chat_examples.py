"""Real-conversation grounding, parsed from WhatsApp chat exports.

Drop `Chat WhatsApp dengan ….zip` exports (WhatsApp → chat → Export chat,
without media) into `chat-example/` and the responder grounds its generation
on how these conversations actually went — tone, pacing, how objections get
answered — on top of the fact sheet in `knowledge.py`.

These are STYLE examples, not fact sources. The chats predate the current
price list, so any agent turn that states an amount outside
`knowledge.ALLOWED_AMOUNTS` is dropped rather than taught. Turns carrying
links, emails, or phone numbers are dropped too: they are operational
(meet invites, group adds), and they leak contact data into prompts.
"""

from __future__ import annotations

import logging
import re
import zipfile
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

log = logging.getLogger(__name__)

# Android/Indonesian: `19/07/26 16.29 - Spark Konsultan Official: text`.
# System lines ("… kini menjadi kontak") have no `Sender: `.
_ANDROID_RE = re.compile(
    r"^(?P<date>\d{1,2}/\d{1,2}/\d{2,4}),?\s+(?P<time>\d{1,2}[.:]\d{2})\s+-\s"
    r"(?:(?P<sender>[^:]+?):\s)?(?P<body>.*)$"
)

# iOS: `[28/04/26, 16.31.34] MCNASIA.BIZ: text` — bracketed stamp with
# seconds; the chat file inside the zip is always `_chat.txt`.
#
# The 12-hour variant (`[8/16/26, 2:10:50 PM] Anda: …`) is what an iPhone set
# to a 12-hour clock writes, and it is the whole of `inbound/` — 36 real
# first-contact conversations. Without the optional AM/PM the bracket never
# closes where this expects it to, so every line falls through as unparseable
# and the corpus reads as empty: no error, no warning, just nothing learned.
_IOS_RE = re.compile(
    r"^\[(?P<date>\d{1,2}/\d{1,2}/\d{2,4}),?\s+(?P<time>\d{1,2}[.:]\d{2})(?:[.:]\d{2})?"
    r"(?:\s*(?:AM|PM|am|pm))?\]\s"
    r"(?:(?P<sender>[^:]+?):\s?)?(?P<body>.*)$"
)

#: Export placeholders that carry no text worth learning from.
_NOISE = {
    "<media tidak disertakan>",
    "pesan ini dihapus",
    "anda menghapus pesan ini",
    "pesan telah dihapus",
    "this message was deleted",
    "you deleted this message",
    "null",
    "",
}

#: System/preamble lines attributed to a sender by some export variants.
#: iOS attributes these to whoever's bubble they appeared under, so they look
#: like real turns; every observed wording variant must be listed or it leaks
#: into the prompt as "something the client said".
_NOISE_PREFIXES = (
    "pesan dan telepon terenkripsi",
    "pesan dan panggilan kini terenkripsi",
    "messages and calls are end-to-end",
    "bisnis anda menggunakan layanan",
    "kini bisnis anda menggunakan layanan",
    "chat ini dimulai dari iklan",
    "anda mengaktifkan balasan ai",
    "ai anda sedang mempelajari",
    "pesan sementara dinyalakan",
    "anda mematikan pesan sementara",
    "anda menyalakan pesan sementara",
    "anda menghapus pesan ini",
    "your business uses a secure service",
)


def _is_noise(text: str) -> bool:
    """A system/deleted-message line, in any observed export wording.

    Trailing punctuation varies between export vintages ("Anda menghapus
    pesan ini" vs "…pesan ini."), so it is stripped before matching.
    """
    low = _clean(text).lower().rstrip(".…")
    return low in _NOISE or low.startswith(_NOISE_PREFIXES)

#: `IMG-20260706-WA0007.jpg (file terlampir)` — attachment stubs inside a
#: message body (the caption follows on the next lines and is kept).
_ATTACH_LINE = re.compile(
    r"(.*\((?:file terlampir|file attached)\)$)|(^<attached:.*>$)"
    r"|(^(?:image|video|audio|sticker|gif|document) omitted$)"
    r"|(.*\btidak disertakan>?$)"  # "…pdf dokumen tidak disertakan"
    r"|(.*<terlampir:.*)"  # "….pdf • 7 halaman <terlampir: 00000006-…>"
    r"|(^[\w .,()&!-]+\.(?:pdf|jpe?g|png|webp|mp4|docx?|xlsx?|pptx?|opus)$)",
    re.IGNORECASE,
)

_EDITED_MARK = "<Pesan ini diedit>"

_URL_RE = re.compile(r"https?://\S+|\b\w+\.(?:google|whatsapp|zoom)\.\S+", re.I)
_EMAIL_RE = re.compile(r"\S+@\S+\.\S+")
#: International (+62…) and local (08…) mobile numbers. The third character
#: must be a digit so times like "08.00" don't match.
_PHONE_RE = re.compile(r"(?:\+?62|08)\d[\d\s.-]{7,}\d")

MAX_PAIRS = 10
MAX_BLOCK_CHARS = 6_000
_MAX_CLIENT_CHARS = 400
_MAX_AGENT_CHARS = 900


@dataclass(frozen=True, slots=True)
class Pair:
    """One exchange: what the brand said, how our agent actually answered."""

    source: str  # transcript filename, for /kb and debugging
    client: str
    agent: str


def _clean(text: str) -> str:
    text = text.replace(_EDITED_MARK, "")
    # Strip the invisible direction marks WhatsApp sprinkles into exports.
    return text.replace("‎", "").replace("‏", "").strip()


def _parse_transcript(raw: str) -> list[tuple[str, str]]:
    """Export text -> [(sender, message)], multiline messages joined."""
    messages: list[tuple[str, str]] = []
    for line in raw.splitlines():
        cleaned = _clean(line)
        m = _IOS_RE.match(cleaned) or _ANDROID_RE.match(cleaned)
        if m:
            sender, body = m.group("sender"), m.group("body")
            if sender is None:
                continue  # system line: encryption notice, "kini menjadi kontak"
            messages.append((sender.strip(), body))
        elif messages:
            # Continuation of the previous message.
            sender, body = messages[-1]
            messages[-1] = (sender, f"{body}\n{line}")

    out: list[tuple[str, str]] = []
    for sender, body in messages:
        # Drop attachment stubs and system lines, but keep the caption that
        # follows an attachment. System lines are filtered per-line too:
        # continuation-joining can bury one inside an otherwise real message.
        kept = [
            ln
            for ln in body.splitlines()
            if not _ATTACH_LINE.match(_clean(ln).strip())
            and not _is_noise(_clean(ln))
        ]
        text = _clean("\n".join(kept)).strip()
        if _is_noise(text):
            continue
        out.append((sender, text))
    return out


#: WhatsApp account names the business side has been observed under, across
#: every export vintage. A transcript whose best agent candidate appears in
#: only one file must match this list (or contain "mcnasia") to be trusted —
#: otherwise a chat where the client simply out-talked the agent would get its
#: sides inverted and teach client turns as our answers. Extend this list when
#: the team adds an account name.
KNOWN_AGENT_SENDERS = frozenset(
    {
        "mcnasia inovasi konsultan",
        "business development mcnasia",
        "spark konsultan official",
        "mcnasia.biz",
    }
)


def _files_per_sender(
    transcripts: dict[str, list[tuple[str, str]]]
) -> dict[str, set[str]]:
    seen_in: dict[str, set[str]] = {}
    for name, msgs in transcripts.items():
        for sender, _ in msgs:
            seen_in.setdefault(sender, set()).add(name)
    return seen_in


def _agent_for(
    msgs: list[tuple[str, str]], seen_in: dict[str, set[str]]
) -> str | None:
    """Which sender in THIS transcript is us?

    The business side recurs across exports (even under several account
    names — "Spark Konsultan Official", "mcnasia.biz" …) while each client
    appears in exactly one, so within a transcript the sender seen in the
    most other files is ours. A candidate seen in only this file is accepted
    only when its name is a known business account — message volume alone is
    not evidence of being the agent."""
    volume: dict[str, int] = {}
    for sender, _ in msgs:
        volume[sender] = volume.get(sender, 0) + 1
    if not volume:
        return None
    # A known business name breaks ties — otherwise two senders with equal
    # spread and volume resolve by dict order, which can invert the sides.
    best = max(
        volume,
        key=lambda s: (len(seen_in.get(s, ())), _named_agent(s), volume[s]),
    )
    if len(seen_in.get(best, ())) >= 2 or _named_agent(best):
        return best
    log.warning(
        "no recognisable business sender (best candidate %r); skipping transcript",
        best,
    )
    return None


def _named_agent(sender: str) -> bool:
    lowered = sender.strip().lower()
    return lowered in KNOWN_AGENT_SENDERS or "mcnasia" in lowered


def _amounts_allowed(text: str) -> bool:
    # Deferred import: responder imports this module for the prompt block.
    from .responder import _AMOUNT_RE, _normalise_amount
    from . import knowledge

    allowed = {_normalise_amount(a) for a in knowledge.ALLOWED_AMOUNTS}
    for m in _AMOUNT_RE.finditer(text):
        amount = _normalise_amount(m.group(1))
        if "miliar" in amount:
            continue  # GMV claim, not a price
        if amount not in allowed:
            return False
    return True


def _usable_agent_turn(text: str) -> bool:
    if not (30 <= len(text) <= _MAX_AGENT_CHARS):
        return False
    if _URL_RE.search(text) or _EMAIL_RE.search(text) or _PHONE_RE.search(text):
        return False
    # Deferred import, same reason as _amounts_allowed. teaches_safely is the
    # validator's own banned-content check — a turn the validator would reject
    # as output must not be shown to the model as an example either.
    from .responder import teaches_safely

    return _amounts_allowed(text) and teaches_safely(text)


def _sanitise_client(text: str) -> str:
    text = _URL_RE.sub("[link]", text)
    text = _EMAIL_RE.sub("[email]", text)
    if len(text) > _MAX_CLIENT_CHARS:
        text = text[: _MAX_CLIENT_CHARS - 1] + "…"
    return text.strip()


def _runs(msgs: list[tuple[str, str]], agent: str) -> list[tuple[bool, str]]:
    """Merge consecutive same-side messages into turns: [(is_agent, text)].

    A burst of short messages is one reply — pairing and replay both want the
    turn, not the fragments.

    `sender == agent`, deliberately, and not "any sender whose name looks
    like ours". That widening was tried in Sep 2026 to catch a transcript
    where our side appears under two names, and measured afterwards it moved
    exactly zero turns on either corpus — `_agent_for` already picks the
    business name when it is the only one present. What it did add was a way
    to lose a whole conversation in silence: the team does not control how a
    contact is saved, and one brand stored as "Lead MCNasia Ads - Budi" would
    have had every one of its turns counted as ours, leaving the transcript
    with no client side at all and no error anywhere. The real fix for the
    ten misattributed turns was naming transcripts after their folder."""
    runs: list[tuple[bool, str]] = []
    for sender, body in msgs:
        is_agent = sender == agent
        if runs and runs[-1][0] == is_agent:
            runs[-1] = (is_agent, f"{runs[-1][1]}\n{body}")
        else:
            runs.append((is_agent, body))
    return runs


def _pairs_from(name: str, msgs: list[tuple[str, str]], agent: str) -> list[Pair]:
    """Merge consecutive same-side turns, then pair client-run -> agent-run."""
    runs = _runs(msgs, agent)
    pairs: list[Pair] = []
    for (a_side, a_text), (b_side, b_text) in zip(runs, runs[1:]):
        if a_side or not b_side:
            continue  # only client -> agent
        client = _sanitise_client(a_text)
        if len(client) < 3 or not _usable_agent_turn(b_text):
            continue
        # The real chats say "20–30 menit"; current policy is "meeting
        # singkat" with no duration — don't let the examples teach it back.
        from .responder import strip_durations

        pairs.append(Pair(source=name, client=client, agent=strip_durations(b_text)))
    return pairs


def _load_transcripts(root: Path) -> dict[str, list[tuple[str, str]]]:
    """Parse every export under `root`: zips, loose .txt, and one-per-folder.

    Three shapes, because the two corpora arrived in two shapes and neither
    is worth rewriting on disk:

    * `chat-example/…zip` — WhatsApp's own "Export chat" file.
    * `<root>/x.txt` — a zip somebody already unpacked.
    * `<root>/<name>/chat.txt` — `inbound/sosmed-ke-wa/`, a folder per
      conversation named after the person, holding the transcript beside its
      attachments. The FOLDER is the transcript name; using the file's stem
      would name all 36 of them "chat", and `_agent_for` decides who we are
      by counting how many transcripts a sender appears in — one name for
      everything collapses that to a single file and the sides invert.
    """
    transcripts: dict[str, list[tuple[str, str]]] = {}

    def read_txt(path: Path, name: str) -> None:
        transcripts[name] = _parse_transcript(
            path.read_text(encoding="utf-8", errors="replace")
        )

    for path in sorted(root.iterdir()):
        try:
            if path.suffix.lower() == ".zip":
                with zipfile.ZipFile(path) as zf:
                    for member in zf.namelist():
                        if member.lower().endswith(".txt"):
                            raw = zf.read(member).decode("utf-8", errors="replace")
                            transcripts[path.stem] = _parse_transcript(raw)
                            break
            elif path.suffix.lower() == ".txt":
                read_txt(path, path.stem)
            elif path.is_dir():
                # Deliberately one level, not a walk: a deep tree of media
                # folders would pull in whatever .txt happens to sit in it.
                found = [
                    f for f in sorted(path.iterdir())
                    if f.suffix.lower() == ".txt" and f.name.lower().lstrip("_")
                    in {"chat.txt", f"{path.name.lower()}.txt"}
                ]
                if found:
                    read_txt(found[0], path.name)
        except Exception:
            log.exception("could not read chat example %s; skipping", path.name)
    return transcripts


@lru_cache(maxsize=4)
def load_pairs(directory: str) -> tuple[Pair, ...]:
    """Every usable exchange from every export zip (and loose .txt) found."""
    root = Path(directory)
    if not root.is_dir():
        return ()

    transcripts = _load_transcripts(root)
    seen_in = _files_per_sender(transcripts)
    pairs: list[Pair] = []
    for name, msgs in transcripts.items():
        agent = _agent_for(msgs, seen_in)
        if agent is None:
            continue
        pairs.extend(_pairs_from(name, msgs, agent))
    return tuple(pairs)


@dataclass(frozen=True, slots=True)
class ClientTurn:
    """One client-side turn (a merged message run) — the replay corpus."""

    source: str  # transcript filename
    text: str


@lru_cache(maxsize=4)
def load_client_turns(directory: str) -> tuple[ClientTurn, ...]:
    """Every client turn from every export — what real brands actually typed.

    This is the measurement corpus for `bd_bot replay`: each turn is what the
    intent classifier would have been given, with links, emails, and phone
    numbers masked. Unlike the style pairs, turns are NOT truncated — a rule
    that only matches past char 400 must still get the chance to."""
    root = Path(directory)
    if not root.is_dir():
        return ()

    transcripts = _load_transcripts(root)
    seen_in = _files_per_sender(transcripts)
    turns: list[ClientTurn] = []
    for name, msgs in transcripts.items():
        agent = _agent_for(msgs, seen_in)
        if agent is None:
            continue
        for is_agent, text in _runs(msgs, agent):
            if is_agent:
                continue
            masked = _URL_RE.sub("[link]", text)
            masked = _EMAIL_RE.sub("[email]", masked)
            masked = _PHONE_RE.sub("[phone]", masked).strip()
            if len(masked) >= 2:
                turns.append(ClientTurn(source=name, text=masked))
    return tuple(turns)


def dialogue_block(*directories: Path) -> str:
    """Prompt section with real exchanges, capped and spread across chats.

    Round-robins across transcripts so one long chat can't crowd out the
    others, and stops at MAX_PAIRS / MAX_BLOCK_CHARS.

    Takes more than one directory because the bot has two corpora that teach
    different halves of the job: `chat-example/` is outbound (we opened),
    `inbound/` is the brand writing first.

    The round-robin runs over DIRECTORIES first, then over the transcripts
    inside each. Flattening both into one pool instead looks equivalent and
    is not: with 33 outbound transcripts, 36 inbound ones and a cap of ten
    pairs, a flat pool takes one pair from each of the first ten transcripts
    and the second corpus never appears at all. The inbound corpus would be
    loaded, parsed, counted — and silently absent from every prompt.
    """
    groups: list[list[list[Pair]]] = []
    for directory in directories:
        pairs = load_pairs(str(directory))
        if not pairs:
            continue
        by_source: dict[str, list[Pair]] = {}
        for p in pairs:
            by_source.setdefault(p.source, []).append(p)
        groups.append(list(by_source.values()))
    if not groups:
        return ""

    picked: list[Pair] = []
    seen_answers: set[str] = set()
    while groups and len(picked) < MAX_PAIRS:
        for group in list(groups):
            # One pair from this corpus, then on to the next corpus.
            while group and not group[0]:
                group.pop(0)
            if not group:
                groups.remove(group)
                continue
            q = group.pop(0)
            p = q.pop(0)
            if q:
                group.append(q)     # back of the queue: spread across chats
            # The same canned answer recurs across chats — one copy teaches
            # as much as ten.
            fingerprint = " ".join(p.agent.lower().split())[:120]
            if fingerprint in seen_answers:
                continue
            seen_answers.add(fingerprint)
            picked.append(p)
            if len(picked) >= MAX_PAIRS:
                break

    lines = [
        "CONTOH PERCAKAPAN NYATA (tiru gaya, nada, dan cara menjawabnya — "
        "tetapi fakta, harga, dan klaim HANYA boleh diambil dari FACT SHEET, "
        "bukan dari contoh ini):",
        "",
    ]
    total = sum(len(line) for line in lines)
    for i, p in enumerate(picked, 1):
        chunk = f"Contoh {i}\nBrand: {p.client}\nBalasan: {p.agent}\n"
        if total + len(chunk) > MAX_BLOCK_CHARS:
            break
        lines.append(chunk)
        total += len(chunk)

    return "\n".join(lines) if len(lines) > 2 else ""
