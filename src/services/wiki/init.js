import { existsSync } from 'fs';
import { getWikiRoot, ensureWikiDirs, indexPath, logPath } from './paths.js';
import { detectProjectIdentity } from './identity.js';
import { detectConventions } from './conventions.js';
import { buildIndex } from './indexBuilder.js';
import { writeTextAtomic } from '../../tui/persistence.js';

export function initWiki(projectPath) {
  const root = ensureWikiDirs(projectPath);

  if (!existsSync(indexPath(root))) {
    const identity = detectProjectIdentity(projectPath);
    const conventions = detectConventions(projectPath);

    const lines = [
      `# Project Wiki`,
      '',
      `*Initialized ${new Date().toLocaleString()}*`,
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

    lines.push(
      '## Pages',
      '',
      '*(No pages yet. Use `wiki_write` to add knowledge pages.)*',
      '',
      '## Sources',
      '',
      '*(Use \`wiki_ingest\` to capture source files as notes.)*',
      '',
    );

    writeTextAtomic(indexPath(root), lines.join('\n'));
  }

  if (!existsSync(logPath(root))) {
    writeTextAtomic(logPath(root), `# Wiki Change Log\n\n*Created ${new Date().toLocaleString()}*\n\n`);
  }

  return root;
}

export function wikiIsInitialized(projectPath) {
  const root = getWikiRoot(projectPath);
  return existsSync(indexPath(root));
}
