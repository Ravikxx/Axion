// Framework-agnostic keymap engine — adapted from opencode's keymap.tsx to
// Axion's React + useKeyboard model. No UI imports.
//
// Capabilities (minimal port):
//   • Command registration with metadata (name, slashName, category, keybinding)
//   • Slash command auto-discovery via slashName / slashAliases
//   • Leader key with timed timeout (configurable trigger + ms)
//   • Mode stack (push/pop) — context-scoped key bindings without conflicts
//   • Key aliases (esc→escape, enter→return, pgup→pageup, pgdn→pagedown)
//
// `handleKey(keyEvent)` consumes an OpenTUI-style key object
// (`{ name, ctrl, shift, meta, sequence }`) and returns true if a binding
// matched (so the caller can stop the dispatch chain). The engine never
// touches the DOM — the App wires it into useKeyboard and decides what to do
// with unhandled keys.

export const LEADER_TOKEN = 'leader';
export const BASE_MODE = 'base';

const KEY_ALIASES = {
  enter: 'return',
  esc: 'escape',
  pgup: 'pageup',
  pgdown: 'pagedown',
  pgdn: 'pagedown',
};

export function expandKeyAlias(name) {
  if (!name) return name;
  return KEY_ALIASES[name.toLowerCase()] || name;
}

// Canonical key string used for binding lookup, e.g. "ctrl+p", "leader>d".
// Modifiers sorted ctrl → alt → shift for stable comparisons.
export function formatKeyStroke(key) {
  const name = expandKeyAlias((key.name || key.sequence || '').toLowerCase());
  const mods = [];
  if (key.ctrl) mods.push('ctrl');
  if (key.alt || key.meta) mods.push('alt');
  if (key.shift) mods.push('shift');
  const stroke = mods.length ? `${mods.join('+')}+${name}` : name;
  return stroke;
}

function normalizeBinding(binding) {
  if (!binding) return null;
  return String(binding).toLowerCase();
}

