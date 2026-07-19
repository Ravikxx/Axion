export const MICRODOLLARS_PER_CENT = 10_000
export const MAX_CREDIT_CENTS = 1_000_000 // $10,000 guardrail against an accidental admin entry
export const MAX_CODE_REDEMPTIONS = 10_000

export class CreditCodeError extends Error {
  constructor(message, code = 'invalid_code') {
    super(message)
    this.name = 'CreditCodeError'
    this.code = code
  }
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase()
}

export function normalizeCreditCode(raw) {
  const normalized = String(raw || '').toUpperCase().replace(/[\s-]+/g, '')
  if (!/^AXION[0-9A-F]{20}$/.test(normalized) && !/^[A-Z0-9]{16}$/.test(normalized)) {
    throw new CreditCodeError('Invalid, expired, or fully redeemed code.')
  }
  return normalized
}

export async function hashCreditCode(raw) {
  const normalized = normalizeCreditCode(raw)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized))
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export function generateCreditCode(compact = false) {
  const bytes = new Uint8Array(10)
  crypto.getRandomValues(bytes)
  if (compact) {
    const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
    let bits = 0
    let value = 0
    let code = ''
    for (const byte of bytes) {
      value = (value << 8) | byte
      bits += 8
      while (bits >= 5) {
        code += alphabet[(value >>> (bits - 5)) & 31]
        bits -= 5
      }
    }
    return code
  }
  const payload = bytesToHex(bytes)
  return `AXION-${payload.match(/.{1,4}/g).join('-')}`
}

export function creditInput(input = {}) {
  const variableAmount = input.variable_amount === true
  const allowRepeat = variableAmount && input.allow_repeat === true
  const unlimitedRedemptions = variableAmount && input.unlimited_redemptions === true
  const creditCents = variableAmount ? 0 : Number(input.credit_cents)
  const maxRedemptions = unlimitedRedemptions ? 0 : (input.max_redemptions == null ? 1 : Number(input.max_redemptions))
  const expiresAt = input.expires_at == null || input.expires_at === '' ? null : Number(input.expires_at)
  const note = String(input.note || '').trim().slice(0, 200)

  if (!variableAmount && (!Number.isInteger(creditCents) || creditCents < 1 || creditCents > MAX_CREDIT_CENTS)) {
    throw new CreditCodeError(`credit_cents must be an integer from 1 to ${MAX_CREDIT_CENTS}.`, 'invalid_input')
  }
  if (!Number.isInteger(maxRedemptions) || maxRedemptions < 0 || maxRedemptions > MAX_CODE_REDEMPTIONS
      || (!unlimitedRedemptions && maxRedemptions < 1)) {
    throw new CreditCodeError(`max_redemptions must be an integer from 1 to ${MAX_CODE_REDEMPTIONS}.`, 'invalid_input')
  }
  if (expiresAt !== null && (!Number.isInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000))) {
    throw new CreditCodeError('expires_at must be a future Unix timestamp.', 'invalid_input')
  }

  return {
    creditCents,
    creditMicrodollars: creditCents * MICRODOLLARS_PER_CENT,
    variableAmount,
    allowRepeat,
    maxCreditMicrodollars: MAX_CREDIT_CENTS * MICRODOLLARS_PER_CENT,
    maxRedemptions,
    expiresAt,
    note,
  }
}

