// Append-only record of every chat completion exchange — separate from the
// `chats` table, which is a mutable reflection of what a user's own web UI
// currently shows (editing or deleting a message there removes it). This
// exists so a real "what did this account actually send" record survives
// regardless of what the client later does, for abuse/legal response.
//
// Logging failures must never break the actual chat response — this is
// always best-effort from the caller's perspective.
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
