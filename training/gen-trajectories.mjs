// Generate Axion-native SFT trajectories for Lumen.
//
// Runs a teacher model (default: big-pickle, free) through Axion's REAL Agent
// class on scripted tasks in throwaway workspaces, verifies each outcome, and
// writes the exact OpenAI-format message history (system prompt + tool schema
// + tool calls + tool results) that Lumen will see at inference time.
//
// Usage:
//   node training/gen-trajectories.mjs --n 50 [--model big-pickle] [--concurrency 2] [--timeout 240] [--seed 0]
//
// Output:
//   training/data/trajectories.jsonl  — verified-successful samples (training data)
//   training/data/failures.jsonl      — failed/unverified samples (inspection only)

import { readFileSync, writeFileSync, mkdirSync, rmSync, appendFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const HERE = dirname(fileURLToPath(import.meta.url));

// ── Bootstrap: sandbox the home directory BEFORE importing Axion modules ─────
// persist.js/config.js resolve ~/.axion at import time. A sandboxed home keeps
// the user's memories, learned preferences, and session notes OUT of the
// system prompt — training data must be canonical, not personal.
const REAL_HOME = process.env.USERPROFILE || process.env.HOME;
{
  const envFile = join(REAL_HOME, '.axion', '.env');
  if (existsSync(envFile)) {
    // Carry over API keys only.
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+_API_KEY)=(\S+)/);
      if (m) process.env[m[1]] = m[2];
    }
  }
}
// Sandbox home + workspaces live in the OS temp dir: outside the repo (so
// workspace files don't inherit axion's "type":"module" package.json and
// don't churn OneDrive sync) and outside version control by construction.
const SANDBOX_HOME = join(tmpdir(), 'axion-training', 'sandbox-home');
mkdirSync(join(SANDBOX_HOME, '.axion'), { recursive: true });
process.env.USERPROFILE = SANDBOX_HOME;
process.env.HOME = SANDBOX_HOME;
// The sandbox home has no .gitconfig — give agent-driven commits a fixed
// identity so git tasks don't depend on the model recovering from
// "Author identity unknown".
process.env.GIT_AUTHOR_NAME = 'axion-gen';
process.env.GIT_AUTHOR_EMAIL = 'gen@axionlabs.local';
process.env.GIT_COMMITTER_NAME = 'axion-gen';
process.env.GIT_COMMITTER_EMAIL = 'gen@axionlabs.local';

const { Agent } = await import('../src/agent/agent.js');
const { setCwd } = await import('../src/agent/tools.js');
const { TASKS, makeRng } = await import('./tasks.mjs');

// ── Args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] != null ? argv[i + 1] : dflt;
};
const N           = Number(arg('n', 20));
const MODEL       = arg('model', 'big-pickle');
const CONCURRENCY = Number(arg('concurrency', 2));
const TIMEOUT_S   = Number(arg('timeout', 240));
const SEED_BASE   = Number(arg('seed', 0));

const DATA_DIR = join(HERE, 'data');
const WORK_DIR = join(tmpdir(), 'axion-training', 'workspaces');
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(WORK_DIR, { recursive: true });
const OK_FILE   = join(DATA_DIR, 'trajectories.jsonl');
const FAIL_FILE = join(DATA_DIR, 'failures.jsonl');

