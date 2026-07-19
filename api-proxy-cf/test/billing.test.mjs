import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  CreditCodeError,
  buildSquareCheckoutPayload,
  canStartUsage,
  chargeAccountUsage,
  createCreditCode,
  normalizeCreditCode,
  redeemCreditCode,
} from '../src/billing.js'
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
    return { meta: { changes: Number(result.changes) } }
  }
}

class D1TestDatabase {
  constructor() {
    this.database = new DatabaseSync(':memory:')
    this.database.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        pw_hash TEXT NOT NULL DEFAULT '',
        verified INTEGER NOT NULL DEFAULT 1,
        banned INTEGER NOT NULL DEFAULT 0,
        token_version INTEGER NOT NULL DEFAULT 0,
        plan TEXT NOT NULL DEFAULT 'free',
        plan_updated_at INTEGER,
        google_id TEXT,
        github_id TEXT,
        discord_id TEXT,
        credit_balance INTEGER NOT NULL DEFAULT 0,
        included_month_cost INTEGER NOT NULL DEFAULT 0,
        usage_month TEXT NOT NULL DEFAULT '',
        included_window_cost INTEGER NOT NULL DEFAULT 0,
        usage_window TEXT NOT NULL DEFAULT '',
        usage_limit_notified TEXT DEFAULT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE TABLE credit_codes (
        id TEXT PRIMARY KEY,
        code_hash TEXT UNIQUE NOT NULL,
        code_hint TEXT NOT NULL,
        credit_microdollars INTEGER NOT NULL,
        variable_amount INTEGER NOT NULL DEFAULT 0,
        max_credit_microdollars INTEGER NOT NULL DEFAULT 10000000000,
        allow_repeat INTEGER NOT NULL DEFAULT 0,
        max_redemptions INTEGER NOT NULL DEFAULT 1,
        redemption_count INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER,
        active INTEGER NOT NULL DEFAULT 1,
        note TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE TABLE credit_redemptions (
        id TEXT PRIMARY KEY,
        code_id TEXT NOT NULL REFERENCES credit_codes(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        credit_microdollars INTEGER NOT NULL,
        repeatable INTEGER NOT NULL DEFAULT 0,
        redeemed_at INTEGER NOT NULL,
        CHECK (credit_microdollars > 0)
      );
      CREATE UNIQUE INDEX credit_redemptions_once
        ON credit_redemptions(code_id, user_id) WHERE repeatable=0;
      CREATE TABLE rate_limits (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0,
        window_start INTEGER NOT NULL
      );
      CREATE TABLE admin_allowlist (
        email TEXT PRIMARY KEY,
        added_by TEXT NOT NULL DEFAULT '',
        added_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        requests INTEGER NOT NULL DEFAULT 0,
        revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE admin_account_edits (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        admin_email TEXT NOT NULL,
        previous_plan TEXT NOT NULL,
        new_plan TEXT NOT NULL,
        previous_month_cost INTEGER NOT NULL,
        new_month_cost INTEGER NOT NULL,
        previous_window_cost INTEGER NOT NULL,
        new_window_cost INTEGER NOT NULL,
        previous_credit_balance INTEGER NOT NULL,
        new_credit_balance INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `)
  }

  prepare(sql) { return new Statement(this.database, sql) }
  batch(statements) {
    this.database.exec('BEGIN IMMEDIATE')
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

function addUser(db, id) {
  db.prepare('INSERT INTO users (id, email) VALUES (?,?)').bind(id, `${id}@example.com`).run()
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

test('credit codes are normalized but plaintext is never stored', async () => {
  const db = new D1TestDatabase()
  addUser(db, 'u1')
  const created = await createCreditCode(db, 'admin@example.com', {
    credit_cents: 500,
    max_redemptions: 1,
    note: 'Launch credit',
  })
  assert.match(created.code, /^AXION-(?:[0-9A-F]{4}-){4}[0-9A-F]{4}$/)
  assert.equal(normalizeCreditCode(created.code.toLowerCase()), created.code.replaceAll('-', ''))
  const stored = db.prepare('SELECT * FROM credit_codes WHERE id=?').bind(created.id).first()
  assert.equal(stored.credit_microdollars, 5_000_000)
  assert.equal(stored.code_hint, `...${normalizeCreditCode(created.code).slice(-4)}`)
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(created.code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('redemption is one-time per account and respects the global redemption cap', async () => {
  const db = new D1TestDatabase()
  for (const id of ['u1', 'u2', 'u3']) addUser(db, id)
  const created = await createCreditCode(db, 'admin@example.com', {
    credit_cents: 250,
    max_redemptions: 2,
  })

  const first = await redeemCreditCode(db, 'u1', created.code)
  assert.equal(first.granted_microdollars, 2_500_000)
  assert.equal(first.balance_microdollars, 2_500_000)
  await assert.rejects(
    redeemCreditCode(db, 'u1', created.code),
    error => error instanceof CreditCodeError && error.code === 'already_redeemed',
  )
  await redeemCreditCode(db, 'u2', created.code)
  await assert.rejects(redeemCreditCode(db, 'u3', created.code), /Invalid, expired, or fully redeemed/)
  const stored = db.prepare('SELECT redemption_count FROM credit_codes WHERE id=?').bind(created.id).first()
  assert.equal(stored.redemption_count, 2)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM credit_redemptions').first().count, 2)
})

test('competing redemptions cannot overrun a one-use code', async () => {
  const db = new D1TestDatabase()
  addUser(db, 'u1')
  addUser(db, 'u2')
  const created = await createCreditCode(db, 'admin@example.com', {
    credit_cents: 100,
    max_redemptions: 1,
  })
  const results = await Promise.allSettled([
    redeemCreditCode(db, 'u1', created.code),
    redeemCreditCode(db, 'u2', created.code),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected').length, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM credit_redemptions').first().count, 1)
  assert.equal(db.prepare('SELECT redemption_count FROM credit_codes').first().redemption_count, 1)
})

test('a compact variable code accepts exact mills and can be reused without a global cap', async () => {
  const db = new D1TestDatabase()
  addUser(db, 'u1')
  const created = await createCreditCode(db, 'admin@example.com', {
    variable_amount: true,
    allow_repeat: true,
    unlimited_redemptions: true,
    note: 'Variable master credit',
  })
  assert.match(created.code, /^[A-Z0-9]{16}$/)
  assert.equal(created.max_redemptions, 0)
  assert.equal(created.variable_amount, true)

  await assert.rejects(
    redeemCreditCode(db, 'u1', created.code),
    error => error instanceof CreditCodeError && error.code === 'amount_required',
  )
  await assert.rejects(
    redeemCreditCode(db, 'u1', created.code, 999),
    error => error instanceof CreditCodeError && error.code === 'amount_required',
  )
  await assert.rejects(
    redeemCreditCode(db, 'u1', created.code, 1_500),
    error => error instanceof CreditCodeError && error.code === 'amount_required',
  )
  const first = await redeemCreditCode(db, 'u1', created.code, 1_000)
  const second = await redeemCreditCode(db, 'u1', created.code, 456_000)
  assert.equal(first.granted_microdollars, 1_000)
  assert.equal(second.granted_microdollars, 456_000)
  assert.equal(second.balance_microdollars, 457_000)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM credit_redemptions').first().count, 2)
  assert.equal(db.prepare('SELECT redemption_count FROM credit_codes').first().redemption_count, 2)
})

test('included usage is consumed before credits and resets by account period', async () => {
  const db = new D1TestDatabase()
  addUser(db, 'u1')
  db.prepare('UPDATE users SET credit_balance=? WHERE id=?').bind(100_000, 'u1').run()

  let usage = await chargeAccountUsage(db, 'u1', 30_000, 500_000, 50_000, '2026-07', 'window-a')
  assert.equal(usage.included_month_cost, 30_000)
  assert.equal(usage.included_window_cost, 30_000)
  assert.equal(usage.credit_balance, 100_000)

  usage = await chargeAccountUsage(db, 'u1', 30_000, 500_000, 50_000, '2026-07', 'window-a')
  assert.equal(usage.included_month_cost, 50_000)
  assert.equal(usage.included_window_cost, 50_000)
  assert.equal(usage.credit_balance, 90_000)

  usage = await chargeAccountUsage(db, 'u1', 100_000, 500_000, 50_000, '2026-07', 'window-a')
  assert.equal(usage.credit_balance, -10_000)
  assert.equal(canStartUsage(usage, 500_000, 50_000), false)

  usage = await chargeAccountUsage(db, 'u1', 10_000, 500_000, 50_000, '2026-07', 'window-b')
  assert.equal(usage.included_month_cost, 60_000)
  assert.equal(usage.included_window_cost, 10_000)
  assert.equal(usage.credit_balance, -10_000)
  assert.equal(canStartUsage(usage, 500_000, 50_000), true)

  usage = await chargeAccountUsage(db, 'u1', 5_000, 500_000, 50_000, '2026-08', 'window-c')
  assert.equal(usage.included_month_cost, 5_000)
  assert.equal(usage.included_window_cost, 5_000)
})

test('Square checkout explicitly enables Marketing coupon entry', () => {
  const payload = buildSquareCheckoutPayload({
    idempotencyKey: 'request-1',
    locationId: 'location',
    planVariationId: 'plan',
    itemVariationId: 'item',
    buyerEmail: 'buyer@example.com',
    redirectUrl: 'https://example.com/settings',
  })
  assert.equal(payload.checkout_options.enable_coupon, true)
  assert.equal(payload.checkout_options.subscription_plan_id, 'plan')
  assert.equal(payload.pre_populated_data.buyer_email, 'buyer@example.com')
  assert.equal(payload.order.line_items[0].catalog_object_id, 'item')
})

test('authenticated admin creation and user redemption routes work end to end', async () => {
  const db = new D1TestDatabase()
  const secret = 'route-test-secret'
  addUser(db, 'admin')
  addUser(db, 'member')
  db.prepare('INSERT INTO admin_allowlist (email, added_by) VALUES (?,?)')
    .bind('admin@example.com', 'test')
    .run()
  const adminToken = await sessionToken('admin', secret)
  const memberToken = await sessionToken('member', secret)
  const env = { DB: db, TOKEN_SECRET: secret }

  const createResponse = await app.request('/admin/credit-codes', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ credit_cents: 375, max_redemptions: 1, note: 'Route test' }),
  }, env)
  assert.equal(createResponse.status, 201)
  const created = await createResponse.json()
  assert.match(created.code, /^AXION-/)
  assert.equal(created.credit_usd, 3.75)

  const redeem = () => app.request('/billing/credits/redeem', {
    method: 'POST',
    headers: { Authorization: `Bearer ${memberToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: created.code }),
  }, env)
  const redeemResponse = await redeem()
  assert.equal(redeemResponse.status, 200)
  assert.deepEqual(await redeemResponse.json(), {
    ok: true,
    granted_usd: 3.75,
    balance_usd: 3.75,
  })
  assert.equal((await redeem()).status, 400)

  const balanceResponse = await app.request('/billing/credits', {
    headers: { Authorization: `Bearer ${memberToken}` },
  }, env)
  assert.equal(balanceResponse.status, 200)
  const balance = await balanceResponse.json()
  assert.equal(balance.balance_usd, 3.75)
  assert.equal(balance.redemptions.length, 1)
  assert.equal(balance.redemptions[0].note, 'Route test')

  const variableResponse = await app.request('/admin/credit-codes', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      variable_amount: true,
      allow_repeat: true,
      unlimited_redemptions: true,
      note: 'Mill route test',
    }),
  }, env)
  assert.equal(variableResponse.status, 201)
  const variable = await variableResponse.json()

  const millResponse = await app.request('/billing/credits/redeem', {
    method: 'POST',
    headers: { Authorization: `Bearer ${memberToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: variable.code, credit_microdollars: 1_000 }),
  }, env)
  assert.equal(millResponse.status, 200)
  assert.equal((await millResponse.json()).granted_usd, 0.001)

  const legacyCentResponse = await app.request('/billing/credits/redeem', {
    method: 'POST',
    headers: { Authorization: `Bearer ${memberToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: variable.code, credit_cents: 1 }),
  }, env)
  assert.equal(legacyCentResponse.status, 200)
  assert.equal((await legacyCentResponse.json()).granted_usd, 0.01)

  const disableResponse = await app.request(`/admin/credit-codes/${created.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminToken}` },
  }, env)
  assert.equal(disableResponse.status, 200)
})

