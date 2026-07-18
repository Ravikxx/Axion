import { spawn } from 'child_process';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_CHARS = 100_000;

class BoundedOutput {
  constructor(limit) {
    this.limit = Math.max(256, limit);
    this.total = 0;
    this.head = '';
    this.tail = '';
    this.truncated = false;
  }

  append(chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
    if (!text) return;
    this.total += text.length;

    if (!this.truncated && this.head.length + text.length <= this.limit) {
      this.head += text;
      return;
    }

    const headLimit = Math.floor(this.limit / 2);
    const tailLimit = this.limit - headLimit;
    if (!this.truncated) {
      const combined = this.head + text;
      this.head = combined.slice(0, headLimit);
      this.tail = combined.slice(-tailLimit);
      this.truncated = true;
      return;
    }
    this.tail = (this.tail + text).slice(-tailLimit);
  }

  toString() {
    if (!this.truncated) return this.head;
    const omitted = Math.max(0, this.total - this.head.length - this.tail.length);
    return `${this.head}\n... [truncated ${omitted} characters] ...\n${this.tail}`;
  }
}

export function terminateProcessTree(child, { forceAfterMs = 1_500 } = {}) {
  if (!child?.pid || child.exitCode != null || child.signalCode != null) return () => {};

  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => {
      try { child.kill(); } catch {}
    });
    return () => {};
  }

  const signalGroup = (signal) => {
    try { process.kill(-child.pid, signal); return; } catch {}
    try { child.kill(signal); } catch {}
  };
  signalGroup('SIGTERM');

  const forceTimer = setTimeout(() => signalGroup('SIGKILL'), forceAfterMs);
  forceTimer.unref?.();
  return () => clearTimeout(forceTimer);
}

export function runManagedProcess(command, args = [], {
  cwd,
  env = process.env,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
} = {}) {
  if (signal?.aborted) {
    return Promise.resolve({
      exitCode: null, signal: null, output: '', aborted: true,
      timedOut: false, truncated: false, spawnError: null,
    });
  }

  return new Promise((resolve) => {
    const output = new BoundedOutput(maxOutputChars);
    let child;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let spawnError = null;
    let timeoutTimer = null;
    let clearForceKill = () => {};

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      clearForceKill();
      signal?.removeEventListener('abort', onAbort);
    };

    const finish = (exitCode = null, exitSignal = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      const rendered = output.toString();
      resolve({
        exitCode,
        signal: exitSignal,
        output: rendered,
        aborted,
        timedOut,
        truncated: rendered.includes('... [truncated '),
        spawnError,
      });
    };

    const stop = () => {
      if (!child || settled) return;
      clearForceKill = terminateProcessTree(child);
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };

    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      spawnError = err;
      finish();
      return;
    }

    child.stdout?.on('data', (chunk) => output.append(chunk));
    child.stderr?.on('data', (chunk) => output.append(chunk));
    child.once('error', (err) => {
      spawnError = err;
      finish();
    });
    child.once('close', (code, exitSignal) => finish(code, exitSignal));

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      stop();
    }, Math.max(1, timeoutMs));
    timeoutTimer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
