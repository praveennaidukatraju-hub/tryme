# Support Chatbot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the stateful, logged-in live-chat support system from `docs/chatbot/chatbot-system-design.md` — RAG bot with account tools, WebSocket transport, and human-in-the-loop takeover.

**Architecture:** New service `apps/chatbot` (Fastify + WS) hosts the LangGraph bot, conversation state machine, and real-time gateway. `apps/api` hosts the admin HTTP surface (Q&A CRUD, ingest proxy, inbox/claim/takeover/end/duty). Both share Postgres (+pgvector) and Redis (pub/sub fanout, presence, locks). `apps/admin-web` gets a Chat Inbox + Q&A page; `apps/catalogues-web` gets a floating chat widget.

**Tech Stack:** TypeScript 5.6 ESM, Fastify 5, `@fastify/websocket`, Drizzle ORM + pgvector, Redis 7 (ioredis), LangGraph.js (`@langchain/langgraph` + `@langchain/anthropic`), OpenAI embeddings via raw `fetch`, Vitest.

## Global Constraints

- Spec: `docs/chatbot/chatbot-system-design.md` (v2, as amended 2026-07-03). Read the relevant section before each task.
- pnpm workspaces only; never npm/yarn lockfiles. ESM everywhere (`"type": "module"`).
- Logger: `createLogger(service)` from `@tryme/logger`; **no `console.log`**.
- Postgres/Redis bind `127.0.0.1` (dev via `pnpm docker:up`); tests require docker infra running.
- All `/admin/chatbot/*` routes use `requireAdmin` (JWT claim AND `admin_users` row). Q&A/ingest = `['SUPER_ADMIN','ADMIN']`; live-chat = `['SUPER_ADMIN','MODERATOR','ADMIN','SUPPORT']`.
- Tool safety invariant (§7.2): account tools take **no identity argument**; orchestrator binds session `userId`. Never accept a userId from model output.
- Bot output persisted only after re-checking `status = 'BOT'` inside the write transaction (§8.3).
- Generation model: `claude-haiku-4-5-20251001`. Embeddings: OpenAI `text-embedding-3-small` (1536 dims).
- Web UI: use `C` tokens from `apps/catalogues-web/src/components/tokens.ts`; honor `NEXT_PUBLIC_BASE_PATH`. Admin UI: follow existing page patterns (`apiFetch` from `src/lib/data.ts`, CSS vars).
- Admin parity: Chat Inbox + Q&A are **web-only in v1** (documented exception).
- Keep monorepo green between tasks: `pnpm typecheck` must pass before each commit.
- Per-task commits below are authorized by the user's approval of this plan. Do not push.
- Deviation from spec doc (record in Task 15 doc update): agent duty is a Redis **SET** `chatbot:agent:duty` (members = adminUserId) instead of per-agent string keys — avoids SCAN when computing availability.

---

### Task 1: pgvector infra + chatbot DB schema + migration

**Files:**
- Modify: `infra/docker-compose.yml:5` (postgres image)
- Create: `packages/db/src/schema/chatbot.ts`
- Modify: `packages/db/src/schema/index.ts`
- Create: `packages/db/src/migrations/0078_chatbot.sql` (via `pnpm db:generate`, then hand-edit)

**Interfaces:**
- Produces Drizzle tables consumed by all later tasks: `schema.chatbotQna`, `schema.chatbotEmbeddings`, `schema.chatbotConversations`, `schema.chatbotMessages`, `schema.chatbotEvents` with the exact columns below.

- [ ] **Step 1: Swap postgres image to pgvector build**

In `infra/docker-compose.yml` change line 5:

```yaml
    image: pgvector/pgvector:pg16
```

(`pgvector/pgvector:pg16` is the official postgres:16 image + the extension binaries; existing volume data is compatible.) Then restart infra:

Run: `pnpm docker:up`
Expected: postgres recreated healthy. Verify: `docker exec $(docker ps -qf name=postgres) psql -U tryon -d tryon_dev -c "SELECT 1"` → `1`.

- [ ] **Step 2: Write the schema file**

Create `packages/db/src/schema/chatbot.ts`:

```ts
import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { adminUsers } from './admin.js';
import { users } from './users.js';

export const chatbotQna = pgTable('chatbot_qna', {
  id: uuid('id').primaryKey().defaultRandom(),
  question: text('question').notNull(),
  answer: text('answer').notNull(),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const chatbotEmbeddings = pgTable(
  'chatbot_embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    qnaId: uuid('qna_id')
      .notNull()
      .references(() => chatbotQna.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    contentTsv: tsvector('content_tsv').generatedAlwaysAs(
      sql`to_tsvector('english', content)`,
    ),
    embedding: vector('embedding', { dimensions: 1536 }).notNull(),
    embeddedAt: timestamp('embedded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('chatbot_embeddings_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('chatbot_embeddings_tsv_idx').using('gin', t.contentTsv),
  ],
);

export const chatbotConversations = pgTable(
  'chatbot_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('BOT'), // BOT | PENDING_HUMAN | HUMAN | CLOSED
    assignedAgentId: uuid('assigned_agent_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    escalationReason: text('escalation_reason'), // user_request | low_confidence | agent_join
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    // one active (non-CLOSED) conversation per user (§5.3)
    uniqueIndex('chatbot_conversations_one_active_idx')
      .on(t.userId)
      .where(sql`${t.status} <> 'CLOSED'`),
    index('chatbot_conversations_status_idx').on(t.status, t.lastMessageAt),
  ],
);

export const chatbotMessages = pgTable(
  'chatbot_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => chatbotConversations.id, { onDelete: 'cascade' }),
    role: text('role').notNull(), // user | bot | agent | system
    senderId: uuid('sender_id'), // users.id or admin_users.id; null for bot/system
    content: text('content').notNull(),
    meta: jsonb('meta').$type<{ toolCalls?: string[]; qnaIds?: string[] }>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('chatbot_messages_conv_idx').on(t.conversationId, t.createdAt)],
);

export const chatbotEvents = pgTable('chatbot_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => chatbotConversations.id, { onDelete: 'cascade' }),
  type: text('type').notNull(), // escalate | claim | takeover | close
  actorId: uuid('actor_id'),
  fromStatus: text('from_status'),
  toStatus: text('to_status'),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Append to `packages/db/src/schema/index.ts`:

```ts
export * from './chatbot.js';
```

- [ ] **Step 3: Generate migration**

Run: `DATABASE_URL=postgres://tryon:tryon_dev_pw@127.0.0.1:5432/tryon_dev pnpm db:generate`
Expected: new `packages/db/src/migrations/0078_*.sql` + journal entry idx 78.

- [ ] **Step 4: Hand-edit the generated SQL**

The extension and generated column may not emit correctly from drizzle-kit. Open the generated `0078_*.sql` and ensure it is equivalent to this reference (edit to match; keep drizzle's `--> statement-breakpoint` separators):

```sql
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chatbot_qna" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "question" text NOT NULL,
  "answer" text NOT NULL,
  "tags" text[] DEFAULT '{}'::text[] NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chatbot_embeddings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "qna_id" uuid NOT NULL,
  "content" text NOT NULL,
  "content_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  "embedding" vector(1536) NOT NULL,
  "embedded_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "chatbot_embeddings_qna_id_fk" FOREIGN KEY ("qna_id") REFERENCES "chatbot_qna"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chatbot_conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "status" text DEFAULT 'BOT' NOT NULL,
  "assigned_agent_id" uuid,
  "escalation_reason" text,
  "last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "closed_at" timestamp with time zone,
  CONSTRAINT "chatbot_conversations_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade,
  CONSTRAINT "chatbot_conversations_agent_fk" FOREIGN KEY ("assigned_agent_id") REFERENCES "admin_users"("id") ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chatbot_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL,
  "role" text NOT NULL,
  "sender_id" uuid,
  "content" text NOT NULL,
  "meta" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "chatbot_messages_conv_fk" FOREIGN KEY ("conversation_id") REFERENCES "chatbot_conversations"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chatbot_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL,
  "type" text NOT NULL,
  "actor_id" uuid,
  "from_status" text,
  "to_status" text,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "chatbot_events_conv_fk" FOREIGN KEY ("conversation_id") REFERENCES "chatbot_conversations"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chatbot_embeddings_hnsw_idx" ON "chatbot_embeddings" USING hnsw ("embedding" vector_cosine_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chatbot_embeddings_tsv_idx" ON "chatbot_embeddings" USING gin ("content_tsv");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chatbot_conversations_one_active_idx" ON "chatbot_conversations" ("user_id") WHERE "status" <> 'CLOSED';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chatbot_conversations_status_idx" ON "chatbot_conversations" ("status","last_message_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chatbot_messages_conv_idx" ON "chatbot_messages" ("conversation_id","created_at");
```

- [ ] **Step 5: Apply migration + verify**

Run: `pnpm db:migrate`
Expected: applies cleanly. Verify: `docker exec $(docker ps -qf name=postgres) psql -U tryon -d tryon_dev -c "\d chatbot_embeddings"` shows `embedding | vector(1536)` and `content_tsv | tsvector | generated always`.

Run: `pnpm --filter @tryme/db build && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add infra/docker-compose.yml packages/db/src/schema/chatbot.ts packages/db/src/schema/index.ts packages/db/src/migrations/
git commit -m "feat(db): chatbot schema + pgvector migration"
```

---

### Task 2: Shared Zod types (`@tryme/types`)

**Files:**
- Create: `packages/types/src/chatbot.ts`
- Modify: `packages/types/src/index.ts`

**Interfaces:**
- Produces (used by chatbot app, api, admin-web, catalogues-web):
  - `ConversationStatus` = `z.enum(['BOT','PENDING_HUMAN','HUMAN','CLOSED'])`
  - `ChatMessage` (zod object, `ChatMessageT` inferred type)
  - `WsClientFrame` / `WsAgentFrame` / `WsServerFrame` discriminated unions
  - `QnaUpsert` (admin CRUD body)

- [ ] **Step 1: Write the types file**

Create `packages/types/src/chatbot.ts`:

```ts
import { z } from 'zod';

export const ConversationStatus = z.enum(['BOT', 'PENDING_HUMAN', 'HUMAN', 'CLOSED']);
export type ConversationStatusT = z.infer<typeof ConversationStatus>;

export const ChatRole = z.enum(['user', 'bot', 'agent', 'system']);

export const ChatMessage = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  role: ChatRole,
  senderId: z.string().uuid().nullable(),
  content: z.string(),
  createdAt: z.string(), // ISO
});
export type ChatMessageT = z.infer<typeof ChatMessage>;

// frames a USER socket may send
export const WsClientFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), content: z.string().min(1).max(2000) }),
  z.object({ type: z.literal('typing') }),
  z.object({ type: z.literal('escalate') }),
]);
export type WsClientFrameT = z.infer<typeof WsClientFrame>;

// frames an AGENT socket may send
export const WsAgentFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('join'), conversationId: z.string().uuid() }),
  z.object({ type: z.literal('leave'), conversationId: z.string().uuid() }),
  z.object({
    type: z.literal('message'),
    conversationId: z.string().uuid(),
    content: z.string().min(1).max(4000),
  }),
  z.object({ type: z.literal('typing'), conversationId: z.string().uuid() }),
]);
export type WsAgentFrameT = z.infer<typeof WsAgentFrame>;

// frames the server pushes (both audiences)
export const WsServerFrame = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    conversationId: z.string().uuid(),
    status: ConversationStatus,
  }),
  z.object({ type: z.literal('message'), message: ChatMessage }),
  z.object({ type: z.literal('token'), conversationId: z.string().uuid(), delta: z.string() }),
  z.object({
    type: z.literal('typing'),
    conversationId: z.string().uuid(),
    role: z.enum(['user', 'agent', 'bot']),
  }),
  z.object({
    type: z.literal('state_change'),
    conversationId: z.string().uuid(),
    status: ConversationStatus,
    reason: z.string().nullable(),
  }),
  z.object({ type: z.literal('queue_update'), pending: z.number() }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type WsServerFrameT = z.infer<typeof WsServerFrame>;

export const QnaUpsert = z.object({
  question: z.string().min(3).max(2000),
  answer: z.string().min(1).max(8000),
  tags: z.array(z.string().min(1).max(50)).max(20).default([]),
  isActive: z.boolean().default(true),
});
export type QnaUpsertT = z.infer<typeof QnaUpsert>;
```

Append to `packages/types/src/index.ts`:

```ts
export * from './chatbot.js';
```

- [ ] **Step 2: Verify + commit**

Run: `pnpm --filter @tryme/types build && pnpm typecheck`
Expected: PASS.

```bash
git add packages/types/src/chatbot.ts packages/types/src/index.ts
git commit -m "feat(types): chatbot zod schemas + ws frames"
```

---

### Task 3: `apps/chatbot` skeleton (Fastify, env, /health, service-token guard)

**Files:**
- Create: `apps/chatbot/package.json`, `apps/chatbot/tsconfig.json`
- Create: `apps/chatbot/src/env.ts`, `apps/chatbot/src/lib/errors.ts`, `apps/chatbot/src/lib/redis.ts`, `apps/chatbot/src/lib/db.ts`
- Create: `apps/chatbot/src/server.ts`, `apps/chatbot/src/index.ts`
- Create: `apps/chatbot/test/helpers/containers.ts`, `apps/chatbot/test/health.test.ts`

**Interfaces:**
- Produces:
  - `loadEnv(): Env` (`apps/chatbot/src/env.ts`)
  - `buildChatbotServer(deps: ChatbotDeps): Promise<FastifyInstance>` where

```ts
export interface ChatbotDeps {
  env: Env;
  db: DB;               // from @tryme/db createDb
  redis: Redis;         // commands
  pub: Redis;           // publisher
  sub: Redis;           // subscriber (dedicated connection)
  embed: EmbedFn;       // (texts: string[]) => Promise<number[][]>  — defined Task 4, stub here
  log: Logger;
}
```
  - `AppError(code, statusCode, message)` mirroring `apps/api/src/lib/errors.ts`.

- [ ] **Step 1: Scaffold package**

`apps/chatbot/package.json`:

```json
{
  "name": "@tryme/chatbot",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "dev": "tsx watch --env-file=../../.env --no-warnings src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node --env-file=../../.env dist/index.js",
    "test": "vitest run --reporter=verbose",
    "lint": "biome check src/"
  },
  "dependencies": {
    "@tryme/db": "workspace:*",
    "@tryme/logger": "workspace:*",
    "@tryme/observability": "workspace:*",
    "@tryme/types": "workspace:*",
    "@fastify/websocket": "^11.0.1",
    "@langchain/anthropic": "^0.3.14",
    "@langchain/core": "^0.3.40",
    "@langchain/langgraph": "^0.2.44",
    "drizzle-orm": "^0.36.0",
    "fastify": "^5.0.0",
    "ioredis": "^5.3.2",
    "jose": "^5.2.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@aws-sdk/client-s3": "^3.600.0",
    "@types/node": "^20.0.0",
    "@types/ws": "^8.5.10",
    "postgres": "^3.4.4",
    "tsx": "^4.11.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "ws": "^8.17.0"
  }
}
```

`apps/chatbot/tsconfig.json`: copy `apps/dispatcher/tsconfig.json` verbatim (same compiler options, `src` → `dist`).

Run: `pnpm install`
Expected: lockfile updated, no errors.

- [ ] **Step 2: env + libs**

`apps/chatbot/src/env.ts`:

```ts
import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('debug'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(16),
  OPENAI_API_KEY: z.string().default(''),
  ANTHROPIC_API_KEY: z.string().default(''),
  CHATBOT_PORT: z.coerce.number().default(4200),
  CHATBOT_SERVICE_TOKEN: z.string().min(16),
  CHATBOT_EMBED_MODEL: z.string().default('text-embedding-3-small'),
  CHATBOT_GEN_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  CHATBOT_TOP_K: z.coerce.number().default(5),
  CHATBOT_SIMILARITY_THRESHOLD: z.coerce.number().default(0.4),
  CHATBOT_FALLBACK_LIMIT: z.coerce.number().default(2),
  CHATBOT_IDLE_TIMEOUT_MIN: z.coerce.number().default(30),
  CHATBOT_MAX_TOOL_ITERATIONS: z.coerce.number().default(4),
  CHATBOT_MAX_TURNS: z.coerce.number().default(80),
});

export type Env = z.infer<typeof Env>;
export function loadEnv(): Env {
  return Env.parse(process.env);
}
```

`apps/chatbot/src/lib/errors.ts`:

```ts
export class AppError extends Error {
  constructor(
    public code: string,
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
```

`apps/chatbot/src/lib/redis.ts`:

```ts
import { Redis } from 'ioredis';
import type { Env } from '../env.js';

export function makeRedis(env: Env) {
  const opts = { maxRetriesPerRequest: null as null };
  const main = new Redis(env.REDIS_URL, opts);
  const pub = new Redis(env.REDIS_URL, opts);
  const sub = new Redis(env.REDIS_URL, opts);
  return {
    main,
    pub,
    sub,
    close: async () => {
      await Promise.all([main.quit(), pub.quit(), sub.quit()]);
    },
  };
}
```

`apps/chatbot/src/lib/db.ts`:

```ts
import { createDb, type DB } from '@tryme/db';
import type { Env } from '../env.js';

export function makeDb(env: Env): { db: DB; close: () => Promise<void> } {
  return createDb(env.DATABASE_URL);
}
```

- [ ] **Step 3: Write failing test**

`apps/chatbot/test/helpers/containers.ts` (trimmed copy of the api harness — no MinIO):

```ts
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

export interface Containers {
  pgUrl: string;
  redisUrl: string;
  stop: () => Promise<void>;
}

export async function startContainers(): Promise<Containers> {
  const dbName = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const adminUrl = 'postgres://tryon:tryon_dev_pw@127.0.0.1:5432/tryon_dev';
  const adminClient = postgres(adminUrl, { max: 1 });
  await adminClient.unsafe(`CREATE DATABASE "${dbName}"`);
  await adminClient.end();

  const pgUrl = `postgres://tryon:tryon_dev_pw@127.0.0.1:5432/${dbName}`;
  const client = postgres(pgUrl, { max: 1 });
  await migrate(drizzle(client), {
    migrationsFolder: './node_modules/@tryme/db/src/migrations',
  });
  await client.end();

  return {
    pgUrl,
    redisUrl: 'redis://127.0.0.1:6379',
    stop: async () => {
      const cleanup = postgres(adminUrl, { max: 1 });
      await cleanup.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await cleanup.end();
    },
  };
}
```

`apps/chatbot/test/helpers/app.ts`:

```ts
import { createDb } from '@tryme/db';
import { createLogger } from '@tryme/logger';
import { Redis } from 'ioredis';
import type { Env } from '../../src/env.js';
import { buildChatbotServer, type ChatbotDeps } from '../../src/server.js';
import type { Containers } from './containers.js';

