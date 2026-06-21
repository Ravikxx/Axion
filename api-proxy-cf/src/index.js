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

const RETURN_DESTINATIONS = {
  admin:      'https://axion.amplifiedsmp.org/admin',
  home:       'https://axion.amplifiedsmp.org',
  keys:       'https://axion.amplifiedsmp.org/keys',
  playground: 'https://axion.amplifiedsmp.org/playground',
}

async function oauthFinish(c, { id_field, email, provider_id, return_to }) {
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
  const base = RETURN_DESTINATIONS[return_to] || RETURN_DESTINATIONS.keys
  return new Response(null, {
    status: 302,
    headers: { Location: `${base}#verified=${encodeURIComponent(token)}&email=${encodeURIComponent(email || '')}` },
  })
}

// ── Google OAuth ───────────────────────────────────────────────────────────

function encodeState(return_to) { return btoa(JSON.stringify({ return_to: return_to || '' })) }
function decodeState(state) { try { return JSON.parse(atob(state || '')).return_to || '' } catch { return '' } }

app.get('/auth/google', (c) => {
  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: 'https://api.amplifiedsmp.org/auth/google/callback',
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
    state: encodeState(c.req.query('return_to')),
  })
  return new Response(null, {
    status: 302,
    headers: { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` },
  })
})

app.get('/auth/google/callback', async (c) => {
  const code = c.req.query('code')
  if (!code) return new Response('Missing code', { status: 400 })
  const return_to = decodeState(c.req.query('state'))

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

  const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  })
  const gUser = await userRes.json()
  if (!gUser.email) return new Response('Could not get email from Google', { status: 400 })

  return oauthFinish(c, { id_field: 'google_id', email: gUser.email, provider_id: gUser.id, return_to })
})

// ── GitHub OAuth ───────────────────────────────────────────────────────────

app.get('/auth/github', (c) => {
  const params = new URLSearchParams({
    client_id: c.env.GITHUB_CLIENT_ID,
    redirect_uri: 'https://api.amplifiedsmp.org/auth/github/callback',
    scope: 'user:email',
    state: encodeState(c.req.query('return_to')),
  })
  return new Response(null, { status: 302, headers: { Location: `https://github.com/login/oauth/authorize?${params}` } })
})

app.get('/auth/github/callback', async (c) => {
  const code = c.req.query('code')
  if (!code) return new Response('Missing code', { status: 400 })
  const return_to = decodeState(c.req.query('state'))

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: c.env.GITHUB_CLIENT_ID, client_secret: c.env.GITHUB_CLIENT_SECRET, code }),
  })
  const { access_token } = await tokenRes.json()
  if (!access_token) return new Response('GitHub OAuth failed', { status: 400 })

  const [profileRes, emailsRes] = await Promise.all([
    fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${access_token}`, 'User-Agent': 'axion-api' } }),
    fetch('https://api.github.com/user/emails', { headers: { Authorization: `Bearer ${access_token}`, 'User-Agent': 'axion-api' } }),
  ])
  const profile = await profileRes.json()
  const emails = await emailsRes.json()
  const primary = emails.find(e => e.primary && e.verified)
  const email = primary?.email || profile.email

  return oauthFinish(c, { id_field: 'github_id', email, provider_id: String(profile.id), return_to })
})

// ── Discord OAuth ──────────────────────────────────────────────────────────

app.get('/auth/discord', (c) => {
  const params = new URLSearchParams({
    client_id: c.env.DISCORD_CLIENT_ID,
    redirect_uri: 'https://api.amplifiedsmp.org/auth/discord/callback',
    response_type: 'code',
    scope: 'identify email',
    state: encodeState(c.req.query('return_to')),
  })
  return new Response(null, { status: 302, headers: { Location: `https://discord.com/oauth2/authorize?${params}` } })
})

