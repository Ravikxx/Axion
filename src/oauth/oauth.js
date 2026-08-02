import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createServer } from 'http';
import { execSync } from 'child_process';
import { randomBytes, createHash } from 'crypto';
import { OAUTH_PROVIDERS } from './providers.js';
import { encryptJSON, decryptJSON } from '../utils/crypto.js';
import { writeJsonAtomic } from '../tui/persistence.js';

const DIR        = join(homedir(), '.axion');
const TOKEN_FILE = join(DIR, 'oauth.json');

// ── Token persistence ─────────────────────────────────────────────────────────

const TOKEN_SECRET_KEYS = ['accessToken', 'refreshToken'];

function loadTokens() {
  try {
    if (!existsSync(TOKEN_FILE)) return {};
    const raw = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
    return decryptJSON(raw, TOKEN_SECRET_KEYS);
  } catch { return {}; }
}

function saveTokens(tokens) {
  const encrypted = encryptJSON(tokens, TOKEN_SECRET_KEYS);
  writeJsonAtomic(TOKEN_FILE, encrypted);
}

export function getOAuthToken(service) {
  return loadTokens()[service] || null;
}

export function listOAuthTokens() {
  const tokens = loadTokens();
  return Object.entries(tokens).map(([service, data]) => ({
    service,
    connectedAt: data.connectedAt,
    scopes:      data.scopes,
  }));
}

export function revokeOAuthToken(service) {
  const tokens = loadTokens();
  if (!tokens[service]) return false;
  delete tokens[service];
  saveTokens(tokens);
  return true;
}

// ── Token refresh ─────────────────────────────────────────────────────────────

const REFRESH_BUFFER_MS = 120_000; // refresh 2 min before expiry

function isTokenExpired(tokenData) {
  return tokenData.expiresAt && Date.now() >= tokenData.expiresAt - REFRESH_BUFFER_MS;
}

export async function refreshOAuthToken(service) {
  const tokens = loadTokens();
  const data   = tokens[service];
  if (!data) throw new Error(`No token found for "${service}"`);
  if (!data.refreshToken) throw new Error(`"${service}" has no refresh token — re-authorize to get one`);

  const cfg = OAUTH_PROVIDERS[service];
  if (!cfg) throw new Error(`Unknown service "${service}"`);

  const tokenRes = await fetch(cfg.tokenURL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      client_id:     cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type:    'refresh_token',
      refresh_token: data.refreshToken,
    }),
  });
  const tokenData = await tokenRes.json();
  if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);

  tokens[service] = {
    ...data,
    accessToken: tokenData.access_token,
    expiresAt:   tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : null,
  };
  saveTokens(tokens);
  return tokenData.access_token;
}

export async function getValidAccessToken(service) {
  const data = loadTokens()[service];
  if (!data) return null;

  if (data.refreshToken && isTokenExpired(data)) {
    try {
      return await refreshOAuthToken(service);
    } catch (err) {
      console.error(`Token refresh failed for "${service}":`, err.message);
      // Fall through — return the expired token; the API call will fail with a
      // clear 401, which is better than silently hiding the error.
    }
  }
  return data.accessToken;
}

// ── Device flow (GitHub + Google) ────────────────────────────────────────────