export function createKeymap({ leader = null, leaderTimeoutMs = 750 } = {}) {
  const commands = new Map();           // name → command
  const bindingsByMode = new Map();     // mode → Map<stroke, commandName>
  let modeStack = [{ id: Symbol('base'), mode: BASE_MODE }];
  let disposed = false;

  // Leader sequence state
  let leaderTrigger = normalizeBinding(leader);
  let leaderActive = false;
  let leaderTimer = null;

  function bindingsFor(mode) {
    let m = bindingsByMode.get(mode);
    if (!m) { m = new Map(); bindingsByMode.set(mode, m); }
    return m;
  }

  function currentMode() {
    return modeStack.at(-1)?.mode ?? BASE_MODE;
  }

  function pushMode(mode) {
    if (disposed) return () => {};
    const id = Symbol(mode);
    let active = true;
    modeStack.push({ id, mode });
    return () => {
      if (!active) return;
      active = false;
      const idx = modeStack.findIndex((s) => s.id === id);
      if (idx !== -1) modeStack.splice(idx, 1);
    };
  }

  function clearLeader() {
    leaderActive = false;
    if (leaderTimer) { clearTimeout(leaderTimer); leaderTimer = null; }
  }

  function armLeader() {
    leaderActive = true;
    if (leaderTimer) clearTimeout(leaderTimer);
    leaderTimer = setTimeout(() => { leaderActive = false; leaderTimer = null; }, leaderTimeoutMs);
  }

  function registerCommand(cmd) {
    if (!cmd || !cmd.name) throw new Error('registerCommand: name required');
    commands.set(cmd.name, cmd);
    // Bind the command under every mode-less binding it declares.
    if (cmd.keybinding) {
      const map = bindingsFor(BASE_MODE);
      map.set(normalizeBinding(cmd.keybinding), cmd.name);
      if (Array.isArray(cmd.keybindings)) {
        for (const b of cmd.keybindings) map.set(normalizeBinding(b), cmd.name);
      }
    }
    // Optional per-mode bindings: { mode: 'dialog', keybinding: 'ctrl+d' }
    if (Array.isArray(cmd.modeBindings)) {
      for (const mb of cmd.modeBindings) {
        if (!mb?.mode || !mb.keybinding) continue;
        bindingsFor(mb.mode).set(normalizeBinding(mb.keybinding), cmd.name);
      }
    }
    return () => unregisterCommand(cmd.name);
  }

  function unregisterCommand(name) {
    if (!commands.has(name)) return;
    commands.delete(name);
    for (const map of bindingsByMode.values()) {
      for (const [stroke, commandName] of map) {
        if (commandName === name) map.delete(stroke);
      }
    }
  }

  function dispatch(name, ...args) {
    const cmd = commands.get(name);
    if (!cmd) return false;
    if (typeof cmd.onSelect === 'function') cmd.onSelect(...args);
    return true;
  }

  // Resolve a stroke for the active mode (falls back to base).
  function resolve(stroke) {
    const m = bindingsByMode.get(currentMode());
    if (m?.has(stroke)) return m.get(stroke);
    return bindingsByMode.get(BASE_MODE)?.get(stroke);
  }

  // Consume a useKeyboard key event. Returns true if a binding matched (and
  // was dispatched); false otherwise. Leader key handling:
  //   1. If the trigger fires, arm the leader and swallow the key.
  //   2. While armed, the next key is treated as the leader-completion stroke
  //      ("leader+<key>") and looked up; if no binding matches, swallow it
  //      anyway (matches Vim's pending-sequence semantics) so stray keys don't
  //      leak into the input.
  function handleKey(key) {
    if (disposed) return false;
    const stroke = formatKeyStroke(key);
    const trig = leaderTrigger;

    if (leaderActive) {
      clearLeader();
      const fullName = `${LEADER_TOKEN}+${stroke}`;
      const commandName = resolve(fullName);
      if (commandName) { dispatch(commandName, key); return true; }
      // fallback: treat as a bare stroke against the active mode
      const bare = resolve(stroke);
      if (bare) { dispatch(bare, key); return true; }
      // No leader+<key> binding registered — don't swallow the key (avoids
      // surprising input loss when the leader trigger is hit by habit).
      return false;
    }

    if (trig && stroke === trig) {
      armLeader();
      return true;
    }

    const commandName = resolve(stroke);
    if (commandName) { dispatch(commandName, key); return true; }
    return false;
  }

  function getCommands() {
    return [...commands.values()];
  }

  function getCommand(name) {
    return commands.get(name);
  }

  // Auto-discover slash commands for the palette / Suggestions list.
  function getSlashCommands() {
    const out = [];
    for (const cmd of commands.values()) {
      const slashName = cmd.slashName;
      if (typeof slashName !== 'string' || !slashName) continue;
      const entry = {
        display: `/${slashName}`,
        description: cmd.description,
        category: cmd.category,
        name: cmd.name,
        aliases: Array.isArray(cmd.slashAliases)
          ? cmd.slashAliases.filter((a) => typeof a === 'string').map((a) => `/${a}`)
          : [],
      };
      out.push(entry);
    }
    return out;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearLeader();
    modeStack.length = 0;
    commands.clear();
    bindingsByMode.clear();
  }

  return {
    handleKey,
    registerCommand,
    unregisterCommand,
    dispatch,
    getCommands,
    getCommand,
    getSlashCommands,
    currentMode,
    pushMode,
    clearLeader,
    isLeaderActive: () => leaderActive,
    setLeader: (trigger, timeoutMs) => {
      leaderTrigger = normalizeBinding(trigger);
      if (typeof timeoutMs === 'number' && timeoutMs > 0) leaderTimeoutMs = timeoutMs;
      clearLeader();
    },
    dispose,
  };
}

// Fuzzy-rank a list of commands by query against name/description/category.
// Lightweight scorer (no deps) — sufficient for the palette.
export function fuzzyRankCommands(commands, query) {
  const q = (query || '').toLowerCase().trim();
  if (!q) return commands;
  const scored = [];
  for (const c of commands) {
    const name = (c.slashName || c.name || '').toLowerCase();
    const desc = (c.description || '').toLowerCase();
    const cat = (c.category || '').toLowerCase();
    let score = -1;
    if (name === q) score = 200;
    else if (name.startsWith(q)) score = 100 + (10 - Math.min(name.length - q.length, 10));
    else {
      const ni = name.indexOf(q);
      if (ni > 0) score = 60 - ni;
      else if (desc.includes(q)) score = 30;
      else if (cat.includes(q)) score = 10;
    }
    if (score >= 0) scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.c);
}