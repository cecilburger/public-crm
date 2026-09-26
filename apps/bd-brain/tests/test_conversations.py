"""What the dashboard's chat panel reads.

The panel is the only window onto conversations the bot runs by itself, so the
shape here is a contract: `status` colours the list, `role` decides which side
a bubble sits on, and a contact who was greeted but never answered has to
appear at all — those are the ones somebody needs to chase.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bd_bot.models import Conversation, Node  # noqa: E402
from bd_bot.storage import Store  # noqa: E402

JID = "628119000002@s.whatsapp.net"
OTHER = "628999000111@s.whatsapp.net"


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "c.sqlite3")
    yield s
    s.close()


def _at(mins):
    return datetime(2026, 8, 13, 14, 0) + timedelta(minutes=mins)


def test_a_greeted_contact_who_never_replied_still_appears(store):
    """These are exactly the ones a human needs to chase."""
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Cimory"))
    store.log_message(JID, "out", "Selamat siang, Kak.", _at(0))
    [c] = store.conversation_summaries()
    assert c["status"] == "belum_reply"
    assert c["msgCount"] == 1 and c["phone"] == "628119000002"


def test_a_contact_who_replied_reads_as_talking(store):
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Cimory"))
    store.log_message(JID, "out", "Selamat siang", _at(0))
    store.log_message(JID, "in", "boleh minta detailnya", _at(1))
    assert store.conversation_summaries()[0]["status"] == "sudah_reply"


def test_a_refusal_is_flagged(store):
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="Cimory"))
    store.log_message(JID, "out", "Selamat siang", _at(0))
    store.log_message(JID, "in", "maaf kami tidak tertarik", _at(1))
    assert store.conversation_summaries()[0]["status"] == "tidak_minat"


def test_newest_conversation_comes_first(store):
    for jid, when in ((JID, 0), (OTHER, 30)):
        store.upsert(Conversation(jid=jid, node=Node.BLASTED))
        store.log_message(jid, "out", "halo", _at(when))
    assert [c["jid"] for c in store.conversation_summaries()] == [OTHER, JID]


def test_the_last_message_is_what_the_list_shows(store):
    store.upsert(Conversation(jid=JID, node=Node.BLASTED))
    store.log_message(JID, "out", "pertama", _at(0))
    store.log_message(JID, "in", "terakhir", _at(1))
    assert store.conversation_summaries()[0]["lastMsg"] == "terakhir"


def test_markers_and_attachments_do_not_invent_a_conversation(store):
    """A demo marker is scaffolding; it must not create a chat row."""
    store.log_message(JID, "demo", "⏩ *1 hari kemudian*", _at(0))
    assert store.conversation_summaries() == []


# -- the thread ------------------------------------------------------------


def test_a_thread_reads_oldest_first_with_chat_roles(store):
    store.upsert(Conversation(jid=JID, node=Node.BLASTED))
    store.log_message(JID, "out", "Selamat siang", _at(0))
    store.log_message(JID, "in", "hai", _at(1))
    store.log_message(JID, "out", "boleh saya kirim deck?", _at(2))
    t = store.thread(JID)
    assert [m["role"] for m in t] == ["assistant", "user", "assistant"]
    assert t[0]["content"] == "Selamat siang"


def test_attachments_show_in_the_thread(store):
    """A brand sent the deck and silent reads differently from text-only."""
    store.upsert(Conversation(jid=JID, node=Node.BLASTED))
    store.log_message(JID, "out", "Selamat siang", _at(0))
    store.record_file(JID, "Company Profile.pdf", _at(1))
    t = store.thread(JID)
    assert t[1]["kind"] == "file"
    assert "Company Profile.pdf" in t[1]["content"]


def test_demo_markers_stay_out_of_the_thread(store):
    store.upsert(Conversation(jid=JID, node=Node.BLASTED))
    store.log_message(JID, "out", "halo", _at(0))
    store.log_message(JID, "demo", "⏩ *1 hari kemudian*", _at(1))
    assert [m["content"] for m in store.thread(JID)] == ["halo"]


def test_an_unknown_jid_is_an_empty_thread(store):
    assert store.thread("628000@s.whatsapp.net") == []


# -- the interest tracker ---------------------------------------------------
# Read off the flow's own state, not the words in the thread: the engine has
# already decided what each message meant, and re-deriving it from text would
# drift from that. meeting > tidak_minat > minat > sudah_reply > belum_reply.


def _status(store, jid=JID):
    return {c["jid"]: c["status"] for c in store.conversation_summaries()}[jid]


def test_a_booked_meeting_outranks_everything(store):
    """The real case: Pip Mim Official, 13 Aug 2026 — booked for Saturday."""
    c = Conversation(jid=JID, node=Node.SCHEDULED, name="Pip Mim Official")
    c.meeting_at = datetime(2026, 8, 15, 12, 0)
    c.meet_link = "https://meet.google.com/fdu-eswu-xco"
    store.upsert(c)
    store.log_message(JID, "in", "boleh kak dijadwalkan online meeting", _at(0), "setuju")
    assert _status(store) == "meeting"


def test_acceptance_reads_as_interested(store):
    from bd_bot.models import Outcome

    c = Conversation(jid=JID, node=Node.QNA, name="X")
    c.outcome = Outcome.ACCEPTANCE
    store.upsert(c)
    store.log_message(JID, "in", "boleh kak", _at(0), "setuju")
    assert _status(store) == "minat"


@pytest.mark.parametrize("node", [Node.OFFER_MEETING, Node.SCHEDULING, Node.MENUNDA_H1])
def test_scheduling_nodes_read_as_interested(store, node):
    store.upsert(Conversation(jid=JID, node=node, name="X"))
    store.log_message(JID, "in", "oke", _at(0), "ok_lanjut")
    assert _status(store) == "minat"


@pytest.mark.parametrize("intent", [
    "tanya_harga", "nego_harga", "minta_kontrak", "tanya_pembayaran",
    "tanya_timeline", "setuju",
])
def test_buying_questions_read_as_interested(store, intent):
    """Asking the price or the contract is what a buyer does."""
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="X"))
    store.log_message(JID, "in", "berapa harganya?", _at(0), intent)
    assert _status(store) == "minat"


def test_politeness_is_not_interest(store):
    """"terima kasih" is not a buying signal."""
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="X"))
    store.log_message(JID, "in", "terima kasih infonya", _at(0), "terima_kasih")
    assert _status(store) == "sudah_reply"


@pytest.mark.parametrize("intent", ["tolak_halus", "tolak_tegas", "opt_out"])
def test_a_refusal_wins_over_earlier_interest(store, intent):
    """A brand who asked the price and then said no is a no."""
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="X"))
    store.log_message(JID, "in", "berapa harganya?", _at(0), "tanya_harga")
    store.log_message(JID, "in", "gak dulu kak", _at(1), intent)
    assert _status(store) == "tidak_minat"


def test_rejection_outcome_wins_over_a_scheduling_node(store):
    from bd_bot.models import Outcome

    c = Conversation(jid=JID, node=Node.SCHEDULING, name="X")
    c.outcome = Outcome.REJECTION
    store.upsert(c)
    store.log_message(JID, "in", "maaf batal", _at(0), "unknown")
    assert _status(store) == "tidak_minat"


def test_a_stopped_conversation_is_not_interested(store):
    store.upsert(Conversation(jid=JID, node=Node.STOPPED, name="X"))
    store.log_message(JID, "in", "stop", _at(0), "opt_out")
    assert _status(store) == "tidak_minat"


def test_silence_is_still_silence(store):
    store.upsert(Conversation(jid=JID, node=Node.BLASTED, name="X"))
    store.log_message(JID, "out", "Selamat siang", _at(0), "blast")
    assert _status(store) == "belum_reply"


# -- the 21 Aug recount ----------------------------------------------------
# The board read 27 brands as interested; two of them were. Every case below
# was one of the twenty-five, and each one turns on the same thing: the flow's
# state is not evidence of interest, because a machine can walk the flow and
# a pleasantry used to be read as agreement.


def test_a_pleasantry_is_not_interest(store):
    """Kymm Skin: "Baik kak 😊🙏🏻-sa", six times, parked at acceptance."""
    from bd_bot.models import Outcome

    c = Conversation(jid=JID, node=Node.SCHEDULING, name="Kymm Skin")
    c.outcome = Outcome.ACCEPTANCE
    store.upsert(c)
    store.log_message(JID, "in", "baik kak 😊🙏🏻-sa", _at(0), "basa_basi")
    assert _status(store) == "sudah_reply"


def test_an_inbox_instead_of_a_meeting_is_not_interest(store):
    """Bali Botanica: "Boleh langsung ke email marketing@… aja ya kak"."""
    store.upsert(Conversation(jid=JID, node=Node.WARM_D2, name="Bali Botanica"))
    store.log_message(JID, "in", "langsung email aja", _at(0), "kirim_email")
    assert _status(store) == "sudah_reply"


def test_a_referral_is_not_interest(store):
    store.upsert(Conversation(jid=JID, node=Node.HANDOVER, name="Marimas"))
    store.log_message(JID, "in", "hubungi PIC kami ya", _at(0), "referral")
    assert _status(store) == "sudah_reply"


def test_a_switchboard_that_never_hands_over_is_a_bot(store):
    """Cellini answers every follow-up with the same marketing greeting. One
    early line the old detector mislabelled kept it under two thirds forever."""
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="Cellini"))
    store.log_message(JID, "in", "Selamat siang, saya Zahwa dari tim marketing",
                      _at(0), "tanya_lokasi")
    store.log_message(JID, "in", "Selamat siang, saya Zahwa dari tim marketing",
                      _at(5), "auto")
    store.log_message(JID, "in", "Selamat siang, saya Zahwa dari tim marketing",
                      _at(9), "auto")
    assert _status(store) == "auto"


def test_a_person_after_the_canned_line_is_not_a_bot(store):
    """The case the machine rule must never eat: a switchboard hands over."""
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="Kino"))
    store.log_message(JID, "in", "Terima kasih telah menghubungi kami", _at(0), "auto")
    store.log_message(JID, "in", "berapa harga paketnya kak?", _at(4), "tanya_harga")
    assert _status(store) == "minat"


def test_the_flow_state_alone_no_longer_makes_a_lead(store):
    """A machine walked this thread to scheduling on 13 Aug."""
    from bd_bot.models import Outcome

    c = Conversation(jid=JID, node=Node.SCHEDULING, name="Sensatia")
    c.outcome = Outcome.ACCEPTANCE
    store.upsert(c)
    store.log_message(JID, "in", "Salam hangat dari Sensatia", _at(0), "terima_kasih")
    assert _status(store) == "sudah_reply"


def test_a_real_yes_still_reads_as_interest(store):
    """Green Angelica picked Tuesday. It must survive all of the above."""
    store.upsert(Conversation(jid=JID, node=Node.SCHEDULING, name="Green Angelica"))
    store.log_message(JID, "in", "Bolehhh", _at(0), "setuju")
    store.log_message(JID, "in", "Selasa aja yaa", _at(3), "ok_lanjut")
    assert _status(store) == "minat"


@pytest.mark.parametrize("intent", ["tanya_sistem", "tanya_komisi", "tanya_live"])
def test_product_questions_read_as_interested(store, intent):
    """"Gimana sistemnya", "komisinya berapa", "bisa live di akun kami?" —
    further along than most of what the board called interested."""
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="X"))
    store.log_message(JID, "in", "gimana sistemnya kak?", _at(0), intent)
    assert _status(store) == "minat"


def test_doubting_our_legitimacy_is_not_interest(store):
    """"Kantornya di mana?" is a brand checking we are real, not shopping."""
    store.upsert(Conversation(jid=JID, node=Node.QNA, name="X"))
    store.log_message(JID, "in", "kantornya dimana ya?", _at(0), "tanya_lokasi")
    assert _status(store) == "sudah_reply"


def test_a_polite_hold_is_not_interest(store):
    """Kymm Skin again, the last way it got in: the flow parks a brand at
    menunda_h1 after "kami sampaikan ke tim dulu", and the node alone used to
    count as a lead."""
    store.upsert(Conversation(jid=JID, node=Node.MENUNDA_H1, name="Kymm Skin"))
    store.log_message(JID, "in", "kami bantu sampaikan ke tim ya kak", _at(0),
                      "teruskan_tim")
    store.log_message(JID, "in", "Baik kak 😊🙏🏻-sa", _at(5), "basa_basi")
    assert _status(store) == "sudah_reply"


def test_we_will_get_back_to_you_is_not_interest(store):
    """Kacang Ijo: "Baik, kami akan hubungi kembali ya"."""
    store.upsert(Conversation(jid=JID, node=Node.MENUNDA_H1, name="Kacang Ijo"))
    store.log_message(JID, "in", "Baik, kami akan hubungi kembali ya", _at(0),
                      "nanti_aja")
    assert _status(store) == "sudah_reply"
