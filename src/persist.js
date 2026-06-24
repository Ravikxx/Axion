import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { encryptJSON, decryptJSON } from './utils/crypto.js';

const DIR  = join(homedir(), '.axion');
const FILE = join(DIR, 'config.json');
const SECRET_KEYS = ['apiKeys', 'axionKey', 'discordToken'];

function load() {
  try {
    if (!existsSync(FILE)) return {};
    const raw = JSON.parse(readFileSync(FILE, 'utf8'));
    return decryptJSON(raw, SECRET_KEYS);
  } catch (e) {
    if (existsSync(FILE)) console.error('[persist] Failed to load config:', e?.message || e);
    return {};
  }
}

function save(data) {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    // Merge with latest from disk to avoid clobbering concurrent writes
    const onDisk = load();
    const merged = { ...onDisk, ...data };
    const encrypted = encryptJSON(merged, SECRET_KEYS);
    writeFileSync(FILE, JSON.stringify(encrypted, null, 2), 'utf8');
  } catch (e) {
    console.error('[persist] Failed to save config:', e?.message || e);
  }
}

const _cfg = load();

function currentDirectoryKey() {
  return resolve(process.cwd());
}

export function isTrustedDirectory(dir = process.cwd()) {
  const key = resolve(dir);
  return _cfg.trustedDirectories?.[key] === true;
}

export function trustDirectory(dir = process.cwd()) {
  if (!_cfg.trustedDirectories) _cfg.trustedDirectories = {};
  _cfg.trustedDirectories[resolve(dir)] = true;
  save(_cfg);
}

export function getSavedModel()   { return _cfg.model   || null; }
export function getSavedMode()    { return _cfg.mode    || null; }
export function getSavedApiKeys() { return _cfg.apiKeys || {}; }

// Returns map of name → {baseURL, model, apiKey}, migrating old single-endpoint format
export function getSavedCustomEndpoints() {
  if (_cfg.customEndpoints) return _cfg.customEndpoints;
  if (_cfg.customEndpoint?.baseURL) return { other: _cfg.customEndpoint };
  return {};
}

export function saveModel(model) {
  _cfg.model = model;
  save(_cfg);
}

export function saveMode(mode) {
  _cfg.mode = mode;
  save(_cfg);
}

export function saveApiKey(provider, key) {
  if (!_cfg.apiKeys) _cfg.apiKeys = {};
  _cfg.apiKeys[provider] = key;
  save(_cfg);
}

export function saveCustomEndpoints(map) {
  _cfg.customEndpoints = map;
  delete _cfg.customEndpoint;
  save(_cfg);
}

export function getSavedTheme() { return _cfg.theme || null; }

export function saveTheme(name) {
  _cfg.theme = name;
  save(_cfg);
}

export function getAdviserModel() { return _cfg.adviserModel || null; }

export function saveAdviserModel(model) {
  _cfg.adviserModel = model || null;
  save(_cfg);
}

export function getCompareModels() { return _cfg.compareModels || null; }

export function saveCompareModels(models) {
  _cfg.compareModels = models;
  save(_cfg);
}

export function getSavedVisionModel() { return _cfg.visionModel || null; }

export function saveVisionModel(alias) {
  _cfg.visionModel = alias;
  save(_cfg);
}

export function getSavedImageModel() { return _cfg.imageModel || null; }

export function saveImageModel(alias) {
  _cfg.imageModel = alias;
  save(_cfg);
}

export function getDiscordToken() { return _cfg.discordToken || null; }

export function saveDiscordToken(token) {
  _cfg.discordToken = token;
  save(_cfg);
}

export function getAxionKey() { return _cfg.axionKey || null; }

export function saveAxionKey(key) {
  _cfg.axionKey = key;
  save(_cfg);
}

export function getDiscordAutoStart() { return _cfg.discordAutoStart || false; }

export function saveDiscordAutoStart(val) {
  _cfg.discordAutoStart = val;
  save(_cfg);
}

// ── Donate / dataset contribution ────────────────────────────────────────────

export function getDonateOptOut()      { return _cfg.donateOptOut  || false; }
export function saveDonateOptOut(val)  { _cfg.donateOptOut = val;  save(_cfg); }

