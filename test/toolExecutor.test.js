import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamingToolExecutor } from '../src/services/tools/toolExecutor.js';

const calls = [
  { id: '1', name: 'read_file', input: { path: 'a' } },
  { id: '2', name: 'list_directory', input: { path: '.' } },
];

test('tool executor preserves result order', async () => {
  const executor = new StreamingToolExecutor({
    executeFn: async (name) => {
      if (name === 'read_file') await new Promise(resolve => setTimeout(resolve, 20));
      return { success: true, output: name };
    },
  });
  const results = await executor.execute(calls);
  assert.deepEqual(results.map(result => result.id), ['1', '2']);
});

test('tool executor passes external cancellation to parallel tools', async () => {
  const controller = new AbortController();
  const executor = new StreamingToolExecutor({
    executeFn: (_name, _input, { signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ success: false, output: 'aborted' }), { once: true });
    }),
  });
  setTimeout(() => controller.abort(), 20);
  const results = await executor.execute(calls, controller.signal);
  assert.equal(results.length, 2);
  assert.ok(results.every(result => result.output === 'aborted'));
});

test('tool executor onBatchEnd receives results, not tool-call inputs', async () => {
  let ended;
  const executor = new StreamingToolExecutor({
    executeFn: async (name) => ({ success: true, output: name }),
    onBatchEnd: (_index, results) => { ended = results; },
  });
  await executor.execute(calls);
  assert.equal(ended[0].output, 'read_file');
  assert.equal(ended[0].input, undefined);
});

