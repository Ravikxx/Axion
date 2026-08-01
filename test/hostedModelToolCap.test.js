import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, restrictToolsForHostedModel, HOSTED_SMALL_MODEL_TOOL_NAMES } from '../src/agent/agent.js';
import { TOOL_DEFINITIONS_OPENAI } from '../src/agent/tools.js';

// Reproduced directly against the live Worker: sending the full ~70-tool
// list to lumen/veil returns an HTTP 200 with a completely empty streamed
// body (52 tools succeeds, 54+ fails every time) — the model call silently
// produces nothing, which the retry loop in _callModel eventually surfaces
// as "Model returned empty response". restrictToolsForHostedModel() caps
// hosted models to a curated safe subset so the app is usable again.

test('restrictToolsForHostedModel leaves the full tool list untouched for non-hosted models', () => {
  const result = restrictToolsForHostedModel(TOOL_DEFINITIONS_OPENAI, 'claude');
  assert.equal(result.length, TOOL_DEFINITIONS_OPENAI.length);
});

test('restrictToolsForHostedModel caps lumen and veil to the curated safe subset', () => {
  for (const alias of ['lumen', 'veil']) {
    const result = restrictToolsForHostedModel(TOOL_DEFINITIONS_OPENAI, alias);
    assert.ok(result.length < TOOL_DEFINITIONS_OPENAI.length, `expected ${alias} to be capped`);
    // Comfortably below the measured 52-tool failure edge, with real margin
    // since the actual limit is schema-complexity/tokens, not a raw count.
    assert.ok(result.length <= 30, `expected a generous safety margin, got ${result.length} tools`);
    for (const tool of result) {
      assert.ok(HOSTED_SMALL_MODEL_TOOL_NAMES.has(tool.function.name), `${tool.function.name} is not in the allowlist`);
    }
  }
});

test('restrictToolsForHostedModel keeps create_cloud_artifact available to hosted models', () => {
  // The Desktop "make an artifact via chat" flow specifically targets the
  // hosted models (Lumen/Veil are the only two shown in Desktop's model
  // picker by default) — this tool must survive the cap.
  const result = restrictToolsForHostedModel(TOOL_DEFINITIONS_OPENAI, 'lumen');
  assert.ok(result.some((t) => t.function.name === 'create_cloud_artifact'));
});

test('restrictToolsForHostedModel keeps the core file/search/git/exec tools available', () => {
  const result = restrictToolsForHostedModel(TOOL_DEFINITIONS_OPENAI, 'lumen');
  const names = new Set(result.map((t) => t.function.name));
  for (const essential of ['read_file', 'write_file', 'list_directory', 'run_command', 'grep', 'git_status']) {
    assert.ok(names.has(essential), `expected ${essential} to survive the cap`);
  }
});

test('every allowlisted tool name actually exists in TOOL_DEFINITIONS_OPENAI', () => {
  // Catches an allowlist entry going stale if a tool is ever renamed/removed.
  const realNames = new Set(TOOL_DEFINITIONS_OPENAI.map((t) => t.function.name));
  for (const name of HOSTED_SMALL_MODEL_TOOL_NAMES) {
    assert.ok(realNames.has(name), `allowlisted "${name}" does not exist in TOOL_DEFINITIONS_OPENAI`);
  }
});

// Computer-use tools are all stripped by the hosted-model cap (none are in
// the allowlist) — /computer would otherwise look enabled while every
// action it needs quietly does nothing, the same silent-failure shape as
// the bug this cap exists to fix. A flagged CodeRabbit review comment on
// the original PR caught this before merge.
test('warns once, not silently, when /computer is on for a hosted model', async () => {
  const notices = [];
  const agent = new Agent({ modelAlias: 'lumen', mode: 'auto', onNotify: (n) => notices.push(n), onTokens: () => {} });
  agent.computerUse = true;

  await agent._getToolListOpenAI();
  await agent._getToolListOpenAI();

  assert.equal(notices.length, 1, 'expected exactly one notice, not one per call');
  assert.match(notices[0].content, /Computer-use tools are unavailable on this model/);
});

test('does not warn about computer-use when it is off, or for non-hosted models', async () => {
  const notices = [];
  const hostedButOff = new Agent({ modelAlias: 'lumen', mode: 'auto', onNotify: (n) => notices.push(n), onTokens: () => {} });
  await hostedButOff._getToolListOpenAI();
  assert.equal(notices.length, 0);

  const nonHosted = new Agent({ modelAlias: 'claude', mode: 'auto', onNotify: (n) => notices.push(n), onTokens: () => {} });
  nonHosted.computerUse = true;
  await nonHosted._getToolListOpenAI();
  assert.equal(notices.length, 0);
});
