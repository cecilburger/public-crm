"""Resolve a WhatsApp *invite link* into the group JID the engine needs.

`BD_GROUP_JID` (FLOWCHART.md §3.3 fan-out) is an internal id like
``120363XXXXXXXXXXXX@g.us`` — you cannot type it by hand and it is *not* the
``https://chat.whatsapp.com/<code>`` link people share. The only way to learn
it is to ask a connected WhatsApp account, which is what `resolve-group` does.

The pure helpers here (`invite_code`, `set_env_var`, `parse_group_info`,
`is_group_jid`) are unit-tested; the neonize calls that need a live pairing
live in `transport.whatsapp` and are exercised by hand.
"""

from __future__ import annotations

from dataclasses import dataclass


def invite_code(link: str) -> str:
    """Extract the bare invite code from whatever the user pasted.

    Accepts a full ``https://chat.whatsapp.com/AbC123`` URL (with or without a
    ``/invite/`` segment, trailing slash, or ``?query``), or a bare code.
    Anything that still looks like a URL after that — a wa.me contact link, a
    random web page — is rejected here, with the original paste in the error,
    instead of going to WhatsApp as a bogus "code".
    """
    code = link.strip()
    # Host match is case-insensitive; the code after it is case-sensitive.
    host_at = code.lower().find("chat.whatsapp.com/")
    if host_at != -1:
        code = code[host_at + len("chat.whatsapp.com/"):]
    # drop query/fragment and any leading slashes
    code = code.split("?", 1)[0].split("#", 1)[0].strip().lstrip("/")
    # older links carry an /invite/ segment before the code
    if code.startswith("invite/"):
        code = code[len("invite/"):]
    # the code is the first path segment; ignore a trailing slash or stray tail
    code = code.split("/", 1)[0]
    if not code or any(ch in code for ch in ":/. "):
        raise ValueError(
            f"could not find an invite code in {link!r} — expected "
            "https://chat.whatsapp.com/<code> or the bare code"
        )
    return code


@dataclass
class GroupRef:
    """What the engine needs to post into a group, plus a human label."""

    jid: str
    name: str = ""
    size: int = 0
    joined: bool = False
    join_error: str = ""
    """Why a requested join failed — the resolved jid itself is still good."""


def _jid_str(jid) -> str:
    """neonize JID message -> canonical 'user@server' string.

    Defensive: neonize's proto field names have shifted across versions, so
    fall back to str() rather than crash on an unexpected shape. Truthiness,
    not `is None`: proto3 renders unset string fields as "", and "@" is not
    a JID.
    """
    user = getattr(jid, "User", None)
    server = getattr(jid, "Server", None)
    if user and server:
        return f"{user}@{server}"
    return str(jid)


def is_group_jid(jid: str) -> bool:
    """True only for a WhatsApp *group* JID: digits@g.us (legacy groups are
    creator-timestamp@g.us). Gate the .env write on this — when the proto
    shape shifts, `parse_group_info` degrades to str(proto), and that blob
    must never become BD_GROUP_JID.
    """
    user, _, server = jid.partition("@")
    return server == "g.us" and bool(user) and user.replace("-", "").isdigit()


def parse_group_info(info) -> GroupRef:
    """Pull jid / name / participant-count out of a neonize GroupInfo.

    Written against neonize 0.4.x (``GroupName.Name``, ``Participants``) but
    tolerant of missing fields so a proto tweak degrades to "jid only".
    """
    jid = _jid_str(getattr(info, "JID", info))

    name = ""
    group_name = getattr(info, "GroupName", None)
    if group_name is not None:
        name = getattr(group_name, "Name", "") or ""
    if not name:
        name = getattr(info, "Name", "") or ""

    participants = getattr(info, "Participants", None) or []
    try:
        size = len(participants)
    except TypeError:
        size = 0

    return GroupRef(jid=jid, name=name, size=size)


def _call_first(client, names: tuple[str, ...], *args):
    """Call the first method on `client` that exists, by name.

    neonize has renamed group methods across releases; trying a short list of
    known spellings means a version bump degrades to a clear error instead of
    an AttributeError deep in a callback.
    """
    for name in names:
        fn = getattr(client, name, None)
        if callable(fn):
            return fn(*args)
    raise RuntimeError(
        "this neonize build exposes none of: " + ", ".join(names) + ".\n"
        "Check `dir(client)` for the current group-invite method name."
    )


def resolve_via_client(client, code: str, join: bool) -> GroupRef:  # pragma: no cover
    """Look up a group by invite `code` on a *connected* neonize client.

    Read-only preview first (works even before the account is a member); then,
    if `join`, actually join so the account can post the meeting fan-out.
    """
    info = _call_first(
        client,
        ("get_group_info_from_link", "get_group_info_from_invite_link"),
        code,
    )
    ref = parse_group_info(info)
    if join:
        try:
            _call_first(
                client, ("join_group_with_link", "join_group_with_invite_link"), code
            )
        except Exception as exc:
            # whatsmeow errors the join when the account is already a member,
            # or the link was revoked between lookup and join. The lookup
            # above already succeeded — keep the JID, report the failure.
            ref.join_error = str(exc)
        else:
            ref.joined = True
    return ref


def set_env_var(text: str, key: str, value: str) -> str:
    """Return `text` with `KEY=value` set — replacing the first real
    assignment to KEY, or appending one if none exists.

    Commented (`# KEY=`) lines are left untouched, `KEY = value` spacing still
    matches, and the file keeps its newline style (a .env edited on Windows
    stays CRLF). Pure, so the .env rewrite is testable without a filesystem.
    """
    nl = "\r\n" if "\r\n" in text else "\n"
    lines = text.splitlines()
    out: list[str] = []
    replaced = False
    for line in lines:
        stripped = line.strip()
        if (
            not replaced
            and stripped
            and not stripped.startswith("#")
            and "=" in stripped
            and stripped.partition("=")[0].strip() == key
        ):
            out.append(f"{key}={value}")
            replaced = True
        else:
            out.append(line)
    if not replaced:
        out.append(f"{key}={value}")
    result = nl.join(out)
    if text.endswith("\n") or not text:
        result += nl
    return result
