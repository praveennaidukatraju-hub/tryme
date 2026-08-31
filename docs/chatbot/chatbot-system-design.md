# Support Chatbot — System Design & HLD v2

Status: **as built (v1)**, implemented per `docs/superpowers/plans/2026-07-03-support-chatbot.md`.
Read alongside `docs/virtual-tryon-system-design.md` for platform conventions.

v2 supersedes v1 (RAG-only). Scope grew to a **stateful, logged-in live-chat system** with
a **tool-using bot** and **human-in-the-loop (HITL) takeover**.

---

## 1. Purpose & Scope

A support chatbot for **logged-in users** that:
- answers questions from a curated, admin-managed Q&A knowledge base (RAG), and
- can call **account tools** (credits, recent jobs) to answer personal questions, and
- **escalates to a human support agent** when needed, with full live takeover.

### 1.1 Goals

- Ground answers in the curated Q&A set; refuse gracefully when out of scope.
- Let the bot answer account-specific questions ("why did my last job fail?", "credits
  left?") via **server-bound tools** (never trusting the LLM for identity).
- Seamless **HITL**: bot escalates OR agent jumps in; human takeover **terminates the bot**
  for that conversation; agent ends → conversation closed.
- Persist full conversation history (source of truth for widget, admin, handoff, analytics).
- Stay in the TypeScript/pnpm monorepo; reuse `packages/db`, `packages/logger`, existing
  Postgres + Redis, and the existing admin `SUPPORT` role.

### 1.2 Non-Goals (v1)

- No public/logged-out access (auth required).
- No catalogue/marketing data in the vector store — Q&A only.
- No multi-language (English first).
- No agent transfer, canned responses, attachments, read receipts, CSAT (all v1.1 — §20).

---

## 2. Key Decisions (resolved)

| # | Decision | Choice | Why |
|---|---|---|---|
| 1 | Language/runtime | **TypeScript**, in this monorepo | `@langchain/langgraph` is production-stable in TS; Drizzle has pgvector helpers. No Python needed. |
| 2 | Service | **New app `apps/chatbot`** | Hosts the LG agent **and** the WebSocket gateway; owns conversation state. Isolates LangChain weight from `apps/api`. |
| 3 | Access | **Logged-in only** (`access_token`) | Per product decision. |
| 4 | Agent framework | **LangGraph.js** | Graph models retrieve → tools → gate → generate/escalate; conditional edges; streaming. |
| 5 | Vector store | **pgvector on existing Postgres** | One extension, Drizzle-native. Small dataset. |
| 6 | Knowledge source | **`chatbot_qna`** (admin CRUD) | Human-editable source of truth. |
| 7 | Vector index | **`chatbot_embeddings`** (derived) | Full rebuild on re-ingest. |
| 8 | Embeddings | **OpenAI `text-embedding-3-small`** (1536) | Anthropic has no embeddings API. |
| 9 | Generation | **Claude Haiku** (`claude-haiku-4-5-20251001`) | Fast, cheap, good for grounded support. |
| 10 | Bot account access | **Full context via tools** (getCredits, getRecentJobs) | Richer answers. Tools are **userId-bound server-side** (injection-safe, §16). |
| 11 | Real-time transport | **WebSocket** (in `apps/chatbot`) | Native two-way for live human↔user chat; typing/presence easy. |
| 12 | Human agents | **`apps/admin-web`, `SUPPORT` role** (+ MODERATOR/ADMIN/SUPER_ADMIN) | Reuse existing admin auth + app. New "Chat Inbox" page. |
| 13 | Availability | **Manual duty punch-in/out** toggle in admin | Agent is "available" only when on duty; presence (live WS) shown separately. |
| 14 | Escalation triggers | **Three in v1** (§8.1) | User button, repeated low-confidence, agent-initiated. Intent detection deferred to v1.1 (needs preprocess node, §21). |
| 15 | No agent available | **Queue + notify; email fallback** off-hours | Reuse `contact_requests` for async follow-up. |
| 16 | Takeover semantics | **Terminates LG permanently**; agent ends → CLOSED | No hand-back. Simpler state machine. |
| 17 | Memory | **Own `chatbot_messages` + replay** last N | One source of truth; no checkpointer dependency. |
| 18 | Re-ingest | **Full rebuild** in one txn, Redis lock | Tiny dataset; no incremental drift. |

---

## 3. Architecture Overview

```
┌──────────────────────────── Browser ────────────────────────────┐
│  apps/catalogues-web  — chat widget (React)                                  │
│     • WebSocket to apps/chatbot (via BFF-issued ticket)           │
└───────────────┬──────────────────────────────────────────────────┘
                │ WS (user)                       ▲ HTTP (login, history fetch)
                ▼                                 │
┌──────────────────────────────────────────────────────────────────┐
│                    apps/chatbot  (Fastify + WS)                    │
│                                                                    │
│   WS gateway  ── user sockets ──┐   ┌── agent sockets             │
│                                 ▼   ▼                             │
│   Conversation orchestrator  ── state machine (BOT/…/CLOSED)      │
│                                 │                                  │
│   LangGraph bot: retrieve → tools → gate → generate/escalate      │
│                                 │                                  │
│   Redis pub/sub  ◄── bridges LG + cross-instance socket fanout    │
│   POST /ingest (from apps/api)  GET /health                        │
└───────┬───────────────┬───────────────────────┬──────────────────┘
        │ SQL (Drizzle)  │ OpenAI / Anthropic     │ Redis
        ▼                ▼                        ▼
┌───────────────────┐ ┌──────────────┐  ┌────────────────────────────┐
│ Postgres (+pgvec) │ │ OpenAI embed  │  │ Redis                       │
│  chatbot_qna       │ │ Claude Haiku  │  │  pub/sub: conv events       │
│  chatbot_embeddings│ └──────────────┘  │  agent duty + presence      │
│  chatbot_convos    │                   │  ingest lock                │
│  chatbot_messages  │                   │  WS ticket store            │
│  chatbot_events    │                   └────────────────────────────┘
└───────────────────┘
        ▲
        │ /admin/chatbot/*  (CRUD, ingest, claim, takeover, end)
        │ WS (agent)
┌───────────────────┐
│ apps/admin-web (SPA)   │  Chat Inbox + Q&A pages  (SUPPORT role+)
└───────────────────┘
```

`apps/api` owns **admin HTTP actions** (Q&A CRUD, trigger ingest, claim/takeover/end —
these need `requireAdmin`) and publishes resulting events to Redis. `apps/chatbot` owns
**real-time** (WS) + the **bot**. Both share Postgres + Redis.

---

## 4. Conversation State Machine

```
                 user opens chat
                       │
                       ▼
                   ┌───────┐   user "talk to human" / low-conf×N / intent / agent-jump
        ┌──────────│  BOT  │───────────────────────────────┐
        │          └───┬───┘                                │
        │  30-min idle │ bot answers (LG + tools)           │ agent claims directly
        │              │                                    ▼
        │              ▼                              ┌──────────┐
        │       (stays BOT)                           │  HUMAN   │  LG TERMINATED
        │                                             │          │  agent ↔ user live
        │        escalation ─────► ┌───────────────┐  └────┬─────┘
        │                          │ PENDING_HUMAN │───────┘ agent claims from queue
        │                          └───────┬───────┘
        │        no agent on duty ─────────┘
        │            └──► email fallback (contact_requests) ─► CLOSED
        ▼                                                        ▲
    ┌────────┐   agent ends  ◄──────────────────────────────────┘
    │ CLOSED │   (from HUMAN)      idle/abandon (from BOT/PENDING)
    └────────┘
   reopen? → NEW conversation (never reopen CLOSED)
```

| State | Meaning | Who advances it |
|---|---|---|
| `BOT` | LG agent handling | escalation trigger → PENDING_HUMAN or HUMAN; idle → CLOSED |
| `PENDING_HUMAN` | escalated, waiting in queue | agent claim → HUMAN; no agent → email fallback → CLOSED |
| `HUMAN` | agent live, **LG terminated** | agent "End" → CLOSED |
| `CLOSED` | terminal | — (new message = new conversation) |

Every transition writes a `chatbot_events` audit row (actor, from, to, reason, ts).

---

## 5. Data Model

New schema `packages/db/src/schema/chatbot.ts`. pgvector via migration.

### 5.1 `chatbot_qna` — knowledge source (admin CRUD)

`id uuid pk · question text · answer text · tags text[] · is_active bool · created_at · updated_at`

### 5.2 `chatbot_embeddings` — derived index (disposable)

`id uuid pk · qna_id uuid fk→qna on delete cascade · content text · content_tsv tsvector (generated) · embedding vector(1536) · embedded_at`
Indexes: **HNSW cosine** (`vector_cosine_ops`) + **GIN** on `content_tsv` (keyword/BM25 leg
of hybrid retrieval, §7.1).

### 5.3 `chatbot_conversations` — one row per session

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `user_id` | uuid fk→users | logged-in owner |
| `status` | enum(`BOT`,`PENDING_HUMAN`,`HUMAN`,`CLOSED`) | state machine (§4) |
| `assigned_agent_id` | uuid null fk→admin_users | set on claim/takeover |
| `escalation_reason` | text null | `user_request`/`low_confidence`/`intent`/`agent_join` |
| `last_message_at` | timestamptz | drives idle timeout + inbox sort |
| `created_at` / `closed_at` | timestamptz | |

Partial unique index: **one active conversation per user** — `(user_id) WHERE status != 'CLOSED'`.

### 5.4 `chatbot_messages` — every turn (source of truth)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `conversation_id` | uuid fk→conversations on delete cascade | |
| `role` | enum(`user`,`bot`,`agent`,`system`) | `system` = state notices |
| `sender_id` | uuid null | user_id or admin_user_id (null for bot/system) |
| `content` | text | |
| `meta` | jsonb null | tool calls used, retrieved qna ids, etc. |
| `created_at` | timestamptz | |

Bot phase reads **last N messages** here → LG context. Same rows render in widget + admin
and form the handoff transcript.

### 5.5 `chatbot_events` — audit

`id · conversation_id · type(escalate/claim/takeover/close/reopen) · actor_id null · from_status · to_status · reason · created_at`

### 5.6 Redis (ephemeral / fast state)

- `chatbot:agent:duty:{agentId}` → `on|off` (persisted toggle, survives reconnect)
- `chatbot:agent:presence` → **sorted set**, member=agentId, score=last-heartbeat ms (§9.1)
- `chatbot:conv:{id}:lock` → atomic claim lock (single owning agent)
- `chatbot:ws:ticket:{ticket}` → short-lived WS auth ticket → {userId|agentId, role}
- pub/sub channel `chatbot:conv:{id}` → message + state events fanned to sockets
- `chatbot:ingest:lock` → re-ingest mutex

---

## 6. Ingestion Pipeline

Admin button → `POST /admin/chatbot/ingest` (api, `requireAdmin`) → `POST /ingest` (chatbot).

```
1. SELECT * FROM chatbot_qna WHERE is_active = true
2. content = question + "\n" + answer  (per row)
3. Batch-embed all via OpenAI                      ← slow/external, done FIRST
4. TXN: DELETE chatbot_embeddings; INSERT × N       ← atomic swap, chat never sees empty
5. return { ingested, durationMs }
```

Redis `chatbot:ingest:lock` prevents overlap. Full rebuild only (no diffing). <10s.

---

## 7. Bot Agent — LangGraph

### 7.1 Graph

```
START ─► loadContext ─► agentTurn ──(tool_calls?)──► tools ──┐
                          ▲                                   │
                          └───────────────────────────────────┘
                          │
                    (no tool calls)
                          ▼
                        gate ──low conf / N×fallback──► escalate ─► END(→PENDING_HUMAN)
                          │
                          ▼
                       generate ─► END (SSE/WS stream)
```

- **loadContext** — last N `chatbot_messages` + embed latest user turn.
- **agentTurn** — Claude Haiku with tools bound (ReAct-style): decides to call a tool or
  answer. Tools:
  - `searchKnowledge(query)` → **hybrid retrieval**: pgvector cosine top-k + BM25-style
    full-text (`tsvector` / `ts_rank`) over `chatbot_embeddings`, merged via RRF. Returns
    similarity/rank scores so the gate can judge grounding.
  - `getCredits()` → **current user's** credit balance.
  - `getRecentJobs()` → **current user's** recent jobs + statuses.
- **tools** — execute; loop back to agentTurn with results.
- **gate** — if the model can't ground an answer (no useful knowledge hit **and** not a
  tool-answerable question) or repeated fallback → route to escalate.
