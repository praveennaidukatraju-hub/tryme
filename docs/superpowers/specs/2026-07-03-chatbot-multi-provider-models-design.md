# Chatbot Multi-Provider Model Selection — Design

Status: **approved**, ready for implementation plan.

## Purpose

`apps/chatbot/src/agent/bot.ts` currently hardcodes `ChatAnthropic` via `makeProdModel(env)` for
the entire bot turn — the same model both decides tool calls and writes the final answer. This
design replaces that with:

1. **Provider-agnostic model selection** — env-var driven, supporting Anthropic, Google AI
   Studio (Gemini), and any OpenAI-compatible host (OpenRouter, NVIDIA NIM, Ollama, vLLM, ...).
2. **Split roles** — a separate model for tool-calling ("router") vs text generation. This lets
   a small/cheap/local model (e.g. via Ollama) handle tool routing while a stronger model writes
   the actual support answer.

Scope for this pass: **local/dev configuration via env vars only**. Admin-configurable
runtime model switching (DB-backed, no-redeploy) is explicitly deferred — decide later.

## Architecture

Replace `createReactAgent`'s single-model ReAct loop with a manual 3-step flow, still inside
`runBotTurn()`:

```
START
  │
  ▼
[router node]  tool-model.bindTools(tools).invoke(history + userMessage)
  │
  ├─ zero tool calls ──────────────────────────────┐
  │                                                 │
  ▼ 1+ tool calls                                   │
[execute node]  run each tool call, collect         │
                ToolMessage results                 │
  │                                                 │
  ▼                                                 ▼
[generation node]  gen-model.invoke(history + userMessage + AIMessage(tool_calls) + ToolMessages)
  │
  ▼
apply existing gate: <escalate/> sentinel → escalate
                      searchCalled && !grounded && no account tool used → fallback
                      else → answer
END
```

Key property: the router makes **one decision pass** — it may request multiple tool calls in a
single response (parallel tool calls; most tool-calling models support this), but there is no
loop back to the router after seeing tool results. This bounds the router to exactly one call
regardless of model quality, which matters because the router may be a small/local model — no
risk of it looping badly or needing `CHATBOT_MAX_TOOL_ITERATIONS` on the router side.

If the router returns zero tool calls (e.g. a greeting), skip the execute step entirely and call
the generation model directly with no tool results — cheapest path, single generation call.

The generation model is **not** given tool bindings — it only synthesizes from whatever the
router already produced. It cannot call tools itself.

## Model Factory

New file `apps/chatbot/src/agent/models.ts`:

```ts
export type ProviderKind = 'anthropic' | 'google' | 'openai-compatible';

export interface ModelConfig {
  provider: ProviderKind;
  model: string;
  apiKey: string;
  baseUrl?: string; // only meaningful for 'openai-compatible'
}

export function makeModel(cfg: ModelConfig): BaseChatModel;
export function genModelConfig(env: Env): ModelConfig;
export function toolModelConfig(env: Env): ModelConfig; // falls back to gen config if TOOL_* unset
```

`makeModel` switches on `provider`:
- `anthropic` → `new ChatAnthropic({ apiKey, model, ... })` (unchanged from today)
- `google` → `new ChatGoogleGenerativeAI({ apiKey, model, ... })`
- `openai-compatible` → `new ChatOpenAI({ apiKey, model, configuration: { baseURL } })`

This covers OpenRouter, NVIDIA NIM, Ollama, vLLM, or any future OpenAI-compatible host through
the single `openai-compatible` kind — adding a new host is an env-var change, not a code change.

## Env Vars

```
CHATBOT_GEN_PROVIDER=anthropic|google|openai-compatible   (default: anthropic)
CHATBOT_GEN_MODEL=claude-haiku-4-5-20251001               (existing var, repurposed)
CHATBOT_GEN_API_KEY=...                                    (new; falls back to ANTHROPIC_API_KEY when provider=anthropic, for back-compat)
CHATBOT_GEN_BASE_URL=...                                   (only used when provider=openai-compatible)

CHATBOT_TOOL_PROVIDER=...   (optional; defaults to CHATBOT_GEN_PROVIDER)
CHATBOT_TOOL_MODEL=...      (optional; defaults to CHATBOT_GEN_MODEL)
CHATBOT_TOOL_API_KEY=...    (optional; defaults to CHATBOT_GEN_API_KEY)
CHATBOT_TOOL_BASE_URL=...   (optional; defaults to CHATBOT_GEN_BASE_URL)
```

