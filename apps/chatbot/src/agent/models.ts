import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOpenAI } from '@langchain/openai';
import type { Env } from '../env.js';

export type ProviderKind = 'anthropic' | 'google' | 'openai-compatible';

export interface ModelConfig {
  provider: ProviderKind;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export function makeModel(cfg: ModelConfig): BaseChatModel {
  switch (cfg.provider) {
    case 'anthropic':
      return new ChatAnthropic({
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: 0.2,
        maxTokens: 1024,
      });
    case 'google':
      return new ChatGoogleGenerativeAI({
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: 0.2,
        maxOutputTokens: 1024,
      });
    case 'openai-compatible':
      if (!cfg.baseUrl) {
        throw new Error('openai-compatible provider requires a baseUrl');
      }
      return new ChatOpenAI({
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: 0.2,
        maxTokens: 1024,
        configuration: { baseURL: cfg.baseUrl },
      });
    default: {
      const exhaustive: never = cfg.provider;
      throw new Error(`unknown provider: ${exhaustive}`);
    }
  }
}

export function genModelConfig(env: Env): ModelConfig {
  const apiKey =
    env.CHATBOT_GEN_API_KEY ||
    (env.CHATBOT_GEN_PROVIDER === 'anthropic' ? env.ANTHROPIC_API_KEY : '');
  return {
    provider: env.CHATBOT_GEN_PROVIDER,
    model: env.CHATBOT_GEN_MODEL,
    apiKey,
    baseUrl: env.CHATBOT_GEN_BASE_URL || undefined,
  };
}

/**
 * Falls back to the generation config per-field when a CHATBOT_TOOL_* var is unset —
 * leaving all of them unset reproduces today's single-model behavior exactly.
 */
export function toolModelConfig(env: Env): ModelConfig {
  const gen = genModelConfig(env);
  return {
    provider: env.CHATBOT_TOOL_PROVIDER ?? gen.provider,
    model: env.CHATBOT_TOOL_MODEL ?? gen.model,
    apiKey: env.CHATBOT_TOOL_API_KEY || gen.apiKey,
    baseUrl: env.CHATBOT_TOOL_BASE_URL || gen.baseUrl,
  };
}
