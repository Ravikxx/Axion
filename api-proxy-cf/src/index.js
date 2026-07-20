import { Hono } from 'hono'
import { cors } from 'hono/cors'
import {
  CreditCodeError,
  buildSquareCheckoutPayload,
  canStartUsage,
  chargeAccountUsage,
  createCreditCode,
  deactivateCreditCode,
  readAccountUsage,
  listCreditCodes,
  microdollarsToUsd,
  periodStatus,
  redeemCreditCode,
  WEEK_MS,
  WINDOW_MS,
} from './billing.js'
import { probeLumenHealth, proxyLumenRequest } from './lumen-upstream.js'
import { runStatusChecks, getStatusSnapshot } from './status.js'

const app = new Hono()
const WEB_ORIGIN = 'https://axion.amplifiedsmp.org'

app.use('*', cors({
  origin: WEB_ORIGIN,
  credentials: true,
  allowHeaders: ['Content-Type', 'Authorization'],
}))

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
const SESSION_COOKIE_TTL = 30 * 24 * 60 * 60 * 1000 // 30 days
const SESSION_COOKIE = 'axion_session'

// `v` pins the token to the user's token_version at mint time so a password
// reset (which bumps token_version) invalidates every session token issued
// before it, even though tokens themselves are stateless/unrevocable by id.
async function makeToken(uid, secret, version = 0, ttlMs = TOKEN_TTL) {
  const payload = btoa(JSON.stringify({ uid, v: version, exp: Date.now() + ttlMs }))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return `${payload}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`
}

// Generic signed-payload helper reused for the OAuth "link intent" state —
// same HMAC scheme as makeToken but for an arbitrary object, verified with
// the existing parseToken (it only cares about a `.`-delimited payload+sig
// and an `exp` field, not the `uid`/`v` shape specifically).
async function signState(obj, secret) {
  const payload = btoa(JSON.stringify(obj))
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
  if (!secret) return false // reject if not configured
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
  if (!user || user.banned) return null
  // Token minted before the user's last password reset — reject even though
  // the signature and expiry are otherwise valid.
  if ((payload.v || 0) !== (user.token_version || 0)) return null
  return user
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

// ── Session cookie ───────────────────────────────────────────────────────
// A parallel, longer-lived identity channel for requests that can't carry an
// Authorization header — namely GET /auth/link/:provider, which is a
// top-level browser navigation, not a fetch. Set on every successful
// browser-facing login (password, OAuth callback, email verify) as a
// Domain=.amplifiedsmp.org cookie so it's sent on both same-site XHR (with
// credentials:'include', already wired into the frontend's login/register
// calls) and top-level cross-subdomain navigations (SameSite=Lax allows
// top-level GET navigations regardless of site).

function getCookieValue(c, name) {
  const header = c.req.header('Cookie') || ''
  const match = header.match(new RegExp('(?:^|; )' + name + '=([^;]*)'))
  return match ? decodeURIComponent(match[1]) : null
}

function sessionCookieHeader(token) {
  return `${SESSION_COOKIE}=${token}; Domain=.amplifiedsmp.org; Path=/; Max-Age=${SESSION_COOKIE_TTL / 1000}; HttpOnly; Secure; SameSite=Lax`
}

function clearSessionCookieHeader() {
  return `${SESSION_COOKIE}=; Domain=.amplifiedsmp.org; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
}

async function sessionUserFromCookie(c) {
  const token = getCookieValue(c, SESSION_COOKIE)
  if (!token) return null
  const payload = await parseToken(token, c.env.TOKEN_SECRET)
  if (!payload?.uid) return null
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(payload.uid).first()
  if (!user || user.banned) return null
  if ((payload.v || 0) !== (user.token_version || 0)) return null
  return user
}

// 3 requests per account per 15 minutes — distinct from the per-IP
// checkRateLimit above, so an account can't be spammed regardless of how
// many IPs the request comes from (and vice versa, an IP can't spam many
// accounts beyond the per-IP cap either — both checks apply).
async function checkAccountRateLimit(db, uid, action, limit = 3) {
  const key = `${action}:${uid}`
  const window = 15 * 60
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

// ── Email ──────────────────────────────────────────────────────────────────

async function sendEmail(resendKey, { to, subject, html, from, replyTo }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
    body: JSON.stringify({
      from: from || 'Axion Labs <noreply@amplifiedsmp.org>',
      to: [to],
      subject,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.error(`[sendEmail] Resend API error ${res.status} sending to ${to}: ${body}`)
  } else {
    console.log(`[sendEmail] sent to ${to}`)
  }
  return res
}

function emailWrap(inner) {
  return `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0f0f11;color:#e8e8f0">${inner}</div>`
}

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

  const existing = await c.env.DB.prepare('SELECT id, verified, banned FROM users WHERE email=?').bind(email.toLowerCase()).first()
  if (existing && existing.verified) return json({ error: 'Email already registered' }, 409)

  const id = existing?.id || crypto.randomUUID()
  const pw_hash = await hashPw(password, c.env.PW_SALT)
  const verify_token = crypto.randomUUID()

  if (existing) {
    await c.env.DB.prepare('UPDATE users SET pw_hash=?, verify_token=? WHERE id=?').bind(pw_hash, verify_token, id).run()
  } else {
    await c.env.DB.prepare('INSERT INTO users (id, email, pw_hash, verify_token) VALUES (?,?,?,?)').bind(id, email.toLowerCase(), pw_hash, verify_token).run()
  }

  // Store the user's IP
  await c.env.DB.prepare('UPDATE users SET ip=? WHERE id=?').bind(ip, id).run()

  // Check for duplicate IP among verified users
  const dupe = await c.env.DB.prepare(
    'SELECT id, email FROM users WHERE ip=? AND verified=1 AND id!=? LIMIT 1'
  ).bind(ip, id).first()

  if (dupe) {
    const reason = 'Duplicate IP: another verified account shares this IP address.'
    await c.env.DB.prepare('UPDATE users SET banned=1, ban_reason=? WHERE id=?').bind(reason, id).run()
    const token = crypto.randomUUID()
    const appealId = crypto.randomUUID()
    const now = Math.floor(Date.now() / 1000)
    await c.env.DB.prepare(
      'INSERT INTO appeals (id, user_id, email, token, status, created_at) VALUES (?,?,?,?,?,?)'
    ).bind(appealId, id, email.toLowerCase(), token, 'pending', now).run()

    if (c.env.RESEND_API_KEY) {
      const appealUrl = 'https://api.amplifiedsmp.org/appeal/' + token
      c.executionCtx.waitUntil(sendEmail(c.env.RESEND_API_KEY, {
        to: email.toLowerCase(),
        subject: 'Your Axion account has been suspended',
        html: emailWrap(`
          <h2 style="margin:0 0 8px;color:#e8e8f0">Account suspended</h2>
          <p style="color:#ccc;margin:0 0 16px">Your account was suspended because another verified account already exists from your IP address.</p>
          <p style="color:#ccc;margin:0 0 24px">If you believe this is an error, click the link below to submit an appeal. We'll review your case.</p>
          <a href="${appealUrl}" style="display:inline-block;background:#e8602c;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Submit appeal →</a>
          <p style="color:#555;font-size:12px;margin-top:24px">Or paste this link: ${appealUrl}</p>
        `),
      }))
    }

    return json({ banned: true, message: 'Your account was suspended because another account already exists from your IP address. Check your email for an appeal link.' })
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
  const sessionToken = await makeToken(user.id, c.env.TOKEN_SECRET, user.token_version || 0)
  const res = new Response(null, {
    status: 302,
    headers: { Location: `https://axion.amplifiedsmp.org/keys#verified=${encodeURIComponent(sessionToken)}&email=${encodeURIComponent(user.email)}` },
  })
  res.headers.set('Set-Cookie', sessionCookieHeader(await makeToken(user.id, c.env.TOKEN_SECRET, user.token_version || 0, SESSION_COOKIE_TTL)))
  return res
})

// ── OAuth shared helper ────────────────────────────────────────────────────

const RETURN_DESTINATIONS = {
  admin:      'https://axion.amplifiedsmp.org/admin',
  home:       'https://axion.amplifiedsmp.org',
  keys:       'https://axion.amplifiedsmp.org/keys',
  playground: 'https://axion.amplifiedsmp.org/playground',
  chat:       'https://axion.amplifiedsmp.org/chat',
}

async function oauthFinish(c, { id_field, email, provider_id, return_to }) {
  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  let user = await c.env.DB.prepare(`SELECT * FROM users WHERE ${id_field}=?`).bind(provider_id).first()
  if (!user && email) {
    user = await c.env.DB.prepare('SELECT * FROM users WHERE email=?').bind(email.toLowerCase()).first()
  }
  if (user) {
    const updateFields = [id_field, provider_id]
    if (!user[id_field]) {
      updateFields.push('verified', 1)
    }
    updateFields.push('ip', ip, user.id)
    await c.env.DB.prepare(
      `UPDATE users SET ${id_field}=?, verified=1, ip=? WHERE id=?`
    ).bind(provider_id, ip, user.id).run()
    if (user.banned) {
      const token = await makeToken(user.id, c.env.TOKEN_SECRET, user.token_version || 0)
      const base = RETURN_DESTINATIONS[return_to] || RETURN_DESTINATIONS.keys
      return new Response(null, {
        status: 302,
        headers: { Location: `${base}#verified=${encodeURIComponent(token)}&email=${encodeURIComponent(email || '')}&banned=1` },
      })
    }
  } else {
    if (!email) return new Response('Could not get email from provider', { status: 400 })
    // Check for existing verified users with this IP BEFORE creating the user
    // to avoid a race condition where two concurrent OAuth logins ban each other.
    const before = await c.env.DB.prepare(
      'SELECT id, email FROM users WHERE ip=? AND verified=1 LIMIT 1'
    ).bind(ip).first()
    if (before) {
      const uid = crypto.randomUUID()
      const reason = 'Duplicate IP: another verified account shares this IP address.'
      await c.env.DB.prepare(
        `INSERT INTO users (id, email, pw_hash, verified, ip, ${id_field}) VALUES (?,?,?,1,?,?)`
      ).bind(uid, email.toLowerCase(), '', ip, provider_id).run()
      await c.env.DB.prepare('UPDATE users SET banned=1, ban_reason=? WHERE id=?').bind(reason, uid).run()
      const appealToken = crypto.randomUUID()
      const appealId = crypto.randomUUID()
      const now = Math.floor(Date.now() / 1000)
      await c.env.DB.prepare(
        'INSERT INTO appeals (id, user_id, email, token, status, created_at) VALUES (?,?,?,?,?,?)'
      ).bind(appealId, uid, email.toLowerCase(), appealToken, 'pending', now).run()
      if (c.env.RESEND_API_KEY) {
        const appealUrl = 'https://api.amplifiedsmp.org/appeal/' + appealToken
        c.executionCtx.waitUntil(sendEmail(c.env.RESEND_API_KEY, {
          to: email.toLowerCase(),
          subject: 'Your Axion account has been suspended',
          html: emailWrap(`
            <h2 style="margin:0 0 8px;color:#e8e8f0">Account suspended</h2>
            <p style="color:#ccc;margin:0 0 16px">Your account was suspended because another verified account already exists from your IP address.</p>
            <p style="color:#ccc;margin:0 0 24px">If you believe this is an error, click the link below to submit an appeal.</p>
            <a href="${appealUrl}" style="display:inline-block;background:#e8602c;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Submit appeal →</a>
            <p style="color:#555;font-size:12px;margin-top:24px">Or paste this link: ${appealUrl}</p>
          `),
        }))
      }
      const token = await makeToken(uid, c.env.TOKEN_SECRET, 0)
      const base = RETURN_DESTINATIONS[return_to] || RETURN_DESTINATIONS.keys
      return new Response(null, {
        status: 302,
        headers: { Location: `${base}#verified=${encodeURIComponent(token)}&email=${encodeURIComponent(email || '')}&banned=1` },
      })
    }
    const uid = crypto.randomUUID()
    await c.env.DB.prepare(
      `INSERT INTO users (id, email, pw_hash, verified, ip, ${id_field}) VALUES (?,?,?,1,?,?)`
    ).bind(uid, email.toLowerCase(), '', ip, provider_id).run()
    user = { id: uid }
  }
  const token = await makeToken(user.id, c.env.TOKEN_SECRET, user.token_version || 0)
  const base = RETURN_DESTINATIONS[return_to] || RETURN_DESTINATIONS.keys
  const res = new Response(null, {
    status: 302,
    headers: { Location: `${base}#verified=${encodeURIComponent(token)}&email=${encodeURIComponent(email || '')}` },
  })
  res.headers.set('Set-Cookie', sessionCookieHeader(await makeToken(user.id, c.env.TOKEN_SECRET, user.token_version || 0, SESSION_COOKIE_TTL)))
  return res
}

