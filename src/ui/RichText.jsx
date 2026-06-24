import React from 'react';
import { Box, Text } from 'ink';

// Parse inline markup within a single line of text
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

function InlineTokens({ tokens }) {
  return tokens.map((tok, i) => {
    switch (tok.type) {
      case 'bold':   return <Text key={i} bold>{tok.text}</Text>;
      case 'italic': return <Text key={i} italic>{tok.text}</Text>;
      case 'code':   return <Text key={i} color="#cc785c">{tok.text}</Text>;
      default:       return <Text key={i}>{tok.text}</Text>;
    }
  });
}

// Split raw text into blocks before splitting by line (handles ``` fences)
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
        try { blocks.push({ type: 'chart', config: JSON.parse(text) }) }
        catch { blocks.push({ type: 'code-block', lang, text }) }
      } else {
        blocks.push({ type: 'code-block', lang, text });
      }
      i++;
      continue;
    }

    blocks.push({ type: 'line', text: line });
    i++;
  }

  return blocks;
}

// ── Syntax highlighting ───────────────────────────────────────────────────────

const KEYWORDS = {
  js: 'const let var function return if else for while do switch case break continue new class extends super this import export from default async await try catch finally throw typeof instanceof of in null undefined true false yield static get set delete void',
  py: 'def return if elif else for while in not and or is None True False import from as class try except finally raise with lambda pass break continue global nonlocal yield async await assert del',
  sh: 'if then else elif fi for while do done case esac function in echo exit return local export set unset readonly shift source true false',
  rs: 'fn let mut pub use mod struct enum impl trait for while loop if else match return self Self super crate as in where async await move dyn ref static const unsafe true false',
  go: 'func var const type struct interface map chan go defer return if else for range switch case break continue package import nil true false select fallthrough goto',
  c:  'int char float double void long short unsigned signed struct union enum typedef const static extern return if else for while do switch case break continue sizeof NULL true false bool auto class public private protected virtual new delete namespace using template typename include define',
  sql:'select from where insert into values update set delete create table drop alter join left right inner outer on as and or not null primary key foreign references group by order limit offset having distinct union',
};

const LANG_ALIASES = {
  javascript: 'js', jsx: 'js', ts: 'js', tsx: 'js', typescript: 'js', json: 'js', node: 'js',
  python: 'py', py3: 'py',
  bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', terminal: 'sh',
  rust: 'rs',
  golang: 'go',
  cpp: 'c', 'c++': 'c', h: 'c', hpp: 'c', java: 'c', cs: 'c', 'c#': 'c', kotlin: 'c', swift: 'c',
  postgres: 'sql', mysql: 'sql', sqlite: 'sql',
};

const TOKEN_COLORS = {
  comment: { color: 'gray' },
  string:  { color: 'green' },
  keyword: { color: 'magentaBright' },
  number:  { color: 'yellow' },
  fn:      { color: 'cyanBright' },
  plain:   { color: 'white' },
};

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

function CodeLine({ line, lang }) {
  if (line.trim() === '') return <Text> </Text>;
  return (
    <Text>
      {highlightLine(line, lang).map((tok, i) => {
        const s = TOKEN_COLORS[tok.type] || TOKEN_COLORS.plain;
        return <Text key={i} color={s.color} dimColor={s.dim}>{tok.text}</Text>;
      })}
    </Text>
  );
}

