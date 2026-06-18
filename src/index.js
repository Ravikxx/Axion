import React from 'react';
import { render } from 'ink';
import minimist from 'minimist';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { WebSocket } from 'ws';
import { App } from './ui/App.jsx';
import { LinkedApp } from './ui/LinkedApp.jsx';
import { DEFAULT_MODEL, DEFAULT_MODE, API_KEYS, CUSTOM_ENDPOINTS, IMAGE_GEN_MODEL } from './config.js';
import { getSavedModel, getSavedMode, getSavedApiKeys, getSavedCustomEndpoints, getSavedImageModel, loadLastSession } from './persist.js';
import { MCP } from './agent/mcp.js';
import { runDoctor } from './doctor.js';
import { runUpdate } from './update.js';
import { PLUGINS } from './agent/plugins.js';

// Resolve the web server path relative to this bundle so /web and axion-serve work
const _cliDir    = dirname(fileURLToPath(import.meta.url));
const WEB_SERVER = join(_cliDir, '../src/web/server.js');

const argv = minimist(process.argv.slice(2), {
  string: ['model', 'mode'],
  boolean: ['link', 'doctor', 'update', 'version', 'help', 'continue'],
  alias: { m: 'model', M: 'mode', v: 'version', h: 'help', c: 'continue' },
});

if (argv.version) {
  const pkgPath = join(_cliDir, '../package.json');
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : {};
  console.log(pkg.version || '1.0.0');
  process.exit(0);
}

if (argv.help) {
  console.log(`
Usage: axion [options] [prompt]

  prompt              Send a message on startup without typing in the TUI

Options:
  -m, --model <name>  Model alias (claude, fable, gpt, gemini, groq, mistral, ollama, veil…)
  -M, --mode <name>   Mode: ask | plan | auto
  -c, --continue      Resume the most recent session
      --link          Link CLI to a running axion-serve web session
      --doctor        Check dependencies, API keys, and environment
      --update        Pull latest from GitHub and rebuild
  -v, --version       Print version and exit
  -h, --help          Show this help

Examples:
  axion
  axion "explain this codebase"
  axion -m fable -M auto "refactor src/agent/tools.js"
  axion --doctor

Shell completions:
  bash  source /path/to/axion/completions/axion.bash
  zsh   fpath=(/path/to/axion/completions $fpath) && autoload -Uz compinit && compinit
`.trim());
  process.exit(0);
}

if (argv.doctor) {
  await runDoctor();
  process.exit(0);
}

if (argv.update) {
  runUpdate();
  process.exit(0);
}

// Positional args become the initial prompt sent on startup
const initialPrompt = argv._.join(' ').trim();

// --continue restores the most recent autosaved session (null if none exists)
const resumeSession = argv['continue'] ? loadLastSession() : null;

const savedModel = getSavedModel();
const savedMode  = getSavedMode();

// Seed API_KEYS from saved config (env vars take priority)
const savedKeys = getSavedApiKeys();
for (const [provider, key] of Object.entries(savedKeys)) {
  if (key && !API_KEYS[provider]) API_KEYS[provider] = key;
}

// Seed named custom endpoints from saved config
const savedEndpoints = getSavedCustomEndpoints();
for (const [name, ep] of Object.entries(savedEndpoints)) {
  if (ep?.baseURL) CUSTOM_ENDPOINTS[name] = ep;
}

// Auto-discover local Ollama models (non-blocking, silent on failure)
try {
  const ollamaRes = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(800) });
  if (ollamaRes.ok) {
    const { models = [] } = await ollamaRes.json();
    for (const m of models) {
      const name = `ollama-${m.name.replace(/[:/]/g, '-')}`;
      if (!CUSTOM_ENDPOINTS[name]) {
        CUSTOM_ENDPOINTS[name] = { baseURL: 'http://localhost:11434/v1', model: m.name, apiKey: 'ollama' };
      }
    }
  }
} catch {}

// Read .axionrc and/or .axion-settings.json from cwd — per-project config overrides.
// .axion-settings.json takes priority over .axionrc when both exist.
let axionrc = {};
try {
  const rcPath = resolve(process.cwd(), '.axionrc');
  if (existsSync(rcPath)) axionrc = JSON.parse(readFileSync(rcPath, 'utf8'));
} catch {}
try {
  const settingsPath = resolve(process.cwd(), '.axion-settings.json');
  if (existsSync(settingsPath)) {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    axionrc = { ...axionrc, ...settings };
  }
} catch {}

const modelArg = argv.model || axionrc.model || savedModel || DEFAULT_MODEL;
const rawMode  = argv.mode  || axionrc.mode  || savedMode || DEFAULT_MODE;
// 'bypass' is the display alias for 'auto'
const modeArg  = rawMode === 'bypass' ? 'auto' : rawMode;

if (!['ask', 'plan', 'auto'].includes(modeArg)) {
  console.error(`Invalid mode: ${rawMode}. Must be: ask, plan, auto (or bypass)`);
  process.exit(1);
}

// Seed image model from saved config
const savedImgModel = getSavedImageModel();
if (savedImgModel) IMAGE_GEN_MODEL.current = savedImgModel;

const stdin = process.stdin;
if (!stdin.isTTY) {
  Object.defineProperty(stdin, 'isTTY', { value: true, writable: true });
  stdin.setRawMode = () => {};
  stdin.ref    = () => {};
  stdin.unref  = () => {};
}

// ── Detect running axion-serve and link if found ──────────────────────────────

const pidFile = join(homedir(), '.axion', 'web-server.pid');
const port    = Number(process.env.AXION_WEB_PORT) || 3000;
const wsUrl   = `ws://localhost:${port}`;

async function serverIsAlive() {
  if (!argv['link']) return false;
  if (!existsSync(pidFile)) return false;
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { ws.terminate(); resolve(false); }, 800);
    ws.on('open',  () => { clearTimeout(timer); ws.close(); resolve(true); });
    ws.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

const linked = await serverIsAlive();

// Init MCP servers and plugins (non-blocking — failures are surfaced via /mcp and /plugin)
await MCP.init();
await PLUGINS.init();

// ── Launch ────────────────────────────────────────────────────────────────────

let component;

if (linked) {
  component = React.createElement(LinkedApp, {
    wsUrl,
    initialModel: modelArg,
    initialMode:  modeArg,
  });
} else {
  // Apply per-project theme before launch
  if (axionrc.theme) {
    const { setTheme } = await import('./ui/theme.js');
    setTheme(axionrc.theme);
  }
  component = React.createElement(App, {
    initialModel:          modelArg,
    initialMode:           modeArg,
    initialSystemOverride: axionrc.systemPrompt || '',
    initialThinking:       axionrc.thinking     || false,
    initialThinkingBudget: axionrc.thinkingBudget || 10000,
    webServerPath:         WEB_SERVER,
    initialPrompt,
    initialResume:         resumeSession,
  });
}

const { waitUntilExit } = render(component, { exitOnCtrlC: true });
waitUntilExit().then(() => process.exit(0));