// ── Account linking (settings page "Connect" button) ──────────────────────
// GET /auth/link/:provider is a top-level browser navigation from
// settings.html, not a fetch — it can carry no Authorization header. Identity
// is proven via the session cookie instead, and the OAuth `state` param
// carries a signed "link intent" (uid + provider + return url) that survives
// the round trip to the provider and back so the callback knows who to link
// to without trusting anything the browser sends at that point.

const PROVIDER_META = {
  google:  { idField: 'google_id' },
  github:  { idField: 'github_id' },
  discord: { idField: 'discord_id' },
}

function allowedReturn(url) {
  try {
    const u = new URL(url)
    if (u.origin === WEB_ORIGIN) return url
  } catch {}
  return `${WEB_ORIGIN}/settings.html`
}

async function oauthLinkFinish(c, { id_field, provider, provider_id, state }) {
  if (!state?.uid) {
    return new Response('This link request expired or is invalid. Go back to Settings and try again.', { status: 400, headers: { 'Content-Type': 'text/plain' } })
  }
  const target = await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(state.uid).first()
  if (!target || target.banned) {
    return new Response('Could not complete linking — please sign in again and retry.', { status: 401, headers: { 'Content-Type': 'text/plain' } })
  }
  const existing = await c.env.DB.prepare(`SELECT id FROM users WHERE ${id_field}=?`).bind(provider_id).first()
  if (existing && existing.id !== target.id) {
    return new Response(`This ${provider} account is already linked to a different Axion account.`, { status: 409, headers: { 'Content-Type': 'text/plain' } })
  }
  await c.env.DB.prepare(`UPDATE users SET ${id_field}=? WHERE id=?`).bind(provider_id, target.id).run()
  return new Response(null, { status: 302, headers: { Location: allowedReturn(state.return) } })
}

app.get('/auth/link/:provider', async (c) => {
  const provider = c.req.param('provider')
  const meta = PROVIDER_META[provider]
  if (!meta) return new Response('Unknown provider', { status: 400 })

  const user = await sessionUserFromCookie(c)
  if (!user) {
    return new Response("You need to be signed in to connect an account. Go back, sign in, then try again.", { status: 401, headers: { 'Content-Type': 'text/plain' } })
  }

  const returnUrl = allowedReturn(c.req.query('return') || '')
  const state = await signState({ action: 'link', uid: user.id, provider, return: returnUrl, exp: Date.now() + 10 * 60 * 1000 }, c.env.TOKEN_SECRET)

  if (provider === 'google') {
    const params = new URLSearchParams({
      client_id: c.env.GOOGLE_CLIENT_ID,
      redirect_uri: 'https://api.amplifiedsmp.org/auth/google/callback',
      response_type: 'code',
      scope: 'openid email profile',
      prompt: 'select_account',
      state,
    })
    return new Response(null, { status: 302, headers: { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` } })
  }
  if (provider === 'github') {
    const params = new URLSearchParams({
      client_id: c.env.GITHUB_CLIENT_ID,
      redirect_uri: 'https://api.amplifiedsmp.org/auth/github/callback',
      scope: 'user:email',
      state,
    })
    return new Response(null, { status: 302, headers: { Location: `https://github.com/login/oauth/authorize?${params}` } })
  }
  const params = new URLSearchParams({
    client_id: c.env.DISCORD_CLIENT_ID,
    redirect_uri: 'https://api.amplifiedsmp.org/auth/discord/callback',
    response_type: 'code',
    scope: 'identify email',
    state,
  })
  return new Response(null, { status: 302, headers: { Location: `https://discord.com/oauth2/authorize?${params}` } })
})

app.delete('/auth/link/:provider', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const meta = PROVIDER_META[c.req.param('provider')]
  if (!meta) return json({ error: 'Unknown provider' }, 400)
  if (!user[meta.idField]) return json({ error: 'That account is not connected' }, 400)

  const otherFields = Object.values(PROVIDER_META).map(m => m.idField).filter(f => f !== meta.idField)
  const hasOtherAuth = !!user.pw_hash || otherFields.some(f => !!user[f])
  if (!hasOtherAuth) {
    return json({ error: 'This is your only sign-in method — set a password or connect another provider before disconnecting this one.' }, 409)
  }

  await c.env.DB.prepare(`UPDATE users SET ${meta.idField}=NULL WHERE id=?`).bind(user.id).run()
  return json({ ok: true })
})

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

  const linkState = await parseToken(c.req.query('state'), c.env.TOKEN_SECRET)
  if (linkState?.action === 'link') {
    return oauthLinkFinish(c, { id_field: 'google_id', provider: 'google', provider_id: gUser.id, state: linkState })
  }
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

  const linkState = await parseToken(c.req.query('state'), c.env.TOKEN_SECRET)
  if (linkState?.action === 'link') {
    return oauthLinkFinish(c, { id_field: 'github_id', provider: 'github', provider_id: String(profile.id), state: linkState })
  }
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

  const linkState = await parseToken(c.req.query('state'), c.env.TOKEN_SECRET)
  if (linkState?.action === 'link') {
    return oauthLinkFinish(c, { id_field: 'discord_id', provider: 'discord', provider_id: dUser.id, state: linkState })
  }
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
  if (user.banned) return json({ error: 'Your account has been suspended. Check your email for an appeal link.', banned: true }, 403)
  const res = json({ token: await makeToken(user.id, c.env.TOKEN_SECRET, user.token_version || 0), email: user.email })
  res.headers.set('Set-Cookie', sessionCookieHeader(await makeToken(user.id, c.env.TOKEN_SECRET, user.token_version || 0, SESSION_COOKIE_TTL)))
  return res
})

// Reads the session cookie set at login and mints a fresh short-lived Bearer
// token from it — lets a page with an empty localStorage (new tab, cleared
// storage) silently restore a session, and doubles as the identity check
// GET /auth/link/:provider itself relies on (same cookie, same verification).
app.get('/auth/session', async (c) => {
  const user = await sessionUserFromCookie(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const res = json({ token: await makeToken(user.id, c.env.TOKEN_SECRET, user.token_version || 0), email: user.email })
  res.headers.set('Set-Cookie', sessionCookieHeader(await makeToken(user.id, c.env.TOKEN_SECRET, user.token_version || 0, SESSION_COOKIE_TTL)))
  return res
})

const RESET_TOKEN_TTL = 60 * 60 // 1 hour, in seconds (reset_token_expires is epoch seconds)

async function sendPasswordResetEmail(email, token, resendKey) {
  const link = `https://axion.amplifiedsmp.org/keys#reset=${token}`
  await sendEmail(resendKey, {
    to: email,
    subject: 'Reset your Axion password',
    html: emailWrap(`
      <h2 style="margin:0 0 8px;color:#e8e8f0">Reset your password</h2>
      <p style="color:#ccc;margin:0 0 24px">Click the button below to choose a new password for your Axion account.</p>
      <a href="${link}" style="display:inline-block;background:#e8602c;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Reset password →</a>
      <p style="color:#555;font-size:12px;margin-top:24px">This link expires in 1 hour and can only be used once. If you didn't request this, ignore this email — your password won't change.</p>
    `),
  })
}

// Always responds with the same generic message regardless of whether the
// email is registered, so this endpoint can't be used to enumerate accounts.
app.post('/auth/forgot-password', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  if (!await checkRateLimit(c.env.DB, ip)) return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429)

  const { email, turnstile } = await c.req.json().catch(() => ({}))
  if (!await verifyTurnstile(turnstile, c.env.TURNSTILE_SECRET, ip)) return json({ error: 'Security check failed. Please try again.' }, 403)

  const generic = { ok: true, message: 'If an account exists with that email, a reset link has been sent.' }
  if (!email || !validEmail(email)) return json(generic)

  const user = await c.env.DB.prepare('SELECT id, email, banned FROM users WHERE email=?').bind(email.toLowerCase()).first()
  // Banned accounts go through the appeal flow, not password reset — a reset
  // link would let a suspended user regain access without review.
  if (!user || user.banned) return json(generic)

  const reset_token = crypto.randomUUID()
  const reset_token_expires = Math.floor(Date.now() / 1000) + RESET_TOKEN_TTL
  await c.env.DB.prepare('UPDATE users SET reset_token=?, reset_token_expires=? WHERE id=?')
    .bind(reset_token, reset_token_expires, user.id).run()

  if (c.env.RESEND_API_KEY) {
    c.executionCtx.waitUntil(sendPasswordResetEmail(user.email, reset_token, c.env.RESEND_API_KEY))
  }

  return json(generic)
})

app.post('/auth/reset-password', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  if (!await checkRateLimit(c.env.DB, ip)) return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429)

  const { token, password } = await c.req.json().catch(() => ({}))
  if (!token) return json({ error: 'Missing reset token' }, 400)
  if (!password || password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400)

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE reset_token=?').bind(token).first()
  if (!user) return json({ error: 'This reset link is invalid or has already been used.' }, 400)
  if (!user.reset_token_expires || user.reset_token_expires < Math.floor(Date.now() / 1000)) {
    return json({ error: 'This reset link has expired. Request a new one.' }, 400)
  }

  const pw_hash = await hashPw(password, c.env.PW_SALT)
  // token_version+1 invalidates every session token issued before this
  // reset (see makeToken/requireAuth) — anyone who had a live session,
  // including an attacker who reset the password after taking the account,
  // gets signed out everywhere.
  await c.env.DB.prepare(
    'UPDATE users SET pw_hash=?, reset_token=NULL, reset_token_expires=NULL, token_version=token_version+1 WHERE id=?'
  ).bind(pw_hash, user.id).run()

  return json({ ok: true, message: 'Password updated. Sign in with your new password.' })
})

// Native-app login: same checks as /auth/login minus the Turnstile browser
// challenge, which native apps can't render. Brute force stays bounded by the
// shared per-IP auth rate limit (10 attempts / 15 min).
app.post('/auth/login/app', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  if (!await checkRateLimit(c.env.DB, ip)) return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429)

  const { email, password } = await c.req.json().catch(() => ({}))
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email=?').bind((email || '').toLowerCase()).first()
  const pw_hash = await hashPw(password || '', c.env.PW_SALT)
  if (!user || !user.pw_hash || user.pw_hash !== pw_hash) return json({ error: 'Invalid email or password' }, 401)
  if (!user.verified) return json({ error: 'Please verify your email before signing in.' }, 403)
  if (user.banned) return json({ error: 'Your account has been suspended. Check your email for an appeal link.', banned: true }, 403)
  return json({ token: await makeToken(user.id, c.env.TOKEN_SECRET, user.token_version || 0), email: user.email })
})

// ── Dashboard ──────────────────────────────────────────────────────────────