function RichLine({ text }) {
  // Blank line — small spacer
  if (text.trim() === '') return <Text> </Text>;

  // Headings
  if (text.startsWith('### ')) {
    return <Text bold color="#b08869"><InlineTokens tokens={parseInline(text.slice(4))} /></Text>;
  }
  if (text.startsWith('## ')) {
    return <Text bold color="#cc785c"><InlineTokens tokens={parseInline(text.slice(3))} /></Text>;
  }
  if (text.startsWith('# ')) {
    return <Text bold color="#cc785c"><InlineTokens tokens={parseInline(text.slice(2))} /></Text>;
  }

  // Horizontal rule
  if (/^[-*_]{3,}$/.test(text.trim())) {
    return <Text color="gray">{'─'.repeat(40)}</Text>;
  }

  // Unordered list
  if (/^(\s*)[*\-+] /.test(text)) {
    const indent = text.match(/^(\s*)/)[1].length;
    const content = text.replace(/^\s*[*\-+] /, '');
    return (
      <Text>
        <Text color="gray">{'  '.repeat(Math.floor(indent / 2))}{'• '}</Text>
        <InlineTokens tokens={parseInline(content)} />
      </Text>
    );
  }

  // Ordered list
  const orderedMatch = text.match(/^(\s*)(\d+)\. (.*)/);
  if (orderedMatch) {
    const indent = orderedMatch[1].length;
    return (
      <Text>
        <Text color="gray">{'  '.repeat(Math.floor(indent / 2))}{orderedMatch[2]}. </Text>
        <InlineTokens tokens={parseInline(orderedMatch[3])} />
      </Text>
    );
  }

  // Blockquote
  if (text.startsWith('> ')) {
    return (
      <Text>
        <Text color="gray">│ </Text>
        <Text color="gray"><InlineTokens tokens={parseInline(text.slice(2))} /></Text>
      </Text>
    );
  }

  // Plain paragraph line
  return <Text><InlineTokens tokens={parseInline(text)} /></Text>;
}