export function testEnv(c: Containers, overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: c.pgUrl,
    REDIS_URL: c.redisUrl,
    JWT_SECRET: 'test-jwt-secret-test-jwt-secret',
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    CHATBOT_PORT: 0,
    CHATBOT_SERVICE_TOKEN: 'test-service-token-123456',
    CHATBOT_EMBED_MODEL: 'text-embedding-3-small',
    CHATBOT_GEN_MODEL: 'claude-haiku-4-5-20251001',
    CHATBOT_TOP_K: 5,
    CHATBOT_SIMILARITY_THRESHOLD: 0.4,
    CHATBOT_FALLBACK_LIMIT: 2,
    CHATBOT_IDLE_TIMEOUT_MIN: 30,
    CHATBOT_MAX_TOOL_ITERATIONS: 4,
    CHATBOT_MAX_TURNS: 80,
    ...overrides,
  };
}

export async function buildTestApp(c: Containers, partial: Partial<ChatbotDeps> = {}) {
  const env = testEnv(c);
  const { db, close: closeDb } = createDb(env.DATABASE_URL);
  const opts = { maxRetriesPerRequest: null as null };
  const redis = new Redis(env.REDIS_URL, opts);
  const pub = new Redis(env.REDIS_URL, opts);
  const sub = new Redis(env.REDIS_URL, opts);
  const deps: ChatbotDeps = {
    env,
    db,
    redis,
    pub,
    sub,
    embed: async (texts) => texts.map(() => Array(1536).fill(0)),
    log: createLogger('chatbot-test'),
    ...partial,
  };
  const app = await buildChatbotServer(deps);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    app,
    deps,
    baseUrl: `http://127.0.0.1:${port}`,
    stop: async () => {
      await app.close();
      await Promise.all([redis.quit(), pub.quit(), sub.quit()]);
      await closeDb();
    },
  };
}
```

`apps/chatbot/test/health.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers/app.js';
import { startContainers, type Containers } from './helpers/containers.js';

