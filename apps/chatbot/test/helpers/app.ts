import { AIMessage } from '@langchain/core/messages';
import { FakeStreamingChatModel } from '@langchain/core/utils/testing';
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
    ANTHROPIC_API_KEY: 'test-anthropic-key',
    GOOGLE_API_KEY: '',
    CHATBOT_PORT: 0,
    CHATBOT_SERVICE_TOKEN: 'test-service-token-123456',
    CHATBOT_EMBED_MODEL: 'gemini-embedding-2-preview',
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
    makeGenModel: () => new FakeStreamingChatModel({ responses: [new AIMessage('ok')] }),
    makeToolModel: () => new FakeStreamingChatModel({ responses: [new AIMessage('')] }),
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