// ── One sample ────────────────────────────────────────────────────────────────
async function runSample(i) {
  const template = TASKS[i % TASKS.length];
  const rng  = makeRng(SEED_BASE + i * 7919 + 13);
  const task = template.gen(rng);
  const label = `traj-${SEED_BASE + i}`;
  const dir = join(WORK_DIR, `${template.id}-${SEED_BASE + i}`);

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // Every workspace is a standalone CommonJS package so task files resolve
  // predictably no matter where the workspace lives.
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'workspace', version: '1.0.0', type: 'commonjs' }, null, 2));
  task.setup(dir);
  setCwd(label, dir); // tools resolve paths per agent label — no global chdir

  let finalText = '';
  const agent = new Agent({
    modelAlias: MODEL,
    mode: 'auto',            // unattended: auto-approve tool calls in the sandbox
    label,
    todoScope: label,
    onToolCall:    () => {},
    onToolResult:  () => {},
    onMessage:     (m) => { if (m.role === 'assistant' && typeof m.content === 'string') finalText = m.content; },
    onTokens:      () => {},
    onStreamChunk: () => {},
    onStreamEnd:   () => {},
    onNotify:      () => {},
  });

  const timer = setTimeout(() => agent.cancel(), TIMEOUT_S * 1000);
  let runError = null;
  try {
    await agent.run(task.prompt, {
      askConfirm:     async () => true,
      askPlanConfirm: async () => true,
      askUser:        async () => '',
    });
  } catch (e) {
    runError = e?.message || String(e);
  } finally {
    clearTimeout(timer);
  }

  let success = false;
  if (!runError && !agent.cancelled) {
    try { success = !!task.verify(dir, { finalText }); } catch { success = false; }
  }

  // Serialize exactly what an inference request will look like.
  const record = {
    id: `${template.id}-${SEED_BASE + i}`,
    task: template.id,
    model: MODEL,
    success,
    error: runError,
    timed_out: agent.cancelled,
    tokens: { input: agent.inputTokens, output: agent.outputTokens },
    messages: [
      { role: 'system', content: agent._getSystemPrompt() },
      ...agent._historyToOpenAI(),
    ],
    tools: agent._getToolListOpenAI(),
  };
  // Normalize the throwaway workspace path (which embeds the local username)
  // to a neutral project path so the model can't memorize a fixed prefix.
  // Paths appear at two JSON escape depths: once in plain string fields
  // (system prompt, tool results) and double-escaped inside
  // tool_calls[].function.arguments, which is a JSON string within JSON.
  const esc = (s) => JSON.stringify(s).slice(1, -1);
  let line = JSON.stringify(record);
  for (const [from, to] of [
    [dir, 'C:\\projects\\app'],
    [dir.replace(/\\/g, '/'), 'C:/projects/app'],
    [SANDBOX_HOME, 'C:\\Users\\dev'],
  ]) {
    line = line.split(esc(esc(from))).join(esc(esc(to)));
    line = line.split(esc(from)).join(esc(to));
  }
  appendFileSync(success ? OK_FILE : FAIL_FILE, line + '\n');

  if (success) rmSync(dir, { recursive: true, force: true }); // keep failed workspaces for debugging
  return { id: record.id, success, turns: record.messages.filter((m) => m.role === 'assistant').length, error: runError };
}

// ── Pool ──────────────────────────────────────────────────────────────────────
console.log(`Generating ${N} trajectories with ${MODEL} (concurrency ${CONCURRENCY}, timeout ${TIMEOUT_S}s, seed ${SEED_BASE})`);
let next = 0, ok = 0, fail = 0;
const perTask = {};

async function worker() {
  while (next < N) {
    const i = next++;
    const started = Date.now();
    try {
      const r = await runSample(i);
      const secs = ((Date.now() - started) / 1000).toFixed(0);
      perTask[r.id.replace(/-\d+$/, '')] = (perTask[r.id.replace(/-\d+$/, '')] || 0) + (r.success ? 1 : 0);
      if (r.success) { ok++; console.log(`  [${i + 1}/${N}] PASS ${r.id} (${r.turns} turns, ${secs}s)`); }
      else { fail++; console.log(`  [${i + 1}/${N}] FAIL ${r.id} (${secs}s)${r.error ? ` — ${r.error.slice(0, 100)}` : ''}`); }
    } catch (e) {
      fail++;
      console.log(`  [${i + 1}/${N}] ERROR sample ${i}: ${(e?.message || e).toString().slice(0, 150)}`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, N) }, worker));

console.log(`\nDone: ${ok} passed, ${fail} failed (${Math.round((ok / N) * 100)}% yield)`);
console.log(`Per-template passes: ${JSON.stringify(perTask)}`);
console.log(`Training data -> ${OK_FILE}`);
console.log(`Failures      -> ${FAIL_FILE} (workspaces kept in ${WORK_DIR} for debugging)`);