describe('health', () => {
  let c: Containers;
  let t: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    c = await startContainers();
    t = await buildTestApp(c);
  }, 60_000);

  afterAll(async () => {
    await t.stop();
    await c.stop();
  });

  it('GET /health returns ok + counts', async () => {
    const res = await fetch(`${t.baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; qna: number; embedded: number };
    expect(body.ok).toBe(true);
    expect(body.qna).toBe(0);
    expect(body.embedded).toBe(0);
  });
});
```

Run: `pnpm --filter @tryme/chatbot test`
Expected: FAIL — `buildChatbotServer` not found.

- [ ] **Step 4: Implement server + entrypoint**

`apps/chatbot/src/server.ts`:

```ts
import { schema, sql, type DB } from '@tryme/db';
import type { Logger } from '@tryme/logger';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Env } from './env.js';
import { AppError } from './lib/errors.js';

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export interface ChatbotDeps {
  env: Env;
  db: DB;
  redis: Redis;
  pub: Redis;
  sub: Redis;
  embed: EmbedFn;
  log: Logger;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: ChatbotDeps;
  }
}

export async function buildChatbotServer(deps: ChatbotDeps): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: deps.log });
  app.decorate('deps', deps);
  await app.register(websocket);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    app.log.error({ err, url: req.url }, 'unhandled');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'internal error' } });
  });

  app.get('/health', async () => {
    const [qna] = await deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.chatbotQna)
      .where(sql`${schema.chatbotQna.isActive} = true`);
    const [emb] = await deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.chatbotEmbeddings);
    return { ok: true, qna: qna?.n ?? 0, embedded: emb?.n ?? 0 };
  });

  return app;
}

/** preHandler guard for internal service routes (POST /ingest). */
export function requireServiceToken(env: Env) {
  return async (req: { headers: Record<string, unknown> }) => {
    if (req.headers['x-service-token'] !== env.CHATBOT_SERVICE_TOKEN)
      throw new AppError('UNAUTH', 401, 'bad service token');
  };
}
```

`apps/chatbot/src/index.ts`:

```ts
import { createLogger } from '@tryme/logger';
import { loadEnv } from './env.js';
import { makeDb } from './lib/db.js';
import { makeRedis } from './lib/redis.js';
import { buildChatbotServer } from './server.js';
import { makeOpenAiEmbedder } from './ingest/embedder.js'; // added Task 4; stub until then

const log = createLogger('chatbot');

async function main(): Promise<void> {
  const env = loadEnv();
  const { db, close: closeDb } = makeDb(env);
  const { main: redis, pub, sub, close: closeRedis } = makeRedis(env);
  const embed = makeOpenAiEmbedder(env.OPENAI_API_KEY, env.CHATBOT_EMBED_MODEL);

  const app = await buildChatbotServer({ env, db, redis, pub, sub, embed, log });
  await app.listen({ port: env.CHATBOT_PORT, host: '0.0.0.0' });
  log.info({ port: env.CHATBOT_PORT }, 'chatbot ready');

  async function shutdown(signal: string) {
    log.info({ signal }, 'shutting down chatbot');
    await app.close();
    await closeRedis();
    await closeDb();
    process.exit(0);
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.error({ err }, 'chatbot crashed');
  process.exit(1);
});
```

For this task only, create a temporary `apps/chatbot/src/ingest/embedder.ts` stub (replaced in Task 4):

```ts
import type { EmbedFn } from '../server.js';

export function makeOpenAiEmbedder(_apiKey: string, _model: string): EmbedFn {
  return async (texts) => texts.map(() => []);
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @tryme/chatbot test`
Expected: PASS (health test green).
Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/chatbot pnpm-lock.yaml
git commit -m "feat(chatbot): service skeleton — fastify, env, health, test harness"
```

---

### Task 4: Ingestion pipeline (`POST /ingest`)

**Files:**
- Modify: `apps/chatbot/src/ingest/embedder.ts` (real implementation)
- Create: `apps/chatbot/src/ingest/ingest.ts`
- Create: `apps/chatbot/src/routes/ingest.ts`
- Modify: `apps/chatbot/src/server.ts` (register route)
- Test: `apps/chatbot/test/ingest.test.ts`

**Interfaces:**
- Consumes: `ChatbotDeps`, `requireServiceToken` (Task 3); `schema.chatbotQna`, `schema.chatbotEmbeddings` (Task 1).
- Produces: `runIngest(deps: Pick<ChatbotDeps,'db'|'redis'|'embed'|'log'>): Promise<{ ingested: number; durationMs: number }>`; HTTP `POST /ingest` (header `x-service-token`) → same shape; `makeOpenAiEmbedder(apiKey, model): EmbedFn`.

- [ ] **Step 1: Write failing tests**

`apps/chatbot/test/ingest.test.ts`:

```ts
import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers/app.js';
import { startContainers, type Containers } from './helpers/containers.js';

// deterministic fake embedder: vector = [len, 0, 0, ...]
const fakeEmbed = async (texts: string[]) =>
  texts.map((t) => [t.length, ...Array(1535).fill(0)]);

describe('ingest', () => {
  let c: Containers;
  let t: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    c = await startContainers();
    t = await buildTestApp(c, { embed: fakeEmbed });
    await t.deps.db.insert(schema.chatbotQna).values([
      { question: 'How do credits work?', answer: 'One credit per try-on.' },
      { question: 'Inactive q', answer: 'skip me', isActive: false },
    ]);
  }, 60_000);

  afterAll(async () => {
    await t.stop();
    await c.stop();
  });

  it('rejects without service token', async () => {
    const res = await fetch(`${t.baseUrl}/ingest`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('embeds only active rows, atomic swap', async () => {
    const res = await fetch(`${t.baseUrl}/ingest`, {
      method: 'POST',
      headers: { 'x-service-token': 'test-service-token-123456' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ingested: number };
    expect(body.ingested).toBe(1);
    const rows = await t.deps.db.select().from(schema.chatbotEmbeddings);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('How do credits work?\nOne credit per try-on.');
  });

  it('re-ingest replaces, not appends', async () => {
    await fetch(`${t.baseUrl}/ingest`, {
      method: 'POST',
      headers: { 'x-service-token': 'test-service-token-123456' },
    });
    const rows = await t.deps.db.select().from(schema.chatbotEmbeddings);
    expect(rows).toHaveLength(1);
  });

  it('conflicts while lock held', async () => {
    await t.deps.redis.set('chatbot:ingest:lock', '1', 'EX', 60, 'NX');
    const res = await fetch(`${t.baseUrl}/ingest`, {
      method: 'POST',
      headers: { 'x-service-token': 'test-service-token-123456' },
    });
    expect(res.status).toBe(409);
    await t.deps.redis.del('chatbot:ingest:lock');
  });
});
```

Run: `pnpm --filter @tryme/chatbot test -- ingest`
Expected: FAIL — 404 on `/ingest`.

- [ ] **Step 2: Implement**

`apps/chatbot/src/ingest/embedder.ts` (replace stub):

```ts
import type { EmbedFn } from '../server.js';

const BATCH = 100;

export function makeOpenAiEmbedder(apiKey: string, model: string): EmbedFn {
  return async (texts) => {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const chunk = texts.slice(i, i + BATCH);
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model, input: chunk }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`openai embeddings ${res.status}: ${await res.text()}`);
      const json = (await res.json()) as {
        data: { index: number; embedding: number[] }[];
      };
      out.push(...json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding));
    }
    return out;
  };
}
```

`apps/chatbot/src/ingest/ingest.ts`:

```ts
import { eq, schema, type DB } from '@tryme/db';
import type { Logger } from '@tryme/logger';
import type { Redis } from 'ioredis';
import { AppError } from '../lib/errors.js';
import type { EmbedFn } from '../server.js';

export async function runIngest(deps: {
  db: DB;
  redis: Redis;
  embed: EmbedFn;
  log: Logger;
}): Promise<{ ingested: number; durationMs: number }> {
  const t0 = Date.now();
  const lock = await deps.redis.set('chatbot:ingest:lock', '1', 'EX', 120, 'NX');
  if (!lock) throw new AppError('INGEST_LOCKED', 409, 'ingest already running');
  try {
    const rows = await deps.db
      .select()
      .from(schema.chatbotQna)
      .where(eq(schema.chatbotQna.isActive, true));
    const contents = rows.map((r) => `${r.question}\n${r.answer}`);
    // slow external call FIRST — DB swap stays atomic and fast (§6)
    const vectors = contents.length > 0 ? await deps.embed(contents) : [];
    await deps.db.transaction(async (tx) => {
      await tx.delete(schema.chatbotEmbeddings);
      if (rows.length > 0) {
        await tx.insert(schema.chatbotEmbeddings).values(
          rows.map((r, i) => ({ qnaId: r.id, content: contents[i], embedding: vectors[i] })),
        );
      }
    });
    const durationMs = Date.now() - t0;
    deps.log.info({ ingested: rows.length, durationMs }, 'ingest complete');
    return { ingested: rows.length, durationMs };
  } finally {
    await deps.redis.del('chatbot:ingest:lock');
  }
}
```

`apps/chatbot/src/routes/ingest.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { runIngest } from '../ingest/ingest.js';
import { requireServiceToken } from '../server.js';

export async function ingestRoutes(app: FastifyInstance) {
  const { deps } = app;
  app.post('/ingest', { preHandler: requireServiceToken(deps.env) }, async () =>
    runIngest(deps),
  );
}
```

In `apps/chatbot/src/server.ts`, after the `/health` route add:

```ts
  const { ingestRoutes } = await import('./routes/ingest.js');
  await app.register(ingestRoutes);
```

(Use a normal top-of-file static import — shown as dynamic here only to indicate placement; final code: `import { ingestRoutes } from './routes/ingest.js';` at top, `await app.register(ingestRoutes);` after the health route.)

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @tryme/chatbot test -- ingest`
Expected: PASS (4 tests).

- [ ] **Step 4: Commit**

```bash
git add apps/chatbot/src apps/chatbot/test
git commit -m "feat(chatbot): ingest pipeline — openai embed + atomic index swap + redis lock"
```

---

### Task 5: Hybrid retrieval (pgvector + BM25 + RRF)

**Files:**
- Create: `apps/chatbot/src/agent/search.ts`
- Test: `apps/chatbot/test/search.test.ts`

**Interfaces:**
- Consumes: `EmbedFn` (Task 3), embeddings table (Task 1).
- Produces:

```ts
export interface KnowledgeHit { qnaId: string; content: string; score: number; sim: number }
export interface SearchResult { hits: KnowledgeHit[]; grounded: boolean }
export async function searchKnowledge(
  db: DB, embed: EmbedFn, query: string, topK: number, simThreshold: number,
): Promise<SearchResult>
```
`grounded` = at least one hit with cosine similarity ≥ `simThreshold` OR a text-leg hit with `ts_rank` > 0.05. The gate (Task 9) keys off this.

- [ ] **Step 1: Write failing test**

`apps/chatbot/test/search.test.ts`:

```ts
import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { searchKnowledge } from '../src/agent/search.js';
import { buildTestApp } from './helpers/app.js';
import { startContainers, type Containers } from './helpers/containers.js';

// fake embed: axis-aligned unit vectors so cosine sim is exactly 1 or 0
function unit(axis: number): number[] {
  const v = Array(1536).fill(0);
  v[axis] = 1;
  return v;
}
const vocab: Record<string, number> = { credits: 0, refund: 1 };
const fakeEmbed = async (texts: string[]) =>
  texts.map((t) => {
    const hit = Object.keys(vocab).find((w) => t.toLowerCase().includes(w));
    return unit(hit ? vocab[hit] : 99);
  });

describe('hybrid search', () => {
  let c: Containers;
  let t: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    c = await startContainers();
    t = await buildTestApp(c, { embed: fakeEmbed });
    const [q1] = await t.deps.db
      .insert(schema.chatbotQna)
      .values({ question: 'How do credits work?', answer: 'One credit per try-on job.' })
      .returning();
    const [q2] = await t.deps.db
      .insert(schema.chatbotQna)
      .values({ question: 'Refund policy', answer: 'Refunds within 7 days.' })
      .returning();
    const [v1, v2] = await fakeEmbed([
      'How do credits work?\nOne credit per try-on job.',
      'Refund policy\nRefunds within 7 days.',
    ]);
    await t.deps.db.insert(schema.chatbotEmbeddings).values([
      { qnaId: q1.id, content: 'How do credits work?\nOne credit per try-on job.', embedding: v1 },
      { qnaId: q2.id, content: 'Refund policy\nRefunds within 7 days.', embedding: v2 },
    ]);
  }, 60_000);

  afterAll(async () => {
    await t.stop();
    await c.stop();
  });

  it('vector leg ranks matching doc first, grounded=true', async () => {
    const r = await searchKnowledge(t.deps.db, fakeEmbed, 'tell me about credits', 5, 0.4);
    expect(r.grounded).toBe(true);
    expect(r.hits[0].content).toContain('credit per try-on');
  });

  it('text leg finds keyword match even with off-axis embedding', async () => {
    const r = await searchKnowledge(t.deps.db, fakeEmbed, 'seven days policy', 5, 0.4);
    expect(r.hits.some((h) => h.content.includes('Refunds'))).toBe(true);
  });

  it('nonsense query is ungrounded', async () => {
    const r = await searchKnowledge(t.deps.db, fakeEmbed, 'zzz qqq xyzzy', 5, 0.4);
    expect(r.grounded).toBe(false);
  });
});
```

Run: `pnpm --filter @tryme/chatbot test -- search`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement**

`apps/chatbot/src/agent/search.ts`:

```ts
import { sql, type DB } from '@tryme/db';
import type { EmbedFn } from '../server.js';

export interface KnowledgeHit {
  qnaId: string;
  content: string;
  score: number; // RRF score
  sim: number; // best cosine similarity (0 if text-leg only)
}
export interface SearchResult {
  hits: KnowledgeHit[];
  grounded: boolean;
}

const RRF_K = 60;

export async function searchKnowledge(
  db: DB,
  embed: EmbedFn,
  query: string,
  topK: number,
  simThreshold: number,
): Promise<SearchResult> {
  const [vec] = await embed([query]);
  const vecLit = JSON.stringify(vec);

  const vecRows = (await db.execute(sql`
    SELECT qna_id, content, 1 - (embedding <=> ${vecLit}::vector) AS sim
    FROM chatbot_embeddings
    ORDER BY embedding <=> ${vecLit}::vector
    LIMIT ${topK}
  `)) as unknown as { qna_id: string; content: string; sim: number }[];

  const txtRows = (await db.execute(sql`
    SELECT qna_id, content,
           ts_rank(content_tsv, websearch_to_tsquery('english', ${query})) AS rank
    FROM chatbot_embeddings
    WHERE content_tsv @@ websearch_to_tsquery('english', ${query})
    ORDER BY rank DESC
    LIMIT ${topK}
  `)) as unknown as { qna_id: string; content: string; rank: number }[];

  // Reciprocal Rank Fusion
  const merged = new Map<string, KnowledgeHit>();
  vecRows.forEach((r, i) => {
    merged.set(r.qna_id, {
      qnaId: r.qna_id,
      content: r.content,
      score: 1 / (RRF_K + i + 1),
      sim: Number(r.sim),
    });
  });
  txtRows.forEach((r, i) => {
    const prev = merged.get(r.qna_id);
    const add = 1 / (RRF_K + i + 1);
    if (prev) prev.score += add;
    else merged.set(r.qna_id, { qnaId: r.qna_id, content: r.content, score: add, sim: 0 });
  });

  const hits = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, topK);
  const grounded =
    hits.some((h) => h.sim >= simThreshold) ||
    txtRows.some((r) => Number(r.rank) > 0.05);
  return { hits, grounded };
}
```

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @tryme/chatbot test -- search`
Expected: PASS (3 tests).

- [ ] **Step 4: Commit**

```bash
git add apps/chatbot/src/agent/search.ts apps/chatbot/test/search.test.ts
git commit -m "feat(chatbot): hybrid retrieval — pgvector + tsvector + RRF"
```

---

### Task 6: api — admin Q&A CRUD + ingest proxy

**Files:**
- Create: `apps/api/src/modules/admin/chatbot.routes.ts`
- Modify: `apps/api/src/server.ts` (import + register `adminChatbotRoutes` alongside the other admin routes)
- Modify: `apps/api/src/env.ts` (add two optional vars)
- Test: `apps/api/test/admin-chatbot.test.ts`

**Interfaces:**
- Consumes: `requireAdmin` (`apps/api/src/modules/admin/guard.ts`), `QnaUpsert` from `@tryme/types`, `schema.chatbotQna`.
- Produces HTTP (all under `requireAdmin(['SUPER_ADMIN','ADMIN'])`):
  - `GET /admin/chatbot/qna?active=all|true|false&q=<text>` → `{ rows, total }`
  - `POST /admin/chatbot/qna` body `QnaUpsert` → row
  - `PATCH /admin/chatbot/qna/:id` body `QnaUpsert.partial()` → row
  - `DELETE /admin/chatbot/qna/:id` → `{ ok: true }`
  - `POST /admin/chatbot/ingest` → proxied `{ ingested, durationMs }` (503 if `CHATBOT_URL` unset)
  - `GET /admin/chatbot/status` → `{ activeQna, embedded }` (embedded count via chatbot `/health`, 0 on fetch failure)

- [ ] **Step 1: env vars**

In `apps/api/src/env.ts` add to the zod object:

```ts
  CHATBOT_URL: z.string().url().optional(), // internal base for ingest proxy
  CHATBOT_SERVICE_TOKEN: z.string().optional(),
```

- [ ] **Step 2: Write failing integration test**

`apps/api/test/admin-chatbot.test.ts` — follow the exact bootstrap pattern of an existing admin route test (e.g. `apps/api/test/admin-contact*.test.ts` or nearest admin test file: same `startContainers()` + `buildTestApp()` + admin login helper). Test body:

```ts
import { describe, expect, it } from 'vitest';
// ...same harness imports/beforeAll/afterAll as sibling admin tests...

describe('admin chatbot qna', () => {
  it('CRUD lifecycle', async () => {
    const created = await adminFetch('POST', '/admin/chatbot/qna', {
      question: 'How do credits work?',
      answer: 'One credit per try-on.',
      tags: ['credits'],
      isActive: true,
    });
    expect(created.id).toBeDefined();

    const list = await adminFetch('GET', '/admin/chatbot/qna?active=true');
    expect(list.total).toBe(1);

    const patched = await adminFetch('PATCH', `/admin/chatbot/qna/${created.id}`, {
      isActive: false,
    });
    expect(patched.isActive).toBe(false);

    await adminFetch('DELETE', `/admin/chatbot/qna/${created.id}`);
    const after = await adminFetch('GET', '/admin/chatbot/qna');
    expect(after.total).toBe(0);
  });

  it('SUPPORT role is rejected for qna', async () => {
    // create/login a SUPPORT admin via the same helper the harness uses,
    // expect 403 from POST /admin/chatbot/qna
  });

  it('ingest returns 503 when CHATBOT_URL unset', async () => {
    const res = await adminFetchRaw('POST', '/admin/chatbot/ingest');
    expect(res.status).toBe(503);
  });
});
```

(`adminFetch`/`adminFetchRaw` = whatever helper sibling admin tests use for authenticated admin calls — reuse, don't reinvent. Fill the SUPPORT-role test using the harness's admin-seeding helper.)

Run: `pnpm --filter @tryme/api test -- admin-chatbot`
Expected: FAIL — 404.

- [ ] **Step 3: Implement routes**

`apps/api/src/modules/admin/chatbot.routes.ts`:

```ts
import { schema } from '@tryme/db';
import { QnaUpsert } from '@tryme/types';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { requireAdmin } from './guard.js';

export async function adminChatbotRoutes(app: FastifyInstance) {
  const QNA = requireAdmin(['SUPER_ADMIN', 'ADMIN']);

  app.get('/admin/chatbot/qna', { preHandler: QNA }, async (req) => {
    const { active = 'all', q = '' } = req.query as Record<string, string>;
    const conds = [];
    if (active === 'true') conds.push(eq(schema.chatbotQna.isActive, true));
    if (active === 'false') conds.push(eq(schema.chatbotQna.isActive, false));
    if (q)
      conds.push(
        or(ilike(schema.chatbotQna.question, `%${q}%`), ilike(schema.chatbotQna.answer, `%${q}%`)),
      );
    const where = conds.length ? and(...conds) : undefined;
    const [rows, [countRow]] = await Promise.all([
      app.db
        .select()
        .from(schema.chatbotQna)
        .where(where)
        .orderBy(desc(schema.chatbotQna.updatedAt))
        .limit(500),
      app.db.select({ total: sql<number>`count(*)::int` }).from(schema.chatbotQna).where(where),
    ]);
    return { rows, total: countRow?.total ?? 0 };
  });

  app.post(
    '/admin/chatbot/qna',
    { preHandler: QNA, schema: { body: QnaUpsert } },
    async (req) => {
      const body = req.body as z.infer<typeof QnaUpsert>;
      const [row] = await app.db.insert(schema.chatbotQna).values(body).returning();
      return row;
    },
  );

  app.patch(
    '/admin/chatbot/qna/:id',
    {
      preHandler: QNA,
      schema: { params: z.object({ id: z.string().uuid() }), body: QnaUpsert.partial() },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const [row] = await app.db
        .update(schema.chatbotQna)
        .set({ ...(req.body as object), updatedAt: new Date() })
        .where(eq(schema.chatbotQna.id, id))
        .returning();
      if (!row) throw new AppError('NOT_FOUND', 404, 'qna not found');
      return row;
    },
  );

  app.delete(
    '/admin/chatbot/qna/:id',
    { preHandler: QNA, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req) => {
      const { id } = req.params as { id: string };
      const [row] = await app.db
        .delete(schema.chatbotQna)
        .where(eq(schema.chatbotQna.id, id))
        .returning();
      if (!row) throw new AppError('NOT_FOUND', 404, 'qna not found');
      return { ok: true };
    },
  );

  app.post('/admin/chatbot/ingest', { preHandler: QNA }, async () => {
    if (!app.env.CHATBOT_URL || !app.env.CHATBOT_SERVICE_TOKEN)
      throw new AppError('CHATBOT_UNCONFIGURED', 503, 'chatbot service not configured');
    const res = await fetch(`${app.env.CHATBOT_URL}/ingest`, {
      method: 'POST',
      headers: { 'x-service-token': app.env.CHATBOT_SERVICE_TOKEN },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new AppError('INGEST_FAILED', res.status === 409 ? 409 : 502, text.slice(0, 300));
    }
    return res.json();
  });

  app.get('/admin/chatbot/status', { preHandler: QNA }, async () => {
    const [activeRow] = await app.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.chatbotQna)
      .where(eq(schema.chatbotQna.isActive, true));
    let embedded = 0;
    if (app.env.CHATBOT_URL) {
      try {
        const res = await fetch(`${app.env.CHATBOT_URL}/health`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) embedded = ((await res.json()) as { embedded: number }).embedded;
      } catch {
        /* chatbot down — show 0 */
      }
    }
    return { activeQna: activeRow?.n ?? 0, embedded };
  });
}
```

Register in `apps/api/src/server.ts` next to the other admin routes:

```ts
import { adminChatbotRoutes } from './modules/admin/chatbot.routes.js';
// ... with the other admin registrations:
await app.register(adminChatbotRoutes);
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @tryme/api test -- admin-chatbot`
Expected: PASS.
Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test/admin-chatbot.test.ts
git commit -m "feat(api): admin chatbot qna crud + ingest proxy"
```

---

### Task 7: admin-web — Chatbot Q&A page

**Files:**
- Create: `apps/admin-web/src/pages/ChatbotQnaPage.tsx`
- Modify: `apps/admin-web/src/App.tsx` (route), sidebar component (nav item — find it via the existing `Sidebar` import in App.tsx)

**Interfaces:**
- Consumes: Task 6 HTTP endpoints; `apiFetch<T>(path, init)` from `apps/admin-web/src/lib/data.ts`; page receives `{ onNav, toast }` props like every other page.

- [ ] **Step 1: Implement page**

`apps/admin-web/src/pages/ChatbotQnaPage.tsx` — follow `ContactRequestsPage.tsx` structure/styling. Functional spec + skeleton:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/data';

interface Qna {
  id: string;
  question: string;
  answer: string;
  tags: string[];
  isActive: boolean;
  updatedAt: string;
}

export default function ChatbotQnaPage({ toast }: { toast: (m: string) => void }) {
  const [rows, setRows] = useState<Qna[]>([]);
  const [status, setStatus] = useState<{ activeQna: number; embedded: number } | null>(null);
  const [editing, setEditing] = useState<Partial<Qna> | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [list, st] = await Promise.all([
      apiFetch<{ rows: Qna[] }>('/admin/chatbot/qna'),
      apiFetch<{ activeQna: number; embedded: number }>('/admin/chatbot/status'),
    ]);
    setRows(list.rows);
    setStatus(st);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!editing) return;
    const body = {
      question: editing.question ?? '',
      answer: editing.answer ?? '',
      tags: editing.tags ?? [],
      isActive: editing.isActive ?? true,
    };
    if (editing.id) await apiFetch(`/admin/chatbot/qna/${editing.id}`, { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    else await apiFetch('/admin/chatbot/qna', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    setEditing(null);
    toast('Saved');
    await load();
  }

  async function remove(id: string) {
    await apiFetch(`/admin/chatbot/qna/${id}`, { method: 'DELETE' });
    toast('Deleted');
    await load();
  }

  async function reingest() {
    setBusy(true);
    try {
      const r = await apiFetch<{ ingested: number; durationMs: number }>(
        '/admin/chatbot/ingest',
        { method: 'POST' },
      );
      toast(`Ingested ${r.ingested} in ${r.durationMs}ms`);
      await load();
    } catch (e) {
      toast(`Ingest failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  // Render: status strip (activeQna vs embedded, warn when mismatch), Re-ingest button
  // (disabled while busy), table of rows (question, tags, active toggle via PATCH,
  // edit/delete buttons), and an edit modal/panel with question textarea, answer
  // textarea, tags input (comma-split), active checkbox. Reuse the same table/card/
  // button classNames used in ContactRequestsPage.tsx so styling matches.
  return (/* JSX per above, matching ContactRequestsPage markup patterns */ null);
}
```

The implementer must complete the JSX by copying markup conventions from `ContactRequestsPage.tsx` (table classes, badge styles, modal pattern). All handlers above are final.

- [ ] **Step 2: Wire route + nav**

In `apps/admin-web/src/App.tsx`: add `import ChatbotQnaPage from './pages/ChatbotQnaPage';`, route `<Route path="/chatbot-qna" element={<ChatbotQnaPage {...pageProps} />} />`, and add `'chatbot-qna': 'Chatbot Q&A'` to `PATH_LABELS`. Add a sidebar item labeled "Chatbot Q&A" next to "Contacts" in the `Sidebar` component, visible to roles `SUPER_ADMIN`/`ADMIN` (match how Sidebar already role-gates items, e.g. workers/settings).

- [ ] **Step 3: Verify**

Run: `pnpm --filter @tryme/admin dev` — log in as admin, create a Q&A pair, toggle active, hit Re-ingest (with `apps/chatbot` running via `pnpm --filter @tryme/chatbot dev`), confirm status strip shows embedded count.
Run: `pnpm typecheck && pnpm --filter @tryme/admin build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/admin-web/src
git commit -m "feat(admin-web): chatbot q&a page with re-ingest"
```

---

### Task 8: Conversation persistence + state machine (chatbot app)

**Files:**
- Create: `apps/chatbot/src/conversation/service.ts`
- Create: `apps/chatbot/src/routes/conversations.ts` (history HTTP)
- Modify: `apps/chatbot/src/server.ts` (register)
- Test: `apps/chatbot/test/conversation.test.ts`

**Interfaces:**
- Consumes: schema tables (Task 1), `WsServerFrameT` (Task 2).
- Produces (`apps/chatbot/src/conversation/service.ts`):

```ts
export type ConvStatus = 'BOT' | 'PENDING_HUMAN' | 'HUMAN' | 'CLOSED';
export interface Conversation { id: string; userId: string; status: ConvStatus; assignedAgentId: string | null; escalationReason: string | null }

export function convChannel(convId: string): string; // `chatbot:conv:${convId}`
export async function publishConv(pub: Redis, convId: string, frame: object): Promise<void>;
export async function getOrCreateActiveConversation(db: DB, userId: string): Promise<Conversation>;
export async function appendMessage(db: DB, pub: Redis, convId: string, msg: { role: 'user'|'bot'|'agent'|'system'; senderId?: string | null; content: string; meta?: object | null }): Promise<ChatMessageT>;
// guarded status transition; returns false when current status !== from
export async function transition(db: DB, pub: Redis, convId: string, opts: { from: ConvStatus | ConvStatus[]; to: ConvStatus; type: string; actorId?: string | null; reason?: string | null }): Promise<boolean>;
export async function listMessages(db: DB, convId: string, opts?: { limit?: number; before?: string }): Promise<ChatMessageT[]>;
```
- HTTP: `GET /conversations/:id/messages?limit=50&before=<iso>` — auth: Bearer user JWT (owner) or admin JWT (any agent); returns `{ messages }` oldest→newest.

- [ ] **Step 1: Write failing tests**

`apps/chatbot/test/conversation.test.ts`:

```ts
import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendMessage,
  getOrCreateActiveConversation,
  listMessages,
  transition,
} from '../src/conversation/service.js';
import { buildTestApp } from './helpers/app.js';
import { startContainers, type Containers } from './helpers/containers.js';

describe('conversation service', () => {
  let c: Containers;
  let t: Awaited<ReturnType<typeof buildTestApp>>;
  let userId: string;

  beforeAll(async () => {
    c = await startContainers();
    t = await buildTestApp(c);
    const [u] = await t.deps.db
      .insert(schema.users)
      .values({ email: 'chat@test.dev', passwordHash: 'x', emailVerified: true })
      .returning();
    userId = u.id;
  }, 60_000);

  afterAll(async () => {
    await t.stop();
    await c.stop();
  });

  it('creates one active conversation, resumes it', async () => {
    const a = await getOrCreateActiveConversation(t.deps.db, userId);
    const b = await getOrCreateActiveConversation(t.deps.db, userId);
    expect(a.id).toBe(b.id);
    expect(a.status).toBe('BOT');
  });

  it('append + list messages ordered', async () => {
    const conv = await getOrCreateActiveConversation(t.deps.db, userId);
    await appendMessage(t.deps.db, t.deps.pub, conv.id, { role: 'user', senderId: userId, content: 'hi' });
    await appendMessage(t.deps.db, t.deps.pub, conv.id, { role: 'bot', content: 'hello!' });
    const msgs = await listMessages(t.deps.db, conv.id);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'bot']);
  });

  it('guarded transition: wrong from-status is a no-op', async () => {
    const conv = await getOrCreateActiveConversation(t.deps.db, userId);
    const bad = await transition(t.deps.db, t.deps.pub, conv.id, {
      from: 'HUMAN', to: 'CLOSED', type: 'close',
    });
    expect(bad).toBe(false);
    const ok = await transition(t.deps.db, t.deps.pub, conv.id, {
      from: 'BOT', to: 'PENDING_HUMAN', type: 'escalate', reason: 'user_request',
    });
    expect(ok).toBe(true);
    const events = await t.deps.db.select().from(schema.chatbotEvents);
    expect(events.some((e) => e.type === 'escalate' && e.toStatus === 'PENDING_HUMAN')).toBe(true);
  });

  it('CLOSED never resumes — new conversation created', async () => {
    const conv = await getOrCreateActiveConversation(t.deps.db, userId);
    await transition(t.deps.db, t.deps.pub, conv.id, {
      from: ['BOT', 'PENDING_HUMAN'], to: 'CLOSED', type: 'close',
    });
    const fresh = await getOrCreateActiveConversation(t.deps.db, userId);
    expect(fresh.id).not.toBe(conv.id);
  });
});
```

Run: `pnpm --filter @tryme/chatbot test -- conversation`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement service**

`apps/chatbot/src/conversation/service.ts`:

```ts
import { and, eq, inArray, schema, sql, type DB } from '@tryme/db';
import type { ChatMessageT } from '@tryme/types';
import type { Redis } from 'ioredis';

export type ConvStatus = 'BOT' | 'PENDING_HUMAN' | 'HUMAN' | 'CLOSED';
export interface Conversation {
  id: string;
  userId: string;
  status: ConvStatus;
  assignedAgentId: string | null;
  escalationReason: string | null;
}

export function convChannel(convId: string): string {
  return `chatbot:conv:${convId}`;
}

export async function publishConv(pub: Redis, convId: string, frame: object): Promise<void> {
  await pub.publish(convChannel(convId), JSON.stringify(frame));
}

export async function getOrCreateActiveConversation(db: DB, userId: string): Promise<Conversation> {
  const [existing] = await db
    .select()
    .from(schema.chatbotConversations)
    .where(
      and(
        eq(schema.chatbotConversations.userId, userId),
        sql`${schema.chatbotConversations.status} <> 'CLOSED'`,
      ),
    );
  if (existing) return existing as Conversation;
  const [created] = await db
    .insert(schema.chatbotConversations)
    .values({ userId })
    .onConflictDoNothing()
    .returning();
  if (created) return created as Conversation;
  // lost a race to the partial unique index — fetch the winner
  const [winner] = await db
    .select()
    .from(schema.chatbotConversations)
    .where(
      and(
        eq(schema.chatbotConversations.userId, userId),
        sql`${schema.chatbotConversations.status} <> 'CLOSED'`,
      ),
    );
  return winner as Conversation;
}

function toWire(row: typeof schema.chatbotMessages.$inferSelect): ChatMessageT {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role as ChatMessageT['role'],
    senderId: row.senderId,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function appendMessage(
  db: DB,
  pub: Redis,
  convId: string,
  msg: {
    role: 'user' | 'bot' | 'agent' | 'system';
    senderId?: string | null;
    content: string;
    meta?: { toolCalls?: string[]; qnaIds?: string[] } | null;
  },
): Promise<ChatMessageT> {
  const [row] = await db
    .insert(schema.chatbotMessages)
    .values({
      conversationId: convId,
      role: msg.role,
      senderId: msg.senderId ?? null,
      content: msg.content,
      meta: msg.meta ?? null,
    })
    .returning();
  await db
    .update(schema.chatbotConversations)
    .set({ lastMessageAt: new Date() })
    .where(eq(schema.chatbotConversations.id, convId));
  const wire = toWire(row);
  await publishConv(pub, convId, { type: 'message', message: wire });
  return wire;
}

export async function transition(
  db: DB,
  pub: Redis,
  convId: string,
  opts: {
    from: ConvStatus | ConvStatus[];
    to: ConvStatus;
    type: string;
    actorId?: string | null;
    reason?: string | null;
  },
): Promise<boolean> {
  const froms = Array.isArray(opts.from) ? opts.from : [opts.from];
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.chatbotConversations)
      .set({
        status: opts.to,
        ...(opts.to === 'CLOSED' ? { closedAt: new Date() } : {}),
        ...(opts.type === 'escalate' ? { escalationReason: opts.reason ?? null } : {}),
      })
      .where(
        and(
          eq(schema.chatbotConversations.id, convId),
          inArray(schema.chatbotConversations.status, froms),
        ),
      )
      .returning();
    if (!row) return null;
    await tx.insert(schema.chatbotEvents).values({
      conversationId: convId,
      type: opts.type,
      actorId: opts.actorId ?? null,
      fromStatus: froms.length === 1 ? froms[0] : null,
      toStatus: opts.to,
      reason: opts.reason ?? null,
    });
    return row;
  });
  if (!updated) return false;
  await publishConv(pub, convId, {
    type: 'state_change',
    conversationId: convId,
    status: opts.to,
    reason: opts.reason ?? null,
  });
  return true;
}

export async function listMessages(
  db: DB,
  convId: string,
  opts: { limit?: number; before?: string } = {},
): Promise<ChatMessageT[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const conds = [eq(schema.chatbotMessages.conversationId, convId)];
  if (opts.before)
    conds.push(sql`${schema.chatbotMessages.createdAt} < ${new Date(opts.before)}`);
  const rows = await db
    .select()
    .from(schema.chatbotMessages)
    .where(and(...conds))
    .orderBy(sql`${schema.chatbotMessages.createdAt} DESC`)
    .limit(limit);
  return rows.reverse().map(toWire);
}
```

- [ ] **Step 3: History HTTP route**

`apps/chatbot/src/routes/conversations.ts` (JWT auth helper is built in Task 10 — for this task, implement `verifyBearer` here and Task 10 moves/reuses it):

```ts
import { eq, schema } from '@tryme/db';
import type { FastifyInstance } from 'fastify';
import { jwtVerify } from 'jose';
import { listMessages } from '../conversation/service.js';
import { AppError } from '../lib/errors.js';

export interface Principal {
  role: 'user' | 'agent';
  userId: string; // users.id
  adminUserId?: string; // admin_users.id (agents only)
}

export async function verifyBearer(app: FastifyInstance, authHeader: string | undefined): Promise<Principal> {
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
  if (!token) throw new AppError('UNAUTH', 401, 'missing bearer');
  const secret = new TextEncoder().encode(app.deps.env.JWT_SECRET);
  let payload: Record<string, unknown>;
  try {
    payload = (await jwtVerify(token, secret, { algorithms: ['HS256'] })).payload as Record<string, unknown>;
  } catch {
    throw new AppError('UNAUTH', 401, 'invalid token');
  }
  const sub = String(payload.sub);
  const aud = payload.aud;
  const isAdminToken = aud === 'admin' || (Array.isArray(aud) && aud.includes('admin'));
  if (isAdminToken) {
    // double-check invariant: JWT claim AND active admin_users row
    const [a] = await app.deps.db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.userId, sub));
    if (!a || a.status !== 'active') throw new AppError('FORBIDDEN', 403, 'not an active admin');
    return { role: 'agent', userId: sub, adminUserId: a.id };
  }
  if (payload.kind !== 'access') throw new AppError('UNAUTH', 401, 'invalid token');
  return { role: 'user', userId: sub };
}

export async function conversationRoutes(app: FastifyInstance) {
  app.get('/conversations/:id/messages', async (req) => {
    const principal = await verifyBearer(app, req.headers.authorization);
    const { id } = req.params as { id: string };
    const { limit, before } = req.query as { limit?: string; before?: string };
    const [conv] = await app.deps.db
      .select()
      .from(schema.chatbotConversations)
      .where(eq(schema.chatbotConversations.id, id));
    if (!conv) throw new AppError('NOT_FOUND', 404, 'conversation not found');
    if (principal.role === 'user' && conv.userId !== principal.userId)
      throw new AppError('FORBIDDEN', 403, 'not your conversation');
    const messages = await listMessages(app.deps.db, id, {
      limit: limit ? Number(limit) : undefined,
      before,
    });
    return { messages };
  });
}
```

Register in `server.ts`: `await app.register(conversationRoutes);`

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @tryme/chatbot test -- conversation`
Expected: PASS (4 tests).
Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/chatbot/src apps/chatbot/test
git commit -m "feat(chatbot): conversation persistence + guarded state machine + history api"
```

---

### Task 9: Bot agent — LangGraph, tools, gate

**Files:**
- Create: `apps/chatbot/src/agent/tools.ts`
- Create: `apps/chatbot/src/agent/bot.ts`
- Test: `apps/chatbot/test/bot.test.ts`

**Interfaces:**
- Consumes: `searchKnowledge` (Task 5), `ChatMessageT`, schema (`userCredits`, `creditLedger`, `jobs`).
- Produces:

```ts
// tools.ts — userId is closed over server-side; tools take NO identity params (§7.2)
export function makeAccountTools(db: DB, userId: string): StructuredToolInterface[];
export function makeSearchTool(db: DB, embed: EmbedFn, env: Env, turnCtx: TurnCtx): StructuredToolInterface;
export interface TurnCtx { searchCalled: boolean; grounded: boolean; qnaIds: string[]; toolCalls: string[] }

// bot.ts
export interface BotResult {
  kind: 'answer' | 'fallback' | 'escalate';
  content: string; // answer text or fallback copy; '' for escalate
  meta: { toolCalls: string[]; qnaIds: string[] };
}
export async function runBotTurn(opts: {
  deps: ChatbotDeps;
  model: BaseChatModel;           // injected: ChatAnthropic in prod, fake in tests
  userId: string;
  convId: string;
  history: ChatMessageT[];        // last N turns, oldest→newest
  userMessage: string;
  signal: AbortSignal;
}): Promise<BotResult>;
export const FALLBACK_COPY: string;
export function makeProdModel(env: Env): BaseChatModel; // ChatAnthropic(claude-haiku-4-5-20251001)
```
- Gate semantics: model may emit sentinel `<escalate/>`; result kind =
  - `escalate` if sentinel present,
  - `fallback` if `turnCtx.searchCalled && !turnCtx.grounded` and no account tool was called (caller counts fallbacks → escalate at limit, Task 10),
  - `answer` otherwise.

- [ ] **Step 1: Write failing tests**

`apps/chatbot/test/bot.test.ts`:

```ts
import { schema } from '@tryme/db';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeAccountTools } from '../src/agent/tools.js';
import { runBotTurn } from '../src/agent/bot.js';
import { buildTestApp } from './helpers/app.js';
import { startContainers, type Containers } from './helpers/containers.js';

describe('bot agent', () => {
  let c: Containers;
  let t: Awaited<ReturnType<typeof buildTestApp>>;
  let userId: string;

  beforeAll(async () => {
    c = await startContainers();
    t = await buildTestApp(c);
    const [u] = await t.deps.db
      .insert(schema.users)
      .values({ email: 'bot@test.dev', passwordHash: 'x', emailVerified: true })
      .returning();
    userId = u.id;
    await t.deps.db.insert(schema.userCredits).values({ userId, balance: 42 });
  }, 60_000);

  afterAll(async () => {
    await t.stop();
    await c.stop();
  });

  it('getCredits is bound to the session user — no identity params', async () => {
    const tools = makeAccountTools(t.deps.db, userId);
    const credits = tools.find((x) => x.name === 'getCredits')!;
    // tool schema must not accept a userId
    expect(JSON.stringify(credits.schema)).not.toContain('userId');
    const out = await credits.invoke({});
    expect(String(out)).toContain('42');
  });

  it('plain answer path', async () => {
    const model = new FakeListChatModel({ responses: ['You get 1 credit per try-on.'] });
    const r = await runBotTurn({
      deps: t.deps, model, userId, convId: crypto.randomUUID(),
      history: [], userMessage: 'how many credits per job?',
      signal: new AbortController().signal,
    });
    expect(r.kind).toBe('answer');
    expect(r.content).toContain('1 credit');
  });

  it('escalate sentinel routes to escalate', async () => {
    const model = new FakeListChatModel({ responses: ['<escalate/>'] });
    const r = await runBotTurn({
      deps: t.deps, model, userId, convId: crypto.randomUUID(),
      history: [], userMessage: 'I demand a refund now',
      signal: new AbortController().signal,
    });
    expect(r.kind).toBe('escalate');
  });
});
```

Run: `pnpm --filter @tryme/chatbot test -- bot`
Expected: FAIL — modules not found.

- [ ] **Step 2: Implement tools**

`apps/chatbot/src/agent/tools.ts`:

```ts
import { eq, schema, sql, type DB } from '@tryme/db';
import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import type { Env } from '../env.js';
import type { EmbedFn } from '../server.js';
import { searchKnowledge } from './search.js';

export interface TurnCtx {
  searchCalled: boolean;
  grounded: boolean;
  qnaIds: string[];
  toolCalls: string[];
}

export function newTurnCtx(): TurnCtx {
  return { searchCalled: false, grounded: false, qnaIds: [], toolCalls: [] };
}

// SECURITY (§7.2): tools close over the authenticated session userId. They accept
// NO identity arguments — the model cannot request another user's data.
export function makeAccountTools(db: DB, userId: string): StructuredToolInterface[] {
  const getCredits = tool(
    async () => {
      const [row] = await db
        .select({ balance: schema.userCredits.balance })
        .from(schema.userCredits)
        .where(eq(schema.userCredits.userId, userId));
      return `Current credit balance: ${row?.balance ?? 0}`;
    },
    {
      name: 'getCredits',
      description: "Get the current user's credit balance.",
      schema: z.object({}),
    },
  );

  const getRecentJobs = tool(
    async () => {
      const rows = await db
        .select({
          id: schema.jobs.id,
          status: schema.jobs.status,
          createdAt: schema.jobs.createdAt,
          creditsCharged: schema.jobs.creditsCharged,
        })
        .from(schema.jobs)
        .where(eq(schema.jobs.userId, userId))
        .orderBy(sql`${schema.jobs.createdAt} DESC`)
        .limit(5);
      if (rows.length === 0) return 'No jobs yet.';
      return rows
        .map(
          (j) =>
            `job ${j.id.slice(0, 8)} — ${j.status} — ${j.creditsCharged} credit(s) — ${j.createdAt.toISOString()}`,
        )
        .join('\n');
    },
    {
      name: 'getRecentJobs',
      description: "List the current user's 5 most recent try-on jobs with statuses.",
      schema: z.object({}),
    },
  );

  return [getCredits, getRecentJobs];
}

export function makeSearchTool(
  db: DB,
  embed: EmbedFn,
  env: Env,
  turnCtx: TurnCtx,
): StructuredToolInterface {
  return tool(
    async ({ query }: { query: string }) => {
      turnCtx.searchCalled = true;
      const r = await searchKnowledge(db, embed, query, env.CHATBOT_TOP_K, env.CHATBOT_SIMILARITY_THRESHOLD);
      turnCtx.grounded = turnCtx.grounded || r.grounded;
      turnCtx.qnaIds.push(...r.hits.map((h) => h.qnaId));
      if (r.hits.length === 0) return 'No knowledge base entries matched.';
      return r.hits.map((h, i) => `[${i + 1}] ${h.content}`).join('\n---\n');
    },
    {
      name: 'searchKnowledge',
      description: 'Search the support knowledge base for policy and how-to answers.',
      schema: z.object({ query: z.string().describe('search query') }),
    },
  );
}
```

Note: verify `schema.jobs`/`schema.userCredits` column names against `packages/db/src/schema/jobs.ts` and `credits.ts` before finalizing (`creditsCharged`, `balance` — adjust to actual names if they differ).

- [ ] **Step 3: Implement bot**

`apps/chatbot/src/agent/bot.ts`:

```ts
import type { ChatMessageT } from '@tryme/types';
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatAnthropic } from '@langchain/anthropic';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import type { Env } from '../env.js';
import type { ChatbotDeps } from '../server.js';
import { makeAccountTools, makeSearchTool, newTurnCtx } from './tools.js';

export const FALLBACK_COPY =
  "I couldn't find an answer to that in our help articles. Could you rephrase, or tap “Talk to a human” and I'll connect you?";

const SYSTEM_PROMPT = `You are the Tryme support assistant for logged-in users.
- Use searchKnowledge for policy/how-to/pricing questions. Only answer from its results.
- Use getCredits / getRecentJobs for questions about the current user's own account.
- If you cannot answer from the knowledge base or the account tools, or the user asks for
  a human, a refund, or has a billing complaint, reply with exactly: <escalate/>
- Never invent pricing, policy, or account data. Keep answers short and friendly.`;

export interface BotResult {
  kind: 'answer' | 'fallback' | 'escalate';
  content: string;
  meta: { toolCalls: string[]; qnaIds: string[] };
}

export function makeProdModel(env: Env): BaseChatModel {
  return new ChatAnthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.CHATBOT_GEN_MODEL,
    temperature: 0.2,
    maxTokens: 1024,
  });
}

function toLc(history: ChatMessageT[]): BaseMessage[] {
  return history
    .filter((m) => m.role === 'user' || m.role === 'bot')
    .map((m) => (m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content)));
}

export async function runBotTurn(opts: {
  deps: ChatbotDeps;
  model: BaseChatModel;
  userId: string;
  convId: string;
  history: ChatMessageT[];
  userMessage: string;
  signal: AbortSignal;
}): Promise<BotResult> {
  const { deps } = opts;
  const turnCtx = newTurnCtx();
  const tools = [
    makeSearchTool(deps.db, deps.embed, deps.env, turnCtx),
    ...makeAccountTools(deps.db, opts.userId),
  ];

  const agent = createReactAgent({ llm: opts.model, tools, stateModifier: SYSTEM_PROMPT });
  const result = await agent.invoke(
    { messages: [...toLc(opts.history), new HumanMessage(opts.userMessage)] },
    {
      signal: opts.signal,
      // each tool round-trip is 2 graph steps; +2 for the final answer
      recursionLimit: deps.env.CHATBOT_MAX_TOOL_ITERATIONS * 2 + 2,
    },
  );

  const last = result.messages[result.messages.length - 1];
  const text =
    typeof last.content === 'string'
      ? last.content
      : last.content
          .map((c: { type?: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : ''))
          .join('');
  turnCtx.toolCalls = result.messages
    .filter((m: BaseMessage) => m.getType() === 'tool')
    .map((m: BaseMessage & { name?: string }) => m.name ?? 'tool');

  const meta = { toolCalls: turnCtx.toolCalls, qnaIds: [...new Set(turnCtx.qnaIds)] };

  if (text.includes('<escalate/>')) return { kind: 'escalate', content: '', meta };

  const usedAccountTool = turnCtx.toolCalls.some((n) => n === 'getCredits' || n === 'getRecentJobs');
  if (turnCtx.searchCalled && !turnCtx.grounded && !usedAccountTool)
    return { kind: 'fallback', content: FALLBACK_COPY, meta };

  return { kind: 'answer', content: text, meta };
}
```

Note for implementer: if the installed `@langchain/langgraph` version names the option `messageModifier` instead of `stateModifier`, use that — check the version's `createReactAgent` signature; both inject the system prompt.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @tryme/chatbot test -- bot`
Expected: PASS (3 tests). `FakeListChatModel` never emits tool calls, so the react loop exits immediately — that's fine; tool binding is tested directly.

- [ ] **Step 5: Commit**

```bash
git add apps/chatbot/src/agent apps/chatbot/test/bot.test.ts
git commit -m "feat(chatbot): langgraph bot — userId-bound tools, escalate sentinel, gate"
```

---

### Task 10: WS gateway + orchestrator (tickets, sockets, bot wiring)

**Files:**
- Create: `apps/chatbot/src/ws/tickets.ts`
- Create: `apps/chatbot/src/ws/gateway.ts`
- Create: `apps/chatbot/src/conversation/orchestrator.ts`
- Modify: `apps/chatbot/src/server.ts` (register ws routes; add `makeModel` to deps)
- Modify: `apps/chatbot/src/index.ts` (pass `makeModel: () => makeProdModel(env)`)
- Modify: `apps/chatbot/test/helpers/app.ts` (default fake model)
- Test: `apps/chatbot/test/ws.test.ts`

**Interfaces:**
- Consumes: `verifyBearer`+`Principal` (Task 8), `runBotTurn`/`makeProdModel`/`FALLBACK_COPY` (Task 9), conversation service (Task 8), frames (Task 2).
- Produces:
  - `ChatbotDeps` gains `makeModel: () => BaseChatModel`.
  - HTTP `POST /ws-ticket` (Bearer) → `{ ticket: string }` (Redis `chatbot:ws:ticket:{t}` = JSON Principal, 30s TTL, one-time GETDEL).
  - WS `GET /ws?ticket=…` — user sockets auto-attach to their active conversation and get `{type:'ready',conversationId,status}`; agent sockets accept `WsAgentFrame`s and heartbeat presence.
  - `Orchestrator` class:

```ts
export class Orchestrator {
  constructor(deps: ChatbotDeps);
  handleUserMessage(convId: string, userId: string, content: string): Promise<void>; // persist; if BOT run bot turn (serialized per conv)
  handleUserEscalate(convId: string, userId: string): Promise<void>;                 // defined fully in Task 11; this task stubs it to transition→PENDING_HUMAN
  terminate(convId: string): void;                                                   // abort in-flight bot run
  fallbackCount(convId: string): Promise<number>;
}
```
  - Redis fanout: gateway subscribes (`psubscribe chatbot:conv:*`, `subscribe chatbot:queue`); frames with `type:'terminate'` are consumed internally (calls `orchestrator.terminate`), never forwarded to clients.

- [ ] **Step 1: Write failing test**

`apps/chatbot/test/ws.test.ts`:

```ts
import { schema } from '@tryme/db';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildTestApp } from './helpers/app.js';
import { startContainers, type Containers } from './helpers/containers.js';

const SECRET = new TextEncoder().encode('test-jwt-secret-test-jwt-secret');

async function userToken(sub: string) {
  return new SignJWT({ kind: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(SECRET);
}

function nextFrame(ws: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 10_000);
    ws.on('message', (buf) => {
      const f = JSON.parse(buf.toString());
      if (f.type === type) {
        clearTimeout(timer);
        resolve(f);
      }
    });
  });
}

describe('ws gateway', () => {
  let c: Containers;
  let t: Awaited<ReturnType<typeof buildTestApp>>;
  let userId: string;

  beforeAll(async () => {
    c = await startContainers();
    t = await buildTestApp(c, {
      makeModel: () => new FakeListChatModel({ responses: ['Hello from bot'] }),
    });
    const [u] = await t.deps.db
      .insert(schema.users)
      .values({ email: 'ws@test.dev', passwordHash: 'x', emailVerified: true })
      .returning();
    userId = u.id;
  }, 60_000);

  afterAll(async () => {
    await t.stop();
    await c.stop();
  });

  it('ticket is required and one-time', async () => {
    const noTicket = await fetch(`${t.baseUrl.replace('http', 'ws')}/ws`).catch(() => null);
    const token = await userToken(userId);
    const res = await fetch(`${t.baseUrl}/ws-ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const { ticket } = (await res.json()) as { ticket: string };
    expect(ticket.length).toBeGreaterThan(16);
    expect(noTicket).toBeNull();
  });

  it('user connects, sends message, bot replies', async () => {
    const token = await userToken(userId);
    const { ticket } = (await (
      await fetch(`${t.baseUrl}/ws-ticket`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as { ticket: string };

    const ws = new WebSocket(`${t.baseUrl.replace('http', 'ws')}/ws?ticket=${ticket}`);
    const ready = await nextFrame(ws, 'ready');
    expect(ready.status).toBe('BOT');

    const botMsg = new Promise<Record<string, unknown>>((resolve) => {
      ws.on('message', (buf) => {
        const f = JSON.parse(buf.toString());
        if (f.type === 'message' && (f.message as { role: string }).role === 'bot') resolve(f);
      });
    });
    ws.send(JSON.stringify({ type: 'message', content: 'hi there' }));
    const got = await botMsg;
    expect((got.message as { content: string }).content).toBe('Hello from bot');
    ws.close();
  });
});
```

Also update `apps/chatbot/test/helpers/app.ts`: add to default deps

```ts
    makeModel: () => new FakeListChatModel({ responses: ['ok'] }),
```

(and add the import; extend `ChatbotDeps` accordingly in Step 2.)

Run: `pnpm --filter @tryme/chatbot test -- ws`
Expected: FAIL — 404 `/ws-ticket`.

- [ ] **Step 2: Implement tickets**

Add to `ChatbotDeps` in `server.ts`:

```ts
  makeModel: () => BaseChatModel;
```

`apps/chatbot/src/ws/tickets.ts`:

```ts
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Principal } from '../routes/conversations.js';
import { verifyBearer } from '../routes/conversations.js';
import { AppError } from '../lib/errors.js';

const TTL_SECONDS = 30;

export async function ticketRoutes(app: FastifyInstance) {
  app.post('/ws-ticket', async (req) => {
    const principal = await verifyBearer(app, req.headers.authorization);
    const ticket = randomBytes(24).toString('base64url');
    await app.deps.redis.set(
      `chatbot:ws:ticket:${ticket}`,
      JSON.stringify(principal),
      'EX',
      TTL_SECONDS,
    );
    return { ticket };
  });
}

export async function redeemTicket(app: FastifyInstance, ticket: string): Promise<Principal> {
  const raw = await app.deps.redis.getdel(`chatbot:ws:ticket:${ticket}`);
  if (!raw) throw new AppError('UNAUTH', 401, 'invalid or expired ticket');
  return JSON.parse(raw) as Principal;
}
```

- [ ] **Step 3: Implement orchestrator**

`apps/chatbot/src/conversation/orchestrator.ts`:

```ts
import { eq, schema } from '@tryme/db';
import { runBotTurn } from '../agent/bot.js';
import type { ChatbotDeps } from '../server.js';
import {
  appendMessage,
  getOrCreateActiveConversation,
  listMessages,
  publishConv,
  transition,
} from './service.js';

const HISTORY_N = 12; // §20 replay window

export class Orchestrator {
  private inflight = new Map<string, AbortController>();
  private chains = new Map<string, Promise<void>>();

  constructor(private deps: ChatbotDeps) {}

  /** serialize bot turns per conversation */
  private enqueue(convId: string, fn: () => Promise<void>): Promise<void> {
    const next = (this.chains.get(convId) ?? Promise.resolve()).then(fn, fn);
    this.chains.set(convId, next);
    return next;
  }

  terminate(convId: string): void {
    this.inflight.get(convId)?.abort();
    this.inflight.delete(convId);
  }

  async fallbackCount(convId: string): Promise<number> {
    const n = await this.deps.redis.get(`chatbot:conv:${convId}:fallbacks`);
    return Number(n ?? 0);
  }

  async handleUserMessage(convId: string, userId: string, content: string): Promise<void> {
    const { deps } = this;
    await appendMessage(deps.db, deps.pub, convId, { role: 'user', senderId: userId, content });

    const [conv] = await deps.db
      .select()
      .from(schema.chatbotConversations)
      .where(eq(schema.chatbotConversations.id, convId));
    if (!conv || conv.status !== 'BOT') return; // PENDING/HUMAN: persist only (§8.4)

    await this.enqueue(convId, async () => {
      const ac = new AbortController();
      this.inflight.set(convId, ac);
      try {
        await publishConv(deps.pub, convId, { type: 'typing', conversationId: convId, role: 'bot' });
        const history = await listMessages(deps.db, convId, { limit: HISTORY_N });
        const result = await runBotTurn({
          deps,
          model: deps.makeModel(),
          userId,
          convId,
          history: history.slice(0, -1), // exclude the message we just appended
          userMessage: content,
          signal: ac.signal,
        });

        if (result.kind === 'escalate') {
          await this.escalate(convId, userId, 'user_request');
          return;
        }

        if (result.kind === 'fallback') {
          const n = await deps.redis.incr(`chatbot:conv:${convId}:fallbacks`);
          await deps.redis.expire(`chatbot:conv:${convId}:fallbacks`, 3600);
          if (n >= deps.env.CHATBOT_FALLBACK_LIMIT) {
            await this.escalate(convId, userId, 'low_confidence');
            return;
          }
        } else {
          await deps.redis.del(`chatbot:conv:${convId}:fallbacks`);
        }

        // §8.3: persist bot output only if still BOT — checked in one guarded txn
        await deps.db.transaction(async (tx) => {
          const [row] = await tx
            .select({ status: schema.chatbotConversations.status })
            .from(schema.chatbotConversations)
            .where(eq(schema.chatbotConversations.id, convId))
            .for('update');
          if (row?.status !== 'BOT') return;
          await tx.insert(schema.chatbotMessages).values({
            conversationId: convId,
            role: 'bot',
            content: result.content,
            meta: result.meta,
          });
          await tx
            .update(schema.chatbotConversations)
            .set({ lastMessageAt: new Date() })
            .where(eq(schema.chatbotConversations.id, convId));
        });
        // re-read to publish exactly what was persisted (skip publish if takeover won)
        const [persisted] = await listMessages(deps.db, convId, { limit: 1 });
        if (persisted?.role === 'bot' && persisted.content === result.content) {
          await publishConv(deps.pub, convId, { type: 'message', message: persisted });
        }
      } catch (err) {
        if (ac.signal.aborted) return; // takeover aborted us — silent
        this.deps.log.error({ err, convId }, 'bot turn failed');
        await appendMessage(deps.db, deps.pub, convId, {
          role: 'system',
          content: 'Something went wrong answering that. You can try again or talk to a human.',
        });
      } finally {
        this.inflight.delete(convId);
      }
    });
  }

  // Full availability-aware version lands in Task 11 (escalation.ts); until then:
  async escalate(convId: string, _userId: string, reason: string): Promise<void> {
    await transition(this.deps.db, this.deps.pub, convId, {
      from: 'BOT',
      to: 'PENDING_HUMAN',
      type: 'escalate',
      reason,
    });
    await appendMessage(this.deps.db, this.deps.pub, convId, {
      role: 'system',
      content: 'Connecting you to a human agent…',
    });
    await this.deps.pub.publish('chatbot:queue', JSON.stringify({ type: 'queue_update' }));
  }

  async handleUserEscalate(convId: string, userId: string): Promise<void> {
    await this.escalate(convId, userId, 'user_request');
  }
}

export { getOrCreateActiveConversation };
```

- [ ] **Step 4: Implement gateway**

`apps/chatbot/src/ws/gateway.ts`:

```ts
import { and, eq, schema, sql } from '@tryme/db';
import { WsAgentFrame, WsClientFrame } from '@tryme/types';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { Orchestrator } from '../conversation/orchestrator.js';
import {
  appendMessage,
  getOrCreateActiveConversation,
} from '../conversation/service.js';
import type { Principal } from '../routes/conversations.js';
import { redeemTicket } from './tickets.js';

interface SocketCtx {
  principal: Principal;
  convIds: Set<string>;
}

export function setupGateway(app: FastifyInstance, orchestrator: Orchestrator) {
  const { deps } = app;
  const subscribers = new Map<string, Set<WebSocket>>(); // convId -> sockets
  const agentSockets = new Map<WebSocket, string>(); // socket -> adminUserId

  // ---- Redis fanout (multi-instance safe) ----
  void deps.sub.psubscribe('chatbot:conv:*');
  void deps.sub.subscribe('chatbot:queue');
  deps.sub.on('pmessage', (_pat, channel, raw) => {
    const convId = channel.slice('chatbot:conv:'.length);
    const frame = JSON.parse(raw) as { type: string };
    if (frame.type === 'terminate') {
      orchestrator.terminate(convId);
      return; // internal — never forwarded
    }
    for (const ws of subscribers.get(convId) ?? []) ws.send(raw);
  });
  deps.sub.on('message', (channel, raw) => {
    if (channel !== 'chatbot:queue') return;
    for (const ws of agentSockets.keys()) ws.send(raw);
  });

  function subscribe(convId: string, ws: WebSocket, ctx: SocketCtx) {
    if (!subscribers.has(convId)) subscribers.set(convId, new Set());
    subscribers.get(convId)!.add(ws);
    ctx.convIds.add(convId);
  }

  function cleanup(ws: WebSocket, ctx: SocketCtx) {
    for (const id of ctx.convIds) subscribers.get(id)?.delete(ws);
    if (agentSockets.has(ws)) {
      const agentId = agentSockets.get(ws)!;
      agentSockets.delete(ws);
      void deps.redis.zrem('chatbot:agent:presence', agentId); // fast path (§9.1)
    }
  }

  // ---- presence heartbeat: ping every 15s; each pong ZADDs (§9.1) ----
  const beat = setInterval(() => {
    for (const [ws, agentId] of agentSockets) {
      ws.ping();
      void deps.redis.zadd('chatbot:agent:presence', Date.now(), agentId);
    }
  }, 15_000);
  app.addHook('onClose', async () => clearInterval(beat));

  app.get('/ws', { websocket: true }, async (socket, req) => {
    const { ticket } = req.query as { ticket?: string };
    let principal: Principal;
    try {
      principal = await redeemTicket(app, ticket ?? '');
    } catch {
      socket.close(4401, 'unauthorized');
      return;
    }
    const ctx: SocketCtx = { principal, convIds: new Set() };
    socket.on('close', () => cleanup(socket, ctx));

    if (principal.role === 'user') {
      const conv = await getOrCreateActiveConversation(deps.db, principal.userId);
      subscribe(conv.id, socket, ctx);
      socket.send(
        JSON.stringify({ type: 'ready', conversationId: conv.id, status: conv.status }),
      );
      socket.on('message', (buf) => {
        void (async () => {
          const parsed = WsClientFrame.safeParse(JSON.parse(buf.toString()));
          if (!parsed.success) {
            socket.send(JSON.stringify({ type: 'error', code: 'BAD_FRAME', message: 'invalid frame' }));
            return;
          }
          const f = parsed.data;
          if (f.type === 'message')
            await orchestrator.handleUserMessage(conv.id, principal.userId, f.content);
          else if (f.type === 'typing')
            await deps.pub.publish(
              `chatbot:conv:${conv.id}`,
              JSON.stringify({ type: 'typing', conversationId: conv.id, role: 'user' }),
            );
          else if (f.type === 'escalate')
            await orchestrator.handleUserEscalate(conv.id, principal.userId);
        })().catch((err) => app.log.error({ err }, 'user frame failed'));
      });
      return;
    }

    // agent socket
    agentSockets.set(socket, principal.adminUserId!);
    await deps.redis.zadd('chatbot:agent:presence', Date.now(), principal.adminUserId!);
    socket.on('message', (buf) => {
      void (async () => {
        const parsed = WsAgentFrame.safeParse(JSON.parse(buf.toString()));
        if (!parsed.success) {
          socket.send(JSON.stringify({ type: 'error', code: 'BAD_FRAME', message: 'invalid frame' }));
          return;
        }
        const f = parsed.data;
        if (f.type === 'join') {
          subscribe(f.conversationId, socket, ctx);
        } else if (f.type === 'leave') {
          subscribers.get(f.conversationId)?.delete(socket);
          ctx.convIds.delete(f.conversationId);
        } else if (f.type === 'message') {
          // only the assigned agent of a HUMAN conversation may speak
          const [conv] = await deps.db
            .select()
            .from(schema.chatbotConversations)
            .where(
              and(
                eq(schema.chatbotConversations.id, f.conversationId),
                eq(schema.chatbotConversations.status, 'HUMAN'),
                eq(schema.chatbotConversations.assignedAgentId, principal.adminUserId!),
              ),
            );
          if (!conv) {
            socket.send(JSON.stringify({ type: 'error', code: 'FORBIDDEN', message: 'not assigned' }));
            return;
          }
          await appendMessage(deps.db, deps.pub, f.conversationId, {
            role: 'agent',
            senderId: principal.adminUserId,
            content: f.content,
          });
        } else if (f.type === 'typing') {
          await deps.pub.publish(
            `chatbot:conv:${f.conversationId}`,
            JSON.stringify({ type: 'typing', conversationId: f.conversationId, role: 'agent' }),
          );
        }
      })().catch((err) => app.log.error({ err }, 'agent frame failed'));
    });
  });
}
```

Wire in `server.ts` (after route registrations):

```ts
import { Orchestrator } from './conversation/orchestrator.js';
import { setupGateway } from './ws/gateway.js';
import { ticketRoutes } from './ws/tickets.js';
// inside buildChatbotServer:
  const orchestrator = new Orchestrator(deps);
  app.decorate('orchestrator', orchestrator);
  await app.register(ticketRoutes);
  await app.register(async (a) => setupGateway(a, orchestrator));
```

Add `orchestrator: Orchestrator` to the fastify module declaration. In `index.ts` pass `makeModel: () => makeProdModel(env)` into deps.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @tryme/chatbot test`
Expected: ALL PASS (health, ingest, search, conversation, bot, ws).

- [ ] **Step 6: Commit**

```bash
git add apps/chatbot/src apps/chatbot/test
git commit -m "feat(chatbot): ws gateway, one-time tickets, orchestrator with abort-safe bot turns"
```

---

### Task 11: Escalation, availability, email fallback, sweeper (chatbot side)

**Files:**
- Create: `apps/chatbot/src/conversation/escalation.ts`
- Create: `apps/chatbot/src/conversation/sweeper.ts`
- Modify: `apps/chatbot/src/conversation/orchestrator.ts` (replace stub `escalate` with `escalation.ts` version)
- Modify: `apps/chatbot/src/index.ts` (start sweeper interval, 60s)
- Test: `apps/chatbot/test/escalation.test.ts`

**Interfaces:**
- Consumes: `transition`, `appendMessage`, `publishConv` (Task 8); `schema.contactRequests`, `schema.users`.
- Produces:

```ts
// escalation.ts
export async function listAvailableAgents(redis: Redis): Promise<string[]>;
// duty SET ∩ presence ZSET fresh within 30s (§8.2)
export async function escalate(deps: ChatbotDeps, convId: string, userId: string, reason: 'user_request' | 'low_confidence' | 'agent_join'): Promise<void>;
// available agents → PENDING_HUMAN + queue notify; none → contact_requests + CLOSED (§8.2/§8.4)

// sweeper.ts
export async function runChatSweeper(deps: ChatbotDeps): Promise<void>;
// 1) BOT idle >IDLE_TIMEOUT → CLOSED
// 2) PENDING_HUMAN unclaimed >IDLE_TIMEOUT → contact_requests + CLOSED
// 3) prune presence ZSET entries older than 60s
// 4) HUMAN convs whose assigned agent is offline >60s → release lock, → PENDING_HUMAN, notify queue (§8.5)
```
- Redis keys: duty = SET `chatbot:agent:duty` (members adminUserId); presence = ZSET `chatbot:agent:presence`; claim lock = `chatbot:conv:{id}:lock`.

- [ ] **Step 1: Write failing tests**

`apps/chatbot/test/escalation.test.ts`:

```ts
import { eq, schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { escalate, listAvailableAgents } from '../src/conversation/escalation.js';
import { runChatSweeper } from '../src/conversation/sweeper.js';
import {
  getOrCreateActiveConversation,
  transition,
} from '../src/conversation/service.js';
import { buildTestApp } from './helpers/app.js';
import { startContainers, type Containers } from './helpers/containers.js';

describe('escalation + sweeper', () => {
  let c: Containers;
  let t: Awaited<ReturnType<typeof buildTestApp>>;
  let userId: string;
  let agentId: string;

  beforeAll(async () => {
    c = await startContainers();
    t = await buildTestApp(c);
    const [u] = await t.deps.db
      .insert(schema.users)
      .values({ email: 'esc@test.dev', passwordHash: 'x', emailVerified: true })
      .returning();
    userId = u.id;
    const [au] = await t.deps.db
      .insert(schema.users)
      .values({ email: 'agent@test.dev', passwordHash: 'x', emailVerified: true })
      .returning();
    const [admin] = await t.deps.db
      .insert(schema.adminUsers)
      .values({ userId: au.id, role: 'SUPPORT', status: 'active' })
      .returning();
    agentId = admin.id;
  }, 60_000);

  afterAll(async () => {
    await t.stop();
    await c.stop();
  });

  it('available = duty ON ∩ fresh presence', async () => {
    expect(await listAvailableAgents(t.deps.redis)).toEqual([]);
    await t.deps.redis.sadd('chatbot:agent:duty', agentId);
    expect(await listAvailableAgents(t.deps.redis)).toEqual([]); // duty but not live
    await t.deps.redis.zadd('chatbot:agent:presence', Date.now(), agentId);
    expect(await listAvailableAgents(t.deps.redis)).toEqual([agentId]);
    await t.deps.redis.zadd('chatbot:agent:presence', Date.now() - 120_000, agentId);
    expect(await listAvailableAgents(t.deps.redis)).toEqual([]); // stale beat
  });

  it('escalate with agent available → PENDING_HUMAN', async () => {
    await t.deps.redis.zadd('chatbot:agent:presence', Date.now(), agentId);
    const conv = await getOrCreateActiveConversation(t.deps.db, userId);
    await escalate(t.deps, conv.id, userId, 'user_request');
    const [row] = await t.deps.db
      .select()
      .from(schema.chatbotConversations)
      .where(eq(schema.chatbotConversations.id, conv.id));
    expect(row.status).toBe('PENDING_HUMAN');
    expect(row.escalationReason).toBe('user_request');
    // cleanup for next test
    await transition(t.deps.db, t.deps.pub, conv.id, {
      from: 'PENDING_HUMAN', to: 'CLOSED', type: 'close',
    });
  });

  it('escalate with nobody available → contact_requests + CLOSED', async () => {
    await t.deps.redis.srem('chatbot:agent:duty', agentId);
    const conv = await getOrCreateActiveConversation(t.deps.db, userId);
    await escalate(t.deps, conv.id, userId, 'user_request');
    const [row] = await t.deps.db
      .select()
      .from(schema.chatbotConversations)
      .where(eq(schema.chatbotConversations.id, conv.id));
    expect(row.status).toBe('CLOSED');
    const reqs = await t.deps.db
      .select()
      .from(schema.contactRequests)
      .where(eq(schema.contactRequests.source, 'chatbot'));
    expect(reqs.length).toBe(1);
    expect(reqs[0].email).toBe('esc@test.dev');
  });

  it('sweeper closes idle BOT conv and emails PENDING timeout', async () => {
    const conv = await getOrCreateActiveConversation(t.deps.db, userId);
    await t.deps.db
      .update(schema.chatbotConversations)
      .set({ lastMessageAt: new Date(Date.now() - 31 * 60_000) })
      .where(eq(schema.chatbotConversations.id, conv.id));
    await runChatSweeper(t.deps);
    const [row] = await t.deps.db
      .select()
      .from(schema.chatbotConversations)
      .where(eq(schema.chatbotConversations.id, conv.id));
    expect(row.status).toBe('CLOSED');
  });
});
```

Run: `pnpm --filter @tryme/chatbot test -- escalation`
Expected: FAIL — modules not found.

- [ ] **Step 2: Implement escalation**

`apps/chatbot/src/conversation/escalation.ts`:

```ts
import { eq, schema } from '@tryme/db';
import type { Redis } from 'ioredis';
import type { ChatbotDeps } from '../server.js';
import { appendMessage, transition } from './service.js';

const PRESENCE_FRESH_MS = 30_000; // 2× beat interval (§9.1)

export async function listAvailableAgents(redis: Redis): Promise<string[]> {
  const [duty, online] = await Promise.all([
    redis.smembers('chatbot:agent:duty'),
    redis.zrangebyscore('chatbot:agent:presence', Date.now() - PRESENCE_FRESH_MS, '+inf'),
  ]);
  const onlineSet = new Set(online);
  return duty.filter((id) => onlineSet.has(id));
}

export async function escalate(
  deps: ChatbotDeps,
  convId: string,
  userId: string,
  reason: 'user_request' | 'low_confidence' | 'agent_join',
): Promise<void> {
  const available = await listAvailableAgents(deps.redis);

  if (available.length > 0) {
    const ok = await transition(deps.db, deps.pub, convId, {
      from: 'BOT',
      to: 'PENDING_HUMAN',
      type: 'escalate',
      reason,
    });
    if (!ok) return; // already escalated/claimed
    await appendMessage(deps.db, deps.pub, convId, {
      role: 'system',
      content: 'Connecting you to a human agent…',
    });
    await deps.pub.publish('chatbot:queue', JSON.stringify({ type: 'queue_update' }));
    return;
  }

  // email fallback (§8.2): no agent on duty+live
  await emailFallback(deps, convId, userId, reason);
}

export async function emailFallback(
  deps: ChatbotDeps,
  convId: string,
  userId: string,
  reason: string,
): Promise<void> {
  const [user] = await deps.db
    .select({ email: schema.users.email, name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  const lastMsgs = await deps.db
    .select({ role: schema.chatbotMessages.role, content: schema.chatbotMessages.content })
    .from(schema.chatbotMessages)
    .where(eq(schema.chatbotMessages.conversationId, convId))
    .limit(20);
  await deps.db.insert(schema.contactRequests).values({
    userId,
    name: user?.name ?? user?.email ?? 'chat user',
    email: user?.email ?? '',
    phone: '',
    source: 'chatbot',
    message: `Chat escalation (${reason}), conversation ${convId}:\n${lastMsgs
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n')
      .slice(0, 4000)}`,
  });
  await appendMessage(deps.db, deps.pub, convId, {
    role: 'system',
    content: 'No agents are available right now — our team will follow up by email.',
  });
  await transition(deps.db, deps.pub, convId, {
    from: ['BOT', 'PENDING_HUMAN'],
    to: 'CLOSED',
    type: 'close',
    reason: 'email_fallback',
  });
}
```

Note: check `packages/db/src/schema/users.ts` for the display-name column (`name` vs `fullName`) and adjust.

In `orchestrator.ts`: delete the stub `escalate` method; import `{ escalate }` from `./escalation.js` and call `escalate(this.deps, convId, userId, reason)` in the two call sites (`handleUserEscalate`, bot-result handling).

- [ ] **Step 3: Implement sweeper**

`apps/chatbot/src/conversation/sweeper.ts`:

```ts
import { and, eq, schema, sql } from '@tryme/db';
import type { ChatbotDeps } from '../server.js';
import { emailFallback } from './escalation.js';
import { appendMessage, publishConv, transition } from './service.js';

const AGENT_OFFLINE_GRACE_MS = 60_000; // §8.5

export async function runChatSweeper(deps: ChatbotDeps): Promise<void> {
  const idleCutoff = new Date(Date.now() - deps.env.CHATBOT_IDLE_TIMEOUT_MIN * 60_000);

  // 1) BOT idle → CLOSED
  const idleBot = await deps.db
    .select({ id: schema.chatbotConversations.id })
    .from(schema.chatbotConversations)
    .where(
      and(
        eq(schema.chatbotConversations.status, 'BOT'),
        sql`${schema.chatbotConversations.lastMessageAt} < ${idleCutoff}`,
      ),
    );
  for (const { id } of idleBot) {
    await appendMessage(deps.db, deps.pub, id, {
      role: 'system',
      content: 'This conversation was closed due to inactivity.',
    });
    await transition(deps.db, deps.pub, id, {
      from: 'BOT', to: 'CLOSED', type: 'close', reason: 'idle',
    });
  }

  // 2) PENDING_HUMAN unclaimed too long → email fallback (§8.4)
  const stalePending = await deps.db
    .select({
      id: schema.chatbotConversations.id,
      userId: schema.chatbotConversations.userId,
    })
    .from(schema.chatbotConversations)
    .where(
      and(
        eq(schema.chatbotConversations.status, 'PENDING_HUMAN'),
        sql`${schema.chatbotConversations.lastMessageAt} < ${idleCutoff}`,
      ),
    );
  for (const conv of stalePending) {
    await emailFallback(deps, conv.id, conv.userId, 'pending_timeout');
  }

  // 3) prune stale presence
  await deps.redis.zremrangebyscore(
    'chatbot:agent:presence',
    '-inf',
    Date.now() - AGENT_OFFLINE_GRACE_MS,
  );

  // 4) HUMAN convs with offline agent → re-queue (§8.5)
  const humanConvs = await deps.db
    .select({
      id: schema.chatbotConversations.id,
      agentId: schema.chatbotConversations.assignedAgentId,
    })
    .from(schema.chatbotConversations)
    .where(eq(schema.chatbotConversations.status, 'HUMAN'));
  for (const conv of humanConvs) {
    if (!conv.agentId) continue;
    const score = await deps.redis.zscore('chatbot:agent:presence', conv.agentId);
    if (score && Number(score) > Date.now() - AGENT_OFFLINE_GRACE_MS) continue; // agent live
    await deps.redis.del(`chatbot:conv:${conv.id}:lock`);
    await deps.db
      .update(schema.chatbotConversations)
      .set({ assignedAgentId: null })
      .where(eq(schema.chatbotConversations.id, conv.id));
    await appendMessage(deps.db, deps.pub, conv.id, {
      role: 'system',
      content: 'Your agent got disconnected — reconnecting you…',
    });
    await transition(deps.db, deps.pub, conv.id, {
      from: 'HUMAN', to: 'PENDING_HUMAN', type: 'escalate', reason: 'agent_drop',
    });
    await deps.pub.publish('chatbot:queue', JSON.stringify({ type: 'queue_update' }));
  }
}
```

In `apps/chatbot/src/index.ts` after `app.listen`:

```ts
  const sweepInterval = setInterval(() => {
    void runChatSweeper({ env, db, redis, pub, sub, embed, makeModel, log } as ChatbotDeps).catch(
      (err) => log.error({ err }, 'sweeper failed'),
    );
  }, 60_000);
```

(clear it in `shutdown`). Cleaner: build `deps` once as a const and share between `buildChatbotServer` and the sweeper.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @tryme/chatbot test`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/chatbot/src apps/chatbot/test
git commit -m "feat(chatbot): escalation w/ availability check, email fallback, idle+agent-drop sweeper"
```

---

### Task 12: api — HITL admin routes (inbox, claim, takeover, end, duty)

**Files:**
- Modify: `apps/api/src/modules/admin/chatbot.routes.ts` (extend)
- Test: `apps/api/test/admin-chatbot-hitl.test.ts`

**Interfaces:**
- Consumes: `requireAdmin`, Redis (`app.redis`), schema tables.
- Produces (all `requireAdmin(['SUPER_ADMIN','MODERATOR','ADMIN','SUPPORT'])`):
  - `GET /admin/chatbot/conversations?status=BOT|PENDING_HUMAN|HUMAN|CLOSED|all&limit&offset` → `{ rows: [{...conv, userEmail, lastMessage}], total }` sorted `last_message_at DESC` (queue view: `status=PENDING_HUMAN` sorted ASC by escalation time client-side)
  - `POST /admin/chatbot/conversations/:id/claim` → PENDING_HUMAN→HUMAN, atomic lock
  - `POST /admin/chatbot/conversations/:id/takeover` → BOT→HUMAN, publishes `{type:'terminate'}`
  - `POST /admin/chatbot/conversations/:id/end` → HUMAN→CLOSED (assigned agent only)
  - `POST /admin/chatbot/duty` body `{ on: boolean }` → `{ on }` (SADD/SREM `chatbot:agent:duty`)
  - `GET /admin/chatbot/duty` → `{ on: boolean }`
- Every state change: writes `chatbot_events`, sends system message, publishes `state_change` on `chatbot:conv:{id}` and `queue_update` on `chatbot:queue` (raw `PUBLISH` from api — same Redis).

- [ ] **Step 1: Write failing test**

`apps/api/test/admin-chatbot-hitl.test.ts` (same harness pattern as Task 6; seed one user + conversation directly via `app.db`):

```ts
// harness bootstrap as in sibling admin tests …
import { schema } from '@tryme/db';
import { describe, expect, it } from 'vitest';

describe('admin chatbot hitl', () => {
  it('claim: PENDING_HUMAN → HUMAN, second claim 409', async () => {
    const conv = await seedConversation('PENDING_HUMAN'); // insert users + chatbot_conversations row
    const first = await supportFetchRaw('POST', `/admin/chatbot/conversations/${conv.id}/claim`);
    expect(first.status).toBe(200);
    const second = await supportFetchRaw('POST', `/admin/chatbot/conversations/${conv.id}/claim`);
    expect(second.status).toBe(409);
    const [row] = await app.db.select().from(schema.chatbotConversations);
    expect(row.status).toBe('HUMAN');
    expect(row.assignedAgentId).not.toBeNull();
  });

  it('takeover: BOT → HUMAN + terminate published', async () => {
    const conv = await seedConversation('BOT');
    // subscribe a raw redis client to chatbot:conv:{id} BEFORE takeover; collect frames
    const frames: string[] = [];
    // … subscribe …
    const res = await supportFetchRaw('POST', `/admin/chatbot/conversations/${conv.id}/takeover`);
    expect(res.status).toBe(200);
    // eventually frames include {"type":"terminate"} and a state_change to HUMAN
  });

  it('end: only assigned agent, HUMAN → CLOSED, lock released', async () => {
    const conv = await seedConversation('PENDING_HUMAN');
    await supportFetchRaw('POST', `/admin/chatbot/conversations/${conv.id}/claim`);
    const res = await supportFetchRaw('POST', `/admin/chatbot/conversations/${conv.id}/end`);
    expect(res.status).toBe(200);
    const lock = await redis.get(`chatbot:conv:${conv.id}:lock`);
    expect(lock).toBeNull();
  });

  it('duty toggle round-trips', async () => {
    await supportFetch('POST', '/admin/chatbot/duty', { on: true });
    expect((await supportFetch('GET', '/admin/chatbot/duty')).on).toBe(true);
    await supportFetch('POST', '/admin/chatbot/duty', { on: false });
    expect((await supportFetch('GET', '/admin/chatbot/duty')).on).toBe(false);
  });
});
```

(`supportFetch*` = admin-auth helper logged in as a SUPPORT-role admin; `seedConversation(status)` inserts a user + conversation row and returns it. Implement both in the test file using the harness's existing seeding utilities.)

Run: `pnpm --filter @tryme/api test -- admin-chatbot-hitl`
Expected: FAIL — 404.

- [ ] **Step 2: Implement — append to `adminChatbotRoutes`**

```ts
  const LIVE = requireAdmin(['SUPER_ADMIN', 'MODERATOR', 'ADMIN', 'SUPPORT']);

  async function adminRowId(userId: string): Promise<string> {
    const [a] = await app.db
      .select({ id: schema.adminUsers.id })
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.userId, userId));
    if (!a) throw new AppError('FORBIDDEN', 403, 'admin required');
    return a.id;
  }

  async function publishConv(convId: string, frame: object) {
    await app.redis.publish(`chatbot:conv:${convId}`, JSON.stringify(frame));
  }
  async function publishQueue() {
    await app.redis.publish('chatbot:queue', JSON.stringify({ type: 'queue_update' }));
  }

  async function systemMessage(convId: string, content: string) {
    const [row] = await app.db
      .insert(schema.chatbotMessages)
      .values({ conversationId: convId, role: 'system', content })
      .returning();
    await publishConv(convId, {
      type: 'message',
      message: {
        id: row.id, conversationId: convId, role: 'system',
        senderId: null, content, createdAt: row.createdAt.toISOString(),
      },
    });
  }

  app.get('/admin/chatbot/conversations', { preHandler: LIVE }, async (req) => {
    const { status = 'all', limit = '50', offset = '0' } = req.query as Record<string, string>;
    const lim = Math.min(Number(limit) || 50, 200);
    const off = Number(offset) || 0;
    const where =
      status !== 'all' ? eq(schema.chatbotConversations.status, status) : undefined;
    const [rows, [countRow]] = await Promise.all([
      app.db
        .select({
          conv: schema.chatbotConversations,
          userEmail: schema.users.email,
        })
        .from(schema.chatbotConversations)
        .innerJoin(schema.users, eq(schema.users.id, schema.chatbotConversations.userId))
        .where(where)
        .orderBy(desc(schema.chatbotConversations.lastMessageAt))
        .limit(lim)
        .offset(off),
      app.db
        .select({ total: sql<number>`count(*)::int` })
        .from(schema.chatbotConversations)
        .where(where),
    ]);
    return {
      rows: rows.map((r) => ({ ...r.conv, userEmail: r.userEmail })),
      total: countRow?.total ?? 0,
    };
  });

  // shared claim/takeover core
  async function assign(convId: string, fromStatus: string, type: 'claim' | 'takeover', userId: string) {
    const agentId = await adminRowId(userId);
    const got = await app.redis.set(`chatbot:conv:${convId}:lock`, agentId, 'NX');
    if (!got) throw new AppError('ALREADY_CLAIMED', 409, 'conversation already claimed');
    const [row] = await app.db
      .update(schema.chatbotConversations)
      .set({
        status: 'HUMAN',
        assignedAgentId: agentId,
        ...(type === 'takeover' ? { escalationReason: 'agent_join' } : {}),
      })
      .where(
        and(
          eq(schema.chatbotConversations.id, convId),
          eq(schema.chatbotConversations.status, fromStatus),
        ),
      )
      .returning();
    if (!row) {
      await app.redis.del(`chatbot:conv:${convId}:lock`);
      throw new AppError('BAD_STATE', 409, `conversation is not ${fromStatus}`);
    }
    await app.db.insert(schema.chatbotEvents).values({
      conversationId: convId, type, actorId: agentId,
      fromStatus, toStatus: 'HUMAN',
      reason: type === 'takeover' ? 'agent_join' : null,
    });
    await publishConv(convId, { type: 'terminate' }); // abort in-flight bot run (§8.3)
    await publishConv(convId, {
      type: 'state_change', conversationId: convId, status: 'HUMAN',
      reason: type === 'takeover' ? 'agent_join' : null,
    });
    await systemMessage(convId, 'A support agent has joined the conversation.');
    await publishQueue();
    return row;
  }

  app.post(
    '/admin/chatbot/conversations/:id/claim',
    { preHandler: LIVE, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req) => assign((req.params as { id: string }).id, 'PENDING_HUMAN', 'claim', req.userId),
  );

  app.post(
    '/admin/chatbot/conversations/:id/takeover',
    { preHandler: LIVE, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req) => assign((req.params as { id: string }).id, 'BOT', 'takeover', req.userId),
  );

  app.post(
    '/admin/chatbot/conversations/:id/end',
    { preHandler: LIVE, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req) => {
      const { id } = req.params as { id: string };
      const agentId = await adminRowId(req.userId);
      const [row] = await app.db
        .update(schema.chatbotConversations)
        .set({ status: 'CLOSED', closedAt: new Date() })
        .where(
          and(
            eq(schema.chatbotConversations.id, id),
            eq(schema.chatbotConversations.status, 'HUMAN'),
            eq(schema.chatbotConversations.assignedAgentId, agentId),
          ),
        )
        .returning();
      if (!row) throw new AppError('BAD_STATE', 409, 'not your active HUMAN conversation');
      await app.db.insert(schema.chatbotEvents).values({
        conversationId: id, type: 'close', actorId: agentId,
        fromStatus: 'HUMAN', toStatus: 'CLOSED',
      });
      await app.redis.del(`chatbot:conv:${id}:lock`);
      await systemMessage(id, 'The agent ended this conversation.');
      await publishConv(id, {
        type: 'state_change', conversationId: id, status: 'CLOSED', reason: null,
      });
      return row;
    },
  );

  app.post(
    '/admin/chatbot/duty',
    { preHandler: LIVE, schema: { body: z.object({ on: z.boolean() }) } },
    async (req) => {
      const agentId = await adminRowId(req.userId);
      const { on } = req.body as { on: boolean };
      if (on) await app.redis.sadd('chatbot:agent:duty', agentId);
      else await app.redis.srem('chatbot:agent:duty', agentId);
      return { on };
    },
  );

  app.get('/admin/chatbot/duty', { preHandler: LIVE }, async (req) => {
    const agentId = await adminRowId(req.userId);
    const on = (await app.redis.sismember('chatbot:agent:duty', agentId)) === 1;
    return { on };
  });
```

(Also add `desc` to the drizzle import at the top of the file.)

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @tryme/api test -- admin-chatbot`
Expected: ALL PASS (Task 6 + Task 12 tests).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat(api): chatbot hitl — inbox list, atomic claim/takeover/end, duty toggle"
```

---

### Task 13: admin-web — Chat Inbox page

**Files:**
- Create: `apps/admin-web/src/pages/ChatInboxPage.tsx`
- Create: `apps/admin-web/src/lib/chatws.ts`
- Modify: `apps/admin-web/src/App.tsx` + Sidebar (route `/chat-inbox`, label "Chat Inbox", visible to all admin roles incl. SUPPORT)
- Modify: `apps/admin-web/.env.example` or vite env docs (`VITE_CHATBOT_URL`)

**Interfaces:**
- Consumes: Task 12 HTTP endpoints via `apiFetch`; chatbot `POST /ws-ticket` + `/ws` (agent role) at `import.meta.env.VITE_CHATBOT_URL` (default `http://localhost:4200`); `GET /conversations/:id/messages` (chatbot HTTP) with admin Bearer token from `getToken()` in `lib/data.ts`.
- Produces: `connectAgentWs(onFrame: (f: WsServerFrameT) => void): Promise<{ send: (f: WsAgentFrameT) => void; close: () => void }>` in `chatws.ts`.

- [ ] **Step 1: WS client helper**

`apps/admin-web/src/lib/chatws.ts`:

```ts
import type { WsAgentFrameT, WsServerFrameT } from '@tryme/types';
import { getToken } from './data';

const CHATBOT_URL = (import.meta.env.VITE_CHATBOT_URL as string) || 'http://localhost:4200';

export async function fetchChatbot<T>(path: string): Promise<T> {
  const res = await fetch(`${CHATBOT_URL}${path}`, {
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) throw new Error(`chatbot ${res.status}`);
  return res.json() as Promise<T>;
}

export async function connectAgentWs(
  onFrame: (f: WsServerFrameT) => void,
): Promise<{ send: (f: WsAgentFrameT) => void; close: () => void }> {
  const res = await fetch(`${CHATBOT_URL}/ws-ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) throw new Error('ws ticket failed');
  const { ticket } = (await res.json()) as { ticket: string };
  const ws = new WebSocket(`${CHATBOT_URL.replace(/^http/, 'ws')}/ws?ticket=${ticket}`);
  ws.onmessage = (ev) => onFrame(JSON.parse(ev.data as string) as WsServerFrameT);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('ws failed'));
  });
  return {
    send: (f) => ws.send(JSON.stringify(f)),
    close: () => ws.close(),
  };
}
```

Add `"@tryme/types": "workspace:*"` to `apps/admin-web/package.json` dependencies if not already present; `pnpm install`.

- [ ] **Step 2: Inbox page**

`apps/admin-web/src/pages/ChatInboxPage.tsx` — behavior spec (follow existing page markup conventions; all logic below is final):

- On mount: `apiFetch('/admin/chatbot/duty')` → duty state; `apiFetch('/admin/chatbot/conversations?status=PENDING_HUMAN')` (queue) + `?status=BOT` (live monitor) + `?status=HUMAN` (mine); `connectAgentWs(handleFrame)`.
- **Duty toggle** button: `POST /admin/chatbot/duty {on}`; show badge "On duty"/"Off duty".
- **Queue panel**: PENDING_HUMAN rows (oldest first), each shows userEmail, escalationReason, wait time (`now - lastMessageAt`), "Claim" button → `POST .../claim`; on 409 toast "Already claimed" and refresh.
- **Bot-live panel**: BOT rows with "Watch" (send `{type:'join',conversationId}` then load history) and "Take over" → `POST .../takeover`.
- **Conversation pane**: on select, `fetchChatbot('/conversations/{id}/messages?limit=100')` for history, `{type:'join'}` for live frames. Renders roles user/bot/agent/system with distinct styles. Input box (enabled only when `status==='HUMAN' && assignedToMe`) sends `{type:'message', conversationId, content}`; typing events debounced 2s. "End conversation" button → `POST .../end`.
- `handleFrame`: `message` → append if pane open; `state_change` → refresh lists + pane status; `queue_update` → refetch queue; `typing` → transient indicator.
- Audit strip: `escalationReason`, `assignedAgentId`, timestamps from the conversation row.

- [ ] **Step 3: Wire route + nav + env**

`App.tsx`: `<Route path="/chat-inbox" element={<ChatInboxPage {...pageProps} />} />`, `PATH_LABELS['chat-inbox'] = 'Chat Inbox'`. Sidebar item "Chat Inbox" visible to every admin role (SUPPORT included). Document `VITE_CHATBOT_URL` in the admin-web README or `.env.example`.

- [ ] **Step 4: Verify**

Run chatbot + api + admin dev servers. As a SUPPORT admin: punch in, open a user chat (via widget after Task 14, or seed a PENDING_HUMAN conversation via SQL), claim it, exchange messages, end it. Confirm queue badge updates live.
Run: `pnpm typecheck && pnpm --filter @tryme/admin build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/admin-web pnpm-lock.yaml
git commit -m "feat(admin-web): chat inbox — duty, queue, claim/takeover, live conversation pane"
```

---

### Task 14: catalogues-web — chat widget

**Files:**
- Create: `apps/catalogues-web/src/components/chat-widget.tsx`
- Modify: `apps/catalogues-web/src/app/(app)/layout.tsx` (mount widget)
- Modify: `.env.example` (+ `NEXT_PUBLIC_CHATBOT_URL`)

**Interfaces:**
- Consumes: chatbot `POST /ws-ticket` (user Bearer from `access_token` cookie), `/ws?ticket=`, `GET /conversations/:id/messages`; `WsClientFrameT`/`WsServerFrameT` from `@tryme/types`; `C` tokens.
- Produces: `<ChatWidget />` — self-contained client component.

- [ ] **Step 1: Implement widget**

`apps/catalogues-web/src/components/chat-widget.tsx` — client component (`'use client'`). Behavior spec (final logic, markup per design tokens):

```tsx
'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessageT, WsServerFrameT } from '@tryme/types';
import { C, grad } from './tokens';

const CHATBOT_URL = process.env.NEXT_PUBLIC_CHATBOT_URL || 'http://localhost:4200';

function accessToken(): string | undefined {
  // same cookie the app auth uses (apps/catalogues-web/src/lib/api.ts pattern)
  return document.cookie
    .split('; ')
    .find((c) => c.startsWith('access_token='))
    ?.split('=')[1];
}

export function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<'BOT' | 'PENDING_HUMAN' | 'HUMAN' | 'CLOSED'>('BOT');
  const [messages, setMessages] = useState<ChatMessageT[]>([]);
  const [typing, setTyping] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const wsRef = useRef<WebSocket | null>(null);
  const convRef = useRef<string | null>(null);

  const connect = useCallback(async () => {
    const token = accessToken();
    if (!token) return;
    const tRes = await fetch(`${CHATBOT_URL}/ws-ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    if (!tRes.ok) return;
    const { ticket } = await tRes.json();
    const ws = new WebSocket(`${CHATBOT_URL.replace(/^http/, 'ws')}/ws?ticket=${ticket}`);
    ws.onmessage = async (ev) => {
      const f = JSON.parse(ev.data) as WsServerFrameT;
      if (f.type === 'ready') {
        convRef.current = f.conversationId;
        setStatus(f.status);
        const h = await fetch(
          `${CHATBOT_URL}/conversations/${f.conversationId}/messages?limit=50`,
          { headers: { authorization: `Bearer ${accessToken()}` } },
        );
        if (h.ok) setMessages((await h.json()).messages);
      } else if (f.type === 'message') {
        setTyping(null);
        setMessages((m) => [...m, f.message]);
      } else if (f.type === 'state_change') {
        setStatus(f.status);
        if (f.status === 'CLOSED') convRef.current = null;
      } else if (f.type === 'typing' && f.role !== 'user') {
        setTyping(f.role);
        setTimeout(() => setTyping(null), 4000);
      }
    };
    ws.onclose = () => {
      wsRef.current = null; // reconnect on next open; history refetched via ready
    };
    wsRef.current = ws;
  }, []);

  useEffect(() => {
    if (open && !wsRef.current) void connect();
  }, [open, connect]);

  function send() {
    const content = input.trim();
    if (!content || !wsRef.current || status === 'CLOSED') return;
    wsRef.current.send(JSON.stringify({ type: 'message', content }));
    setInput('');
  }
  function talkToHuman() {
    wsRef.current?.send(JSON.stringify({ type: 'escalate' }));
  }

  // Render:
  // - floating bubble button (bottom-right, background: grad) toggling `open`
  // - panel: header ("Support", status line — BOT: "AI assistant" /
  //   PENDING_HUMAN: "Connecting you to a human…" / HUMAN: "Live agent" /
  //   CLOSED: "Conversation ended" + "Start new chat" button that resets
  //   state and reconnects), scrollable message list (user right-aligned pink,
  //   bot/agent left, system centered muted italic), typing indicator,
  //   input row + send button, "Talk to a human" link visible while status==='BOT'.
  // All colors from C.*; no raw hex.
  return (/* JSX per spec */ null);
}
```

Mount in `apps/catalogues-web/src/app/(app)/layout.tsx`:

```tsx
import { ChatWidget } from '@/components/chat-widget';
// inside the returned tree, after {children}:
        <ChatWidget />
```

Add to `.env.example`: `NEXT_PUBLIC_CHATBOT_URL=http://localhost:4200`.

Note: chatbot Fastify needs CORS for browser HTTP calls (`/ws-ticket`, history). Add `@fastify/cors` to `apps/chatbot` (`await app.register(cors, { origin: true, credentials: false })` — Bearer auth, no cookies) in `server.ts`; add dependency to package.json.

- [ ] **Step 2: Verify end-to-end**

Run infra + api + chatbot + web. Log in, open widget: bot answers a Q&A question (after ingesting one via admin); "Talk to a human" → PENDING_HUMAN → claim in admin inbox → two-way live chat → agent ends → widget shows closed + new-chat CTA.
Run: `pnpm typecheck && pnpm --filter @tryme/web build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/catalogues-web apps/chatbot .env.example pnpm-lock.yaml
git commit -m "feat(web): floating chat widget with ws streaming + human handoff"
```

---

### Task 15: Hardening — rate limit, metrics, env examples, docs

**Files:**
- Modify: `apps/chatbot/src/ws/gateway.ts` (rate limit)
- Modify: `packages/observability/src/metrics.ts` (chatbot metrics)
- Modify: `apps/chatbot/src/conversation/orchestrator.ts`, `escalation.ts` (instrument)
- Modify: `.env.production.example`, `docs/chatbot/chatbot-system-design.md`, `docs/progress.md`
- Test: `apps/chatbot/test/ratelimit.test.ts`

**Interfaces:**
- Produces metrics (all registered on the shared `register`):
  - `chatbotMessagesTotal` Counter `chatbot_messages_total{role}`
  - `chatbotEscalationsTotal` Counter `chatbot_escalations_total{reason}`
  - `chatbotFallbacksTotal` Counter `chatbot_fallbacks_total`
  - `chatbotBotTurnDuration` Histogram `chatbot_bot_turn_duration_seconds` buckets `[0.5,1,2,5,10,30]`
  - `chatbotActiveSockets` Gauge `chatbot_active_sockets{kind}` (user|agent)

- [ ] **Step 1: Rate limit (failing test first)**

`apps/chatbot/test/ratelimit.test.ts`: connect a user WS (as in `ws.test.ts`), send 11 `message` frames in a loop, expect an `error` frame with `code: 'RATE_LIMITED'` and only 10 user messages persisted.

Implement in `gateway.ts` before `orchestrator.handleUserMessage`:

```ts
          const rlKey = `chatbot:rl:${principal.userId}`;
          const n = await deps.redis.incr(rlKey);
          if (n === 1) await deps.redis.expire(rlKey, 30);
          if (n > 10) {
            socket.send(
              JSON.stringify({ type: 'error', code: 'RATE_LIMITED', message: 'slow down' }),
            );
            return;
          }
```

Run: `pnpm --filter @tryme/chatbot test -- ratelimit` → PASS.

- [ ] **Step 2: Metrics**

Append to `packages/observability/src/metrics.ts` (follow existing style):

```ts
// ── Chatbot metrics ──────────────────────────────────────────────────────────

export const chatbotMessagesTotal = new Counter({
  name: 'chatbot_messages_total',
  help: 'Chat messages persisted, by role',
  labelNames: ['role'] as const,
  registers: [register],
});

export const chatbotEscalationsTotal = new Counter({
  name: 'chatbot_escalations_total',
  help: 'Conversations escalated to a human, by reason',
  labelNames: ['reason'] as const,
  registers: [register],
});

export const chatbotFallbacksTotal = new Counter({
  name: 'chatbot_fallbacks_total',
  help: 'Bot low-confidence fallback replies',
  registers: [register],
});

export const chatbotBotTurnDuration = new Histogram({
  name: 'chatbot_bot_turn_duration_seconds',
  help: 'Bot turn latency (retrieval + tools + generation)',
  buckets: [0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

export const chatbotActiveSockets = new Gauge({
  name: 'chatbot_active_sockets',
  help: 'Open chatbot websockets',
  labelNames: ['kind'] as const,
  registers: [register],
});
```

Instrument: `appendMessage` callers already know role → increment in `appendMessage` (conversation/service.ts); `escalate()` → `chatbotEscalationsTotal.inc({reason})`; fallback branch in orchestrator → `chatbotFallbacksTotal.inc()`; time `runBotTurn` in orchestrator with `chatbotBotTurnDuration.startTimer()`; socket open/close in gateway → gauge inc/dec. Add `GET /metrics` route to chatbot server returning `register.metrics()` (same as api/dispatcher pattern).

- [ ] **Step 3: Env examples + docs**

- `.env.production.example`: add `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CHATBOT_PORT`, `CHATBOT_SERVICE_TOKEN`, `CHATBOT_URL`, `NEXT_PUBLIC_CHATBOT_URL`, `VITE_CHATBOT_URL`, and the tuning vars (`CHATBOT_TOP_K`, `CHATBOT_SIMILARITY_THRESHOLD`, `CHATBOT_FALLBACK_LIMIT`, `CHATBOT_IDLE_TIMEOUT_MIN`, `CHATBOT_MAX_TOOL_ITERATIONS`, `CHATBOT_MAX_TURNS`).
- `docs/chatbot/chatbot-system-design.md`: §5.6 — duty is a Redis SET `chatbot:agent:duty` (deviation note); mark doc "as built (v1)".
- `CLAUDE.md`: add `apps/chatbot` to Monorepo Layout table + `pnpm --filter @tryme/chatbot dev` command row.
- `docs/progress.md`: new dated entry — Done / Failed / Open Questions for this build.

- [ ] **Step 4: Full green check**

Run: `pnpm typecheck && pnpm lint && pnpm --filter @tryme/chatbot test && pnpm --filter @tryme/api test`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/chatbot packages/observability .env.production.example docs CLAUDE.md
git commit -m "feat(chatbot): rate limits, prometheus metrics, env + docs hardening"
```

---

## Self-Review Notes (done at plan time)

- **Spec coverage:** §5 data model → Task 1; §6 ingest → Task 4; §7 bot+tools+gate → Tasks 5/9; §8 escalation/claim/takeover/idle/agent-drop → Tasks 11/12; §9 WS+tickets+presence → Task 10; §10 sessions/history → Task 8; §11 admin workspace → Tasks 7/13; §12 API surface → Tasks 6/8/10/12; §13 widget → Task 14; §14 env → Tasks 3/6/15; §15 security (tool binding, ticket auth, admin double-check, rate limit, service token) → Tasks 9/10/8/15/4; §16 observability → Task 15; §17 failure modes → covered by lock/txn/fallback code paths; §18 phase order preserved.
- **Known judgment calls:** duty stored as Redis SET (documented deviation); token streaming deferred — bot replies arrive as whole `message` frames with a `typing` indicator during generation (the `token` frame type is reserved in `WsServerFrame` for a later streaming pass); intent-detection trigger deferred to v1.1 per spec amendment.
- **Verify against live code during execution:** column names in `schema.jobs`/`schema.userCredits`/`schema.users` (Task 9/11 notes), `createReactAgent` option name for the system prompt (Task 9 note), admin test harness helper names (Tasks 6/12).
