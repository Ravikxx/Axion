import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

const migration = (name) => fs.readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8')

test('user_settings accepts the same TEXT ids used by users after migration 038', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)')
  db.exec(migration('030_user_settings.sql'))
  db.exec(migration('037_authoritative_onboarding.sql'))
  db.exec(migration('038_user_settings_text_id.sql'))

  const idColumn = db.prepare('PRAGMA table_info(user_settings)').all()
    .find((column) => column.name === 'user_id')
  assert.equal(idColumn?.type, 'TEXT')

  const userId = 'user_01hxyz'
  db.prepare('INSERT INTO users (id) VALUES (?)').run(userId)
  db.prepare(`
    INSERT INTO user_settings (user_id, updated, revision)
    VALUES (?, ?, ?)
  `).run(userId, Date.now(), 1)

  assert.equal(
    db.prepare('SELECT user_id FROM user_settings').get().user_id,
    userId,
  )
})
