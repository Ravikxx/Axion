// Async safety review of message_log rows. Runs after the live exchange so
// moderation can never add latency or prevent a user from receiving a reply.
// Policy findings and reviewer infrastructure failures are deliberately
// separate states: only genuine moderation findings enter the human safety
// queue, while API/configuration failures become operational errors.

const MISTRAL_MODERATION_URL = 'https://api.mistral.ai/v1/moderations'
const MISTRAL_MODERATION_MODEL = 'mistral-moderation-2603'
const REVIEW_CATEGORIES = new Map([
  ['sexual', 'sexual content'],
  ['hate_and_discrimination', 'hate or discrimination'],
  ['violence_and_threats', 'violence or threats'],
  ['dangerous_and_criminal_content', 'dangerous or criminal content'],
  ['dangerous_content', 'dangerous content'],
  ['criminal_content', 'criminal content'],
  ['selfharm', 'self-harm'],
])

function lastUserMessage(requestMessagesJson) {
  try {
    const messages = JSON.parse(requestMessagesJson)
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        return typeof messages[i].content === 'string'
          ? messages[i].content
          : JSON.stringify(messages[i].content)
      }
    }
  } catch {}
  return '(unable to parse request_messages)'
}

function findingsForResult(result, source) {
  if (!result?.categories || typeof result.categories !== 'object') return null
  const scores = result.category_scores || {}
  const findings = []
  for (const [category, label] of REVIEW_CATEGORIES) {
    if (result.categories[category] !== true) continue
    const score = Number(scores[category])
    findings.push({
      source,
      category,
      label,
      score: Number.isFinite(score) ? score : null,
    })
  }
  return findings
}

function formatFindings(findings) {
  return findings.map(({ source, label, score }) => (
    `${source}: ${label}${score == null ? '' : ` (${Math.round(score * 100)}%)`}`
  )).join('; ')
}

async function classifyExchange(env, userMessage, responseText, fetchImpl) {
  if (!env.MISTRAL_API_KEY) {
    return { status: 'error', notes: 'Mistral moderation is not configured.' }
  }

  try {
    const response = await fetchImpl(MISTRAL_MODERATION_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.MISTRAL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MISTRAL_MODERATION_MODEL,
        input: [
          userMessage || '(user message was empty)',
          responseText || '(assistant returned no recorded text or tool call)',
        ],
      }),
    })

    if (!response.ok) {
      return { status: 'error', notes: `Mistral moderation call failed (${response.status}).` }
    }

    const data = await response.json()
    if (!Array.isArray(data.results) || data.results.length !== 2) {
      return { status: 'error', notes: 'Mistral moderation returned an invalid result shape.' }
    }

    const userFindings = findingsForResult(data.results[0], 'user message')
    const assistantFindings = findingsForResult(data.results[1], 'assistant reply')
    if (!userFindings || !assistantFindings) {
      return { status: 'error', notes: 'Mistral moderation omitted category results.' }
    }

    const findings = [...userFindings, ...assistantFindings]
    if (!findings.length) return { status: 'safe', notes: '' }
    return { status: 'flagged', notes: formatFindings(findings) }
  } catch (err) {
    return { status: 'error', notes: `Mistral moderation error (${err?.message || err}).` }
  }
}

export async function reviewPendingMessages(env, fetchImpl = fetch, batchSize = 15) {
  const { results: pending } = await env.DB.prepare(
    'SELECT id, user_id, ip, auth_type, request_messages, response_text FROM message_log WHERE review_status=? ORDER BY id ASC LIMIT ?'
  ).bind('pending', batchSize).all()

  const flagged = []
  const errors = []
  for (const row of pending) {
    const userMessage = lastUserMessage(row.request_messages)
    const { status, notes } = await classifyExchange(env, userMessage, row.response_text, fetchImpl)
    await env.DB.prepare('UPDATE message_log SET review_status=?, reviewed_at=?, review_notes=? WHERE id=?')
      .bind(status, Date.now(), notes, row.id).run()

    const item = { id: row.id, userId: row.user_id, ip: row.ip, authType: row.auth_type, notes }
    if (status === 'flagged') flagged.push(item)
    if (status === 'error') errors.push(item)
  }

  return { reviewedCount: pending.length, flagged, errors }
}
