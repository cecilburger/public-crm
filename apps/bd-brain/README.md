# bd-brain — the BD chatbot, served to the CRM

The `bd_bot` package from `whatsapp-bot-bd`, pulled into the CRM on
25 Sep 2026 so the CRM and its chatbot are one system. The worker
(`apps/worker`) does not run this bot; it **asks** it: every inbound BD
message on WhatsApp Web or Instagram DM becomes one HTTP call carrying the
conversation's state, and the answer is the same state, mutated, plus the
messages to queue. The CRM delivers through its own bridges. Nothing is
stored here — Postgres is the memory.

```
CRM worker (bd.draft)  ──POST /v1/step──▶  brain-serve  ──▶  bd_bot.engine + bd_bot.flow
        │                                       │            (the real bot, in-memory store)
        │◀── actions: send / set_node / … ──────┘
        ├──POST /v1/propose-slots──▶  free slots from Google Calendar (or the simulated one)
        └──POST /v1/book───────────▶  the event + Meet link
```

What it implements is the BD team's inbound funnel — **comment → DM →
WhatsApp → Google Meet** — as trained in `whatsapp-bot-bd` on 24 Sep 2026:
a comment gets one short public line and a DM (`/v1/comment-reply`); a DM
qualifies, pitches once, and hands the lead to `BD_WHATSAPP_NUMBER`;
WhatsApp offers the services and books the meeting. `FLOWCHART.md` is the
design the flow was built from.

## Running it

```bash
# from the repository root, alongside dev:api / dev:worker / the bridges
npm run dev:bd-brain          # python -m bd_bot brain-serve  → http://127.0.0.1:4321
npm run test:bd-brain         # the bot's own pytest suite, offline

# once, for the Python side
cd apps/bd-brain && python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
# then either activate that venv before `npm run dev:bd-brain`, or
BD_BRAIN_PYTHON=apps/bd-brain/.venv/bin/python npm run dev:bd-brain
```

Settings come from two files, root first: the repository root `.env`
(`BD_BRAIN_SECRET`, `BD_BRAIN_URL`, `BD_WHATSAPP_NUMBER`,
`BD_BRAIN_SIMULATE_CALENDAR`, `ANTHROPIC_API_KEY`) and, underneath it,
`apps/bd-brain/.env` for the bot's own settings — see `.env.example` here.
The brain **refuses to start without `BD_BRAIN_SECRET`**; the worker sends
it as a bearer token on every call.

Real bookings need Google OAuth: an OAuth *Desktop app* client JSON at
`secrets/google-credentials.json`, then `PYTHONPATH=src python -m bd_bot
gcal-auth` once on a machine with a browser, and `gcal-check` to confirm.
On a laptop without that, `BD_BRAIN_SIMULATE_CALENDAR=true` books into an
in-memory calendar (every hour free except 13.00) so the booking path can be
walked end to end.

Walk the flow without the CRM at all:

```bash
cd apps/bd-brain
PYTHONPATH=src python -m bd_bot simulate --inbound --fresh                 # a WhatsApp lead
BD_WHATSAPP_NUMBER='+62 8xx' PYTHONPATH=src python -m bd_bot simulate --inbound --jid ig:123 --fresh   # the DM side
```

Docker: `apps/bd-brain/Dockerfile` and the `bd-brain` service in the root
`docker-compose.yml`; the worker reaches it as `http://bd-brain:4321`.

## The contract (`brain_serve.py`, mirrored by `apps/worker/src/bdBrain.ts`)

All `/v1/*` routes require `Authorization: Bearer <BD_BRAIN_SECRET>`
(401 otherwise). Bodies are JSON. `400` means the payload is wrong and the
worker will not retry; `500` is retried with backoff. `GET /healthz` needs
no auth.

| | request | response |
|---|---|---|
| `POST /v1/step` | `conversation` (`BdConversation`), `text`, `now` (ISO), `history` (`{direction:"in"\|"out", body, at?}[]`, oldest first), optional `intent` | `{intent, conversation, actions[]}` |
| `POST /v1/propose-slots` | `conversation`, `fallback_text`, `fallback_key`, `history`, `now` | `{messages[], conversation}` |
| `POST /v1/book` | `conversation`, `history`, `now` | `{booked, meeting_at, meet_link, event_id, html_link, messages[], conversation}` |
| `GET /v1/comment-reply` | — | `{publicReply, dmOpener}` |

Action types, exactly `BdAction` in `bdBrain.ts`: `send {text, key,
attach_company_profile, attach_opening, attach_case_study, attach_ads_deck}`,
`set_node {node, outcome}`, `schedule {timer, fire_at}`, `cancel_timers`,
`book_meeting {preferred}`, `propose_slots {fallback_text, fallback_key}`,
`notify_group {text}`, `escalate {reason, inbound_text}`.

`conversation` mirrors `bd_bot.models.Conversation` field for field,
including `source` (`""` WhatsApp, `"instagram"`, `"facebook"`) — the CRM's
jid is a UUID, so this is how the flow knows it is in a DM.

