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
        deleted_at INTEGER,
        project_id TEXT
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL
      );
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        project_id TEXT,
        chat_id TEXT,
        title TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'text',
        language TEXT,
        latest_revision_id TEXT,
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL
      );
      CREATE TABLE artifact_revisions (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        content TEXT,
        created INTEGER NOT NULL
      );
      CREATE TABLE user_settings (
        user_id TEXT PRIMARY KEY,
        selected_model TEXT,
        onboarding_completed_at INTEGER,
        updated INTEGER NOT NULL
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

test('POST /projects creates a project, GET /projects lists it with a chat_count', async () => {
  const { env, headers } = await setup()
  const create = await app.request('/projects', {
    method: 'POST', headers, body: JSON.stringify({ name: 'Research' }),
  }, env)
  assert.equal(create.status, 200)
  const created = await create.json()
  assert.equal(created.name, 'Research')
  assert.equal(created.chat_count, 0)

  const list = await app.request('/projects', { headers }, env)
  const body = await list.json()
  assert.equal(body.projects.length, 1)
  assert.equal(body.projects[0].id, created.id)
  assert.equal(body.projects[0].chat_count, 0)
})

test('creating a project with an empty name is rejected', async () => {
  const { env, headers } = await setup()
  const res = await app.request('/projects', {
    method: 'POST', headers, body: JSON.stringify({ name: '   ' }),
  }, env)
  assert.equal(res.status, 400)
})

test('PUT /projects/:id renames a project; renaming another user\'s project 404s', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO projects (id, user_id, name, created, updated) VALUES (?,?,?,?,?)')
    .bind('proj-1', 'user-1', 'Old name', 1, 1).run()
  db.prepare('INSERT INTO projects (id, user_id, name, created, updated) VALUES (?,?,?,?,?)')
    .bind('proj-2', 'user-2', 'Not yours', 1, 1).run()

  const ok = await app.request('/projects/proj-1', {
    method: 'PUT', headers, body: JSON.stringify({ name: 'New name' }),
  }, env)
  assert.equal(ok.status, 200)
  assert.equal(db.prepare('SELECT name FROM projects WHERE id=?').bind('proj-1').first().name, 'New name')

  const forbidden = await app.request('/projects/proj-2', {
    method: 'PUT', headers, body: JSON.stringify({ name: 'Hijacked' }),
  }, env)
  assert.equal(forbidden.status, 404)
})

test('DELETE /projects/:id removes the project and unfiles its chats without deleting them', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO projects (id, user_id, name, created, updated) VALUES (?,?,?,?,?)')
    .bind('proj-1', 'user-1', 'Research', 1, 1).run()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created, project_id) VALUES (?,?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'In project', 1, 1, 'proj-1').run()

  const res = await app.request('/projects/proj-1', { method: 'DELETE', headers }, env)
  assert.equal(res.status, 200)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects WHERE id=?').bind('proj-1').first().n, 0)
  const chat = db.prepare('SELECT project_id FROM chats WHERE id=?').bind('chat-1').first()
  assert.equal(chat.project_id, null)
})

test('PUT /chats/:id/project assigns a chat to a project and GET /projects/:id/chats lists it', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO projects (id, user_id, name, created, updated) VALUES (?,?,?,?,?)')
    .bind('proj-1', 'user-1', 'Research', 1, 1).run()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Unfiled', 1, 1).run()

  const assign = await app.request('/chats/chat-1/project', {
    method: 'PUT', headers, body: JSON.stringify({ project_id: 'proj-1' }),
  }, env)
  assert.equal(assign.status, 200)

  const chats = await app.request('/projects/proj-1/chats', { headers }, env)
  assert.equal(chats.status, 200)
  const body = await chats.json()
  assert.equal(body.chats.length, 1)
  assert.equal(body.chats[0].id, 'chat-1')

  const list = await app.request('/projects', { headers }, env)
  assert.equal((await list.json()).projects[0].chat_count, 1)

  const unassign = await app.request('/chats/chat-1/project', {
    method: 'PUT', headers, body: JSON.stringify({ project_id: null }),
  }, env)
  assert.equal(unassign.status, 200)
  assert.equal(db.prepare('SELECT project_id FROM chats WHERE id=?').bind('chat-1').first().project_id, null)
})