Leaving all `CHATBOT_TOOL_*` unset reproduces today's behavior exactly — same model for both
roles, no config changes required for existing deployments.

Example — Claude for generation, local Ollama for tool routing:

```
CHATBOT_GEN_PROVIDER=anthropic
CHATBOT_GEN_MODEL=claude-haiku-4-5-20251001
ANTHROPIC_API_KEY=sk-ant-...

CHATBOT_TOOL_PROVIDER=openai-compatible
CHATBOT_TOOL_MODEL=qwen2.5:7b
CHATBOT_TOOL_API_KEY=ollama          # Ollama ignores the key but the client requires a non-empty string
CHATBOT_TOOL_BASE_URL=http://localhost:11434/v1
```

Example — OpenRouter for both roles:

```
CHATBOT_GEN_PROVIDER=openai-compatible
CHATBOT_GEN_MODEL=anthropic/claude-3.5-sonnet
CHATBOT_GEN_API_KEY=sk-or-...
CHATBOT_GEN_BASE_URL=https://openrouter.ai/api/v1
```

## New Dependencies

- `@langchain/openai` — covers OpenRouter, NVIDIA NIM, Ollama, vLLM via `openai-compatible`.
- `@langchain/google-genai` — Gemini via Google AI Studio.
- `@langchain/anthropic` — already installed, unchanged.

No dedicated Ollama package needed — its `/v1/chat/completions` endpoint is OpenAI-compatible.

**Risk flag (not a blocker):** small/local models are materially less reliable at structured
tool-calling than Claude/GPT-4/Gemini — wrong argument shapes, hallucinated tool names, or
declining to call a tool it should. Recommend a real tool-calling checkpoint (`qwen2.5`,
`llama3.1` tool-calling variants) rather than a tiny (≤3B) model. This is a runtime/prompt
tuning concern, not something the code needs to defend against beyond normal error handling.

## Changes to `bot.ts`

- `makeProdModel(env)` is removed; replaced by `makeModel(genModelConfig(env))` and
  `makeModel(toolModelConfig(env))`, called once per turn (or cached — implementation detail,
  not load-bearing since models are cheap to construct and stateless).
- `runBotTurn()` signature changes: takes `toolModel` and `genModel` instead of a single
  `model` parameter.
- `createReactAgent` import is removed. The router step becomes a direct
  `toolModel.bindTools(tools).invoke(messages)` call; the execute step manually runs each
  returned tool call (LangChain `ToolCall` → invoke the matching `StructuredToolInterface` →
  wrap result in a `ToolMessage`); the generation step is a plain
  `genModel.invoke([...messages, aiMessageWithToolCalls, ...toolMessages])`.
- `turnCtx` tracking (searchCalled/grounded/qnaIds/toolCalls) is populated during the execute
  step exactly as today — unaffected by the model split.
- The gate logic (escalate sentinel, grounding fallback) runs against the **generation model's**
  output text, unchanged.

## Test Impact

`apps/chatbot/test/bot.test.ts` updates:
- `runBotTurn` calls now pass `toolModel` and `genModel` separately (both `FakeListChatModel`
  or a fake supporting `.bindTools()`/tool-call responses for the router side).
- Existing three test cases (bound tools / no identity params, plain answer, escalate sentinel)
  still hold — just wired through two fakes instead of one.
- New test: router returns a tool call, generation model synthesizes from the tool result —
  verifies the hand-off between the two models works (tool result actually reaches the
  generation model's input messages).

`apps/chatbot/src/env.ts` gains the new vars (all optional with the fallback behavior described
above) — no test changes needed there beyond what `testEnv()` in `test/helpers/app.ts` already
provides (defaults keep working since new vars are optional).

## Out of Scope (explicitly deferred)

- Admin-configurable model switching (DB-backed, no-redeploy) — decide later, per user.
- Per-conversation or per-request model override.
- Automatic tool-calling-capability validation/startup check for the configured model — trusted
  to the env var, fails loudly at runtime if misconfigured (consistent with today's behavior).
- Embeddings provider swap — stays OpenAI `text-embedding-3-small` (Anthropic has no embeddings
  API; not part of this design).
