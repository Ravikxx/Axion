#!/usr/bin/env node
import { createServer } from 'http';
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { WebSocketServer } from 'ws';
import { Agent } from '../agent/agent.js';
import {
  MODELS, API_KEYS, setApiKey, CUSTOM_ENDPOINTS,
  DEFAULT_MODEL, DEFAULT_MODE, IMAGE_GEN_MODEL,
  getContextWindow,
} from '../config.js';
import {
  getSavedModel, getSavedMode, getSavedApiKeys, getSavedCustomEndpoints,
  saveModel, saveMode, saveApiKey, saveCustomEndpoints,
  saveChat, loadChat, listChats, deleteChat,
  undoLastBackup, undoStackSize,
  getMemories, addMemory, removeMemory,
  getSavedImageModel, saveImageModel,
  saveAxionKey,
  exportSession, importSession,
  getTodos, addTodo, toggleTodo, removeTodo,
  listProfiles, saveProfile, loadProfile, deleteProfile,
} from '../persist.js';
import { generateImage } from '../agent/image.js';
import { startScheduler } from '../scheduler.js';

// Seed saved config exactly like the CLI does
const _savedKeys = getSavedApiKeys();
for (const [provider, key] of Object.entries(_savedKeys)) {
  if (key && !API_KEYS[provider]) API_KEYS[provider] = key;
}
const _savedEndpoints = getSavedCustomEndpoints();
for (const [name, ep] of Object.entries(_savedEndpoints)) {
  if (ep?.baseURL) CUSTOM_ENDPOINTS[name] = ep;
}
const _savedImgModel = getSavedImageModel();
if (_savedImgModel) IMAGE_GEN_MODEL.current = _savedImgModel;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR   = join(__dirname, '../../dist/web');
const PORT       = Number(process.env.AXION_WEB_PORT) || 3000;
const PID_FILE   = join(homedir(), '.axion', 'web-server.pid');

// ── Static file server ────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

function serveFile(res, filePath, fallbackToIndex = true) {
  const ext = (filePath.match(/\.\w+$/) || ['.html'])[0];
  try {
    const content = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(content);
  } catch {
    if (fallbackToIndex) serveFile(res, join(DIST_DIR, 'index.html'), false);
    else { res.writeHead(404); res.end('Not found'); }
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export function start({ initialModel = getSavedModel() || DEFAULT_MODEL, initialMode = getSavedMode() || DEFAULT_MODE } = {}) {
  const session = createSharedSession(initialModel, initialMode);

  const httpServer = createServer((req, res) => {
    // CORS for extension
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Config endpoint — lets the Chrome extension import saved keys + endpoints
    if (req.url === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        apiKeys:         getSavedApiKeys(),
        customEndpoints: getSavedCustomEndpoints(),
        model:           getSavedModel(),
      }));
      return;
    }

    // Chess trainer — standalone page
    if (req.url === '/chess' || req.url === '/chess/') {
      serveFile(res, join(__dirname, '../../docs/chess.html'), false);
      return;
    }

    const url = req.url === '/' ? '/index.html' : req.url;
    serveFile(res, join(DIST_DIR, url));
  });

  const wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', (ws) => session.addClient(ws));

  const schedulerTimer = startScheduler();

  httpServer.listen(PORT, () => {
    try { mkdirSync(dirname(PID_FILE), { recursive: true }); writeFileSync(PID_FILE, String(process.pid), 'utf8'); } catch {}
    console.log(`\n  ◈ Axion web UI  →  http://localhost:${PORT}\n`);
    console.log(`  Working directory: ${process.cwd()}`);
    console.log(`  Press Ctrl+C to stop  (or /web stop in the CLI).\n`);
  });

  const cleanup = () => {
    clearInterval(schedulerTimer);
    try { unlinkSync(PID_FILE); } catch {}
  };
  process.once('exit',    cleanup);
  process.once('SIGINT',  () => { cleanup(); process.exit(0); });
  process.once('SIGTERM', () => { cleanup(); process.exit(0); });

  return httpServer;
}

// ── Shared session (one agent, all clients see everything) ────────────────────

