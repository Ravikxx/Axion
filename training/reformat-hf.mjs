// Reformat public HF datasets into the same JSONL schema as gen-trajectories.mjs,
// streamed via the free datasets-server API (no auth, no python, no downloads).
//
// Usage:
//   node training/reformat-hf.mjs --source swe-smith --n 500 [--offset 0] [--max-chars 120000]
//
// Sources:
//   swe-smith  — SWE-bench/SWE-smith-trajectories: real resolved agentic bug-fix
//                trajectories (OpenAI tool_calls format, SWE-agent tools)
//   hermes     — NousResearch/hermes-function-calling-v1: tool/function calling
//   tulu       — allenai/tulu-3-sft-mixture: general chat (anti-forgetting)
//   magicoder  — ise-uiuc/Magicoder-OSS-Instruct-75K: code instruct
//
// Every record: { id, task, source, messages, tools } — identical shape to the
// Axion-native trajectories, so the packer can treat all slices uniformly.
// tulu/magicoder samples get Axion's real system prompt + tool list so Lumen
// learns "tools are available but plain answers are fine"; swe-smith/hermes
// keep their native tool schemas (schema diversity aids generalization).

import { readFileSync, mkdirSync, appendFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const HERE = dirname(fileURLToPath(import.meta.url));

// ── Canonical Axion system prompt + tools (sandboxed home, neutral cwd) ──────
const REAL_HOME = process.env.USERPROFILE || process.env.HOME;
{
  const envFile = join(REAL_HOME, '.axion', '.env');
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+_API_KEY)=(\S+)/);
      if (m) process.env[m[1]] = m[2];
    }
  }
}
const SANDBOX_HOME = join(tmpdir(), 'axion-training', 'sandbox-home');
mkdirSync(join(SANDBOX_HOME, '.axion'), { recursive: true });
process.env.USERPROFILE = SANDBOX_HOME;
process.env.HOME = SANDBOX_HOME;

const { Agent } = await import('../src/agent/agent.js');
const { setCwd } = await import('../src/agent/tools.js');

const NEUTRAL_CWD = join(tmpdir(), 'axion-training', 'neutral');
mkdirSync(NEUTRAL_CWD, { recursive: true });
setCwd('reformat', NEUTRAL_CWD);
const probe = new Agent({
  modelAlias: 'big-pickle', mode: 'ask', label: 'reformat',
  onToolCall: () => {}, onToolResult: () => {}, onMessage: () => {},
  onTokens: () => {}, onStreamChunk: () => {}, onStreamEnd: () => {}, onNotify: () => {},
});
const AXION_SYSTEM = probe._getSystemPrompt();
const AXION_TOOLS  = probe._getToolListOpenAI();

// ── SWE-agent tool schemas (not shipped in the dataset; reconstructed) ───────
const SWE_AGENT_TOOLS = [
  { type: 'function', function: {
    name: 'bash',
    description: 'Run a bash command in the repository environment and return its output.',
    parameters: { type: 'object', properties: { command: { type: 'string', description: 'The bash command to execute.' } }, required: ['command'] },
  } },
  { type: 'function', function: {
    name: 'str_replace_editor',
    description: 'View, create, and edit files. Commands: view (show file or directory), create (write a new file), str_replace (replace an exact string once), insert (insert text after a line), undo_edit.',
    parameters: { type: 'object', properties: {
      command: { type: 'string', enum: ['view', 'create', 'str_replace', 'insert', 'undo_edit'] },
      path: { type: 'string' },
      file_text: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' },
      insert_line: { type: 'integer' }, view_range: { type: 'array', items: { type: 'integer' } },
    }, required: ['command', 'path'] },
  } },
  { type: 'function', function: {
    name: 'submit',
    description: 'Signal that the task is complete and submit the current state of the repository as the solution.',
    parameters: { type: 'object', properties: {} },
  } },
];

// ── datasets-server client ────────────────────────────────────────────────────
async function fetchRows(dataset, config, split, offset, length) {
  const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(dataset)}&config=${config}&split=${split}&offset=${offset}&length=${length}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (res.status === 429) { await new Promise(r => setTimeout(r, 3000 * attempt)); continue; }
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      return json.rows.map((r) => r.row);
    } catch (e) {
      if (attempt === 4) throw e;
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
}

// Flatten OpenAI content blocks (or anything odd) to a plain string.
const flat = (c) => {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('');
  return c == null ? '' : String(c);
};

