# Chatbot Multi-Provider Model Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded `ChatAnthropic` model in `apps/chatbot/src/agent/bot.ts` with
env-var-driven, provider-agnostic model selection, and split the bot turn into two roles — a
tool-calling ("router") model and a text-generation model — so a small/local model (e.g. via
Ollama) can handle tool routing while a stronger model writes the actual answer.

**Architecture:** A new `apps/chatbot/src/agent/models.ts` factory builds a LangChain
`BaseChatModel` from a `ModelConfig` (`provider` + `model` + `apiKey` + optional `baseUrl`),
supporting `anthropic` (native), `google` (Google AI Studio / Gemini, native), and
`openai-compatible` (covers OpenRouter, NVIDIA NIM, Ollama, vLLM — anything with an OpenAI-shaped
`/v1/chat/completions` endpoint) via `ChatOpenAI` with a custom `baseURL`. `bot.ts`'s
`runBotTurn()` is rewritten from a single-model `createReactAgent` loop into a manual 3-step
flow: router model decides 0+ tool calls in one pass (no loop-back) → tools execute → generation
model writes the final reply from the tool results.

**Tech Stack:** `@langchain/anthropic` (existing), `@langchain/openai@0.3.17`,
`@langchain/google-genai@0.2.18` — both pinned to exact versions because their latest majors
require `@langchain/core@^1.x`, while this repo's `@langchain/langgraph`/`@langchain/anthropic`
are pinned to `@langchain/core@^0.3.40`; these two exact versions are the newest release of each
package still compatible with `@langchain/core@0.3.80` (confirmed via `npm view <pkg> peerDependencies`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-03-chatbot-multi-provider-models-design.md`. Read before
  each task.
- Scope for this pass: **env-var-driven configuration only**, dev/local usage. No DB-backed or
  admin-UI model switching (explicitly deferred in the spec).
- Leaving all `CHATBOT_TOOL_*` env vars unset must reproduce today's single-model behavior
  exactly (same provider/model/key/baseUrl for both roles) — no config changes required for
  existing deployments.
- Router model makes **one decision pass** per turn — 0+ tool calls in a single response, no
  loop-back to the router after seeing tool results. This bounds the router regardless of model
  quality (important since it may be a small/local model).
- Generation model is never given tool bindings — it only synthesizes from whatever the router
  already produced.
- `CHATBOT_MAX_TOOL_ITERATIONS` becomes an orphaned env var after this change (its only consumer,
  the `recursionLimit` passed to `createReactAgent`, is removed). Leave it declared in `env.ts` —
  harmless, avoids breaking anyone with it already set — do not delete it as part of this plan.
- No `console.log` — use `createLogger` (`@tryme/logger`) if logging is ever added (none of
  these tasks need new logging).
- ESM only, TypeScript 5.6, pnpm workspaces.
- Every task ends green on `pnpm --filter @tryme/chatbot test` and `pnpm typecheck`.

---

### Task 1: Provider-agnostic model factory (`agent/models.ts`) + env vars

**Files:**
- Modify: `apps/chatbot/package.json` (deps already added — verify only, see Step 1)
- Modify: `apps/chatbot/src/env.ts`
- Modify: `apps/chatbot/test/helpers/app.ts:10-31` (`testEnv()` — add new env fields)
- Create: `apps/chatbot/src/agent/models.ts`
- Test: `apps/chatbot/test/models.test.ts`

**Interfaces:**
- Produces (consumed by Task 2):

```ts
export type ProviderKind = 'anthropic' | 'google' | 'openai-compatible';

export interface ModelConfig {
  provider: ProviderKind;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export function makeModel(cfg: ModelConfig): BaseChatModel;
export function genModelConfig(env: Env): ModelConfig;
export function toolModelConfig(env: Env): ModelConfig;
```

- Consumes: `Env` type from `../env.js` (extended by this task).

- [ ] **Step 1: Verify the provider packages are installed at the pinned versions**

Run: `grep -A2 '"@langchain/google-genai"\|"@langchain/openai"' apps/chatbot/package.json`
Expected:
```
    "@langchain/google-genai": "0.2.18",
    "@langchain/langgraph": "^0.2.44",
    "@langchain/openai": "0.3.17",
```

If missing, install the exact pinned versions (do **not** use `^` ranges — their latest majors
require `@langchain/core@^1.x`, incompatible with this repo's `@langchain/core@0.3.80`):

```bash
cd apps/chatbot && pnpm add @langchain/openai@0.3.17 @langchain/google-genai@0.2.18
```

Run: `pnpm install && pnpm typecheck`
Expected: no peer-dependency warnings for these two packages; typecheck PASS.

- [ ] **Step 2: Extend `Env` with provider config vars**

In `apps/chatbot/src/env.ts`, replace the whole file with:

```ts
import { z } from 'zod';

const ProviderKind = z.enum(['anthropic', 'google', 'openai-compatible']);

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
  CHATBOT_GEN_PROVIDER: ProviderKind.default('anthropic'),
  CHATBOT_GEN_API_KEY: z.string().default(''),
  CHATBOT_GEN_BASE_URL: z.string().default(''),
  CHATBOT_TOOL_PROVIDER: ProviderKind.optional(),
  CHATBOT_TOOL_MODEL: z.string().optional(),
  CHATBOT_TOOL_API_KEY: z.string().optional(),
  CHATBOT_TOOL_BASE_URL: z.string().optional(),
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

- [ ] **Step 3: Add the new fields to the test env helper**

In `apps/chatbot/test/helpers/app.ts`, in `testEnv()` (currently lines 10-31), add the new
fields so existing tests keep passing unchanged:

```ts
export function testEnv(c: Containers, overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: c.pgUrl,
    REDIS_URL: c.redisUrl,
    JWT_SECRET: 'test-jwt-secret-test-jwt-secret',
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: 'test-anthropic-key',
    CHATBOT_PORT: 0,
    CHATBOT_SERVICE_TOKEN: 'test-service-token-123456',
    CHATBOT_EMBED_MODEL: 'text-embedding-3-small',
    CHATBOT_GEN_MODEL: 'claude-haiku-4-5-20251001',
    CHATBOT_GEN_PROVIDER: 'anthropic',
    CHATBOT_GEN_API_KEY: '',
    CHATBOT_GEN_BASE_URL: '',
    CHATBOT_TOP_K: 5,
    CHATBOT_SIMILARITY_THRESHOLD: 0.4,
    CHATBOT_FALLBACK_LIMIT: 2,
    CHATBOT_IDLE_TIMEOUT_MIN: 30,
    CHATBOT_MAX_TOOL_ITERATIONS: 4,
    CHATBOT_MAX_TURNS: 80,
    ...overrides,
  };
}
```

(`ANTHROPIC_API_KEY` changed from `''` to `'test-anthropic-key'` so the anthropic-fallback test
in Step 5 below has a non-empty value to assert against; `CHATBOT_TOOL_*` fields are intentionally
left undefined here — they stay optional and tests override them per-case via `overrides`.)

- [ ] **Step 4: Write the failing tests**

Create `apps/chatbot/test/models.test.ts`:

```ts
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOpenAI } from '@langchain/openai';
import { describe, expect, it } from 'vitest';
import { genModelConfig, makeModel, toolModelConfig } from '../src/agent/models.js';
import { testEnv } from './helpers/app.js';
import type { Containers } from './helpers/containers.js';

// models.ts is pure config/factory logic — no DB or Redis needed, so we don't
// spin up real containers, just satisfy the Containers shape testEnv() expects.
function fakeContainers(): Containers {
  return { pgUrl: 'postgres://unused', redisUrl: 'redis://unused', stop: async () => {} };
}

describe('genModelConfig', () => {
  it('defaults to anthropic provider using ANTHROPIC_API_KEY when CHATBOT_GEN_API_KEY unset', () => {
    const env = testEnv(fakeContainers());
    const cfg = genModelConfig(env);
    expect(cfg).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      apiKey: 'test-anthropic-key',
      baseUrl: undefined,
    });
  });

  it('prefers CHATBOT_GEN_API_KEY over ANTHROPIC_API_KEY when set', () => {
    const env = testEnv(fakeContainers(), { CHATBOT_GEN_API_KEY: 'explicit-key' });
    expect(genModelConfig(env).apiKey).toBe('explicit-key');
  });

  it('carries baseUrl through for openai-compatible provider', () => {
    const env = testEnv(fakeContainers(), {
      CHATBOT_GEN_PROVIDER: 'openai-compatible',
      CHATBOT_GEN_MODEL: 'anthropic/claude-3.5-sonnet',
      CHATBOT_GEN_API_KEY: 'sk-or-x',
      CHATBOT_GEN_BASE_URL: 'https://openrouter.ai/api/v1',
    });
    expect(genModelConfig(env)).toEqual({
      provider: 'openai-compatible',
      model: 'anthropic/claude-3.5-sonnet',
      apiKey: 'sk-or-x',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
  });
});

describe('toolModelConfig', () => {
  it('falls back entirely to gen config when no TOOL_* vars are set', () => {
    const env = testEnv(fakeContainers());
    expect(toolModelConfig(env)).toEqual(genModelConfig(env));
  });

  it('overrides only the fields that are set, per-field', () => {
    const env = testEnv(fakeContainers(), {
      CHATBOT_TOOL_PROVIDER: 'openai-compatible',
      CHATBOT_TOOL_MODEL: 'qwen2.5:7b',
      CHATBOT_TOOL_API_KEY: 'ollama',
      CHATBOT_TOOL_BASE_URL: 'http://localhost:11434/v1',
    });
    expect(toolModelConfig(env)).toEqual({
      provider: 'openai-compatible',
      model: 'qwen2.5:7b',
      apiKey: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
    });
  });

  it('unset TOOL_MODEL alone still falls back to gen model, keeping gen provider', () => {
    const env = testEnv(fakeContainers(), { CHATBOT_TOOL_API_KEY: 'only-key-set' });
    const cfg = toolModelConfig(env);
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.model).toBe('claude-haiku-4-5-20251001');
    expect(cfg.apiKey).toBe('only-key-set');
  });
});

describe('makeModel', () => {
  it('returns a ChatAnthropic instance for provider anthropic', () => {
    const m = makeModel({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'x' });
    expect(m).toBeInstanceOf(ChatAnthropic);
  });

  it('returns a ChatGoogleGenerativeAI instance for provider google', () => {
    const m = makeModel({ provider: 'google', model: 'gemini-1.5-flash', apiKey: 'x' });
    expect(m).toBeInstanceOf(ChatGoogleGenerativeAI);
  });

  it('returns a ChatOpenAI instance for provider openai-compatible with a baseUrl', () => {
    const m = makeModel({
      provider: 'openai-compatible',
      model: 'anthropic/claude-3.5-sonnet',
      apiKey: 'x',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    expect(m).toBeInstanceOf(ChatOpenAI);
  });

  it('throws for openai-compatible with no baseUrl', () => {
    expect(() => makeModel({ provider: 'openai-compatible', model: 'x', apiKey: 'x' })).toThrow(
      /baseUrl/,
    );
  });
});
```

Run: `pnpm --filter @tryme/chatbot test -- models`
Expected: FAIL — `../src/agent/models.js` module not found.

- [ ] **Step 5: Implement `agent/models.ts`**

Create `apps/chatbot/src/agent/models.ts`:

```ts
import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOpenAI } from '@langchain/openai';
import type { Env } from '../env.js';

export type ProviderKind = 'anthropic' | 'google' | 'openai-compatible';

export interface ModelConfig {
  provider: ProviderKind;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export function makeModel(cfg: ModelConfig): BaseChatModel {
  switch (cfg.provider) {
    case 'anthropic':
      return new ChatAnthropic({
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: 0.2,
        maxTokens: 1024,
      });
    case 'google':
      return new ChatGoogleGenerativeAI({
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: 0.2,
        maxOutputTokens: 1024,
      });
    case 'openai-compatible':
      if (!cfg.baseUrl) {
        throw new Error('openai-compatible provider requires a baseUrl');
      }
      return new ChatOpenAI({
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: 0.2,
        maxTokens: 1024,
        configuration: { baseURL: cfg.baseUrl },
      });
    default: {
      const exhaustive: never = cfg.provider;
      throw new Error(`unknown provider: ${exhaustive}`);
    }
  }
}

export function genModelConfig(env: Env): ModelConfig {
  const apiKey =
    env.CHATBOT_GEN_API_KEY ||
    (env.CHATBOT_GEN_PROVIDER === 'anthropic' ? env.ANTHROPIC_API_KEY : '');
  return {
    provider: env.CHATBOT_GEN_PROVIDER,
    model: env.CHATBOT_GEN_MODEL,
    apiKey,
    baseUrl: env.CHATBOT_GEN_BASE_URL || undefined,
  };
}

/**
 * Falls back to the generation config per-field when a CHATBOT_TOOL_* var is unset —
 * leaving all of them unset reproduces today's single-model behavior exactly.
 */
export function toolModelConfig(env: Env): ModelConfig {
  const gen = genModelConfig(env);
  return {
    provider: env.CHATBOT_TOOL_PROVIDER ?? gen.provider,
    model: env.CHATBOT_TOOL_MODEL ?? gen.model,
    apiKey: env.CHATBOT_TOOL_API_KEY || gen.apiKey,
    baseUrl: env.CHATBOT_TOOL_BASE_URL || gen.baseUrl,
  };
}
```

- [ ] **Step 6: Run tests, verify pass**

Run: `pnpm --filter @tryme/chatbot test -- models`
Expected: PASS (10 tests: 3 `genModelConfig` + 3 `toolModelConfig` + 4 `makeModel`).

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/chatbot/package.json apps/chatbot/src/env.ts apps/chatbot/src/agent/models.ts apps/chatbot/test/models.test.ts apps/chatbot/test/helpers/app.ts pnpm-lock.yaml
git commit -m "feat(chatbot): provider-agnostic model factory (anthropic/google/openai-compatible)"
```

---

### Task 2: Split `runBotTurn` into router + generation models

**Files:**
- Modify: `apps/chatbot/src/agent/bot.ts` (full rewrite)
- Modify: `apps/chatbot/src/server.ts:1-27` (`ChatbotDeps` — replace `makeModel` with
  `makeGenModel`/`makeToolModel`)
- Modify: `apps/chatbot/src/conversation/orchestrator.ts:58-66` (pass both models into
  `runBotTurn`)
- Modify: `apps/chatbot/src/index.ts` (wire `makeGenModel`/`makeToolModel` from
  `genModelConfig`/`toolModelConfig`)
- Modify: `apps/chatbot/test/helpers/app.ts` (`buildTestApp()` — replace `makeModel` default)
- Modify: `apps/chatbot/test/bot.test.ts` (adapt existing 3 tests + add hand-off test)

**Interfaces:**
- Consumes: `makeModel`, `genModelConfig`, `toolModelConfig` from `../agent/models.js` (Task 1);
  `makeAccountTools`, `makeSearchTool`, `newTurnCtx` from `./tools.js` (unchanged).
- Produces:

```ts
export interface BotResult {
  kind: 'answer' | 'fallback' | 'escalate';
  content: string;
  meta: { toolCalls: string[]; qnaIds: string[] };
}
export async function runBotTurn(opts: {
  deps: ChatbotDeps;
  toolModel: BaseChatModel;
  genModel: BaseChatModel;
  userId: string;
  convId: string;
  history: ChatMessageT[];
  userMessage: string;
  signal: AbortSignal;
}): Promise<BotResult>;
export const FALLBACK_COPY: string;
```

`ChatbotDeps` gains `makeGenModel: () => BaseChatModel` and `makeToolModel: () => BaseChatModel`,
replacing the single `makeModel: () => BaseChatModel`.

- [ ] **Step 1: Write the failing tests**

Replace `apps/chatbot/test/bot.test.ts` entirely:

```ts
import { schema } from '@tryme/db';
import { AIMessage } from '@langchain/core/messages';
import { FakeStreamingChatModel } from '@langchain/core/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runBotTurn } from '../src/agent/bot.js';
import { makeAccountTools } from '../src/agent/tools.js';
import { buildTestApp } from './helpers/app.js';
import { type Containers, startContainers } from './helpers/containers.js';

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
    const credits = tools.find((x) => x.name === 'getCredits');
    if (!credits) throw new Error('getCredits tool not found');
    expect(JSON.stringify(credits.schema)).not.toContain('userId');
    const out = await credits.invoke({});
    expect(String(out)).toContain('42');
  });

  it('router calls no tools, generation model answers directly', async () => {
    // router response has no tool_calls -> empty array is the "call nothing" case
    const toolModel = new FakeStreamingChatModel({ responses: [new AIMessage('')] });
    const genModel = new FakeStreamingChatModel({
      responses: [new AIMessage('You get 1 credit per try-on.')],
    });
    const r = await runBotTurn({
      deps: t.deps,
      toolModel,
      genModel,
      userId,
      convId: crypto.randomUUID(),
      history: [],
      userMessage: 'how many credits per job?',
      signal: new AbortController().signal,
    });
    expect(r.kind).toBe('answer');
    expect(r.content).toContain('1 credit');
    expect(r.meta.toolCalls).toEqual([]);
  });

  it('router calls getCredits, generation model synthesizes from the tool result', async () => {
    const toolModel = new FakeStreamingChatModel({
      responses: [
        new AIMessage({
          content: '',
          tool_calls: [{ name: 'getCredits', args: {}, id: 'call_1' }],
        }),
      ],
    });
    const genModel = new FakeStreamingChatModel({
      responses: [new AIMessage('You have 42 credits.')],
    });
    const r = await runBotTurn({
      deps: t.deps,
      toolModel,
      genModel,
      userId,
      convId: crypto.randomUUID(),
      history: [],
      userMessage: 'how many credits do I have?',
      signal: new AbortController().signal,
    });
    expect(r.kind).toBe('answer');
    expect(r.content).toBe('You have 42 credits.');
    expect(r.meta.toolCalls).toEqual(['getCredits']);
  });

  it('escalate sentinel from generation model routes to escalate', async () => {
    const toolModel = new FakeStreamingChatModel({ responses: [new AIMessage('')] });
    const genModel = new FakeStreamingChatModel({ responses: [new AIMessage('<escalate/>')] });
    const r = await runBotTurn({
      deps: t.deps,
      toolModel,
      genModel,
      userId,
      convId: crypto.randomUUID(),
      history: [],
      userMessage: 'I demand a refund now',
      signal: new AbortController().signal,
    });
    expect(r.kind).toBe('escalate');
  });

  it('empty generation output falls back rather than answering blank', async () => {
    const toolModel = new FakeStreamingChatModel({ responses: [new AIMessage('')] });
    const genModel = new FakeStreamingChatModel({ responses: [new AIMessage('')] });
    const r = await runBotTurn({
      deps: t.deps,
      toolModel,
      genModel,
      userId,
      convId: crypto.randomUUID(),
      history: [],
      userMessage: 'anything',
      signal: new AbortController().signal,
    });
    expect(r.kind).toBe('fallback');
  });
});
```

Run: `pnpm --filter @tryme/chatbot test -- bot`
Expected: FAIL — `runBotTurn` still has the old single-`model` signature.

- [ ] **Step 2: Rewrite `agent/bot.ts`**

Replace `apps/chatbot/src/agent/bot.ts` entirely:

```ts
import type { ChatMessageT } from '@tryme/types';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { ChatbotDeps } from '../server.js';
import { makeAccountTools, makeSearchTool, newTurnCtx } from './tools.js';

