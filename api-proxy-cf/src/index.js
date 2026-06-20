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

// ── Email ──────────────────────────────────────────────────────────────────

async function sendVerificationEmail(email, token, resendKey) {
  const link = `https://axion.amplifiedsmp.org/keys/verify?token=${token}`
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
    body: JSON.stringify({
      from: 'Axion Labs <noreply@amplifiedsmp.org>',
      to: [email],
      subject: 'Verify your Axion account',
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px">
          <h2 style="margin:0 0 8px">Verify your email</h2>
          <p style="color:#555;margin:0 0 24px">Click the button below to activate your Axion Labs account and start using the API.</p>
          <a href="${link}" style="display:inline-block;background:#e8602c;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Verify email →</a>
          <p style="color:#999;font-size:12px;margin-top:24px">Link expires in 24 hours. If you didn't sign up, ignore this email.</p>
        </div>`,
    }),
  })
}

// ── Auth ───────────────────────────────────────────────────────────────────

app.post('/auth/register', async (c) => {
  const { email, password } = await c.req.json().catch(() => ({}))
  if (!email || !password) return json({ error: 'email and password required' }, 400)
  if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400)

  const existing = await c.env.DB.prepare('SELECT id, verified FROM users WHERE email=?').bind(email.toLowerCase()).first()
  if (existing && existing.verified) return json({ error: 'Email already registered' }, 409)

  const id = existing?.id || crypto.randomUUID()
  const pw_hash = await hashPw(password, c.env.PW_SALT)
  const verify_token = crypto.randomUUID()

  if (existing) {
    await c.env.DB.prepare('UPDATE users SET pw_hash=?, verify_token=? WHERE id=?').bind(pw_hash, verify_token, id).run()
  } else {
    await c.env.DB.prepare('INSERT INTO users (id, email, pw_hash, verify_token) VALUES (?,?,?,?)').bind(id, email.toLowerCase(), pw_hash, verify_token).run()
  }

  if (c.env.RESEND_API_KEY) {
    c.executionCtx.waitUntil(sendVerificationEmail(email.toLowerCase(), verify_token, c.env.RESEND_API_KEY))
  }

  return json({ pending: true, message: 'Check your email to verify your account.' })
})

app.get('/auth/verify', async (c) => {
  const token = c.req.query('token')
  if (!token) return json({ error: 'Missing token' }, 400)

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE verify_token=?').bind(token).first()
  if (!user) return new Response('Invalid or expired verification link.', { status: 400, headers: { 'Content-Type': 'text/plain' } })

  await c.env.DB.prepare('UPDATE users SET verified=1, verify_token=NULL WHERE id=?').bind(user.id).run()

  // Redirect to dashboard with session token in URL hash (read by JS, never sent to server)
  const sessionToken = makeToken(user.id)
  return new Response(null, {
    status: 302,
    headers: { Location: `https://axion.amplifiedsmp.org/keys#verified=${encodeURIComponent(sessionToken)}&email=${encodeURIComponent(user.email)}` },
  })
})

// ── Google OAuth ───────────────────────────────────────────────────────────

app.get('/auth/google', (c) => {
  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: 'https://api.amplifiedsmp.org/auth/google/callback',
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
  })
  return new Response(null, {
    status: 302,
    headers: { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` },
  })
})

app.get('/auth/google/callback', async (c) => {
  const code = c.req.query('code')
  if (!code) return new Response('Missing code', { status: 400 })

  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: 'https://api.amplifiedsmp.org/auth/google/callback',
      grant_type: 'authorization_code',
    }),
  })
  const tokens = await tokenRes.json()
  if (!tokens.access_token) return new Response('OAuth failed', { status: 400 })

  // Get user info
  const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  })
  const gUser = await userRes.json()
  if (!gUser.email) return new Response('Could not get email from Google', { status: 400 })

  // Find or create user
  let user = await c.env.DB.prepare('SELECT * FROM users WHERE google_id=?').bind(gUser.id).first()
  if (!user) {
    user = await c.env.DB.prepare('SELECT * FROM users WHERE email=?').bind(gUser.email.toLowerCase()).first()
  }

  if (user) {
    // Link Google ID if not already linked
    if (!user.google_id) {
      await c.env.DB.prepare('UPDATE users SET google_id=?, verified=1 WHERE id=?').bind(gUser.id, user.id).run()
    }
  } else {
    // Create new user — Google-verified so skip email verification
    const id = crypto.randomUUID()
    await c.env.DB.prepare(
      'INSERT INTO users (id, email, pw_hash, verified, google_id) VALUES (?,?,?,1,?)'
    ).bind(id, gUser.email.toLowerCase(), '', gUser.id).run()
    user = { id }
  }

  const sessionToken = makeToken(user.id)
  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://axion.amplifiedsmp.org/keys#verified=${encodeURIComponent(sessionToken)}&email=${encodeURIComponent(gUser.email)}`,
    },
  })
})

app.post('/auth/login', async (c) => {
  const { email, password } = await c.req.json().catch(() => ({}))
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email=?').bind((email || '').toLowerCase()).first()
  const pw_hash = await hashPw(password || '', c.env.PW_SALT)
  if (!user || user.pw_hash !== pw_hash) return json({ error: 'Invalid email or password' }, 401)
  if (!user.verified) return json({ error: 'Please verify your email before signing in.' }, 403)
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
