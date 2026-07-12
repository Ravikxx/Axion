import { execFileSync, execSync } from 'child_process';
import { extname, join } from 'path';
import { existsSync } from 'fs';
import { FORMATTERS } from '../../config.js';

// Try to auto-format a file based on configured formatter rules.
// Returns a string label like " (prettier)" or "" on failure/skip.
export function tryAutoFormat(absPath, cwd) {
  const cfg = FORMATTERS;
  if (cfg.disabled) return '';

  const ext = extname(absPath).toLowerCase();

  for (const rule of cfg.rules) {
    if (!rule.extensions.includes(ext)) continue;
    if (rule.disabled) continue;

    try {
      const cmd = Array.isArray(rule.command) ? rule.command : [rule.command];
      const replaced = cmd.map(c => c.replace('{file}', absPath));

      if (replaced.length === 1) {
        execSync(replaced[0], { cwd, stdio: 'pipe', timeout: 15000 });
      } else {
        execFileSync(replaced[0], replaced.slice(1), { cwd, stdio: 'pipe', timeout: 15000 });
      }

      return ` (auto-formatted)`;
    } catch {
      // formatter not available or failed — silent skip
    }
  }

  return '';
}