function createSharedSession(defaultModel, defaultMode) {
  let model           = defaultModel;
  let mode            = defaultMode;
  let thinking        = false;
  let confirmResolver = null;
  let questionResolver = null;
  let extThinking     = false;
  let thinkingBudget  = 10000;
  let systemOverride  = '';
  let goal            = null;
  let goalActive      = false;
  let lastUserMsg     = '';
  let tokens          = { total: 0, input: 0, output: 0 };
  let displayMessages = [];
  const sessionStart  = Date.now();

  let currentChatName = null;
  let chatAutoNamed   = false;
  let sessionTab      = null; // null = new session; 'code' or 'chat' once first message sent
  let messageQueue    = [];
  let cancelFn        = null;
  let streamBuffer    = '';
  let uploadPaths     = []; // file paths uploaded in current session

  // ── Terminal / console ────────────────────────────────────────────────────
  let terminalProc    = null; // child_process spawn
  let terminalBuf     = '';   // buffered output before WS is connected

  const MAX_GOAL_ITERS = 25;
  const THINKING_WORDS = ['baking','brewing','conjuring','weaving','crafting',
                          'simmering','forging','hatching','distilling','wrangling',
                          'cooking up','scheming','assembling','calibrating','synthesizing',
                          'plotting','whittling','ruminating','percolating','manifesting',
                          'untangling','chiseling','mulling','marinating','decoding',
                          'reverse-engineering','daydreaming','noodling','spelunking','simulating',
                          'hallucinating productively','connecting dots','running the numbers','vibing'];

  // ── Client set ──────────────────────────────────────────────────────────────

  const clients = new Set();

  function broadcast(data) {
    const json = JSON.stringify(data);
    for (const c of clients) {
      if (c.readyState === 1 /* OPEN */) try { c.send(json); } catch { clients.delete(c); }
    }
  }

  function sendTo(ws, data) {
    if (ws.readyState === 1) ws.send(JSON.stringify(data));
  }

  function pickWord() {
    return THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)];
  }

  function pushDisplay(msg) {
    displayMessages.push(msg);
    broadcast({ type: 'message', msg });
  }

  function broadcastStatus() {
    broadcast({ type: 'status', model, mode, tokens, goal, extThinking, thinkingBudget });
  }

  // ── Terminal / console ────────────────────────────────────────────────────

  function startTerminal(ws) {
    if (terminalProc) {
      // Flush buffered output to the requesting client
      if (terminalBuf) {
        sendTo(ws, { type: 'terminal_output', data: terminalBuf });
      }
      return;
    }
    const shell = process.platform === 'win32'
      ? { cmd: 'powershell.exe', args: ['-NoLogo'] }
      : { cmd: 'bash', args: ['--norc'] };
    terminalBuf = '';
    terminalProc = spawn(shell.cmd, shell.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    terminalProc.stdout.on('data', (chunk) => {
      terminalBuf += chunk.toString();
      broadcast({ type: 'terminal_output', data: chunk.toString() });
    });
    terminalProc.stderr.on('data', (chunk) => {
      terminalBuf += chunk.toString();
      broadcast({ type: 'terminal_output', data: chunk.toString() });
    });
    terminalProc.on('exit', () => {
      terminalProc = null;
      terminalBuf = '';
      broadcast({ type: 'terminal_end' });
    });
    terminalProc.on('error', (err) => {
      broadcast({ type: 'terminal_error', message: err.message });
    });
  }

  function stopTerminal() {
    if (terminalProc) {
      terminalProc.kill();
      terminalProc = null;
      terminalBuf = '';
    }
  }

  // ── Agent (shared across all clients) ──────────────────────────────────────

  const agent = new Agent({
    modelAlias: model,
    mode,
    onTokens: (t) => { tokens = t; broadcast({ type: 'tokens', ...t }); },
    onStreamChunk: (chunk) => {
      streamBuffer += chunk;
      broadcast({ type: 'stream_chunk', content: chunk });
    },
    onStreamEnd: () => {
      if (streamBuffer.trim()) {
        displayMessages.push({ type: 'assistant', content: streamBuffer });
      }
      streamBuffer = '';
      broadcast({ type: 'stream_end' });
    },
    onToolCall: ({ name, input, id }) => {
      const msg = { type: 'tool', id, name, input, output: null, success: null, pending: true };
      displayMessages.push(msg);
      broadcast({ type: 'tool_call', id, name, input });
    },
    onToolResult: ({ name, output, success, diff }) => {
      for (let i = displayMessages.length - 1; i >= 0; i--) {
        if (displayMessages[i].type === 'tool' && displayMessages[i].name === name && displayMessages[i].pending) {
          displayMessages[i] = { ...displayMessages[i], output, success, pending: false, diff: diff || null };
          break;
        }
      }
      broadcast({ type: 'tool_result', name, output, success, diff });
    },
    onMessage: ({ role, content, label }) => {
      const type = role;
      const msg = { type, content, label };
      if (role !== 'thinking') displayMessages.push(msg);
      broadcast({ type: 'message', msg });
    },
    onNotify: (n) => {
      if (n.type === 'agent-msg') {
        const msg = { type: 'agent-msg', from: n.from, to: n.to, content: n.content };
        displayMessages.push(msg);
        broadcast({ type: 'message', msg });
      }
    },
  });

  // ── Add a new client ────────────────────────────────────────────────────────

  function addClient(ws) {
    clients.add(ws);

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // Cancel current generation
      if (msg.type === 'cancel') {
        if (cancelFn) cancelFn(new Error('cancelled'));
        return;
      }

      // Hello handshake — client identifies itself and gets full history
      if (msg.type === 'hello') {
        ws._clientType = msg.clientType || 'web';

        sendTo(ws, {
          type: 'welcome',
          model, mode,
          cwd: process.cwd(),
          history: displayMessages,
          chats: listChats(),
          sessionTab,
          chatName: currentChatName,
        });
        broadcastStatus();
        return;
      }

      // ── Terminal / console ──────────────────────────────────────────────────
      if (msg.type === 'terminal_start') {
        startTerminal(ws);
        return;
      }
      if (msg.type === 'terminal_input') {
        if (terminalProc && terminalProc.stdin.writable) {
          terminalProc.stdin.write(msg.data);
        }
        return;
      }
      if (msg.type === 'terminal_resize') {
        // child_process.spawn doesn't support resize; upgrade to node-pty for this
        return;
      }

      // Chat list refresh
      if (msg.type === 'list_chats') {
        sendTo(ws, { type: 'chats_list', chats: listChats() });
        return;
      }

      // Confirm — first responder wins
      if (msg.type === 'confirm') {
        if (confirmResolver) {
          const resolve = confirmResolver;
      confirmResolver = null;
      questionResolver = null;
          resolve(msg.answer);
        }
        return;
      }

      if (msg.type === 'question_answer') {
        if (questionResolver) {
          const resolve = questionResolver;
          questionResolver = null;
          confirmResolver = null;
          resolve(msg.answer);
        }
        return;
      }

      if (msg.type === 'file_upload') {
        const fileName = msg.name || 'upload';
        const fileData = Buffer.from(msg.data, 'base64');
        const uploadDir = join(homedir(), '.axion', 'uploads');
        mkdirSync(uploadDir, { recursive: true });
        const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filePath = join(uploadDir, `${Date.now()}-${safeName}`);
        writeFileSync(filePath, fileData);
        uploadPaths.push(filePath);
        sendTo(ws, { type: 'file_uploaded', name: fileName, path: filePath });
        return;
      }

      if (msg.type === 'submit') {
        const input = (msg.content || '').trim();
        if (!input) return;

        if (input.startsWith('/')) {
          await handleCommand(input, ws);
          return;
        }

        if (thinking) {
          messageQueue.push({ input, clientType: ws._clientType || 'web', tab: msg.tab || 'code' });
          const count = messageQueue.length;
          broadcast({ type: 'queue_update', count });
          sendTo(ws, { type: 'message', msg: { type: 'info', content: `⏱ Queued (${count}): "${input.slice(0, 60)}${input.length > 60 ? '…' : ''}"` } });
          return;
        }

        // Prepend file references to the message
        let uploadMsg = input;
        if (msg.uploadPaths?.length) {
          const refs = msg.uploadPaths.map((p) => `[file] ${basename(p)} (${p})`).join('\n');
          uploadMsg = `${refs}\n\n${input}`;
        }
        await processMessage(uploadMsg, ws._clientType || 'web', msg.tab || 'code');
      }
    });

    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  }

  // ── Run agent ───────────────────────────────────────────────────────────────

  async function runAgent(message) {
    const askConfirm = (tc) => {
      if (tc.name && tc.name.includes('sequentialthinking')) return Promise.resolve(true);
      return new Promise((resolve) => {
        confirmResolver = resolve;
        broadcast({ type: 'confirm_request', kind: 'tool', tool: { name: tc.name, label: confirmLabel(tc.name, tc.input) } });
      });
    };
    const askPlanConfirm = () => new Promise((resolve) => {
      confirmResolver = resolve;
      broadcast({ type: 'confirm_request', kind: 'plan' });
    });

    const askUser = (prompt) => new Promise((resolve) => {
      questionResolver = resolve;
      broadcast({ type: 'question', prompt });
    });

    if (goal) {
      goalActive = true;
      for (let iter = 0; iter < MAX_GOAL_ITERS && goalActive; iter++) {
        broadcastStatus();
        const msg = iter === 0 ? message : 'Continue working on the goal.';
        if (iter > 0) pushDisplay({ type: 'info', content: `── goal iteration ${iter + 1} ──` });
        await agent.run(msg, { askConfirm, askPlanConfirm, askUser });
        const hist = agent.history;
        const last = [...hist].reverse().find((m) => m.role === 'assistant');
        const lastText = typeof last?.content === 'string' ? last.content
          : last?.content?.find?.((c) => c.type === 'text')?.text || '';
        if (lastText.includes('GOAL_COMPLETE')) {
          pushDisplay({ type: 'info', content: '✔ Goal complete.' });
          goal = null; goalActive = false; agent.setGoal(null);
          break;
        }
      }
      if (goalActive) pushDisplay({ type: 'info', content: `Goal reached max iterations (${MAX_GOAL_ITERS}).` });
      goalActive = false;
    } else {
      await agent.run(message, { askConfirm, askPlanConfirm, askUser });
    }
  }

  // ── Process a user message (handles cancel, queue drain, auto-save) ───────────

  async function processMessage(input, clientType, tab = 'code') {
    // Lock session to the tab of the first message
    if (sessionTab === null) {
      sessionTab = tab;
      broadcast({ type: 'session_tab', tab: sessionTab });
    }
    agent.setChatMode(sessionTab === 'chat');
    lastUserMsg = input;
    const userMsg = { type: 'user', content: input, source: clientType };
    displayMessages.push(userMsg);
    broadcast({ type: 'message', msg: userMsg });
    broadcast({ type: 'thinking_start', word: pickWord() });
    thinking = true;

    const cancelPromise = new Promise((_, rej) => { cancelFn = rej; });
    try {
      await Promise.race([runAgent(input), cancelPromise]);
    } catch (err) {
      if (err.message === 'cancelled') {
        const cm = { type: 'info', content: '⊘ Stopped.' };
        displayMessages.push(cm); broadcast({ type: 'message', msg: cm });
      } else {
        const em = { type: 'error', content: err.message };
        displayMessages.push(em); broadcast({ type: 'message', msg: em });
      }
    } finally {
      cancelFn = null;
      thinking = false;
      confirmResolver = null;
      broadcast({ type: 'thinking_end' });
      broadcastStatus();
      autoSaveChat();
      if (messageQueue.length > 0) {
        const next = messageQueue.shift();
        broadcast({ type: 'queue_update', count: messageQueue.length });
        await processMessage(next.input, next.clientType, next.tab);
      } else {
        broadcast({ type: 'queue_update', count: 0 });
      }
    }
  }

  // ── Auto-save chat with AI-chosen title from first assistant response ─────────

  function autoSaveChat() {
    const firstUser = displayMessages.find(m => m.type === 'user');
    if (!firstUser) return;
    if (!chatAutoNamed) {
      let raw = '';
      const firstAssistant = displayMessages.find(m => m.type === 'assistant');
      if (firstAssistant?.content) {
        raw = firstAssistant.content.trim().replace(/\n+/g, ' ').replace(/[^\w\s-]/g, '').trim();
      }
      if (!raw) {
        raw = firstUser.content.trim().replace(/\n+/g, ' ').replace(/[^\w\s-]/g, '').trim();
      }
      const words = raw.split(/\s+/).slice(0, 5).join(' ');
      const safe = (words.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40) || `chat-${Date.now()}`);
      currentChatName = safe;
      chatAutoNamed = true;
      broadcast({ type: 'chat_name', name: safe });
    }
    if (currentChatName) {
      try {
        saveChat(currentChatName, { model, mode, tokenCount: tokens.total, agentHistory: agent.history || [], displayMessages, tab: sessionTab || 'code' });
      } catch (err) {
        console.error('[autoSave] saveChat failed:', err.message);
      }
      broadcast({ type: 'chats_list', chats: listChats() });
    }
  }

  // ── Slash commands ──────────────────────────────────────────────────────────
  // ws param used for commands that only affect the requesting client (none currently)

  async function handleCommand(input, _ws) { // eslint-disable-line no-unused-vars
    const [cmd, ...args] = input.slice(1).trim().split(/\s+/);
    const arg = args.join(' ');
    const info  = (content) => pushDisplay({ type: 'info',  content });
    const error = (content) => pushDisplay({ type: 'error', content });

    switch (cmd.toLowerCase()) {
      case 'help': info(HELP_TEXT); break;

      case 'clear':
        agent.clearHistory();
        tokens = { total: 0, input: 0, output: 0 };
        lastUserMsg = ''; displayMessages = [];
        currentChatName = null; chatAutoNamed = false; sessionTab = null; messageQueue = [];
        uploadPaths = [];
        stopTerminal();
        broadcast({ type: 'clear' });
        broadcast({ type: 'queue_update', count: 0 });
        broadcastStatus();
        break;

      case 'model':
        if (!arg) { info(`current: ${model}  available: ${Object.keys(MODELS).join(' · ')}`); }
        else { model = arg; agent.setModel(model); saveModel(model); info(`model → ${arg} (saved)`); broadcastStatus(); }
        break;

      case 'mode': {
        // 'bypass' is the user-facing alias for 'auto'
        const nm = arg === 'bypass' ? 'auto' : arg;
        if (!['ask','plan','auto'].includes(nm)) { error(`unknown mode "${arg}" — use ask, plan, or bypass`); }
        else { mode = nm; agent.setMode(nm); saveMode(nm); info(`mode → ${nm === 'auto' ? 'bypass' : nm} (saved)`); broadcastStatus(); }
        break;
      }

      case 'api': {
        const [apiTarget, apiKey] = args;
        if (!apiTarget || !apiKey) { error('usage: /api <model> <key>'); break; }
        if (apiTarget === 'lumen' || apiTarget === 'axion') {
          if (!apiKey.startsWith('axion-sk-')) { error('Axion keys start with axion-sk-  —  get one at axion.amplifiedsmp.org/keys'); break; }
          saveAxionKey(apiKey);
          info(`Axion API key saved. Lumen now uses your key (1,000 req/month · 40 req/2h).`);
          break;
        }
        try { const p = setApiKey(apiTarget, apiKey); saveApiKey(p, apiKey); info(`API key set for ${p} (saved)`); }
        catch (err) { error(err.message); }
        break;
      }

      case 'thinking': {
        if (!arg || arg === 'off') { extThinking = false; agent.setThinking(false); info('Extended thinking off.'); }
        else if (arg === 'on')    { extThinking = true;  agent.setThinking(true, thinkingBudget); info(`Extended thinking on (budget: ${thinkingBudget.toLocaleString()} tokens)`); }
        else {
          const budget = parseInt(arg, 10);
          if (isNaN(budget) || budget < 1000) { error('usage: /thinking [on|off|<tokens>]'); break; }
          extThinking = true; thinkingBudget = budget; agent.setThinking(true, budget);
          info(`Extended thinking on (budget: ${budget.toLocaleString()} tokens)`);
        }
        broadcastStatus(); break;
      }

      case 'system':
        if (!arg) { info(systemOverride ? `Current: ${systemOverride}\n\nUse /system clear to remove.` : 'No system override set.'); }
        else if (arg === 'clear') { systemOverride = ''; agent.setSystemOverride(''); info('System override cleared.'); }
        else { systemOverride = arg; agent.setSystemOverride(arg); info(`System override set: ${arg}`); }
        break;

      case 'goal':
        if (!arg) {
          if (goal) { goalActive = false; goal = null; agent.setGoal(null); info('Goal cancelled.'); }
          else info('No active goal. Usage: /goal <description>');
        } else {
          goal = arg; agent.setGoal(arg);
          info(`Goal set: "${arg}"\nAxion will work autonomously until this is achieved (max ${MAX_GOAL_ITERS} iterations).`);
        }
        broadcastStatus(); break;

      case 'retry': {
        if (!lastUserMsg) { info('Nothing to retry yet.'); break; }
        const h = agent.history;
        const li = [...h].reverse().findIndex((m) => m.role === 'user');
        if (li !== -1) agent.history = h.slice(0, h.length - 1 - li);
        info(`↩ Retrying: "${lastUserMsg}"`);
        const rm = { type: 'user', content: lastUserMsg };
        displayMessages.push(rm); broadcast({ type: 'message', msg: rm });
        broadcast({ type: 'thinking_start', word: 'retrying' }); thinking = true;
        try { await runAgent(lastUserMsg); }
        catch (err) { broadcast({ type: 'message', msg: { type: 'error', content: err.message } }); }
        finally { thinking = false; broadcast({ type: 'thinking_end' }); broadcastStatus(); }
        break;
      }

      case 'compact':
        if (!agent.history?.length) { info('Nothing to compact yet.'); break; }
        info('Compacting history…');
        broadcast({ type: 'thinking_start', word: 'compressing' });
        try { const s = await agent.compact(); info(`✔ Compacted. Summary:\n${s}`); }
        catch (err) { error(`Compact failed: ${err.message}`); }
        finally { broadcast({ type: 'thinking_end' }); }
        break;

      case 'undo': {
        const r = undoLastBackup();
        if (r) info(`↩ Restored: ${r}  (${undoStackSize()} more available)`);
        else info('Nothing to undo.');
        break;
      }

      case 'export-session': {
        if (!arg) { error('usage: /export-session <path>'); break; }
        try {
          const sessionData = { model, mode, agentHistory: agent.history || [], displayMessages, tokenCount: tokens.total, tab: sessionTab || 'code', systemOverride };
          const outPath = exportSession(arg, sessionData);
          info(`✔ Session exported to ${outPath}`);
        } catch (err) { error(`Export failed: ${err.message}`); }
        break;
      }

      case 'import-session': {
        if (!arg) { error('usage: /import-session <path>'); break; }
        try {
          const data = importSession(arg);
          if (!data) { error(`Not a valid Axion session file: ${arg}`); break; }
          if (data.model) { model = data.model; agent.setModel(data.model); saveModel(data.model); }
          if (data.mode)  { mode = data.mode; agent.setMode(data.mode); saveMode(data.mode); }
          if (data.agentHistory) agent.history = data.agentHistory;
          if (data.systemOverride) { systemOverride = data.systemOverride; agent.setSystemOverride(data.systemOverride); }
          if (data.tab) sessionTab = data.tab;
          tokens = data.tokenCount ? { total: data.tokenCount, input: 0, output: data.tokenCount } : { total: 0, input: 0, output: 0 };
          displayMessages = data.displayMessages || [];
          broadcast({ type: 'resume', model, mode, messages: displayMessages, tab: sessionTab });
          broadcastStatus();
          info(`✔ Session imported: ${data.model || model} · ${data.mode || mode} · ${displayMessages.length} messages`);
        } catch (err) { error(`Import failed: ${err.message}`); }
        break;
      }

      case 'remember':
        if (!arg) {
          const ms = getMemories();
          if (!ms.length) { info('No memories saved. Use /remember <text> to add one.'); break; }
          info(`Persistent notes (${ms.length}):\n${ms.map((m,i) => `  ${i+1}. ${m.text}`).join('\n')}\n\nUse /forget <number> to remove one.`);
        } else { const l = addMemory(arg); info(`Remembered: "${arg}"  (${l.length} total)`); }
        break;

      case 'forget': {
        const idx = parseInt(arg, 10) - 1;
        if (isNaN(idx)) { error('usage: /forget <number>'); break; }
        const ms = getMemories();
        if (idx < 0 || idx >= ms.length) { error(`No memory #${idx+1}.`); break; }
        const removed = ms[idx].text; removeMemory(idx); info(`Forgotten: "${removed}"`);
        break;
      }

      case 'save':
        if (!arg) { error('usage: /save <chatname>'); break; }
        saveChat(arg, { model, mode, tokenCount: tokens.total, agentHistory: agent.history || [], displayMessages, tab: sessionTab || 'code' });
        currentChatName = arg; chatAutoNamed = true;
        info(`Chat saved as "${arg}".`);
        broadcast({ type: 'chat_name', name: arg });
        broadcast({ type: 'chats_list', chats: listChats() });
        break;

      case 'resume': {
        const isCli = _ws._clientType === 'cli';
        if (!arg) {
          const allChats = listChats();
          const visible  = isCli ? allChats.filter(c => (c.tab || 'code') === 'code') : allChats;
          if (!visible.length) { info('No saved chats. Use /save <chatname> to save one.'); break; }
          info(`Saved chats:\n${visible.map(c => `  ${c.name.padEnd(20)} ${(c.model||'?').padEnd(14)} ${c.savedAt ? new Date(c.savedAt).toLocaleString() : '?'}`).join('\n')}\n\nUse /resume <chatname> to load one.`);
          break;
        }
        const chat = loadChat(arg);
        if (!chat) { error(`No saved chat named "${arg}".`); break; }
        // CLI can only resume code chats
        if (isCli && (chat.tab || 'code') !== 'code') {
          error(`Chat "${arg}" is a chat-type session and cannot be resumed from the CLI.`);
          break;
        }
        agent.history = chat.agentHistory || [];
        model = chat.model || model; mode = chat.mode || mode;
        tokens = { total: chat.tokenCount || 0, input: 0, output: chat.tokenCount || 0 };
        agent.setModel(model); agent.setMode(mode);
        displayMessages = chat.displayMessages || [];
        sessionTab = chat.tab || 'code';
        currentChatName = arg; chatAutoNamed = true; messageQueue = [];
        broadcast({ type: 'resume', model, mode, messages: displayMessages, tab: sessionTab });
        broadcast({ type: 'chat_name', name: arg });
        broadcastStatus();
        break;
      }

      case 'remove-chat':
        if (!arg) { error('usage: /remove-chat <chatname>'); break; }
        if (deleteChat(arg)) {
          if (currentChatName === arg) { currentChatName = null; chatAutoNamed = false; }
          broadcast({ type: 'chats_list', chats: listChats() });
        } else { error(`No saved chat named "${arg}".`); }
        break;

      case 'rename-chat': {
        const [oldName, ...rest] = args;
        const newName = rest.join(' ').trim();
        if (!oldName || !newName) { error('usage: /rename-chat <oldname> <newname>'); break; }
        const chat = loadChat(oldName);
        if (!chat) { error(`No saved chat named "${oldName}".`); break; }
        saveChat(newName, chat);
        deleteChat(oldName);
        if (currentChatName === oldName) currentChatName = newName;
        broadcast({ type: 'chats_list', chats: listChats() });
        break;
      }

      case 'models': {
        const built = Object.entries(MODELS).map(([a,id]) => `  ${a.padEnd(22)} ${id}`).join('\n');
        const custom = Object.entries(CUSTOM_ENDPOINTS);
        info(`Available models:\n${built}${custom.length ? '\n\nCustom:\n'+custom.map(([n,e])=>`  ${n.padEnd(22)} ${e.model}  ${e.baseURL}`).join('\n') : ''}`);
        break;
      }

      case 'history': {
        if (!arg) { error('usage: /history <query>'); break; }
        const q = arg.toLowerCase();
        const hits = displayMessages.filter(m => (m.type==='user'||m.type==='assistant') && typeof m.content==='string' && m.content.toLowerCase().includes(q));
        if (!hits.length) { info(`No messages found containing "${arg}".`); break; }
        info(`${hits.length} match(es) for "${arg}":\n${hits.slice(-8).map(m=>`  [${m.type}] ${m.content.trim().slice(0,120).replace(/\n/g,' ')}`).join('\n')}`);
        break;
      }

      case 'btw':
        if (!arg) { error('usage: /btw <question>'); break; }
        pushDisplay({ type: 'user', content: `btw: ${arg}` });
        broadcast({ type: 'thinking_start', word: 'checking' });
        try { const a = await agent.askBtw(arg); pushDisplay({ type: 'btw', content: a }); }
        catch (err) { error(`btw failed: ${err.message}`); }
        finally { broadcast({ type: 'thinking_end' }); }
        break;

      case 'endpoint': {
        const [f,s,t,fo] = args;
        if (!f) {
          const es = Object.entries(CUSTOM_ENDPOINTS);
          if (!es.length) info(`No custom endpoints.\n\nUsage: /endpoint <name> <url> [model] [key]`);
          else info(`Saved endpoints:\n${es.map(([n,e])=>`  ${n.padEnd(16)} ${e.baseURL}  model: ${e.model}`).join('\n')}`);
          break;
        }
        let epName, epURL, epModel, epKey;
        if (f.startsWith('http')) { epName='other'; epURL=f; epModel=s; epKey=t; }
        else { epName=f; epURL=s; epModel=t; epKey=fo; }
        if (!epURL) { const ep=CUSTOM_ENDPOINTS[epName]; if(ep) info(`${epName}: ${ep.baseURL}\n  model: ${ep.model}`); else error(`No endpoint named "${epName}".`); break; }
        CUSTOM_ENDPOINTS[epName] = { baseURL: epURL, model: epModel||CUSTOM_ENDPOINTS[epName]?.model||epName, apiKey: epKey||CUSTOM_ENDPOINTS[epName]?.apiKey||'no-key' };
        saveCustomEndpoints({ ...CUSTOM_ENDPOINTS });
        model = epName; agent.setModel(epName); saveModel(epName);
        info(`Endpoint "${epName}" saved → ${CUSTOM_ENDPOINTS[epName].baseURL}\nSwitched to "${epName}"`);
        broadcastStatus(); break;
      }

      case 'img-gen': {
        if (!arg) { error('usage: /img-gen <prompt>'); break; }
        broadcast({ type: 'thinking_start', word: 'painting' });
        try {
          const { b64, filePath, revisedPrompt, model: imgModel } = await generateImage(arg);
          const display = revisedPrompt !== arg ? `\nRevised prompt: ${revisedPrompt}` : '';
          // Push image as a renderable message for the web
          const imgMsg = { type: 'img', b64, filePath, prompt: arg, revisedPrompt, model: imgModel };
          displayMessages.push(imgMsg);
          broadcast({ type: 'message', msg: imgMsg });
          info(`◈ Image generated with ${imgModel}${display}\n  Saved to: ${filePath}`);
        } catch (err) {
          error(`Image generation failed: ${err.message}`);
        } finally {
          broadcast({ type: 'thinking_end' });
        }
        break;
      }

      case 'img-gen-model': {
        if (!arg) {
          info(`Image model: ${IMAGE_GEN_MODEL.current}\n  Available: dall-e-3  dall-e-2  gpt-image-1\n  Usage: /img-gen-model <model>`);
          break;
        }
        IMAGE_GEN_MODEL.current = arg;
        saveImageModel(arg);
        info(`Image model → ${arg} (saved)`);
        break;
      }

      case 'todo': {
        const [sub, ...todoRest] = args;
        const todoText = todoRest.join(' ').trim();
        if (!sub) {
          const all = getTodos();
          if (!all.length) { info('TODO list is empty.\n  /todo add <text>   add a task\n  /todo done <id>    mark complete\n  /todo list         show all\n  /todo clear        clear completed'); break; }
          const pending = all.filter(t => !t.done);
          const done = all.filter(t => t.done);
          const lines = [`Pending: ${pending.length}  Done: ${done.length}  Total: ${all.length}`];
          pending.forEach(t => lines.push(`  ☐ ${t.text}  [${t.id}]`));
          if (done.length) lines.push(`  ☑ ${done.length} completed (use /todo list to see all)`);
          info(lines.join('\n')); break;
        }
        if (sub === 'add') {
          if (!todoText) { error('usage: /todo add <text>'); break; }
          addTodo(todoText);
          info(`✔ Added: "${todoText}"`); break;
        }
        if (sub === 'done') {
          if (!todoText) { error('usage: /todo done <id>'); break; }
          const toggled = toggleTodo(todoText);
          if (!toggled) { error(`No TODO found with id "${todoText}". Use /todo to see ids.`); break; }
          info(toggled.done ? `✔ Completed: "${toggled.text}"` : `↩ Reopened: "${toggled.text}"`); break;
        }
        if (sub === 'list') {
          const all = getTodos();
          if (!all.length) { info('TODO list is empty.'); break; }
          const pending = all.filter(t => !t.done);
          const done = all.filter(t => t.done);
          const lines = [`── TODOs ──  Pending: ${pending.length}  Done: ${done.length}`];
          pending.forEach(t => lines.push(`  ☐ ${t.text}  [${t.id}]`));
          done.forEach(t => lines.push(`  ☑ ${t.text}  [${t.id}]`));
          info(lines.join('\n')); break;
        }
        if (sub === 'clear') {
          const all = getTodos();
          const completed = all.filter(t => t.done);
          completed.forEach(t => removeTodo(t.id));
          info(`Cleared ${completed.length} completed task(s).`); break;
        }
        error(`Unknown subcommand: /todo ${sub}\nUsage: /todo add|done|list|clear`);
        break;
      }

      case 'profile': {
        const [sub, ...profileRest] = args;
        const pName = profileRest.join(' ').trim();
        if (sub === 'save' && pName) {
          saveProfile(pName, { model, mode });
          info(`Profile saved: "${pName}" (${model}, ${mode})`);
        } else if (sub === 'load' && pName) {
          const p = loadProfile(pName);
          if (!p) { error(`No profile named "${pName}". Use /profile list`); break; }
          model = p.model; agent.setModel(p.model); saveModel(p.model);
          mode = p.mode; agent.setMode(p.mode); saveMode(p.mode);
          info(`Profile loaded: "${pName}" → ${p.model}, ${p.mode}`);
          broadcastStatus();
        } else if (sub === 'delete' && pName) {
          deleteProfile(pName);
          info(`Deleted profile "${pName}".`);
        } else if (sub === 'list' || !sub) {
          const list = listProfiles();
          if (!list.length) { info('No saved profiles. Use /profile save <name>'); break; }
          info(`Profiles:\n${list.map(n => `  ${n}`).join('\n')}`);
        } else {
          error('usage: /profile save|load|delete|list [name]');
        }
        break;
      }

      case 'cost': {
        const win = getContextWindow(model) * 0.85;
        const ctxNow = tokens.context || tokens.total;
        const pct = win > 0 ? Math.round((ctxNow / win) * 100) : 0;
        const fmtTok = n => n >= 1000 ? `${(n/1000).toFixed(1)}k` : String(n||0);
        info(
          `  Session usage\n` +
          `  ──────────────────────────────\n` +
          `  model     ${model}\n` +
          `  tokens    ${fmtTok(tokens.input)} in · ${fmtTok(tokens.output)} out · ${fmtTok(tokens.total)} total\n` +
          `  context   ${fmtTok(ctxNow)} / ${fmtTok(win)} (${pct}%)`
        );
        break;
      }

      case 'stats': {
        const elapsed = Math.floor((Date.now() - sessionStart) / 1000);
        const hrs = Math.floor(elapsed / 3600);
        const mins = Math.floor((elapsed % 3600) / 60);
        const secs = elapsed % 60;
        const dur = hrs > 0 ? `${hrs}h ${mins}m ${secs}s` : mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
        const msgCount = displayMessages.filter(m => m.type === 'user' || m.type === 'assistant').length;
        const sWin = getContextWindow(model) * 0.85;
        const sCtx = tokens.context || tokens.total;
        const sPct = sWin > 0 ? Math.round((sCtx / sWin) * 100) : 0;
        const fmtTok = n => n >= 1000 ? `${(n/1000).toFixed(1)}k` : String(n||0);
        info(
          `  Session stats\n` +
          `  ──────────────────────────────\n` +
          `  model     ${model}\n` +
          `  mode      ${mode}\n` +
          `  duration  ${dur}\n` +
          `  messages  ${msgCount}\n` +
          `  tokens    ${fmtTok(tokens.input)} in · ${fmtTok(tokens.output)} out · ${fmtTok(tokens.total)} total\n` +
          `  context   ${fmtTok(sCtx)} / ${fmtTok(sWin)} (${sPct}%)`
        );
        break;
      }

      default: error(`unknown command /${cmd} — type /help`);
    }
  }

  return { addClient };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function confirmLabel(name, input) {
  if (!input) return '';
  switch (name) {
    case 'read_file': case 'write_file': case 'patch_file': case 'delete_file': return input.path || '';
    case 'move_file':      return `${input.from} → ${input.to}`;
    case 'list_directory': return input.path || '.';
    case 'run_command':    return `\`${(input.command||'').slice(0,60)}\``;
    case 'git_commit':     return `"${(input.message||'').slice(0,50)}"`;
    case 'web_search':     return `"${(input.query||'').slice(0,60)}"`;
    case 'fetch_url':      return input.url || '';
    default: return '';
  }
}

