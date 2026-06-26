#!/usr/bin/env node
import { createServer } from 'http';
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';

const PORT = Number(process.env.BRIDGE_PORT) || 3002;
const TOKEN = process.env.BRIDGE_TOKEN || '';

const html = readFileSync(new URL('../docs/console.html', import.meta.url), 'utf-8');

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  // Token auth via query string or header
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

  ws.on('message', (data) => {
    if (proc.stdin.writable) proc.stdin.write(data.toString());
  });

  proc.stdout.on('data', (chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk.toString());
  });
  proc.stderr.on('data', (chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk.toString());
  });

  proc.on('exit', (code) => {
    ws.send(`\r\n\x1b[31m[process exited with code ${code}]\x1b[0m\r\n`);
    ws.close();
  });

  ws.on('close', () => {
    proc.kill();
  });

  ws.on('error', () => proc.kill());

  ws.send(`\x1b[32m[axion bridge — ${shell.cmd} connected]\x1b[0m\r\n`);
});

server.listen(PORT, () => {
  console.log(`axion bridge — WebSocket server on ws://localhost:${PORT}`);
  if (TOKEN) console.log(`token auth enabled (BRIDGE_TOKEN)`);
  console.log('Expose via:  cloudflared tunnel --url http://localhost:' + PORT);
});