app.get('/dashboard/keys', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const { results } = await c.env.DB.prepare(
    'SELECT id, label, key_value, created_at, last_used, requests, tokens, month_requests, month_cost FROM api_keys WHERE user_id=? AND revoked=0 ORDER BY created_at DESC'
  ).bind(user.id).all()
  for (const k of results) {
    if (k.key_value && k.key_value.length > 14) {
      k.key_value = k.key_value.slice(0, 10) + '...' + k.key_value.slice(-4)
    }
  }
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
  if (user.plan !== 'pro') {
    const { count } = await c.env.DB.prepare('SELECT COUNT(*) as count FROM api_keys WHERE user_id=? AND revoked=0').bind(user.id).first()
    if (count >= FREE_KEY_CAP) {
      return json({ error: `Free plan is limited to ${FREE_KEY_CAP} API keys. Upgrade to Pro for unlimited keys, or revoke one first.` }, 403)
    }
  }
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

// Authenticated shortcut for the same reset-password flow /auth/forgot-password
// uses — same reset_token/reset_token_expires columns, same email, same
// single-use + 1hr-TTL semantics — just triggered by a proven Bearer token
// instead of an email address + Turnstile, since identity is already known.
app.post('/dashboard/change-password/request', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  if (!await checkAccountRateLimit(c.env.DB, user.id, 'pwreset-req')) {
    return json({ error: 'Too many requests. Try again in 15 minutes.' }, 429)
  }

  const reset_token = crypto.randomUUID()
  const reset_token_expires = Math.floor(Date.now() / 1000) + RESET_TOKEN_TTL
  await c.env.DB.prepare('UPDATE users SET reset_token=?, reset_token_expires=? WHERE id=?')
    .bind(reset_token, reset_token_expires, user.id).run()

  if (c.env.RESEND_API_KEY) {
    c.executionCtx.waitUntil(sendPasswordResetEmail(user.email, reset_token, c.env.RESEND_API_KEY))
  }
  return json({ ok: true })
})

app.get('/dashboard/account', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const usage = await readAccountUsage(c.env.DB, user.id)
  const { weeklyBudget, windowBudget } = limitsForPlan(user.plan)
  return json({
    connected: {
      google: !!user.google_id,
      github: !!user.github_id,
      discord: !!user.discord_id,
    },
    plan: user.plan || 'free',
    credits: {
      balance_microdollars: Math.max(0, usage.credit_balance || 0),
      balance_usd: microdollarsToUsd(Math.max(0, usage.credit_balance || 0)),
    },
    usage: {
      weekly_included_used_microdollars: usage.included_week_cost,
      weekly_included_limit_microdollars: weeklyBudget,
      weekly_included_used_usd: microdollarsToUsd(usage.included_week_cost),
      weekly_included_limit_usd: microdollarsToUsd(weeklyBudget),
      weekly_started: usage.week_started,
      weekly_reset_at: usage.week_reset_at,
      window_included_used_microdollars: usage.included_window_cost,
      window_included_limit_microdollars: windowBudget,
      window_included_used_usd: microdollarsToUsd(usage.included_window_cost),
      window_included_limit_usd: microdollarsToUsd(windowBudget),
      window_started: usage.window_started,
      window_reset_at: usage.window_reset_at,
    },
    metering: {
      unit: 'microdollar',
      usd_per_microdollar: 0.000001,
      input_per_million_tokens_usd: LUMEN_INPUT_PER_M_USD,
      output_per_million_tokens_usd: LUMEN_OUTPUT_PER_M_USD,
    },
  })
})

// Hard-deletes the account (not a soft delete) so an old Bearer token can't
// keep working against a row that's still technically there — requireAuth's
// `SELECT * FROM users WHERE id=?` simply finds nothing and 401s. Child rows
// are cleaned up first since D1/SQLite don't enforce FK constraints by
// default and would otherwise leave orphaned data behind.
app.delete('/dashboard/account', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  if (!await checkAccountRateLimit(c.env.DB, user.id, 'acct-delete', 5)) {
    return json({ error: 'Too many requests. Try again in 15 minutes.' }, 429)
  }

  // D1 enforces the FK constraints declared in schema.sql/migrations (api_keys,
  // email_prefs, device_codes, org_members, orgs.owner_id, appeals all
  // REFERENCES users(id) with no ON DELETE CASCADE) — every referencing row
  // has to be gone before the users row itself can go, hence the full
  // child-tables-first cleanup rather than the softer "revoke, don't delete"
  // api_keys handles elsewhere (DELETE /dashboard/keys/:id): a revoked-but-
  // still-present row still blocks deleting its parent user.
  const db = c.env.DB
  const ownedOrgIds = (await db.prepare('SELECT id FROM orgs WHERE owner_id=?').bind(user.id).all()).results.map(r => r.id)

  const stmts = []
  for (const orgId of ownedOrgIds) {
    stmts.push(db.prepare('DELETE FROM api_keys WHERE org_id=?').bind(orgId))
    stmts.push(db.prepare('DELETE FROM org_invites WHERE org_id=?').bind(orgId))
    stmts.push(db.prepare('DELETE FROM org_members WHERE org_id=?').bind(orgId))
  }
  if (ownedOrgIds.length) {
    stmts.push(db.prepare('DELETE FROM orgs WHERE owner_id=?').bind(user.id))
  }
  stmts.push(
    db.prepare('DELETE FROM org_members WHERE user_id=?').bind(user.id),
    db.prepare('DELETE FROM credit_redemptions WHERE user_id=?').bind(user.id),
    db.prepare('DELETE FROM admin_account_edits WHERE user_id=?').bind(user.id),
    db.prepare('DELETE FROM api_keys WHERE user_id=?').bind(user.id),
    db.prepare('DELETE FROM chats WHERE user_id=?').bind(user.id),
    db.prepare('DELETE FROM email_prefs WHERE user_id=?').bind(user.id),
    db.prepare('DELETE FROM device_codes WHERE user_id=?').bind(user.id),
    db.prepare('DELETE FROM appeals WHERE user_id=?').bind(user.id),
    db.prepare('DELETE FROM rate_limits WHERE key LIKE ?').bind(`%:${user.id}`),
    db.prepare('DELETE FROM users WHERE id=?').bind(user.id),
  )
  await db.batch(stmts)

  const res = json({ ok: true })
  res.headers.set('Set-Cookie', clearSessionCookieHeader())
  return res
})

// ── Billing (Square) ────────────────────────────────────────────────────────
// The "Axion Pro" subscription plan variation in the Square catalog — see
// the Monthly variation under plan LQIOMJA3CQPO2EPLORLAHASG. A Quarterly
// variation also exists in Square (XW3UTLEQKQ6VDNORQO6XTZIS) but Square's
// API won't let it be deleted once created; it's simply never referenced
// here, so it's permanently unreachable from checkout.
const SQUARE_PLAN_VARIATION_ID = 'YEXEI6A4P4NTO73GCAJANOGJ'
const SQUARE_ITEM_VARIATION_ID = '5NSUWXYLVOOXSZXZB7SY6XPQ' // "Regular" $7/mo, backs the plan above
const SQUARE_API = 'https://connect.squareup.com/v2'
const SQUARE_WEBHOOK_URL = 'https://api.amplifiedsmp.org/webhooks/square'