- **generate** — final grounded answer, streamed over WS.
- **escalate** — set `escalation_reason`, transition BOT→PENDING_HUMAN (§8).

### 7.2 Tool safety (critical)

Tools are parameterized by the **session `userId` bound server-side** from the
authenticated WS/HTTP context — **never** from anything the LLM parses out of the message.
The model cannot request another user's credits/jobs; it can only call `getCredits()` and
the orchestrator injects the owner's id. This is the core defense against prompt-injection
data exfiltration (§16).

### 7.3 System prompt guardrail

*"Answer support questions. Use searchKnowledge for policy/how-to; use getCredits/
getRecentJobs only for the current user's account. If you cannot answer from these,
escalate to a human. Never invent pricing, policy, or account data."*

### 7.4 Multi-provider model selection (added post-v1)

Tool-calling and generation use separately configurable models — see
`docs/superpowers/specs/2026-07-03-chatbot-multi-provider-models-design.md`. Router model
makes one tool-decision pass per turn (no loop-back); generation model writes the final reply
from the tool results and applies the escalate/grounding gate. Supports Anthropic, Google AI
Studio, and any OpenAI-compatible host (OpenRouter, NVIDIA NIM, Ollama, vLLM) via
`CHATBOT_GEN_*` / `CHATBOT_TOOL_*` env vars — see `.env.production.example`.