app.get('/auth/discord/callback', async (c) => {
  const code = c.req.query('code')
  if (!code) return new Response('Missing code', { status: 400 })
  const return_to = decodeState(c.req.query('state'))

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

  return oauthFinish(c, { id_field: 'discord_id', email: dUser.email, provider_id: dUser.id, return_to })
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

const FREE_DAILY_LIMIT  = 50    // keyless requests per IP per day
const KEY_MONTHLY_LIMIT = 1000  // keyed requests per month
const KEY_WINDOW_LIMIT  = 40    // keyed requests per 2-hour window
const KEY_WINDOW_MS     = 2 * 60 * 60 * 1000

function currentMonth() {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function nextMonthISO() {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString()
}

function currentWindowISO() {
  return new Date(Math.floor(Date.now() / KEY_WINDOW_MS) * KEY_WINDOW_MS).toISOString()
}

function nextWindowISO() {
  return new Date((Math.floor(Date.now() / KEY_WINDOW_MS) + 1) * KEY_WINDOW_MS).toISOString()
}

async function proxyUpstream(body) {
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

    // Monthly limit — reset counter when month rolls over
    const month = currentMonth()
    if (keyRow.month_start !== month) {
      await c.env.DB.prepare('UPDATE api_keys SET month_requests=0, month_start=? WHERE id=?').bind(month, keyRow.id).run()
      keyRow.month_requests = 0
    }
    if (keyRow.month_requests >= KEY_MONTHLY_LIMIT) {
      const reset_at = nextMonthISO()
      return json({ error: { message: `Monthly limit of ${KEY_MONTHLY_LIMIT} requests reached.`, type: 'rate_limit_error', reset_at, limit: KEY_MONTHLY_LIMIT, used: keyRow.month_requests } }, 429)
    }

    // 2-hour window limit
    const winKey = `win:${keyRow.id}`
    const winStart = currentWindowISO()
    const winRow = await c.env.DB.prepare('SELECT count, window_start FROM rate_limits WHERE key=?').bind(winKey).first()
    const winCount = (winRow && winRow.window_start === winStart) ? winRow.count : 0
    if (winCount >= KEY_WINDOW_LIMIT) {
      const reset_at = nextWindowISO()
      return json({ error: { message: `Rate limit reached (${KEY_WINDOW_LIMIT} requests per 2 hours).`, type: 'rate_limit_error', reset_at, limit: KEY_WINDOW_LIMIT, used: winCount, window: true } }, 429)
    }

    const upstream = await proxyUpstream(body)
    if (!upstream.ok) return json({ error: { message: await upstream.text(), type: 'upstream_error' } }, upstream.status)

    const today = new Date().toISOString().slice(0, 10)
    const track = () => Promise.all([
      c.env.DB.prepare(
        "UPDATE api_keys SET last_used=strftime('%s','now'), requests=requests+1, month_requests=month_requests+1 WHERE id=?"
      ).bind(keyRow.id).run(),
      c.env.DB.prepare(
        'INSERT INTO usage_daily (key_id, date, count) VALUES (?,?,1) ON CONFLICT (key_id, date) DO UPDATE SET count=count+1'
      ).bind(keyRow.id, today).run(),
      winRow && winRow.window_start === winStart
        ? c.env.DB.prepare('UPDATE rate_limits SET count=count+1 WHERE key=?').bind(winKey).run()
        : c.env.DB.prepare('INSERT OR REPLACE INTO rate_limits (key, count, window_start) VALUES (?,1,?)').bind(winKey, winStart).run(),
    ])

    if (body.stream) { c.executionCtx.waitUntil(track()); return streamResponse(upstream) }
    const data = await upstream.json()
    c.executionCtx.waitUntil(track())
    return json(data)
  }

  // ── Free keyless request ──
  const freeKey = `free:${ip}`
  const today = new Date().toISOString().slice(0, 10)
  const row = await c.env.DB.prepare('SELECT count, window_start FROM rate_limits WHERE key=?').bind(freeKey).first()

  if (row && row.window_start === today) {
    if (row.count >= FREE_DAILY_LIMIT) {
      const tomorrow = new Date()
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
      tomorrow.setUTCHours(0, 0, 0, 0)
      return json({
        error: {
          message: `Free tier limit of ${FREE_DAILY_LIMIT} requests/day reached. Get an API key at https://axion.amplifiedsmp.org/keys for 1,000/month + 40/2h.`,
          type: 'rate_limit_error',
          reset_at: tomorrow.toISOString(),
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

async function requireAdmin(c) {
  const user = await requireAuth(c)
  if (!user) return null
  const allowed = await c.env.DB.prepare('SELECT email FROM admin_allowlist WHERE email=?').bind(user.email).first()
  return allowed ? user : null
}

app.get('/admin/check', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ admin: false }, 403)
  return json({ admin: true, email: user.email })
})

app.get('/admin/stats', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)

  const today = new Date().toISOString().slice(0, 10)
  const [users, keys, requests, freeToday] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) as count FROM users WHERE verified=1').first(),
    c.env.DB.prepare('SELECT COUNT(*) as count FROM api_keys WHERE revoked=0').first(),
    c.env.DB.prepare('SELECT SUM(requests) as total FROM api_keys').first(),
    c.env.DB.prepare("SELECT SUM(count) as total FROM rate_limits WHERE key LIKE 'free:%' AND window_start=?").bind(today).first(),
  ])

  const topKeys = await c.env.DB.prepare(
    'SELECT k.label, k.requests, k.month_requests, u.email FROM api_keys k JOIN users u ON k.user_id=u.id WHERE k.revoked=0 ORDER BY k.requests DESC LIMIT 20'
  ).all()

  return json({
    users: users.count,
    active_keys: keys.count,
    total_requests: requests.total || 0,
    free_requests_today: freeToday.total || 0,
    top_keys: topKeys.results,
  })
})

