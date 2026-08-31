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
  GOOGLE_API_KEY: z.string().default(''),
  CHATBOT_PORT: z.coerce.number().default(4200),
  CHATBOT_SERVICE_TOKEN: z.string().min(16),
  CHATBOT_EMBED_MODEL: z.string().default('gemini-embedding-2-preview'),
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
