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

const TOKEN_TTL = 7 * 24 * 60 * 60 * 1000 // 7 days

async function makeToken(uid, secret) {
  const payload = btoa(JSON.stringify({ uid, exp: Date.now() + TOKEN_TTL }))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return `${payload}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`
}

async function parseToken(token, secret) {
  const parts = (token || '').split('.')
  if (parts.length !== 2) return null
  const [payload, sig] = parts
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    const sigBytes = Uint8Array.from(atob(sig), ch => ch.charCodeAt(0))
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(payload))
    if (!valid) return null
    const data = JSON.parse(atob(payload))
    if (data.exp < Date.now()) return null // expired
    return data
  } catch { return null }
}

async function verifyTurnstile(token, secret, ip) {
  if (!secret) return true // skip if not configured yet
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret, response: token || '', remoteip: ip }),
  })
  const data = await res.json()
  return data.success === true
}

// 10 attempts per IP per 15 minutes on auth endpoints
async function checkRateLimit(db, ip) {
  const key = `auth:${ip}`
  const window = 15 * 60 // seconds
  const limit = 10
  const now = Math.floor(Date.now() / 1000)

  const row = await db.prepare('SELECT count, window_start FROM rate_limits WHERE key=?').bind(key).first()
  if (row && now - row.window_start < window) {
    if (row.count >= limit) return false
    await db.prepare('UPDATE rate_limits SET count=count+1 WHERE key=?').bind(key).run()
  } else {
    await db.prepare('INSERT OR REPLACE INTO rate_limits (key, count, window_start) VALUES (?,1,?)').bind(key, now).run()
  }
  return true
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
  const payload = await parseToken(token, c.env.TOKEN_SECRET)
  if (!payload?.uid) return null
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(payload.uid).first()
  return user || null
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

async function requireKey(c) {
  const auth = c.req.header('Authorization') || ''
  const key = auth.replace(/^Bearer\s+/i, '').trim()
  if (!key.startsWith('axion-sk-')) return null
  return c.env.DB.prepare('SELECT * FROM api_keys WHERE key_value=? AND revoked=0').bind(key).first()
}

// ── Email ──────────────────────────────────────────────────────────────────

async function sendVerificationEmail(email, token, resendKey) {
  const link = `https://api.amplifiedsmp.org/auth/verify?token=${token}`
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
  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  if (!await checkRateLimit(c.env.DB, ip)) return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429)

  const { email, password, turnstile } = await c.req.json().catch(() => ({}))
  if (!await verifyTurnstile(turnstile, c.env.TURNSTILE_SECRET, ip)) return json({ error: 'Security check failed. Please try again.' }, 403)
  if (!email || !password) return json({ error: 'email and password required' }, 400)
  if (!validEmail(email)) return json({ error: 'Invalid email address' }, 400)
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
  const sessionToken = await makeToken(user.id, c.env.TOKEN_SECRET)
  return new Response(null, {
    status: 302,
    headers: { Location: `https://axion.amplifiedsmp.org/keys#verified=${encodeURIComponent(sessionToken)}&email=${encodeURIComponent(user.email)}` },
  })
})

// ── OAuth shared helper ────────────────────────────────────────────────────

async function oauthFinish(c, { id_field, email, provider_id }) {
  // Find by provider ID first, then fall back to email
  let user = await c.env.DB.prepare(`SELECT * FROM users WHERE ${id_field}=?`).bind(provider_id).first()
  if (!user && email) {
    user = await c.env.DB.prepare('SELECT * FROM users WHERE email=?').bind(email.toLowerCase()).first()
  }
  if (user) {
    if (!user[id_field]) {
      await c.env.DB.prepare(`UPDATE users SET ${id_field}=?, verified=1 WHERE id=?`).bind(provider_id, user.id).run()
    }
  } else {
    if (!email) return new Response('Could not get email from provider', { status: 400 })
    const uid = crypto.randomUUID()
    await c.env.DB.prepare(
      `INSERT INTO users (id, email, pw_hash, verified, ${id_field}) VALUES (?,?,?,1,?)`
    ).bind(uid, email.toLowerCase(), '', provider_id).run()
    user = { id: uid }
  }
  const token = await makeToken(user.id, c.env.TOKEN_SECRET)
  return new Response(null, {
    status: 302,
    headers: { Location: `https://axion.amplifiedsmp.org/keys#verified=${encodeURIComponent(token)}&email=${encodeURIComponent(email || '')}` },
  })
}

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

  return oauthFinish(c, { id_field: 'google_id', email: gUser.email, provider_id: gUser.id })
})

