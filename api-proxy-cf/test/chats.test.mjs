import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import app from '../src/index.js'

class Statement {
  constructor(database, sql, values = []) {
    this.database = database
    this.sql = sql
    this.values = values
  }
  bind(...values) { return new Statement(this.database, this.sql, values) }
  first() { return this.database.prepare(this.sql).get(...this.values) || null }
  all() { return { results: this.database.prepare(this.sql).all(...this.values) } }
  run() {
    const result = this.database.prepare(this.sql).run(...this.values)
    return Promise.resolve({ meta: { changes: Number(result.changes) } })
  }
}

class D1TestDatabase {
  constructor() {
    this.database = new DatabaseSync(':memory:')
    this.database.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        banned INTEGER NOT NULL DEFAULT 0,
        token_version INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE chats (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT 'New chat',
        updated INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL DEFAULT 0,
        active_generation_id TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        pinned_at INTEGER
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tool_calls TEXT,
        tool_call_id TEXT,
        generation_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_messages_chat_seq ON messages (chat_id, seq);
      CREATE UNIQUE INDEX idx_messages_generation ON messages (generation_id) WHERE generation_id IS NOT NULL;
      CREATE TABLE chat_generations (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        model TEXT NOT NULL,
        error TEXT,
        created INTEGER NOT NULL,
        started INTEGER,
        completed INTEGER
      );
    `)
  }
  prepare(sql) { return new Statement(this.database, sql) }
  async batch(statements) {
    this.database.exec('BEGIN')
    try {
      const results = statements.map(statement => statement.run())
      this.database.exec('COMMIT')
      return results
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
}

async function sessionToken(uid, secret) {
  const payload = btoa(JSON.stringify({ uid, v: 0, exp: Date.now() + 60_000 }))
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return `${payload}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`
}

const SECRET = 'chats-test-secret'

async function setup() {
  const db = new D1TestDatabase()
  db.prepare('INSERT INTO users (id, email) VALUES (?,?)').bind('user-1', 'a@example.com').run()
  db.prepare('INSERT INTO users (id, email) VALUES (?,?)').bind('user-2', 'b@example.com').run()
  const token = await sessionToken('user-1', SECRET)
  const env = { DB: db, TOKEN_SECRET: SECRET }
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  return { db, env, headers }
}

test('PUT creates a chat, POST appends messages one at a time, GET returns them in order', async () => {
  const { db, env, headers } = await setup()

  await app.request('/chats/chat-1', {
    method: 'PUT', headers, body: JSON.stringify({ title: 'Hello world' }),
  }, env)

  const first = await app.request('/chats/chat-1/messages', {
    method: 'POST', headers, body: JSON.stringify({ role: 'user', content: 'Hi' }),
  }, env)
  assert.equal(first.status, 200)
  assert.equal((await first.json()).seq, 1)

  const second = await app.request('/chats/chat-1/messages', {
    method: 'POST', headers, body: JSON.stringify({ role: 'assistant', content: 'Hello back' }),
  }, env)
  assert.equal((await second.json()).seq, 2)

  const get = await app.request('/chats/chat-1', { headers }, env)
  const body = await get.json()
  assert.equal(body.title, 'Hello world')
  assert.deepEqual(body.messages.map(m => [m.role, m.content]), [
    ['user', 'Hi'],
    ['assistant', 'Hello back'],
  ])
})

test('POST to a chat owned by another user is rejected', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-2', 'user-2', 'Not yours', 1, 1).run()

  const res = await app.request('/chats/chat-2/messages', {
    method: 'POST', headers, body: JSON.stringify({ role: 'user', content: 'Hi' }),
  }, env)
  assert.equal(res.status, 404)
})

test('an invalid role is rejected before any row is written', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Test', 1, 1).run()

  const res = await app.request('/chats/chat-1/messages', {
    method: 'POST', headers, body: JSON.stringify({ role: 'system', content: 'nope' }),
  }, env)
  assert.equal(res.status, 400)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id=?').bind('chat-1').first().n, 0)
})

test('DELETE from_seq truncates a message and everything after it, for edit/regenerate', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Test', 1, 1).run()
  for (const [seq, role, content] of [[1, 'user', 'one'], [2, 'assistant', 'two'], [3, 'user', 'three']]) {
    db.prepare('INSERT INTO messages (id, chat_id, user_id, seq, role, content, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(`chat-1-${seq}`, 'chat-1', 'user-1', seq, role, content, seq).run()
  }

  const res = await app.request('/chats/chat-1/messages?from_seq=2', { method: 'DELETE', headers }, env)
  assert.equal(res.status, 200)

  const remaining = db.prepare('SELECT seq FROM messages WHERE chat_id=? ORDER BY seq').bind('chat-1').all()
  assert.deepEqual(remaining.results.map(r => r.seq), [1])
})

test('a malformed from_seq is rejected rather than deleting everything', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Test', 1, 1).run()
  db.prepare('INSERT INTO messages (id, chat_id, user_id, seq, role, content, created_at) VALUES (?,?,?,?,?,?,?)')
    .bind('chat-1-1', 'chat-1', 'user-1', 1, 'user', 'one', 1).run()

  const res = await app.request('/chats/chat-1/messages', { method: 'DELETE', headers }, env)
  assert.equal(res.status, 400)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id=?').bind('chat-1').first().n, 1)
})

test('PUT never touches existing messages, only title/updated', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Old title', 1, 1).run()
  db.prepare('INSERT INTO messages (id, chat_id, user_id, seq, role, content, created_at) VALUES (?,?,?,?,?,?,?)')
    .bind('chat-1-1', 'chat-1', 'user-1', 1, 'user', 'Keep me', 1).run()

  await app.request('/chats/chat-1', {
    method: 'PUT', headers, body: JSON.stringify({ title: 'New title' }),
  }, env)

  const chat = db.prepare('SELECT title FROM chats WHERE id=?').bind('chat-1').first()
  assert.equal(chat.title, 'New title')
  const messages = db.prepare('SELECT content FROM messages WHERE chat_id=?').bind('chat-1').all()
  assert.deepEqual(messages.results.map(r => r.content), ['Keep me'])
})

test('pinning a chat sets pinned_at, unpinning clears it, GET reflects both', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Test', 1, 1).run()

  const pin = await app.request('/chats/chat-1/pin', {
    method: 'PUT', headers, body: JSON.stringify({ pinned: true }),
  }, env)
  assert.equal(pin.status, 200)
  const pinBody = await pin.json()
  assert.equal(pinBody.pinned, true)
  assert.ok(pinBody.pinned_at)

  const get = await app.request('/chats/chat-1', { headers }, env)
  const getBody = await get.json()
  assert.equal(getBody.pinned, true)
  assert.equal(getBody.pinned_at, pinBody.pinned_at)

  const unpin = await app.request('/chats/chat-1/pin', {
    method: 'PUT', headers, body: JSON.stringify({ pinned: false }),
  }, env)
  const unpinBody = await unpin.json()
  assert.equal(unpinBody.pinned, false)
  assert.equal(unpinBody.pinned_at, null)

  const chat = db.prepare('SELECT pinned, pinned_at FROM chats WHERE id=?').bind('chat-1').first()
  assert.equal(chat.pinned, 0)
  assert.equal(chat.pinned_at, null)
})

test('pinning a chat owned by another user is rejected', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-2', 'user-2', 'Not yours', 1, 1).run()

  const res = await app.request('/chats/chat-2/pin', {
    method: 'PUT', headers, body: JSON.stringify({ pinned: true }),
  }, env)
  assert.equal(res.status, 404)
})

test('pinning does not touch title, updated, or messages', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Untouched title', 1, 1).run()

  await app.request('/chats/chat-1/pin', {
    method: 'PUT', headers, body: JSON.stringify({ pinned: true }),
  }, env)

  const chat = db.prepare('SELECT title, updated FROM chats WHERE id=?').bind('chat-1').first()
  assert.equal(chat.title, 'Untouched title')
  assert.equal(chat.updated, 1)
})