// Strip tool calls, tool results, and thinking — return plain chat messages.
export function toTrainingFormat(history) {
  const messages = [];
  for (const turn of (history || [])) {
    if (turn.role !== 'user' && turn.role !== 'assistant') continue;
    let text = '';
    if (typeof turn.content === 'string') {
      text = turn.content.trim();
    } else if (Array.isArray(turn.content)) {
      text = turn.content
        .filter(b => b.type === 'text')
        .map(b => (b.text || '').trim())
        .filter(Boolean)
        .join('\n');
    }
    if (text) messages.push({ role: turn.role, content: text });
  }
  return messages;
}

const DONATIONS_DIR = join(DIR, 'donations');

export function saveDonation(history) {
  if (!existsSync(DONATIONS_DIR)) mkdirSync(DONATIONS_DIR, { recursive: true });
  const ts       = new Date().toISOString().replace(/[:.]/g, '-');
  const file     = join(DONATIONS_DIR, `${ts}.json`);
  const messages = toTrainingFormat(history);
  writeFileSync(file, JSON.stringify({ messages, meta: { donatedAt: new Date().toISOString(), source: 'axion' } }, null, 2), 'utf8');
  return file;
}

// ── Persistent memory ────────────────────────────────────────────────────────

const MEMORY_FILE = join(DIR, 'memory.json');

export function getMemories() {
  try {
    if (!existsSync(MEMORY_FILE)) return [];
    return JSON.parse(readFileSync(MEMORY_FILE, 'utf8'));
  } catch { return []; }
}

export function addMemory(text) {
  const list = getMemories();
  list.push({ text, addedAt: new Date().toISOString() });
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  writeFileSync(MEMORY_FILE, JSON.stringify(list, null, 2), 'utf8');
  return list;
}

export function removeMemory(index) {
  const list = getMemories();
  if (index < 0 || index >= list.length) return false;
  list.splice(index, 1);
  writeFileSync(MEMORY_FILE, JSON.stringify(list, null, 2), 'utf8');
  return true;
}

// ── Undo (file backup stack) ──────────────────────────────────────────────────

const BACKUPS_DIR = join(DIR, 'backups');
const _undoStack  = []; // { originalPath, backupPath }
const MAX_BACKUPS = 20;

export function backupFile(originalPath, content) {
  try {
    if (!existsSync(BACKUPS_DIR)) mkdirSync(BACKUPS_DIR, { recursive: true });
    const ts   = Date.now();
    const name = originalPath.replace(/[^a-zA-Z0-9.-]/g, '_').slice(-60);
    const dest = join(BACKUPS_DIR, `${ts}-${name}`);
    writeFileSync(dest, content, 'utf8');
    _undoStack.push({ originalPath, backupPath: dest });
    // Prune oldest backup if over cap
    if (_undoStack.length > MAX_BACKUPS) {
      const old = _undoStack.shift();
      try { unlinkSync(old.backupPath); } catch {}
    }
  } catch {}
}

export function undoLastBackup() {
  if (!_undoStack.length) return null;
  const { originalPath, backupPath } = _undoStack.pop();
  try {
    const content = readFileSync(backupPath, 'utf8');
    writeFileSync(originalPath, content, 'utf8');
    unlinkSync(backupPath);
    return originalPath;
  } catch (err) {
    return null;
  }
}

export function undoStackSize() { return _undoStack.length; }

// ── Skills (~/.axion/skills/*.md + ./.axion/skills/*.md) ──────────────────────
// Claude-style skill files: YAML-ish frontmatter (name, description, triggers)
// followed by a markdown body. A skill auto-activates for the session when any
// of its trigger words appear in a user message.

const SKILLS_DIR = join(DIR, 'skills');

function parseSkill(raw, fallbackName) {
  const skill = { name: fallbackName, description: '', triggers: [], body: raw.trim() };
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    skill.body = raw.slice(fm[0].length).trim();
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (!m) continue;
      const [, key, val] = m;
      if (key === 'name')        skill.name = val.trim() || fallbackName;
      if (key === 'description') skill.description = val.trim();
      if (key === 'triggers')    skill.triggers = val.split(',').map(s => s.trim()).filter(Boolean);
    }
  }
  if (!skill.triggers.length) skill.triggers = [skill.name];
  return skill;
}

