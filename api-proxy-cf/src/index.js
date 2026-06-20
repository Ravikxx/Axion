import { Hono } from 'hono'
import { cors } from 'hono/cors'

const app = new Hono()
const HF_URL = 'https://ravikxxbgamin-lumen.hf.space/v1/chat/completions'

app.use('*', cors({ origin: '*', allowHeaders: ['Content-Type', 'Authorization'] }))

// ── Helpers ────────────────────────────────────────────────────────────────

async function hashPw(password, salt) {
  const enc = new TextEncoder()
  const data = enc.encode(password + (salt || 'axion'))
  const buf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function genKey() {
  const bytes = new Uint8Array(20)
  crypto.getRandomValues(bytes)
  return 'axion-sk-' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

function makeToken(uid) {
  return btoa(JSON.stringify({ uid, ts: Date.now() }))
}

function parseToken(token) {
  try { return JSON.parse(atob(token)) } catch { return null }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function requireAuth(c) {
  const auth = c.req.header('Authorization') || ''
  const token = auth.replace(/^Bearer\s+/i, '').trim()
  const payload = parseToken(token)
  if (!payload?.uid) return null
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(payload.uid).first()
  return user || null
}

async function requireKey(c) {
  const auth = c.req.header('Authorization') || ''
  const key = auth.replace(/^Bearer\s+/i, '').trim()
  if (!key.startsWith('axion-sk-')) return null
  return c.env.DB.prepare('SELECT * FROM api_keys WHERE key_value=? AND revoked=0').bind(key).first()
}

// ── Auth ───────────────────────────────────────────────────────────────────

app.post('/auth/register', async (c) => {
  const { email, password } = await c.req.json().catch(() => ({}))
  if (!email || !password) return json({ error: 'email and password required' }, 400)

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email.toLowerCase()).first()
  if (existing) return json({ error: 'Email already registered' }, 409)

  const id = crypto.randomUUID()
  const pw_hash = await hashPw(password, c.env.PW_SALT)
  await c.env.DB.prepare('INSERT INTO users (id, email, pw_hash) VALUES (?,?,?)').bind(id, email.toLowerCase(), pw_hash).run()
  return json({ user_id: id, email, token: makeToken(id) })
})

app.post('/auth/login', async (c) => {
  const { email, password } = await c.req.json().catch(() => ({}))
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email=?').bind((email || '').toLowerCase()).first()
  const pw_hash = await hashPw(password || '', c.env.PW_SALT)
  if (!user || user.pw_hash !== pw_hash) return json({ error: 'Invalid email or password' }, 401)
  return json({ token: makeToken(user.id), email: user.email })
})

// ── Dashboard ──────────────────────────────────────────────────────────────

app.get('/dashboard/keys', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const { results } = await c.env.DB.prepare(
    'SELECT id, label, key_value, created_at, last_used, requests, tokens FROM api_keys WHERE user_id=? AND revoked=0 ORDER BY created_at DESC'
  ).bind(user.id).all()
  return json({ keys: results })
})

app.get('/dashboard/stats', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const stats = await c.env.DB.prepare(
    'SELECT COUNT(*) as total_keys, SUM(requests) as total_requests, SUM(tokens) as total_tokens FROM api_keys WHERE user_id=? AND revoked=0'
  ).bind(user.id).first()
  return json(stats)
})

app.post('/dashboard/keys', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const { label } = await c.req.json().catch(() => ({}))
  const id = crypto.randomUUID()
  const key_value = genKey()
  await c.env.DB.prepare('INSERT INTO api_keys (id, user_id, key_value, label) VALUES (?,?,?,?)').bind(id, user.id, key_value, label || 'My Key').run()
  return json({ id, key_value, label: label || 'My Key' })
})

app.delete('/dashboard/keys/:id', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const result = await c.env.DB.prepare('UPDATE api_keys SET revoked=1 WHERE id=? AND user_id=?').bind(c.req.param('id'), user.id).run()
  if (result.meta.changes === 0) return json({ error: 'Key not found' }, 404)
  return json({ ok: true })
})

// ── OpenAI-compatible proxy ────────────────────────────────────────────────

app.post('/v1/chat/completions', async (c) => {
  const keyRow = await requireKey(c)
  if (!keyRow) return json({ error: { message: 'Invalid or missing API key', type: 'invalid_request_error' } }, 401)

  const body = await c.req.json()
  body.model = 'lumen'

  const upstream = await fetch(HF_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!upstream.ok) {
    const err = await upstream.text()
    return json({ error: { message: err, type: 'upstream_error' } }, upstream.status)
  }

  // update usage (fire and forget — don't block the response)
  const trackUsage = async () => {
    await c.env.DB.prepare(
      "UPDATE api_keys SET last_used=strftime('%s','now'), requests=requests+1 WHERE id=?"
    ).bind(keyRow.id).run()
  }

  if (body.stream) {
    // pipe SSE stream directly from HF Space to client
    const { readable, writable } = new TransformStream()
    upstream.body.pipeTo(writable)
    c.executionCtx.waitUntil(trackUsage())
    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      },
    })
  } else {
    const data = await upstream.json()
    c.executionCtx.waitUntil(trackUsage())
    return json(data)
  }
})

app.get('/v1/models', async (c) => {
  return json({
    object: 'list',
    data: [{ id: 'lumen', object: 'model', created: 1750000000, owned_by: 'axion-labs' }],
  })
})

app.get('/health', (c) => json({ ok: true, model: 'lumen-1.2.5' }))

export default app
