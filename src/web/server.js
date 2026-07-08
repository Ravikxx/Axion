// Axion PWA web server. Serves the app shell + proxies chat to providers.
// Run: node src/web/server.js   (or PORT=3001 node src/web/server.js)
// Auth: set AXION_WEB_TOKEN to require a Bearer token for /api/* routes.
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createClient, resolveModel } from '../agent/models.js';
import { API_KEYS, MODELS, CUSTOM_ENDPOINTS } from '../config.js';
import { getSavedApiKeys, getSavedCustomEndpoints } from '../persist.js';

const __dir    = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dir, '../../docs/assets');
const PORT     = parseInt(process.env.PORT || '3000', 10);
const TOKEN    = process.env.AXION_WEB_TOKEN || '';

// Seed API keys and custom endpoints from ~/.axion/config.json
const savedKeys = getSavedApiKeys();
for (const [p, k] of Object.entries(savedKeys)) {
  if (k && !API_KEYS[p]) API_KEYS[p] = k;
}
const savedEndpoints = getSavedCustomEndpoints();
for (const [name, ep] of Object.entries(savedEndpoints)) {
  if (ep?.baseURL) CUSTOM_ENDPOINTS[name] = ep;
}

const MIME = {
  '.html':        'text/html; charset=utf-8',
  '.js':          'text/javascript; charset=utf-8',
  '.css':         'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json':        'application/json',
  '.png':         'image/png',
  '.ico':         'image/x-icon',
};

// Tight CSP: no external scripts/styles/frames; connect only to self.
const CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
].join('; ');

const SYSTEM = 'You are Axion, a helpful AI assistant. Be concise and clear.';

function addSecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function checkAuth(req, res) {
  if (!TOKEN) return true;
  if ((req.headers.authorization || '') === `Bearer ${TOKEN}`) return true;
  res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="Axion"', 'Content-Type': 'text/plain' });
  res.end('Unauthorized — set AXION_WEB_TOKEN and pass it as Bearer token.');
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 500_000) reject(new Error('Request too large')); });
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });
}

function serveFile(res, absPath, mime) {
  try {
    const buf = readFileSync(absPath);
    addSecurityHeaders(res);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

const STATIC = {
  '/':                   'index.html',
  '/index.html':         'index.html',
  '/app.js':             'app.js',
  '/app.css':            'app.css',
  '/manifest.webmanifest': 'manifest.webmanifest',
  '/sw.js':              'sw.js',
};

const server = createServer(async (req, res) => {
  const url  = new URL(req.url || '/', `http://localhost:${PORT}`);
  const path = url.pathname;

  // ── GET /api/models — return model aliases the server can use ──────────────
  if (req.method === 'GET' && path === '/api/models') {
    if (!checkAuth(req, res)) return;
    const aliases = [
      ...Object.keys(MODELS),
      ...Object.keys(CUSTOM_ENDPOINTS),
    ];
    addSecurityHeaders(res);
    json(res, 200, aliases);
    return;
  }

  // ── POST /api/chat — streaming chat proxy ──────────────────────────────────
  if (req.method === 'POST' && path === '/api/chat') {
    if (!checkAuth(req, res)) return;
    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      json(res, 400, { error: 'Invalid JSON' }); return;
    }
    const { model, messages } = body;
    if (!model || !Array.isArray(messages) || !messages.length) {
      json(res, 400, { error: 'Need {model: string, messages: [{role,content},...]}' }); return;
    }

    addSecurityHeaders(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const emit = (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);

    try {
      const { client, type } = createClient(model);
      const resolved = resolveModel(model);

      if (type === 'anthropic') {
        const stream = client.messages.stream({ model: resolved, max_tokens: 4096, system: SYSTEM, messages });
        for await (const evt of stream) {
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
            emit(evt.delta.text);
          }
        }
      } else {
        const openaiMsgs = [{ role: 'system', content: SYSTEM }, ...messages];
        const stream = await client.chat.completions.create({
          model: resolved, messages: openaiMsgs, max_tokens: 4096, stream: true,
        });
        for await (const chunk of stream) {
          const text = chunk.choices?.[0]?.delta?.content;
          if (text) emit(text);
        }
      }
    } catch (err) {
      emit({ error: err.message || String(err) });
    }

    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405); res.end(); return;
  }

  // ── Docs assets (icons) ────────────────────────────────────────────────────
  if (path.startsWith('/assets/')) {
    const file = path.slice('/assets/'.length);
    const abs  = join(DOCS_DIR, file);
    if (existsSync(abs)) {
      serveFile(res, abs, MIME[extname(abs)] || 'application/octet-stream');
      return;
    }
  }

  // ── App shell static files ─────────────────────────────────────────────────
  const name = STATIC[path];
  if (name) {
    serveFile(res, join(__dir, name), MIME[extname(name)] || 'text/plain');
    return;
  }

  // Catch-all → index.html (SPA navigation)
  serveFile(res, join(__dir, 'index.html'), MIME['.html']);
});

server.listen(PORT, () => {
  process.stdout.write(`Axion PWA  →  http://localhost:${PORT}\n`);
  process.stdout.write(TOKEN
    ? 'Auth: AXION_WEB_TOKEN set — include as Bearer token.\n'
    : 'Auth: none (set AXION_WEB_TOKEN to protect LAN access).\n');
});
