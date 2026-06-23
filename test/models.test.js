import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, MODEL_PROVIDERS, CONTEXT_WINDOWS } from '../src/config.js';
import { resolveModel, resolveProvider } from '../src/agent/models.js';

// ── Model list ─────────────────────────────────────────────────────────────────

test('MODELS has entries', () => {
  assert.ok(Object.keys(MODELS).length > 0);
});

test('MODELS has claude, gpt, gemini', () => {
  assert.ok(MODELS['claude']);
  assert.ok(MODELS['gpt']);
  assert.ok(MODELS['gemini']);
});

test('MODELS values are strings (model IDs)', () => {
  for (const [alias, modelId] of Object.entries(MODELS)) {
    assert.equal(typeof modelId, 'string', `${alias} value is not a string`);
  }
});

// ── MODEL_PROVIDERS ───────────────────────────────────────────────────────────

test('MODEL_PROVIDERS covers all MODELS keys', () => {
  for (const alias of Object.keys(MODELS)) {
    const found = MODEL_PROVIDERS[alias] || MODEL_PROVIDERS[alias.toLowerCase()];
    // Some aliases don't have explicit entries — resolveProvider handles via regex fallback
    if (!found) {
      const provider = resolveProvider(alias);
      assert.ok(provider, `No provider found for alias "${alias}"`);
    }
  }
});

// ── resolveModel ───────────────────────────────────────────────────────────────

test('resolveModel returns model ID for known alias', () => {
  assert.equal(resolveModel('claude'), 'claude-sonnet-4-6');
  assert.equal(resolveModel('gpt'), 'gpt-4o');
  assert.equal(resolveModel('gemini'), 'gemini-2.0-flash');
});

test('resolveModel passthrough for unknown alias', () => {
  assert.equal(resolveModel('some-random-model'), 'some-random-model');
});

// ── resolveProvider ────────────────────────────────────────────────────────────

test('resolveProvider returns provider for known aliases', () => {
  assert.equal(resolveProvider('claude'), 'anthropic');
  assert.equal(resolveProvider('gpt'), 'openai');
  assert.equal(resolveProvider('gemini'), 'gemini');
  assert.equal(resolveProvider('groq'), 'groq');
  assert.equal(resolveProvider('mistral'), 'mistral');
  assert.equal(resolveProvider('ollama'), 'ollama');
});

test('resolveProvider uses regex fallback', () => {
  // Not in MODEL_PROVIDERS, but matches regex
  assert.equal(resolveProvider('gpt-4o'), 'openai');
  assert.equal(resolveProvider('claude-sonnet-4'), 'anthropic');
  assert.equal(resolveProvider('gemini-2.0-flash'), 'gemini');
});

test('resolveProvider returns openai as default unknown', () => {
  assert.equal(resolveProvider('completely-unknown-model-name-xyz'), 'openai');
});

// ── CONTEXT_WINDOWS ───────────────────────────────────────────────────────────

test('CONTEXT_WINDOWS has entries', () => {
  assert.ok(Object.keys(CONTEXT_WINDOWS).length > 0);
});

test('context windows are positive integers', () => {
  for (const [alias, size] of Object.entries(CONTEXT_WINDOWS)) {
    assert.ok(Number.isInteger(size), `${alias} context window ${size} is not an integer`);
    assert.ok(size > 0, `${alias} context window ${size} is not positive`);
  }
});
