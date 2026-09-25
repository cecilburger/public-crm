"""Invite-link parsing and the .env rewrite. No network — the neonize calls
(resolve_via_client / transport.connect_and_run) need a live pairing and are
exercised by hand."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bd_bot import groups  # noqa: E402


# --- invite_code -----------------------------------------------------------


@pytest.mark.parametrize(
    "link,expected",
    [
        ("https://chat.whatsapp.com/EtLwI8otGKsLR12ett98Y3", "EtLwI8otGKsLR12ett98Y3"),
        ("http://chat.whatsapp.com/EtLwI8otGKsLR12ett98Y3", "EtLwI8otGKsLR12ett98Y3"),
        ("https://chat.whatsapp.com/EtLwI8otGKsLR12ett98Y3/", "EtLwI8otGKsLR12ett98Y3"),
        ("chat.whatsapp.com/EtLwI8otGKsLR12ett98Y3", "EtLwI8otGKsLR12ett98Y3"),
        ("https://chat.whatsapp.com/invite/AbC123", "AbC123"),
        ("https://chat.whatsapp.com/AbC123?foo=bar", "AbC123"),
        ("https://chat.whatsapp.com/AbC123#frag", "AbC123"),
        ("  https://chat.whatsapp.com/AbC123  ", "AbC123"),
        ("AbC123", "AbC123"),  # bare code passes through
        ("https://CHAT.WhatsApp.Com/AbC123", "AbC123"),  # host is case-insensitive
        ("https://chat.whatsapp.com/invite/AbC123/", "AbC123"),
        ("https://chat.whatsapp.com/AbC123/extra", "AbC123"),  # stray path tail
    ],
)
def test_invite_code(link, expected):
    assert groups.invite_code(link) == expected


@pytest.mark.parametrize(
    "bad",
    [
        "",
        "   ",
        "https://chat.whatsapp.com/",
        "invite/",
        "https://chat.whatsapp.com",  # no code at all
        # wrong link pasted — must fail here, not as a bogus code on the wire
        "https://wa.me/6281234567890",
        "https://example.com/AbC123",
        "not a code",
    ],
)
def test_invite_code_rejects_junk(bad):
    with pytest.raises(ValueError):
        groups.invite_code(bad)


# --- parse_group_info (defensive against proto shape) ----------------------


class _JID:
    def __init__(self, user, server):
        self.User = user
        self.Server = server


class _Name:
    def __init__(self, name):
        self.Name = name


class _Info:
    def __init__(self, jid, name, participants):
        self.JID = jid
        self.GroupName = _Name(name)
        self.Participants = participants


def test_parse_group_info_full():
    info = _Info(_JID("120363999", "g.us"), "MCNAsia BD", [1, 2, 3])
    ref = groups.parse_group_info(info)
    assert ref.jid == "120363999@g.us"
    assert ref.name == "MCNAsia BD"
    assert ref.size == 3
    assert ref.joined is False


def test_parse_group_info_missing_fields_degrades():
    class Bare:
        JID = _JID("120363000", "g.us")

    ref = groups.parse_group_info(Bare())
    assert ref.jid == "120363000@g.us"
    assert ref.name == ""
    assert ref.size == 0


def test_parse_group_info_empty_proto_strings():
    # proto3 renders unset string fields as "", not None — must not yield "@"
    class EmptyJID:
        User = ""
        Server = ""

        def __str__(self):
            return "raw-proto-blob"

    class Info:
        JID = EmptyJID()

    assert groups.parse_group_info(Info()).jid == "raw-proto-blob"


# --- is_group_jid (guards the .env write) ----------------------------------


@pytest.mark.parametrize(
    "jid,ok",
    [
        ("120363999@g.us", True),
        ("628123456789-1601234567@g.us", True),  # legacy creator-timestamp form
        ("628123456789@s.whatsapp.net", False),  # a person, not a group
        ("raw-proto-blob", False),  # the str(proto) degraded shape
        ("@g.us", False),
        ("-@g.us", False),
        ("", False),
    ],
)
def test_is_group_jid(jid, ok):
    assert groups.is_group_jid(jid) is ok


# --- set_env_var -----------------------------------------------------------


def test_set_env_var_replaces_existing():
    text = "DRY_RUN=true\nBD_GROUP_JID=\nALERT_JID=\n"
    out = groups.set_env_var(text, "BD_GROUP_JID", "120363@g.us")
    assert out == "DRY_RUN=true\nBD_GROUP_JID=120363@g.us\nALERT_JID=\n"


def test_set_env_var_appends_when_absent():
    text = "DRY_RUN=true\n"
    out = groups.set_env_var(text, "BD_GROUP_JID", "120363@g.us")
    assert out == "DRY_RUN=true\nBD_GROUP_JID=120363@g.us\n"


def test_set_env_var_ignores_commented_line():
    text = "# BD_GROUP_JID=old\nDRY_RUN=true\n"
    out = groups.set_env_var(text, "BD_GROUP_JID", "new@g.us")
    # the comment is untouched; a real assignment is appended
    assert "# BD_GROUP_JID=old" in out
    assert "BD_GROUP_JID=new@g.us" in out
    assert out.count("BD_GROUP_JID=new@g.us") == 1


def test_set_env_var_replaces_only_first():
    text = "BD_GROUP_JID=a\nBD_GROUP_JID=b\n"
    out = groups.set_env_var(text, "BD_GROUP_JID", "c")
    assert out == "BD_GROUP_JID=c\nBD_GROUP_JID=b\n"


def test_set_env_var_empty_input():
    assert groups.set_env_var("", "BD_GROUP_JID", "x@g.us") == "BD_GROUP_JID=x@g.us\n"


def test_set_env_var_matches_spaced_assignment():
    # `KEY = value` is how some editors format dotenv; still the same key
    out = groups.set_env_var("BD_GROUP_JID = old\n", "BD_GROUP_JID", "new@g.us")
    assert out == "BD_GROUP_JID=new@g.us\n"


def test_set_env_var_replaces_quoted_value():
    out = groups.set_env_var('BD_GROUP_JID="old@g.us"\n', "BD_GROUP_JID", "new@g.us")
    assert out == "BD_GROUP_JID=new@g.us\n"


def test_set_env_var_preserves_crlf():
    # a .env last touched on Windows must not come back with mixed endings
    text = "DRY_RUN=true\r\nBD_GROUP_JID=\r\n"
    out = groups.set_env_var(text, "BD_GROUP_JID", "120363@g.us")
    assert out == "DRY_RUN=true\r\nBD_GROUP_JID=120363@g.us\r\n"


def test_set_env_var_appends_crlf():
    out = groups.set_env_var("DRY_RUN=true\r\n", "BD_GROUP_JID", "x@g.us")
    assert out == "DRY_RUN=true\r\nBD_GROUP_JID=x@g.us\r\n"


def test_set_env_var_no_trailing_newline_stays_that_way():
    out = groups.set_env_var("DRY_RUN=true", "BD_GROUP_JID", "x@g.us")
    assert out == "DRY_RUN=true\nBD_GROUP_JID=x@g.us"


# --- resolve_via_client dispatch (fake client, no neonize) -----------------


class _FakeClient:
    def __init__(self, info):
        self._info = info
        self.joined_with = None

    def get_group_info_from_link(self, code):
        self._last_code = code
        return self._info

    def join_group_with_link(self, code):
        self.joined_with = code


def test_resolve_via_client_join():
    info = _Info(_JID("120363999", "g.us"), "MCNAsia BD", [1, 2])
    client = _FakeClient(info)
    ref = groups.resolve_via_client(client, "AbC123", join=True)
    assert ref.jid == "120363999@g.us"
    assert ref.joined is True
    assert client.joined_with == "AbC123"


def test_resolve_via_client_no_join():
    info = _Info(_JID("120363999", "g.us"), "MCNAsia BD", [1, 2])
    client = _FakeClient(info)
    ref = groups.resolve_via_client(client, "AbC123", join=False)
    assert ref.joined is False
    assert client.joined_with is None


def test_resolve_via_client_alternate_method_names():
    # a neonize rename must degrade to "the other spelling", not AttributeError
    class Renamed:
        def __init__(self, info):
            self._info = info
            self.joined_with = None

        def get_group_info_from_invite_link(self, code):
            return self._info

        def join_group_with_invite_link(self, code):
            self.joined_with = code

    client = Renamed(_Info(_JID("120363999", "g.us"), "MCNAsia BD", []))
    ref = groups.resolve_via_client(client, "AbC123", join=True)
    assert ref.jid == "120363999@g.us"
    assert ref.joined is True
    assert client.joined_with == "AbC123"


def test_resolve_via_client_join_failure_keeps_jid():
    # already-a-member (or a just-revoked link) errors the join — the JID
    # resolved a moment earlier must survive
    class JoinFails(_FakeClient):
        def join_group_with_link(self, code):
            raise Exception("409: participant already exists")

    client = JoinFails(_Info(_JID("120363999", "g.us"), "MCNAsia BD", [1]))
    ref = groups.resolve_via_client(client, "AbC123", join=True)
    assert ref.jid == "120363999@g.us"
    assert ref.joined is False
    assert "already exists" in ref.join_error


def test_resolve_via_client_missing_join_method_keeps_jid():
    class NoJoin:
        def get_group_info_from_link(self, code):
            return _Info(_JID("120363999", "g.us"), "", [])

    ref = groups.resolve_via_client(NoJoin(), "AbC123", join=True)
    assert ref.jid == "120363999@g.us"
    assert ref.joined is False
    assert "none of" in ref.join_error


def test_resolve_via_client_unknown_method_errors():
    class Empty:
        pass

    with pytest.raises(RuntimeError, match="none of"):
        groups.resolve_via_client(Empty(), "AbC123", join=False)
