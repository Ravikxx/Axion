import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { MODELS, MODEL_PROVIDERS, API_KEYS, BASE_URLS, CUSTOM_ENDPOINTS } from '../config.js';

export function resolveModel(alias) {
  // Custom endpoint: use the model name stored in the endpoint config
  if (CUSTOM_ENDPOINTS[alias]) return CUSTOM_ENDPOINTS[alias].model || alias;
  return MODELS[alias] || alias;
}

export function resolveProvider(alias) {
  if (MODEL_PROVIDERS[alias]) return MODEL_PROVIDERS[alias];
  // Named custom endpoint
  if (CUSTOM_ENDPOINTS[alias]) return 'custom';

  if (/^claude/i.test(alias))                                              return 'anthropic';
  if (/^(gpt|o1|o3|o4|chatgpt|text-|dall-e)/i.test(alias))               return 'openai';
  if (/^gemini/i.test(alias))                                              return 'gemini';
  if (/^(mistral|codestral|pixtral|magistral|open-mistral)/i.test(alias)) return 'mistral';
  if (/^(llama|mixtral|gemma|qwen|deepseek|whisper)/i.test(alias))        return 'groq';

  return 'openai';
}

export function createClient(modelAlias) {
  const provider = resolveProvider(modelAlias);

  if (provider === 'anthropic') {
    const key = API_KEYS.anthropic;
    if (!key) throw new Error('ANTHROPIC_API_KEY not set — use /api claude <key>');
    return { type: 'anthropic', client: new Anthropic({ apiKey: key }) };
  }

  if (provider === 'openai') {
    const key = API_KEYS.openai;
    if (!key) throw new Error('OPENAI_API_KEY not set — use /api gpt <key>');
    return { type: 'openai', client: new OpenAI({ apiKey: key }) };
  }

  if (provider === 'groq') {
    const key = API_KEYS.groq;
    if (!key) throw new Error('GROQ_API_KEY not set — use /api groq <key>');
    return { type: 'openai', client: new OpenAI({ apiKey: key, baseURL: BASE_URLS.groq }) };
  }

  if (provider === 'mistral') {
    const key = API_KEYS.mistral;
    if (!key) throw new Error('MISTRAL_API_KEY not set — use /api mistral <key>');
    return { type: 'openai', client: new OpenAI({ apiKey: key, baseURL: BASE_URLS.mistral }) };
  }

  if (provider === 'gemini') {
    const key = API_KEYS.gemini;
    if (!key) throw new Error('GEMINI_API_KEY not set — use /api gemini <key>');
    return { type: 'openai', client: new OpenAI({ apiKey: key, baseURL: BASE_URLS.gemini }) };
  }

  if (provider === 'custom') {
    const ep = CUSTOM_ENDPOINTS[modelAlias];
    if (!ep) throw new Error(`No endpoint named "${modelAlias}" — use /endpoint <name> <url>`);
    return { type: 'openai', client: new OpenAI({ apiKey: ep.apiKey || 'no-key', baseURL: ep.baseURL }) };
  }

  if (provider === 'ollama') {
    return { type: 'openai', client: new OpenAI({ apiKey: 'ollama', baseURL: BASE_URLS.ollama }) };
  }

  if (provider === 'veil') {
    return { type: 'veil', client: new OpenAI({ apiKey: 'no-key', baseURL: BASE_URLS.veil }) };
  }

  if (provider === 'lumen') {
    return { type: 'openai', client: new OpenAI({ apiKey: 'no-key', baseURL: BASE_URLS.lumen }) };
  }

  if (provider === 'axion-vision') {
    return { type: 'openai', client: new OpenAI({ apiKey: 'no-key', baseURL: BASE_URLS['axion-vision'] }) };
  }

  if (provider === 'zai') {
    const key = API_KEYS.zai;
    if (!key) throw new Error('ZAI_API_KEY not set — use /api glm <key>');
    return { type: 'openai', client: new OpenAI({ apiKey: key, baseURL: BASE_URLS.zai }) };
  }

  if (provider === 'openrouter') {
    const key = API_KEYS.openrouter;
    if (!key) throw new Error('OPENROUTER_API_KEY not set — use /api openrouter <key>');
    return { type: 'openai', client: new OpenAI({
      apiKey: key,
      baseURL: BASE_URLS.openrouter,
      defaultHeaders: {
        'HTTP-Referer': 'https://axion.amplifiedsmp.org',
        'X-Title': 'Axion',
      },
    }) };
  }

  throw new Error(`Unknown provider for model: ${modelAlias}`);
}
