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
        pinned_at INTEGER,
        draft TEXT,
        draft_updated_at INTEGER,
        branched_from_chat_id TEXT,
        branched_from_seq INTEGER,
        deleted_at INTEGER
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

function seedMessages(db, chatId, userId, items) {
  items.forEach(([role, content], i) => {
    const seq = i + 1
    db.prepare('INSERT INTO messages (id, chat_id, user_id, seq, role, content, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(`${chatId}-${seq}`, chatId, userId, seq, role, content, seq).run()
  })
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

test('saving a draft persists it and GET returns it; clearing it drops draft_updated_at', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Test', 1, 1).run()

  const save = await app.request('/chats/chat-1/draft', {
    method: 'PUT', headers, body: JSON.stringify({ content: 'unsent text' }),
  }, env)
  assert.equal(save.status, 200)
  const saveBody = await save.json()
  assert.ok(saveBody.draft_updated_at)

  const get = await app.request('/chats/chat-1', { headers }, env)
  const getBody = await get.json()
  assert.equal(getBody.draft, 'unsent text')
  assert.equal(getBody.draft_updated_at, saveBody.draft_updated_at)

  const clear = await app.request('/chats/chat-1/draft', {
    method: 'PUT', headers, body: JSON.stringify({ content: '' }),
  }, env)
  const clearBody = await clear.json()
  assert.equal(clearBody.draft_updated_at, null)

  const chat = db.prepare('SELECT draft, draft_updated_at FROM chats WHERE id=?').bind('chat-1').first()
  assert.equal(chat.draft, null)
  assert.equal(chat.draft_updated_at, null)
})

test('saving a draft does not touch title, updated, pinned, or messages', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created, pinned) VALUES (?,?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Untouched title', 1, 1, 1).run()
  db.prepare('INSERT INTO messages (id, chat_id, user_id, seq, role, content, created_at) VALUES (?,?,?,?,?,?,?)')
    .bind('chat-1-1', 'chat-1', 'user-1', 1, 'user', 'Keep me', 1).run()

  await app.request('/chats/chat-1/draft', {
    method: 'PUT', headers, body: JSON.stringify({ content: 'a draft' }),
  }, env)

  const chat = db.prepare('SELECT title, updated, pinned FROM chats WHERE id=?').bind('chat-1').first()
  assert.equal(chat.title, 'Untouched title')
  assert.equal(chat.updated, 1)
  assert.equal(chat.pinned, 1)
  const messages = db.prepare('SELECT content FROM messages WHERE chat_id=?').bind('chat-1').all()
  assert.deepEqual(messages.results.map(r => r.content), ['Keep me'])
})

test('saving a draft for a chat owned by another user is rejected', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-2', 'user-2', 'Not yours', 1, 1).run()

  const res = await app.request('/chats/chat-2/draft', {
    method: 'PUT', headers, body: JSON.stringify({ content: 'nope' }),
  }, env)
  assert.equal(res.status, 404)
})

test('a draft longer than the cap is truncated, not rejected', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Test', 1, 1).run()

  const huge = 'x'.repeat(60_000)
  const res = await app.request('/chats/chat-1/draft', {
    method: 'PUT', headers, body: JSON.stringify({ content: huge }),
  }, env)
  assert.equal(res.status, 200)
  const chat = db.prepare('SELECT draft FROM chats WHERE id=?').bind('chat-1').first()
  assert.equal(chat.draft.length, 50_000)
})

test('branching copies messages up to from_seq into a new chat and records the relationship', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Original', 1, 1).run()
  seedMessages(db, 'chat-1', 'user-1', [
    ['user', 'one'], ['assistant', 'two'], ['user', 'three'], ['assistant', 'four'],
  ])

  const res = await app.request('/chats/chat-1/branch', {
    method: 'POST', headers, body: JSON.stringify({ from_seq: 2 }),
  }, env)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.branched_from_chat_id, 'chat-1')
  assert.equal(body.branched_from_seq, 2)
  assert.equal(body.title, 'Original')

  const chat = db.prepare('SELECT branched_from_chat_id, branched_from_seq FROM chats WHERE id=?').bind(body.id).first()
  assert.equal(chat.branched_from_chat_id, 'chat-1')
  assert.equal(chat.branched_from_seq, 2)

  const messages = db.prepare('SELECT seq, role, content FROM messages WHERE chat_id=? ORDER BY seq').bind(body.id).all().results
  assert.deepEqual(messages.map(m => [m.role, m.content]), [['user', 'one'], ['assistant', 'two']])

  // The original chat is untouched.
  const originalCount = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id=?').bind('chat-1').first().n
  assert.equal(originalCount, 4)
})

test('a branched copy does not carry generation_id forward, so it never collides with the source', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Original', 1, 1).run()
  db.prepare('INSERT INTO messages (id, chat_id, user_id, seq, role, content, generation_id, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind('chat-1-1', 'chat-1', 'user-1', 1, 'assistant', 'reply', 'gen-1', 1).run()

  const res = await app.request('/chats/chat-1/branch', {
    method: 'POST', headers, body: JSON.stringify({ from_seq: 1 }),
  }, env)
  assert.equal(res.status, 200)
  const body = await res.json()

  const copy = db.prepare('SELECT generation_id FROM messages WHERE chat_id=? AND seq=1').bind(body.id).first()
  assert.equal(copy.generation_id, null)
  // The unique index on generation_id would have thrown on insert if this
  // weren't null — reaching here at all is most of the assertion.
})

