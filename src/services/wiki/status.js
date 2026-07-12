import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { getWikiRoot, indexPath, logPath } from './paths.js';

export function wikiStatus(projectPath) {
  const root = getWikiRoot(projectPath);
  if (!existsSync(indexPath(root))) {
    return { initialized: false, root, pages: 0, sources: 0, lastModified: null };
  }

  const pagesDir = join(root, 'pages');
  const sourcesDir = join(root, 'sources');

  const pageCount = existsSync(pagesDir) ? readdirSync(pagesDir).filter(f => f.endsWith('.md')).length : 0;
  const sourceCount = existsSync(sourcesDir) ? readdirSync(sourcesDir).filter(f => f.endsWith('.md')).length : 0;

  let lastModified = null;
  try {
    const st = statSync(logPath(root));
    lastModified = st.mtime.toISOString();
  } catch {}

  return {
    initialized: true,
    root,
    pages: pageCount,
    sources: sourceCount,
    lastModified,
  };
}

export function wikiContent(projectPath) {
  const root = getWikiRoot(projectPath);
  if (!existsSync(indexPath(root))) return null;
  return readFileSync(indexPath(root), 'utf8');
}

export function searchWiki(projectPath, query) {
  const root = getWikiRoot(projectPath);
  const q = query.toLowerCase();
  const results = [];

  const searchFile = (filePath) => {
    try {
      const content = readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      const matchingLines = lines
        .map((l, i) => ({ line: i + 1, text: l.trim() }))
        .filter(l => l.text.toLowerCase().includes(q) && l.text);
      if (matchingLines.length) {
        const title = lines[0]?.replace(/^#\s*/, '') || filePath;
        results.push({ file: filePath, title, matches: matchingLines.slice(0, 5) });
      }
    } catch {}
  };

  searchFile(indexPath(root));
  for (const dir of ['pages', 'sources']) {
    const dirPath = join(root, dir);
    if (existsSync(dirPath)) {
      for (const f of readdirSync(dirPath).filter(f => f.endsWith('.md'))) {
        searchFile(join(dirPath, f));
      }
    }
  }

  return results;
}