export function getSkills() {
  const out = new Map(); // project-level overrides global
  const dirs = [SKILLS_DIR];
  if (isTrustedDirectory()) dirs.push(join(process.cwd(), '.axion', 'skills'));
  for (const dir of dirs) {
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        try {
          const raw = readFileSync(join(dir, f), 'utf8');
          if (!raw.trim()) continue;
          const skill = parseSkill(raw, f.slice(0, -3).toLowerCase());
          skill.path = join(dir, f);
          out.set(skill.name.toLowerCase(), skill);
        } catch {}
      }
    } catch {}
  }
  return [...out.values()];
}

export function saveSkill(name, content) {
  if (!existsSync(SKILLS_DIR)) mkdirSync(SKILLS_DIR, { recursive: true });
  const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  const path = join(SKILLS_DIR, `${slug}.md`);
  writeFileSync(path, content, 'utf8');
  return path;
}

export function deleteSkill(name) {
  const skill = getSkills().find(s => s.name.toLowerCase() === name.toLowerCase());
  if (!skill) return false;
  try { unlinkSync(skill.path); return true; } catch { return false; }
}

// ── Tool permission allowlist (per project, for ask mode) ─────────────────────
// Keys are tool names, or "run_command:<binary>" for shell commands.

export function getAllowedTools() {
  if (!isTrustedDirectory()) return [];
  return (_cfg.allowedTools || {})[currentDirectoryKey()] || [];
}

export function allowTool(key) {
  if (!isTrustedDirectory()) return;
  if (!_cfg.allowedTools) _cfg.allowedTools = {};
  const projectKey = currentDirectoryKey();
  const list = _cfg.allowedTools[projectKey] || [];
  if (!list.includes(key)) list.push(key);
  _cfg.allowedTools[projectKey] = list;
  save(_cfg);
}

export function clearAllowedTools() {
  if (_cfg.allowedTools) delete _cfg.allowedTools[currentDirectoryKey()];
  save(_cfg);
}

// ── Custom slash commands ─────────────────────────────────────────────────────
// Markdown files in ~/.axion/commands/ and ./.axion/commands/ become slash
// commands: greet.md → /greet. $ARGUMENTS in the body is replaced with args.
// Read fresh on each lookup so edits apply without restarting.

export function getCustomCommands() {
  const out = {};
  const dirs = [join(DIR, 'commands')];
  if (isTrustedDirectory()) dirs.push(join(process.cwd(), '.axion', 'commands'));
  for (const dir of dirs) {
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        try {
          const body = readFileSync(join(dir, f), 'utf8').trim();
          if (body) out[f.slice(0, -3).toLowerCase()] = body;
        } catch {}
      }
    } catch {}
  }
  return out;
}

// ── Checkpoints (per-turn file snapshots for /rewind) ─────────────────────────

const _checkpoints = [];
const MAX_CHECKPOINTS = 20;
let _activeCheckpoint = null;

// Called at the start of each user turn. Empty checkpoints are replaced.
export function beginCheckpoint(label) {
  if (_activeCheckpoint && !_activeCheckpoint.files.size && !_activeCheckpoint.created.size) {
    _checkpoints.pop();
  }
  _activeCheckpoint = { label: String(label || '').slice(0, 60), ts: Date.now(), files: new Map(), created: new Set() };
  _checkpoints.push(_activeCheckpoint);
  if (_checkpoints.length > MAX_CHECKPOINTS) _checkpoints.shift();
}

// Called from tools on every file write/delete. oldContent === null marks a
// newly created file (rewind deletes it instead of restoring content).
export function recordFileChange(path, oldContent) {
  if (!_activeCheckpoint) return;
  if (_activeCheckpoint.files.has(path) || _activeCheckpoint.created.has(path)) return;
  if (oldContent == null) _activeCheckpoint.created.add(path);
  else _activeCheckpoint.files.set(path, oldContent);
}

export function listCheckpoints() {
  return _checkpoints
    .map((c) => ({ label: c.label, ts: c.ts, fileCount: c.files.size + c.created.size }))
    .reverse(); // most recent first
}