function squareApi(env, path, opts = {}) {
  return fetch(`${SQUARE_API}${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      'Square-Version': '2024-01-18',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  })
}

// Square signs webhook bodies as base64(HMAC-SHA256(notification_url + raw_body, signature_key)).
async function verifySquareSignature(rawBody, signatureHeader, signatureKey) {
  if (!signatureHeader || !signatureKey) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(signatureKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(SQUARE_WEBHOOK_URL + rawBody))
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)))
  // Constant-time compare — this is a signature check, not a plain equality.
  if (expected.length !== signatureHeader.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i)
  return diff === 0
}

// Mints a Square-hosted checkout page for the Axion Pro subscription. Square
// collects the card, creates the Customer + Card + Subscription itself once
// payment succeeds — nothing here touches card data. The buyer is matched
// back to their Axion account by email in the webhook handler below, same
// pattern already used for OAuth account matching (oauthFinish).
app.post('/billing/checkout', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  if (user.plan === 'pro') return json({ error: 'Already on Pro' }, 400)

  const res = await squareApi(c.env, '/online-checkout/payment-links', {
    method: 'POST',
    body: JSON.stringify(buildSquareCheckoutPayload({
      idempotencyKey: crypto.randomUUID(),
      locationId: c.env.SQUARE_LOCATION_ID,
      planVariationId: SQUARE_PLAN_VARIATION_ID,
      itemVariationId: SQUARE_ITEM_VARIATION_ID,
      buyerEmail: user.email,
      redirectUrl: 'https://axion.amplifiedsmp.org/settings.html',
    })),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.payment_link?.url) {
    console.error('[billing/checkout] Square error:', JSON.stringify(data))
    return json({ error: 'Could not start checkout right now.' }, 502)
  }
  return json({ url: data.payment_link.url })
})

app.get('/billing/credits', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const balance = await c.env.DB.prepare('SELECT credit_balance FROM users WHERE id=?').bind(user.id).first()
  const { results } = await c.env.DB.prepare(
    `SELECT r.credit_microdollars, r.redeemed_at, cc.code_hint, cc.note
     FROM credit_redemptions r JOIN credit_codes cc ON cc.id=r.code_id
     WHERE r.user_id=? ORDER BY r.redeemed_at DESC LIMIT 20`
  ).bind(user.id).all()
  return json({
    balance_microdollars: Math.max(0, balance?.credit_balance || 0),
    balance_usd: microdollarsToUsd(Math.max(0, balance?.credit_balance || 0)),
    redemptions: results.map(row => ({
      ...row,
      credit_usd: microdollarsToUsd(row.credit_microdollars),
    })),
  })
})

app.post('/billing/credits/redeem', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  if (!await checkAccountRateLimit(c.env.DB, user.id, 'credit-redeem', 10)) {
    return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429)
  }
  const {
    code,
    credit_microdollars: creditMicrodollars,
    credit_cents: legacyCreditCents,
  } = await c.req.json().catch(() => ({}))
  const requestedMicrodollars = creditMicrodollars == null && legacyCreditCents != null
    ? Number(legacyCreditCents) * 10_000
    : creditMicrodollars
  try {
    const redeemed = await redeemCreditCode(c.env.DB, user.id, code, requestedMicrodollars)
    return json({
      ok: true,
      granted_usd: microdollarsToUsd(redeemed.granted_microdollars),
      balance_usd: microdollarsToUsd(Math.max(0, redeemed.balance_microdollars)),
    })
  } catch (error) {
    if (error instanceof CreditCodeError) return json({ error: error.message, code: error.code }, 400)
    console.error('[billing/credits/redeem]', error)
    return json({ error: 'Could not redeem this code right now.' }, 500)
  }
})

app.post('/webhooks/square', async (c) => {
  const rawBody = await c.req.text()
  const signature = c.req.header('x-square-hmacsha256-signature')
  if (!await verifySquareSignature(rawBody, signature, c.env.SQUARE_WEBHOOK_SIGNATURE_KEY)) {
    return json({ error: 'Invalid signature' }, 401)
  }

  const event = JSON.parse(rawBody)
  const subscription = event?.data?.object?.subscription
  if (!subscription?.customer_id) return json({ ok: true }) // not a subscription event we care about

  const custRes = await squareApi(c.env, `/customers/${subscription.customer_id}`)
  const custData = await custRes.json().catch(() => ({}))
  const email = custData.customer?.email_address
  if (!email) return json({ ok: true })

  const user = await c.env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email.toLowerCase()).first()
  if (!user) return json({ ok: true }) // no matching Axion account — nothing to do

  const active = subscription.status === 'ACTIVE'
  await c.env.DB.prepare(
    'UPDATE users SET plan=?, plan_updated_at=strftime(\'%s\',\'now\'), square_customer_id=?, square_subscription_id=? WHERE id=?'
  ).bind(active ? 'pro' : 'free', subscription.customer_id, subscription.id, user.id).run()

  return json({ ok: true })
})

// ── Chat sync (web chat app) ────────────────────────────────────────────────

app.get('/chats', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const { results } = await c.env.DB.prepare(
    'SELECT id, title, updated FROM chats WHERE user_id=? ORDER BY updated DESC LIMIT 500'
  ).bind(user.id).all()
  return json({ chats: results })
})

app.get('/chats/:id', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const row = await c.env.DB.prepare(
    'SELECT id, title, messages, updated FROM chats WHERE id=? AND user_id=?'
  ).bind(c.req.param('id'), user.id).first()
  if (!row) return json({ error: 'Not found' }, 404)
  let messages = []
  try { messages = JSON.parse(row.messages || '[]') } catch {}
  return json({ id: row.id, title: row.title, messages, updated: row.updated })
})

app.put('/chats/:id', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const id = c.req.param('id')
  const { title, messages, updated } = await c.req.json().catch(() => ({}))
  const msgJson = JSON.stringify(Array.isArray(messages) ? messages : [])
  if (msgJson.length > 1_000_000) return json({ error: 'Conversation too large' }, 413)
  const ts = updated || Date.now()
  // Upsert; the WHERE guard stops one user from overwriting another's row id.
  await c.env.DB.prepare(
    `INSERT INTO chats (id, user_id, title, messages, updated, created)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET title=excluded.title, messages=excluded.messages, updated=excluded.updated
     WHERE chats.user_id = excluded.user_id`
  ).bind(id, user.id, (title || 'New chat').slice(0, 200), msgJson, ts, ts).run()
  return json({ ok: true, id, updated: ts })
})

app.delete('/chats/:id', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const result = await c.env.DB.prepare('DELETE FROM chats WHERE id=? AND user_id=?').bind(c.req.param('id'), user.id).run()
  if (result.meta.changes === 0) return json({ error: 'Not found' }, 404)
  return json({ ok: true })
})

// ── OpenAI-compatible proxy ────────────────────────────────────────────────

const FREE_DAILY_LIMIT  = 50    // keyless requests per IP per day (unauthenticated anti-abuse gate, stays request-based)
const FREE_KEY_CAP      = 3     // max non-revoked API keys, free plan (pro is uncapped)

// Lumen pricing — also the unit the pay-as-you-go credits feature will use.
const LUMEN_INPUT_PER_M_USD  = 0.15
const LUMEN_OUTPUT_PER_M_USD = 0.50

// Usage budgets, denominated in microdollars (1,000,000 = $1) rather than raw
// request or token counts. Request counts are a bad proxy for cost (a 5-token
// reply and an 8,000-token document dump both count as "1 request"), and raw
// token counts ignore that input/output tokens are priced differently — cost
// is the one unit that's actually meaningful for both the limiter and future
// purchased credits.
//
// Weekly figures are the former monthly budget ÷4 (a weekly cadence has ~4.3
// billing periods per month, but 4 keeps the numbers clean): $0.50/mo →
// $0.125/wk free, $5.00/mo → $1.25/wk pro.
const FREE_WEEKLY_BUDGET = 125_000    // $0.125/wk
const PRO_WEEKLY_BUDGET  = 1_250_000  // $1.25/wk, 10x
const FREE_WINDOW_BUDGET = 50_000     // $0.05 / 2hr
const PRO_WINDOW_BUDGET  = 500_000    // $0.50 / 2hr, 10x

function limitsForPlan(plan) {
  return plan === 'pro'
    ? { weeklyBudget: PRO_WEEKLY_BUDGET, windowBudget: PRO_WINDOW_BUDGET }
    : { weeklyBudget: FREE_WEEKLY_BUDGET, windowBudget: FREE_WINDOW_BUDGET }
}

function requestCostMicrodollars(inputTokens, outputTokens) {
  return Math.round(inputTokens * LUMEN_INPUT_PER_M_USD + outputTokens * LUMEN_OUTPUT_PER_M_USD)
}

// ~4 chars/token — the standard rough heuristic (same one the CLI uses
// client-side in utils/tokenEstimate.js). Only used when the upstream
// response doesn't report real usage, or for streaming where we're
// accumulating text ourselves rather than getting a token count directly.
function estimateTokensFromChars(text) {
  return Math.ceil((text || '').length / 4)
}
async function proxyUpstream(body, env) {
  return proxyLumenRequest(body, env)
}

function streamResponse(upstream) {
  const { readable, writable } = new TransformStream()
  upstream.body.pipeTo(writable)
  return new Response(readable, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' },
  })
}

// Same as streamResponse, but tees the body so the client gets the untouched
// stream immediately while a second copy is read in the background to
// accumulate the assistant's output text for cost tracking — SSE parsing
// never blocks or delays what's forwarded to the client. Also harvests the
// upstream's real `usage` object when the final chunk carries one, so billing
// can use exact token counts instead of character estimates. Returns the
// client Response plus a promise for {outText, usage}; the caller is
// responsible for registering that promise with waitUntil.
function streamResponseTracked(upstream) {
  const [clientBody, trackBody] = upstream.body.tee()
  const client = new Response(clientBody, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' },
  })
  const trackedPromise = (async () => {
    let outText = ''
    let usage = null
    try {
      const reader = trackBody.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (payload === '[DONE]') continue
          try {
            const parsed = JSON.parse(payload)
            const delta = parsed.choices?.[0]?.delta?.content
            if (typeof delta === 'string') outText += delta
            if (typeof parsed.usage?.prompt_tokens === 'number') usage = parsed.usage
          } catch {}
        }
      }
    } catch (e) {
      console.error('[streamResponseTracked] tee read failed:', e.message)
    }
    return { outText, usage }
  })()
  return { client, trackedPromise }
}

// ── Safety triggers ──────────────────────────────────────────────────────────

const SAFETY_TRIGGERS = [
  {
    name: 'sexual',
    patterns: [
      /\b(?:explicit\s+(?:sexual|content|adult|material)|sexual\s+(?:act|intercourse|content|explicit)|porn(?:ography)?\b|nsfw\b|sexua(l|ly)\s+(?:explicit|graphic|suggestive)|suck\s+(?:my|his|her|your)\s+(?:dick|cock|penis)|fuck\s+(?:me|her|him|you|my|his|your)\s*(?:hard|in|with|raw)?|blow\s*(?:job|me)|cum\s*(?:in|on|inside)|dick\s*(?:pic|pics|photo)|naked\s*(?:pics?|photos?|picture)|hentai|xxx\b)/i,
    ],
    instruction: "\n\n[System notice: The above request may involve content that falls outside our content guidelines. Please respond helpfully but decline to generate sexual, explicit, or adult content. Offer a constructive alternative instead.]",
  },
  {
    name: 'violence',
    patterns: [
      /\b(?:how\s+to\s+(?:kill|murder|harm|torture|assault|stab|shoot)\s+(?:someone|a\s+\w+|people|him|her|them)|bomb\s+(?:making|recipe|instructions|tutorial)|make\s+(?:a\s+)?(?:bomb|explosive|weapon)\s*(?:at\s+home|instructions|tutorial)?|torture\s+(?:methods?|techniques?|someone|people)|mass\s+(?:shooting|murder|kill(?:ing)?)\s+(?:plan|how|guide|tutorial)|school\s+shoot(?:ing|er)\s+(?:plan|how|guide))/i,
    ],
    instruction: "\n\n[System notice: The above request appears to reference violent content that may violate our safety guidelines. Please respond helpfully while declining to provide instructions for violence, harm, or illegal activities. Offer a constructive alternative instead.]",
  },
  {
    name: 'self_harm',
    patterns: [
      /\b(?:how\s+to\s+(?:commit\s+suicide|kill\s+myself|end\s+my\s+life|self.?harm)|suicide\s+(?:methods?|ways?|how|guide|note)|self.?harm\s+(?:methods?|ways?|how|techniques?)|cut\s+(?:myself|my\s+(?:wrist|arm|body))|hurt\s+myself|ending\s+(?:my\s+)?life|suicidal\s+thoughts?\s+(?:help|advice|how))/i,
    ],
    instruction: "\n\n[System notice: The above request mentions self-harm or suicide. Please respond with care and compassion. Provide crisis resources and encourage seeking professional help. Do not provide methods or instructions for self-harm.]",
  },
  {
    name: 'illegal',
    patterns: [
      /\b(?:how\s+to\s+(?:hack|steal|rob|burgle|scam|fraud|traffick|launder\s+money|make\s+(?:fake|counterfeit)|manufacture\s+(?:drugs?|meth|cocaine|heroin|lsd|mdma))|buy\s+(?:illegal\s+)?(?:drugs?|weapons?|guns?|firearms?)\s+(?:online|without\s+prescription|dark\s+web)|credit\s+card\s+(?:fraud|cloning|steal|numbers?)|identity\s+theft\s+(?:how|guide|tutorial)|child\s+(?:porn|abuse|exploitation)\s+(?:how|generate|create|make)|cp\b(?:\s*(?:content|images?|videos?|material))?)/i,
    ],
    instruction: "\n\n[System notice: The above request appears to involve illegal activities. Please respond helpfully while declining to provide guidance or information about illegal acts. Offer a constructive alternative instead.]",
  },
  {
    name: 'hate',
    patterns: [
      /\b(?:n[i1]gg[ae3]r|n[i1]gg[a4])\b/i,
      /\b(?:racial\s+(?:slur|epithet|superiority|inferiority)|hate\s+(?:speech|crime|group|against)|white\s+supremac(?:y|ist)|nazi\s+(?:propaganda|ideology|symbols?)|genocide\s+(?:how|plan|guide|method)|ethnic\s+(?:cleansing|purification)|discriminat(?:ion|ory)\s+(?:against|based\s+on)\s+(?:race|religion|gender|sexual\s+orientation))/i,
    ],
    instruction: "\n\n[System notice: The above request may contain hateful or discriminatory content. Please respond respectfully and decline to generate content that promotes hatred, discrimination, or violence against any group. Offer a constructive alternative instead.]",
  },
  {
    name: 'malicious_code',
    patterns: [
      /\b(?:how\s+to\s+(?:create|make|write|build)\s+(?:a\s+)?(?:virus|malware|ransomware|trojan|worm|spyware|keylogger|rootkit)|malicious\s+(?:code|script|software|program)|ransomware\s+(?:code|script|how|tutorial|source)|exploit\s+(?:code|script|how|tutorial|vulnerability)\s+(?:for\s+)?(?:hack|attack|crack)|bypass\s+(?:security|authentication|login|password)\s+(?:using|with)\s+(?:code|script|python|js|bash))/i,
    ],
    instruction: "\n\n[System notice: The above request appears to seek malicious code or hacking tools. Please respond helpfully while declining to provide code, instructions, or tools designed for malicious purposes. Offer educational alternatives about cybersecurity instead.]",
  },
]

function applySafetyTriggers(body) {
  if (!body.messages || !Array.isArray(body.messages)) return null
  for (const t of SAFETY_TRIGGERS) {
    let match = false
    for (const msg of body.messages) {
      if (typeof msg.content === 'string' && t.patterns.some(p => p.test(msg.content))) {
        match = true
        break
      }
    }
    if (match) {
      for (let i = body.messages.length - 1; i >= 0; i--) {
        if (body.messages[i].role === 'user') {
          body.messages[i].content += t.instruction
          break
        }
      }
      return t.name
    }
  }
  return null
}

app.post('/v1/chat/completions', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  const auth = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '').trim()
  const body = await c.req.json().catch(() => ({}))
  if (!body.messages) return json({ error: { message: 'Invalid or missing request body', type: 'invalid_request_error' } }, 400)

  // ── Account-billed request (API key or signed-in session) ──
  // Website chat/playground traffic authenticates with a signed session
  // token rather than an axion-sk- key; it must hit the same account
  // budgets and charging as keyed traffic, never the anonymous free tier.
  let keyRow = null
  let billedUser = null
  if (auth.startsWith('axion-sk-')) {
    keyRow = await c.env.DB.prepare('SELECT * FROM api_keys WHERE key_value=? AND revoked=0').bind(auth).first()
    if (!keyRow) return json({ error: { message: 'Invalid or revoked API key', type: 'invalid_request_error' } }, 401)

    // Check if the key owner is banned, and pull their plan for rate limits
    billedUser = await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(keyRow.user_id).first()
    if (!billedUser) return json({ error: { message: 'Invalid or revoked API key', type: 'invalid_request_error' } }, 401)
    if (billedUser.banned) return json({ error: { message: 'Your account has been suspended.', type: 'permission_error' } }, 403)
  } else if (auth) {
    billedUser = await requireAuth(c)
    if (!billedUser) return json({ error: { message: 'Invalid or expired credentials', type: 'invalid_request_error' } }, 401)
  }

  if (billedUser) {
    const { weeklyBudget: planWeeklyBudget, windowBudget: planWindowBudget } = limitsForPlan(billedUser.plan)

    // Scope check — if key has scopes, requested model must be in the list
    if (keyRow?.scopes) {
      const allowed = JSON.parse(keyRow.scopes)
      const requested = (body.model || '').toLowerCase()
      if (!allowed.some(s => s.toLowerCase() === requested)) {
        return json({ error: { message: `This API key is not permitted to use model "${body.model}". Allowed: ${allowed.join(', ')}`, type: 'permission_error', allowed_models: allowed } }, 403)
      }
    }

    // Calendar month for the api_keys display counters only (month_requests/
    // month_cost — informational dashboard stats, not a gate). The actual
    // weekly/window budgets below are lazy-start, not calendar-aligned.
    const calendarMonth = new Date().toISOString().slice(0, 7)
    const accountUsage = await readAccountUsage(c.env.DB, billedUser.id)
    if (keyRow && keyRow.month_start !== calendarMonth) {
      await c.env.DB.prepare('UPDATE api_keys SET month_requests=0, month_cost=0, month_start=? WHERE id=?').bind(calendarMonth, keyRow.id).run()
      keyRow.month_requests = 0
      keyRow.month_cost = 0
    }
    if (!canStartUsage(accountUsage, planWeeklyBudget, planWindowBudget)
        && accountUsage.included_week_cost >= planWeeklyBudget) {
      return json({ error: {
        message: 'Weekly included usage reached and no API credits remain.',
        type: 'rate_limit_error',
        reset_at: accountUsage.week_reset_at,
        limit_usd: microdollarsToUsd(planWeeklyBudget),
        used_usd: microdollarsToUsd(accountUsage.included_week_cost),
        credit_balance_usd: microdollarsToUsd(Math.max(0, accountUsage.credit_balance || 0)),
      } }, 429)
    }

    // The two-hour included allowance is account-wide. Once either included
    // allowance is exhausted, a positive credit balance keeps requests open.
    if (!canStartUsage(accountUsage, planWeeklyBudget, planWindowBudget)) {
      return json({ error: {
        message: 'Two-hour included usage reached and no API credits remain.',
        type: 'rate_limit_error',
        reset_at: accountUsage.window_reset_at,
        limit_usd: microdollarsToUsd(planWindowBudget),
        used_usd: microdollarsToUsd(accountUsage.included_window_cost),
        credit_balance_usd: microdollarsToUsd(Math.max(0, accountUsage.credit_balance || 0)),
        window: true,
      } }, 429)
    }

    const trigger = applySafetyTriggers(body)
    if (trigger === 'hate') {
      const nKey = `nword:${billedUser.id}`
      const nRow = await c.env.DB.prepare('SELECT count FROM rate_limits WHERE key=?').bind(nKey).first()
      const nCount = (nRow?.count || 0) + 1
      await c.env.DB.prepare('INSERT OR REPLACE INTO rate_limits (key, count, window_start) VALUES (?,?,0)').bind(nKey, nCount).run()
      if (nCount >= 3) {
        const reason = 'Racial slur detected (3 strikes).'
        await c.env.DB.prepare('UPDATE users SET banned=1, ban_reason=? WHERE id=?').bind(reason, billedUser.id).run()
        if (c.env.RESEND_API_KEY) {
          const appealToken = crypto.randomUUID()
          const appealId = crypto.randomUUID()
          const now = Math.floor(Date.now() / 1000)
          await c.env.DB.prepare('INSERT INTO appeals (id, user_id, email, token, status, created_at) VALUES (?,?,?,?,?,?)')
            .bind(appealId, billedUser.id, billedUser.email, appealToken, 'pending', now).run()
          const appealUrl = 'https://api.amplifiedsmp.org/appeal/' + appealToken
          c.executionCtx.waitUntil(sendEmail(c.env.RESEND_API_KEY, {
            to: billedUser.email,
            subject: 'Your Axion account has been suspended',
            html: emailWrap(`<h2 style="margin:0 0 8px;color:#e8e8f0">Account suspended</h2><p style="color:#ccc;margin:0 0 16px">Your account was automatically suspended for violating our content policy.</p><a href="${appealUrl}" style="display:inline-block;background:#e8602c;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Submit appeal →</a>`),
          }))
        }
        return json({ error: { message: 'Your account has been suspended for violating our content policy.', type: 'permission_error' } }, 403)
      }
    }
    const upstream = await proxyUpstream(body, c.env)
    if (!upstream.ok) return json({ error: { message: await upstream.text(), type: 'upstream_error' } }, upstream.status)

    const today = new Date().toISOString().slice(0, 10)
    const reqText = (body.messages || []).map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')).join(' ')

    // Records actual usage after a completion finishes: updates the request/
    // token/cost counters, and fires the 80%-of-budget email the first time
    // a request's cost crosses the threshold (can't be an exact-match check
    // like the old request-count version — cost jumps by a variable amount
    // per request, so it can skip right over an exact target).
    async function recordUsage(inputTokens, outputTokens) {
      const cost = requestCostMicrodollars(inputTokens, outputTokens)
      const totalTokens = inputTokens + outputTokens
      const chargedUsage = await chargeAccountUsage(
        c.env.DB,
        billedUser.id,
        cost,
        planWeeklyBudget,
        planWindowBudget,
      )
      if (keyRow) await Promise.all([
        c.env.DB.prepare(
          "UPDATE api_keys SET last_used=strftime('%s','now'), requests=requests+1, month_requests=month_requests+1, tokens=tokens+?, month_cost=month_cost+? WHERE id=?"
        ).bind(totalTokens, cost, keyRow.id).run(),
        c.env.DB.prepare(
          'INSERT INTO usage_daily (key_id, date, count) VALUES (?,?,1) ON CONFLICT (key_id, date) DO UPDATE SET count=count+1'
        ).bind(keyRow.id, today).run(),
      ])

      const newWeekCost = chargedUsage.included_week_cost
      const notifyThreshold = Math.floor(planWeeklyBudget * 0.8)
      // Dedupe key is the week's own start timestamp (not a calendar label —
      // periods are lazy-start and per-account), so a fresh week can notify
      // again even though the column value looks similar to a prior one.
      if (newWeekCost >= notifyThreshold && chargedUsage.usage_limit_notified !== chargedUsage.usage_week && c.env.RESEND_API_KEY) {
        const claimed = await c.env.DB.prepare(
          `UPDATE users SET usage_limit_notified=?
           WHERE id=? AND included_week_cost>=? AND COALESCE(usage_limit_notified,'')<>?`
        ).bind(chargedUsage.usage_week, billedUser.id, notifyThreshold, chargedUsage.usage_week).run()
        if (!claimed.meta?.changes) return
        const [limitUser, prefs] = await Promise.all([
          c.env.DB.prepare('SELECT email FROM users WHERE id=?').bind(billedUser.id).first(),
          c.env.DB.prepare('SELECT notify_limit FROM email_prefs WHERE user_id=?').bind(billedUser.id).first(),
        ])
        if (limitUser && prefs?.notify_limit !== 0) {
          const usedUsd = (newWeekCost / 1_000_000).toFixed(2)
          const budgetUsd = (planWeeklyBudget / 1_000_000).toFixed(2)
          const resetAt = new Date(new Date(chargedUsage.usage_week).getTime() + WEEK_MS)
          const resetLabel = resetAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
          await sendEmail(c.env.RESEND_API_KEY, {
            to: limitUser.email,
            subject: `You've used 80% of your $${budgetUsd} weekly Axion usage`,
            html: emailWrap(`
              <h2 style="margin:0 0 8px;color:#e8e8f0">Usage alert</h2>
              <p style="color:#888;margin:0 0 16px">Your account${keyRow ? ` (API key <strong style="color:#e8e8f0">${keyRow.label}</strong>)` : ''} has used <strong style="color:#e8602c">$${usedUsd} / $${budgetUsd}</strong> this week (80%).</p>
              <p style="color:#888;margin:0 0 24px">Your usage resets ${resetLabel}. If you need more, reply to this email.</p>
              <a href="https://axion.amplifiedsmp.org/keys" style="display:inline-block;background:#e8602c;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">View usage →</a>
              <p style="color:#555;font-size:12px;margin-top:24px">To turn off these alerts, visit your <a href="https://axion.amplifiedsmp.org/keys" style="color:#e8602c">account settings</a>.</p>
            `),
          })
        }
      }
    }

    if (body.stream) {
      const { client, trackedPromise } = streamResponseTracked(upstream)
      c.executionCtx.waitUntil(trackedPromise.then(({ outText, usage }) => {
        const inputTokens = typeof usage?.prompt_tokens === 'number'
          ? usage.prompt_tokens
          : estimateTokensFromChars(reqText)
        const outputTokens = typeof usage?.completion_tokens === 'number'
          ? usage.completion_tokens
          : estimateTokensFromChars(outText)
        return recordUsage(inputTokens, outputTokens)
      }))
      return client
    }

    const data = await upstream.json()
    let inputTokens, outputTokens
    if (data.usage && typeof data.usage.prompt_tokens === 'number') {
      inputTokens = data.usage.prompt_tokens
      outputTokens = data.usage.completion_tokens ?? 0
    } else {
      inputTokens = estimateTokensFromChars(reqText)
      outputTokens = estimateTokensFromChars(data.choices?.[0]?.message?.content || '')
    }
    c.executionCtx.waitUntil(recordUsage(inputTokens, outputTokens))
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
          message: `Free tier limit of ${FREE_DAILY_LIMIT} requests/day reached. Get an API key at https://axion.amplifiedsmp.org/keys for account-based usage limits and redeemable API credits.`,
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

  applySafetyTriggers(body)
  const upstream = await proxyUpstream(body, c.env)
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

