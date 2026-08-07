import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { BrowserExtensionBridge } from '../src/agent/browserExtension.js';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

test('browser extension broker serves both its owner and another Axion controller', async (t) => {
  const port = await freePort();
  const pairing = { host: '127.0.0.1', port, token: 'test-token-that-is-long-enough-for-auth' };
  const owner = new BrowserExtensionBridge({ pairing, requestTimeout: 2000 });
  const second = new BrowserExtensionBridge({ pairing, requestTimeout: 2000 });
  let extension;

  t.after(async () => {
    try { extension?.close(); } catch {}
    await second.close();
    await owner.close();
  });

  await owner.start();
  extension = await openSocket(`ws://127.0.0.1:${port}/?role=extension&token=${encodeURIComponent(pairing.token)}`);
  extension.send(JSON.stringify({ type: 'hello', capabilities: ['page.read', 'tabs.list'] }));
  extension.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'ping') {
      extension.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    if (message.type !== 'request') return;
    extension.send(JSON.stringify({
      type: 'response', id: message.id, ok: true,
      result: { method: message.method, params: message.params },
    }));
  });

  const direct = await owner.call('page.read', { tabId: 7 });
  assert.deepEqual(direct, { method: 'page.read', params: { tabId: 7 } });

  await second.start();
  const status = await second.status();
  assert.equal(status.connected, true);
  assert.equal(status.mode, 'controller');

  const relayed = await second.call('tabs.list', {});
  assert.deepEqual(relayed, { method: 'tabs.list', params: {} });
});

test('browser extension broker rejects an invalid pairing token', async (t) => {
  const port = await freePort();
  const pairing = { host: '127.0.0.1', port, token: 'correct-token-that-is-long-enough-for-auth' };
  const owner = new BrowserExtensionBridge({ pairing, requestTimeout: 1000 });
  t.after(async () => owner.close());
  await owner.start();

  await assert.rejects(
    openSocket(`ws://127.0.0.1:${port}/?role=extension&token=wrong-token`),
    /401|Unexpected server response/,
  );
});