**Engine-level behaviour, and where it lives now.** In `whatsapp-bot-bd`
the engine reads its SQLite for these; here each is reproduced by running
the *same* `Engine` against a per-request in-memory store seeded from the
request (see the module docstring in `brain_serve.py`):

| behaviour | source in the bot | here |
|---|---|---|
| FOKUS_CAMPAIGN context gate (was our last message the focus question?) | `store.recent_outbound_texts` | the last `out` turn in `history` |
| loop breaker, echo check, "would repeat ourselves" | recent messages + timestamps | `history` with `at` |
| `unknown_streak` → handover, `gadget_loops`, `price_stage` | the conversation row | `conversation` in, `conversation` out |
| DM detection | `Conversation.source` written by the Meta transport | `source` from the CRM's channel kind |
| DM → WhatsApp hand-off number | `Settings.bd_whatsapp_number` | `BD_WHATSAPP_NUMBER` in this process's env |
| autoresponder / referral / "send it to this email" hand-overs | move the node directly | same, plus an explicit `set_node` action |
| booking's event id | `gcal.Booking` inside `_book` | `Engine._calendar_book` (the one engine.py edit) |
| the learned-readings cache, the reply cache | SQLite, across messages | per request only (rebuilt each call; a cost, not a behaviour change) |
| timers (WARM_D2, reminders, …) | the engine's tick loop | returned as `schedule` actions; **the CRM does not fire them yet** |

## What is here, and what is not

Copied as-is, module names unchanged, so a diff against `whatsapp-bot-bd/src/bd_bot`
stays readable: `models`, `flow`, `intents`, `templates`, `knowledge`,
`responder`, `understanding`, `chat_examples`, `config`, `contacts`,
`engine`, `storage`, `gcal`, `groups`, `meta`, `cli`,
`transport/{base,mock,meta}`. Outbound code paths (blast, the cold ladder,
`campaign`, `import`) are in the copy and unused by the CRM — the flow is
one file for both directions.

Edited, each with a dated comment at the spot:

* `storage.py` — no `ClawStore` mixin / `CLAW_SCHEMA` (the phone fleet is not here).
* `engine.py` — `_calendar_free_slots` / `_calendar_book` indirection (above).
* `knowledge.py`, `templates.py` — the company **NPWP number** and **bank
  account number** are not in this repository. `PAYMENT_ACCOUNT_NUMBER` is
  read from the environment (empty by default; the bot never sends it
  anyway), and the legality answer no longer states the NPWP digits.
* `cli.py` — `brain-serve` added; `run`/`login`/`--claw`/`--api-port` refuse
  with a message instead of an import error.

Left out on purpose: `transport/whatsapp.py` and `vendored_magic.py`
(neonize — the CRM's wa-bridge holds the session), `transport/claw.py`,
`claw_api.py`, `claw_store.py` (the phone fleet), `http_api.py` (the
operator dashboard), `outreach_targets.py` (the outbound target list),
`deploy/`, and every piece of customer data: `chat-example/`, `inbound/`,
`assets/`, `opening/`, `secrets/`, `data/`, `tests/data/gold_intents.csv`.
`cli.py` still references the excluded modules lazily (`run`, `login`,
`resolve-group`, `--claw`, `--api-port`, `targets`); those commands fail
with an explanation.

New: `brain_serve.py` (the HTTP layer) and `tests/test_brain_serve.py`.

Tests: the bot's suite minus the files that only test excluded modules
(`test_claw`, `test_http_api`, `test_outreach_targets`, `test_blocklist`,
`test_transport_helpers`). Tests that need the private corpora skip the way
the public `trained-cb` does (`gold_intents.csv`, `inbound/`,
`chat-example/`, `assets/`, `deploy/`).

## Keeping the two copies in sync

`whatsapp-bot-bd` stays the place the WhatsApp bot is paired and trained;
this directory is what the CRM runs. After a training round there:

1. copy the changed modules over (`flow.py`, `intents.py`, `templates.py`,
   `knowledge.py`, `models.py`, `config.py`, `engine.py`, `understanding.py`,
   `responder.py`, `chat_examples.py`, `meta.py`, `transport/meta.py`, `cli.py`,
   `storage.py`) and the matching tests;
2. re-apply the four edits listed above — `git diff` on this directory shows
   each one, and the tests pin them (`test_the_bank_account_number_never_goes_out_in_chat`,
   `tests/test_brain_serve.py`);
3. a new `Node` value needs a CRM migration too (`bd_conversation_state`'s
   check constraint — see `0059_bd_state_wa_handoff.sql`), and a new
   `Conversation` field needs `BdConversation` in `bdBrain.ts` and the
   `bd_conversation_state` columns;
4. `npm run test:bd-brain`, then `npm test` — the CRM's `tests/bd-brain*.test.ts`
   drive the processors against this contract.
