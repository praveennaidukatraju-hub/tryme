import { type DB, eq, schema } from '@tryme/db';
import type { Redis } from 'ioredis';
import { AppError } from '../lib/errors.js';
import type { EmbedFn } from '../server.js';

export async function runIngest(deps: {
  db: DB;
  redis: Redis;
  embed: EmbedFn;
  log: { info: (o: object, s: string) => void };
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
    const vectors = contents.length > 0 ? await deps.embed(contents) : [];
    await deps.db.transaction(async (tx) => {
      await tx.delete(schema.chatbotEmbeddings);
      if (rows.length > 0) {
        await tx.insert(schema.chatbotEmbeddings).values(
          rows.map((r, i) => ({
            qnaId: r.id,
            content: contents[i] ?? '',
            embedding: vectors[i] ?? ([] as number[]),
          })),
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
