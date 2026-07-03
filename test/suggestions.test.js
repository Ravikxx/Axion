import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSuggestions, getTabCompletion, COMMANDS } from '../src/ui/commands.js';

// ── getSuggestions ────────────────────────────────────────────────────────────

test('returns empty array when no leading slash', () => {
  assert.deepEqual(getSuggestions('help'),  []);
  assert.deepEqual(getSuggestions(''),      []);
  assert.deepEqual(getSuggestions('hello'), []);
});

test('returns all commands for bare slash', () => {
  const results = getSuggestions('/');
  assert.equal(results.length, COMMANDS.length);
});

test('filters by prefix', () => {
  const results = getSuggestions('/he');
  assert.ok(results.every(c => c.cmd.startsWith('he')));
  assert.ok(results.some(c => c.cmd === 'help'));
});

test('exact match returns that command', () => {
  const results = getSuggestions('/help');
  assert.equal(results.length, 1);
  assert.equal(results[0].cmd, 'help');
});

test('returns empty for unknown prefix', () => {
  assert.deepEqual(getSuggestions('/zzzzz'), []);
});

test('ignores text after the first space (matches on command token only)', () => {
  const results = getSuggestions('/model something');
  assert.ok(results.some(c => c.cmd === 'model'));
});

// ── getTabCompletion ──────────────────────────────────────────────────────────

test('completes a partial command', () => {
  assert.equal(getTabCompletion('/he'), '/help ');
});

test('returns null when already an exact match', () => {
  assert.equal(getTabCompletion('/help'), null);
});

test('returns null for no matches', () => {
  assert.equal(getTabCompletion('/zzzzz'), null);
});

test('returns null for input without slash', () => {
  assert.equal(getTabCompletion('help'), null);
});

test('completes to first alphabetically matched command', () => {
  const completion = getTabCompletion('/mo');
  // First command starting with 'mo' in COMMANDS order
  const expected = '/' + COMMANDS.find(c => c.cmd.startsWith('mo')).cmd + ' ';
  assert.equal(completion, expected);
});

// ── ALL commands integrity ─────────────────────────────────────────────────────

test('every COMMAND has cmd and desc', () => {
  for (const c of COMMANDS) {
    assert.equal(typeof c.cmd, 'string', `missing cmd in ${JSON.stringify(c)}`);
    assert.ok(c.cmd.length > 0, `empty cmd in ${JSON.stringify(c)}`);
    assert.equal(typeof c.desc, 'string', `missing desc for /${c.cmd}`);
    assert.ok(c.desc.length > 0, `empty desc for /${c.cmd}`);
  }
});

test('COMMAND names are unique', () => {
  const names = COMMANDS.map(c => c.cmd);
  assert.equal(new Set(names).size, names.length, 'duplicate command names found');
});
