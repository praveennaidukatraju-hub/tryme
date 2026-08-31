import { type StructuredToolInterface, tool } from '@langchain/core/tools';
import { type DB, eq, schema, sql } from '@tryme/db';
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
      const r = await searchKnowledge(
        db,
        embed,
        query,
        env.CHATBOT_TOP_K,
        env.CHATBOT_SIMILARITY_THRESHOLD,
      );
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