test('assigning a chat to a nonexistent project 404s, and to another user\'s project 404s', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Unfiled', 1, 1).run()
  db.prepare('INSERT INTO projects (id, user_id, name, created, updated) VALUES (?,?,?,?,?)')
    .bind('proj-2', 'user-2', 'Not yours', 1, 1).run()

  const missing = await app.request('/chats/chat-1/project', {
    method: 'PUT', headers, body: JSON.stringify({ project_id: 'nope' }),
  }, env)
  assert.equal(missing.status, 404)

  const otherUsers = await app.request('/chats/chat-1/project', {
    method: 'PUT', headers, body: JSON.stringify({ project_id: 'proj-2' }),
  }, env)
  assert.equal(otherUsers.status, 404)
})

test('GET /projects/:id/chats 404s for a project that is not yours', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO projects (id, user_id, name, created, updated) VALUES (?,?,?,?,?)')
    .bind('proj-2', 'user-2', 'Not yours', 1, 1).run()

  const res = await app.request('/projects/proj-2/chats', { headers }, env)
  assert.equal(res.status, 404)
})

test('POST /artifacts creates an artifact with a first revision; GET /artifacts lists it without content', async () => {
  const { env, headers } = await setup()
  const create = await app.request('/artifacts', {
    method: 'POST', headers, body: JSON.stringify({ title: 'Notes', kind: 'markdown', content: '# Hi' }),
  }, env)
  assert.equal(create.status, 200)
  const created = await create.json()
  assert.equal(created.title, 'Notes')
  assert.equal(created.kind, 'markdown')
  assert.equal(created.content, '# Hi')

  const list = await app.request('/artifacts', { headers }, env)
  const body = await list.json()
  assert.equal(body.artifacts.length, 1)
  assert.equal(body.artifacts[0].id, created.id)
  assert.equal(body.artifacts[0].content, undefined)
})

test('an unrecognized kind falls back to text; content over the size limit is rejected with 413', async () => {
  const { env, headers } = await setup()
  const create = await app.request('/artifacts', {
    method: 'POST', headers, body: JSON.stringify({ title: 'X', kind: 'nonsense', content: 'hi' }),
  }, env)
  assert.equal((await create.json()).kind, 'text')

  const tooBig = await app.request('/artifacts', {
    method: 'POST', headers, body: JSON.stringify({ title: 'Big', content: 'x'.repeat(500_001) }),
  }, env)
  assert.equal(tooBig.status, 413)
})

test('GET /artifacts/:id returns the latest content plus a revision list, newest first', async () => {
  const { db, env, headers } = await setup()
  const create = await app.request('/artifacts', {
    method: 'POST', headers, body: JSON.stringify({ title: 'Doc', content: 'v1' }),
  }, env)
  const { id } = await create.json()

  await app.request(`/artifacts/${id}`, {
    method: 'PUT', headers, body: JSON.stringify({ content: 'v2' }),
  }, env)

  const res = await app.request(`/artifacts/${id}`, { headers }, env)
  const body = await res.json()
  assert.equal(body.content, 'v2')
  assert.equal(body.revisions.length, 2)
  assert.ok(body.revisions[0].created >= body.revisions[1].created)
})

test('PUT /artifacts/:id with only a title does not create a new revision', async () => {
  const { db, env, headers } = await setup()
  const create = await app.request('/artifacts', {
    method: 'POST', headers, body: JSON.stringify({ title: 'Doc', content: 'v1' }),
  }, env)
  const { id } = await create.json()

  const rename = await app.request(`/artifacts/${id}`, {
    method: 'PUT', headers, body: JSON.stringify({ title: 'Renamed' }),
  }, env)
  assert.equal(rename.status, 200)

  const count = db.prepare('SELECT COUNT(*) AS n FROM artifact_revisions WHERE artifact_id=?').bind(id).first().n
  assert.equal(count, 1)
  assert.equal(db.prepare('SELECT title FROM artifacts WHERE id=?').bind(id).first().title, 'Renamed')
})

test('PUT /artifacts/:id with no title and no content is rejected', async () => {
  const { env, headers } = await setup()
  const create = await app.request('/artifacts', {
    method: 'POST', headers, body: JSON.stringify({ title: 'Doc', content: 'v1' }),
  }, env)
  const { id } = await create.json()

  const res = await app.request(`/artifacts/${id}`, { method: 'PUT', headers, body: JSON.stringify({}) }, env)
  assert.equal(res.status, 400)
})