async function deviceFlow(provider, onStatus) {
  const cfg = OAUTH_PROVIDERS[provider];

  // Step 1: request device code
  const codeRes = await fetch(cfg.deviceCodeURL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body:    new URLSearchParams({ client_id: cfg.clientId, scope: cfg.scopes }),
  });
  const codeData = await codeRes.json();
  if (codeData.error) throw new Error(codeData.error_description || codeData.error);

  const { device_code, user_code, verification_uri, interval = 5, expires_in = 300 } = codeData;

  onStatus({ user_code, verification_uri });

  // Step 2: poll for token
  const deadline = Date.now() + expires_in * 1000;
  const pollMs   = (interval + 1) * 1000;

  while (Date.now() < deadline) {
    await sleep(pollMs);

    const tokenRes = await fetch(cfg.tokenURL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body:    new URLSearchParams({
        client_id:     cfg.clientId,
        client_secret: cfg.clientSecret,
        device_code,
        grant_type:    'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const tokenData = await tokenRes.json();

    if (tokenData.access_token) return tokenData;
    if (tokenData.error === 'authorization_pending') continue;
    if (tokenData.error === 'slow_down') { await sleep(5000); continue; }
    throw new Error(tokenData.error_description || tokenData.error);
  }

  throw new Error('Authorization timed out — try again');
}

// ── Connect ───────────────────────────────────────────────────────────────────

export async function connectOAuth(service, { onStatus, onToken, pastedToken } = {}) {
  const cfg = OAUTH_PROVIDERS[service];
  if (!cfg) throw new Error(`Unknown service "${service}". Available: ${Object.keys(OAUTH_PROVIDERS).join(', ')}`);

  // Fail fast when an app-based flow (device/redirect) has no client ID, rather
  // than opening the browser onto the provider's cryptic "missing client_id"
  // error page. Paste-token flows (Notion, Slack) don't need pre-registered apps.
  if (cfg.tokenFlow !== 'paste' && !cfg.clientId) {
    const U = service.toUpperCase();
    throw new Error(`${cfg.label} OAuth isn't configured on this build — no client ID. Register an OAuth app and set AXION_${U}_CLIENT_ID and AXION_${U}_CLIENT_SECRET, or use a paste-token integration (notion, slack) instead.`);
  }

  let tokenData;

  if (cfg.tokenFlow === 'paste') {
    if (!pastedToken) throw new Error(`paste_required`);
    tokenData = { access_token: pastedToken.trim() };
  } else if (cfg.tokenFlow === 'redirect') {
    tokenData = await redirectFlow(service, onStatus);
  } else {
    tokenData = await deviceFlow(service, onStatus);
  }

  const tokens = loadTokens();
  tokens[service] = {
    accessToken:  tokenData.access_token,
    refreshToken: tokenData.refresh_token || null,
    expiresAt:    tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : null,
    connectedAt:  new Date().toISOString(),
    scopes:       tokenData.scope || cfg.scopes || 'custom',
  };
  saveTokens(tokens);

  onToken?.(tokenData.access_token);
  return tokenData.access_token;
}

// ── Local redirect flow (Google Desktop app) ──────────────────────────────────

function openBrowser(url) {
  try {
    if (process.platform === 'win32')   execSync(`start "" "${url}"`, { stdio: 'ignore' });
    else if (process.platform === 'darwin') execSync(`open "${url}"`, { stdio: 'ignore' });
    else                                    execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
  } catch {}
}

// PKCE (RFC 7636) — binds the authorization code to whoever started this
// specific flow, so a code intercepted in transit can't be redeemed by
// anyone else. `state` separately guards against a forged callback being
// accepted as if it came from the browser we opened.
function pkcePair() {
  const verifier  = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function redirectFlow(provider, onStatus) {
  const cfg  = OAUTH_PROVIDERS[provider];
  // Google's "Desktop app" OAuth client type accepts any loopback port
  // without pre-registration, so a fresh random port is fine there. GitHub
  // (and most other providers) require the redirect_uri to exactly match a
  // URL registered on the app, so those providers pin a fixed port instead
  // — see cfg.redirectPort.
  const port = cfg.redirectPort || await getFreePort();
  const redirectUri = `http://localhost:${port}/`;

  const state = randomBytes(16).toString('hex');
  const { verifier, challenge } = pkcePair();

  // Bind the callback listener BEFORE opening the browser — if the fixed
  // port is already taken, this fails fast instead of letting the user
  // approve access on GitHub's side and only then discovering the local
  // callback can't be delivered.
  const { listening, codeReceived } = startCallbackServer(port, state);
  try {
    await listening;
  } catch (err) {
    throw new Error(`Could not start local callback server on port ${port}: ${err.message}`);
  }

  const authUrl = `${cfg.authURL}?${new URLSearchParams({
    client_id:             cfg.clientId,
    redirect_uri:          redirectUri,
    response_type:         'code',
    scope:                 cfg.scopes,
    access_type:           'offline',
    prompt:                'consent',
    state,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
  })}`;

  onStatus({ authUrl, port });
  openBrowser(authUrl);

  // Wait for browser to redirect back with ?code=...
  const code = await codeReceived;

  // Exchange code for token
  const tokenRes = await fetch(cfg.tokenURL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      code,
      client_id:     cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code',
      code_verifier: verifier,
    }),
  });
  const tokenData = await tokenRes.json();
  if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);
  return tokenData;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// Returns { listening, codeReceived }: `listening` resolves once the server
// has successfully bound the port (or rejects on conflict, e.g. EADDRINUSE);
// `codeReceived` resolves with the authorization code once a matching
// callback arrives, or rejects on a state mismatch, an error param, or the
// 2-minute timeout. Binding with no explicit host (rather than pinning to
// 127.0.0.1) accepts the connection whichever loopback address "localhost"
// resolves to in the browser, IPv4 or IPv6 — a bare 127.0.0.1 bind can miss
// requests that resolve to ::1 first.
function startCallbackServer(port, expectedState) {
  let server;

  const codeReceived = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error('Authorization timed out (2 minutes)'));
    }, 120_000);

    server = createServer((req, res) => {
      const url    = new URL(req.url, `http://localhost:${port}`);
      const code   = url.searchParams.get('code');
      const state  = url.searchParams.get('state');
      const error  = url.searchParams.get('error');
      const stateOk = state === expectedState;
      const ok = Boolean(code) && stateOk;

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(ok
        ? '<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>● Connected!</h2><p>You can close this tab and return to Axion.</p></body></html>'
        : '<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>● Authorization failed</h2><p>You can close this tab.</p></body></html>');

      clearTimeout(timeout);
      server.close();
      if (ok) resolve(code);
      else if (!stateOk) reject(new Error('Authorization state did not match — possible CSRF attempt, or the link expired. Try connecting again.'));
      else reject(new Error(error || 'Authorization denied'));
    });
  });

  const listening = new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, () => resolve());
  });

  return { listening, codeReceived };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