// `ok` means the API itself is up; `model_up` means the model behind it
// reports its model as loaded. Probes are cached for 2 minutes so
// website page loads don't hammer the upstream.
app.get('/health', async (c) => {
  const cache = caches.default
  const cacheKey = new Request('https://health.internal/model-probe-v2')
  let model_up
  const cached = await cache.match(cacheKey)
  if (cached) {
    model_up = (await cached.json()).model_up
  } else {
    try {
      model_up = await probeLumenHealth(c.env, fetch, 6000)
    } catch {
      model_up = false
    }
    c.executionCtx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify({ model_up }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=120' },
    })))
  }
  return json({ ok: true, model: 'lumen-1.2.5', model_up })
})

// Public status page data: current per-service state, a 30-day uptime
// history, and the incident timeline. Deliberately uncached (both at the
// edge and the client) — a stale copy here reads as us hiding or being
// slow to reflect a real incident, which is worse than the extra D1 reads
// at this endpoint's traffic level.
app.get('/status/api', async (c) => {
  const snapshot = await getStatusSnapshot(c.env)
  const res = json(snapshot)
  res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate')
  res.headers.set('CDN-Cache-Control', 'no-store')
  res.headers.set('Cloudflare-CDN-Cache-Control', 'no-store')
  return res
})

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
    `SELECT u.id, u.email, u.verified, u.created_at, u.plan,
     u.credit_balance, u.included_week_cost, u.usage_week,
     u.included_window_cost, u.usage_window,
     COUNT(k.id) as key_count, COALESCE(SUM(k.requests),0) as total_requests
     FROM users u LEFT JOIN api_keys k ON k.user_id=u.id AND k.revoked=0
     GROUP BY u.id
     ORDER BY CASE WHEN u.id=? THEN 0 ELSE 1 END, u.created_at DESC LIMIT 100`
  ).bind(user.id).all()

  const users = results.map((row) => {
    const { weeklyBudget, windowBudget } = limitsForPlan(row.plan)
    const week = periodStatus(row.usage_week, row.included_week_cost, WEEK_MS)
    const win = periodStatus(row.usage_window, row.included_window_cost, WINDOW_MS)
    return {
      ...row,
      plan: row.plan === 'pro' ? 'pro' : 'free',
      credit_balance: Math.max(0, row.credit_balance || 0),
      included_week_cost: week.cost,
      included_window_cost: win.cost,
      weekly_limit: weeklyBudget,
      window_limit: windowBudget,
      credit_balance_usd: microdollarsToUsd(Math.max(0, row.credit_balance || 0)),
      weekly_used_usd: microdollarsToUsd(week.cost),
      window_used_usd: microdollarsToUsd(win.cost),
      weekly_limit_usd: microdollarsToUsd(weeklyBudget),
      window_limit_usd: microdollarsToUsd(windowBudget),
    }
  })

  return json({ users, current_user_id: user.id })
})