---

## 8. Escalation & Handoff

### 8.1 Triggers (v1)

1. **User** clicks "Talk to a human" (always available in widget).
2. **Repeated low-confidence** — bot hits gate fallback N times in a row.
3. **Agent-initiated** — on-duty agent watching the inbox jumps into a live BOT conversation
   (BOT→HUMAN directly, LG terminated).

**Intent detection is deferred to v1.1** — auto-routing refund/complaint/billing needs the
preprocess node (§21). v1 trusts the incoming question as-is; hybrid retrieval (§7.1) plus
the triggers above cover routing.

### 8.2 Availability = on-duty AND live

An agent is **available** only when both hold:
1. `chatbot:agent:duty:{id} = on` (manual punch-in button), and
2. the agent is **live** — a fresh presence heartbeat (§9.1).

Duty alone is not enough: an agent who punched in then closed their laptop would otherwise
be a "ghost" that escalations route to. The heartbeat is the liveness truth.

Escalation checks: any available agent (duty ON ∩ online set)? → PENDING_HUMAN + notify.
None? → **email fallback**: create a `contact_requests` row and tell the user "our team
will follow up by email."

### 8.5 Agent drop mid-conversation

If an agent's presence goes stale while assigned a `HUMAN` conversation: grace period
(~60s); if still absent → system message to the user ("reconnecting you…"), release the
claim lock, re-queue the conversation to `PENDING_HUMAN`, and notify other on-duty agents.
Prevents a user stuck talking to a disconnected agent.

