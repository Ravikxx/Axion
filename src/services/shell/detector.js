import { readFileSync, statSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

// ── Shell metadata ────────────────────────────────────────────────────────────
const META = {
  bash:       { login: true,  posix: true },
  dash:       { login: true,  posix: true },
  fish:       { login: true,  posix: false, deny: true },
  ksh:        { login: true,  posix: true },
  nu:         { login: false, posix: false, deny: true },
  powershell: { login: false, posix: false, ps: true },
  pwsh:       { login: false, posix: false, ps: true },
  sh:         { login: true,  posix: true },
  zsh:        { login: true,  posix: true },
};

// ── Cached results ────────────────────────────────────────────────────────────
let _cachedDefault = undefined;
let _cachedList = undefined;

// ── Helpers ───────────────────────────────────────────────────────────────────

function shellName(shellPath) {
  return path.basename(shellPath).toLowerCase();
}

function shellMeta(name) {
  return META[name];
}

function isAcceptable(name) {
  const meta = shellMeta(name);
  return !meta || !meta.deny;
}

function statSafe(file) {
  try { return statSync(file); } catch { return undefined; }
}

function which(cmd) {
  try {
    return execSync(`which ${JSON.stringify(cmd)}`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch { return undefined; }
}

// ── Platform-specific detection ───────────────────────────────────────────────

function detectUnix() {
  // 1. $SHELL env var
  if (process.env.SHELL) return process.env.SHELL;

  // 2. /etc/passwd
  try {
    const passwd = readFileSync('/etc/passwd', 'utf8');
    const lines = passwd.split('\n');
    const uid = execSync('id -u', { encoding: 'utf8', timeout: 5000 }).trim();
    for (const line of lines) {
      const parts = line.split(':');
      if (parts[0] === process.env.USER || parts[2] === uid) {
        const shell = parts[6]?.trim();
        if (shell && statSafe(shell)?.isFile()) return shell;
      }
    }
  } catch {}

  // 3. Fallback chain
  for (const sh of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (statSafe(sh)?.isFile()) return sh;
  }
  return '/bin/sh';
}

function detectWindows() {
  // 1. COMSPEC
  if (process.env.COMSPEC) return process.env.COMSPEC;
  // 2. pwsh
  const pwsh = which('pwsh');
  if (pwsh) return pwsh;
  // 3. powershell
  const ps = which('powershell');
  if (ps) return ps;
  // 4. cmd.exe
  return process.env.COMSPEC || 'cmd.exe';
}

// ── Shell args for login-style invocation ─────────────────────────────────────

const POSIX_LOGIN_HEADER = (cwd) => `
[[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
[[ -f ~/.bash_profile ]] && source ~/.bash_profile >/dev/null 2>&1 || true
[[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
cd -- "${cwd}"
`.trim();

const ZSH_LOGIN_HEADER = (cwd) => `
[[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
[[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
cd -- "${cwd}"
`.trim();

const BASH_LOGIN_HEADER = (cwd) => `
shopt -s expand_aliases
[[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
cd -- "${cwd}"
`.trim();

/**
 * Build shell arguments for running a command with proper login shell semantics.
 * @param {string} shellPath - resolved absolute path to shell
 * @param {string} command - command string to execute
 * @param {string} cwd - working directory
 * @returns {{ shell: string, args: string[] }}
 */
export function buildShellArgs(shellPath, command, cwd) {
  const name = shellName(shellPath);
  const meta = shellMeta(name);

  // fish / nu: no login flag, just -c
  if (name === 'fish' || name === 'nu') {
    return { shell: shellPath, args: ['-c', command] };
  }
  // powershell / pwsh
  if (meta?.ps) {
    return { shell: shellPath, args: ['-NoProfile', '-Command', command] };
  }
  // cmd.exe
  if (name === 'cmd') {
    return { shell: shellPath, args: ['/c', command] };
  }
  // zsh — special login sourcing
  if (name === 'zsh') {
    const script = `${ZSH_LOGIN_HEADER(cwd)}\neval ${JSON.stringify(command)}`;
    return { shell: shellPath, args: ['-l', '-c', script] };
  }
  // bash — special login sourcing
  if (name === 'bash') {
    const script = `${BASH_LOGIN_HEADER(cwd)}\neval ${JSON.stringify(command)}`;
    return { shell: shellPath, args: ['-l', '-c', script] };
  }
  // Generic POSIX login shell
  if (meta?.login) {
    return { shell: shellPath, args: ['-l', '-c', command] };
  }
  // Default
  return { shell: shellPath, args: ['-c', command] };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Detect the default shell for the current user.
 * @param {string} [configShell] - user-configured shell override
 * @returns {string} absolute path to shell binary
 */
export function detect(configShell) {
  if (configShell) {
    const resolved = path.isAbsolute(configShell) ? configShell : which(configShell);
    if (resolved && statSafe(resolved)?.isFile()) return resolved;
  }
  if (_cachedDefault) return _cachedDefault;
  _cachedDefault = process.platform === 'win32' ? detectWindows() : detectUnix();
  return _cachedDefault;
}

/**
 * Detect if a shell is acceptable (not deny-flagged like fish/nu for tool use).
 * @param {string} [configShell]
 * @returns {string} shell path — acceptable shell or system fallback
 */
export function acceptable(configShell) {
  const shell = detect(configShell);
  const name = shellName(shell);
  if (isAcceptable(name)) return shell;
  // Fallback to a known-good shell
  return detect();
}

/**
 * List all available shells on the system.
 * @returns {{ path: string, name: string, acceptable: boolean }[]}
 */
export function list() {
  if (_cachedList) return _cachedList;

  const shells = [];
  if (process.platform === 'win32') {
    const candidates = ['pwsh', 'powershell', 'bash', 'cmd'];
    for (const name of candidates) {
      const p = which(name);
      if (p) shells.push({ path: p, name, acceptable: isAcceptable(name) });
    }
  } else {
    let candidates = [];
    try {
      const text = readFileSync('/etc/shells', 'utf8');
      candidates = text.split('\n')
        .filter(l => l.trim() && !l.startsWith('#'))
        .map(l => l.trim());
    } catch {
      candidates = ['/bin/bash', '/bin/zsh', '/bin/sh'];
    }
    // Also check $SHELL
    if (process.env.SHELL && !candidates.includes(process.env.SHELL)) {
      candidates.unshift(process.env.SHELL);
    }
    const seen = new Set();
    for (const p of candidates) {
      if (seen.has(p) || !statSafe(p)?.isFile()) continue;
      seen.add(p);
      const name = shellName(p);
      shells.push({ path: p, name, acceptable: isAcceptable(name) });
    }
  }

  _cachedList = shells;
  return shells;
}

/**
 * Get shell info (name, path, acceptable) for display.
 * @param {string} [configShell]
 * @returns {{ path: string, name: string, acceptable: boolean }}
 */
export function info(configShell) {
  const shell = detect(configShell);
  const name = shellName(shell);
  return { path: shell, name, acceptable: isAcceptable(name) };
}

/**
 * Get the shell login flag for a given shell.
 * @param {string} shellPath
 * @returns {boolean}
 */
export function isLogin(shellPath) {
  return shellMeta(shellName(shellPath))?.login === true;
}

/**
 * Reset cached detection (useful for testing or when config changes).
 */
export function reset() {
  _cachedDefault = undefined;
  _cachedList = undefined;
}