// Restore the last `count` checkpoints (most recent first, so earlier
// checkpoints overwrite with progressively older content).
export function rewindCheckpoints(count = 1) {
  const restored = new Set();
  const deleted  = new Set();
  let undone = 0;
  while (undone < count && _checkpoints.length) {
    const c = _checkpoints.pop();
    for (const [path, content] of c.files) {
      try { writeFileSync(path, content, 'utf8'); restored.add(path); } catch {}
    }
    for (const path of c.created) {
      try { unlinkSync(path); deleted.add(path); restored.delete(path); } catch {}
    }
    undone++;
  }
  _activeCheckpoint = null;
  return { undone, restored: [...restored], deleted: [...deleted] };
}

// ── Chat save/resume ──────────────────────────────────────────────────────────

const CHATS_DIR = join(DIR, 'chats');

// Shared serializer — strips tool-call internals and diff arrays so saved
// sessions stay small and JSON-safe. Used by both /save and session autosave.
function serializeChat(name, { model, mode, tokenCount, agentHistory, displayMessages, tab = 'code' }) {
  return {
    name,
    savedAt: new Date().toISOString(),
    model,
    mode,
    tab,
    tokenCount,
    // Strip tool-call internals from history — keep only user/assistant text
    agentHistory: agentHistory
      .map((m) => {
        if (m.role === 'user' && typeof m.content === 'string') return m;
        if (m.role === 'assistant' && typeof m.content === 'string') return m;
        if (m.role === 'user' && Array.isArray(m.content)) {
          // Flatten Anthropic tool results to text summary
          const text = m.content
            .filter((b) => b.type === 'tool_result')
            .map((b) => `[tool result: ${b.content?.slice?.(0, 200) ?? ''}]`)
            .join('\n');
          return text ? { role: 'user', content: text } : null;
        }
        if (m.role === 'assistant' && Array.isArray(m.content)) {
          const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
          return text ? { role: 'assistant', content: text } : null;
        }
        return null;
      })
      .filter(Boolean),
    // Strip diff arrays from display messages (files already written)
    displayMessages: displayMessages.map(({ diff: _d, ...m }) => m),
  };
}

export function saveChat(name, payload) {
  if (!existsSync(CHATS_DIR)) mkdirSync(CHATS_DIR, { recursive: true });
  writeFileSync(join(CHATS_DIR, `${name}.json`), JSON.stringify(serializeChat(name, payload), null, 2), 'utf8');
}

// ── Session autosave (axion --continue) ────────────────────────────────────────
// A single rolling slot, kept outside CHATS_DIR so it never appears in /resume.

const LAST_SESSION_FILE = join(DIR, 'last-session.json');

export function autosaveSession(payload) {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    writeFileSync(LAST_SESSION_FILE, JSON.stringify(serializeChat('__last__', payload), null, 2), 'utf8');
  } catch {}
}

export function loadLastSession() {
  try {
    if (!existsSync(LAST_SESSION_FILE)) return null;
    return JSON.parse(readFileSync(LAST_SESSION_FILE, 'utf8'));
  } catch { return null; }
}

export function clearLastSession() {
  try { if (existsSync(LAST_SESSION_FILE)) unlinkSync(LAST_SESSION_FILE); } catch {}
}

export function loadChat(name) {
  const file = join(CHATS_DIR, `${name}.json`);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

export function deleteChat(name) {
  const file = join(CHATS_DIR, `${name}.json`);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

export function exportSession(filePath, sessionData) {
  const outPath = filePath.endsWith('.axion-session.json') ? filePath : `${filePath}.axion-session.json`;
  writeFileSync(outPath, JSON.stringify({ ...sessionData, __axion: true, exportedAt: new Date().toISOString() }, null, 2), 'utf8');
  return outPath;
}

export function importSession(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!data.__axion) return null;
    return data;
  } catch { return null; }
}

export function exportChat(filename, messages) {
  const lines = [
    `# Axion Chat Export`,
    `*Exported: ${new Date().toLocaleString()}*`,
    '',
  ];
  for (const msg of messages) {
    if (msg.type === 'user') {
      lines.push(`## You\n\n${msg.content}\n`);
    } else if (msg.type === 'assistant') {
      lines.push(`## Axion\n\n${msg.content}\n`);
    } else if (msg.type === 'plan') {
      lines.push(`## Plan\n\n${msg.content}\n`);
    } else if (msg.type === 'info') {
      lines.push(`> ${msg.content}\n`);
    } else if (msg.type === 'tool') {
      lines.push(`> **${msg.name}** ${msg.output ? `→ ${String(msg.output).slice(0, 200)}` : ''}\n`);
    }
  }
  const outPath = join(process.cwd(), filename.endsWith('.md') ? filename : `${filename}.md`);
  writeFileSync(outPath, lines.join('\n'), 'utf8');
  return outPath;
}

