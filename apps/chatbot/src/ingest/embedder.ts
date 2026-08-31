import type { EmbedFn } from '../server.js';

const BATCH = 100;

// packages/db/src/schema/chatbot.ts locks chatbot_embeddings.embedding to vector(1536) —
// request that exact size via outputDimensionality (Matryoshka truncation) so no migration
// is needed if CHATBOT_EMBED_MODEL changes to another dimension-flexible Gemini model.
const EMBED_DIMENSIONS = 1536;

export function makeGeminiEmbedder(apiKey: string, model: string): EmbedFn {
  return async (texts) => {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const chunk = texts.slice(i, i + BATCH);
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`,
        {
          method: 'POST',
          headers: {
            'x-goog-api-key': apiKey,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            requests: chunk.map((text) => ({
              model: `models/${model}`,
              content: { parts: [{ text }] },
              outputDimensionality: EMBED_DIMENSIONS,
            })),
          }),
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!res.ok) throw new Error(`gemini embeddings ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as Record<string, unknown>;
      if (!Array.isArray(body?.embeddings))
        throw new Error('gemini embeddings: unexpected response shape');
      const embeddings = body.embeddings as { values: number[] }[];
      if (embeddings.length !== chunk.length)
        throw new Error(
          `gemini embeddings: expected ${chunk.length} results, got ${embeddings.length}`,
        );
      out.push(...embeddings.map((e) => e.values));
    }
    return out;
  };
}