app.get('/admin/users', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)

  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.verified, u.created_at,
     COUNT(k.id) as key_count, COALESCE(SUM(k.requests),0) as total_requests
     FROM users u LEFT JOIN api_keys k ON k.user_id=u.id AND k.revoked=0
     GROUP BY u.id ORDER BY u.created_at DESC LIMIT 100`
  ).all()

  return json({ users: results })
})

app.get('/admin/allowlist', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)
  const { results } = await c.env.DB.prepare('SELECT email, added_by, added_at FROM admin_allowlist ORDER BY added_at ASC').all()
  return json({ allowlist: results })
})

app.post('/admin/allowlist', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)
  const { email } = await c.req.json().catch(() => ({}))
  if (!email || !validEmail(email)) return json({ error: 'Invalid email' }, 400)
  await c.env.DB.prepare('INSERT OR IGNORE INTO admin_allowlist (email, added_by) VALUES (?,?)').bind(email.toLowerCase(), user.email).run()
  return json({ ok: true })
})

app.delete('/admin/allowlist/:email', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)
  const target = decodeURIComponent(c.req.param('email'))
  if (target === 'fearlessaviatorclan@gmail.com') return json({ error: 'Cannot remove owner' }, 400)
  await c.env.DB.prepare('DELETE FROM admin_allowlist WHERE email=?').bind(target).run()
  return json({ ok: true })
})

// ── Admin: daily usage chart ───────────────────────────────────────────────

app.get('/admin/daily', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)

  // Build last 14 date strings
  const days = []
  const now = new Date()
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now)
    d.setUTCDate(d.getUTCDate() - i)
    days.push(d.toISOString().slice(0, 10))
  }

  const { results } = await c.env.DB.prepare(
    `SELECT window_start AS date, SUM(count) AS count
     FROM rate_limits
     WHERE key LIKE 'free:%' AND window_start >= ?
     GROUP BY window_start ORDER BY window_start ASC`
  ).bind(days[0]).all()

  const byDate = Object.fromEntries(results.map(r => [r.date, Number(r.count)]))
  return json({ daily: days.map(d => ({ date: d, count: byDate[d] || 0 })) })
})

// ── Admin: invite flow ─────────────────────────────────────────────────────

app.post('/admin/invite', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)
  const { email } = await c.req.json().catch(() => ({}))
  if (!email || !validEmail(email)) return json({ error: 'Invalid email' }, 400)

  const token = crypto.randomUUID()
  const expires_at = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60 // 7 days

  await c.env.DB.prepare(
    'INSERT INTO admin_invites (token, email, invited_by, expires_at) VALUES (?,?,?,?)'
  ).bind(token, email.toLowerCase(), user.email, expires_at).run()

  if (c.env.RESEND_API_KEY) {
    const link = `https://api.amplifiedsmp.org/admin/invite/accept?token=${token}`
    c.executionCtx.waitUntil(fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: 'Axion Labs <noreply@amplifiedsmp.org>',
        to: [email],
        subject: `${user.email} invited you to the Axion admin panel`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0f0f11;color:#e8e8f0">
          <h2 style="margin:0 0 8px;color:#e8e8f0">You've been invited</h2>
          <p style="color:#888;margin:0 0 24px">${user.email} has invited you to become an admin on Axion Labs.</p>
          <a href="${link}" style="display:inline-block;background:#e8602c;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Accept invitation →</a>
          <p style="color:#666;font-size:12px;margin-top:24px">This link expires in 7 days. If you didn't expect this, you can safely ignore it.</p>
        </div>`,
      }),
    }))
  }

  return json({ ok: true })
})

app.get('/admin/invite/accept', async (c) => {
  const token = c.req.query('token')
  if (!token) return new Response('Missing token.', { status: 400, headers: { 'Content-Type': 'text/plain' } })

  const invite = await c.env.DB.prepare(
    'SELECT * FROM admin_invites WHERE token=? AND used=0'
  ).bind(token).first()

  if (!invite) return new Response('Invalid or already used invitation link.', { status: 400, headers: { 'Content-Type': 'text/plain' } })
  if (invite.expires_at < Math.floor(Date.now() / 1000)) {
    return new Response('This invitation has expired.', { status: 400, headers: { 'Content-Type': 'text/plain' } })
  }

  await c.env.DB.prepare('INSERT OR IGNORE INTO admin_allowlist (email, added_by) VALUES (?,?)').bind(invite.email, invite.invited_by).run()
  await c.env.DB.prepare('UPDATE admin_invites SET used=1 WHERE token=?').bind(token).run()

  return new Response(null, {
    status: 302,
    headers: { Location: `https://axion.amplifiedsmp.org/admin#invited=1` },
  })
})