// ── GitHub OAuth ───────────────────────────────────────────────────────────

app.get('/auth/github', (c) => {
  const params = new URLSearchParams({
    client_id: c.env.GITHUB_CLIENT_ID,
    redirect_uri: 'https://api.amplifiedsmp.org/auth/github/callback',
    scope: 'user:email',
  })
  return new Response(null, { status: 302, headers: { Location: `https://github.com/login/oauth/authorize?${params}` } })
})

app.get('/auth/github/callback', async (c) => {
  const code = c.req.query('code')
  if (!code) return new Response('Missing code', { status: 400 })

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: c.env.GITHUB_CLIENT_ID, client_secret: c.env.GITHUB_CLIENT_SECRET, code }),
  })
  const { access_token } = await tokenRes.json()
  if (!access_token) return new Response('GitHub OAuth failed', { status: 400 })

  // Get user profile
  const [profileRes, emailsRes] = await Promise.all([
    fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${access_token}`, 'User-Agent': 'axion-api' } }),
    fetch('https://api.github.com/user/emails', { headers: { Authorization: `Bearer ${access_token}`, 'User-Agent': 'axion-api' } }),
  ])
  const profile = await profileRes.json()
  const emails = await emailsRes.json()
  const primary = emails.find(e => e.primary && e.verified)
  const email = primary?.email || profile.email

  return oauthFinish(c, { id_field: 'github_id', email, provider_id: String(profile.id) })
})

// ── Discord OAuth ──────────────────────────────────────────────────────────

app.get('/auth/discord', (c) => {
  const params = new URLSearchParams({
    client_id: c.env.DISCORD_CLIENT_ID,
    redirect_uri: 'https://api.amplifiedsmp.org/auth/discord/callback',
    response_type: 'code',
    scope: 'identify email',
  })
  return new Response(null, { status: 302, headers: { Location: `https://discord.com/oauth2/authorize?${params}` } })
})