const HELP_TEXT = `Commands
──────────────────────────────────────────────────
/help                           this screen
/model <name|id>                switch model
/mode  <name>                   ask · plan · bypass  (click mode in status bar to cycle)
/api   <model> <key>            set API key (saved)
/endpoint <name> <url> [model] [key]  custom endpoint
/thinking [on|off|<tokens>]     extended thinking
/img-gen <prompt>               generate an image (OpenAI)
/img-gen-model [model]          set/show image model (dall-e-3, dall-e-2, gpt-image-1)
/remember <text>                save a persistent note
/forget <index>                 remove a saved note
/models                         list all models
/history <query>                search message history
/system [text]                  extra system instructions
/goal <description>             autonomous goal mode
/retry                          re-run last message
/compact                        compress history
/btw <question>                 quick side question
/save <name>                    save current chat
/resume <name>                  resume a saved chat
/remove-chat <name>             delete a saved chat
/rename-chat <old> <new>        rename a saved chat
/undo                           restore last overwritten file
/clear                          clear history
/todo [add|done|list|clear]     manage your TODO list
/profile [save|load|delete|list] manage model+mode profiles
/cost                           show session token usage
/stats                          show session stats (tokens, duration, messages)`;

// Run when invoked directly: node src/web/server.js
import { pathToFileURL } from 'url';
const _isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (_isMain) start();