// ── Dashboard: daily usage chart ──────────────────────────────────────────

app.get('/dashboard/daily', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)

  const days = []
  const now = new Date()
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now)
    d.setUTCDate(d.getUTCDate() - i)
    days.push(d.toISOString().slice(0, 10))
  }

  const { results } = await c.env.DB.prepare(
    `SELECT d.date, SUM(d.count) AS count
     FROM usage_daily d
     JOIN api_keys k ON k.id = d.key_id
     WHERE k.user_id=? AND k.revoked=0 AND d.date >= ?
     GROUP BY d.date ORDER BY d.date ASC`
  ).bind(user.id, days[0]).all()

  const byDate = Object.fromEntries(results.map(r => [r.date, Number(r.count)]))
  return json({ daily: days.map(d => ({ date: d, count: byDate[d] || 0 })) })
})

// ── Auth: device flow (CLI login) ─────────────────────────────────────────

const DEVICE_TTL = 15 * 60 // 15 minutes

app.post('/auth/device', async (c) => {
  const code = crypto.randomUUID().replace(/-/g, '').slice(0, 24)
  const expires_at = Math.floor(Date.now() / 1000) + DEVICE_TTL
  await c.env.DB.prepare('INSERT INTO device_codes (code, expires_at) VALUES (?,?)').bind(code, expires_at).run()
  return json({ device_code: code, expires_in: DEVICE_TTL })
})

app.get('/auth/device/poll', async (c) => {
  const code = c.req.query('code')
  if (!code) return json({ error: 'Missing code' }, 400)

  const row = await c.env.DB.prepare('SELECT * FROM device_codes WHERE code=?').bind(code).first()
  if (!row) return json({ error: 'Invalid code' }, 400)
  if (row.expires_at < Math.floor(Date.now() / 1000)) return json({ error: 'Code expired' }, 400)
  if (!row.user_id) return json({ pending: true })

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(row.user_id).first()
  if (!user) return json({ error: 'User not found' }, 400)

  // Clean up
  c.executionCtx.waitUntil(c.env.DB.prepare('DELETE FROM device_codes WHERE code=?').bind(code).run())

  const token = await makeToken(user.id, c.env.TOKEN_SECRET)
  return json({ token, email: user.email })
})

app.post('/auth/device/authorize', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const { code } = await c.req.json().catch(() => ({}))
  if (!code) return json({ error: 'code required' }, 400)

  const row = await c.env.DB.prepare('SELECT * FROM device_codes WHERE code=?').bind(code).first()
  if (!row) return json({ error: 'Invalid code' }, 400)
  if (row.expires_at < Math.floor(Date.now() / 1000)) return json({ error: 'Code expired' }, 400)
  if (row.user_id) return json({ error: 'Already authorized' }, 400)

  await c.env.DB.prepare('UPDATE device_codes SET user_id=? WHERE code=?').bind(user.id, code).run()
  return json({ ok: true })
})

// ── Orgs ───────────────────────────────────────────────────────────────────

async function requireOrgMember(c, orgId) {
  const user = await requireAuth(c)
  if (!user) return null
  const mem = await c.env.DB.prepare(
    'SELECT role FROM org_members WHERE org_id=? AND user_id=?'
  ).bind(orgId, user.id).first()
  if (!mem) return null
  return { user, role: mem.role }
}

