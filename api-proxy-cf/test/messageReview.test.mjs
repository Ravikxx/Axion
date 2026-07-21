import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { reviewPendingMessages } from '../src/messageReview.js'

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
      CREATE TABLE message_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        api_key_id TEXT,
        ip TEXT NOT NULL,
        auth_type TEXT NOT NULL,
        model TEXT,
        request_messages TEXT NOT NULL,
        response_text TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        review_status TEXT NOT NULL DEFAULT 'pending',
        reviewed_at INTEGER,
        review_notes TEXT
      );
    `)
  }
  prepare(sql) { return new Statement(this.database, sql) }
}

function addLogRow(db, { userId = null, ip = '1.2.3.4', authType = 'anonymous', requestMessages, responseText = '' }) {
  db.prepare('INSERT INTO message_log (user_id, ip, auth_type, request_messages, response_text, created_at) VALUES (?,?,?,?,?,?)')
    .bind(userId, ip, authType, JSON.stringify(requestMessages), responseText, Date.now()).run()
}

function lumenFetchStub(verdict) {
  return async (url, options) => {
    const body = JSON.parse(options.body)
    return Response.json({
      choices: [{ index: 0, message: { role: 'assistant', content: verdict }, finish_reason: 'stop' }],
      model: body.model,
    })
  }
}

const env = { DAYTONA_API_KEY: 'unused', RUNPOD_ENDPOINT_ID: 'ep-test', RUNPOD_API_KEY: 'rp-test-key' }

test('a SAFE verdict marks the row safe and is not included in flagged[]', async () => {
  const db = new D1TestDatabase()
  addLogRow(db, { requestMessages: [{ role: 'user', content: 'whats 2+2' }], responseText: '4' })

  const result = await reviewPendingMessages({ DB: db }, lumenFetchStub('SAFE'), 10)
  assert.equal(result.reviewedCount, 1)
  assert.equal(result.flagged.length, 0)

  const row = db.prepare('SELECT review_status, review_notes FROM message_log WHERE id=1').first()
  assert.equal(row.review_status, 'safe')
  assert.equal(row.review_notes, '')
})

test('a FLAG verdict marks the row flagged, extracts the reason, and includes it in flagged[]', async () => {
  const db = new D1TestDatabase()
  addLogRow(db, { userId: 'u1', ip: '9.9.9.9', authType: 'session', requestMessages: [{ role: 'user', content: 'bad thing' }], responseText: 'refused' })

  const result = await reviewPendingMessages({ DB: db }, lumenFetchStub('FLAG: possible weapons request'), 10)
  assert.equal(result.flagged.length, 1)
  assert.equal(result.flagged[0].notes, 'possible weapons request')
  assert.equal(result.flagged[0].userId, 'u1')
  assert.equal(result.flagged[0].ip, '9.9.9.9')

  const row = db.prepare('SELECT review_status, review_notes FROM message_log WHERE id=1').first()
  assert.equal(row.review_status, 'flagged')
  assert.equal(row.review_notes, 'possible weapons request')
})

test('an unparseable classifier response defaults to flagged, never silently safe', async () => {
  const db = new D1TestDatabase()
  addLogRow(db, { requestMessages: [{ role: 'user', content: 'hi' }], responseText: 'hello' })

  const result = await reviewPendingMessages({ DB: db }, lumenFetchStub('uh, I guess this seems fine?'), 10)
  assert.equal(result.flagged.length, 1)
  assert.match(result.flagged[0].notes, /Unparseable classifier response/)
})

test('a failed upstream call (non-2xx) defaults to flagged, not safe', async () => {
  const db = new D1TestDatabase()
  addLogRow(db, { requestMessages: [{ role: 'user', content: 'hi' }], responseText: 'hello' })

  const failingFetch = async () => new Response('server error', { status: 500 })
  const result = await reviewPendingMessages({ DB: db }, failingFetch, 10)
  assert.equal(result.flagged.length, 1)
  assert.match(result.flagged[0].notes, /Classifier call failed/)
})

test('only "pending" rows are picked up, and batchSize caps how many run per call', async () => {
  const db = new D1TestDatabase()
  addLogRow(db, { requestMessages: [{ role: 'user', content: 'one' }] })
  addLogRow(db, { requestMessages: [{ role: 'user', content: 'two' }] })
  db.prepare("UPDATE message_log SET review_status='safe' WHERE id=2").run()
  addLogRow(db, { requestMessages: [{ role: 'user', content: 'three' }] })

  const result = await reviewPendingMessages({ DB: db }, lumenFetchStub('SAFE'), 1)
  assert.equal(result.reviewedCount, 1, 'batchSize=1 must only process one pending row')

  const stillPending = db.prepare("SELECT COUNT(*) AS c FROM message_log WHERE review_status='pending'").first()
  assert.equal(stillPending.c, 1, 'row #3 was never touched — id #1 (oldest pending) should have been picked first')
})

test('classification uses the LAST user message in a multi-turn request, not the first', async () => {
  const db = new D1TestDatabase()
  addLogRow(db, {
    requestMessages: [
      { role: 'user', content: 'first turn, irrelevant' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'the actual latest message' },
    ],
    responseText: 'reply to latest',
  })

  let sentUserContent
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body)
    sentUserContent = body.messages.find(m => m.role === 'user' && m.content.includes('USER MESSAGE'))?.content
    return Response.json({ choices: [{ message: { content: 'SAFE' } }] })
  }
  await reviewPendingMessages({ DB: db }, fetchImpl, 10)
  assert.match(sentUserContent, /the actual latest message/)
  assert.doesNotMatch(sentUserContent, /first turn, irrelevant/)
})
