"""Loading the brand database: CSV in, normalised contacts out.

The acquisition flow starts from a list of brands to approach. This module is
the front door for that list — it reads whatever spreadsheet export it is given
and turns each row into a `Contact` with a valid WhatsApp JID.

It deliberately does no I/O beyond reading the file, so the parsing rules are
testable on their own.
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass
from pathlib import Path

from .models import Contact

#: Header names seen in real exports, per field. Matching is case-insensitive
#: and ignores spaces/underscores, so "No. HP" and "no_hp" both land here.
ALIASES: dict[str, tuple[str, ...]] = {
    "phone": (
        "phone", "phonenumber", "number", "no", "nomor", "nohp", "nowa",
        "nomorhp", "nomorwa", "hp", "wa", "whatsapp", "telepon", "telp",
        "kontak", "contact", "mobile",
    ),
    "name": (
        "name", "nama", "pic", "contactperson", "namapic", "person",
        "namakontak", "cp",
    ),
    "brand": (
        "brand", "brandname", "company", "companyname", "perusahaan", "toko",
        "namabrand", "client", "akun", "account",
    ),
    "category": (
        "category", "kategori", "cat", "niche", "vertical", "industri",
        "industry",
    ),
}


def _key(header: str) -> str:
    return "".join(ch for ch in header.lower() if ch.isalnum())


def normalise_phone(raw: str) -> str:
    """Indonesian mobile number -> bare international digits, or '' if invalid.

    Handles the four ways the same number shows up in a spreadsheet:
    `0812…`, `+62812…`, `62812…`, `812…`. Everything else — landlines, stray
    notes, half-typed cells — is rejected rather than guessed at, because a
    wrong number here means messaging a stranger.
    """
    digits = "".join(ch for ch in str(raw) if ch.isdigit())
    if not digits:
        return ""

    if digits.startswith("62"):
        pass
    elif digits.startswith("0"):
        digits = "62" + digits.lstrip("0")
    elif digits.startswith("8"):
        digits = "62" + digits
    else:
        return ""

    # Indonesian mobile numbers are 62 + 8 + 8..11 more digits.
    if not digits.startswith("628") or not 11 <= len(digits) <= 15:
        return ""
    return digits


def to_jid(phone: str) -> str:
    digits = normalise_phone(phone)
    return f"{digits}@s.whatsapp.net" if digits else ""


@dataclass(slots=True)
class LoadReport:
    """What a load produced, including everything it refused."""

    contacts: list[Contact]
    skipped: list[tuple[int, str, str]]
    """(line number, raw value, reason) — surfaced so bad rows get fixed."""

    duplicates: int = 0

    @property
    def ok(self) -> int:
        return len(self.contacts)


def parse(text: str) -> LoadReport:
    """Parse CSV text into contacts.

    Accepts either a headered file (any of the aliases above) or a bare list of
    phone numbers, one per line — both are common ways a brand list arrives.
    """
    sample = text[:4096]
    try:
        dialect: type[csv.Dialect] | csv.Dialect = csv.Sniffer().sniff(
            sample, delimiters=",;\t|"
        )
    except csv.Error:
        dialect = csv.excel

    rows = list(csv.reader(io.StringIO(text), dialect))
    rows = [r for r in rows if any(cell.strip() for cell in r)]
    if not rows:
        return LoadReport(contacts=[], skipped=[])

    columns = _map_columns(rows[0])
    body = rows[1:] if columns else rows
    if not columns:
        # Headerless: assume phone, then name, then brand, positionally.
        columns = {"phone": 0}
        if len(rows[0]) > 1:
            columns["name"] = 1
        if len(rows[0]) > 2:
            columns["brand"] = 2

    contacts: list[Contact] = []
    skipped: list[tuple[int, str, str]] = []
    seen: set[str] = set()
    offset = 2 if len(body) < len(rows) else 1

    for i, row in enumerate(body):
        line = i + offset

        def cell(field: str) -> str:
            idx = columns.get(field)
            return row[idx].strip() if idx is not None and idx < len(row) else ""

        raw_phone = cell("phone")
        if not raw_phone:
            skipped.append((line, "", "no phone"))
            continue

        jid = to_jid(raw_phone)
        if not jid:
            skipped.append((line, raw_phone, "not a valid Indonesian mobile"))
            continue
        if jid in seen:
            skipped.append((line, raw_phone, "duplicate"))
            continue

        seen.add(jid)
        contacts.append(
            Contact(
                jid=jid,
                name=cell("name"),
                brand=cell("brand"),
                category=cell("category").lower(),
            )
        )

    duplicates = sum(1 for s in skipped if s[2] == "duplicate")
    return LoadReport(contacts=contacts, skipped=skipped, duplicates=duplicates)


def load_file(path: Path) -> LoadReport:
    raw = path.read_bytes()
    # Spreadsheet exports from Excel are frequently UTF-8 with a BOM, or cp1252.
    for encoding in ("utf-8-sig", "utf-8", "cp1252"):
        try:
            return parse(raw.decode(encoding))
        except UnicodeDecodeError:
            continue
    return parse(raw.decode("utf-8", errors="replace"))


def _map_columns(header: list[str]) -> dict[str, int]:
    """Match a header row against the aliases. Empty if it isn't a header."""
    found: dict[str, int] = {}
    for idx, raw in enumerate(header):
        key = _key(raw)
        for field, names in ALIASES.items():
            if key in names and field not in found:
                found[field] = idx
    return found if "phone" in found else {}
