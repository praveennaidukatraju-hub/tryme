import { createLogger } from '@tryme/logger';
import { genModelConfig, makeModel, toolModelConfig } from './agent/models.js';
import { runChatSweeper } from './conversation/sweeper.js';
import { loadEnv } from './env.js';
import { makeGeminiEmbedder } from './ingest/embedder.js';
import { makeDb } from './lib/db.js';
import { makeRedis } from './lib/redis.js';
import { buildChatbotServer } from './server.js';

const log = createLogger('chatbot');

async function main(): Promise<void> {
  const env = loadEnv();
  const { db, close: closeDb } = makeDb(env);
  const { main: redis, pub, sub, close: closeRedis } = makeRedis(env);
  const embed = makeGeminiEmbedder(env.GOOGLE_API_KEY, env.CHATBOT_EMBED_MODEL);

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