// ── Source converters: row → record | null (null = skip) ─────────────────────
const SOURCES = {
  'swe-smith': {
    dataset: 'SWE-bench/SWE-smith-trajectories', config: 'default', split: 'tool',
    convert(row, i) {
      if (row.resolved !== true) return null;
      let raw;
      try { raw = JSON.parse(row.messages); } catch { return null; }
      const messages = [];
      for (const m of raw) {
        if (m.role === 'system') {
          messages.push({ role: 'system', content: flat(m.content) });
        } else if (m.role === 'user') {
          messages.push({ role: 'user', content: flat(m.content) });
        } else if (m.role === 'assistant') {
          const out = { role: 'assistant', content: flat(m.content) || null };
          if (m.tool_calls?.length) {
            out.tool_calls = m.tool_calls.map((tc) => ({
              id: tc.id, type: 'function',
              function: { name: tc.function.name, arguments: tc.function.arguments },
            }));
          }
          messages.push(out);
        } else if (m.role === 'tool') {
          const ids = m.tool_call_ids?.length ? m.tool_call_ids : [m.tool_call_id].filter(Boolean);
          for (const id of ids.length ? ids : ['unknown']) {
            messages.push({ role: 'tool', tool_call_id: id, content: flat(m.content) });
          }
        }
      }
      if (!messages.some((m) => m.tool_calls)) return null;
      return { id: `swe-smith-${row.instance_id || i}`, task: 'swe-agentic', source: 'SWE-bench/SWE-smith-trajectories', messages, tools: SWE_AGENT_TOOLS };
    },
  },

  hermes: {
    dataset: 'NousResearch/hermes-function-calling-v1', config: 'func_calling', split: 'train',
    convert(row, i) {
      let tools;
      try { tools = JSON.parse(row.tools); } catch { return null; }
      if (!Array.isArray(tools) || !tools.length) return null;
      const messages = [];
      let callSeq = 0;
      let lastCallIds = [];
      for (const m of row.conversations || []) {
        const text = flat(m.value);
        if (m.from === 'system') {
          messages.push({ role: 'system', content: text });
        } else if (m.from === 'human') {
          messages.push({ role: 'user', content: text });
        } else if (m.from === 'gpt') {
          // Parse <tool_call>{json}</tool_call> blocks into structured calls.
          const calls = [];
          const clean = text.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (_, body) => {
            try {
              const j = JSON.parse(body);
              calls.push({
                id: `call_${i}_${callSeq++}`, type: 'function',
                function: { name: j.name, arguments: JSON.stringify(j.arguments ?? {}) },
              });
            } catch {}
            return '';
          }).trim();
          const out = { role: 'assistant', content: clean || null };
          if (calls.length) { out.tool_calls = calls; lastCallIds = calls.map((c) => c.id); }
          messages.push(out);
        } else if (m.from === 'tool') {
          const bodies = [...text.matchAll(/<tool_response>\s*([\s\S]*?)\s*<\/tool_response>/g)].map((m2) => m2[1]);
          const contents = bodies.length ? bodies : [text];
          contents.forEach((c, k) => {
            messages.push({ role: 'tool', tool_call_id: lastCallIds[k] || lastCallIds[0] || `call_${i}_x`, content: c });
          });
        }
      }
      if (!messages.some((m) => m.tool_calls)) return null;
      return { id: `hermes-${row.id || i}`, task: 'tool-calling', source: 'NousResearch/hermes-function-calling-v1', messages, tools };
    },
  },

  tulu: {
    dataset: 'allenai/tulu-3-sft-mixture', config: 'default', split: 'train',
    convert(row, i) {
      const msgs = row.messages || [];
      if (!msgs.length || msgs.some((m) => m.role === 'system')) return null; // keep it simple: Axion system only
      if (!msgs.every((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')) return null;
      return {
        id: `tulu-${row.id || i}`, task: 'general', source: `tulu-3/${row.source || 'unknown'}`,
        messages: [{ role: 'system', content: AXION_SYSTEM }, ...msgs],
        tools: AXION_TOOLS,
      };
    },
  },

  magicoder: {
    dataset: 'ise-uiuc/Magicoder-OSS-Instruct-75K', config: 'default', split: 'train',
    convert(row, i) {
      if (!row.problem || !row.solution) return null;
      return {
        id: `magicoder-${row.index ?? i}`, task: 'code-instruct', source: 'ise-uiuc/Magicoder-OSS-Instruct-75K',
        messages: [
          { role: 'system', content: AXION_SYSTEM },
          { role: 'user', content: row.problem },
          { role: 'assistant', content: row.solution },
        ],
        tools: AXION_TOOLS,
      };
    },
  },
};

// ── Main ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] != null ? argv[i + 1] : dflt;
};
const sourceName = arg('source', null);
const N          = Number(arg('n', 100));
let   offset     = Number(arg('offset', 0));
const MAX_CHARS  = Number(arg('max-chars', 120_000));

const src = SOURCES[sourceName];
if (!src) {
  console.error(`Unknown --source "${sourceName}". Valid: ${Object.keys(SOURCES).join(', ')}`);
  process.exit(1);
}

const DATA_DIR = join(HERE, 'data');
mkdirSync(DATA_DIR, { recursive: true });
const OUT = join(DATA_DIR, `${sourceName}.jsonl`);

console.log(`Reformatting ${src.dataset} -> ${OUT} (want ${N}, from offset ${offset}, max ${MAX_CHARS} chars)`);
let kept = 0, seen = 0, tooBig = 0, skipped = 0;
const PAGE = 100;

while (kept < N) {
  let rows;
  try { rows = await fetchRows(src.dataset, src.config, src.split, offset, PAGE); }
  catch (e) { console.error(`fetch failed at offset ${offset}: ${e.message}`); break; }
  if (!rows.length) { console.log('dataset exhausted'); break; }

  for (const row of rows) {
    seen++;
    if (kept >= N) break;
    let rec;
    try { rec = src.convert(row, offset + seen); } catch { rec = null; }
    if (!rec) { skipped++; continue; }
    const line = JSON.stringify(rec);
    if (line.length > MAX_CHARS) { tooBig++; continue; }
    appendFileSync(OUT, line + '\n');
    kept++;
  }
  offset += PAGE;
  if (kept % 100 < PAGE && kept > 0) console.log(`  kept ${kept}/${N} (seen ${seen}, skipped ${skipped}, oversize ${tooBig})`);
}

console.log(`Done: kept ${kept}, seen ${seen}, skipped ${skipped} (filtered/unparseable), oversize ${tooBig}`);
console.log(`Resume from --offset ${offset} for more.`);
// Let in-flight sockets settle before exiting — process.exit() during undici
// teardown trips a libuv assertion on Windows (exit code 9).
await new Promise((r) => setTimeout(r, 250));
process.exit(0);
