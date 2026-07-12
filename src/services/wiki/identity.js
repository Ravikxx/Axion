import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { ProjectIdentity } from './types.js';

export function detectProjectIdentity(projectPath) {
  const identity = new ProjectIdentity();
  const cwd = projectPath || process.cwd();

  identity.primaryLanguages = detectLanguages(cwd);
  identity.isMonorepo = detectMonorepo(cwd);
  identity.mainBranch = detectMainBranch(cwd);
  identity.packageManager = detectPackageManager(cwd);

  return identity;
}

function detectLanguages(cwd) {
  const langs = [];
  if (existsSync(resolve(cwd, 'package.json')))     langs.push('JavaScript/TypeScript');
  if (existsSync(resolve(cwd, 'pyproject.toml')))    langs.push('Python');
  if (existsSync(resolve(cwd, 'Cargo.toml')))        langs.push('Rust');
  if (existsSync(resolve(cwd, 'go.mod')))            langs.push('Go');
  if (existsSync(resolve(cwd, 'Gemfile')))           langs.push('Ruby');
  if (existsSync(resolve(cwd, 'Makefile')))          langs.push('C/C++');
  if (existsSync(resolve(cwd, 'pom.xml')))           langs.push('Java');
  if (existsSync(resolve(cwd, 'project.clj')))       langs.push('Clojure');
  return langs;
}

function detectMonorepo(cwd) {
  try {
    const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));
    return !!(pkg.workspaces || pkg.private === true && existsSync(resolve(cwd, 'packages')));
  } catch { return false; }
}

function detectMainBranch(cwd) {
  try {
    const out = execSync('git branch --show-current', { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
    if (out) return out;
  } catch {}
  try {
    for (const name of ['main', 'master', 'develop']) {
      execSync(`git show-ref --verify refs/heads/${name}`, { cwd, encoding: 'utf8', stdio: 'pipe' });
      return name;
    }
  } catch {}
  return 'main';
}

function detectPackageManager(cwd) {
  if (existsSync(resolve(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(resolve(cwd, 'yarn.lock')))      return 'yarn';
  if (existsSync(resolve(cwd, 'bun.lockb')))      return 'bun';
  if (existsSync(resolve(cwd, 'package-lock.json'))) return 'npm';
  return '';
}