const MAX_ADMIN_ACCOUNT_VALUE = 10_000_000_000 // $10,000

function validAdminAccountValue(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_ADMIN_ACCOUNT_VALUE
}

app.put('/admin/users/:id/account-testing', async (c) => {
  const admin = await requireAdmin(c)
  if (!admin) return json({ error: 'Forbidden' }, 403)

  const targetId = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const { plan, included_week_cost, included_window_cost, credit_balance } = body
  if (!['free', 'pro'].includes(plan)) return json({ error: 'Plan must be free or pro' }, 400)
  if (![included_week_cost, included_window_cost, credit_balance].every(validAdminAccountValue)) {
    return json({ error: 'Usage and credit values must be whole microdollar amounts from $0 to $10,000' }, 400)
  }

  const previous = await c.env.DB.prepare(
    `SELECT id, email, plan, credit_balance, included_week_cost, included_window_cost
     FROM users WHERE id=?`
  ).bind(targetId).first()
  if (!previous) return json({ error: 'User not found' }, 404)

  const editId = crypto.randomUUID()
  const changedAt = Math.floor(Date.now() / 1000)
  const nowIso = new Date(changedAt * 1000).toISOString()
  // An override with cost 0 reads as "not started" (matches how a real,
  // never-touched period looks); a nonzero override starts a fresh
  // full-duration period right now, as if the admin's edit were a charge.
  const weekStart = included_week_cost > 0 ? nowIso : ''
  const windowStart = included_window_cost > 0 ? nowIso : ''
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE users SET plan=?, plan_updated_at=?, credit_balance=?,
       included_week_cost=?, usage_week=?, included_window_cost=?, usage_window=?,
       usage_limit_notified=NULL WHERE id=?`
    ).bind(plan, changedAt, credit_balance, included_week_cost, weekStart,
      included_window_cost, windowStart, targetId),
    c.env.DB.prepare(
      `INSERT INTO admin_account_edits
       (id, user_id, admin_email, previous_plan, new_plan,
        previous_week_cost, new_week_cost, previous_window_cost, new_window_cost,
        previous_credit_balance, new_credit_balance, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(editId, targetId, admin.email, previous.plan || 'free', plan,
      previous.included_week_cost || 0, included_week_cost,
      previous.included_window_cost || 0, included_window_cost,
      previous.credit_balance || 0, credit_balance, changedAt),
  ])

  const { weeklyBudget, windowBudget } = limitsForPlan(plan)
  return json({
    ok: true,
    user: {
      id: targetId,
      email: previous.email,
      plan,
      credit_balance,
      included_week_cost,
      included_window_cost,
      weekly_limit: weeklyBudget,
      window_limit: windowBudget,
      blocked_without_credits: !canStartUsage({
        credit_balance,
        included_week_cost,
        included_window_cost,
      }, weeklyBudget, windowBudget),
    },
  })
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

// ── Scopes: update allowed models for a key ────────────────────────────────

app.get('/admin/credit-codes', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)
  const codes = await listCreditCodes(c.env.DB)
  return json({
    codes: codes.map(code => ({
      ...code,
      credit_usd: microdollarsToUsd(code.credit_microdollars),
    })),
  })
})

app.post('/admin/credit-codes', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)
  const input = await c.req.json().catch(() => ({}))
  try {
    const created = await createCreditCode(c.env.DB, user.email, input)
    return json({
      ...created,
      credit_usd: microdollarsToUsd(created.credit_microdollars),
      warning: 'This plaintext code is shown only once.',
    }, 201)
  } catch (error) {
    if (error instanceof CreditCodeError) return json({ error: error.message, code: error.code }, 400)
    console.error('[admin/credit-codes]', error)
    return json({ error: 'Could not create a credit code.' }, 500)
  }
})

app.delete('/admin/credit-codes/:id', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)
  const result = await deactivateCreditCode(c.env.DB, c.req.param('id'))
  if (!result.meta?.changes) return json({ error: 'Code not found' }, 404)
  return json({ ok: true })
})

app.put('/dashboard/keys/:id/scopes', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const { scopes } = await c.req.json().catch(() => ({}))
  // scopes = array of model names, or null to allow all
  const scopesVal = Array.isArray(scopes) && scopes.length ? JSON.stringify(scopes.map(s => s.toLowerCase())) : null
  const result = await c.env.DB.prepare('UPDATE api_keys SET scopes=? WHERE id=? AND user_id=?').bind(scopesVal, c.req.param('id'), user.id).run()
  if (result.meta.changes === 0) return json({ error: 'Key not found' }, 404)
  return json({ ok: true, scopes: scopesVal ? JSON.parse(scopesVal) : null })
})

// ── Email preferences ──────────────────────────────────────────────────────

app.get('/dashboard/prefs', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const prefs = await c.env.DB.prepare('SELECT * FROM email_prefs WHERE user_id=?').bind(user.id).first()
  return json({ notify_limit: 1, notify_announcements: 1, ...prefs })
})

app.put('/dashboard/prefs', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const { notify_limit, notify_announcements } = await c.req.json().catch(() => ({}))
  await c.env.DB.prepare(
    'INSERT INTO email_prefs (user_id, notify_limit, notify_announcements) VALUES (?,?,?) ON CONFLICT (user_id) DO UPDATE SET notify_limit=excluded.notify_limit, notify_announcements=excluded.notify_announcements'
  ).bind(user.id, notify_limit ? 1 : 0, notify_announcements ? 1 : 0).run()
  return json({ ok: true })
})

// ── Waitlist ───────────────────────────────────────────────────────────────

app.post('/waitlist', async (c) => {
  const { email } = await c.req.json().catch(() => ({}))
  if (!email || !validEmail(email)) return json({ error: 'Valid email required' }, 400)

  const existing = await c.env.DB.prepare('SELECT status FROM waitlist WHERE email=?').bind(email.toLowerCase()).first()
  if (existing) {
    if (existing.status === 'approved') return json({ error: 'Already approved — check your email for an invite.' }, 409)
    return json({ already: true, message: "You're already on the waitlist. We'll email you when you're approved." })
  }

  await c.env.DB.prepare('INSERT INTO waitlist (id, email) VALUES (?,?)').bind(crypto.randomUUID(), email.toLowerCase()).run()
  return json({ ok: true, message: "You're on the list! We'll email you when you're approved." })
})

app.get('/waitlist/accept', async (c) => {
  const token = c.req.query('token')
  if (!token) return new Response('Missing token.', { status: 400, headers: { 'Content-Type': 'text/plain' } })

  const entry = await c.env.DB.prepare('SELECT * FROM waitlist WHERE invite_token=?').bind(token).first()
  if (!entry) return new Response('Invalid or already used invite link.', { status: 400, headers: { 'Content-Type': 'text/plain' } })
  if (entry.invite_expires < Math.floor(Date.now() / 1000)) {
    return new Response('This invite link has expired. Contact support for a new one.', { status: 400, headers: { 'Content-Type': 'text/plain' } })
  }
  if (entry.status === 'accepted') return new Response(null, { status: 302, headers: { Location: 'https://axion.amplifiedsmp.org/keys' } })

  // Find or create user
  let user = await c.env.DB.prepare('SELECT * FROM users WHERE email=?').bind(entry.email).first()
  if (!user) {
    const uid = crypto.randomUUID()
    await c.env.DB.prepare('INSERT INTO users (id, email, pw_hash, verified) VALUES (?,?,?,1)').bind(uid, entry.email, '').run()
    user = { id: uid }
  } else if (!user.verified) {
    await c.env.DB.prepare('UPDATE users SET verified=1 WHERE id=?').bind(user.id).run()
  }

  await c.env.DB.prepare("UPDATE waitlist SET status='accepted', invite_token=NULL WHERE id=?").bind(entry.id).run()

  const sessionToken = await makeToken(user.id, c.env.TOKEN_SECRET, user.token_version || 0)
  return new Response(null, {
    status: 302,
    headers: { Location: `https://axion.amplifiedsmp.org/keys#verified=${encodeURIComponent(sessionToken)}&email=${encodeURIComponent(entry.email)}` },
  })
})

app.get('/admin/waitlist', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)
  const { results } = await c.env.DB.prepare(
    'SELECT id, email, status, created_at, approved_by, approved_at FROM waitlist ORDER BY created_at DESC LIMIT 200'
  ).all()
  return json({ waitlist: results })
})

app.post('/admin/waitlist/:id/approve', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)

  const entry = await c.env.DB.prepare('SELECT * FROM waitlist WHERE id=?').bind(c.req.param('id')).first()
  if (!entry) return json({ error: 'Not found' }, 404)
  if (entry.status === 'approved' || entry.status === 'accepted') return json({ error: 'Already approved' }, 409)

  const token = crypto.randomUUID()
  const expires = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60

  await c.env.DB.prepare(
    "UPDATE waitlist SET status='approved', invite_token=?, invite_expires=?, approved_by=?, approved_at=strftime('%s','now') WHERE id=?"
  ).bind(token, expires, user.email, entry.id).run()

  if (c.env.RESEND_API_KEY) {
    const link = `https://api.amplifiedsmp.org/waitlist/accept?token=${token}`
    c.executionCtx.waitUntil(sendEmail(c.env.RESEND_API_KEY, {
      to: entry.email,
      subject: "You're in — your Axion invite is ready",
      html: emailWrap(`
        <h2 style="margin:0 0 8px;color:#e8e8f0">You're approved!</h2>
        <p style="color:#888;margin:0 0 24px">Your Axion Labs early access is ready. Click below to activate your account and get account-based included usage and redeemable API credits.</p>
        <a href="${link}" style="display:inline-block;background:#e8602c;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Activate account →</a>
        <p style="color:#555;font-size:12px;margin-top:24px">This link expires in 7 days.</p>
      `),
    }))
  }

  return json({ ok: true })
})

