// OpenTUI entry point for the Axion TUI. Runs under Bun (OpenTUI's renderer
// requires Bun's FFI). Launched in production via src/tui/launch.js.
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import minimist from 'minimist';
import { App } from './App.jsx';
import {
  getSavedModel, getSavedMode, getSavedApiKeys, getSavedCustomEndpoints,
  loadChat, loadLastSession, saveChat,
} from '../persist.js';
import { API_KEYS, CUSTOM_ENDPOINTS, DEFAULT_MODEL, DEFAULT_MODE } from '../config.js';
import { accent } from '../ui/theme.js';
import { sessionSummary } from './exitSummary.js';

// ── Seed runtime config from saved settings (mirrors src/index.js) ──────────────
const savedKeys = getSavedApiKeys();
for (const [provider, key] of Object.entries(savedKeys)) {
  if (key && !API_KEYS[provider]) API_KEYS[provider] = key;
}
const savedEndpoints = getSavedCustomEndpoints();
for (const [name, ep] of Object.entries(savedEndpoints)) {
  if (ep?.baseURL) CUSTOM_ENDPOINTS[name] = ep;
}

// ── Resume: -r/--resume <name> a saved chat, or -c/--continue the last session ──
const argv = minimist(process.argv.slice(2), {
  string: ['resume'], boolean: ['continue'], alias: { r: 'resume', c: 'continue' },
});
let initialResume = null;
try {
  if (argv.resume) initialResume = loadChat(argv.resume);
  else if (argv.continue) initialResume = loadLastSession();
} catch {}

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
  let sesId = null;
  const hasContent = session && Array.isArray(session.agentHistory) && session.agentHistory.length > 0;
  try {
    if (hasContent) {
      sesId = `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      saveChat(sesId, session);
    }
  } catch {}
  try { renderer.destroy?.(); } catch {}
  if (hasContent) {
    try {
      const msgCount = (session.displayMessages || []).filter((m) => m.type === 'user' || m.type === 'assistant').length;
      process.stdout.write(sessionSummary({
        model: session.model, mode: session.mode, msgCount,
        tokens: session.tokenCount || 0, cost: session.cost || 0, sesId, accent: accent(),
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
