import { readFileSync, existsSync, appendFileSync } from 'fs';
import { relative, resolve, basename } from 'path';
import { getWikiRoot, sourcePath, logPath } from './paths.js';
import { buildIndex } from './indexBuilder.js';
import { writeTextAtomic } from '../../tui/persistence.js';

export function ingestSource(projectPath, filePath) {
  const root = getWikiRoot(projectPath);
  const absPath = resolve(projectPath || process.cwd(), filePath);

  if (!existsSync(absPath)) {
    return { success: false, output: `File not found: ${filePath}` };
  }

  const content = readFileSync(absPath, 'utf8');
  const rel = relative(projectPath || process.cwd(), absPath);
  const title = basename(absPath);
  const summary = content.split('\n').slice(0, 3).join(' ').slice(0, 200);
  const excerpt = content.slice(0, 1000);

  const src = [
    `# Source: ${title}`,
    '',
    `- **Path:** \`${rel}\``,
    `- **Created:** ${new Date().toLocaleString()}`,
    '',
    '## Summary',
    '',
    summary,
    '',
    '## Excerpt',
    '',
    '```',
    excerpt,
    '```',
    '',
  ];

  const dest = sourcePath(root, absPath);
  writeTextAtomic(dest, src.join('\n'));

  appendFileSync(logPath(root), `- ${new Date().toISOString()} — ingested \`${rel}\`\n`, 'utf8');

  buildIndex(projectPath);

  return { success: true, output: `Ingested ${rel} → ${dest}` };
}