async function requireOrgOwner(c, orgId) {
  const ctx = await requireOrgMember(c, orgId)
  if (!ctx) return null
  if (ctx.role !== 'owner') return null
  return ctx
}

// Create org
app.post('/orgs', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const { name } = await c.req.json().catch(() => ({}))
  if (!name?.trim()) return json({ error: 'name required' }, 400)

  const id = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO orgs (id, name, owner_id) VALUES (?,?,?)').bind(id, name.trim(), user.id).run()
  await c.env.DB.prepare('INSERT INTO org_members (org_id, user_id, role) VALUES (?,?,?)').bind(id, user.id, 'owner').run()
  return json({ id, name: name.trim(), role: 'owner' }, 201)
})

// List orgs for current user
app.get('/orgs', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const { results } = await c.env.DB.prepare(
    `SELECT o.id, o.name, o.owner_id, m.role, o.created_at
     FROM orgs o JOIN org_members m ON m.org_id=o.id
     WHERE m.user_id=? ORDER BY o.created_at DESC`
  ).bind(user.id).all()
  return json({ orgs: results })
})

// Get org detail (members + keys)
app.get('/orgs/:id', async (c) => {
  const ctx = await requireOrgMember(c, c.req.param('id'))
  if (!ctx) return json({ error: 'Forbidden' }, 403)
  const orgId = c.req.param('id')

  const [org, members, keys] = await Promise.all([
    c.env.DB.prepare('SELECT id, name, owner_id, created_at FROM orgs WHERE id=?').bind(orgId).first(),
    c.env.DB.prepare(
      `SELECT m.user_id, m.role, m.joined_at, u.email
       FROM org_members m JOIN users u ON u.id=m.user_id
       WHERE m.org_id=? ORDER BY m.joined_at ASC`
    ).bind(orgId).all(),
    c.env.DB.prepare(
      'SELECT id, label, key_value, created_at, last_used, requests, month_requests FROM api_keys WHERE org_id=? AND revoked=0 ORDER BY created_at DESC'
    ).bind(orgId).all(),
  ])

  if (!org) return json({ error: 'Not found' }, 404)
  return json({ org, members: members.results, keys: keys.results, myRole: ctx.role })
})

// Rename org
app.patch('/orgs/:id', async (c) => {
  const ctx = await requireOrgOwner(c, c.req.param('id'))
  if (!ctx) return json({ error: 'Forbidden' }, 403)
  const { name } = await c.req.json().catch(() => ({}))
  if (!name?.trim()) return json({ error: 'name required' }, 400)
  await c.env.DB.prepare('UPDATE orgs SET name=? WHERE id=?').bind(name.trim(), c.req.param('id')).run()
  return json({ ok: true })
})

// Delete org
app.delete('/orgs/:id', async (c) => {
  const ctx = await requireOrgOwner(c, c.req.param('id'))
  if (!ctx) return json({ error: 'Forbidden' }, 403)
  const orgId = c.req.param('id')

  // Revoke all org keys, delete members + invites + org
  await c.env.DB.prepare('UPDATE api_keys SET revoked=1 WHERE org_id=?').bind(orgId).run()
  await c.env.DB.prepare('DELETE FROM org_invites WHERE org_id=?').bind(orgId).run()
  await c.env.DB.prepare('DELETE FROM org_members WHERE org_id=?').bind(orgId).run()
  await c.env.DB.prepare('DELETE FROM orgs WHERE id=?').bind(orgId).run()
  return json({ ok: true })
})

