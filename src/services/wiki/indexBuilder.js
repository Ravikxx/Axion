import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getWikiRoot, indexPath } from './paths.js';
import { detectProjectIdentity } from './identity.js';
import { detectConventions } from './conventions.js';
import { writeTextAtomic } from '../../tui/persistence.js';

export function buildIndex(projectPath) {
  const root = getWikiRoot(projectPath);
  const pagesDir = join(root, 'pages');
  const sourcesDir = join(root, 'sources');

  const identity = detectProjectIdentity(projectPath);
  const conventions = detectConventions(projectPath);

  const lines = [
    `# Project Wiki`,
    '',
    `*Last rebuilt: ${new Date().toLocaleString()}*`,
    '',
    '## Project Identity',
    `- Languages: ${identity.primaryLanguages.join(', ') || 'detecting…'}`,
    `- Monorepo: ${identity.isMonorepo ? 'yes' : 'no'}`,
    `- Main branch: ${identity.mainBranch}`,
    identity.packageManager ? `- Package manager: ${identity.packageManager}` : '',
    '',
  ];

  if (conventions.length) {
    lines.push('## Detected Conventions', '');
    for (const c of conventions) {
      lines.push(`- **${c.type}**: ${c.value} ${c.description ? `(${c.description})` : ''}`);
    }
    lines.push('');
  }

  // List pages
  lines.push('## Pages', '');
  if (existsSync(pagesDir)) {
    const pageFiles = readdirSync(pagesDir).filter(f => f.endsWith('.md'));
    if (pageFiles.length) {
      for (const f of pageFiles.sort()) {
        const pagePath = join(pagesDir, f);
        const content = readFileSync(pagePath, 'utf8');
        const title = content.split('\n')[0]?.replace(/^#\s*/, '') || f.replace(/\.md$/, '');
        const summary = content.split('\n').slice(2, 4).join(' ').replace(/^[\*\-]*\s*/, '').slice(0, 150);
        lines.push(`- [${title}](${join('pages', f)}) — ${summary}`);
      }
    } else {
      lines.push('*(No pages yet.)*');
    }
  } else {
    lines.push('*(No pages yet.)*');
  }
  lines.push('');

  // List sources
  lines.push('## Sources', '');
  if (existsSync(sourcesDir)) {
    const sourceFiles = readdirSync(sourcesDir).filter(f => f.endsWith('.md'));
    if (sourceFiles.length) {
      for (const f of sourceFiles.sort()) {
        lines.push(`- [${f.replace(/\.md$/, '').replace(/_/g, '/')}](${join('sources', f)})`);
      }
    } else {
      lines.push('*(No sources ingested yet.)*');
    }
  } else {
    lines.push('*(No sources ingested yet.)*');
  }

  writeTextAtomic(indexPath(root), lines.join('\n') + '\n');
}

export function rebuildIndex(projectPath) {
  buildIndex(projectPath);
}