### 8.3 Claim & takeover

- **Claim from queue** (PENDING_HUMAN→HUMAN): atomic — `SET chatbot:conv:{id}:lock agentId
  NX`. First agent wins; others see "already claimed." Sets `assigned_agent_id`, writes
  audit, terminates LG.
- **Takeover** (BOT→HUMAN): same lock + terminate LG. Termination is two-layer: (a) api
  publishes a `terminate` event on `chatbot:conv:{id}`; the chatbot instance running the
  graph aborts any in-flight run (AbortController). (b) Belt-and-braces: bot output is
  persisted only after re-checking `status = 'BOT'` inside the write transaction — a late
  bot message can never land after takeover.
- **End** (HUMAN→CLOSED): agent action; sets `closed_at`, releases lock, writes audit.

### 8.4 Idle

- BOT idle 30 min → CLOSED (system message, audit).
- PENDING_HUMAN unclaimed 30 min → **email fallback**: create a `contact_requests` row,
  system message ("no agent free right now — we'll follow up by email"), → CLOSED (audit).
- HUMAN never auto-closes; inbox shows idle warning, agent ends explicitly.
- User messages sent while PENDING_HUMAN are persisted and shown to the claiming agent;
  the bot does not reply (LG is not invoked in this state).
- **Sweeper:** interval job inside `apps/chatbot` (every 60s) closes idle conversations and
  prunes stale members from the presence ZSET (§9.1).

---

## 9. Real-time Transport — WebSocket

