import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import {
  REVIEW_MESSAGE_RETENTION_MS,
  ROUTINE_MESSAGE_RETENTION_MS,
  purgeExpiredMessageLogs,
} from '../src/auditLog.js'

class Statement {
  constructor(database, sql, values = []) {
    this.database = database
    this.sql = sql
    this.values = values
  }
  bind(...values) { return new Statement(this.database, this.sql, values) }
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
        id INTEGER PRIMARY KEY,
        created_at INTEGER NOT NULL,
        review_status TEXT NOT NULL,
        human_review_status TEXT
      );
    `)
  }
  prepare(sql) { return new Statement(this.database, sql) }
  batch(statements) { return statements.map(statement => statement.run()) }
}

test('message retention removes routine rows after 30 days and active findings after one year', async () => {
  const db = new D1TestDatabase()
  const now = Date.UTC(2026, 6, 24)
  const oldRoutine = now - ROUTINE_MESSAGE_RETENTION_MS - 1
  const oldReview = now - REVIEW_MESSAGE_RETENTION_MS - 1
  const recent = now - 1000
  const rows = [
    [1, oldRoutine, 'safe', null],
    [2, oldRoutine, 'error', null],
    [3, oldRoutine, 'flagged', 'dismissed'],
    [4, oldRoutine, 'flagged', 'pending'],
    [5, oldReview, 'flagged', 'pending'],
    [6, oldReview, 'flagged', 'confirmed'],
    [7, oldReview, 'pending', null],
    [8, recent, 'safe', null],
  ]
  for (const row of rows) {
    db.prepare(
      'INSERT INTO message_log (id, created_at, review_status, human_review_status) VALUES (?,?,?,?)'
    ).bind(...row).run()
  }

  const deleted = await purgeExpiredMessageLogs(db, now)

  assert.equal(deleted, 6)
  assert.deepEqual(
    db.prepare('SELECT id FROM message_log ORDER BY id').all().results.map(row => row.id),
    [4, 8],
  )
})
