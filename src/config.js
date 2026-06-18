import { config } from 'dotenv';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const cwdEnv  = join(process.cwd(), '.env');
const homeEnv = join(homedir(), '.axion', '.env');
if (existsSync(cwdEnv)) config({ path: cwdEnv });
else if (existsSync(homeEnv)) config({ path: homeEnv });
else config();

export const MODELS = {
  claude:             'claude-sonnet-4-6',
  'claude-opus':      'claude-opus-4-8',
  'claude-haiku':     'claude-haiku-4-5-20251001',
  fable:              'claude-fable-5',
  gpt:                'gpt-4o',
  'gpt-mini':         'gpt-4o-mini',
  'gpt-4o-mini':      'gpt-4o-mini',
  groq:               'llama-3.3-70b-versatile',
  'groq-fast':        'llama-3.1-8b-instant',
  mistral:            'mistral-large-latest',
  'mistral-small':    'mistral-small-latest',
  gemini:             'gemini-2.0-flash',
  'gemini-flash':     'gemini-2.0-flash',
  'gemini-pro':       'gemini-1.5-pro',
  'gemini-2.5-pro':   'gemini-2.5-pro-preview-05-06',
  'gemini-2.5-flash': 'gemini-2.5-flash-preview-05-20',
  openrouter:         'meta-llama/llama-3.3-70b-instruct',
  'or':               'meta-llama/llama-3.3-70b-instruct',
  ollama:             'llama3',
  veil:               'veil',
  lumen:              'lumen',
  glm:                'glm-5.2',
  'glm-5.2':          'glm-5.2',
};

export const MODEL_PROVIDERS = {
  claude:             'anthropic',
  'claude-opus':      'anthropic',
  'claude-haiku':     'anthropic',
  fable:              'anthropic',
  gpt:                'openai',
  'gpt-mini':         'openai',
  'gpt-4o-mini':      'openai',
  groq:               'groq',
  'groq-fast':        'groq',
  mistral:            'mistral',
  'mistral-small':    'mistral',
  gemini:             'gemini',
  'gemini-flash':     'gemini',
  'gemini-pro':       'gemini',
  'gemini-2.5-pro':   'gemini',
  'gemini-2.5-flash': 'gemini',
  openrouter:         'openrouter',
  'or':               'openrouter',
  ollama:             'ollama',
  veil:               'veil',
  lumen:              'lumen',
  glm:                'zai',
  'glm-5.2':          'zai',
};

export const API_KEYS = {
  anthropic:   process.env.ANTHROPIC_API_KEY,
  openai:      process.env.OPENAI_API_KEY,
  groq:        process.env.GROQ_API_KEY,
  mistral:     process.env.MISTRAL_API_KEY,
  gemini:      process.env.GEMINI_API_KEY,
  openrouter:  process.env.OPENROUTER_API_KEY,
  tavily:      process.env.TAVILY_API_KEY,
  sketchfab:   process.env.SKETCHFAB_API_KEY,
  zai:         process.env.ZAI_API_KEY,
};

export const BASE_URLS = {
  groq:        'https://api.groq.com/openai/v1',
  mistral:     'https://api.mistral.ai/v1',
  gemini:      'https://generativelanguage.googleapis.com/v1beta/openai/',
  openrouter:  'https://openrouter.ai/api/v1',
  ollama:      'http://localhost:11434/v1',
  veil:        'https://ravikxxbgamin-minecraftai-chat.hf.space/v1',
  lumen:       'https://ravikxxbgamin-lumen.hf.space/v1',
  zai:         'https://api.z.ai/api/paas/v4',
};

// Named custom endpoints — mutated at runtime via /endpoint command.
// Each key is the endpoint name used as a model alias.
// e.g. CUSTOM_ENDPOINTS['ollama'] = { baseURL, model, apiKey }
export const CUSTOM_ENDPOINTS = {};

// Vision model for computer use — mutable object so imports stay live after /vision changes it.
export const VISION_MODEL = { current: process.env.AXION_VISION_MODEL || 'claude' };

// Image generation model — mutable so /img-gen-model changes it globally.
export const IMAGE_GEN_MODEL = { current: process.env.AXION_IMAGE_MODEL || 'dall-e-3' };

export function setApiKey(modelOrProvider, key) {
  const provider = MODEL_PROVIDERS[modelOrProvider] || modelOrProvider;
  if (!Object.prototype.hasOwnProperty.call(API_KEYS, provider)) {
    throw new Error(`Unknown provider "${provider}". Valid: anthropic, openai, groq, mistral, gemini, openrouter, zai, tavily, sketchfab`);
  }
  API_KEYS[provider] = key;
  return provider;
}

// Context window sizes (input tokens) per model ID
export const CONTEXT_WINDOWS = {
  'claude-sonnet-4-6':              200_000,
  'claude-opus-4-8':                200_000,
  'claude-haiku-4-5-20251001':      200_000,
  'claude-fable-5':                 200_000,
  'gpt-4o':                         128_000,
  'gpt-4o-mini':                    128_000,
  'gemini-2.0-flash':             1_000_000,
  'gemini-2.5-pro-preview-05-06': 1_000_000,
  'gemini-2.5-flash-preview-05-20':1_000_000,
  'llama-3.3-70b-versatile':        128_000,
  'llama-3.1-8b-instant':           128_000,
  'mistral-large-latest':           128_000,
  'mistral-small-latest':           32_000,
};

export function getContextWindow(modelAlias) {
  const id = MODELS[modelAlias] || modelAlias;
  return CONTEXT_WINDOWS[id] || 128_000;
}

export const DEFAULT_MODEL = process.env.AXION_MODEL || 'claude';
export const DEFAULT_MODE  = 'ask';

// Cost per 1M tokens (input, output) in USD — used for rough estimates only
export const TOKEN_COSTS = {
  'claude-sonnet-4-6':            { in: 3,     out: 15   },
  'claude-opus-4-8':              { in: 15,    out: 75   },
  'claude-haiku-4-5-20251001':    { in: 0.8,   out: 4    },
  'claude-fable-5':               { in: 10,    out: 50   },
  'gpt-4o':                       { in: 5,     out: 15   },
  'gpt-4o-mini':                  { in: 0.15,  out: 0.6  },
  'gemini-2.0-flash':             { in: 0.075, out: 0.3  },
  'gemini-2.5-pro-preview-05-06': { in: 1.25,  out: 10   },
  'gemini-2.5-flash-preview-05-20': { in: 0.15, out: 0.6 },
  'llama-3.3-70b-versatile':      { in: 0.59,  out: 0.79 },
  'mistral-large-latest':         { in: 3,     out: 9    },
};

export function estimateCost(modelAlias, inputTokens, outputTokens) {
  const id   = MODELS[modelAlias] || modelAlias;
  const cost = TOKEN_COSTS[id];
  if (!cost) return null;
  return (inputTokens / 1_000_000) * cost.in + (outputTokens / 1_000_000) * cost.out;
}
