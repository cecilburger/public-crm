"""SQLite persistence. Stdlib only."""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime
from pathlib import Path

from .models import Contact, Conversation, Job, Node, Outcome, Timer

SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
    jid              TEXT PRIMARY KEY,
    name             TEXT NOT NULL DEFAULT '',
    brand            TEXT NOT NULL DEFAULT '',
    category         TEXT NOT NULL DEFAULT '',
    email            TEXT NOT NULL DEFAULT '',
    node             TEXT NOT NULL,
    outcome          TEXT NOT NULL,
    gadget_loops     INTEGER NOT NULL DEFAULT 0,
    unknown_streak   INTEGER NOT NULL DEFAULT 0,
    price_stage      INTEGER NOT NULL DEFAULT 0,
    last_inbound_at  TEXT,
    last_outbound_at TEXT,
    meeting_at       TEXT,
    meet_link        TEXT NOT NULL DEFAULT '',
    stopped_reason   TEXT NOT NULL DEFAULT '',
    source           TEXT NOT NULL DEFAULT ''
);

-- The brand database to work through. Separate from `conversations` because a
-- contact exists before it is ever messaged, and must survive being skipped.
CREATE TABLE IF NOT EXISTS contacts (
    jid        TEXT PRIMARY KEY,
    name       TEXT NOT NULL DEFAULT '',
    brand      TEXT NOT NULL DEFAULT '',
    category   TEXT NOT NULL DEFAULT '',
    list_name  TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    blasted_at TEXT
);

-- Small persistent key/value state (last digest date, …). ROADMAP 3.5.
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_queue ON contacts (blasted_at, created_at);