export async function createCreditCode(db, createdBy, input = {}) {
  const values = creditInput(input)
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateCreditCode(values.variableAmount)
    const codeHash = await hashCreditCode(code)
    const id = crypto.randomUUID()
    try {
      await db.prepare(
        `INSERT INTO credit_codes
         (id, code_hash, code_hint, credit_microdollars, variable_amount,
          max_credit_microdollars, allow_repeat, max_redemptions, expires_at, note, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        id,
        codeHash,
        `...${normalizeCreditCode(code).slice(-4)}`,
        values.creditMicrodollars,
        values.variableAmount ? 1 : 0,
        values.maxCreditMicrodollars,
        values.allowRepeat ? 1 : 0,
        values.maxRedemptions,
        values.expiresAt,
        values.note,
        createdBy,
      ).run()
      return {
        id,
        code,
        credit_microdollars: values.creditMicrodollars,
        variable_amount: values.variableAmount,
        allow_repeat: values.allowRepeat,
        max_redemptions: values.maxRedemptions,
        expires_at: values.expiresAt,
        note: values.note,
      }
    } catch (error) {
      if (!/unique|constraint/i.test(error?.message || '') || attempt === 2) throw error
    }
  }
  throw new Error('Could not generate a unique credit code.')
}

export async function redeemCreditCode(db, userId, rawCode, requestedCreditCents = null) {
  const codeHash = await hashCreditCode(rawCode)
  const code = await db.prepare(
    `SELECT id, credit_microdollars, variable_amount, max_credit_microdollars,
            allow_repeat FROM credit_codes WHERE code_hash=?`
  ).bind(codeHash).first()
  if (!code) throw new CreditCodeError('Invalid, expired, or fully redeemed code.')
  let grantedMicrodollars = code.credit_microdollars
  if (code.variable_amount) {
    const cents = Number(requestedCreditCents)
    if (!Number.isInteger(cents) || cents < 1
        || cents * MICRODOLLARS_PER_CENT > code.max_credit_microdollars) {
      throw new CreditCodeError(
        `Choose an amount from $0.01 to $${(code.max_credit_microdollars / 1_000_000).toFixed(2)}.`,
        'amount_required',
      )
    }
    grantedMicrodollars = cents * MICRODOLLARS_PER_CENT
  }

  const redemptionId = crypto.randomUUID()
  const now = Math.floor(Date.now() / 1000)
  await db.batch([
    db.prepare(
      `INSERT INTO credit_redemptions (id, code_id, user_id, credit_microdollars, repeatable, redeemed_at)
       SELECT ?, id, ?, ?, allow_repeat, ?
       FROM credit_codes
       WHERE id=? AND active=1
         AND (expires_at IS NULL OR expires_at>?)
         AND (max_redemptions=0 OR redemption_count<max_redemptions)
         AND (allow_repeat=1 OR NOT EXISTS (
           SELECT 1 FROM credit_redemptions WHERE code_id=credit_codes.id AND user_id=?
         ))
       ON CONFLICT DO NOTHING`
    ).bind(redemptionId, userId, grantedMicrodollars, now, code.id, now, userId),
    db.prepare(
      `UPDATE credit_codes SET redemption_count=redemption_count+1
       WHERE id=? AND EXISTS (SELECT 1 FROM credit_redemptions WHERE id=?)`
    ).bind(code.id, redemptionId),
    db.prepare(
      `UPDATE users
       SET credit_balance=credit_balance+(
         SELECT credit_microdollars FROM credit_redemptions WHERE id=?
       )
       WHERE id=? AND EXISTS (SELECT 1 FROM credit_redemptions WHERE id=?)`
    ).bind(redemptionId, userId, redemptionId),
  ])

  const redemption = await db.prepare(
    'SELECT credit_microdollars, redeemed_at FROM credit_redemptions WHERE id=?'
  ).bind(redemptionId).first()
  if (!redemption) {
    const previous = await db.prepare(
      'SELECT 1 AS redeemed FROM credit_redemptions WHERE code_id=? AND user_id=?'
    ).bind(code.id, userId).first()
    if (previous && !code.allow_repeat) throw new CreditCodeError('You already redeemed this code.', 'already_redeemed')
    throw new CreditCodeError('Invalid, expired, or fully redeemed code.')
  }

  const user = await db.prepare('SELECT credit_balance FROM users WHERE id=?').bind(userId).first()
  return {
    granted_microdollars: redemption.credit_microdollars,
    balance_microdollars: user?.credit_balance || 0,
    redeemed_at: redemption.redeemed_at,
  }
}

export async function listCreditCodes(db) {
  const { results } = await db.prepare(
    `SELECT id, code_hint, credit_microdollars, variable_amount, allow_repeat,
            max_redemptions, redemption_count, expires_at, active, note, created_by, created_at
     FROM credit_codes ORDER BY created_at DESC LIMIT 100`
  ).all()
  return results
}

export async function deactivateCreditCode(db, id) {
  return db.prepare('UPDATE credit_codes SET active=0 WHERE id=?').bind(id).run()
}

export function splitUsageCost(cost, includedMonthCost, includedWindowCost, monthlyBudget, windowBudget) {
  const safeCost = Math.max(0, Math.round(Number(cost) || 0))
  const monthRemaining = Math.max(0, monthlyBudget - (Number(includedMonthCost) || 0))
  const windowRemaining = Math.max(0, windowBudget - (Number(includedWindowCost) || 0))
  const included = Math.min(safeCost, monthRemaining, windowRemaining)
  return { included, credits: safeCost - included, monthRemaining, windowRemaining }
}

export async function ensureUsagePeriods(db, userId, month, windowStart) {
  await db.prepare(
    `UPDATE users SET
       included_month_cost=CASE WHEN usage_month=? THEN included_month_cost ELSE 0 END,
       usage_month=?,
       included_window_cost=CASE WHEN usage_window=? THEN included_window_cost ELSE 0 END,
       usage_window=?
     WHERE id=?`
  ).bind(month, month, windowStart, windowStart, userId).run()
  return db.prepare(
    `SELECT credit_balance, included_month_cost, included_window_cost,
            usage_month, usage_window, usage_limit_notified
     FROM users WHERE id=?`
  ).bind(userId).first()
}

export function canStartUsage(usage, monthlyBudget, windowBudget) {
  const split = splitUsageCost(1, usage?.included_month_cost, usage?.included_window_cost, monthlyBudget, windowBudget)
  return split.included > 0 || (usage?.credit_balance || 0) > 0
}

export async function chargeAccountUsage(db, userId, cost, monthlyBudget, windowBudget, month, windowStart) {
  await ensureUsagePeriods(db, userId, month, windowStart)
  const amount = Math.max(0, Math.round(Number(cost) || 0))
  await db.prepare(
    `UPDATE users SET
       included_month_cost=included_month_cost + MIN(?, MAX(0, ?-included_month_cost), MAX(0, ?-included_window_cost)),
       included_window_cost=included_window_cost + MIN(?, MAX(0, ?-included_month_cost), MAX(0, ?-included_window_cost)),
       credit_balance=credit_balance - (?-MIN(?, MAX(0, ?-included_month_cost), MAX(0, ?-included_window_cost)))
     WHERE id=?`
  ).bind(
    amount, monthlyBudget, windowBudget,
    amount, monthlyBudget, windowBudget,
    amount, amount, monthlyBudget, windowBudget,
    userId,
  ).run()
  return db.prepare(
    'SELECT credit_balance, included_month_cost, included_window_cost, usage_limit_notified FROM users WHERE id=?'
  ).bind(userId).first()
}

export function microdollarsToUsd(value) {
  return Number(((Number(value) || 0) / 1_000_000).toFixed(4))
}

export function buildSquareCheckoutPayload({
  idempotencyKey,
  locationId,
  planVariationId,
  itemVariationId,
  buyerEmail,
  redirectUrl,
}) {
  return {
    idempotency_key: idempotencyKey,
    checkout_options: {
      subscription_plan_id: planVariationId,
      redirect_url: redirectUrl,
      enable_coupon: true,
    },
    order: {
      location_id: locationId,
      line_items: [{ quantity: '1', catalog_object_id: itemVariationId }],
    },
    pre_populated_data: { buyer_email: buyerEmail },
  }
}