function ChartBlock({ config }) {
  const width = Math.min(process.stdout.columns - 6 || 50, 60);
  const ds = config.data?.datasets?.[0];
  const labels = config.data?.labels || [];
  const values = ds?.data || [];
  if (!values.length) return <Text color="gray">(empty chart)</Text>;

  const maxVal = Math.max(...values, 1);
  const totalVal = values.reduce((a, b) => Math.abs(a) + Math.abs(b), 0) || 1;
  const barMax = Math.max(width - 20, 10);
  const colors = ['#e8602c','#34d399','#60a5fa','#f59e0b','#a78bfa','#f472b6','#14b8a6','#f97316'];

  if (config.type === 'line') {
    const sparkChars = ['▁','▂','▃','▄','▅','▆','▇','█'];
    const n = Math.min(values.length, width - 4);
    const step = Math.max(1, Math.floor(values.length / n));
    const sampled = values.filter((_, i) => i % step === 0 || i === values.length - 1);
    const sMax = Math.max(...sampled, 1);
    const sMin = Math.min(...sampled, 0);
    const sRange = sMax - sMin || 1;
    const line = sampled.map(v => {
      const idx = Math.round(((v - sMin) / sRange) * 7);
      return sparkChars[Math.min(Math.max(idx, 0), 7)];
    }).join('');
    const idxStep = Math.max(1, Math.floor(sampled.length / 6));
    const annotated = labels.length ? labels.filter((_, i) => i % idxStep === 0 || i === sampled.length - 1).join('  ') : '';
    return (
      <Box flexDirection="column" marginY={0} paddingX={1} gap={0}>
        {config.title && <Text bold color="#cc785c">{config.title}</Text>}
        <Box flexDirection="row" gap={0}>
          <Text color="#60a5fa">{line}</Text>
        </Box>
        {sampled.length > 0 && (
          <Text color="gray" dim>
            {sampled.map((v, i) =>
              labels[i] ? `${labels[i]}=${v}` : `${v}`
            ).filter((_, i) => i % idxStep === 0 || i === sampled.length - 1).join(', ')}
          </Text>
        )}
      </Box>
    );
  }

  if (config.type === 'pie' || config.type === 'doughnut') {
    const total = values.reduce((a, b) => Math.abs(a) + Math.abs(b), 0) || 1;
    const AR = 2; // terminal char height:width ratio
    const R = Math.min(Math.max(5, Math.floor(width / 5)), 10);
    const diam = R * 2 + 1;
    const holeR = config.type === 'doughnut' ? R * 0.3 : 0;

    let cumAngle = Math.PI / 2; // start at 12 o'clock, go CCW
    const slices = values.map((v, i) => {
      const a = (Math.abs(v) / total) * 2 * Math.PI;
      const s = { start: cumAngle, end: cumAngle + a, color: colors[i % colors.length], label: labels[i] || '', value: v, pct: ((Math.abs(v) / total) * 100).toFixed(1) };
      cumAngle += a;
      return s;
    });

    const norm = a => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

    const sliceAt = (x, y) => {
      const a = norm(Math.atan2(y * AR, x));
      for (const s of slices) {
        const sA = norm(s.start), sB = norm(s.end);
        if (sA < sB ? (a >= sA && a < sB) : (a >= sA || a < sB)) return s;
      }
      return slices[slices.length - 1];
    };

    const rows = [];
    for (let py = 0; py < diam; py++) {
      const runs = [];
      // two sub-pixel rows per character row (half-blocks)
      for (let sub = 0; sub < 2; sub++) {
        for (let px = 0; px < diam; px++) {
          const x = px - R;
          const y = (R - py) + (sub === 0 ? -0.25 : 0.25);
          const d2 = x * x + (y * AR) * (y * AR);
          const edge = R + 0.5;
          if (d2 > edge * edge) {
            runs.push(null);
          } else if (d2 < holeR * holeR) {
            runs.push(null);
          } else {
            runs.push(sliceAt(x, y).color);
          }
        }
      }
      // Merge two sub-rows into half-block characters
      const merged = [];
      const topHalf = runs.slice(0, diam);
      const botHalf = runs.slice(diam);
      for (let i = 0; i < diam; i++) {
        const sub0 = topHalf[i], sub1 = botHalf[i];
        if (sub0 && sub1) {
          merged.push({ char: '█', color: sub1 });
        } else if (sub0 && !sub1) {
          merged.push({ char: '▄', color: sub0 });
        } else if (!sub0 && sub1) {
          merged.push({ char: '▀', color: sub1 });
        } else {
          merged.push({ char: ' ', color: null });
        }
      }
      // Merge consecutive same-color runs
      const groups = [];
      for (let i = 0; i < merged.length; ) {
        const cur = merged[i];
        let j = i;
        while (j < merged.length && merged[j].color === cur.color && merged[j].char === cur.char) j++;
        groups.push({ color: cur.color, text: cur.char.repeat(j - i) });
        i = j;
      }
      rows.push(groups);
    }

    return (
      <Box flexDirection="column" marginY={0} paddingX={1} gap={0}>
        {config.title && <Text bold color="#cc785c">{config.title} ({config.type})</Text>}
        {rows.map((groups, ri) => (
          <Box key={ri} flexDirection="row" gap={0}>
            {groups.map((g, gi) =>
              g.color === null
                ? <Text key={gi}>{g.text}</Text>
                : <Text key={gi} color={g.color}>{g.text}</Text>
            )}
          </Box>
        ))}
        {slices.map((s, i) => (
          <Box key={i} flexDirection="row" gap={0}>
            <Text color={s.color}>{'█'}</Text>
            <Text color="gray">{' ' + s.label}{s.label ? ': ' : ''}{s.value} ({s.pct}%)</Text>
          </Box>
        ))}
      </Box>
    );
  }

  const labelPad = Math.max(...labels.map(l => l.length), 1);
  const bars = values.map((v, i) => {
    const barLen = Math.round((Math.abs(v) / maxVal) * barMax);
    if (barLen < 1) return null;
    return (
      <Box key={i} flexDirection="row" gap={0}>
        <Text color={colors[i % colors.length]}>{' '.repeat(2)}</Text>
        <Text color={colors[i % colors.length]}>{'▇'.repeat(Math.max(barLen, 1))}</Text>
        <Text color="gray">{' ' + v}</Text>
      </Box>
    );
  }).filter(Boolean);

  return (
    <Box flexDirection="column" marginY={0} paddingX={1} gap={0}>
      {config.title && <Text bold color="#cc785c">{config.title}</Text>}
      {bars}
    </Box>
  );
}

export function RichText({ children }) {
  const text = typeof children === 'string' ? children : String(children ?? '');
  const blocks = parseBlocks(text);

  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => {
        if (block.type === 'code-block') {
          return (
            <Box key={i} flexDirection="column" marginY={0} paddingX={1} borderStyle="round" borderColor="#cc785c">
              {block.lang && (
                <Text color="gray">{block.lang}</Text>
              )}
              {block.text.split('\n').map((line, j) => (
                <CodeLine key={j} line={line} lang={(block.lang || '').toLowerCase()} />
              ))}
            </Box>
          );
        }
        if (block.type === 'chart') {
          return <ChartBlock key={i} config={block.config} />;
        }
        return <RichLine key={i} text={block.text} />;
      })}
    </Box>
  );
}