// ── Macro save/load ───────────────────────────────────────────────────────────

const MACROS_DIR = join(DIR, 'macros');

export function saveMacro(name, steps) {
  if (!existsSync(MACROS_DIR)) mkdirSync(MACROS_DIR, { recursive: true });
  const data = { name, savedAt: new Date().toISOString(), steps };
  writeFileSync(join(MACROS_DIR, `${name}.json`), JSON.stringify(data, null, 2), 'utf8');
}

export function loadMacro(name) {
  const file = join(MACROS_DIR, `${name}.json`);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')).steps; } catch { return null; }
}

export function listMacros() {
  if (!existsSync(MACROS_DIR)) return [];
  return readdirSync(MACROS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const d = JSON.parse(readFileSync(join(MACROS_DIR, f), 'utf8'));
        return { name: d.name, steps: d.steps?.length ?? 0, savedAt: d.savedAt };
      } catch { return { name: f.slice(0, -5) }; }
    })
    .sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
}

export function deleteMacro(name) {
  const file = join(MACROS_DIR, `${name}.json`);
  if (!existsSync(file)) return false;
  unlinkSync(file); return true;
}

// ── Watch-and-learn (learned preferences) ────────────────────────────────────

const LEARNED_FILE = join(DIR, 'learned.md');

export function getLearnedInstructions() {
  try {
    if (!existsSync(LEARNED_FILE)) return '';
    return readFileSync(LEARNED_FILE, 'utf8').trim();
  } catch { return ''; }
}

export function appendLearnedInstructions(text) {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  const existing = getLearnedInstructions();
  const separator = existing ? '\n\n---\n\n' : '';
  const stamped   = `*Learned ${new Date().toLocaleString()}*\n\n${text.trim()}`;
  writeFileSync(LEARNED_FILE, existing + separator + stamped, 'utf8');
}

export function clearLearnedInstructions() {
  if (existsSync(LEARNED_FILE)) unlinkSync(LEARNED_FILE);
}

// ── Auto-memory (background extraction, replaced each session) ────────────────

const AUTO_MEMORY_FILE = join(DIR, 'auto-memory.md');

export function getAutoMemory() {
  try {
    if (!existsSync(AUTO_MEMORY_FILE)) return '';
    return readFileSync(AUTO_MEMORY_FILE, 'utf8').trim();
  } catch { return ''; }
}

export function saveAutoMemory(text) {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  writeFileSync(AUTO_MEMORY_FILE, text.trim(), 'utf8');
}

export function clearAutoMemory() {
  if (existsSync(AUTO_MEMORY_FILE)) unlinkSync(AUTO_MEMORY_FILE);
}

// ── Profiles (model+mode presets) ──────────────────────────────────────────────

const PROFILES_DIR = join(DIR, 'profiles');

export function listProfiles() {
  try {
    if (!existsSync(PROFILES_DIR)) return [];
    return readdirSync(PROFILES_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
  } catch { return []; }
}

export function saveProfile(name, data) {
  if (!existsSync(PROFILES_DIR)) mkdirSync(PROFILES_DIR, { recursive: true });
  const file = join(PROFILES_DIR, name.replace(/[^a-z0-9_-]/gi, '') + '.json');
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return file;
}

export function loadProfile(name) {
  try {
    const file = join(PROFILES_DIR, name.replace(/[^a-z0-9_-]/gi, '') + '.json');
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch { return null; }
}

export function deleteProfile(name) {
  try {
    const file = join(PROFILES_DIR, name.replace(/[^a-z0-9_-]/gi, '') + '.json');
    if (existsSync(file)) unlinkSync(file);
  } catch {}
}

export function listChats() {
  if (!existsSync(CHATS_DIR)) return [];
  return readdirSync(CHATS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const d = JSON.parse(readFileSync(join(CHATS_DIR, f), 'utf8'));
        return { name: d.name, model: d.model, savedAt: d.savedAt, messages: d.displayMessages?.length ?? 0, tab: d.tab || 'code' };
      } catch {
        return { name: f.slice(0, -5) };
      }
    })
    .sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
}

