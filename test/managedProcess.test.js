import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runManagedProcess } from '../src/services/process/managedProcess.js';

test('managed process captures successful output', async () => {
  const result = await runManagedProcess(process.execPath, ['-e', 'process.stdout.write("hello")']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, 'hello');
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
});

test('managed process reports non-zero exit and stderr', async () => {
  const result = await runManagedProcess(process.execPath, ['-e', 'process.stderr.write("bad"); process.exit(7)']);
  assert.equal(result.exitCode, 7);
  assert.match(result.output, /bad/);
});

test('managed process bounds very large output', async () => {
  const result = await runManagedProcess(
    process.execPath,
    ['-e', 'process.stdout.write("x".repeat(10000))'],
    { maxOutputChars: 1000 },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.truncated, true);
  assert.match(result.output, /truncated 9000 characters/);
  assert.ok(result.output.length < 1200);
});

test('managed process terminates on timeout', async () => {
  const started = Date.now();
  const result = await runManagedProcess(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { timeoutMs: 100 },
  );
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 5000, 'timed-out process should be terminated promptly');
});

test('managed process terminates when aborted', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const result = await runManagedProcess(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { signal: controller.signal, timeoutMs: 5000 },
  );
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
});
