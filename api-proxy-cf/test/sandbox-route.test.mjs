import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import app from '../src/index.js'

// Minimal D1 mock — just enough for /v1/sandbox/execute's auth + usage path.
// Not reusing billing.test.mjs's D1TestDatabase to avoid cross-file coupling;
// small enough to duplicate (same judgment call already made elsewhere in
// this test suite).
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
    return { meta: { changes: Number(result.changes) } }
  }
}

class D1TestDatabase {
  constructor() {
    this.database = new DatabaseSync(':memory:')
    this.database.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        banned INTEGER NOT NULL DEFAULT 0,
        plan TEXT NOT NULL DEFAULT 'free',
        sandbox_week_count INTEGER NOT NULL DEFAULT 0,
        sandbox_week_start TEXT NOT NULL DEFAULT '',
        sandbox_mode TEXT NOT NULL DEFAULT 'ask'
      );
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        key_value TEXT UNIQUE NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0
      );
    `)
  }
  prepare(sql) { return new Statement(this.database, sql) }
}

function addUser(db, id, overrides = {}) {
  db.prepare('INSERT INTO users (id, email) VALUES (?,?)').bind(id, `${id}@example.com`).run()
  for (const [col, val] of Object.entries(overrides)) {
    db.prepare(`UPDATE users SET ${col}=? WHERE id=?`).bind(val, id).run()
  }
}

async function sessionToken(uid, secret) {
  const payload = btoa(JSON.stringify({ uid, v: 0, exp: Date.now() + 60_000 }))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
  return `${payload}.${sigB64}`
}

function daytonaFetchStub() {
  return async (url, options) => {
    if (url === 'https://app.daytona.io/api/sandbox' && options.method === 'POST') {
      return Response.json({ id: 'sb-route-test', state: 'started' })
    }
    if (url.includes('/process/code-run')) {
      return Response.json({ exitCode: 0, result: '2\n' })
    }
    if (options.method === 'DELETE') {
      return Response.json({ id: 'sb-route-test', state: 'destroying' })
    }
    throw new Error(`unexpected fetch in route test: ${url}`)
  }
}

test('anonymous requests (no auth header at all) are rejected with 403', async () => {
  const db = new D1TestDatabase()
  const response = await app.request('/v1/sandbox/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'print(1)' }),
  }, { DB: db })
  assert.equal(response.status, 403)
  assert.match((await response.json()).error.message, /signed-in account or API key/)
})

test('a banned session-token account is rejected (requireAuth already filters banned users to null, same as /v1/chat/completions — so this is a 401, not a 403)', async () => {
  const db = new D1TestDatabase()
  const secret = 'sandbox-route-secret'
  addUser(db, 'banned-user', { banned: 1 })
  const token = await sessionToken('banned-user', secret)
  const response = await app.request('/v1/sandbox/execute', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'print(1)' }),
  }, { DB: db, TOKEN_SECRET: secret })
  assert.equal(response.status, 401)
})

test('a banned account using an API key (not pre-filtered by requireAuth) hits the route\'s own banned check and gets 403', async () => {
  const db = new D1TestDatabase()
  addUser(db, 'banned-keyholder', { banned: 1 })
  db.prepare('INSERT INTO api_keys (id, user_id, key_value) VALUES (?,?,?)').bind('k1', 'banned-keyholder', 'axion-sk-banned').run()
  const response = await app.request('/v1/sandbox/execute', {
    method: 'POST',
    headers: { Authorization: 'Bearer axion-sk-banned', 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'print(1)' }),
  }, { DB: db })
  assert.equal(response.status, 403)
})

test('a successful execution runs the sandbox and increments the weekly count', async () => {
  const db = new D1TestDatabase()
  const secret = 'sandbox-route-secret'
  addUser(db, 'member')
  const token = await sessionToken('member', secret)
  const env = { DB: db, TOKEN_SECRET: secret, DAYTONA_API_KEY: 'dtn-test' }

  const realFetch = globalThis.fetch
  globalThis.fetch = daytonaFetchStub()
  try {
    const response = await app.request('/v1/sandbox/execute', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'print(1+1)' }),
    }, env)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.stdout, '2\n')
    assert.equal(body.exit_code, 0)
    assert.equal(body.cap_exceeded, undefined)
  } finally {
    globalThis.fetch = realFetch
  }

  const row = db.prepare('SELECT sandbox_week_count FROM users WHERE id=?').bind('member').first()
  assert.equal(row.sandbox_week_count, 1)
})

test('hitting the weekly cap returns 200 with cap_exceeded:true instead of a hard error, and does not call Daytona', async () => {
  const db = new D1TestDatabase()
  const secret = 'sandbox-route-secret'
  const nowIso = new Date().toISOString()
  addUser(db, 'capped', { sandbox_week_count: 10, sandbox_week_start: nowIso }) // free cap is 10/week
  const token = await sessionToken('capped', secret)
  const env = { DB: db, TOKEN_SECRET: secret, DAYTONA_API_KEY: 'dtn-test' }

  let fetchCalled = false
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('should not reach Daytona') }
  try {
    const response = await app.request('/v1/sandbox/execute', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'print(1)' }),
    }, env)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.cap_exceeded, true)
    assert.match(body.message, /Weekly sandbox execution limit reached/)
  } finally {
    globalThis.fetch = realFetch
  }
  assert.equal(fetchCalled, false)
})

test('a valid axion-sk- API key can also use the sandbox (not just session tokens)', async () => {
  const db = new D1TestDatabase()
  addUser(db, 'keyholder')
  db.prepare('INSERT INTO api_keys (id, user_id, key_value) VALUES (?,?,?)').bind('k1', 'keyholder', 'axion-sk-test123').run()
  const env = { DB: db, DAYTONA_API_KEY: 'dtn-test' }

  const realFetch = globalThis.fetch
  globalThis.fetch = daytonaFetchStub()
  try {
    const response = await app.request('/v1/sandbox/execute', {
      method: 'POST',
      headers: { Authorization: 'Bearer axion-sk-test123', 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'print(1)' }),
    }, env)
    assert.equal(response.status, 200)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('missing "code" in the request body is a 400, not a crash', async () => {
  const db = new D1TestDatabase()
  const secret = 'sandbox-route-secret'
  addUser(db, 'member')
  const token = await sessionToken('member', secret)
  const response = await app.request('/v1/sandbox/execute', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }, { DB: db, TOKEN_SECRET: secret })
  assert.equal(response.status, 400)
})