// ── Input history ─────────────────────────────────────────────────────────────

const INPUT_HISTORY_FILE = join(DIR, 'input-history');
const MAX_INPUT_HISTORY  = 500;

export function loadInputHistory() {
  try {
    if (!existsSync(INPUT_HISTORY_FILE)) return [];
    return readFileSync(INPUT_HISTORY_FILE, 'utf8')
      .split('\n')
      .filter(Boolean);
  } catch { return []; }
}

export function appendInputHistory(entry) {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    const lines = loadInputHistory().filter((l) => l !== entry);
    lines.push(entry);
    const capped = lines.slice(-MAX_INPUT_HISTORY);
    writeFileSync(INPUT_HISTORY_FILE, capped.join('\n') + '\n', 'utf8');
  } catch {}
}

// ── Scheduled tasks ───────────────────────────────────────────────────────────

const SCHEDULES_FILE = join(DIR, 'schedules.json');
const RESULTS_DIR    = join(DIR, 'schedule-results');

export function getSchedules() {
  try {
    if (!existsSync(SCHEDULES_FILE)) return [];
    return JSON.parse(readFileSync(SCHEDULES_FILE, 'utf8'));
  } catch { return []; }
}

export function saveSchedules(list) {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  writeFileSync(SCHEDULES_FILE, JSON.stringify(list, null, 2), 'utf8');
}

export function saveScheduleResult(name, content) {
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const ts   = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(RESULTS_DIR, `${safe}-${ts}.md`);
  writeFileSync(file, content, 'utf8');
  return file;
}

export function getScheduleResults(name) {
  if (!existsSync(RESULTS_DIR)) return [];
  const prefix = name ? name.replace(/[^a-zA-Z0-9_-]/g, '_') : null;
  return readdirSync(RESULTS_DIR)
    .filter(f => f.endsWith('.md') && (!prefix || f.startsWith(prefix + '-')))
    .sort()
    .reverse()
    .map(f => ({ file: join(RESULTS_DIR, f), name: f }));
}

export function searchChats(query) {
  if (!existsSync(CHATS_DIR)) return [];
  const q = query.toLowerCase();
  const hits = [];
  for (const f of readdirSync(CHATS_DIR).filter(f => f.endsWith('.json'))) {
    try {
      const d = JSON.parse(readFileSync(join(CHATS_DIR, f), 'utf8'));
      const matches = (d.displayMessages || [])
        .filter(m => (m.type === 'user' || m.type === 'assistant') &&
                     typeof m.content === 'string' &&
                     m.content.toLowerCase().includes(q))
        .map(m => ({ type: m.type, snippet: m.content.trim().slice(0, 140).replace(/\n+/g, ' ') }));
      if (matches.length) {
        hits.push({ name: d.name, model: d.model || '?', savedAt: d.savedAt, matches });
      }
    } catch {}
  }
  return hits.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
}

// ── TODO / Task list ──────────────────────────────────────────────────────────

const TODOS_FILE = join(DIR, 'todos.json');

export function getTodos() {
  try {
    if (!existsSync(TODOS_FILE)) return [];
    return JSON.parse(readFileSync(TODOS_FILE, 'utf8'));
  } catch (e) {
    console.error('[persist] Failed to load todos:', e?.message || e);
    return [];
  }
}

function saveTodos(list) {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    writeFileSync(TODOS_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {
    console.error('[persist] Failed to save todos:', e?.message || e);
  }
}

export function addTodo(text, { source = 'user' } = {}) {
  const list = getTodos();
  const id = `todo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  list.push({ id, text, done: false, source, createdAt: new Date().toISOString() });
  saveTodos(list);
  return { id, list };
}

export function toggleTodo(id) {
  const list = getTodos();
  const todo = list.find(t => t.id === id);
  if (!todo) return null;
  todo.done = !todo.done;
  saveTodos(list);
  return todo;
}

export function removeTodo(id) {
  const list = getTodos();
  const idx = list.findIndex(t => t.id === id);
  if (idx === -1) return false;
  list.splice(idx, 1);
  saveTodos(list);
  return true;
}
