import { type DB, sql } from '@tryme/db';
import type { EmbedFn } from '../server.js';

export interface KnowledgeHit {
  qnaId: string;
  content: string;
  score: number;
  sim: number;
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
  `)) as { qna_id: string; content: string; sim: number }[];

  const txtRows = (await db.execute(sql`
    SELECT qna_id, content,
           ts_rank(content_tsv, websearch_to_tsquery('english', ${query})) AS rank
    FROM chatbot_embeddings
    WHERE content_tsv @@ websearch_to_tsquery('english', ${query})
    ORDER BY rank DESC
    LIMIT ${topK}
  `)) as { qna_id: string; content: string; rank: number }[];

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
    if (prev) {
      prev.score += add;
    } else {
      merged.set(r.qna_id, {
        qnaId: r.qna_id,
        content: r.content,
        score: add,
        sim: 0,
      });
    }
  });

  const hits = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, topK);
  const grounded = hits.some((h) => h.sim >= simThreshold);
  return { hits, grounded };
}
