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
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL
      );
      CREATE TABLE chats (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT 'New chat',
        updated INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE cloud_tasks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        project_id TEXT,
        chat_id TEXT,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        error TEXT,
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL,
        completed INTEGER
      );
      CREATE TABLE cloud_task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT,
        data TEXT,
        created INTEGER NOT NULL
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

const SECRET = 'cloud-tasks-test-secret'

async function setup() {
  const db = new D1TestDatabase()
  db.prepare('INSERT INTO users (id, email) VALUES (?,?)').bind('user-1', 'a@example.com').run()
  db.prepare('INSERT INTO users (id, email) VALUES (?,?)').bind('user-2', 'b@example.com').run()
  const token = await sessionToken('user-1', SECRET)
  const env = { DB: db, TOKEN_SECRET: SECRET }
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  return { db, env, headers }
}

test('POST /cloud-tasks creates a queued task and logs a created event', async () => {
  const { env, headers } = await setup()
  const res = await app.request('/cloud-tasks', {
    method: 'POST', headers, body: JSON.stringify({ title: 'Migrate the dataset' }),
  }, env)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.title, 'Migrate the dataset')
  assert.equal(body.status, 'queued')
  assert.equal(body.project_id, null)
  assert.equal(body.chat_id, null)

  const get = await app.request(`/cloud-tasks/${body.id}`, { headers }, env)
  const task = await get.json()
  assert.equal(task.events.length, 1)
  assert.equal(task.events[0].type, 'created')
})

test('POST /cloud-tasks without a title is rejected', async () => {
  const { env, headers } = await setup()
  const res = await app.request('/cloud-tasks', {
    method: 'POST', headers, body: JSON.stringify({}),
  }, env)
  assert.equal(res.status, 400)
})

test('POST /cloud-tasks rejects a project_id or chat_id the caller does not own', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO projects (id, user_id, name, created, updated) VALUES (?,?,?,?,?)')
    .bind('proj-other', 'user-2', 'Someone else\'s project', 1, 1).run()

  const res = await app.request('/cloud-tasks', {
    method: 'POST', headers, body: JSON.stringify({ title: 'X', project_id: 'proj-other' }),
  }, env)
  assert.equal(res.status, 404)
})

test('GET /cloud-tasks lists only the caller\'s own tasks, most recently updated first', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO cloud_tasks (id, user_id, title, status, created, updated) VALUES (?,?,?,?,?,?)')
    .bind('t-mine-old', 'user-1', 'Older', 'queued', 1, 1).run()
  db.prepare('INSERT INTO cloud_tasks (id, user_id, title, status, created, updated) VALUES (?,?,?,?,?,?)')
    .bind('t-mine-new', 'user-1', 'Newer', 'queued', 2, 2).run()
  db.prepare('INSERT INTO cloud_tasks (id, user_id, title, status, created, updated) VALUES (?,?,?,?,?,?)')
    .bind('t-other', 'user-2', 'Not mine', 'queued', 3, 3).run()

  const res = await app.request('/cloud-tasks', { headers }, env)
  const body = await res.json()
  assert.deepEqual(body.tasks.map(t => t.id), ['t-mine-new', 't-mine-old'])
})

test('PATCH /cloud-tasks/:id transitions status, stamps completed, and logs a status_changed event', async () => {
  const { db, env, headers } = await setup()
  const create = await app.request('/cloud-tasks', {
    method: 'POST', headers, body: JSON.stringify({ title: 'Run the thing' }),
  }, env)
  const { id } = await create.json()

  const patch = await app.request(`/cloud-tasks/${id}`, {
    method: 'PATCH', headers, body: JSON.stringify({ status: 'running' }),
  }, env)
  assert.equal(patch.status, 200)

  let row = db.prepare('SELECT status, completed FROM cloud_tasks WHERE id=?').bind(id).first()
  assert.equal(row.status, 'running')
  assert.equal(row.completed, null)

  await app.request(`/cloud-tasks/${id}`, {
    method: 'PATCH', headers, body: JSON.stringify({ status: 'completed' }),
  }, env)
  row = db.prepare('SELECT status, completed FROM cloud_tasks WHERE id=?').bind(id).first()
  assert.equal(row.status, 'completed')
  assert.ok(row.completed > 0)

  const events = db.prepare('SELECT type, message FROM cloud_task_events WHERE task_id=? ORDER BY created ASC').bind(id).all().results
  assert.deepEqual(events.map(e => e.type), ['created', 'status_changed', 'status_changed'])
  assert.equal(events[2].message, 'running -> completed')
})

