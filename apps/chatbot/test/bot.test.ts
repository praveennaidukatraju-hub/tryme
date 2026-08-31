import { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import { FakeStreamingChatModel } from '@langchain/core/utils/testing';
import { schema } from '@tryme/db';
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
      // FakeStreamingChatModel@0.3.80's non-streaming _generate() reads tool_calls from
      // `chunks[0]`, not `responses[0]` (it only reads `.content` off `responses[0]`) — both
      // are needed to get a tool-calling AIMessage back from a plain `.invoke()`.
      chunks: [
        new AIMessageChunk({
          content: '',
          tool_calls: [{ name: 'getCredits', args: {}, id: 'call_1' }],
        }),
      ],
    });
    const genModel = new FakeStreamingChatModel({
      responses: [new AIMessage('You have 42 credits.')],
    });
    let genInputMessages: unknown[] = [];
    const originalInvoke = genModel.invoke.bind(genModel);
    genModel.invoke = (async (input: unknown, options?: unknown) => {
      genInputMessages = input as unknown[];
      return originalInvoke(input as never, options as never);
    }) as typeof genModel.invoke;

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

    // Prove the tool result actually reached genModel's input, not just that the
    // final text passed through — the hand-off, not only the exit.
    const genMessageContents = genInputMessages.map((m) =>
      typeof m === 'object' && m !== null && 'content' in m
        ? (m as { content: unknown }).content
        : undefined,
    );
    expect(
      genMessageContents.some(
        (c) => typeof c === 'string' && c.includes('Current credit balance: 42'),
      ),
    ).toBe(true);

    // Regression guard: the gen model is never bound to tools, so it must never receive
    // structured tool_use/tool_result blocks — Anthropic rejects those with "Requests
    // which include tool_use or tool_result blocks must define tools" when `tools` isn't
    // passed on that call. Tool results must be flattened to plain text instead.
    for (const m of genInputMessages as { _getType?: () => string; tool_calls?: unknown[] }[]) {
      expect(m._getType?.()).not.toBe('tool');
      expect(m.tool_calls ?? []).toEqual([]);
    }
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

  it('escalate sentinel missing the closing slash still escalates, not leaks as text', async () => {
    // Regression: a real free-tier model emitted `<escalate>` (no slash) in live testing —
    // the exact-match `<escalate/>` check missed it and leaked the tag into the user answer.
    const toolModel = new FakeStreamingChatModel({ responses: [new AIMessage('')] });
    const genModel = new FakeStreamingChatModel({
      responses: [new AIMessage('Sorry, let me get a human.\n<escalate>')],
    });
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
    expect(r.content).toBe('');
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
