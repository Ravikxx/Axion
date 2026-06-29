// OpenTUI entry point for the Axion TUI. Runs under Bun (OpenTUI's renderer
// requires Bun's FFI). Launched in production via src/tui/launch.js.
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { writeSync } from 'fs';
import minimist from 'minimist';
import { App } from './App.jsx';
import {
  getSavedModel, getSavedMode, getSavedApiKeys, getSavedCustomEndpoints,
  loadChat, loadLastSession, saveChat, listChats,
} from '../persist.js';
import { API_KEYS, CUSTOM_ENDPOINTS, DEFAULT_MODEL, DEFAULT_MODE, fetchOpenRouterContextWindows, fetchEndpointContextWindows } from '../config.js';
import { accent } from '../ui/theme.js';
import { sessionSummary } from './exitSummary.js';

// ── Interactive session picker ──────────────────────────────────────────────────
function pickSession() {
  return new Promise((resolve) => {
    const chats = listChats();
    if (!chats.length) {
      process.stderr.write('\n  No saved sessions found.\n\n');
      process.exit(1);
    }
    let sel = 0;
    const render = () => {
      process.stderr.write('\x1b[?25l\x1b[2J\x1b[H\x1b[?1000l\x1b[?1002l\x1b[?1006l');
      process.stderr.write('  Select a session (↑/↓ Enter Esc  or  click):\n\n');
      chats.forEach((c, i) => {
        const pfx = i === sel ? ' ▸' : '  ';
        const dir = c.cwd ? String(c.cwd).split(/[\\/]/).pop() : '?';
        const date = c.savedAt ? new Date(c.savedAt).toLocaleString() : '';
        const num = i < 9 ? `\x1b[90m${i + 1}\x1b[0m ` : '  ';
        process.stderr.write(`  ${pfx} \x1b[33m${c.name}\x1b[0m  ${num}\x1b[90m${dir}\x1b[0m  ${date}\n`);
      });
    };
    const cleanup = () => {
      process.stdin.removeAllListeners('data');
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write('\x1b[?25h\x1b[2J\x1b[H\x1b[?1000l\x1b[?1002l\x1b[?1006l');
    };
    try { process.stdin.setRawMode(true); process.stdin.resume(); } catch {}
    // Enable SGR mouse mode for click support
    process.stderr.write('\x1b[?1000h\x1b[?1002h\x1b[?1006h');
    render();
    process.stdin.on('data', (buf) => {
      const s = buf.toString();
      const b = [...buf];
      // SGR mouse click: ESC [ < M <x+32> <y+32>  or  ESC [ < Cb ; Cx ; Cy M
      if (b[0] === 27 && b[1] === 91 && b[2] === 77) {
        // X10 mouse encoding
        const col = (b[3] || 0) - 32;
        const row = (b[4] || 0) - 32 - 3; // offset for header rows
        if (row >= 0 && row < chats.length) { sel = row; render(); }
        return;
      }
      // SGR mouse: ESC [ < Cb ; Cx ; Cy M
      const sgrM = s.match(/^\x1b\[<(\d+);(\d+);(\d+)[Mm]/);
      if (sgrM) {
        const row = parseInt(sgrM[3], 10) - 3;
        if (row >= 0 && row < chats.length) { sel = row; render(); }
        return;
      }
      // Arrow keys
      if (b[0] === 27 && b[1] === 91) {
        if (b[2] === 65) { sel = Math.max(0, sel - 1); render(); return; }
        if (b[2] === 66) { sel = Math.min(chats.length - 1, sel + 1); render(); return; }
      }
      // Number keys 1-9
      const n = parseInt(s, 10);
      if (n >= 1 && n <= 9 && n <= chats.length) {
        sel = n - 1; render(); return;
      }
      // Enter
      if (b[0] === 13 || b[0] === 10) {
        cleanup();
        resolve(chats[sel].name);
      }
      // Esc
      if (b[0] === 27) {
        cleanup();
        process.exit(0);
      }
    });
  });
}

// ── Seed runtime config from saved settings (mirrors src/index.js) ──────────────
const savedKeys = getSavedApiKeys();
for (const [provider, key] of Object.entries(savedKeys)) {
  if (key && !API_KEYS[provider]) API_KEYS[provider] = key;
}
const savedEndpoints = getSavedCustomEndpoints();
for (const [name, ep] of Object.entries(savedEndpoints)) {
  if (ep?.baseURL) CUSTOM_ENDPOINTS[name] = ep;
}

// Pre-fetch context windows from OpenRouter and custom endpoints (silent)
fetchOpenRouterContextWindows();
fetchEndpointContextWindows();

// ── Resume: -r/--resume <name> a saved chat, or -c/--continue the last session ──
const argv = minimist(process.argv.slice(2), {
  string: ['resume'], boolean: ['continue'], alias: { r: 'resume', c: 'continue' },
});
let resumeName = null;
let initialResume = null;

// Detect bare -r/--resume (no argument) by checking raw args
const rawArgs = process.argv.slice(2);
const hasBareResume = rawArgs.some(a => a === '-r' || a === '--resume' || a === '-resume');
const resumeVal = argv.resume;

if (hasBareResume && (resumeVal === true || resumeVal === '' || typeof resumeVal !== 'string')) {
  resumeName = await pickSession();
  initialResume = loadChat(resumeName);
} else if (typeof resumeVal === 'string' && resumeVal) {
  resumeName = resumeVal;
  initialResume = loadChat(resumeName);
} else if (argv.continue) {
  initialResume = loadLastSession();
  resumeName = initialResume?.name || null;
}

// Auto-cd to the session's saved directory
if (initialResume?.cwd && initialResume.cwd !== process.cwd()) {
  try { process.chdir(initialResume.cwd); } catch {}
}
const sessionId = resumeName || `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

const initialModel = initialResume?.model || getSavedModel() || DEFAULT_MODEL;
const initialMode  = initialResume?.mode  || getSavedMode()  || DEFAULT_MODE;

// ── Renderer + graceful exit with session summary ───────────────────────────────
// If OpenTUI's renderer can't initialize (unsupported platform / terminal), exit
// with code 87 so the Node launcher falls back to the plain readline UI.
let renderer;
try {
  renderer = await createCliRenderer({ exitOnCtrlC: false });
} catch (err) {
  process.stderr.write(`OpenTUI renderer unavailable (${err?.message || err}); falling back.\n`);
  process.exit(87);
}

let exited = false;
function exitWithSummary(session) {
  if (exited) return;
  exited = true;
  const hasContent = session && Array.isArray(session.agentHistory) && session.agentHistory.length > 0;
  try {
    if (hasContent) saveChat(sessionId, session);
  } catch {}
  try { renderer.destroy?.(); } catch {}
  try { writeSync(1, '\x1b[?1049l\x1b[?25h'); } catch {}
  if (hasContent) {
    try {
      const msgCount = (session.displayMessages || []).filter((m) => m.type === 'user' || m.type === 'assistant').length;
      writeSync(1, sessionSummary({
        model: session.model, mode: session.mode, msgCount,
        tokens: session.tokenCount || 0, cost: session.cost || 0, sesId: sessionId, accent: accent(),
      }));
    } catch {}
  }
  process.exit(0);
}

createRoot(renderer).render(
  <App
    initialModel={initialModel}
    initialMode={initialMode}
    initialResume={initialResume}
    onExit={exitWithSummary}
  />
);
