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
      blocks.push({ type: 'code-block', lang, text: codeLines.join('\n') });
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
        return <RichLine key={i} text={block.text} />;
      })}
    </Box>
  );
}