test('PATCH /cloud-tasks/:id rejects an invalid status', async () => {
  const { env, headers } = await setup()
  const create = await app.request('/cloud-tasks', {
    method: 'POST', headers, body: JSON.stringify({ title: 'X' }),
  }, env)
  const { id } = await create.json()

  const res = await app.request(`/cloud-tasks/${id}`, {
    method: 'PATCH', headers, body: JSON.stringify({ status: 'not-a-real-status' }),
  }, env)
  assert.equal(res.status, 400)
})

test('a user cannot PATCH or DELETE another user\'s task', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO cloud_tasks (id, user_id, title, status, created, updated) VALUES (?,?,?,?,?,?)')
    .bind('t-other', 'user-2', 'Not mine', 'queued', 1, 1).run()

  const patch = await app.request('/cloud-tasks/t-other', {
    method: 'PATCH', headers, body: JSON.stringify({ status: 'running' }),
  }, env)
  assert.equal(patch.status, 404)

  const del = await app.request('/cloud-tasks/t-other', { method: 'DELETE', headers }, env)
  assert.equal(del.status, 404)

  const stillThere = db.prepare('SELECT id FROM cloud_tasks WHERE id=?').bind('t-other').first()
  assert.ok(stillThere)
})

test('POST /cloud-tasks/:id/events appends a custom event with structured data', async () => {
  const { db, env, headers } = await setup()
  const create = await app.request('/cloud-tasks', {
    method: 'POST', headers, body: JSON.stringify({ title: 'X' }),
  }, env)
  const { id } = await create.json()

  const res = await app.request(`/cloud-tasks/${id}/events`, {
    method: 'POST', headers,
    body: JSON.stringify({ type: 'log', message: 'Cloning repo', data: { step: 1, of: 3 } }),
  }, env)
  assert.equal(res.status, 201)
  const event = await res.json()
  assert.equal(event.type, 'log')
  assert.deepEqual(event.data, { step: 1, of: 3 })

  const get = await app.request(`/cloud-tasks/${id}`, { headers }, env)
  const task = await get.json()
  assert.equal(task.events.length, 2)
  assert.deepEqual(task.events[1].data, { step: 1, of: 3 })
})

test('POST /cloud-tasks/:id/events without a type is rejected', async () => {
  const { env, headers } = await setup()
  const create = await app.request('/cloud-tasks', {
    method: 'POST', headers, body: JSON.stringify({ title: 'X' }),
  }, env)
  const { id } = await create.json()

  const res = await app.request(`/cloud-tasks/${id}/events`, {
    method: 'POST', headers, body: JSON.stringify({ message: 'no type' }),
  }, env)
  assert.equal(res.status, 400)
})

test('DELETE /cloud-tasks/:id removes the task and its events', async () => {
  const { db, env, headers } = await setup()
  const create = await app.request('/cloud-tasks', {
    method: 'POST', headers, body: JSON.stringify({ title: 'X' }),
  }, env)
  const { id } = await create.json()

  const del = await app.request(`/cloud-tasks/${id}`, { method: 'DELETE', headers }, env)
  assert.equal(del.status, 200)

  assert.equal(db.prepare('SELECT id FROM cloud_tasks WHERE id=?').bind(id).first(), null)
  assert.equal(db.prepare('SELECT id FROM cloud_task_events WHERE task_id=?').bind(id).all().results.length, 0)
})

test('unauthenticated requests are rejected on every cloud-task endpoint', async () => {
  const { env } = await setup()
  const noAuth = { 'Content-Type': 'application/json' }
  assert.equal((await app.request('/cloud-tasks', { headers: noAuth }, env)).status, 401)
  assert.equal((await app.request('/cloud-tasks', { method: 'POST', headers: noAuth, body: '{}' }, env)).status, 401)
  assert.equal((await app.request('/cloud-tasks/x', { headers: noAuth }, env)).status, 401)
  assert.equal((await app.request('/cloud-tasks/x', { method: 'PATCH', headers: noAuth, body: '{}' }, env)).status, 401)
  assert.equal((await app.request('/cloud-tasks/x', { method: 'DELETE', headers: noAuth }, env)).status, 401)
  assert.equal((await app.request('/cloud-tasks/x/events', { method: 'POST', headers: noAuth, body: '{}' }, env)).status, 401)
})