- **Server:** `apps/chatbot` via `@fastify/websocket`.
- **Auth handshake:** browser/admin can't put JWT in the WS URL safely, so:
  1. client calls an HTTP endpoint (with its normal auth) → gets a short-lived
     **WS ticket** (`chatbot:ws:ticket:{t}`, ~30s TTL, one-time).
  2. client opens `wss://…/ws?ticket=t`; server resolves ticket → {userId|agentId, role}.
- **Channels:** each conversation = Redis pub/sub `chatbot:conv:{id}`. Sockets subscribe to
  their conversation(s); agents also subscribe to the **queue channel** for new-in-queue
  alerts. Redis fanout means multiple `apps/chatbot` instances stay consistent.
- **Message types (both directions):** `message`, `typing`, `state_change`, `presence`,
  `queue_update`, `error`.
- **Reconnect:** client refetches history via HTTP (`GET /conversations/:id/messages`) then
  resubscribes; WS carries only live deltas. History always comes from Postgres.

### 9.1 Presence heartbeat (agents)

Uses native WS ping/pong + a Redis sorted set — no per-agent key sprawl.

```
agent WS connected
  → every 15s: WS ping ↔ pong (or client heartbeat frame)
  → on each beat:  ZADD chatbot:agent:presence  score=now  member=agentId
  → on clean close: ZREM chatbot:agent:presence agentId   (fast path)
  → unclean drop (laptop shut): no beat → score goes stale

online set = ZRANGEBYSCORE chatbot:agent:presence (now-30s) +inf
             (30s = 2× beat interval; stale members swept periodically)

AVAILABLE (for escalation, §8.2) = duty ON  AND  agentId ∈ online set
```

One ZSET, one range query to count/list live agents. Duty (`chatbot:agent:duty`) is a
separate persistent flag so punch-in survives a brief reconnect while presence tracks the
actual socket.

---

## 10. Session Management & History

- One `chatbot_conversations` row per session; `chatbot_messages` holds all turns.
- Bot context = last N turns replayed into LG (no external memory store).
- **New conversation** created when a logged-in user opens chat with no active (non-CLOSED)
  conversation; an existing active one is resumed. CLOSED never reopens.
- History fetch is paginated HTTP; live updates via WS (§9).

---

## 11. Agent Workspace (`apps/admin-web`)

New page **Chat Inbox** (`apps/admin-web/src/pages/ChatInboxPage.tsx`), gated to
`SUPPORT`+ roles.

- **Duty toggle** — punch in/out (`chatbot:agent:duty`). Off duty = not counted available.
- **Queue** — live list of PENDING_HUMAN (WS `queue_update`), oldest first, escalation
  reason + wait time. "Claim" button (atomic).
- **Live monitor** — active BOT conversations; agent can open + "Take over."
- **Conversation view** — full transcript (user/bot/agent/system), live via WS, typing
  indicators, message input, "End conversation."
- **Audit strip** — escalated why, claimed by, timings (from `chatbot_events`).

Second page **Chatbot Q&A** (`ChatbotQnaPage.tsx`): CRUD + tags + active toggle,
**Re-ingest** button, status strip (active vs embedded count, last ingest).

**Admin parity exception:** Chat Inbox + Chatbot Q&A are **web-only in v1** — explicit
exception to the `apps/admin-mobile` parity rule (agent live-chat needs a desktop
workspace). Revisit for v1.1.

---

## 12. API + WS Surface

### 12.1 `apps/chatbot`

| Kind | Path | Auth | Notes |
|---|---|---|---|
| HTTP | `POST /ws-ticket` | user or agent JWT | issue one-time WS ticket |
| WS | `/ws?ticket=…` | ticket | live chat (user + agent) |
| HTTP | `GET /conversations/:id/messages` | owner or agent | paginated history |
| HTTP | `POST /ingest` | service token | rebuild index (called by api) |
| HTTP | `GET /health` | none | liveness + counts |

### 12.2 `apps/api` (`/admin/chatbot/*`, `requireAdmin`)

| Method | Path | Roles | Notes |
|---|---|---|---|
| GET/POST/PATCH/DELETE | `/admin/chatbot/qna[...]` | ADMIN+ | Q&A CRUD |
| POST | `/admin/chatbot/ingest` | ADMIN+ | proxy → chatbot `/ingest` |
| GET | `/admin/chatbot/conversations` | SUPPORT+ | inbox list/filter |
| POST | `/admin/chatbot/conversations/:id/claim` | SUPPORT+ | atomic claim |
| POST | `/admin/chatbot/conversations/:id/takeover` | SUPPORT+ | BOT→HUMAN |
| POST | `/admin/chatbot/conversations/:id/end` | SUPPORT+ | HUMAN→CLOSED |
| POST | `/admin/chatbot/duty` | SUPPORT+ | punch in/out |

