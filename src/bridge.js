#!/usr/bin/env node
import { createServer } from 'http';
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { networkInterfaces } from 'os';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';

const PORT = Number(process.env.BRIDGE_PORT) || 3002;
const TOKEN = process.env.BRIDGE_TOKEN || '';

const html = readFileSync(new URL('../docs/console.html', import.meta.url), 'utf-8');
const xtermJs = readFileSync(new URL('../vendor/xterm.js', import.meta.url), 'utf-8');
const xtermCss = readFileSync(new URL('../vendor/xterm.css', import.meta.url), 'utf-8');
const themeCss = readFileSync(new URL('../docs/assets/theme-dark.css', import.meta.url), 'utf-8');
const mobileCss = readFileSync(new URL('../docs/assets/mobile.css', import.meta.url), 'utf-8');

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (req.url === '/xterm.js' || req.url === '/assets/xterm.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end(xtermJs);
    return;
  }
  if (req.url === '/xterm.css' || req.url === '/assets/xterm.css') {
    res.writeHead(200, { 'Content-Type': 'text/css' });
    res.end(xtermCss);
    return;
  }
  if (req.url === '/assets/theme-dark.css') {
    res.writeHead(200, { 'Content-Type': 'text/css' });
    res.end(themeCss);
    return;
  }
  if (req.url === '/assets/mobile.css') {
    res.writeHead(200, { 'Content-Type': 'text/css' });
    res.end(mobileCss);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
});

const wss = new WebSocketServer({ server });
const shells = new Set();

wss.on('connection', (ws, req) => {
  const params = new URL(req.url || '/', 'http://localhost').searchParams;
  const token = params.get('token') || '';
  if (TOKEN && token !== TOKEN) {
    ws.close(4001, 'unauthorized');
    return;
  }

  const shell = process.platform === 'win32'
    ? { cmd: 'powershell.exe', args: ['-NoLogo'] }
    : { cmd: process.env.SHELL || 'bash', args: [] };

  const proc = spawn(shell.cmd, shell.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  shells.add(proc);

  ws.on('message', (data) => {
    const str = data.toString();
    // JSON envelope for resize or ping
    if (str.startsWith('{')) {
      try {
        const msg = JSON.parse(str);
        if (msg.type === 'resize') {
          if (process.platform !== 'win32') {
            try { process.kill(proc.pid, 'SIGWINCH'); } catch {}
          }
          return;
        }
        if (msg.type === 'ping') { ws.send('{"type":"pong"}'); return; }
      } catch {}
    }
    if (proc.stdin.writable) proc.stdin.write(str);
  });

  proc.stdout.on('data', (chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk.toString());
  });
  proc.stderr.on('data', (chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk.toString());
  });

  proc.on('exit', (code) => {
    shells.delete(proc);
    ws.send(`\r\n\x1b[31m[process exited with code ${code}]\x1b[0m\r\n`);
    ws.close();
  });

  ws.on('close', () => {
    proc.kill();
  });

  ws.on('error', () => proc.kill());

  ws.send(`\x1b[32m[axion bridge — ${shell.cmd} connected]\x1b[0m\r\n`);
});

const ifaces = networkInterfaces();
let lanIp = '127.0.0.1';
for (const name of Object.keys(ifaces)) {
  for (const iface of ifaces[name] || []) {
    if (iface.family === 'IPv4' && !iface.internal) {
      lanIp = iface.address;
      break;
    }
  }
  if (lanIp !== '127.0.0.1') break;
}

function shutdown() {
  console.log('\n  shutting down...');
  for (const proc of shells) proc.kill();
  shells.clear();
  wss.close();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  const localUrl = `http://localhost:${PORT}`;
  const lanUrl = `http://${lanIp}:${PORT}`;
  const wsUrl = `ws://${lanIp}:${PORT}`;

  console.log(`
  ╔══════════════════════════════════════╗
  ║         ⎔  axion bridge              ║
  ╠══════════════════════════════════════╣
  ║  Local:  ${localUrl.padEnd(28)}║
  ║  LAN:    ${lanUrl.padEnd(28)}║
  ╚══════════════════════════════════════╝`);

  QRCode.toString(lanUrl, { type: 'terminal', small: true }, (err, qr) => {
    if (!err) console.log(qr);
  });

  if (TOKEN) console.log(`  token auth enabled (BRIDGE_TOKEN)`);
  console.log(`  Expose via:  cloudflared tunnel --url ${localUrl}\n`);
});
