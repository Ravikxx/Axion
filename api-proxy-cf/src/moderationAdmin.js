export class ModerationAdminError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'ModerationAdminError'
    this.status = status
  }
}

function parsedMessages(value) {
  try {
    const messages = JSON.parse(value)
    if (Array.isArray(messages)) return messages
  } catch {}
  return [{ role: 'unknown', content: String(value || '') }]
}

function serializeItem(row) {
  return {
    id: row.id,
    run_id: row.review_run_id,
    user_id: row.user_id,
    email: row.email,
    account_banned: Boolean(row.account_banned),
    account_protected: Boolean(row.account_protected),
    ban_reason: row.ban_reason,
    api_key_id: row.api_key_id,
    ip: row.ip,
    auth_type: row.auth_type,
    model: row.model,
    request_messages: parsedMessages(row.request_messages),
    response_text: row.response_text,
    created_at: row.created_at,
    review_status: row.review_status,
    review_notes: row.review_notes || '',
    human_review_status: row.review_status === 'flagged'
      ? (row.human_review_status || 'pending')
      : null,
    human_reviewed_at: row.human_reviewed_at,
    human_reviewed_by: row.human_reviewed_by,
    account_flagged_count: Number(row.account_flagged_count || 0),
  }
}

const ITEM_SELECT = `
  SELECT ml.id, ml.review_run_id, ml.user_id, u.email,
    u.banned AS account_banned, u.ban_reason,
    CASE WHEN u.email IS NULL THEN 0 ELSE EXISTS(
      SELECT 1 FROM admin_allowlist protected WHERE protected.email=u.email
    ) END AS account_protected,
    ml.api_key_id, ml.ip, ml.auth_type, ml.model,
    ml.request_messages, ml.response_text, ml.created_at,
    ml.review_status, ml.review_notes,
    ml.human_review_status, ml.human_reviewed_at, ml.human_reviewed_by,
    CASE WHEN ml.user_id IS NULL THEN 0 ELSE (
      SELECT COUNT(*) FROM message_log history
      WHERE history.user_id=ml.user_id AND history.review_status='flagged'
    ) END AS account_flagged_count
  FROM message_log ml
  LEFT JOIN users u ON u.id=ml.user_id
`

export async function createModerationRun(db, { trigger, startedBy = null }) {
  if (!['scheduled', 'manual'].includes(trigger)) {
    throw new ModerationAdminError('Invalid moderation run trigger.')
  }
  const id = crypto.randomUUID()
  const startedAt = Date.now()
  await db.prepare(
    `INSERT INTO moderation_runs
     (id, trigger, started_by, status, started_at)
     VALUES (?,?,?,?,?)`
  ).bind(id, trigger, startedBy, 'running', startedAt).run()
  return { id, trigger, started_by: startedBy, started_at: startedAt }
}

export async function completeModerationRun(db, runId, result) {
  const completedAt = Date.now()
  await db.prepare(
    `UPDATE moderation_runs
     SET status='completed', completed_at=?, reviewed_count=?, flagged_count=?, error_count=?
     WHERE id=? AND status='running'`
  ).bind(
    completedAt,
    result.reviewedCount,
    result.flagged.length,
    result.errors.length,
    runId,
  ).run()
  return completedAt
}

export async function failModerationRun(db, runId, error) {
  const notes = String(error?.message || error || 'Unknown moderation run failure').slice(0, 500)
  await db.prepare(
    `UPDATE moderation_runs
     SET status='failed', completed_at=?, failure_notes=?
     WHERE id=? AND status='running'`
  ).bind(Date.now(), notes, runId).run()
}

export async function listModerationRuns(db, limit = 20) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20))
  const { results } = await db.prepare(
    `SELECT id, trigger, started_by, status, started_at, completed_at,
      reviewed_count, flagged_count, error_count, failure_notes
     FROM moderation_runs ORDER BY started_at DESC LIMIT ?`
  ).bind(safeLimit).all()
  return results
}

export async function getModerationRun(db, runId) {
  const run = await db.prepare(
    `SELECT id, trigger, started_by, status, started_at, completed_at,
      reviewed_count, flagged_count, error_count, failure_notes
     FROM moderation_runs WHERE id=?`
  ).bind(runId).first()
  if (!run) throw new ModerationAdminError('Moderation run not found.', 404)

  const { results } = await db.prepare(
    `${ITEM_SELECT}
     WHERE ml.review_run_id=? AND ml.review_status IN ('flagged','error')
     ORDER BY ml.id ASC`
  ).bind(runId).all()
  return {
    run: {
      ...run,
      safe_count: Math.max(0, run.reviewed_count - run.flagged_count - run.error_count),
    },
    items: results.map(serializeItem),
  }
}