All state-changing api routes publish to Redis `chatbot:conv:{id}` so the WS layer pushes
updates to connected user + agents.

---

## 13. Web Widget (`apps/catalogues-web`)

- Floating bubble in `(app)` layout (logged-in). Hidden when no `access_token`.
- Fetches/opens conversation, requests WS ticket, connects WS.
- Renders streamed bot tokens + live agent messages; shows state ("connecting you to a
  human…", "agents are offline, we'll email you"), typing indicators.
- "Talk to a human" button. Uses `C` design tokens; honors `NEXT_PUBLIC_BASE_PATH`.

---

## 14. Environment Variables

| Var | Used by | Notes |
|---|---|---|
| `OPENAI_API_KEY` | chatbot | embeddings |
| `ANTHROPIC_API_KEY` | chatbot | Claude Haiku |
| `CHATBOT_EMBED_MODEL` / `CHATBOT_GEN_MODEL` | chatbot | defaults per §2 |
| `CHATBOT_TOP_K` / `CHATBOT_SIMILARITY_THRESHOLD` | chatbot | retrieval tuning |
| `CHATBOT_FALLBACK_LIMIT` | chatbot | low-conf count → escalate |
| `CHATBOT_IDLE_TIMEOUT_MIN` | chatbot | default 30 |
| `CHATBOT_MAX_TOOL_ITERATIONS` | chatbot | ReAct loop cap per turn (default 4) |
| `CHATBOT_MAX_TURNS` | chatbot | bot-turn cap per conversation (cost guard) |
| `CHATBOT_PORT` | chatbot | HTTP + WS listen port |
| `CHATBOT_SERVICE_TOKEN` | chatbot, api | internal `/ingest` auth |
| `DATABASE_URL` / `REDIS_URL` | chatbot | shared infra |
| `CHATBOT_WS_URL` | web | browser WS base |
| `CHATBOT_URL` | api | internal base for ingest proxy |
| `JWT_SECRET` | chatbot | verify user + admin tokens for WS tickets |

---

## 15. Security & Safety

- **Tool injection defense (§7.2):** tool params bound to session `userId` server-side;
  LLM cannot read another user's data. Highest-priority invariant.
- **WS auth:** short-lived one-time ticket; no long-lived JWT in URLs. Role encoded in the
  ticket (user vs agent) gates what a socket can do. Agent tickets are issued only after
  verifying the JWT claim **AND** an `admin_users` row lookup — same double-check invariant
  as all `/admin/*` routes.
- **Admin gating:** every `/admin/chatbot/*` uses `requireAdmin`; SUPPORT for live-chat,
  ADMIN+ for Q&A/ingest — same invariant as all admin routes.
- **Rate limiting:** per-user message rate on WS + HTTP (flood/cost control). Block-user is
  v1.1.
- **Grounding:** bot restricted to Q&A + own-account tools; escalates rather than inventing
  policy/pricing.
- **Service isolation:** `/ingest` requires `CHATBOT_SERVICE_TOKEN`; chatbot not public
  except the WS endpoint (ticket-gated).
- **DB/Redis:** bound `127.0.0.1` (existing invariant).
- **Audit:** every escalate/claim/takeover/close in `chatbot_events`.

---

## 16. Observability

- `@tryme/logger` child loggers bound with `conversationId`, `userId`, `agentId`.
- Metrics (`@tryme/observability`): messages, retrieval/gen latency, tool-call rate,
  **fallback rate**, **escalation rate**, queue wait, time-to-claim, resolution time,
  tokens/cost, active sockets, on-duty agents.
- Fallback + escalation rates surface Q&A gaps → feed admins which pairs to add.

---

## 17. Failure Modes

| Failure | Behavior |
|---|---|
| OpenAI/Claude down | stream graceful error; offer human escalation |
| Ingest embed fails | abort before DB write; existing index untouched |
| Two agents claim same convo | Redis `NX` lock — second gets "already claimed" |
| No on-duty agent on escalate | email fallback via `contact_requests`; convo → CLOSED |
| WS drop | client refetches history (HTTP) + resubscribes; no lost messages (Postgres source) |
| chatbot instance restart | sockets reconnect via ticket; Redis pub/sub keeps fanout consistent |
| Empty index | bot leans on tools + escalation; admin status shows 0 embedded |

---

## 18. Build Phases

1. **DB** — pgvector migration + `chatbot_qna`, `chatbot_embeddings`, `chatbot_conversations`,
   `chatbot_messages`, `chatbot_events` (+ HNSW index). Rebuild db package.
2. **chatbot skeleton** — `apps/chatbot`: Fastify, `/health`, Drizzle/Redis wiring, env,
   service-token guard.
3. **Ingest** — `/ingest` + pipeline (§6) + Redis lock.
4. **Admin Q&A** — api CRUD + ingest proxy; `apps/admin-web` Q&A page.
5. **Bot agent** — LangGraph (§7) with tools + gate; WS ticket + `/ws` streaming for
   BOT-phase chat.
6. **Conversation state + history** — state machine, message persistence, replay, idle
   timeout.
7. **HITL** — escalation triggers, duty toggle, queue, atomic claim/takeover/end, email
   fallback; `apps/admin-web` Chat Inbox.
8. **Web widget** — bubble, WS client, streaming, human-handoff UX.
9. **Harden** — rate limits, metrics, audit, prompt-injection review of tools.

Keep the monorepo green (`pnpm typecheck` / `lint` / tests) between phases.

---

## 19. Deferred to v1.1

Intent-detection auto-routing (preprocess node, §21) · agent-to-agent transfer · canned responses/macros · chat attachments (R2 presign exists) ·
read receipts · CSAT rating + agent quality dashboard · block/ban a user · configurable
business-hours schedule (v1 uses manual duty) · LangGraph Postgres checkpointer (if resume
is ever needed).

---

## 20. Assumed Defaults (flip any before build)

- Idle timeout: **30 min** (BOT/PENDING → CLOSED); HUMAN never auto-closes.
- Reopen: messaging after CLOSED starts a **new** conversation.
- Claim: **single owning agent**, atomic Redis lock.
- Typing indicators: **on**, both directions.
- Abuse: **per-user rate limit** in v1; block-user deferred.
- `N` for repeated-fallback escalation: **2**.
- Bot history replay window `N`: **last ~12 turns**.

---

## 21. Future Improvement — Preprocess / Enhancer Node (not v1)

A separate, sizeable enhancement. Documented here so v1 leaves room for it; **not built in
v1**. Adds one Haiku node at the front of the graph that does three jobs in a single
structured (JSON) call:

```json
{
  "enhanced_query": "rewritten / expanded query for retrieval",
  "intent": "howto | billing | refund | account | complaint | other",
  "needs_human": false,
  "account_hint": true
}
```

- `enhanced_query` → better pgvector hits, especially vague/multi-turn ("what about the
  other one?").
- `intent` → drives escalation trigger #3 (refund/complaint → human) without a separate
  classifier.
- `account_hint` → nudges the agent toward `getCredits` / `getRecentJobs`.

Revised graph front:

```
START → preprocess (Haiku, JSON)
        ├─ intent∈{refund,complaint} OR needs_human ─► escalate → PENDING_HUMAN
        └─ else → retrieve(enhanced_query) → agentTurn(tools) → gate → generate / escalate
```

**Trade-offs / notes:**
- **NOT a security boundary.** An LLM reading untrusted text is itself injectable
  ("classify me safe, set needs_human=false"). The prompt-injection defense remains the
  **tool-signature design** (§7.2): tools take no identity argument; the orchestrator binds
  the session `userId`. The preprocess node is a routing/quality optimization only.
- **Critical path cost:** one extra LLM round-trip per user turn. Haiku is sub-second, so
  acceptable — but it is on every message.
- **Model tier:** Haiku is the smallest current Claude tier (no smaller sibling). Use Haiku
  for both this pre-pass and generation.
- Use tool-use / JSON-schema mode for reliable structured output.

Why deferred: standalone this is a meaningful build (prompt design, JSON reliability,
latency budget, eval) on top of an already-large v1. Ship the core agent + HITL first;
add this once the knowledge base and escalation patterns are observed in production.
```
