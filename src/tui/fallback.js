// Compatibility-mode chat: a plain Node readline REPL that reuses the same Agent.
// No Bun / OpenTUI — runs anywhere Node does. The launcher falls back to this when
// Bun or OpenTUI's renderer isn't available, and for non-TTY / piped input.
import readline from 'readline';
import { Agent } from '../agent/agent.js';
import { getSavedModel, getSavedMode, getSavedApiKeys, getSavedCustomEndpoints } from '../persist.js';
import { API_KEYS, CUSTOM_ENDPOINTS, DEFAULT_MODEL, DEFAULT_MODE } from '../config.js';

// Seed runtime config from saved settings (same as the TUI entry).
for (const [p, k] of Object.entries(getSavedApiKeys())) { if (k && !API_KEYS[p]) API_KEYS[p] = k; }
for (const [n, ep] of Object.entries(getSavedCustomEndpoints())) { if (ep?.baseURL) CUSTOM_ENDPOINTS[n] = ep; }

const model = getSavedModel() || DEFAULT_MODEL;
const mode  = getSavedMode()  || DEFAULT_MODE;

const C = { accent: '\x1b[38;5;173m', dim: '\x1b[90m', red: '\x1b[31m', green: '\x1b[32m', reset: '\x1b[0m' };

const agent = new Agent({
  modelAlias: model,
  mode,
  onStreamChunk: (chunk) => process.stdout.write(chunk),
  onMessage: ({ role, content }) => {
    if (role === 'error') process.stdout.write(`\n${C.red}✖ ${content}${C.reset}\n`);
    else if (role === 'thinking') { /* omit verbose thinking in compat mode */ }
    else if (role === 'plan') process.stdout.write(`\n${C.dim}${content}${C.reset}\n`);
  },
  onToolCall: ({ name }) => process.stdout.write(`\n${C.dim}  ⚙ ${name}…${C.reset}`),
  onToolResult: ({ success }) => process.stdout.write(` ${success === false ? C.red + '✖' : C.green + '✔'}${C.reset}\n`),
});

// ── Non-TTY / pipe mode: read all stdin, run once, exit ─────────────────────────
if (!process.stdin.isTTY) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = Buffer.concat(chunks).toString('utf8').trim();
  if (input) {
    await agent.run(input, {
      askConfirm: () => Promise.resolve(true),
      askPlanConfirm: () => Promise.resolve(true),
      askUser: () => Promise.resolve(''),
    }).catch((e) => process.stderr.write(`\n${e?.message || e}\n`));
    process.stdout.write('\n');
  }
  process.exit(0);
}

// ── Interactive readline REPL ───────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

process.stdout.write(
  `${C.accent}✻ Axion${C.reset} ${C.dim}— compatibility mode (OpenTUI unavailable on this system)${C.reset}\n` +
  `${C.dim}model ${model} · mode ${mode} · type a message, /exit to quit${C.reset}\n\n`
);

let running = true;
while (running) {
  const line = (await ask(`${C.accent}you ›${C.reset} `)).trim();
  if (!line) continue;
  if (line === '/exit' || line === '/quit') break;
  process.stdout.write(`\n${C.accent}✻ Axion${C.reset}\n`);
  try {
    await agent.run(line, {
      askConfirm: async (tc) => /^y/i.test(await ask(`${C.dim}  run ${tc.name}? (y/n) ${C.reset}`)),
      askPlanConfirm: async () => /^y/i.test(await ask(`${C.dim}  execute this plan? (y/n) ${C.reset}`)),
      askUser: async (p) => ask(`${C.dim}  ${p?.question || 'answer'}: ${C.reset}`),
    });
  } catch (e) {
    process.stdout.write(`\n${C.red}✖ ${e?.message || e}${C.reset}`);
  }
  process.stdout.write('\n\n');
}
rl.close();
process.exit(0);
