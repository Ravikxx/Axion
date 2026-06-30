import { execSync } from 'child_process';

// Copy text to the system clipboard. Throws if no clipboard tool is available.
export function copyToClipboard(text) {
  if (process.platform === 'win32')  return execSync('clip',   { input: text });
  if (process.platform === 'darwin') return execSync('pbcopy', { input: text });
  // Linux: prefer wl-copy on Wayland, fall back to xclip (and vice versa).
  const cmds = process.env.WAYLAND_DISPLAY
    ? ['wl-copy', 'xclip -selection clipboard']
    : ['xclip -selection clipboard', 'wl-copy'];
  let lastErr;
  for (const cmd of cmds) {
    try { return execSync(cmd, { input: text, stdio: ['pipe', 'ignore', 'ignore'] }); }
    catch (err) { lastErr = err; }
  }
  throw lastErr;
}
