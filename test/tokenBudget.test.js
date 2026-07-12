import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTokenBudget, stripTokenBudget, createBudgetTracker, checkTokenBudget } from '../src/agent/tokenBudget.js';

test('parseTokenBudget parses +500k shorthand at start', () => {
  assert.equal(parseTokenBudget('+500k fix the bug'), 500000);
});

test('parseTokenBudget parses +2m shorthand at end', () => {
  assert.equal(parseTokenBudget('refactor everything +2m'), 2000000);
});

test('parseTokenBudget parses verbose "use 2M tokens"', () => {
  assert.equal(parseTokenBudget('use 2M tokens to build it'), 2000000);
});

test('parseTokenBudget returns null for no budget', () => {
  assert.equal(parseTokenBudget('just do it'), null);
});

test('stripTokenBudget removes the budget syntax', () => {
  assert.equal(stripTokenBudget('+500k fix the bug'), 'fix the bug');
  assert.equal(stripTokenBudget('refactor everything +2m'), 'refactor everything');
});

test('checkTokenBudget stops subagents immediately', () => {
  const tracker = createBudgetTracker();
  const decision = checkTokenBudget(tracker, 'sub-1', 500000, 100);
  assert.equal(decision.action, 'stop');
  assert.equal(decision.completionEvent, null);
});

test('checkTokenBudget continues when under 90% threshold', () => {
  const tracker = createBudgetTracker();
  // Simulate 100 tokens consumed (well under 90% of 500000)
  const decision = checkTokenBudget(tracker, undefined, 500000, 100);
  assert.equal(decision.action, 'continue');
  assert.equal(decision.continuationCount, 1);
});

test('checkTokenBudget stops at 90% threshold', () => {
  const tracker = createBudgetTracker();
  tracker.continuationCount = 1; // simulate at least one continuation
  const decision = checkTokenBudget(tracker, undefined, 500000, 450000);
  assert.equal(decision.action, 'stop');
  assert.ok(decision.completionEvent);
});