test('branching a chat owned by another user is rejected', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-2', 'user-2', 'Not yours', 1, 1).run()
  seedMessages(db, 'chat-2', 'user-2', [['user', 'hi']])

  const res = await app.request('/chats/chat-2/branch', {
    method: 'POST', headers, body: JSON.stringify({ from_seq: 1 }),
  }, env)
  assert.equal(res.status, 404)
})

test('an invalid from_seq is rejected', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Original', 1, 1).run()
  seedMessages(db, 'chat-1', 'user-1', [['user', 'one']])

  const res = await app.request('/chats/chat-1/branch', {
    method: 'POST', headers, body: JSON.stringify({ from_seq: 0 }),
  }, env)
  assert.equal(res.status, 400)
})

test('branching from a seq past the end of the conversation is rejected, not silently clamped', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Original', 1, 1).run()
  seedMessages(db, 'chat-1', 'user-1', [['user', 'one']])

  const res = await app.request('/chats/chat-1/branch', {
    method: 'POST', headers, body: JSON.stringify({ from_seq: 99 }),
  }, env)
  assert.equal(res.status, 400)
})

test('DELETE soft-deletes: it disappears from the list and appears in trash, but the row survives', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Test', 1, 1).run()

  const del = await app.request('/chats/chat-1', { method: 'DELETE', headers }, env)
  assert.equal(del.status, 200)

  const list = await app.request('/chats', { headers }, env)
  assert.deepEqual((await list.json()).chats.map(c => c.id), [])

  const trash = await app.request('/chats/trash', { headers }, env)
  const trashBody = await trash.json()
  assert.equal(trashBody.chats.length, 1)
  assert.equal(trashBody.chats[0].id, 'chat-1')
  assert.ok(trashBody.chats[0].deleted_at)

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chats WHERE id=?').bind('chat-1').first().n, 1)
})

test('deleting an already-trashed chat 404s instead of refreshing deleted_at', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created, deleted_at) VALUES (?,?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Test', 1, 1, 5).run()

  const res = await app.request('/chats/chat-1', { method: 'DELETE', headers }, env)
  assert.equal(res.status, 404)
  assert.equal(db.prepare('SELECT deleted_at FROM chats WHERE id=?').bind('chat-1').first().deleted_at, 5)
})

test('restore clears deleted_at and the chat reappears in the active list', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created, deleted_at) VALUES (?,?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Test', 1, 1, Date.now()).run()

  const res = await app.request('/chats/chat-1/restore', { method: 'POST', headers }, env)
  assert.equal(res.status, 200)

  const chat = db.prepare('SELECT deleted_at FROM chats WHERE id=?').bind('chat-1').first()
  assert.equal(chat.deleted_at, null)
  const list = await app.request('/chats', { headers }, env)
  assert.deepEqual((await list.json()).chats.map(c => c.id), ['chat-1'])
})

test('restoring a chat that is not in trash 404s', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Test', 1, 1).run()

  const res = await app.request('/chats/chat-1/restore', { method: 'POST', headers }, env)
  assert.equal(res.status, 404)
})

test('permanent delete removes the chat and its messages, but only if already trashed', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Test', 1, 1).run()
  seedMessages(db, 'chat-1', 'user-1', [['user', 'one']])

  const tooEarly = await app.request('/chats/chat-1/permanent', { method: 'DELETE', headers }, env)
  assert.equal(tooEarly.status, 404)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chats WHERE id=?').bind('chat-1').first().n, 1)

  await app.request('/chats/chat-1', { method: 'DELETE', headers }, env)
  const res = await app.request('/chats/chat-1/permanent', { method: 'DELETE', headers }, env)
  assert.equal(res.status, 200)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chats WHERE id=?').bind('chat-1').first().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id=?').bind('chat-1').first().n, 0)
})

test('Empty Trash permanently removes every trashed chat and its messages, and only those', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created, deleted_at) VALUES (?,?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Trashed one', 1, 1, 5).run()
  seedMessages(db, 'chat-1', 'user-1', [['user', 'one']])
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created, deleted_at) VALUES (?,?,?,?,?,?)')
    .bind('chat-2', 'user-1', 'Trashed two', 1, 1, 6).run()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-3', 'user-1', 'Still active', 1, 1).run()

  const res = await app.request('/chats/trash', { method: 'DELETE', headers }, env)
  assert.equal(res.status, 200)
  assert.equal((await res.json()).count, 2)

  const remaining = db.prepare('SELECT id FROM chats ORDER BY id').all().results
  assert.deepEqual(remaining.map(r => r.id), ['chat-3'])
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id=?').bind('chat-1').first().n, 0)
})

test('trash and restore only operate on the requesting user\'s own chats', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created, deleted_at) VALUES (?,?,?,?,?,?)')
    .bind('chat-2', 'user-2', 'Not yours', 1, 1, 5).run()

  const del = await app.request('/chats/chat-2', { method: 'DELETE', headers }, env)
  assert.equal(del.status, 404)
  const restore = await app.request('/chats/chat-2/restore', { method: 'POST', headers }, env)
  assert.equal(restore.status, 404)
  const permanent = await app.request('/chats/chat-2/permanent', { method: 'DELETE', headers }, env)
  assert.equal(permanent.status, 404)

  const trash = await app.request('/chats/trash', { headers }, env)
  assert.deepEqual((await trash.json()).chats, [])
})