CREATE TABLE IF NOT EXISTS jobs (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    jid      TEXT NOT NULL,
    timer    TEXT NOT NULL,
    fire_at  TEXT NOT NULL,
    payload  TEXT NOT NULL DEFAULT '{}',
    fired    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs (fired, fire_at);
CREATE INDEX IF NOT EXISTS idx_jobs_jid ON jobs (jid, fired);

CREATE TABLE IF NOT EXISTS messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    jid       TEXT NOT NULL,
    direction TEXT NOT NULL,
    body      TEXT NOT NULL,
    intent    TEXT,
    at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_jid ON messages (jid, at);

-- Generated replies saved for reuse: once a template has enough variants,
-- sending it stops costing an API call. `name`/`brand` record what was baked
-- into the text at generation time so it can be re-personalised on reuse.
CREATE TABLE IF NOT EXISTS reply_cache (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    key   TEXT NOT NULL,
    text  TEXT NOT NULL,
    name  TEXT NOT NULL DEFAULT '',
    brand TEXT NOT NULL DEFAULT '',
    at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reply_cache_key ON reply_cache (key);

-- What a message turned out to mean, so the same message never has to be
-- thought about twice. `context` is our own preceding message, normalised:
-- "baik kak" after a slot proposal is not the same case as "baik kak" after a
-- price answer. Rows are written only for readings that carry nothing
-- message-specific (no address, no number, no chosen day) — see
-- understanding.Reading.reusable.
CREATE TABLE IF NOT EXISTS readings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint  TEXT NOT NULL,
    context      TEXT NOT NULL DEFAULT '',
    normalized   TEXT NOT NULL,
    sample       TEXT NOT NULL DEFAULT '',
    payload      TEXT NOT NULL,
    automated    INTEGER NOT NULL DEFAULT 0,
    hits         INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    last_used_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_readings_fp ON readings (fingerprint);
CREATE INDEX IF NOT EXISTS idx_readings_ctx ON readings (context);
CREATE INDEX IF NOT EXISTS idx_readings_norm ON readings (normalized);

CREATE TABLE IF NOT EXISTS escalations (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    jid      TEXT NOT NULL,
    reason   TEXT NOT NULL,
    body     TEXT NOT NULL DEFAULT '',
    at       TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0
);
"""


def _dt(raw: str | None) -> datetime | None:
    return datetime.fromisoformat(raw) if raw else None


def _s(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


class _Rows:
    """What `execute` hands back: a result already read, not a live cursor.

    The rows are fetched while the lock is held, so nothing downstream can be
    reading from a cursor while another thread is using the same connection.
    Everything the call sites use — `fetchone`, `fetchall`, iteration,
    `rowcount`, `lastrowid` — behaves as before.
    """

    __slots__ = ("_rows", "rowcount", "lastrowid")

    def __init__(self, rows, rowcount, lastrowid):
        self._rows = rows
        self.rowcount = rowcount
        self.lastrowid = lastrowid

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows

    def __iter__(self):
        return iter(self._rows)

    def __len__(self):
        return len(self._rows)


class _LockedConnection:
    """One sqlite connection, one lock.

    The bot always shared this connection between the transport thread and the
    timer sweep, and got away with it: two threads, both slow, mostly taking a
    per-contact lock first. A threaded HTTP server on top of the same store
    breaks that assumption — several callers really do land in here at the
    same moment, and concurrent use of one connection raises
    `sqlite3.InterfaceError: bad parameter or other API misuse`, surfacing as
    a caller being told there is nothing to do when there is.

    A lock rather than a connection per thread: the writes here are tiny, and
    one connection is what keeps related rows moving together.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        self._lock = threading.RLock()

    def execute(self, sql, params=()):
        with self._lock:
            cur = self._conn.execute(sql, params)
            rows = cur.fetchall() if cur.description else []
            return _Rows(rows, cur.rowcount, cur.lastrowid)

    def executemany(self, sql, seq):
        with self._lock:
            cur = self._conn.executemany(sql, seq)
            return _Rows([], cur.rowcount, cur.lastrowid)

    def executescript(self, script):
        with self._lock:
            return self._conn.executescript(script)

    def commit(self):
        with self._lock:
            self._conn.commit()

    def close(self):
        with self._lock:
            self._conn.close()

    @property
    def row_factory(self):
        return self._conn.row_factory

    @row_factory.setter
    def row_factory(self, value):
        self._conn.row_factory = value


class Store:
    """The bot's database.

    In `whatsapp-bot-bd` this inherits `ClawStore` (the phone-fleet outbox,
    registry and undo tables). That fleet is not part of the CRM copy
    (25 Sep 2026): the CRM delivers messages through its own bridges, so the
    mixin and its `CLAW_SCHEMA` are the one thing dropped from this file.
    Everything the flow, the engine and the tests use is unchanged, and the
    `brain-serve` HTTP layer opens one of these per request on `:memory:`."""

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        # check_same_thread=False: `run` serves inbound messages on the
        # transport thread while the 60s timer loop calls tick() from its
        # own thread. Python's sqlite3 is compiled serialized
        # (sqlite3.threadsafety == 3), so sharing one autocommit connection
        # across those two threads is safe — without this flag every timer
        # in live mode dies with ProgrammingError. ROADMAP 3.1.
        conn = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        self.db = _LockedConnection(conn)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA)
        # Migrations for databases created before these columns existed.
        for table in ("conversations", "contacts"):
            cols = {r[1] for r in self.db.execute(f"PRAGMA table_info({table})")}
            if table == "conversations" and "email" not in cols:
                self.db.execute(
                    "ALTER TABLE conversations ADD COLUMN email TEXT NOT NULL DEFAULT ''"
                )
            if table == "conversations" and "source" not in cols:
                self.db.execute(
                    "ALTER TABLE conversations ADD COLUMN source TEXT NOT NULL DEFAULT ''"
                )
            if "category" not in cols:
                self.db.execute(
                    f"ALTER TABLE {table} ADD COLUMN category TEXT NOT NULL DEFAULT ''"
                )

    def close(self) -> None:
        self.db.close()

    # --- conversations -----------------------------------------------------

    def get(self, jid: str) -> Conversation | None:
        row = self.db.execute(
            "SELECT * FROM conversations WHERE jid = ?", (jid,)
        ).fetchone()
        return self._to_convo(row) if row else None

    def upsert(self, convo: Conversation) -> None:
        self.db.execute(
            """
            INSERT INTO conversations
                (jid, name, brand, category, email, node, outcome, gadget_loops,
                 unknown_streak, price_stage, last_inbound_at, last_outbound_at,
                 meeting_at, meet_link, stopped_reason, source)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(jid) DO UPDATE SET
                name=excluded.name, brand=excluded.brand,
                category=excluded.category,
                email=excluded.email, node=excluded.node,
                outcome=excluded.outcome, gadget_loops=excluded.gadget_loops,
                unknown_streak=excluded.unknown_streak,
                price_stage=excluded.price_stage,
                last_inbound_at=excluded.last_inbound_at,
                last_outbound_at=excluded.last_outbound_at,
                meeting_at=excluded.meeting_at, meet_link=excluded.meet_link,
                stopped_reason=excluded.stopped_reason,
                source=excluded.source
            """,
            (
                convo.jid,
                convo.name,
                convo.brand,
                convo.category,
                convo.email,
                convo.node.value,
                convo.outcome.value,
                convo.gadget_loops,
                convo.unknown_streak,
                convo.price_stage,
                _s(convo.last_inbound_at),
                _s(convo.last_outbound_at),
                _s(convo.meeting_at),
                convo.meet_link,
                convo.stopped_reason,
                convo.source,
            ),
        )

    def reset(self, jid: str) -> None:
        """Forget one conversation entirely — state, timers, history.

        Used by `simulate --fresh` so a test conversation can be replayed from
        the blast. Contacts are kept: resetting a sim must not re-queue a real
        brand for blasting."""
        for table in ("conversations", "jobs", "messages", "escalations"):
            self.db.execute(f"DELETE FROM {table} WHERE jid = ?", (jid,))

    def all_conversations(self) -> list[Conversation]:
        rows = self.db.execute("SELECT * FROM conversations ORDER BY jid").fetchall()
        return [self._to_convo(r) for r in rows]

    @staticmethod
    def _to_convo(row: sqlite3.Row) -> Conversation:
        convo = Conversation(jid=row["jid"])
        convo.name = row["name"]
        convo.brand = row["brand"]
        convo.category = row["category"]
        convo.email = row["email"]
        convo.node = Node(row["node"])
        convo.outcome = Outcome(row["outcome"])
        convo.gadget_loops = row["gadget_loops"]
        convo.unknown_streak = row["unknown_streak"]
        convo.price_stage = row["price_stage"]
        convo.last_inbound_at = _dt(row["last_inbound_at"])
        convo.last_outbound_at = _dt(row["last_outbound_at"])
        convo.meeting_at = _dt(row["meeting_at"])
        convo.meet_link = row["meet_link"]
        convo.stopped_reason = row["stopped_reason"]
        # Databases predating 18 Sep 2026 have no such column; everything in
        # them arrived on WhatsApp, which is what "" means.
        convo.source = row["source"] if "source" in row.keys() else ""
        return convo

    # --- contacts (the brand database) -------------------------------------

    def add_contacts(
        self, contacts: list[Contact], list_name: str, now: datetime
    ) -> tuple[int, int]:
        """Import contacts. Returns (added, enriched).

        Re-importing is safe and expected — lists get re-exported with more
        columns filled in. An existing row keeps its `blasted_at`, so a brand is
        never messaged twice by re-running an import, and only picks up name or
        brand values it was previously missing.
        """
        added = enriched = 0
        for contact in contacts:
            existing = self.db.execute(
                "SELECT name, brand, category FROM contacts WHERE jid = ?",
                (contact.jid,),
            ).fetchone()
            if existing is None:
                self.db.execute(
                    "INSERT INTO contacts "
                    "(jid, name, brand, category, list_name, created_at) "
                    "VALUES (?,?,?,?,?,?)",
                    (
                        contact.jid,
                        contact.name,
                        contact.brand,
                        contact.category,
                        list_name,
                        now.isoformat(),
                    ),
                )
                added += 1
                continue
            name = existing["name"] or contact.name
            brand = existing["brand"] or contact.brand
            category = existing["category"] or contact.category
            if (name, brand, category) != (
                existing["name"],
                existing["brand"],
                existing["category"],
            ):
                self.db.execute(
                    "UPDATE contacts SET name = ?, brand = ?, category = ? "
                    "WHERE jid = ?",
                    (name, brand, category, contact.jid),
                )
                enriched += 1
        return added, enriched

    def queue(self, limit: int) -> list[Contact]:
        """Contacts still waiting for their opening message, oldest first.

        Excludes anything already in the flow: `blasted_at` catches contacts we
        messaged, and the join catches anyone who messaged *us* first, so an
        inbound conversation is never interrupted by a cold blast.
        """
        rows = self.db.execute(
            """
            SELECT c.* FROM contacts c
            LEFT JOIN conversations v ON v.jid = c.jid
            WHERE c.blasted_at IS NULL AND (v.jid IS NULL OR v.node = 'new')
            ORDER BY c.created_at, c.jid
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        return [
            Contact(
                jid=r["jid"],
                name=r["name"],
                brand=r["brand"],
                category=r["category"],
                created_at=_dt(r["created_at"]),
            )
            for r in rows
        ]

    def mark_blasted(self, jid: str, at: datetime) -> None:
        self.db.execute(
            "UPDATE contacts SET blasted_at = ? WHERE jid = ?", (at.isoformat(), jid)
        )

    def contact_stats(self) -> dict[str, int]:
        row = self.db.execute(
            "SELECT COUNT(*) AS total, "
            "COUNT(blasted_at) AS blasted FROM contacts"
        ).fetchone()
        return {
            "total": int(row["total"]),
            "blasted": int(row["blasted"]),
            "waiting": int(row["total"]) - int(row["blasted"]),
        }

    def blasted_today(self, day: datetime) -> int:
        start = day.replace(hour=0, minute=0, second=0, microsecond=0)
        row = self.db.execute(
            "SELECT COUNT(*) AS n FROM contacts WHERE blasted_at >= ?",
            (start.isoformat(),),
        ).fetchone()
        return int(row["n"])

    def outcome_counts(self) -> dict[str, int]:
        """Conversations grouped by node — the deal / no-deal picture."""
        rows = self.db.execute(
            "SELECT node, COUNT(*) AS n FROM conversations GROUP BY node"
        ).fetchall()
        return {r["node"]: int(r["n"]) for r in rows}

    def meetings(self) -> list[Conversation]:
        rows = self.db.execute(
            "SELECT * FROM conversations WHERE meeting_at IS NOT NULL "
            "ORDER BY meeting_at"
        ).fetchall()
        return [self._to_convo(r) for r in rows]

    # --- jobs --------------------------------------------------------------

    def schedule(self, jid: str, timer: Timer, fire_at: datetime, **payload) -> None:
        self.db.execute(
            "INSERT INTO jobs (jid, timer, fire_at, payload) VALUES (?,?,?,?)",
            (jid, timer.value, fire_at.isoformat(), json.dumps(payload)),
        )

    def cancel_all(self, jid: str) -> int:
        cur = self.db.execute(
            "UPDATE jobs SET fired = 1 WHERE jid = ? AND fired = 0", (jid,)
        )
        return cur.rowcount

    def due(self, now: datetime, limit: int = 50) -> list[Job]:
        rows = self.db.execute(
            "SELECT * FROM jobs WHERE fired = 0 AND fire_at <= ? "
            "ORDER BY fire_at LIMIT ?",
            (now.isoformat(), limit),
        ).fetchall()
        return [
            Job(
                id=r["id"],
                jid=r["jid"],
                timer=Timer(r["timer"]),
                fire_at=datetime.fromisoformat(r["fire_at"]),
                payload=json.loads(r["payload"]),
            )
            for r in rows
        ]

    def mark_fired(self, job_id: int) -> None:
        self.db.execute("UPDATE jobs SET fired = 1 WHERE id = ?", (job_id,))

    def pending(self, jid: str) -> list[Job]:
        rows = self.db.execute(
            "SELECT * FROM jobs WHERE jid = ? AND fired = 0 ORDER BY fire_at", (jid,)
        ).fetchall()
        return [
            Job(
                id=r["id"],
                jid=r["jid"],
                timer=Timer(r["timer"]),
                fire_at=datetime.fromisoformat(r["fire_at"]),
                payload=json.loads(r["payload"]),
            )
            for r in rows
        ]

    # --- log ---------------------------------------------------------------

    def log_message(
        self, jid: str, direction: str, body: str, at: datetime, intent: str = ""
    ) -> None:
        self.db.execute(
            "INSERT INTO messages (jid, direction, body, intent, at) VALUES (?,?,?,?,?)",
            (jid, direction, body, intent or None, at.isoformat()),
        )

    def recent_turns(self, jid: str, limit: int = 8) -> list[tuple[str, str]]:
        """The last turns as (direction, body), OLDEST first.

        Both directions, because half a transcript cannot be read: "baik kak"
        means one thing after a price answer and another after "boleh dibantu
        alamat email-nya?", and the difference is our own message.
        """
        rows = self.db.execute(
            "SELECT direction, body FROM messages WHERE jid = ? "
            "ORDER BY at DESC, id DESC LIMIT ?",
            (jid, limit),
        ).fetchall()
        return [(r["direction"], r["body"]) for r in reversed(rows)]

    # --- learned readings --------------------------------------------------
    #
    # The point of this table: a message the bot has seen before costs nothing
    # to understand the second time. Autoresponders are byte-identical every
    # time, "baik kak" arrives all day, and each one used to be a fresh call.

    #: How alike two messages must be to count as the same case. Deliberately
    #: high — "boleh kirim ke email A" and "boleh kirim ke email B" are 0.95
    #: alike and mean different things, which is why readings carrying an
    #: address are never learned in the first place.
    SIMILAR_ENOUGH = 0.94

    def recall_reading(
        self, context: str, normalized: str, fingerprint: str
    ) -> tuple[dict, int] | None:
        """A learned reading for this message, with the row's hit count.

        Three passes, cheapest first: the exact case, a near-identical message
        after the same thing we said, and — for machine text only — the same
        message after anything, since a switchboard's notice means what it
        means whatever we asked.
        """
        row = self.db.execute(
            "SELECT id, payload, hits FROM readings WHERE fingerprint = ?",
            (fingerprint,),
        ).fetchone()
        if row is None:
            row = self.db.execute(
                "SELECT id, payload, hits FROM readings "
                "WHERE normalized = ? AND automated = 1 LIMIT 1",
                (normalized,),
            ).fetchone()
        if row is None:
            row = self._nearest_reading(context, normalized)
        if row is None:
            return None
        try:
            payload = json.loads(row["payload"])
        except ValueError:
            return None
        self.db.execute(
            "UPDATE readings SET hits = hits + 1, last_used_at = ? WHERE id = ?",
            (datetime.now().isoformat(), row["id"]),
        )
        return payload, row["hits"] + 1

    def _nearest_reading(self, context: str, normalized: str):
        """The closest learned message said in the same place, or None.

        Linear over one context bucket, capped: this runs on every inbound
        message, and a scan of the whole table would grow with the pilot.
        """
        from difflib import SequenceMatcher

        rows = self.db.execute(
            "SELECT id, payload, hits, normalized FROM readings "
            "WHERE context = ? ORDER BY hits DESC LIMIT 200",
            (context,),
        ).fetchall()
        best, score = None, self.SIMILAR_ENOUGH
        for row in rows:
            ratio = SequenceMatcher(None, normalized, row["normalized"]).ratio()
            if ratio >= score:
                best, score = row, ratio
        return best

    def remember_reading(
        self,
        fingerprint: str,
        context: str,
        normalized: str,
        sample: str,
        payload: dict,
        automated: bool,
        at: datetime,
    ) -> None:
        """Learn one case. Re-reading the same message just refreshes it."""
        self.db.execute(
            "INSERT INTO readings "
            "(fingerprint, context, normalized, sample, payload, automated, "
            " created_at) VALUES (?,?,?,?,?,?,?) "
            "ON CONFLICT(fingerprint) DO UPDATE SET payload=excluded.payload, "
            "automated=excluded.automated",
            (fingerprint, context, normalized, sample[:500],
             json.dumps(payload, ensure_ascii=False), int(automated),
             at.isoformat()),
        )

    def learned_readings(self, limit: int = 40) -> list[dict]:
        """The learned cases, most-used first, flattened for printing."""
        rows = self.db.execute(
            "SELECT id, hits, sample, payload, automated FROM readings "
            "ORDER BY hits DESC, id DESC LIMIT ?",
            (limit,),
        ).fetchall()
        out = []
        for row in rows:
            try:
                payload = json.loads(row["payload"])
            except ValueError:
                payload = {}
            out.append({
                "id": row["id"],
                "hits": row["hits"],
                "sample": " ".join((row["sample"] or "").split()),
                "intent": payload.get("intent") or "-",
                "automated": bool(row["automated"]),
                "politeness_only": bool(payload.get("politeness_only")),
                "ends_conversation": bool(payload.get("ends_conversation")),
            })
        return out

    def forget_readings(self, reading_id: int | str | None) -> int:
        """Unlearn one case, or all of them. Returns how many went."""
        if reading_id is None:
            cur = self.db.execute("DELETE FROM readings")
        else:
            cur = self.db.execute(
                "DELETE FROM readings WHERE id = ?", (int(reading_id),))
        return cur.rowcount

    def reading_stats(self) -> tuple[int, int]:
        """(cases learned, times one was reused)."""
        row = self.db.execute(
            "SELECT count(*) AS n, coalesce(sum(hits), 0) AS h FROM readings"
        ).fetchone()
        return row["n"], row["h"]

    def inbound_messages(self, jid: str) -> list[tuple[int, str, str]]:
        """Every message they sent, oldest first: (id, body, current tag)."""
        rows = self.db.execute(
            "SELECT id, body, intent FROM messages "
            "WHERE jid = ? AND direction = 'in' ORDER BY at, id",
            (jid,),
        ).fetchall()
        return [(r["id"], r["body"], r["intent"] or "") for r in rows]

    def turns_before(self, jid: str, message_id: int, limit: int = 8):
        """The turns that preceded one message, oldest first.

        Re-reading history needs the conversation as it stood *then*: what
        "baik kak" answered is the question we had just asked, not the last
        thing in the table.
        """
        rows = self.db.execute(
            "SELECT direction, body FROM messages WHERE jid = ? AND id < ? "
            "ORDER BY id DESC LIMIT ?",
            (jid, message_id, limit),
        ).fetchall()
        return [(r["direction"], r["body"]) for r in reversed(rows)]

    def retag_message(self, message_id: int, intent: str) -> None:
        self.db.execute(
            "UPDATE messages SET intent = ? WHERE id = ?", (intent or None, message_id)
        )

    def jids_with_inbound(self) -> list[str]:
        rows = self.db.execute(
            "SELECT DISTINCT jid FROM messages WHERE direction = 'in'"
        ).fetchall()
        return [r["jid"] for r in rows]

    def recent_inbound_intents(self, jid: str, limit: int = 3) -> list[str]:
        """The tags on their last few messages, newest first.

        `""` for a message logged without one. Used to notice a run of the
        same kind of turn — three "baik kak"s, or a switchboard answering
        every nudge with the same canned line.
        """
        rows = self.db.execute(
            "SELECT intent FROM messages WHERE jid = ? AND direction = 'in' "
            "ORDER BY at DESC, id DESC LIMIT ?",
            (jid, limit),
        ).fetchall()
        return [r["intent"] or "" for r in rows]

    def last_inbound_text(self, jid: str) -> str:
        row = self.db.execute(
            "SELECT body FROM messages WHERE jid = ? AND direction = 'in' "
            "ORDER BY at DESC LIMIT 1",
            (jid,),
        ).fetchone()
        return row["body"] if row else ""

    def unanswered_inbound(self, since: datetime) -> list[tuple[str, str, str]]:
        """Contacts whose newest message is one of theirs, still unanswered.

        `(jid, body, at)`, oldest first. A process killed between reading a
        message and sending the reply leaves exactly this, and nothing retries
        it — a pilot tester asked "lewat chat dulu aja ka, detail paket nya"
        eleven seconds before a restart and simply never got an answer.

        Deliberately only reports. The outbound row is written *after* the send
        (engine `_send`), so a crash in that gap looks identical to a dropped
        reply, and auto-replaying it would send the brand a second copy.
        Silence is recoverable by a human; a duplicate is not.
        """
        rows = self.db.execute(
            """
            SELECT m.jid, m.body, m.at FROM messages m
            JOIN (SELECT jid, MAX(at) AS at FROM messages GROUP BY jid) newest
              ON m.jid = newest.jid AND m.at = newest.at
            WHERE m.direction = 'in' AND m.at >= ?
            ORDER BY m.at
            """,
            (since.isoformat(),),
        ).fetchall()
        return [(r["jid"], r["body"], r["at"]) for r in rows]

    def recent_inbound_texts(self, jid: str, limit: int = 3) -> list[str]:
        """Newest first. The preferred meeting hour may sit a message or two
        before the one carrying the email — slot picking scans all of these."""
        rows = self.db.execute(
            "SELECT body FROM messages WHERE jid = ? AND direction = 'in' "
            "ORDER BY at DESC LIMIT ?",
            (jid, limit),
        ).fetchall()
        return [r["body"] for r in rows]

    def recent_outbound_texts(self, jid: str, limit: int = 5) -> list[str]:
        """Newest first. Used to recognise our own words coming back."""
        rows = self.db.execute(
            "SELECT body FROM messages WHERE jid = ? AND direction = 'out' "
            "ORDER BY at DESC LIMIT ?",
            (jid, limit),
        ).fetchall()
        return [r["body"] for r in rows]

    #: Words a brand uses to close the door. A last resort for the dashboard's
    #: conversation list: the flow's own state is checked first and is far more
    #: reliable than matching text.
    _DECLINE_WORDS = (
        "tidak tertarik", "ga tertarik", "gak tertarik", "nggak tertarik",
        "tidak minat", "ga minat", "gak minat", "kurang minat", "belum minat",
        "tidak butuh", "ga butuh", "gak butuh", "maaf tidak", "maaf ga",
        "stop", "jangan hubungi", "unsubscribe",
    )

    #: Inbound intents that mean a brand is actually shopping, not just
    #: being polite. Asking the price, the contract, the timeline or the
    #: payment terms is what a buyer does; "terima kasih" is not.
    #: `tanya_sistem`, `tanya_komisi` and `tanya_live` joined on 21 Aug: "gimana
    #: sistemnya", "komisinya berapa persen" and "bisa live di akun kami?" are
    #: product questions, and a brand that asks one is further along than most
    #: of what the board was calling interested.
    _INTEREST_INTENTS = frozenset({
        "setuju", "ok_lanjut", "tanya_harga", "nego_harga", "nego_komisi",
        "tanya_sistem", "tanya_komisi", "tanya_live",
        "minta_kontrak", "minta_telepon", "tanya_pembayaran", "tanya_timeline",
        "tanya_portofolio", "tanya_meeting_detail", "tanya_custom",
        "tanya_rekening", "tanya_legalitas", "tanya_kpi", "tanya_target",
        "tanya_paket_lama", "tanya_affiliate", "tanya_sample",
    })

    #: "Kirim ke email kami", "hubungi PIC kami" — a channel, not a yes.
    _REDIRECT_INTENTS = frozenset(
        {"kirim_email", "referral", "hubungkan_pic", "selesai"}
    )

    def _is_machine(self, jid: str) -> bool:
        """Is there nobody on the other end of this thread?

        Not "every message matched" but "most did": a hotline that emits one
        line the detector has never seen is still a hotline, and demanding a
        clean sweep let Interlac through on eight unmatched lines out of
        twelve. A single human message is enough to overturn it, which is what
        protects a brand whose real person takes over after the canned reply.
        """
        rows = [
            r["intent"] for r in self.db.execute(
                "SELECT intent FROM messages WHERE jid = ? AND direction = 'in'",
                (jid,),
            )
        ]
        if not rows:
            return False
        machine = sum(1 for i in rows if i in ("auto", "loop", "echo"))
        if not machine:
            return False

        # The loop breaker has already met this one. Interlac runs an AI
        # assistant that writes flawless Indonesian and refers to itself in the
        # third person — no phrase list was going to catch it, but the breaker
        # did. Its verdict counts for a lot, though not everything: one or two
        # canned lines is a switchboard handing over to a person, which is the
        # case that must survive. Several means nobody ever handed over.
        if machine >= 3 and self.has_open_escalation(jid, "auto-loop"):
            return True
        # Two thirds, or any thread where the only labelled things are machine.
        if machine * 3 >= len(rows) * 2:
            return True
        # Or a thread that has *become* a switchboard: the last two things they
        # sent were both canned. Cellini and Sensatia answer every follow-up
        # with the same marketing greeting, and one early human-looking line
        # kept them under two thirds for good.
        return len(rows) >= 2 and all(i == "auto" for i in rows[-2:])

    def _interest(self, jid: str, convo, has_inbound: bool) -> str:
        """Where this brand stands, most decisive signal first.

        Read off the flow's own state rather than the words in the thread:
        the engine already decided what each message meant, and re-deriving
        that from text would drift from it. Keywords are the last resort, for
        a contact who declined before the machine had classified anything.

        auto > meeting > tidak_minat > minat > sudah_reply > belum_reply.

        "auto" is checked FIRST, before the flow's own state, and that
        ordering is the whole fix. On 13 Aug the machines had already walked
        the flow to `node=scheduling, outcome=acceptance` — so trusting node
        and outcome meant trusting a conclusion a switchboard had reached on
        our behalf, and the dashboard reported ten interested brands of which
        none were.
        """
        if self._is_machine(jid):
            return "auto"

        if convo is not None:
            if convo.meeting_at:
                return "meeting"
            outcome = str(getattr(convo.outcome, "value", convo.outcome) or "")
            node = str(getattr(convo.node, "value", convo.node) or "")
            if outcome == "rejection" or node == "stopped":
                return "tidak_minat"

        if not has_inbound:
            return "belum_reply"

        intents = [
            r["intent"] for r in self.db.execute(
                "SELECT intent FROM messages "
                "WHERE jid = ? AND direction = 'in' AND intent IS NOT NULL",
                (jid,),
            )
        ]
        seen = set(intents)
        if seen & {"tolak_halus", "tolak_tegas", "opt_out"}:
            return "tidak_minat"

        # They named another channel — an inbox, a colleague's number, their
        # switchboard's PIC. A reply, and a lead for a human, but not this
        # brand agreeing to meet us: on 21 Aug five of the 27 "Minat" were
        # brands who had written "langsung email aja".
        if seen & self._REDIRECT_INTENTS or node == "handover":
            return "sudah_reply"

        # Nobody home. Every inbound this contact has sent was a canned reply
        # or a loop the breaker stopped — a switchboard, not a lead. Its own
        # bucket rather than "minat", because on 13 Aug six brand hotlines
        # showed up as interested and the one real lead was buried among them.
        if intents and seen <= {"auto", "loop", "echo"}:
            return "auto"

        # Interest is what they *said* — and only that. Where the flow has
        # parked the conversation is not evidence: `outcome=acceptance` is
        # exactly what a switchboard's canned "baik kak" used to produce, and
        # `menunda_h1` is where a brand lands after "kami sampaikan ke tim
        # dulu", which is a polite hold, not a lead. Twenty of the 27 brands
        # the board called interested on 21 Aug had never said anything of
        # the kind; the last three got in through the node.
        if seen & self._INTEREST_INTENTS:
            return "minat"

        said = " ".join(self.recent_inbound_texts(jid, limit=30)).lower()
        if any(w in said for w in self._DECLINE_WORDS):
            return "tidak_minat"
        return "sudah_reply"

    def conversation_summaries(self) -> list[dict]:
        """One row per contact for the dashboard's chat list, newest first.

        Built from `messages` rather than `conversations` because the list is
        about what was *said* — a contact the bot greeted and who never
        answered still belongs in it, under "belum reply".
        """
        rows = self.db.execute(
            """
            SELECT m.jid,
                   COUNT(*)                                    AS n,
                   MAX(m.at)                                   AS last_at,
                   SUM(m.direction = 'in')                     AS inbound
            FROM messages m
            WHERE m.direction IN ('in', 'out')
            GROUP BY m.jid
            """
        ).fetchall()

        out: list[dict] = []
        for r in rows:
            jid = r["jid"]
            last = self.db.execute(
                "SELECT body FROM messages WHERE jid = ? AND direction IN ('in','out') "
                "ORDER BY at DESC LIMIT 1",
                (jid,),
            ).fetchone()
            convo = self.get(jid)
            status = self._interest(jid, convo, bool(r["inbound"]))
            out.append({
                "jid": jid,
                "phone": jid.split("@")[0],
                "name": (convo.name or convo.brand or "") if convo else "",
                "node": convo.node.value if convo else "",
                "updatedAt": r["last_at"],
                "msgCount": int(r["n"]),
                "lastMsg": (last["body"] if last else "")[:160],
                "status": status,
            })
        out.sort(key=lambda c: c["updatedAt"] or "", reverse=True)
        return out

    def thread(self, jid: str, limit: int = 400) -> list[dict]:
        """The whole exchange with one contact, oldest first.

        Attachments are included — a brand who was sent the deck and never
        answered reads very differently from one who got only text — but the
        demo markers are not: they were scaffolding, never part of the chat.
        """
        rows = self.db.execute(
            "SELECT direction, body, at FROM messages "
            "WHERE jid = ? AND direction IN ('in','out','file') "
            "ORDER BY at LIMIT ?",
            (jid, limit),
        ).fetchall()
        return [
            {
                # The dashboard speaks in chat roles, not directions.
                "role": "user" if r["direction"] == "in" else "assistant",
                "kind": r["direction"],
                "content": (f"[lampiran: {r['body']}]" if r["direction"] == "file"
                            else r["body"]),
                "ts": r["at"],
            }
            for r in rows
        ]

    def outbound_since(self, jid: str, since: datetime) -> int:
        """How many messages we have sent this contact since `since`.

        The loop breaker's counter. Counts 'out' only: attachments and the
        demo markers have their own direction and are not conversation turns.
        """
        row = self.db.execute(
            "SELECT COUNT(*) AS n FROM messages "
            "WHERE jid = ? AND direction = 'out' AND at >= ?",
            (jid, since.isoformat()),
        ).fetchone()
        return int(row["n"])

    def last_outbound(self, jid: str) -> tuple[str, datetime] | None:
        """The most recent thing we said to them, and when."""
        row = self.db.execute(
            "SELECT body, at FROM messages WHERE jid = ? AND direction = 'out' "
            "ORDER BY at DESC LIMIT 1",
            (jid,),
        ).fetchone()
        if row is None:
            return None
        return row["body"], datetime.fromisoformat(row["at"])

    def already_sent_file(self, jid: str, filename: str) -> bool:
        """Has this exact file already gone to this contact?"""
        row = self.db.execute(
            "SELECT 1 FROM messages WHERE jid = ? AND direction = 'file' "
            "AND body = ? LIMIT 1",
            (jid, filename),
        ).fetchone()
        return row is not None

    def record_file(self, jid: str, filename: str, at: datetime) -> None:
        """Note a delivered attachment. Its own direction, so it never counts
        toward the daily send cap or reads back as conversation text."""
        self.log_message(jid, "file", filename, at)

    def sent_today(self, day: datetime) -> int:
        """Every message that went out today, whatever prompted it."""
        start = day.replace(hour=0, minute=0, second=0, microsecond=0)
        row = self.db.execute(
            "SELECT COUNT(*) AS n FROM messages WHERE direction = 'out' AND at >= ?",
            (start.isoformat(),),
        ).fetchone()
        return int(row["n"])

    def proactive_sent_today(self, day: datetime) -> int:
        """Only the messages the bot started — what the daily cap is for.

        The cap exists because messaging people who did not ask is what gets a
        number banned. Answering someone who just wrote to you is the safest
        message the bot sends, so it must not consume the same budget: on
        13 Aug 2026 nineteen openings and eleven replies hit a cap of thirty,
        and the campaign stopped mid-afternoon because brands had engaged.

        Follow-up rungs DO count. They go to people who never answered, which
        is the same unsolicited volume an opening is.

        Rows written before sends were labelled have no intent; they count as
        proactive, because under-counting the cap is the dangerous direction.
        """
        start = day.replace(hour=0, minute=0, second=0, microsecond=0)
        row = self.db.execute(
            "SELECT COUNT(*) AS n FROM messages "
            "WHERE direction = 'out' AND at >= ? "
            "AND (intent IS NULL OR intent <> 'reply')",
            (start.isoformat(),),
        ).fetchone()
        return int(row["n"])

    # -- reply cache --------------------------------------------------------

    def cached_replies(self, key: str) -> list[sqlite3.Row]:
        return self.db.execute(
            "SELECT id, text, name, brand FROM reply_cache WHERE key = ? ORDER BY id",
            (key,),
        ).fetchall()

    def drop_cached_reply(self, row_id: int) -> None:
        """Evict one variant — used when it no longer passes validation."""
        self.db.execute("DELETE FROM reply_cache WHERE id = ?", (row_id,))

    def cache_reply(
        self, key: str, text: str, name: str, brand: str, at: datetime
    ) -> None:
        self.db.execute(
            "INSERT INTO reply_cache (key, text, name, brand, at) VALUES (?,?,?,?,?)",
            (key, text, name, brand, _s(at)),
        )

    def clear_reply_cache(self) -> int:
        cur = self.db.execute("DELETE FROM reply_cache")
        return cur.rowcount

    # -- meta ---------------------------------------------------------------

    def get_meta(self, key: str, default: str = "") -> str:
        row = self.db.execute(
            "SELECT value FROM meta WHERE key = ?", (key,)
        ).fetchone()
        return row["value"] if row else default

    def set_meta(self, key: str, value: str) -> None:
        self.db.execute(
            "INSERT INTO meta (key, value) VALUES (?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )

    def escalate(self, jid: str, reason: str, body: str, at: datetime) -> None:
        self.db.execute(
            "INSERT INTO escalations (jid, reason, body, at) VALUES (?,?,?,?)",
            (jid, reason, body, at.isoformat()),
        )

    def has_open_escalation(self, jid: str, tag: str) -> bool:
        """Is this contact already flagged for this kind of trouble?

        An autoresponder keeps answering, and one open item per canned reply
        would bury the inbox the loop breaker exists to protect.
        """
        row = self.db.execute(
            "SELECT 1 FROM escalations WHERE jid = ? AND resolved = 0 "
            "AND reason LIKE ? LIMIT 1",
            (jid, f"%{tag}%"),
        ).fetchone()
        return row is not None

    def open_escalations(self) -> list[sqlite3.Row]:
        return self.db.execute(
            "SELECT * FROM escalations WHERE resolved = 0 ORDER BY at"
        ).fetchall()

    def resolve_escalation(self, esc_id: int) -> None:
        self.db.execute("UPDATE escalations SET resolved = 1 WHERE id = ?", (esc_id,))


