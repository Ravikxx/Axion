import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { formatFatalError, installFatalHandlers } from '../src/tui/runtimeLifecycle.js';

test('fatal error formatting keeps useful stack information', () => {
  const error = new Error('boom');
  const text = formatFatalError(error, 'crashed');
  assert.match(text, /Axion crashed/);
  assert.match(text, /boom/);
});

test('fatal handlers report once, restore state, and exit non-zero', () => {
  const fakeProcess = new EventEmitter();
  const reports = [];
  const exits = [];
  const uninstall = installFatalHandlers({
    processLike: fakeProcess,
    onFatal: (report) => reports.push(report),
    exit: (code) => exits.push(code),
  });

  fakeProcess.emit('unhandledRejection', new Error('broken promise'));
  fakeProcess.emit('uncaughtException', new Error('second crash'));

  assert.equal(reports.length, 1);
  assert.match(reports[0].message, /broken promise/);
  assert.deepEqual(exits, [1]);
  uninstall();
  assert.equal(fakeProcess.listenerCount('uncaughtException'), 0);
  assert.equal(fakeProcess.listenerCount('unhandledRejection'), 0);
});

