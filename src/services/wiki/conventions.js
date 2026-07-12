import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { ConventionEntry } from './types.js';

const CONVENTION_CHECKS = [
  {
    file: 'package.json',
    extract: (cwd) => {
      const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));
      const entries = [];
      if (pkg.scripts && Object.keys(pkg.scripts).length) {
        entries.push(new ConventionEntry({ file: 'package.json', type: 'scripts', value: Object.keys(pkg.scripts).join(', '), description: 'npm scripts' }));
      }
      const testScript = Object.keys(pkg.scripts || {}).find(s => /^test|^spec/i.test(s));
      if (testScript) {
        entries.push(new ConventionEntry({ file: 'package.json', type: 'test-command', value: `npm run ${testScript}`, description: 'Test runner command' }));
      }
      return entries;
    },
  },
  {
    file: '.editorconfig',
    extract: (cwd) => {
      const text = readFileSync(resolve(cwd, '.editorconfig'), 'utf8');
      const indentStyle = text.match(/indent_style\s*=\s*(\w+)/i);
      const indentSize  = text.match(/indent_size\s*=\s*(\d+)/i);
      const entries = [];
      if (indentStyle) entries.push(new ConventionEntry({ file: '.editorconfig', type: 'indent-style', value: indentStyle[1] }));
      if (indentSize)  entries.push(new ConventionEntry({ file: '.editorconfig', type: 'indent-size', value: indentSize[1] }));
      return entries;
    },
  },
  {
    file: '.prettierrc',
    extract: (cwd) => {
      const files = ['.prettierrc', '.prettierrc.json', '.prettierrc.js', 'prettier.config.js'];
      for (const f of files) {
        const p = resolve(cwd, f);
        if (existsSync(p)) {
          const raw = readFileSync(p, 'utf8');
          let cfg;
          try { cfg = JSON.parse(raw); } catch { cfg = {}; }
          return [
            new ConventionEntry({ file: f, type: 'formatter', value: 'prettier', description: `Single quotes: ${cfg.singleQuotes ?? '—'}, tab width: ${cfg.tabWidth ?? '—'}` }),
          ];
        }
      }
      return [];
    },
  },
  {
    file: 'tsconfig.json',
    extract: (cwd) => {
      const cfg = JSON.parse(readFileSync(resolve(cwd, 'tsconfig.json'), 'utf8'));
      const c = cfg.compilerOptions || {};
      const strict = c.strict ? 'strict' : c.noImplicitAny ? 'noImplicitAny' : 'loose';
      return [new ConventionEntry({ file: 'tsconfig.json', type: 'typescript-strictness', value: strict })];
    },
  },
  {
    file: 'Dockerfile',
    extract: () => [new ConventionEntry({ file: 'Dockerfile', type: 'containerization', value: 'Docker', description: 'Docker build detected' })],
  },
  {
    file: 'Makefile',
    extract: () => [new ConventionEntry({ file: 'Makefile', type: 'build-system', value: 'make' })],
  },
  {
    file: 'Justfile',
    extract: () => [new ConventionEntry({ file: 'Justfile', type: 'build-system', value: 'just' })],
  },
  {
    file: 'pyproject.toml',
    extract: (cwd) => {
      const text = readFileSync(resolve(cwd, 'pyproject.toml'), 'utf8');
      const entries = [];
      if (text.includes('[tool.pytest')) entries.push(new ConventionEntry({ file: 'pyproject.toml', type: 'test-framework', value: 'pytest' }));
      if (text.includes('black') || text.includes('[tool.black')) entries.push(new ConventionEntry({ file: 'pyproject.toml', type: 'formatter', value: 'black' }));
      if (text.includes('ruff')) entries.push(new ConventionEntry({ file: 'pyproject.toml', type: 'linter', value: 'ruff' }));
      return entries;
    },
  },
  {
    file: '.github/workflows',
    extract: (cwd) => {
      const workflowsDir = resolve(cwd, '.github', 'workflows');
      if (!existsSync(workflowsDir)) return [];
      const files = readdirSync(workflowsDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
      return files.map(f => new ConventionEntry({ file: `.github/workflows/${f}`, type: 'ci-workflow', value: f }));
    },
  },
  {
    file: '.github/CODEOWNERS',
    extract: () => [new ConventionEntry({ file: '.github/CODEOWNERS', type: 'code-owners', value: 'present' })],
  },
];

export function detectConventions(projectPath) {
  const cwd = projectPath || process.cwd();
  const entries = [];

  for (const check of CONVENTION_CHECKS) {
    const filePath = resolve(cwd, check.file);
    if (existsSync(filePath)) {
      try {
        const results = check.extract(cwd);
        entries.push(...results);
      } catch {}
    }
  }

  return entries;
}
