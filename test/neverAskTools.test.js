import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/agent/agent.js';
import { TOOL_DEFINITIONS } from '../src/agent/tools.js';

const agentSource = readFileSync(new URL('../src/agent/agent.js', import.meta.url), 'utf8');

// User-reported bug: "the permissions thing still shows... where it can't
// do anything except artifacts, which don't require asking ever." Cloud
// artifact tools only touch the signed-in user's own Sennoric account, are
// fully reversible (including via delete_cloud_artifact itself), and never
// touch the local filesystem or another user's data — so unlike
// run_command/delete_file, asking permission adds friction with no matching
// safety benefit. Agent.NEVER_ASK exempts them from both 'ask' mode's
// unconditional confirm and 'decide' mode's AI-judge gate.

test('NEVER_ASK contains reversible cloud tools and user-interaction tools', () => {
  assert.deepEqual(
    [...Agent.NEVER_ASK].sort(),
    [
      'ask_confirm', 'ask_multiple_choice', 'ask_question', 'ask_questions',
      'create_cloud_artifact', 'delete_cloud_artifact', 'update_cloud_artifact',
    ],
  );
});

test('every NEVER_ASK tool actually exists in TOOL_DEFINITIONS', () => {
  const realNames = new Set(TOOL_DEFINITIONS.map((t) => t.name));
  for (const name of Agent.NEVER_ASK) {
    assert.ok(realNames.has(name), `NEVER_ASK entry "${name}" does not exist in TOOL_DEFINITIONS`);
  }
});

test('NEVER_ASK does not include destructive local-filesystem or shell tools', () => {
  // A regression here would silently make run_command/delete_file skip
  // confirmation too, which is a real safety issue, not just noise.
  for (const dangerous of ['run_command', 'delete_file', 'replace_in_files', 'git_push', 'write_file', 'patch_file']) {
    assert.ok(!Agent.NEVER_ASK.has(dangerous), `${dangerous} must never be in NEVER_ASK`);
  }
});

test('the permission gate checks the permanent floor, then NEVER_ASK, before mode branches', () => {
  const start = agentSource.indexOf('// ── Permission checks');
  assert.notEqual(start, -1, 'expected to find the permission-check block');
  const gate = agentSource.slice(start, start + 2200);
  assert.match(gate, /if \(Agent\.NEVER_ASK\.has\(name\)\) \{/);
  const floorIndex = gate.indexOf('requiresPermanentApproval(name)');
  const neverAskIndex = gate.indexOf('Agent.NEVER_ASK.has(name)');
  const decideIndex = gate.indexOf("this.mode === 'decide'");
  const askIndex = gate.indexOf("this.mode === 'ask'");
  assert.ok(floorIndex >= 0 && floorIndex < neverAskIndex, 'permanent floor must be evaluated first');
  assert.ok(neverAskIndex < decideIndex && neverAskIndex < askIndex, 'NEVER_ASK must precede mode-specific checks');
});
