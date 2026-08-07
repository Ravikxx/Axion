// Server-side record of every chat completion exchange — separate from the
// `chats` table, which is a mutable reflection of what a user's own web UI
// currently shows. Rows are retained only for the review windows below and
// account deletion redacts routine content before unlinking identity.
//
// Logging failures must never break the actual chat response — this is
// always best-effort from the caller's perspective.
const DAY_MS = 24 * 60 * 60 * 1000
export const ROUTINE_MESSAGE_RETENTION_MS = 30 * DAY_MS
export const REVIEW_MESSAGE_RETENTION_MS = 365 * DAY_MS

function compactToolArguments(value) {
  if (value == null) return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text
}

export function assistantMessageForReview(message) {
  if (!message || typeof message !== 'object') return ''
  const parts = []
  if (typeof message.content === 'string' && message.content.trim()) parts.push(message.content)

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  for (const call of toolCalls) {
    const name = call?.function?.name || call?.name || 'unknown_tool'
    const args = compactToolArguments(call?.function?.arguments ?? call?.arguments)
    parts.push(`[Tool call: ${name}${args ? ` ${args}` : ''}]`)
  }

  if (message.function_call && !toolCalls.length) {
    const name = message.function_call.name || 'unknown_tool'
    const args = compactToolArguments(message.function_call.arguments)
    parts.push(`[Function call: ${name}${args ? ` ${args}` : ''}]`)
  }

  return parts.join('\n\n')
}

export async function logMessageExchange(db, { userId, apiKeyId, ip, authType, model, requestMessages, responseText }) {
  try {
    await db.prepare(
      'INSERT INTO message_log (user_id, api_key_id, ip, auth_type, model, request_messages, response_text, created_at) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(
      userId || null,
      apiKeyId || null,
      ip,
      authType,
      model || null,
      requestMessages,
      responseText || '',
      Date.now(),
    ).run()
  } catch (err) {
    console.error('[auditLog] failed to write message_log row:', err?.message || err)
  }
}

export async function purgeExpiredMessageLogs(db, now = Date.now()) {
  const routineCutoff = now - ROUTINE_MESSAGE_RETENTION_MS
  const reviewCutoff = now - REVIEW_MESSAGE_RETENTION_MS
  const results = await db.batch([
    db.prepare(
      `DELETE FROM message_log
       WHERE created_at < ?
         AND (
           review_status IN ('safe','error')
           OR (review_status='flagged' AND human_review_status='dismissed')
         )`
    ).bind(routineCutoff),
    db.prepare(
      `DELETE FROM message_log
       WHERE created_at < ?
         AND (
           review_status='pending'
           OR (
             review_status='flagged'
             AND human_review_status IN ('pending','confirmed')
           )
         )`
    ).bind(reviewCutoff),
  ])
  return results.reduce((count, result) => count + Number(result.meta?.changes || 0), 0)
}
