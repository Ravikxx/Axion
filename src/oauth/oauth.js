import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createServer } from 'http';
import { execSync } from 'child_process';
import { OAUTH_PROVIDERS } from './providers.js';
import { encryptJSON, decryptJSON } from '../utils/crypto.js';

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
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  const encrypted = encryptJSON(tokens, TOKEN_SECRET_KEYS);
  writeFileSync(TOKEN_FILE, JSON.stringify(encrypted, null, 2), 'utf8');
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

async function redirectFlow(provider, onStatus) {
  const cfg  = OAUTH_PROVIDERS[provider];
  const port = await getFreePort();
  const redirectUri = `http://localhost:${port}`;

  const authUrl = `${cfg.authURL}?${new URLSearchParams({
    client_id:     cfg.clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         cfg.scopes,
    access_type:   'offline',
    prompt:        'consent',
  })}`;

  onStatus({ authUrl, port });
  openBrowser(authUrl);

  // Wait for browser to redirect back with ?code=...
  const code = await waitForCode(port);

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
    }),
  });
  const tokenData = await tokenRes.json();
  if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);
  return tokenData;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function waitForCode(port) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error('Authorization timed out (2 minutes)'));
    }, 120_000);

    const server = createServer((req, res) => {
      const url    = new URL(req.url, `http://localhost:${port}`);
      const code   = url.searchParams.get('code');
      const error  = url.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (code) {
        res.end('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>✔ Connected!</h2><p>You can close this tab and return to Axion.</p></body></html>');
      } else {
        res.end('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>✖ Authorization failed</h2><p>You can close this tab.</p></body></html>');
      }

      clearTimeout(timeout);
      server.close();
      if (code) resolve(code);
      else reject(new Error(error || 'Authorization denied'));
    });

    server.listen(port, '127.0.0.1');
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
