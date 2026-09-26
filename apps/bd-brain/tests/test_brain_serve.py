"""The HTTP contract the CRM's worker relies on (apps/worker/src/bdBrain.ts).

Every test here talks to a real `ThreadingHTTPServer` on an ephemeral port,
with the same JSON the TypeScript client sends, and checks the shapes the
TypeScript types declare — `BdStep`, `BdAction`, `BdBooking`,
`BdConversation`. The three properties that matter most:

* auth: no bearer, wrong bearer, and a non-/v1 path each get the status the
  client expects (401 is "permanent", never retried);
* statelessness: the same request twice gives the same answer, and a request
  that escalates leaves nothing behind for the next one;
* the engine-level behaviour the bot reads from its database — the FOKUS
  gate, the loop breaker, the DM hand-off — works from what the CRM sends.

Offline throughout: the calendar is the simulated one, and the LLM flags are
cleared by conftest.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bd_bot import brain_serve, gcal, templates  # noqa: E402
from bd_bot.config import Settings  # noqa: E402
from bd_bot.models import Node  # noqa: E402

SECRET = "test-secret"


@pytest.fixture(scope="module")
def server():
    gcal.use_simulated()
    cfg = Settings()
    srv, url = brain_serve.start_in_thread(brain_serve.BrainService(cfg), SECRET)
    yield url
    srv.shutdown()
    srv.server_close()
    gcal.use_real()


@pytest.fixture
def cfg():
    return Settings()


def _call(url: str, path: str, body: dict | None = None, *, method: str | None = None,
          secret: str | None = SECRET) -> tuple[int, dict]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url + path, data=data, method=method or ("POST" if data else "GET"))
    req.add_header("Content-Type", "application/json")
    if secret is not None:
        req.add_header("Authorization", f"Bearer {secret}")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


NOW = "2026-09-25T03:00:00.000Z"  # 10.00 WIB on a Friday


def _convo(**fields) -> dict:
    return {"jid": "4d1c7d3e-0000-4000-8000-000000000001", "name": "Cika", **fields}


def _sends(step: dict) -> list[dict]:
    return [a for a in step["actions"] if a["type"] == "send"]


def _turns(*pairs: tuple[str, str], start: str = NOW) -> list[dict]:
    """`("in"|"out", body)` pairs -> history with real, increasing timestamps."""
    base = datetime.fromisoformat(start.replace("Z", "+00:00")) - timedelta(minutes=30)
    return [
        {"direction": d, "body": b, "at": (base + timedelta(minutes=i)).isoformat()}
        for i, (d, b) in enumerate(pairs)
    ]


# --- auth and plumbing --------------------------------------------------------


def test_healthz_needs_no_secret(server):
    assert _call(server, "/healthz", secret=None) == (200, {"ok": True})


@pytest.mark.parametrize("path,body", [
    ("/v1/step", {"conversation": _convo(), "text": "halo", "now": NOW}),
    ("/v1/book", {"conversation": _convo(), "history": [], "now": NOW}),
    ("/v1/propose-slots", {"conversation": _convo(), "fallback_text": "x", "fallback_key": "REPLY_SETUJU", "history": [], "now": NOW}),
    ("/v1/comment-reply", None),
])
def test_every_v1_route_refuses_a_missing_or_wrong_secret(server, path, body):
    assert _call(server, path, body, secret=None)[0] == 401
    assert _call(server, path, body, secret="not-it")[0] == 401


def test_unknown_paths_and_wrong_methods(server):
    assert _call(server, "/v1/nope", {"a": 1})[0] == 404
    assert _call(server, "/v1/step", method="GET")[0] == 405
    assert _call(server, "/nope", secret=None)[0] == 404


def test_a_malformed_payload_is_400_not_500(server):
    """400 is what the client treats as permanent — a bad payload must not be
    retried eight times, and must not be mistaken for a crash."""
    assert _call(server, "/v1/step", {"text": "halo", "now": NOW})[0] == 400  # no conversation
    assert _call(server, "/v1/step", {"conversation": _convo(), "now": NOW})[0] == 400  # no text
    assert _call(server, "/v1/step", {"conversation": _convo(node="not-a-node"), "text": "x", "now": NOW})[0] == 400
    assert _call(server, "/v1/step", {"conversation": _convo(), "text": "x", "now": "yesterday"})[0] == 400
    assert _call(server, "/v1/step", {"conversation": _convo(), "text": "x", "now": NOW, "intent": "made_up"})[0] == 400
    assert _call(server, "/v1/propose-slots", {"conversation": _convo(), "history": [], "now": NOW})[0] == 400


def test_the_server_refuses_to_start_without_a_secret(cfg):
    with pytest.raises(RuntimeError, match="BD_BRAIN_SECRET"):
        brain_serve.make_server(brain_serve.BrainService(cfg), "", port=0)


# --- /v1/step: shapes ----------------------------------------------------------


def test_step_returns_the_bdstep_shape(server):
    status, step = _call(server, "/v1/step", {
        "conversation": _convo(), "text": "Halo! Bisa minta info lebih lanjut tentang ini?", "now": NOW,
    })
    assert status == 200
    assert set(step) == {"intent", "conversation", "actions"}
    assert step["intent"] == "lead_iklan"

    convo = step["conversation"]
    # Every BdConversation field, always present, so the CRM's upsert never guesses.
    assert set(convo) == {
        "jid", "name", "brand", "category", "node", "outcome", "gadget_loops", "email",
        "last_inbound_at", "last_outbound_at", "meeting_at", "meet_link",
        "unknown_streak", "price_stage", "stopped_reason", "source",
    }
    assert convo["node"] == "inbound_qualify"
    assert convo["last_inbound_at"] == "2026-09-25T10:00:00+07:00"

    types = [a["type"] for a in step["actions"]]
    assert types == ["cancel_timers", "send", "set_node", "schedule"]
    send = _sends(step)[0]
    assert set(send) == {"type", "text", "key", "attach_company_profile", "attach_opening",
                         "attach_case_study", "attach_ads_deck"}
    assert send["key"] == "INBOUND_QUALIFY" and "Nama Brand" in send["text"]
    set_node = step["actions"][2]
    assert set_node == {"type": "set_node", "node": "inbound_qualify", "outcome": "followup"}
    assert step["actions"][3]["timer"] == "warm_d2"


def test_step_is_stateless(server):
    body = {"conversation": _convo(), "text": "Halo! Bisa minta info lebih lanjut tentang ini?", "now": NOW}
    first = _call(server, "/v1/step", body)[1]
    second = _call(server, "/v1/step", body)[1]
    assert first == second

    # A request that escalates and hands over leaves no trace for the next
    # one: the same conversation, stepped again from the state it SENT, is
    # answered as if the escalation had never happened.
    handover = _call(server, "/v1/step", {
        "conversation": _convo(node="qna"), "text": "hubungi PIC kami Pak Jo di +62 878-8496-2002", "now": NOW,
    })[1]
    assert handover["conversation"]["node"] == "handover"
    again = _call(server, "/v1/step", body)[1]
    assert again == first


def test_a_pre_flow_handover_is_reported_as_a_set_node(server):
    """The referral path moves the node directly, not through the flow. The
    contract says node changes are actions, and bdDraft.ts reads them."""
    step = _call(server, "/v1/step", {
        "conversation": _convo(node="qna"), "text": "hubungi PIC kami Pak Jo di +62 878-8496-2002", "now": NOW,
    })[1]
    assert step["intent"] == "referral"
    assert {"type": "set_node", "node": "handover", "outcome": "followup"} in step["actions"]
    assert any(a["type"] == "escalate" and "nomor lain" in a["reason"] for a in step["actions"])
    assert _sends(step)[0]["key"] == "REPLY_REFERRAL"
    assert step["conversation"]["stopped_reason"].startswith("rujukan ke")


def test_a_forced_intent_skips_classification(server):
    step = _call(server, "/v1/step", {
        "conversation": _convo(node="qna"), "text": "whatever", "now": NOW, "intent": "tanya_harga",
    })[1]
    assert step["intent"] == "tanya_harga"
    assert _sends(step)[0]["key"] == "REPLY_TANYA_HARGA"
    assert step["conversation"]["price_stage"] == 1


def test_the_attachment_flags_cross_the_wire(server):
    step = _call(server, "/v1/step", {
        "conversation": _convo(node="qna"), "text": "boleh minta portofolionya kak?", "now": NOW,
    })[1]
    send = _sends(step)[0]
    assert send["key"] == "REPLY_TANYA_PORTOFOLIO"
    assert send["attach_company_profile"] is True and send["attach_case_study"] is True
    assert send["attach_opening"] is False


# --- /v1/step: engine-level behaviour from what the CRM sends -------------------


def test_the_focus_answer_counts_only_after_our_focus_question(server):
    """FOKUS_CAMPAIGN is context-bound: the engine keeps it only when OUR last
    message asked the focus. In the bot that is a store lookup; here it is the
    last `out` turn in `history`."""
    asked = _turns(("in", "harganya berapa?"), ("out", templates.REPLY_TANYA_HARGA.strip()))
    with_context = _call(server, "/v1/step", {
        "conversation": _convo(node="qna", price_stage=1), "text": "lebih ke sales kak",
        "now": NOW, "history": asked,
    })[1]
    assert with_context["intent"] == "fokus_campaign"
    assert _sends(with_context)[0]["key"] == "REPLY_FOKUS_SALES"

    without = _call(server, "/v1/step", {
        "conversation": _convo(node="qna", price_stage=1), "text": "lebih ke sales kak",
        "now": NOW, "history": _turns(("out", "Boleh dibantu alamat email-nya?")),
    })[1]
    assert without["intent"] == "unknown"
    assert without["conversation"]["unknown_streak"] == 1


def test_the_current_message_at_the_end_of_history_is_not_read_as_a_repeat(server):
    """bdDraft.ts records the inbound message before it asks about it, so the
    newest turn in `history` is the message itself. The loop breaker must
    not see that as the contact repeating themselves."""
    text = "Halo kak, saya mau tanya soal campaign affiliate untuk brand skincare saya"
    step = _call(server, "/v1/step", {
        "conversation": _convo(node="qna"), "text": text, "now": NOW,
        "history": _turns(("out", "Boleh, ada yang bisa dibantu?"), ("in", text)),
    })[1]
    assert step["intent"] != "loop"
    assert _sends(step), "the message was answered"


def test_a_verbatim_repeat_trips_the_loop_breaker(server):
    text = "Terima kasih telah menghubungi kami, pesan Anda akan segera kami balas pada jam kerja."
    step = _call(server, "/v1/step", {
        "conversation": _convo(node="qna"), "text": text, "now": NOW,
        "history": _turns(("in", text), ("out", "Baik Kak, ada yang bisa dibantu?")),
    })[1]
    assert step["intent"] == "loop"
    assert not _sends(step), "a machine is not answered"
    assert any(a["type"] == "escalate" and "auto-loop" in a["reason"] for a in step["actions"])
    assert step["conversation"]["node"] == "qna", "the node does not advance"


def test_unknown_streak_from_the_crm_reaches_handover(server, cfg):
    step = _call(server, "/v1/step", {
        "conversation": _convo(node="qna", unknown_streak=cfg.max_unknown_streak - 1),
        "text": "xyzzy plugh", "now": NOW,
    })[1]
    assert step["intent"] == "unknown"
    assert step["conversation"]["node"] == "handover"
    assert _sends(step)[-1]["key"] == "HANDOVER"


def test_source_instagram_gets_the_dm_opener_and_hands_off_to_whatsapp(server, monkeypatch):
    """`source` is what the flow sees of the channel — the CRM's jid is a
    UUID. With a number configured, interest in a DM past qualification is
    the hand-off, with the number in the text."""
    monkeypatch.setenv("BD_WHATSAPP_NUMBER", "+62 800-0000-0000")
    # The server's Settings were built at start; rebuild a service that read
    # the variable, on the same secret, to keep the test honest about where
    # the number comes from (this process's environment, not the request).
    srv, url = brain_serve.start_in_thread(brain_serve.BrainService(Settings()), SECRET)
    try:
        first = _call(url, "/v1/step", {
            "conversation": _convo(source="instagram"), "text": "Info kak", "now": NOW,
        })[1]
        assert _sends(first)[0]["key"] == "INBOUND_QUALIFY_DM"

        interest = _call(url, "/v1/step", {
            "conversation": _convo(source="instagram", node="qna", brand="Baju Uji"),
            "text": "lebih ke sales kak", "now": NOW,
            "history": _turns(("out", templates.DM_SERVICE_PITCH.strip().split("\n")[-1])),
        })[1]
        send = _sends(interest)[0]
        assert send["key"] == "DM_TO_WA" and "+62 800-0000-0000" in send["text"]
        assert interest["conversation"]["node"] == "wa_handoff"
        assert any(a["type"] == "escalate" for a in interest["actions"])
    finally:
        srv.shutdown()
        srv.server_close()


def test_without_a_number_the_dm_stays_and_a_whatsapp_lead_gets_the_form(server):
    dm = _call(server, "/v1/step", {
        "conversation": _convo(source="instagram", node="qna", brand="Baju Uji"), "text": "boleh kak", "now": NOW,
    })[1]
    assert dm["conversation"]["node"] != "wa_handoff"
    wa = _call(server, "/v1/step", {"conversation": _convo(source=""), "text": "Info kak", "now": NOW})[1]
    assert _sends(wa)[0]["key"] == "INBOUND_QUALIFY"


# --- /v1/propose-slots and /v1/book ------------------------------------------------


def test_propose_slots_confirms_a_requested_free_slot(server):
    step = _call(server, "/v1/step", {
        "conversation": _convo(node="offer_meeting"), "text": "boleh, besok jam 10 bisa?", "now": NOW,
    })[1]
    propose = next(a for a in step["actions"] if a["type"] == "propose_slots")
    assert set(propose) == {"type", "fallback_text", "fallback_key"}
    assert propose["fallback_key"] == "REPLY_SETUJU"

    status, offered = _call(server, "/v1/propose-slots", {
        "conversation": step["conversation"],
        "fallback_text": propose["fallback_text"], "fallback_key": propose["fallback_key"],
        "history": _turns(("in", "boleh, besok jam 10 bisa?")), "now": NOW,
    })
    assert status == 200 and set(offered) == {"messages", "conversation"}
    assert len(offered["messages"]) == 1
    assert "Sabtu 26/09 jam 10.00" in offered["messages"][0]


def test_propose_slots_offers_alternatives_when_the_hour_is_busy(server):
    # 13.00 is held busy by the simulated calendar.
    offered = _call(server, "/v1/propose-slots", {
        "conversation": _convo(node="scheduling"),
        "fallback_text": "fallback", "fallback_key": "REPLY_SETUJU",
        "history": _turns(("in", "boleh, besok jam 13 ya")), "now": NOW,
    })[1]
    # Not confirmed as requested; the open ranges are listed instead, and
    # 13 is where the first range ends and the next begins, never a start.
    assert offered["messages"]
    assert "13.00 saya catat" not in offered["messages"][0]
    assert "09.00-13.00, 14.00-19.00" in offered["messages"][0]


def test_book_returns_the_bdbooking_shape_and_books_the_requested_hour(server):
    status, booking = _call(server, "/v1/book", {
        "conversation": _convo(node="scheduling", email="cika@contoh.id"),
        "history": _turns(("in", "boleh, besok jam 10 bisa?"), ("in", "email saya cika@contoh.id")),
        "now": NOW,
    })
    assert status == 200
    assert set(booking) == {"booked", "meeting_at", "meet_link", "event_id", "html_link", "messages", "conversation"}
    assert booking["booked"] is True
    assert booking["meeting_at"] == "2026-09-26T10:00:00+07:00"
    assert booking["meet_link"] == gcal.SIMULATED_MEET_LINK
    assert booking["event_id"] == "simulated"
    assert booking["conversation"]["node"] == "scheduled"
    assert booking["conversation"]["meet_link"] == gcal.SIMULATED_MEET_LINK
    assert any("10.00 WIB" in m for m in booking["messages"])


def test_book_with_no_hour_offers_slots_instead(server):
    booking = _call(server, "/v1/book", {
        "conversation": _convo(node="scheduling", email="cika@contoh.id"),
        "history": _turns(("in", "email saya cika@contoh.id")), "now": NOW,
    })[1]
    assert booking["booked"] is False and booking["event_id"] is None
    assert booking["meeting_at"] is None
    assert booking["messages"], "the contact still hears something"
    assert booking["conversation"]["node"] == "scheduling"


def test_book_does_not_book_twice_for_a_conversation_that_already_has_a_meeting(server):
    """A re-run of a job (a stalled lock, a retry) must not put a second
    event on the calendar. `event_id` is absent, as bdDraft.ts expects."""
    booking = _call(server, "/v1/book", {
        "conversation": _convo(node="scheduled", email="cika@contoh.id",
                               meeting_at="2026-09-26T03:00:00.000Z", meet_link="https://meet.google.com/abc"),
        "history": _turns(("in", "besok jam 10")), "now": NOW,
    })[1]
    assert booking == {
        "booked": False, "meeting_at": "2026-09-26T10:00:00+07:00", "meet_link": "https://meet.google.com/abc",
        "event_id": None, "html_link": None, "messages": [],
        "conversation": booking["conversation"],
    }
    assert booking["conversation"]["node"] == "scheduled"


def test_a_calendar_failure_still_answers_and_escalates(server, monkeypatch):
    def _down(*_a, **_k):
        raise gcal.CalendarError("token expired")

    monkeypatch.setattr(gcal, "free_slots", _down)
    booking = _call(server, "/v1/book", {
        "conversation": _convo(node="scheduling", email="cika@contoh.id"),
        "history": _turns(("in", "besok jam 10")), "now": NOW,
    })[1]
    assert booking["booked"] is False
    assert booking["messages"] and "sedang saya siapkan" in booking["messages"][0]


# --- /v1/comment-reply ----------------------------------------------------------------


def test_comment_reply_hands_out_the_two_bank_texts_verbatim(server):
    status, texts = _call(server, "/v1/comment-reply")
    assert status == 200
    assert texts == {
        "publicReply": templates.REPLY_KOMENTAR_PUBLIK.strip(),
        "dmOpener": templates.COMMENT_DM_OPENER.strip(),
    }
    assert "{" not in texts["dmOpener"], "sent un-rendered, so no placeholder may be in it"


# --- the serialisation, both ways --------------------------------------------------------


def test_conversation_round_trips(cfg):
    src = _convo(node="scheduled", outcome="acceptance", brand="B", category="fnb", gadget_loops=1,
                 email="a@b.co", last_inbound_at="2026-09-25T03:00:00Z", last_outbound_at=None,
                 meeting_at="2026-09-26T03:00:00+00:00", meet_link="https://m", unknown_streak=0,
                 price_stage=2, stopped_reason="", source="facebook")
    convo = brain_serve.conversation_from(src, cfg)
    assert convo.node is Node.SCHEDULED and convo.source == "facebook"
    out = brain_serve.conversation_to(convo)
    assert out["last_inbound_at"] == "2026-09-25T10:00:00+07:00"
    assert out["meeting_at"] == "2026-09-26T10:00:00+07:00"
    assert out["last_outbound_at"] is None
    assert brain_serve.conversation_to(brain_serve.conversation_from(out, cfg)) == out


def test_nothing_is_ever_sent_through_a_transport(cfg):
    """`_NoTransport` is loud on purpose — a code path that bypasses the
    recording must fail a test, not silently send nothing."""
    with pytest.raises(AssertionError):
        brain_serve._NoTransport().send_text("x", "y")