export async function getAccountModerationHistory(db, userId) {
  const account = await db.prepare(
    `SELECT id, email, banned, ban_reason, created_at
     FROM users WHERE id=?`
  ).bind(userId).first()
  if (!account) throw new ModerationAdminError('Account not found.', 404)

  const { results } = await db.prepare(
    `${ITEM_SELECT}
     WHERE ml.user_id=? AND ml.review_status='flagged'
     ORDER BY ml.created_at DESC, ml.id DESC`
  ).bind(userId).all()
  return {
    account: {
      ...account,
      banned: Boolean(account.banned),
      flagged_count: results.length,
      confirmed_count: results.filter(row => row.human_review_status === 'confirmed').length,
      dismissed_count: results.filter(row => row.human_review_status === 'dismissed').length,
      pending_count: results.filter(row => !row.human_review_status || row.human_review_status === 'pending').length,
    },
    items: results.map(serializeItem),
  }
}

async function flaggedItem(db, messageId) {
  const row = await db.prepare(
    `${ITEM_SELECT} WHERE ml.id=?`
  ).bind(messageId).first()
  if (!row) throw new ModerationAdminError('Flagged exchange not found.', 404)
  if (row.review_status !== 'flagged') {
    throw new ModerationAdminError('Only automatically flagged exchanges can receive a human decision.', 409)
  }
  return row
}

export async function setModerationDecision(db, {
  messageId,
  decision,
  adminEmail,
}) {
  if (!['dismissed', 'confirmed'].includes(decision)) {
    throw new ModerationAdminError('Decision must be dismissed or confirmed.')
  }
  await flaggedItem(db, messageId)
  const reviewedAt = Date.now()
  await db.prepare(
    `UPDATE message_log
     SET human_review_status=?, human_reviewed_at=?, human_reviewed_by=?
     WHERE id=? AND review_status='flagged'`
  ).bind(decision, reviewedAt, adminEmail, messageId).run()
  const updated = await flaggedItem(db, messageId)
  return serializeItem(updated)
}

export async function banAccountFromModeration(db, {
  messageId,
  adminId,
  adminEmail,
}) {
  const item = await flaggedItem(db, messageId)
  if (!item.user_id || !item.email) {
    throw new ModerationAdminError('This exchange is not attached to an account.', 409)
  }
  if (item.user_id === adminId) {
    throw new ModerationAdminError('You cannot ban your own account from moderation.', 409)
  }
  if (item.account_banned) {
    throw new ModerationAdminError('This account is already banned.', 409)
  }
  const protectedAdmin = await db.prepare(
    'SELECT email FROM admin_allowlist WHERE email=?'
  ).bind(item.email).first()
  if (protectedAdmin) {
    throw new ModerationAdminError('Remove this account from the admin allowlist before banning it.', 409)
  }

  const appealId = crypto.randomUUID()
  const appealToken = crypto.randomUUID()
  const createdAt = Math.floor(Date.now() / 1000)
  const reviewedAt = Date.now()
  const reason = `Confirmed safety violation in message_log #${messageId}.`
  const [banResult] = await db.batch([
    db.prepare(
      `UPDATE users
       SET banned=1, ban_reason=?, token_version=token_version+1
       WHERE id=? AND banned=0`
    ).bind(reason, item.user_id),
    db.prepare(
      `INSERT INTO appeals (id, user_id, email, token, status, created_at)
       SELECT ?,?,?,?,?,?
       WHERE changes()=1`
    ).bind(appealId, item.user_id, item.email, appealToken, 'pending', createdAt),
    db.prepare(
      `UPDATE message_log
       SET human_review_status='confirmed', human_reviewed_at=?, human_reviewed_by=?
       WHERE id=? AND review_status='flagged'`
    ).bind(reviewedAt, adminEmail, messageId),
  ])
  if (!banResult.meta?.changes) {
    throw new ModerationAdminError('This account is already banned.', 409)
  }

  return {
    user_id: item.user_id,
    email: item.email,
    reason,
    appeal_token: appealToken,
  }
}