app.post('/admin/waitlist/:id/reject', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)
  await c.env.DB.prepare("UPDATE waitlist SET status='rejected' WHERE id=?").bind(c.req.param('id')).run()
  return json({ ok: true })
})

// ── Announcements ──────────────────────────────────────────────────────────

app.get('/announcements', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, title, body, link, created_at FROM announcements ORDER BY created_at DESC LIMIT 50'
  ).all()
  return json({ announcements: results })
})

// Subscribe/unsubscribe (no account required)
app.post('/announcements/subscribe', async (c) => {
  const { email } = await c.req.json().catch(() => ({}))
  if (!email || !validEmail(email)) return json({ error: 'Valid email required' }, 400)
  await c.env.DB.prepare(
    'INSERT INTO subscribers (email) VALUES (?) ON CONFLICT (email) DO UPDATE SET active=1'
  ).bind(email.toLowerCase()).run()
  return json({ ok: true, message: "You're subscribed to Axion Labs announcements." })
})

app.get('/announcements/unsubscribe', async (c) => {
  const token = c.req.query('token')
  if (!token) return new Response('Missing token.', { status: 400, headers: { 'Content-Type': 'text/plain' } })
  await c.env.DB.prepare('UPDATE subscribers SET active=0 WHERE unsub_token=?').bind(token).run()
  return new Response(null, { status: 302, headers: { Location: 'https://axion.amplifiedsmp.org/announcements?unsubscribed=1' } })
})

// Called by GitHub Actions when announcements.html is updated — secret-protected, no login needed
app.post('/webhook/announce', async (c) => {
  const secret = c.req.header('X-Webhook-Secret')
  if (!secret || secret !== c.env.ANNOUNCE_WEBHOOK_SECRET) return json({ error: 'Unauthorized' }, 401)

  const { title, body, link, content_hash } = await c.req.json().catch(() => ({}))
  if (!title?.trim() || !body?.trim()) return json({ error: 'title and body required' }, 400)

  // Idempotency: skip if this exact announcement was already sent
  if (content_hash) {
    const existing = await c.env.DB.prepare('SELECT id FROM announcements WHERE id=?').bind(content_hash).first()
    if (existing) return json({ ok: true, skipped: true, reason: 'already_sent' })
  }

  const id = content_hash || crypto.randomUUID()
  const now = Math.floor(Date.now() / 1000)
  await c.env.DB.prepare('INSERT OR IGNORE INTO announcements (id, title, body, link, sent_at, created_at) VALUES (?,?,?,?,?,?)').bind(id, title.trim(), body.trim(), link || null, now, now).run()

  if (c.env.RESEND_API_KEY) {
    c.executionCtx.waitUntil((async () => {
      try {
        const [{ results: accountRecipients }, { results: subRecipients }] = await Promise.all([
          c.env.DB.prepare(`
            SELECT u.email, NULL as unsub_token FROM users u
            LEFT JOIN email_prefs p ON p.user_id = u.id
            WHERE u.verified = 1 AND (p.notify_announcements IS NULL OR p.notify_announcements = 1)
            LIMIT 500
          `).all(),
          c.env.DB.prepare('SELECT email, unsub_token FROM subscribers WHERE active=1 LIMIT 500').all(),
        ])

        const seen = new Set()
        const all = []
        for (const r of [...accountRecipients, ...subRecipients]) {
          if (!seen.has(r.email)) { seen.add(r.email); all.push(r) }
        }
        console.log(`[announce] sending "${title.trim()}" to ${all.length} recipient(s): ${all.map(r => r.email).join(', ')}`)

        const titleStr = title.trim()
        const bodyStr = body.trim().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        for (let i = 0; i < all.length; i += 10) {
          await Promise.all(all.slice(i, i + 10).map(r => {
            const unsubUrl = r.unsub_token
              ? `https://api.amplifiedsmp.org/announcements/unsubscribe?token=${r.unsub_token}`
              : `https://axion.amplifiedsmp.org/keys`
            return sendEmail(c.env.RESEND_API_KEY, {
              to: r.email,
              subject: `Axion Labs: ${titleStr}`,
              html: emailWrap(`
                <h2 style="margin:0 0 8px;color:#e8e8f0">${titleStr}</h2>
                <div style="color:#ccc;line-height:1.7;margin:0 0 24px;white-space:pre-wrap">${bodyStr}</div>
                <a href="https://axion.amplifiedsmp.org/announcements" style="display:inline-block;background:#e8602c;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Read on site →</a>
                <p style="color:#555;font-size:12px;margin-top:24px"><a href="${unsubUrl}" style="color:#666">Unsubscribe</a></p>
              `),
            })
          }))
        }
      } catch (err) {
        console.error(`[announce] background send failed: ${err?.stack || err}`)
      }
    })())
  } else {
    console.error('[announce] RESEND_API_KEY not set — skipping send entirely')
  }

  return json({ ok: true, id, recipients_queued: true })
})

// One-off transactional send (e.g. a personal welcome note to a specific
// signup) — reuses the announce webhook's secret rather than a new one.
app.post('/webhook/send-email', async (c) => {
  const secret = c.req.header('X-Webhook-Secret')
  if (!secret || secret !== c.env.ANNOUNCE_WEBHOOK_SECRET) return json({ error: 'Unauthorized' }, 401)
  if (!c.env.RESEND_API_KEY) return json({ error: 'RESEND_API_KEY not set' }, 500)

  const { to, subject, html, from, replyTo } = await c.req.json().catch(() => ({}))
  if (!to || !subject || !html) return json({ error: 'to, subject, and html are required' }, 400)

  const res = await sendEmail(c.env.RESEND_API_KEY, { to, subject, html, from, replyTo })
  if (!res.ok) return json({ error: `Resend API error ${res.status}` }, 502)
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

// ── Appeals ────────────────────────────────────────────────────────────────

app.get('/appeal/:token', async (c) => {
  const token = c.req.param('token')
  const appeal = await c.env.DB.prepare('SELECT * FROM appeals WHERE token=?').bind(token).first()
  if (!appeal) return new Response('Appeal not found.', { status: 404, headers: { 'Content-Type': 'text/plain' } })

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(appeal.user_id).first()

  if (appeal.status !== 'pending') {
    const msg = appeal.status === 'approved'
      ? 'Your appeal was approved and your account has been reinstated.'
      : 'Your appeal was reviewed and not approved at this time.'
    return new Response(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Appeal — Axion Labs</title><style>
body{font-family:system-ui,sans-serif;background:#110d08;color:#e8ddd0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
.card{background:#1c1510;border:1px solid #2e2218;border-radius:16px;padding:36px 40px;max-width:480px;width:100%;text-align:center}
.card h1{font-size:22px;margin:0 0 8px;color:#e8ddd0}
.card p{color:#a08060;font-size:14px;line-height:1.6;margin:0 0 8px}
.status{display:inline-block;padding:4px 14px;border-radius:99px;font-size:13px;font-weight:600;margin-bottom:16px}
.status-approved{background:rgba(106,168,122,.15);color:#6aa87a}
.status-rejected{background:rgba(200,100,80,.15);color:#c86450}
.btn{display:inline-block;background:#cc785c;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;margin-top:16px}
</style></head><body>
<div class="card"><div class="status status-${appeal.status}">${appeal.status === 'approved' ? 'Approved' : 'Not approved'}</div>
<h1>${msg}</h1></div></body></html>`, { status: 200, headers: { 'Content-Type': 'text/html' } })
  }

  const banned = user?.banned
  return new Response(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Submit appeal — Axion Labs</title><style>
body{font-family:system-ui,sans-serif;background:#110d08;color:#e8ddd0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
.card{background:#1c1510;border:1px solid #2e2218;border-radius:16px;padding:36px 40px;max-width:480px;width:100%}
.card h1{font-size:22px;margin:0 0 4px;color:#e8ddd0}
.card .sub{color:#a08060;font-size:14px;margin:0 0 20px;line-height:1.5}
.field{margin-bottom:16px}
.field label{display:block;font-size:12px;color:#a08060;margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em}
.field textarea{width:100%;background:#150f0a;border:1px solid #2e2218;border-radius:8px;padding:10px 14px;color:#e8ddd0;font-size:14px;outline:none;font-family:inherit;resize:vertical;min-height:120px;box-sizing:border-box}
.field textarea:focus{border-color:#cc785c}
.btn{background:#cc785c;color:#fff;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;width:100%}
.btn:hover{background:#b8664a}
.btn:disabled{opacity:.5;cursor:not-allowed}
.msg{padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:16px;display:none}
.msg.error{background:rgba(200,100,80,.1);color:#c86450;border:1px solid rgba(200,100,80,.2);display:block}
.msg.success{background:rgba(106,168,122,.1);color:#6aa87a;border:1px solid rgba(106,168,122,.2);display:block}
</style></head><body>
<div class="card">
<h1>Submit an appeal</h1>
<p class="sub">Your account has been suspended. If you believe this was a mistake, tell us why and we'll review your case.</p>
${!banned ? '<div class="msg success">Your account is no longer suspended. No further action needed.</div>' : ''}
<div id="error-msg" class="msg error" style="display:none"></div>
<div class="field"><label>Your appeal</label>
<textarea id="reason" placeholder="Explain why your account should be reinstated..." ${!banned ? 'disabled' : ''}>${appeal.reason || ''}</textarea></div>
<button class="btn" id="submit-btn" onclick="submitAppeal()" ${!banned || appeal.reason ? 'disabled' : ''}>${appeal.reason ? 'Appeal submitted — awaiting review' : 'Submit appeal'}</button>
</div>
<script>
const TOKEN = '${token}'
async function submitAppeal(){const r=document.getElementById('reason').value.trim();if(!r)return;const b=document.getElementById('submit-btn');const e=document.getElementById('error-msg');b.disabled=true;b.textContent='Submitting...';e.style.display='none'
try{const res=await fetch('/appeal/'+TOKEN,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason:r})});const d=await res.json()
if(!res.ok){e.textContent=d.error||'Failed to submit';e.style.display='block';b.disabled=false;b.textContent='Submit appeal';return}
document.querySelector('.card').innerHTML='<div style="text-align:center;padding:20px 0"><div style="font-size:40px;margin-bottom:12px">\u2709\ufe0f</div><h1 style="margin:0 0 8px;color:#e8ddd0;font-size:20px">Appeal submitted</h1><p style="color:#a08060;font-size:14px;line-height:1.6;margin:0">We\'ll review your appeal and get back to you. You\'ll receive an email when a decision is made.</p></div>'}
catch(err){b.disabled=false;b.textContent='Submit appeal';e.textContent=err&&err.message?err.message:'Network error — try again';e.style.display='block'}}
</script></body></html>`, { status: 200, headers: { 'Content-Type': 'text/html' } })
})

app.post('/appeal/:token', async (c) => {
  const token = c.req.param('token')
  const { reason } = await c.req.json().catch(() => ({}))
  if (!reason || !reason.trim()) return json({ error: 'Please provide a reason for your appeal.' }, 400)

  const appeal = await c.env.DB.prepare('SELECT * FROM appeals WHERE token=?').bind(token).first()
  if (!appeal) return json({ error: 'Appeal not found.' }, 404)
  if (appeal.status !== 'pending') return json({ error: 'This appeal has already been ' + appeal.status + '.' }, 400)
  if (appeal.reason) return json({ error: 'You have already submitted this appeal.' }, 400)

  await c.env.DB.prepare('UPDATE appeals SET reason=? WHERE token=?').bind(reason.trim(), token).run()

  if (c.env.RESEND_API_KEY) {
    c.executionCtx.waitUntil(sendEmail(c.env.RESEND_API_KEY, {
      to: 'fearlessaviatorclan@gmail.com',
      subject: '[Axion] New appeal from ' + appeal.email,
      html: emailWrap(`
        <h2 style="margin:0 0 8px;color:#e8e8f0">New appeal submitted</h2>
        <p style="color:#ccc;margin:0 0 4px"><strong>Email:</strong> ${appeal.email}</p>
        <p style="color:#ccc;margin:0 0 16px"><strong>Reason:</strong></p>
        <div style="background:#0f0f11;border:1px solid #2a2a30;border-radius:8px;padding:14px 16px;color:#ccc;font-size:14px;line-height:1.6;white-space:pre-wrap;margin-bottom:20px">${reason.trim()}</div>
        <a href="https://api.amplifiedsmp.org/admin" style="display:inline-block;background:#e8602c;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Review in admin panel →</a>
      `),
    }))
  }

  return json({ ok: true, message: 'Appeal submitted. You\'ll receive an email when a decision is made.' })
})

// ── Admin: appeals ─────────────────────────────────────────────────────────

app.get('/admin/appeals', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)

  const { results } = await c.env.DB.prepare(
    'SELECT a.id, a.email, a.reason, a.status, a.token, a.created_at, a.reviewed_at, a.reviewed_by, u.banned FROM appeals a JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 100'
  ).all()
  return json({ appeals: results })
})

app.post('/admin/appeals/:token/accept', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)

  const token = c.req.param('token')
  const appeal = await c.env.DB.prepare('SELECT * FROM appeals WHERE token=?').bind(token).first()
  if (!appeal) return json({ error: 'Appeal not found.' }, 404)
  if (appeal.status !== 'pending') return json({ error: 'Appeal already ' + appeal.status }, 400)

  const now = Math.floor(Date.now() / 1000)
  await c.env.DB.prepare('UPDATE appeals SET status=?, reviewed_at=?, reviewed_by=? WHERE token=?')
    .bind('approved', now, user.email, token).run()
  await c.env.DB.prepare('UPDATE users SET banned=0 WHERE id=?').bind(appeal.user_id).run()

  if (c.env.RESEND_API_KEY) {
    c.executionCtx.waitUntil(sendEmail(c.env.RESEND_API_KEY, {
      to: appeal.email,
      subject: 'Your Axion appeal has been approved',
      html: emailWrap(`
        <h2 style="margin:0 0 8px;color:#e8e8f0">Appeal approved</h2>
        <p style="color:#ccc;margin:0 0 24px">Your account has been reinstated. You can now sign in and use the service normally.</p>
        <a href="https://axion.amplifiedsmp.org/keys" style="display:inline-block;background:#e8602c;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Sign in →</a>
      `),
    }))
  }

  return json({ ok: true })
})

app.post('/admin/appeals/:token/reject', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)

  const token = c.req.param('token')
  const appeal = await c.env.DB.prepare('SELECT * FROM appeals WHERE token=?').bind(token).first()
  if (!appeal) return json({ error: 'Appeal not found.' }, 404)
  if (appeal.status !== 'pending') return json({ error: 'Appeal already ' + appeal.status }, 400)

  const now = Math.floor(Date.now() / 1000)
  await c.env.DB.prepare('UPDATE appeals SET status=?, reviewed_at=?, reviewed_by=? WHERE token=?')
    .bind('rejected', now, user.email, token).run()

  if (c.env.RESEND_API_KEY) {
    c.executionCtx.waitUntil(sendEmail(c.env.RESEND_API_KEY, {
      to: appeal.email,
      subject: 'Your Axion appeal has been reviewed',
      html: emailWrap(`
        <h2 style="margin:0 0 8px;color:#e8e8f0">Appeal not approved</h2>
        <p style="color:#ccc;margin:0 0 24px">After review, your appeal was not approved. Your account remains suspended. If you have additional information, please submit a new appeal.</p>
        <p style="color:#555;font-size:12px">This decision was made by the Axion Labs team.</p>
      `),
    }))
  }

  return json({ ok: true })
})

// ── Admin: status page incidents ──────────────────────────────────────────

app.get('/admin/status/incidents', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)

  const { results: incidents } = await c.env.DB.prepare(
    'SELECT * FROM status_incidents ORDER BY created_at DESC LIMIT 50'
  ).all()
  const ids = incidents.map((i) => i.id)
  let updatesByIncident = {}
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',')
    const { results: updates } = await c.env.DB.prepare(
      `SELECT * FROM status_incident_updates WHERE incident_id IN (${placeholders}) ORDER BY created_at DESC`
    ).bind(...ids).all()
    for (const u of updates) {
      updatesByIncident[u.incident_id] ||= []
      updatesByIncident[u.incident_id].push(u)
    }
  }

  return json({ incidents: incidents.map((i) => ({ ...i, updates: updatesByIncident[i.id] || [] })) })
})

