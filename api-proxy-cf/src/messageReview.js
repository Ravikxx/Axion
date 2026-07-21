// Async safety review of message_log rows. Runs on its own cron schedule,
// well after the actual chat exchange already happened — never on the live
// request path, so it can never add latency or fail a real chat response.
// Every row ends up either 'safe' or 'flagged'; a classification failure or
// an ambiguous verdict defaults to 'flagged' rather than silently passing,
// since the whole point is that nothing genuinely bad slips through
// unreviewed just because the classifier had a bad day.
import { proxyLumenRequest } from './lumen-upstream.js'

const REVIEW_SYSTEM_PROMPT = `You are an internal safety reviewer for an AI chat platform, not the platform's user-facing assistant. You will be shown one user message and the assistant's reply to it. Decide whether this exchange needs human review for a genuine policy violation: illegal activity, sexual content involving minors, weapons/explosives instructions, malicious code meant to attack or compromise systems, credible threats of violence, hate speech, or serious self-harm encouragement. Respond with exactly one line, in exactly this format: "SAFE" or "FLAG: <one short sentence reason>". Only flag genuine, serious concerns — do not flag ordinary, ambiguous, or borderline-edgy content.`

function lastUserMessage(requestMessagesJson) {
  try {
    const messages = JSON.parse(requestMessagesJson)
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return typeof messages[i].content === 'string' ? messages[i].content : JSON.stringify(messages[i].content)
    }
  } catch {}
  return '(unable to parse request_messages)'
}

async function classifyExchange(env, userMessage, responseText, fetchImpl) {
  try {
    const upstream = await proxyLumenRequest({
      model: 'lumen',
      messages: [
        { role: 'system', content: REVIEW_SYSTEM_PROMPT },
        { role: 'user', content: `USER MESSAGE:\n${userMessage}\n\nASSISTANT REPLY:\n${responseText}` },
      ],
    }, env, fetchImpl)
    if (!upstream.ok) return { status: 'flagged', notes: `Classifier call failed (${upstream.status}) — needs manual review.` }
    const data = await upstream.json()
    const verdict = (data.choices?.[0]?.message?.content || '').trim()
    if (/^SAFE\b/i.test(verdict)) return { status: 'safe', notes: '' }
    if (/^FLAG\b/i.test(verdict)) return { status: 'flagged', notes: verdict.replace(/^FLAG:\s*/i, '') }
    return { status: 'flagged', notes: `Unparseable classifier response — needs manual review. Raw: ${verdict.slice(0, 200)}` }
  } catch (err) {
    return { status: 'flagged', notes: `Classifier error (${err?.message || err}) — needs manual review.` }
  }
}

export async function reviewPendingMessages(env, fetchImpl = fetch, batchSize = 15) {
  const { results: pending } = await env.DB.prepare(
    'SELECT id, user_id, ip, auth_type, request_messages, response_text FROM message_log WHERE review_status=? ORDER BY id ASC LIMIT ?'
  ).bind('pending', batchSize).all()

  const flagged = []
  for (const row of pending) {
    const userMessage = lastUserMessage(row.request_messages)
    const { status, notes } = await classifyExchange(env, userMessage, row.response_text, fetchImpl)
    await env.DB.prepare('UPDATE message_log SET review_status=?, reviewed_at=?, review_notes=? WHERE id=?')
      .bind(status, Date.now(), notes, row.id).run()
    if (status === 'flagged') flagged.push({ id: row.id, userId: row.user_id, ip: row.ip, authType: row.auth_type, notes })
  }

  return { reviewedCount: pending.length, flagged }
}