test('admin account testing overrides enforce plan limits without rewriting request history', async () => {
  const db = new D1TestDatabase()
  const secret = 'account-testing-secret'
  addUser(db, 'admin')
  addUser(db, 'member')
  db.prepare('INSERT INTO admin_allowlist (email, added_by) VALUES (?,?)')
    .bind('admin@example.com', 'test')
    .run()
  db.prepare('INSERT INTO api_keys (id, user_id, requests) VALUES (?,?,?)')
    .bind('key-1', 'member', 1234)
    .run()
  const adminToken = await sessionToken('admin', secret)
  const memberToken = await sessionToken('member', secret)
  const env = { DB: db, TOKEN_SECRET: secret }
  const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }

  const denied = await app.request('/admin/users/member/account-testing', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${memberToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan: 'pro', included_month_cost: 0, included_window_cost: 0, credit_balance: 0 }),
  }, env)
  assert.equal(denied.status, 403)

  const invalid = await app.request('/admin/users/member/account-testing', {
    method: 'PUT', headers,
    body: JSON.stringify({ plan: 'paid', included_month_cost: -1, included_window_cost: 0, credit_balance: 0 }),
  }, env)
  assert.equal(invalid.status, 400)

  const atLimit = await app.request('/admin/users/member/account-testing', {
    method: 'PUT', headers,
    body: JSON.stringify({
      plan: 'pro',
      included_month_cost: 5_000_000,
      included_window_cost: 500_000,
      credit_balance: 0,
    }),
  }, env)
  assert.equal(atLimit.status, 200)
  const atLimitBody = await atLimit.json()
  assert.equal(atLimitBody.user.plan, 'pro')
  assert.equal(atLimitBody.user.blocked_without_credits, true)
  assert.equal(db.prepare('SELECT requests FROM api_keys WHERE id=?').bind('key-1').first().requests, 1234)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM admin_account_edits').first().count, 1)

  const listResponse = await app.request('/admin/users', {
    headers: { Authorization: `Bearer ${adminToken}` },
  }, env)
  assert.equal(listResponse.status, 200)
  const listed = (await listResponse.json()).users.find(user => user.id === 'member')
  assert.equal(listed.plan, 'pro')
  assert.equal(listed.monthly_used_usd, 5)
  assert.equal(listed.window_used_usd, 0.5)
  assert.equal(listed.total_requests, 1234)

  const reset = await app.request('/admin/users/member/account-testing', {
    method: 'PUT', headers,
    body: JSON.stringify({ plan: 'free', included_month_cost: 0, included_window_cost: 0, credit_balance: 0 }),
  }, env)
  assert.equal(reset.status, 200)
  assert.equal((await reset.json()).user.blocked_without_credits, false)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM admin_account_edits').first().count, 2)
})