app.post('/admin/status/incidents', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)

  const { service, title, status, body } = await c.req.json()
  if (!service || !title || !body) return json({ error: 'service, title, and body are required' }, 400)
  const validStatus = ['investigating', 'identified', 'monitoring', 'resolved'].includes(status) ? status : 'investigating'

  const id = crypto.randomUUID()
  const nowIso = new Date().toISOString()
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO status_incidents (id, service, title, status, created_at, updated_at, auto_created) VALUES (?,?,?,?,?,?,0)'
    ).bind(id, service, title, validStatus, nowIso, nowIso),
    c.env.DB.prepare(
      'INSERT INTO status_incident_updates (id, incident_id, status, body, created_at) VALUES (?,?,?,?,?)'
    ).bind(crypto.randomUUID(), id, validStatus, body, nowIso),
  ])

  return json({ ok: true, id })
})

app.post('/admin/status/incidents/:id/updates', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)

  const id = c.req.param('id')
  const incident = await c.env.DB.prepare('SELECT * FROM status_incidents WHERE id=?').bind(id).first()
  if (!incident) return json({ error: 'Incident not found' }, 404)

  const { status, body } = await c.req.json()
  if (!body) return json({ error: 'body is required' }, 400)
  const validStatus = ['investigating', 'identified', 'monitoring', 'resolved'].includes(status) ? status : incident.status

  const nowIso = new Date().toISOString()
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE status_incidents SET status=?, updated_at=? WHERE id=?').bind(validStatus, nowIso, id),
    c.env.DB.prepare(
      'INSERT INTO status_incident_updates (id, incident_id, status, body, created_at) VALUES (?,?,?,?,?)'
    ).bind(crypto.randomUUID(), id, validStatus, body, nowIso),
  ])

  return json({ ok: true })
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
  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  if (!await checkRateLimit(c.env.DB, ip)) return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429)
  const code = crypto.randomUUID().replace(/-/g, '').slice(0, 24)
  const expires_at = Math.floor(Date.now() / 1000) + DEVICE_TTL
  await c.env.DB.prepare('INSERT INTO device_codes (code, expires_at) VALUES (?,?)').bind(code, expires_at).run()
  return json({ device_code: code, expires_in: DEVICE_TTL })
})

app.get('/auth/device/poll', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  if (!await checkRateLimit(c.env.DB, ip)) return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429)
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

  const token = await makeToken(user.id, c.env.TOKEN_SECRET, user.token_version || 0)
  return json({ token, email: user.email })
})

app.post('/auth/device/authorize', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  if (!await checkRateLimit(c.env.DB, ip)) return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429)
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
  for (const k of keys.results) {
    if (k.key_value && k.key_value.length > 14) {
      k.key_value = k.key_value.slice(0, 10) + '...' + k.key_value.slice(-4)
    }
  }
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

  // Rate limit: max 5 invites per 15 minutes per user
  const rlKey = `invite:${ctx.user.id}`
  const rlNow = Math.floor(Date.now() / 1000)
  const rlRow = await c.env.DB.prepare('SELECT count, window_start FROM rate_limits WHERE key=?').bind(rlKey).first()
  if (rlRow && rlNow - rlRow.window_start < 900 && rlRow.count >= 5) {
    return json({ error: 'Too many invites. Try again later.' }, 429)
  }
  if (rlRow && rlNow - rlRow.window_start < 900) {
    await c.env.DB.prepare('UPDATE rate_limits SET count=count+1 WHERE key=?').bind(rlKey).run()
  } else {
    await c.env.DB.prepare('INSERT OR REPLACE INTO rate_limits (key, count, window_start) VALUES (?,1,?)').bind(rlKey, rlNow).run()
  }

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
  if (user.email !== invite.email) return json({ error: 'This invite was sent to a different email address.' }, 403)

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

// ── CLI <-> mobile app bridge relay ─────────────────────────────────────────
//
// Lets the Axion CLI (running on a desktop) and the Axion mobile app pair up
// through this worker instead of requiring the phone to be on the same LAN.
// One Durable Object instance per user id holds the live CLI socket and
// relays terminal I/O to any attached app sockets. Auth accepts either an
// axion-sk- API key (what the CLI already stores) or a session token (what
// the app stores after device-flow login) — same account, either credential.

async function resolveBridgeUser(c) {
  const auth = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '').trim()
  if (!auth) return null
  if (auth.startsWith('axion-sk-')) {
    const keyRow = await c.env.DB.prepare('SELECT user_id FROM api_keys WHERE key_value=? AND revoked=0').bind(auth).first()
    return keyRow ? keyRow.user_id : null
  }
  const payload = await parseToken(auth, c.env.TOKEN_SECRET)
  return payload?.uid || null
}

app.get('/bridge/ws', async (c) => {
  const upgrade = c.req.header('Upgrade') || ''
  if (upgrade.toLowerCase() !== 'websocket') return json({ error: 'Expected websocket upgrade' }, 426)

  const userId = await resolveBridgeUser(c)
  if (!userId) return json({ error: 'Not authenticated' }, 401)

  const role = c.req.query('role') === 'cli' ? 'cli' : 'app'
  const id = c.env.BRIDGE.idFromName(userId)
  const stub = c.env.BRIDGE.get(id)

  const url = new URL(c.req.url)
  url.searchParams.set('role', role)
  return stub.fetch(new Request(url, c.req.raw))
})

export class BridgeRelay {
  constructor(state, env) {
    this.state = state
    this.cli = null
    this.apps = new Set()
  }

  async fetch(request) {
    const url = new URL(request.url)
    const role = url.searchParams.get('role') === 'cli' ? 'cli' : 'app'

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    server.accept()

    if (role === 'cli') {
      // Only one active CLI session per account — a new connection replaces
      // the old one (e.g. CLI restarted) rather than stacking up.
      if (this.cli) { try { this.cli.close(4000, 'replaced by new connection') } catch {} }
      this.cli = server
      this.broadcastStatus(true)

      server.addEventListener('message', (ev) => this.relayToApps(ev.data))
      const onGone = () => { if (this.cli === server) { this.cli = null; this.broadcastStatus(false) } }
      server.addEventListener('close', onGone)
      server.addEventListener('error', onGone)
    } else {
      this.apps.add(server)
      try { server.send(JSON.stringify({ type: 'status', connected: !!this.cli })) } catch {}

      server.addEventListener('message', (ev) => {
        if (this.cli) { try { this.cli.send(ev.data) } catch {} }
      })
      const onGone = () => { this.apps.delete(server) }
      server.addEventListener('close', onGone)
      server.addEventListener('error', onGone)
    }

    return new Response(null, { status: 101, webSocket: client })
  }

  relayToApps(data) {
    for (const app of this.apps) { try { app.send(data) } catch {} }
  }

  broadcastStatus(connected) {
    const msg = JSON.stringify({ type: 'status', connected })
    for (const app of this.apps) { try { app.send(msg) } catch {} }
  }
}

app.scheduled = async (event, env, ctx) => {
  ctx.waitUntil(runStatusChecks(env, fetch, (req) => app.fetch(req, env, ctx)))
}

export default app