export const FALLBACK_COPY =
  'I couldn\'t find an answer to that in our help articles. Could you rephrase, or tap "Talk to a human" and I\'ll connect you?';

const ROUTER_PROMPT = `You are the tool-routing step of the Tryme support assistant.
Decide which tools (if any) are needed to answer the user's latest message, then call them.
- Use searchKnowledge for policy/how-to/pricing questions.
- Use getCredits / getRecentJobs for questions about the current user's own account.
- For greetings, small talk, or anything no tool can help with, call no tools.`;

const GEN_SYSTEM_PROMPT = `You are the Tryme support assistant for logged-in users, writing the final reply.
- Only answer using the tool results provided below (if any). Never invent pricing, policy, or account data.
- If the tool results don't contain enough information to answer, or the user asks for a human, a refund, or has a billing complaint, reply with exactly: <escalate/>
- Keep answers short and friendly.`;

export interface BotResult {
  kind: 'answer' | 'fallback' | 'escalate';
  content: string;
  meta: { toolCalls: string[]; qnaIds: string[] };
}

function toLc(history: ChatMessageT[]): BaseMessage[] {
  return history
    .filter((m) => m.role === 'user' || m.role === 'bot')
    .map((m) => (m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content)));
}

function extractText(msg: BaseMessage): string {
  return typeof msg.content === 'string'
    ? msg.content
    : msg.content
        .map((c: { type?: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : ''))
        .join('');
}

export async function runBotTurn(opts: {
  deps: ChatbotDeps;
  toolModel: BaseChatModel;
  genModel: BaseChatModel;
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

  const conversation = [...toLc(opts.history), new HumanMessage(opts.userMessage)];

  // --- router step: one decision pass, no loop-back ---
  if (!opts.toolModel.bindTools) {
    throw new Error('configured tool model does not support tool calling (bindTools missing)');
  }
  const boundToolModel = opts.toolModel.bindTools(tools);
  const routerResponse = await boundToolModel.invoke(
    [new SystemMessage(ROUTER_PROMPT), ...conversation],
    { signal: opts.signal },
  );

  const toolCalls = routerResponse.tool_calls ?? [];
  const toolMessages: ToolMessage[] = [];
  for (const call of toolCalls) {
    turnCtx.toolCalls.push(call.name);
    const target = tools.find((t) => t.name === call.name);
    const output = target ? await target.invoke(call.args) : `Unknown tool: ${call.name}`;
    toolMessages.push(
      new ToolMessage({
        content: String(output),
        tool_call_id: call.id ?? call.name,
        name: call.name,
      }),
    );
  }

  // --- generation step: writes the final reply; never calls tools itself ---
  const genMessages: BaseMessage[] = [
    new SystemMessage(GEN_SYSTEM_PROMPT),
    ...conversation,
    ...(toolCalls.length > 0 ? [routerResponse, ...toolMessages] : []),
  ];
  const genResponse = await opts.genModel.invoke(genMessages, { signal: opts.signal });
  const text = extractText(genResponse);

  const meta = { toolCalls: turnCtx.toolCalls, qnaIds: [...new Set(turnCtx.qnaIds)] };

  if (!text.trim()) return { kind: 'fallback', content: FALLBACK_COPY, meta };
  if (text.includes('<escalate/>')) return { kind: 'escalate', content: '', meta };

  const usedAccountTool = turnCtx.toolCalls.some(
    (n) => n === 'getCredits' || n === 'getRecentJobs',
  );
  if (turnCtx.searchCalled && !turnCtx.grounded && !usedAccountTool)
    return { kind: 'fallback', content: FALLBACK_COPY, meta };

  return { kind: 'answer', content: text, meta };
}
```

Note: `makeProdModel` and the `createReactAgent`/`@langchain/langgraph/prebuilt` import are
gone — model construction now lives entirely in `agent/models.ts` (Task 1), called from
`index.ts` (Step 5 below).

- [ ] **Step 3: Update `ChatbotDeps` in `server.ts`**

In `apps/chatbot/src/server.ts`, change:

```ts
  makeModel: () => BaseChatModel;
```

to:

```ts
  makeGenModel: () => BaseChatModel;
  makeToolModel: () => BaseChatModel;
```

- [ ] **Step 4: Update the orchestrator call site**

In `apps/chatbot/src/conversation/orchestrator.ts`, change the `runBotTurn` call (currently
around lines 58-66):

```ts
        const result = await runBotTurn({
          deps,
          model: deps.makeModel(),
          userId,
          convId,
          history: history.slice(0, -1),
          userMessage: content,
          signal: ac.signal,
        });
```

to:

```ts
        const result = await runBotTurn({
          deps,
          toolModel: deps.makeToolModel(),
          genModel: deps.makeGenModel(),
          userId,
          convId,
          history: history.slice(0, -1),
          userMessage: content,
          signal: ac.signal,
        });
```

- [ ] **Step 5: Wire production model construction in `index.ts`**

In `apps/chatbot/src/index.ts`, replace the `makeProdModel` import and both `makeModel: () =>
makeProdModel(env)` sites:

```ts
import { createLogger } from '@tryme/logger';
import { genModelConfig, makeModel, toolModelConfig } from './agent/models.js';
import { runChatSweeper } from './conversation/sweeper.js';
import { loadEnv } from './env.js';
import { makeOpenAiEmbedder } from './ingest/embedder.js';
import { makeDb } from './lib/db.js';
import { makeRedis } from './lib/redis.js';
import { buildChatbotServer } from './server.js';

const log = createLogger('chatbot');

async function main(): Promise<void> {
  const env = loadEnv();
  const { db, close: closeDb } = makeDb(env);
  const { main: redis, pub, sub, close: closeRedis } = makeRedis(env);
  const embed = makeOpenAiEmbedder(env.OPENAI_API_KEY, env.CHATBOT_EMBED_MODEL);

  const deps = {
    env,
    db,
    redis,
    pub,
    sub,
    embed,
    makeGenModel: () => makeModel(genModelConfig(env)),
    makeToolModel: () => makeModel(toolModelConfig(env)),
    log,
  };

  const app = await buildChatbotServer(deps);
  await app.listen({ port: env.CHATBOT_PORT, host: '0.0.0.0' });
  log.info({ port: env.CHATBOT_PORT }, 'chatbot ready');

  const sweepInterval = setInterval(() => {
    void runChatSweeper(deps).catch((err) => log.error({ err }, 'sweeper failed'));
  }, 60_000);

  async function shutdown(signal: string) {
    log.info({ signal }, 'shutting down chatbot');
    clearInterval(sweepInterval);
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

(This also fixes a pre-existing duplication in `index.ts` where `deps` was built twice — once
inline for `buildChatbotServer` and again for the sweeper. Now built once and reused, which is
required anyway since `makeGenModel`/`makeToolModel` read the same `env` closure either way.)

- [ ] **Step 6: Update the test app helper**

In `apps/chatbot/test/helpers/app.ts`, replace the `makeModel` default in `buildTestApp()`:

```ts
    makeModel: () => new FakeStreamingChatModel({ responses: [new AIMessage('ok')] }),
```

with:

```ts
    makeGenModel: () => new FakeStreamingChatModel({ responses: [new AIMessage('ok')] }),
    makeToolModel: () => new FakeStreamingChatModel({ responses: [new AIMessage('')] }),
```

- [ ] **Step 7: Run tests, verify pass**

Run: `pnpm --filter @tryme/chatbot test`
Expected: ALL PASS — this exercises every test file, since `server.ts`'s `ChatbotDeps` type
change and `test/helpers/app.ts` changes affect every test that calls `buildTestApp()`.

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/chatbot/src/agent/bot.ts apps/chatbot/src/server.ts apps/chatbot/src/conversation/orchestrator.ts apps/chatbot/src/index.ts apps/chatbot/test/helpers/app.ts apps/chatbot/test/bot.test.ts
git commit -m "feat(chatbot): split bot turn into router (tool-calling) + generation models"
```

---

### Task 3: Env examples + docs

**Files:**
- Modify: `.env.production.example`
- Modify: `docs/chatbot/chatbot-system-design.md` (§7 Bot Agent section)
- Modify: `docs/progress.md`

**Interfaces:**
- None — documentation only, no code.

- [ ] **Step 1: Update `.env.production.example`**

Find the existing chatbot env block (added in the original chatbot build — look for
`CHATBOT_GEN_MODEL`) and replace/extend it:

```
CHATBOT_GEN_PROVIDER=anthropic
CHATBOT_GEN_MODEL=claude-haiku-4-5-20251001
CHATBOT_GEN_API_KEY=
CHATBOT_GEN_BASE_URL=
# ANTHROPIC_API_KEY is used as a fallback for CHATBOT_GEN_API_KEY when provider=anthropic

CHATBOT_TOOL_PROVIDER=
CHATBOT_TOOL_MODEL=
CHATBOT_TOOL_API_KEY=
CHATBOT_TOOL_BASE_URL=
# Leave all CHATBOT_TOOL_* blank to use the same model for tool-calling and generation.
# Example split: strong model for generation, small local model for tool routing —
#   CHATBOT_TOOL_PROVIDER=openai-compatible
#   CHATBOT_TOOL_MODEL=qwen2.5:7b
#   CHATBOT_TOOL_API_KEY=ollama
#   CHATBOT_TOOL_BASE_URL=http://localhost:11434/v1
```

- [ ] **Step 2: Update the system design doc**

In `docs/chatbot/chatbot-system-design.md`, §7 ("Bot Agent — LangGraph"), add a short note
after the existing graph description (do not rewrite the whole section — this is an addendum):

```markdown
### 7.4 Multi-provider model selection (added post-v1)

Tool-calling and generation use separately configurable models — see
`docs/superpowers/specs/2026-07-03-chatbot-multi-provider-models-design.md`. Router model
makes one tool-decision pass per turn (no loop-back); generation model writes the final reply
from the tool results and applies the escalate/grounding gate. Supports Anthropic, Google AI
Studio, and any OpenAI-compatible host (OpenRouter, NVIDIA NIM, Ollama, vLLM) via
`CHATBOT_GEN_*` / `CHATBOT_TOOL_*` env vars — see `.env.production.example`.
```

- [ ] **Step 3: Add a `docs/progress.md` entry**

Add a new dated entry at the top of the log (above the existing `2026-07-03` chatbot entry):

```markdown
## 2026-07-03 — Chatbot Multi-Provider Model Selection

Implemented per `docs/superpowers/plans/2026-07-03-chatbot-multi-provider-models.md`.

### Done
- New `apps/chatbot/src/agent/models.ts` — provider-agnostic `makeModel()` factory
  (`anthropic` / `google` / `openai-compatible`), env-var config resolution with per-field
  fallback (`genModelConfig`/`toolModelConfig`).
- `runBotTurn()` split into a router (tool-calling) model and a generation model — router
  makes one tool-decision pass (no loop), generation model synthesizes the final reply and
  applies the existing escalate/grounding gate. `createReactAgent` no longer used.
- Pinned `@langchain/openai@0.3.17` and `@langchain/google-genai@0.2.18` (not `^` ranges) —
  their latest majors require `@langchain/core@^1.x`, incompatible with this repo's
  `@langchain/core@0.3.80` (pinned via `@langchain/langgraph`/`@langchain/anthropic`).
- Fixed a pre-existing duplication in `apps/chatbot/src/index.ts` where `deps` was
  constructed twice (once for the server, once for the sweeper) — now built once.

### Failed / Not Done
- None.

### Open Questions / Decisions
- Admin-configurable (DB-backed, no-redeploy) model switching is explicitly deferred —
  decide later per user.
- `CHATBOT_MAX_TOOL_ITERATIONS` is now an orphaned env var (its only consumer, the
  `recursionLimit` on the old `createReactAgent` call, was removed). Left declared in
  `env.ts` for backward compatibility; not wired to anything.
```

- [ ] **Step 4: Final verification**

Run: `pnpm typecheck && pnpm --filter @tryme/chatbot test`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add .env.production.example docs/chatbot/chatbot-system-design.md docs/progress.md
git commit -m "docs: multi-provider model selection env examples + design doc addendum"
```

---

## Self-Review Notes (done at plan time)

- **Spec coverage:** provider-agnostic factory (anthropic/google/openai-compatible) → Task 1;
  env vars with per-field fallback → Task 1; split router/generation models, single-pass router,
  no tool bindings on generation model → Task 2; new deps pinned to core-0.3.x-compatible
  versions → Task 1 Step 1; docs/env examples → Task 3. All spec sections covered.
- **Verified against installed packages, not guessed:** `@langchain/openai@0.3.17`'s
  `ChatOpenAIFields.configuration?: ClientOptions & LegacyOpenAIInput` (→ `baseURL` field) and
  `@langchain/google-genai@0.2.18`'s `ChatGoogleGenerativeAI` constructor (`apiKey`, `model`,
  `maxOutputTokens` — not `maxTokens`) were read directly from each package's installed
  `.d.ts` files, and `@langchain/core@0.3.80`'s `ToolCall = { name, args, id?, type? }` /
  `ToolMessage` constructor shape were likewise confirmed from source — not assumed.
- **Type consistency:** `BotResult`/`FALLBACK_COPY` unchanged from the original `bot.ts` (no
  downstream break in `orchestrator.ts`'s handling of `result.kind`/`result.meta`/
  `result.content`, which this plan does not touch). `ChatbotDeps.makeGenModel`/`makeToolModel`
  names match exactly between Task 2 Steps 3-6 and Task 1's `genModelConfig`/`toolModelConfig`/
  `makeModel` names from Task 1.
- **Known limitation carried from the spec:** no startup validation that the configured tool
  model actually supports tool calling — fails loudly at runtime (`bindTools` missing throws
  immediately; a model that has `bindTools` but is bad at using it will just produce wrong tool
  calls, caught by normal error handling upstream in the orchestrator).