// Invite a member (sends email with link to /keys#invite=TOKEN)
app.post('/orgs/:id/invite', async (c) => {
  const ctx = await requireOrgMember(c, c.req.param('id'))
  if (!ctx) return json({ error: 'Forbidden' }, 403)
  const orgId = c.req.param('id')
  const { email, role } = await c.req.json().catch(() => ({}))
  if (!email || !validEmail(email)) return json({ error: 'Invalid email' }, 400)
  const assignRole = role === 'owner' ? 'owner' : 'member'

  const token = crypto.randomUUID()
  const expires_at = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60

  const org = await c.env.DB.prepare('SELECT name FROM orgs WHERE id=?').bind(orgId).first()

  await c.env.DB.prepare(
    'INSERT INTO org_invites (token, org_id, email, role, invited_by, expires_at) VALUES (?,?,?,?,?,?)'
  ).bind(token, orgId, email.toLowerCase(), assignRole, ctx.user.email, expires_at).run()

  if (c.env.RESEND_API_KEY) {
    const link = `https://axion.amplifiedsmp.org/keys#invite=${token}&org=${orgId}`
    c.executionCtx.waitUntil(fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: 'Axion Labs <noreply@amplifiedsmp.org>',
        to: [email],
        subject: `${ctx.user.email} invited you to ${org?.name || 'a team'} on Axion`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0f0f11;color:#e8e8f0">
          <h2 style="margin:0 0 8px;color:#e8e8f0">You've been invited</h2>
          <p style="color:#888;margin:0 0 24px">${ctx.user.email} invited you to join <strong style="color:#e8e8f0">${org?.name || 'a team'}</strong> on Axion Labs.</p>
          <a href="${link}" style="display:inline-block;background:#e8602c;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Accept invitation →</a>
          <p style="color:#666;font-size:12px;margin-top:24px">Expires in 7 days. You'll need to sign in or create an Axion account to accept.</p>
        </div>`,
      }),
    }))
  }

  return json({ ok: true })
})

// Accept org invite (authenticated — resolves user_id from bearer token)
app.post('/orgs/invite/accept', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const { token } = await c.req.json().catch(() => ({}))
  if (!token) return json({ error: 'token required' }, 400)

  const invite = await c.env.DB.prepare(
    'SELECT * FROM org_invites WHERE token=? AND used=0'
  ).bind(token).first()

  if (!invite) return json({ error: 'Invalid or already used invite' }, 400)
  if (invite.expires_at < Math.floor(Date.now() / 1000)) return json({ error: 'Invite expired' }, 400)

  // Upsert — if already a member, upgrade role if invite is owner
  const existing = await c.env.DB.prepare(
    'SELECT role FROM org_members WHERE org_id=? AND user_id=?'
  ).bind(invite.org_id, user.id).first()

  if (existing) {
    if (invite.role === 'owner' && existing.role !== 'owner') {
      await c.env.DB.prepare('UPDATE org_members SET role=? WHERE org_id=? AND user_id=?').bind('owner', invite.org_id, user.id).run()
    }
  } else {
    await c.env.DB.prepare('INSERT INTO org_members (org_id, user_id, role) VALUES (?,?,?)').bind(invite.org_id, user.id, invite.role).run()
  }

  await c.env.DB.prepare('UPDATE org_invites SET used=1 WHERE token=?').bind(token).run()
  return json({ ok: true, org_id: invite.org_id, role: invite.role })
})

// Remove member (owner removes anyone, member removes self = leave)
app.delete('/orgs/:id/members/:uid', async (c) => {
  const orgId = c.req.param('id')
  const targetUid = c.req.param('uid')
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)

  // Allow if removing self, or if requester is owner
  const myMem = await c.env.DB.prepare('SELECT role FROM org_members WHERE org_id=? AND user_id=?').bind(orgId, user.id).first()
  if (!myMem) return json({ error: 'Forbidden' }, 403)
  if (user.id !== targetUid && myMem.role !== 'owner') return json({ error: 'Forbidden' }, 403)

  // Can't remove the org owner
  const org = await c.env.DB.prepare('SELECT owner_id FROM orgs WHERE id=?').bind(orgId).first()
  if (org?.owner_id === targetUid) return json({ error: 'Cannot remove the org owner' }, 400)

  await c.env.DB.prepare('DELETE FROM org_members WHERE org_id=? AND user_id=?').bind(orgId, targetUid).run()
  return json({ ok: true })
})

// Create org-scoped API key
app.post('/orgs/:id/keys', async (c) => {
  const ctx = await requireOrgMember(c, c.req.param('id'))
  if (!ctx) return json({ error: 'Forbidden' }, 403)
  const orgId = c.req.param('id')
  const { label } = await c.req.json().catch(() => ({}))
  const id = crypto.randomUUID()
  const key_value = genKey()
  await c.env.DB.prepare(
    'INSERT INTO api_keys (id, user_id, org_id, key_value, label) VALUES (?,?,?,?,?)'
  ).bind(id, ctx.user.id, orgId, key_value, label || 'Team Key').run()
  return json({ id, key_value, label: label || 'Team Key', org_id: orgId }, 201)
})

export default app
