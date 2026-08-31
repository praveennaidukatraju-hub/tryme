import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOpenAI } from '@langchain/openai';
import { describe, expect, it } from 'vitest';
import { genModelConfig, makeModel, toolModelConfig } from '../src/agent/models.js';
import { testEnv } from './helpers/app.js';
import type { Containers } from './helpers/containers.js';

// models.ts is pure config/factory logic — no DB or Redis needed, so we don't
// spin up real containers, just satisfy the Containers shape testEnv() expects.
function fakeContainers(): Containers {
  return { pgUrl: 'postgres://unused', redisUrl: 'redis://unused', stop: async () => {} };
}

describe('genModelConfig', () => {
  it('defaults to anthropic provider using ANTHROPIC_API_KEY when CHATBOT_GEN_API_KEY unset', () => {
    const env = testEnv(fakeContainers());
    const cfg = genModelConfig(env);
    expect(cfg).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      apiKey: 'test-anthropic-key',
      baseUrl: undefined,
    });
  });

  it('prefers CHATBOT_GEN_API_KEY over ANTHROPIC_API_KEY when set', () => {
    const env = testEnv(fakeContainers(), { CHATBOT_GEN_API_KEY: 'explicit-key' });
    expect(genModelConfig(env).apiKey).toBe('explicit-key');
  });

  it('carries baseUrl through for openai-compatible provider', () => {
    const env = testEnv(fakeContainers(), {
      CHATBOT_GEN_PROVIDER: 'openai-compatible',
      CHATBOT_GEN_MODEL: 'anthropic/claude-3.5-sonnet',
      CHATBOT_GEN_API_KEY: 'sk-or-x',
      CHATBOT_GEN_BASE_URL: 'https://openrouter.ai/api/v1',
    });
    expect(genModelConfig(env)).toEqual({
      provider: 'openai-compatible',
      model: 'anthropic/claude-3.5-sonnet',
      apiKey: 'sk-or-x',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
  });
});

describe('toolModelConfig', () => {
  it('falls back entirely to gen config when no TOOL_* vars are set', () => {
    const env = testEnv(fakeContainers());
    expect(toolModelConfig(env)).toEqual(genModelConfig(env));
  });

  it('overrides only the fields that are set, per-field', () => {
    const env = testEnv(fakeContainers(), {
      CHATBOT_TOOL_PROVIDER: 'openai-compatible',
      CHATBOT_TOOL_MODEL: 'qwen2.5:7b',
      CHATBOT_TOOL_API_KEY: 'ollama',
      CHATBOT_TOOL_BASE_URL: 'http://localhost:11434/v1',
    });
    expect(toolModelConfig(env)).toEqual({
      provider: 'openai-compatible',
      model: 'qwen2.5:7b',
      apiKey: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
    });
  });

  it('unset TOOL_MODEL alone still falls back to gen model, keeping gen provider', () => {
    const env = testEnv(fakeContainers(), { CHATBOT_TOOL_API_KEY: 'only-key-set' });
    const cfg = toolModelConfig(env);
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.model).toBe('claude-haiku-4-5-20251001');
    expect(cfg.apiKey).toBe('only-key-set');
  });
});

describe('makeModel', () => {
  it('returns a ChatAnthropic instance for provider anthropic', () => {
    const m = makeModel({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'x' });
    expect(m).toBeInstanceOf(ChatAnthropic);
  });

  it('returns a ChatGoogleGenerativeAI instance for provider google', () => {
    const m = makeModel({ provider: 'google', model: 'gemini-1.5-flash', apiKey: 'x' });
    expect(m).toBeInstanceOf(ChatGoogleGenerativeAI);
  });

  it('returns a ChatOpenAI instance for provider openai-compatible with a baseUrl', () => {
    const m = makeModel({
      provider: 'openai-compatible',
      model: 'anthropic/claude-3.5-sonnet',
      apiKey: 'x',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    expect(m).toBeInstanceOf(ChatOpenAI);
  });

  it('throws for openai-compatible with no baseUrl', () => {
    expect(() => makeModel({ provider: 'openai-compatible', model: 'x', apiKey: 'x' })).toThrow(
      /baseUrl/,
    );
  });
});
