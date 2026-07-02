// Framework-agnostic markdown + syntax-highlighting parser used by the OpenTUI
// RichText (src/tui/RichText.jsx). Pure functions only — no UI imports — so it's
// unit-testable.

// Parse inline markup within a single line of text.
export function parseInline(text) {
  const tokens = [];
  // Order matters: ** before * so bold isn't consumed as two italics
  const re = /\*\*(.+?)\*\*|\*(.+?)\*|`([^`\n]+)`/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) tokens.push({ type: 'plain', text: text.slice(last, m.index) });
    if      (m[1] != null) tokens.push({ type: 'bold',   text: m[1] });
    else if (m[2] != null) tokens.push({ type: 'italic', text: m[2] });
    else if (m[3] != null) tokens.push({ type: 'code',   text: m[3] });
    last = re.lastIndex;
  }
  if (last < text.length) tokens.push({ type: 'plain', text: text.slice(last) });
  return tokens;
}

// Parse a markdown table from consecutive pipe-delimited lines starting at `start`.
// Returns a table block or null.
function parseTable(lines, start) {
  const rawRows = [];
  let i = start;
  while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
    rawRows.push(lines[i]);
    i++;
  }
  // Need at least header + separator rows
  if (rawRows.length < 2) return null;

  const splitRow = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  const headers = splitRow(rawRows[0]);
  const sep     = splitRow(rawRows[1]);

  // Parse alignment from separator row (colons in the dash line)
  const align = sep.map((cell) => {
    const t = cell.trim();
    const l = t.startsWith(':');
    const r = t.endsWith(':');
    if (l && r) return 'center';
    if (r) return 'right';
    return 'left';
  });

  const dataRows = rawRows.slice(2).map((r) => splitRow(r));

  // Normalise column count (shorter rows padded with empty cells)
  const numCols = Math.max(headers.length, ...dataRows.map((r) => r.length));
  const pad     = (arr, n) => [...arr, ...Array(n).fill('')].slice(0, n);

  return {
    type: 'table',
    headers: pad(headers, numCols),
    rows: dataRows.map((r) => pad(r, numCols)),
    align: pad(align, numCols),
    _rowCount: rawRows.length,
  };
}

// Split raw text into blocks before splitting by line (handles ``` fences + tables).
export function parseBlocks(text) {
  const blocks = [];
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trimStart().startsWith('```')) {
      const lang = line.trim().slice(3).trim() || null;
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      const text = codeLines.join('\n');
      if (lang === 'chart') {
        try { blocks.push({ type: 'chart', config: JSON.parse(text) }); }
        catch { blocks.push({ type: 'code-block', lang, text }); }
      } else {
        blocks.push({ type: 'code-block', lang, text });
      }
      i++;
      continue;
    }

    // Table detection: line starts/ends with a pipe (after trim).
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const table = parseTable(lines, i);
      if (table) {
        blocks.push(table);
        i += table._rowCount;
        continue;
      }
    }

    blocks.push({ type: 'line', text: line });
    i++;
  }

  return blocks;
}

// ── Syntax highlighting ───────────────────────────────────────────────────────

export const KEYWORDS = {
  js: 'const let var function return if else for while do switch case break continue new class extends super this import export from default async await try catch finally throw typeof instanceof of in null undefined true false yield static get set delete void',
  py: 'def return if elif else for while in not and or is None True False import from as class try except finally raise with lambda pass break continue global nonlocal yield async await assert del',
  sh: 'if then else elif fi for while do done case esac function in echo exit return local export set unset readonly shift source true false',
  rs: 'fn let mut pub use mod struct enum impl trait for while loop if else match return self Self super crate as in where async await move dyn ref static const unsafe true false',
  go: 'func var const type struct interface map chan go defer return if else for range switch case break continue package import nil true false select fallthrough goto',
  c:  'int char float double void long short unsigned signed struct union enum typedef const static extern return if else for while do switch case break continue sizeof NULL true false bool auto class public private protected virtual new delete namespace using template typename include define',
  sql:'select from where insert into values update set delete create table drop alter join left right inner outer on as and or not null primary key foreign references group by order limit offset having distinct union',
};

export const LANG_ALIASES = {
  javascript: 'js', jsx: 'js', ts: 'js', tsx: 'js', typescript: 'js', json: 'js', node: 'js',
  python: 'py', py3: 'py',
  bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', terminal: 'sh',
  rust: 'rs',
  golang: 'go',
  cpp: 'c', 'c++': 'c', h: 'c', hpp: 'c', java: 'c', cs: 'c', 'c#': 'c', kotlin: 'c', swift: 'c',
  postgres: 'sql', mysql: 'sql', sqlite: 'sql',
};

// Map a file path/extension to a highlighter language key (or null if unknown).
const EXT_LANG = {
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', json: 'js',
  py: 'py', pyw: 'py',
  sh: 'sh', bash: 'sh', zsh: 'sh',
  rs: 'rs', go: 'go',
  c: 'c', h: 'c', cpp: 'c', cc: 'c', cxx: 'c', hpp: 'c', cs: 'c', java: 'c', kt: 'c', swift: 'c',
  sql: 'sql',
};
export function langFromPath(path) {
  if (!path) return null;
  const ext = String(path).split(/[\\/]/).pop().split('.').pop().toLowerCase();
  return EXT_LANG[ext] || (KEYWORDS[ext] ? ext : null);
}

// Tokenize one line of code: comments, strings, keywords, numbers, function calls.
export function highlightLine(line, lang) {
  const key  = LANG_ALIASES[lang] || lang;
  const kw   = new Set((KEYWORDS[key] || KEYWORDS.js).split(' '));
  const tokens = [];
  // comment | string | word | number — comment marker depends on language
  const commentRe =
    key === 'py' || key === 'sh' ? '#.*$'
    : key === 'sql'              ? '--.*$'
    : '\\/\\/.*$';
  const re = new RegExp(
    `(${commentRe})|("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)|([A-Za-z_][A-Za-z0-9_]*)|(\\b\\d[\\d_]*\\.?\\d*\\b)`,
    'gm'
  );
  let last = 0, m;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) tokens.push({ type: 'plain', text: line.slice(last, m.index) });
    if (m[1] != null) {
      tokens.push({ type: 'comment', text: m[1] });
    } else if (m[2] != null) {
      tokens.push({ type: 'string', text: m[2] });
    } else if (m[3] != null) {
      const word = m[3];
      if (kw.has(word) || (key === 'sql' && kw.has(word.toLowerCase()))) {
        tokens.push({ type: 'keyword', text: word });
      } else if (line[re.lastIndex] === '(') {
        tokens.push({ type: 'fn', text: word });
      } else {
        tokens.push({ type: 'plain', text: word });
      }
    } else if (m[4] != null) {
      tokens.push({ type: 'number', text: m[4] });
    }
    last = re.lastIndex;
  }
  if (last < line.length) tokens.push({ type: 'plain', text: line.slice(last) });
  return tokens;
}
