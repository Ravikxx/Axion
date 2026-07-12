import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeymap, expandKeyAlias, formatKeyStroke, fuzzyRankCommands, LEADER_TOKEN, BASE_MODE } from '../src/tui/keymap.js';
import { buildCommandCatalog, COMMANDS, getSuggestions } from '../src/ui/commands.js';

// key event helper — mirrors the object OpenTUI's useKeyboard emits.
function k(name, mods = {}) {
  return { name, sequence: name.length === 1 ? name : '', ctrl: !!mods.ctrl, shift: !!mods.shift, alt: !!mods.alt, meta: !!mods.meta };
}

test('expandKeyAlias maps common aliases and is a no-op for unknown keys', () => {
  assert.equal(expandKeyAlias('esc'), 'escape');
  assert.equal(expandKeyAlias('ESC'), 'escape');
  assert.equal(expandKeyAlias('enter'), 'return');
  assert.equal(expandKeyAlias('pgup'), 'pageup');
  assert.equal(expandKeyAlias('pgdown'), 'pagedown');
  assert.equal(expandKeyAlias('pgdn'), 'pagedown');
  assert.equal(expandKeyAlias('a'), 'a');
  assert.equal(expandKeyAlias(undefined), undefined);
});

test('formatKeyStroke builds canonical ctrl/alt/shift strokes with alias expansion', () => {
  assert.equal(formatKeyStroke(k('p', { ctrl: true })), 'ctrl+p');
  assert.equal(formatKeyStroke(k('p', { ctrl: true, shift: true })), 'ctrl+shift+p');
  assert.equal(formatKeyStroke(k('esc')), 'escape');
  assert.equal(formatKeyStroke(k('p', { shift: true })), 'shift+p');
  assert.equal(formatKeyStroke(k('p')), 'p');
});

test('registerCommand + dispatch fires onSelect and returns true', () => {
  const km = createKeymap();
  let fired = 0;
  km.registerCommand({ name: 'cmd.a', onSelect: () => fired++ });
  assert.equal(km.dispatch('cmd.a'), true);
  assert.equal(fired, 1);
  assert.equal(km.dispatch('missing'), false);
  km.dispose();
});

test('a ctrl+shift+p binding is matched via handleKey and dispatched', () => {
  const km = createKeymap();
  let opened = 0;
  km.registerCommand({ name: 'palette.show', keybinding: 'ctrl+shift+p', onSelect: () => opened++ });
  assert.equal(km.handleKey(k('p', { ctrl: true, shift: true })), true);
  assert.equal(opened, 1);
  // an unbound combo is not swallowed
  assert.equal(km.handleKey(k('x', { ctrl: true })), false);
  km.dispose();
});

test('mode stack scopes bindings — push/pop changes which binding fires', () => {
  const km = createKeymap();
  const calls = [];
  km.registerCommand({ name: 'save', keybinding: 'ctrl+s', onSelect: () => calls.push('base-save') });
  km.registerCommand({ name: 'dialog-save', modeBindings: [{ mode: 'dialog', keybinding: 'ctrl+s' }], onSelect: () => calls.push('dialog-save') });
  assert.equal(km.currentMode(), BASE_MODE);
  assert.equal(km.handleKey(k('s', { ctrl: true })), true);
  const pop = km.pushMode('dialog');
  assert.equal(km.currentMode(), 'dialog');
  assert.equal(km.handleKey(k('s', { ctrl: true })), true);
  pop();
  assert.equal(km.currentMode(), BASE_MODE);
  assert.equal(km.handleKey(k('s', { ctrl: true })), true);
  assert.deepEqual(calls, ['base-save', 'dialog-save', 'base-save']);
  km.dispose();
});

test('leader key arms on trigger then resolves leader+<next> binding', () => {
  const km = createKeymap({ leader: 'ctrl+k', leaderTimeoutMs: 1000 });
  const calls = [];
  km.registerCommand({ name: 'leader-d', modeBindings: [{ mode: BASE_MODE, keybinding: `${LEADER_TOKEN}+d` }], onSelect: () => calls.push('leader-d') });
  assert.equal(km.isLeaderActive(), false);
  // first press: arms the leader, swallows the key
  assert.equal(km.handleKey(k('k', { ctrl: true })), true);
  assert.equal(km.isLeaderActive(), true);
  // second press: completes the sequence
  assert.equal(km.handleKey(k('d')), true);
  assert.deepEqual(calls, ['leader-d']);
  km.dispose();
});

