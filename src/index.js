import minimist from 'minimist';
import { emitKeypressEvents } from 'readline';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import {
  getSavedModel, getSavedMode, getSavedApiKeys, getSavedCustomEndpoints, getSavedImageModel, loadLastSession,
  isTrustedDirectory, trustDirectory,
} from './persist.js';

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

Pipe mode:
  echo "refactor this" | axion          Read input from stdin
  cat file.js | axion -M auto           Pipe file content as prompt
  axion -m claude < prompt.txt          Run with file redirect

Shell completions:
  bash  source /path/to/axion/completions/axion.bash
  zsh   fpath=(/path/to/axion/completions $fpath) && autoload -Uz compinit && compinit
`.trim());
  process.exit(0);
}

if (argv.doctor) {
  const { runDoctor } = await import('./doctor.js');
  await runDoctor();
  process.exit(0);
}

if (argv.update) {
  const { runUpdate } = await import('./update.js');
  runUpdate();
  process.exit(0);
}

async function promptForDirectoryTrust() {
  const cwd = resolve(process.cwd());
  if (isTrustedDirectory(cwd)) return;

  if (!process.stdin.isTTY) {
    console.error(`Axion has not trusted ${cwd}. Run axion in an interactive terminal first to trust this directory.`);
    process.exit(1);
  }

  const options = ['Yes, continue', 'No, quit'];
  let selected = 0;
  let renderedLines = 0;

  function renderPrompt() {
    if (renderedLines) {
      process.stdout.write(`\x1b[${renderedLines}A\x1b[J`);
    }

    const body = `
> You are in ${cwd}

  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of
  prompt injection. Trusting the directory allows project-local config, hooks, and exec policies to load.

${options.map((option, index) => `${index === selected ? '›' : ' '} ${option}`).join('\n')}

  Use ↑/↓ and Enter to select
`;

    process.stdout.write(body);
    renderedLines = body.split('\n').length - 1;
  }

  emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  renderPrompt();

  // Persistent listener + queue so rapid key bursts (e.g. Down+Enter from a PTY)
  // are never dropped between loop iterations.
  const keyQueue = [];
  let keyWaiter = null;
  function onKey(_str, key) {
    if (keyWaiter) {
      const resolve = keyWaiter;
      keyWaiter = null;
      resolve(key);
    } else {
      keyQueue.push(key);
    }
  }
  function nextKey() {
    if (keyQueue.length) return Promise.resolve(keyQueue.shift());
    return new Promise((r) => { keyWaiter = r; });
  }

  process.stdin.on('keypress', onKey);

  try {
    while (true) {
      const key = await nextKey();

      if (key?.ctrl && key?.name === 'c') {
        process.stdout.write('\n');
        process.exit(130);
      }
      if (key?.name === 'up' || key?.name === 'k') {
        selected = selected === 0 ? options.length - 1 : selected - 1;
        renderPrompt();
      } else if (key?.name === 'down' || key?.name === 'j') {
        selected = (selected + 1) % options.length;
        renderPrompt();
      } else if (key?.name === 'return' || key?.name === 'enter') {
        process.stdout.write('\n');
        if (selected === 0) {
          trustDirectory(cwd);
          return;
        }
        process.exit(0);
      }
    }
  } finally {
    process.stdin.off('keypress', onKey);
    process.stdin.setRawMode(Boolean(wasRaw));
  }
}

await promptForDirectoryTrust();

const React = (await import('react')).default;
const { render } = await import('ink');
const { WebSocket } = await import('ws');
const { DEFAULT_MODEL, DEFAULT_MODE, API_KEYS, CUSTOM_ENDPOINTS, IMAGE_GEN_MODEL } = await import('./config.js');
const { App } = await import('./ui/App.jsx');
const { LinkedApp } = await import('./ui/LinkedApp.jsx');
const { MCP } = await import('./agent/mcp.js');
const { PLUGINS } = await import('./agent/plugins.js');

// Positional args become the initial prompt sent on startup
let initialPrompt = argv._.join(' ').trim();

// Pipe mode: when stdin is not a TTY, read piped input and run headlessly
const isPipe = !process.stdin.isTTY;

if (isPipe) {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const pipeInput = Buffer.concat(chunks).toString('utf8').trim();
    if (pipeInput) {
      initialPrompt = initialPrompt
        ? `${initialPrompt}\n\n${pipeInput}`
        : pipeInput;
    }
  } catch {} // swallow pipe errors silently
}

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

// ── Pipe mode: run headlessly and print response to stdout ──────────────────

if (isPipe && initialPrompt) {
  const { Agent } = await import('./agent/agent.js');
  const agent = new Agent({ modelAlias: modelArg, mode: modeArg });
  // Let tool results be approved automatically in pipe mode
  const askConfirm = () => Promise.resolve(true);
  console.error(`\n  ◈ Axion  ·  ${modelArg}  ·  ${modeArg}\n`);
  try {
    const result = await agent.run(initialPrompt, { askConfirm });
    const lastMsg = [...agent.history].reverse().find((m) => m.role === 'assistant');
    if (lastMsg) {
      const text = typeof lastMsg.content === 'string'
        ? lastMsg.content
        : lastMsg.content?.find?.((c) => c.type === 'text')?.text || '';
      process.stdout.write(text + '\n');
    }
  } catch (err) {
    console.error(`\n✖ ${err.message}`);
    process.exit(1);
  }
  process.exit(0);
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
