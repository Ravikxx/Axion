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

function moderationResult(categories = {}, scores = {}) {
  return {
    categories: {
      sexual: false,
      hate_and_discrimination: false,
      violence_and_threats: false,
      dangerous_and_criminal_content: false,
      selfharm: false,
      health: false,
      financial: false,
      law: false,
      pii: false,
      jailbreaking: false,
      ...categories,
    },
    category_scores: scores,
  }
}

function mistralFetchStub(results, inspect) {
  return async (url, options) => {
    assert.equal(url, 'https://api.mistral.ai/v1/moderations')
    assert.equal(options.headers.Authorization, 'Bearer mistral-test-key')
    const body = JSON.parse(options.body)
    assert.equal(body.model, 'mistral-moderation-2603')
    assert.equal(body.input.length, 2)
    inspect?.(body)
    return Response.json({ id: 'mod-test', model: body.model, results })
  }
}

const envFor = db => ({ DB: db, MISTRAL_API_KEY: 'mistral-test-key' })

test('a clean Mistral moderation result marks the row safe', async () => {
  const db = new D1TestDatabase()
  addLogRow(db, { requestMessages: [{ role: 'user', content: 'whats 2+2' }], responseText: '4' })

  const result = await reviewPendingMessages(
    envFor(db),
    mistralFetchStub([moderationResult(), moderationResult()]),
    10,
  )

  assert.equal(result.reviewedCount, 1)
  assert.equal(result.flagged.length, 0)
  assert.equal(result.errors.length, 0)
  const row = db.prepare('SELECT review_status, review_notes FROM message_log WHERE id=1').first()
  assert.equal(row.review_status, 'safe')
  assert.equal(row.review_notes, '')
})

test('policy categories are attributed to the user and assistant with scores', async () => {
  const db = new D1TestDatabase()
  addLogRow(db, {
    userId: 'u1',
    ip: '9.9.9.9',
    authType: 'session',
    requestMessages: [{ role: 'user', content: 'dangerous request' }],
    responseText: 'unsafe answer',
  })

  const result = await reviewPendingMessages(
    envFor(db),
    mistralFetchStub([
      moderationResult({ dangerous_and_criminal_content: true }, { dangerous_and_criminal_content: 0.92 }),
      moderationResult({ violence_and_threats: true }, { violence_and_threats: 0.81 }),
    ]),
    10,
  )

  assert.equal(result.flagged.length, 1)
  assert.equal(result.errors.length, 0)
  assert.match(result.flagged[0].notes, /user message: dangerous or criminal content \(92%\)/)
  assert.match(result.flagged[0].notes, /assistant reply: violence or threats \(81%\)/)
  assert.equal(result.flagged[0].userId, 'u1')
  assert.equal(result.flagged[0].ip, '9.9.9.9')
  assert.equal(db.prepare('SELECT review_status FROM message_log WHERE id=1').first().review_status, 'flagged')
})

test('non-policy advisory categories do not enter the safety queue', async () => {
  const db = new D1TestDatabase()
  addLogRow(db, { requestMessages: [{ role: 'user', content: 'medical question' }], responseText: 'general information' })

  const result = await reviewPendingMessages(
    envFor(db),
    mistralFetchStub([
      moderationResult({ health: true, financial: true, law: true, pii: true, jailbreaking: true }),
      moderationResult(),
    ]),
    10,
  )

  assert.equal(result.flagged.length, 0)
  assert.equal(result.errors.length, 0)
  assert.equal(db.prepare('SELECT review_status FROM message_log WHERE id=1').first().review_status, 'safe')
})

test('a failed moderation request becomes a review error, not a safety flag', async () => {
  const db = new D1TestDatabase()
  addLogRow(db, { requestMessages: [{ role: 'user', content: 'hi' }], responseText: 'hello' })

  const result = await reviewPendingMessages(
    envFor(db),
    async () => new Response('server error', { status: 500 }),
    10,
  )

  assert.equal(result.flagged.length, 0)
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0].notes, /Mistral moderation call failed/)
  assert.equal(db.prepare('SELECT review_status FROM message_log WHERE id=1').first().review_status, 'error')
})

test('an invalid moderation response becomes a review error', async () => {
  const db = new D1TestDatabase()
  addLogRow(db, { requestMessages: [{ role: 'user', content: 'hi' }], responseText: 'hello' })

  const result = await reviewPendingMessages(
    envFor(db),
    async () => Response.json({ results: [] }),
    10,
  )

  assert.equal(result.flagged.length, 0)
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0].notes, /invalid result shape/)
})

test('only pending rows are selected and batchSize caps each run', async () => {
  const db = new D1TestDatabase()
  addLogRow(db, { requestMessages: [{ role: 'user', content: 'one' }] })
  addLogRow(db, { requestMessages: [{ role: 'user', content: 'two' }] })
  db.prepare("UPDATE message_log SET review_status='safe' WHERE id=2").run()
  addLogRow(db, { requestMessages: [{ role: 'user', content: 'three' }] })

  const result = await reviewPendingMessages(
    envFor(db),
    mistralFetchStub([moderationResult(), moderationResult()]),
    1,
  )

  assert.equal(result.reviewedCount, 1)
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM message_log WHERE review_status='pending'").first().c, 1)
})

test('overlapping review runs only claim and report each row once', async () => {
  const db = new D1TestDatabase()
  addLogRow(db, {
    requestMessages: [{ role: 'user', content: 'dangerous request' }],
    responseText: 'unsafe answer',
  })

  let fetchCount = 0
  let releaseFetches
  const bothFetchesStarted = new Promise(resolve => { releaseFetches = resolve })
  const fetchImpl = async () => {
    fetchCount += 1
    if (fetchCount === 2) releaseFetches()
    await bothFetchesStarted
    return Response.json({
      results: [
        moderationResult({ dangerous_and_criminal_content: true }),
        moderationResult(),
      ],
    })
  }

  const results = await Promise.all([
    reviewPendingMessages(envFor(db), fetchImpl, 10),
    reviewPendingMessages(envFor(db), fetchImpl, 10),
  ])

  assert.equal(fetchCount, 2)
  assert.equal(results.reduce((sum, result) => sum + result.reviewedCount, 0), 1)
  assert.equal(results.reduce((sum, result) => sum + result.flagged.length, 0), 1)
  assert.equal(db.prepare('SELECT review_status FROM message_log WHERE id=1').first().review_status, 'flagged')
})

test('moderation receives the last user message and the stored assistant representation', async () => {
  const db = new D1TestDatabase()
  addLogRow(db, {
    requestMessages: [
      { role: 'user', content: 'first turn, irrelevant' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'the actual latest message' },
    ],
    responseText: '[Tool call: python {"code":"print(\\"hi\\")"}]',
  })

  let sentInput
  await reviewPendingMessages(
    envFor(db),
    mistralFetchStub([moderationResult(), moderationResult()], body => { sentInput = body.input }),
    10,
  )

  assert.equal(sentInput[0], 'the actual latest message')
  assert.match(sentInput[1], /Tool call: python/)
  assert.doesNotMatch(sentInput[0], /first turn/)
})