test('leader completion with no registered leader+<key> binding falls through (does not swallow)', () => {
  const km = createKeymap({ leader: 'ctrl+k', leaderTimeoutMs: 1000 });
  assert.equal(km.handleKey(k('k', { ctrl: true })), true); // armed
  // no leader+x binding → must NOT swallow the key
  assert.equal(km.handleKey(k('x')), false);
  assert.equal(km.isLeaderActive(), false); // leader cleared after completion attempt
  km.dispose();
});

test('clearLeader resets a pending leader sequence', () => {
  const km = createKeymap({ leader: 'ctrl+k', leaderTimeoutMs: 10_000 });
  km.handleKey(k('k', { ctrl: true })); // arm
  assert.equal(km.isLeaderActive(), true);
  km.clearLeader();
  assert.equal(km.isLeaderActive(), false);
  km.dispose();
});

test('unregisterCommand removes its bindings', () => {
  const km = createKeymap();
  let n = 0;
  const off = km.registerCommand({ name: 'c', keybinding: 'ctrl+l', onSelect: () => n++ });
  assert.equal(km.handleKey(k('l', { ctrl: true })), true);
  off();
  assert.equal(km.handleKey(k('l', { ctrl: true })), false);
  assert.equal(n, 1);
  km.dispose();
});

test('getSlashCommands surfaces commands with a slashName + aliases', () => {
  const km = createKeymap();
  km.registerCommand({ name: 'diff', slashName: 'diff', slashAliases: ['d'], description: 'show diff', category: 'Files', onSelect: () => {} });
  const slashes = km.getSlashCommands();
  assert.equal(slashes.length, 1);
  assert.deepEqual(slashes[0], { display: '/diff', description: 'show diff', category: 'Files', name: 'diff', aliases: ['/d'] });
  km.dispose();
});

test('fuzzyRankCommands scores name-prefix hits highest, then mid-name, then description', () => {
  const cmds = [
    { name: 'model', slashName: 'model', description: 'switch model' },
    { name: 'mode', slashName: 'mode', description: 'change mode' },
    { name: 'sessions', slashName: 'sessions', description: 'list saved chats' },
  ];
  const ranked = fuzzyRankCommands(cmds, 'mode');
  assert.equal(ranked[0].name, 'mode');      // exact prefix
  assert.equal(ranked[1].name, 'model');    // prefix "mode" of "model"
  // empty query returns the original ordering untouched
  assert.equal(fuzzyRankCommands(cmds, '').length, cmds.length);
});

test('buildCommandCatalog merges built-ins with custom registry and tags categories', () => {
  const cat = buildCommandCatalog({ customRegistry: { mycmd: { description: 'a custom one' } } });
  const names = cat.map((c) => c.name);
  assert.ok(names.includes('help'));
  assert.ok(names.includes('mycmd'));
  const custom = cat.find((c) => c.name === 'mycmd');
  assert.equal(custom.source, 'custom');
  assert.equal(custom.category, 'Custom');
  assert.equal(custom.slashName, 'mycmd');
  const builtin = cat.find((c) => c.name === 'help');
  assert.equal(builtin.source, 'builtin');
  assert.equal(builtin.category, 'System');
});

test('buildCommandCatalog onSelect hook is invoked with the command name + source', () => {
  const picked = [];
  const cat = buildCommandCatalog({ customRegistry: { foo: { description: '' } }, onSelect: (name, meta) => picked.push({ name, source: meta.source }) });
  const foo = cat.find((c) => c.name === 'foo');
  foo.onSelect();
  const help = cat.find((c) => c.name === 'help');
  help.onSelect();
  assert.deepEqual(picked, [{ name: 'foo', source: 'custom' }, { name: 'help', source: 'builtin' }]);
});

test('COMMANDS list still backs the existing getSuggestions flow (no regression)', () => {
  assert.ok(Array.isArray(COMMANDS) && COMMANDS.length);
  const s = getSuggestions('/mo');
  assert.ok(s.some((c) => c.cmd === 'model'));
  assert.ok(s.some((c) => c.cmd === 'mode'));
});