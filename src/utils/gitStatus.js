import { execSync } from 'child_process';

// Cheap, read-only git status snapshot for the sidebar. Returns null outside
// a git repo (or if git isn't installed) so callers can just hide the panel.
export function readGitStatus(cwd = process.cwd()) {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf8', timeout: 4000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const porcelain = execSync('git status --porcelain', { cwd, encoding: 'utf8', timeout: 4000, stdio: ['pipe', 'pipe', 'pipe'] });
    let staged = 0, unstaged = 0;
    for (const line of porcelain.split('\n')) {
      if (!line) continue;
      const index = line[0], worktree = line[1];
      if (index !== ' ' && index !== '?') staged++;
      if (worktree !== ' ') unstaged++;
    }
    return { branch, staged, unstaged };
  } catch {
    return null;
  }
}