app.get('/auth/discord/callback', async (c) => {
  const code = c.req.query('code')
  if (!code) return new Response('Missing code', { status: 400 })

  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.env.DISCORD_CLIENT_ID,
      client_secret: c.env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://api.amplifiedsmp.org/auth/discord/callback',
    }),
  })
  const { access_token } = await tokenRes.json()
  if (!access_token) return new Response('Discord OAuth failed', { status: 400 })

  const userRes = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${access_token}` },
  })
  const dUser = await userRes.json()
  if (!dUser.verified) return new Response('Discord email not verified', { status: 400 })

  return oauthFinish(c, { id_field: 'discord_id', email: dUser.email, provider_id: dUser.id })
})

app.post('/auth/login', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  if (!await checkRateLimit(c.env.DB, ip)) return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429)

  const { email, password, turnstile } = await c.req.json().catch(() => ({}))
  if (!await verifyTurnstile(turnstile, c.env.TURNSTILE_SECRET, ip)) return json({ error: 'Security check failed. Please try again.' }, 403)
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email=?').bind((email || '').toLowerCase()).first()
  const pw_hash = await hashPw(password || '', c.env.PW_SALT)
  if (!user || user.pw_hash !== pw_hash) return json({ error: 'Invalid email or password' }, 401)
  if (!user.verified) return json({ error: 'Please verify your email before signing in.' }, 403)
  return json({ token: await makeToken(user.id, c.env.TOKEN_SECRET), email: user.email })
})

// ── Dashboard ──────────────────────────────────────────────────────────────

app.get('/dashboard/keys', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const { results } = await c.env.DB.prepare(
    'SELECT id, label, key_value, created_at, last_used, requests, tokens, month_requests FROM api_keys WHERE user_id=? AND revoked=0 ORDER BY created_at DESC'
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

const FREE_DAILY_LIMIT = 50      // keyless requests per IP per day
const KEY_MONTHLY_LIMIT = 1000   // keyed requests per month (free plan)

function currentMonth() {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

async function proxyUpstream(body, stream) {
  return fetch(HF_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, model: 'lumen' }),
  })
}

function streamResponse(upstream) {
  const { readable, writable } = new TransformStream()
  upstream.body.pipeTo(writable)
  return new Response(readable, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' },
  })
}

app.post('/v1/chat/completions', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  const auth = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '').trim()
  const body = await c.req.json()

  // ── Keyed request ──
  if (auth.startsWith('axion-sk-')) {
    const keyRow = await c.env.DB.prepare('SELECT * FROM api_keys WHERE key_value=? AND revoked=0').bind(auth).first()
    if (!keyRow) return json({ error: { message: 'Invalid or revoked API key', type: 'invalid_request_error' } }, 401)

    // Monthly limit check — reset counter when month rolls over
    const month = currentMonth()
    if (keyRow.month_start !== month) {
      await c.env.DB.prepare('UPDATE api_keys SET month_requests=0, month_start=? WHERE id=?').bind(month, keyRow.id).run()
      keyRow.month_requests = 0
    }
    if (keyRow.month_requests >= KEY_MONTHLY_LIMIT) {
      return json({ error: { message: `Monthly limit of ${KEY_MONTHLY_LIMIT} requests reached. Upgrade for more.`, type: 'rate_limit_error', limit: KEY_MONTHLY_LIMIT, used: keyRow.month_requests } }, 429)
    }

    const upstream = await proxyUpstream(body)
    if (!upstream.ok) return json({ error: { message: await upstream.text(), type: 'upstream_error' } }, upstream.status)

    const track = () => c.env.DB.prepare(
      "UPDATE api_keys SET last_used=strftime('%s','now'), requests=requests+1, month_requests=month_requests+1 WHERE id=?"
    ).bind(keyRow.id).run()

    if (body.stream) { c.executionCtx.waitUntil(track()); return streamResponse(upstream) }
    const data = await upstream.json()
    c.executionCtx.waitUntil(track())
    return json(data)
  }

  // ── Free keyless request (Lumen free tier) ──
  const freeKey = `free:${ip}`
  const today = new Date().toISOString().slice(0, 10)
  const row = await c.env.DB.prepare('SELECT count, window_start FROM rate_limits WHERE key=?').bind(freeKey).first()

  if (row && row.window_start === today) {
    if (row.count >= FREE_DAILY_LIMIT) {
      return json({
        error: {
          message: `Free tier limit of ${FREE_DAILY_LIMIT} requests/day reached. Sign up for an API key at https://axion.amplifiedsmp.org/keys for 1000/month.`,
          type: 'rate_limit_error',
          limit: FREE_DAILY_LIMIT,
          used: row.count,
          free_tier: true,
        }
      }, 429)
    }
    c.executionCtx.waitUntil(c.env.DB.prepare('UPDATE rate_limits SET count=count+1 WHERE key=?').bind(freeKey).run())
  } else {
    c.executionCtx.waitUntil(c.env.DB.prepare('INSERT OR REPLACE INTO rate_limits (key, count, window_start) VALUES (?,1,?)').bind(freeKey, today).run())
  }

  const upstream = await proxyUpstream(body)
  if (!upstream.ok) return json({ error: { message: await upstream.text(), type: 'upstream_error' } }, upstream.status)

  if (body.stream) return streamResponse(upstream)
  return json(await upstream.json())
})

app.get('/v1/models', async (c) => {
  return json({
    object: 'list',
    data: [{ id: 'lumen', object: 'model', created: 1750000000, owned_by: 'axion-labs' }],
  })
})

app.get('/health', (c) => json({ ok: true, model: 'lumen-1.2.5' }))

// ── Admin panel ────────────────────────────────────────────────────────────

app.get('/admin/stats', async (c) => {
  const token = c.req.header('Authorization') || ''
  if (token !== `Bearer ${c.env.ADMIN_SECRET}`) return json({ error: 'Forbidden' }, 403)

  const [users, keys, requests, freeToday] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) as count FROM users WHERE verified=1').first(),
    c.env.DB.prepare('SELECT COUNT(*) as count FROM api_keys WHERE revoked=0').first(),
    c.env.DB.prepare('SELECT SUM(requests) as total FROM api_keys').first(),
    c.env.DB.prepare("SELECT SUM(count) as total FROM rate_limits WHERE key LIKE 'free:%' AND window_start=?").bind(new Date().toISOString().slice(0, 10)).first(),
  ])

  const topKeys = await c.env.DB.prepare(
    'SELECT k.label, k.requests, k.month_requests, u.email FROM api_keys k JOIN users u ON k.user_id=u.id WHERE k.revoked=0 ORDER BY k.requests DESC LIMIT 10'
  ).all()

  return json({
    users: users.count,
    active_keys: keys.count,
    total_requests: requests.total || 0,
    free_requests_today: freeToday.total || 0,
    top_keys: topKeys.results,
  })
})

export default app
