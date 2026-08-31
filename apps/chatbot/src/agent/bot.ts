import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { ChatMessageT } from '@tryme/types';
import type { ChatbotDeps } from '../server.js';
import { makeAccountTools, makeSearchTool, newTurnCtx } from './tools.js';

export const FALLBACK_COPY =
  'I couldn\'t find an answer to that in our help articles. Could you rephrase, or tap "Talk to a human" and I\'ll connect you?';

const ROUTER_PROMPT = `You are the tool-routing step of the Tryme support assistant.
Decide which tools (if any) are needed to answer the user's latest message, then call them.
- Use searchKnowledge for policy/how-to/pricing questions.
- Use getCredits for balance/credits questions (e.g. "how many credits do I have", "what's my balance").
- Use getRecentJobs for ANY question about the user's own jobs, generations, orders, or history
  (e.g. "my recent jobs", "job history", "what have I submitted", "last generation", "my orders").
  Never answer these from memory — always call getRecentJobs first, even if you think you know
  the answer, since you have no real data about this user's account.
- For greetings, small talk, or anything no tool can help with, call no tools.`;

const GEN_SYSTEM_PROMPT = `You are the Tryme support assistant for logged-in users, writing the final reply.
- Only answer using the tool results provided below (if any). Never invent pricing, policy, or account data.
- Greetings and small talk with no tool results: reply naturally and briefly, do not escalate.
- If a substantive question can't be answered from the tool results, or the user asks for a human, a refund, or has a billing complaint, reply with exactly: <escalate/>
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
  // Tool results are flattened to plain text rather than passed as tool_use/tool_result
  // message blocks: the gen model is never bound to tools here, and providers like
  // Anthropic reject requests containing tool_use/tool_result blocks with no `tools`
  // param on that call ("Requests which include tool_use or tool_result blocks must
  // define tools"). Plain text is also provider-agnostic when tool/gen models differ.
  const toolResultsBlock =
    toolMessages.length > 0
      ? `Tool results:\n${toolMessages.map((m) => `[${m.name}] ${String(m.content)}`).join('\n')}`
      : '';
  const genMessages: BaseMessage[] = [
    new SystemMessage(GEN_SYSTEM_PROMPT),
    ...conversation,
    ...(toolResultsBlock ? [new SystemMessage(toolResultsBlock)] : []),
  ];
  const genResponse = await opts.genModel.invoke(genMessages, { signal: opts.signal });
  const text = extractText(genResponse);

  const meta = { toolCalls: turnCtx.toolCalls, qnaIds: [...new Set(turnCtx.qnaIds)] };

  if (!text.trim()) return { kind: 'fallback', content: FALLBACK_COPY, meta };
  // Weaker/free models don't always reproduce the exact self-closing `<escalate/>` sentinel
  // (observed live: a model emitted `<escalate>` with no slash) — match both forms so the
  // marker never leaks into the user-facing answer instead of triggering escalation.
  if (/<escalate\s*\/?\s*>/i.test(text)) return { kind: 'escalate', content: '', meta };

  const usedAccountTool = turnCtx.toolCalls.some(
    (n) => n === 'getCredits' || n === 'getRecentJobs',
  );
  if (turnCtx.searchCalled && !turnCtx.grounded && !usedAccountTool)
    return { kind: 'fallback', content: FALLBACK_COPY, meta };

  return { kind: 'answer', content: text, meta };
}
