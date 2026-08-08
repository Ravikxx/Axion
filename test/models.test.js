import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, MODEL_PROVIDERS, CONTEXT_WINDOWS } from '../src/config.js';
import { createClient, resolveModel, resolveProvider, setAxionAuthResolver } from '../src/agent/models.js';

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
  assert.equal(resolveProvider('opencode'), 'opencode');
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

// ── Sennoric auth resolver seam ──────────────────────────────────────────────
//
// getAxionKey() reads a real ~/.axion/config.json, so these tests avoid
// asserting a specific persisted-key value (environment-dependent) and
// instead assert the resolver takes precedence when it returns something,
// and that a falsy resolver result is indistinguishable from no resolver at
// all having been registered.

test('createClient prefers the registered Sennoric auth resolver for lumen/veil/axion-vision', () => {
  setAxionAuthResolver(() => 'resolver-supplied-token');
  try {
    assert.equal(createClient('lumen').client.apiKey, 'resolver-supplied-token');
    assert.equal(createClient('veil').client.apiKey, 'resolver-supplied-token');
    assert.equal(createClient('axion-vision').client.apiKey, 'resolver-supplied-token');
  } finally {
    setAxionAuthResolver(null);
  }
});

test('a resolver returning a falsy value behaves identically to no resolver registered', () => {
  const attempt = () => {
    try { return createClient('lumen'); } catch (error) { return error; }
  };
  const baseline = attempt();

  setAxionAuthResolver(() => null);
  const withFalsyResolver = attempt();
  setAxionAuthResolver(null);

  if (baseline instanceof Error) {
    assert.ok(withFalsyResolver instanceof Error);
    assert.equal(withFalsyResolver.message, baseline.message);
  } else {
    assert.equal(withFalsyResolver.client.apiKey, baseline.client.apiKey);
  }
});

test('setAxionAuthResolver ignores a non-function argument instead of throwing', () => {
  assert.doesNotThrow(() => setAxionAuthResolver('not-a-function'));
  assert.doesNotThrow(() => setAxionAuthResolver(undefined));
  setAxionAuthResolver(null);
});

test('providers unrelated to Sennoric accounts never see the resolver value', () => {
  setAxionAuthResolver(() => 'should-never-leak-here');
  try {
    let result;
    try { result = createClient('claude'); } catch (error) { result = error; }
    if (!(result instanceof Error)) {
      assert.notEqual(result.client.apiKey, 'should-never-leak-here');
    }
  } finally {
    setAxionAuthResolver(null);
  }
});