test('DELETE /artifacts/:id removes the artifact and all of its revisions', async () => {
  const { db, env, headers } = await setup()
  const create = await app.request('/artifacts', {
    method: 'POST', headers, body: JSON.stringify({ title: 'Doc', content: 'v1' }),
  }, env)
  const { id } = await create.json()
  await app.request(`/artifacts/${id}`, { method: 'PUT', headers, body: JSON.stringify({ content: 'v2' }) }, env)

  const del = await app.request(`/artifacts/${id}`, { method: 'DELETE', headers }, env)
  assert.equal(del.status, 200)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE id=?').bind(id).first().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM artifact_revisions WHERE artifact_id=?').bind(id).first().n, 0)
})

test('creating an artifact under a project or chat that is not yours 404s', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO projects (id, user_id, name, created, updated) VALUES (?,?,?,?,?)')
    .bind('proj-2', 'user-2', 'Not yours', 1, 1).run()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-2', 'user-2', 'Not yours', 1, 1).run()

  const viaProject = await app.request('/artifacts', {
    method: 'POST', headers, body: JSON.stringify({ title: 'X', content: 'y', project_id: 'proj-2' }),
  }, env)
  assert.equal(viaProject.status, 404)

  const viaChat = await app.request('/artifacts', {
    method: 'POST', headers, body: JSON.stringify({ title: 'X', content: 'y', chat_id: 'chat-2' }),
  }, env)
  assert.equal(viaChat.status, 404)
})

test('artifacts only expose themselves to their owner', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO artifacts (id, user_id, title, kind, latest_revision_id, created, updated) VALUES (?,?,?,?,?,?,?)')
    .bind('art-2', 'user-2', 'Not yours', 'text', null, 1, 1).run()

  const get = await app.request('/artifacts/art-2', { headers }, env)
  assert.equal(get.status, 404)
  const put = await app.request('/artifacts/art-2', { method: 'PUT', headers, body: JSON.stringify({ title: 'Hijack' }) }, env)
  assert.equal(put.status, 404)
  const del = await app.request('/artifacts/art-2', { method: 'DELETE', headers }, env)
  assert.equal(del.status, 404)
  const list = await app.request('/artifacts', { headers }, env)
  assert.deepEqual((await list.json()).artifacts, [])
})

test('GET /settings returns defaults when no row exists yet', async () => {
  const { env, headers } = await setup()
  const res = await app.request('/settings', { headers }, env)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { selected_model: null, onboarding_completed_at: null, updated: null })
})

test('PUT /settings creates the row on first write and GET reflects it', async () => {
  const { env, headers } = await setup()
  const put = await app.request('/settings', {
    method: 'PUT', headers, body: JSON.stringify({ selected_model: 'lumen-pro' }),
  }, env)
  assert.equal(put.status, 200)
  const body = await put.json()
  assert.equal(body.selected_model, 'lumen-pro')
  assert.equal(body.onboarding_completed_at, null)

  const get = await app.request('/settings', { headers }, env)
  assert.equal((await get.json()).selected_model, 'lumen-pro')
})

test('PUT /settings with only onboarding_completed does not clobber a previously set model', async () => {
  const { env, headers } = await setup()
  await app.request('/settings', { method: 'PUT', headers, body: JSON.stringify({ selected_model: 'lumen-pro' }) }, env)
  const res = await app.request('/settings', {
    method: 'PUT', headers, body: JSON.stringify({ onboarding_completed: true }),
  }, env)
  const body = await res.json()
  assert.equal(body.selected_model, 'lumen-pro')
  assert.ok(body.onboarding_completed_at)
})

test('PUT /settings with an empty body is rejected', async () => {
  const { env, headers } = await setup()
  const res = await app.request('/settings', { method: 'PUT', headers, body: JSON.stringify({}) }, env)
  assert.equal(res.status, 400)
})

test('settings are scoped per user', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO user_settings (user_id, selected_model, updated) VALUES (?,?,?)')
    .bind('user-2', 'not-yours', 1).run()
  const res = await app.request('/settings', { headers }, env)
  assert.equal((await res.json()).selected_model, null)
})
