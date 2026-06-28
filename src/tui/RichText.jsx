import React from 'react';
import { accent } from '../ui/theme.js';
import { parseInline, parseBlocks, highlightLine } from '../ui/markdown.js';

// OpenTUI markdown renderer. Shares the parser with the Ink version; renders via
// OpenTUI text/span/strong/em + box. Headings, bold/italic/inline-code, lists,
// blockquotes, rules, and syntax-highlighted code fences. (Charts → code fallback.)

const CODE_COLORS = {
  comment: '#6e7681',
  string:  '#7ee787',
  keyword: '#d2a8ff',
  number:  '#f0c674',
  fn:      '#79c0ff',
  plain:   undefined,
};

const HEAD_COLORS = { 1: '#cc785c', 2: '#cc785c', 3: '#b08869' };

function Inline({ tokens, force }) {
  // force: optional { color, bold } applied to every token (used by headings)
  return tokens.map((tok, i) => {
    const color = force?.color;
    if (tok.type === 'bold' || force?.bold) {
      return <strong key={i}>{color ? <span fg={color}>{tok.text}</span> : tok.text}</strong>;
    }
    if (tok.type === 'italic') return <em key={i}>{tok.text}</em>;
    if (tok.type === 'code')   return <span key={i} fg={accent()}>{tok.text}</span>;
    return color ? <span key={i} fg={color}>{tok.text}</span> : <span key={i}>{tok.text}</span>;
  });
}

function Line({ text }) {
  if (text.trim() === '') return <text> </text>;

  // Headings
  let m;
  if ((m = text.match(/^(#{1,3}) (.*)/))) {
    const level = m[1].length;
    return <text><Inline tokens={parseInline(m[2])} force={{ color: HEAD_COLORS[level], bold: true }} /></text>;
  }
  // Horizontal rule
  if (/^[-*_]{3,}$/.test(text.trim())) {
    return <text><span fg="#444">{'─'.repeat(40)}</span></text>;
  }
  // Unordered list
  if (/^(\s*)[*\-+] /.test(text)) {
    const indent = text.match(/^(\s*)/)[1].length;
    const content = text.replace(/^\s*[*\-+] /, '');
    return (
      <text>
        <span fg="#888">{'  '.repeat(Math.floor(indent / 2)) + '• '}</span>
        <Inline tokens={parseInline(content)} />
      </text>
    );
  }
  // Ordered list
  if ((m = text.match(/^(\s*)(\d+)\. (.*)/))) {
    const indent = m[1].length;
    return (
      <text>
        <span fg="#888">{'  '.repeat(Math.floor(indent / 2)) + m[2] + '. '}</span>
        <Inline tokens={parseInline(m[3])} />
      </text>
    );
  }
  // Blockquote
  if (text.startsWith('> ')) {
    return (
      <text>
        <span fg="#888">{'│ '}</span>
        <span fg="#888"><Inline tokens={parseInline(text.slice(2))} /></span>
      </text>
    );
  }
  // Plain paragraph
  return <text><Inline tokens={parseInline(text)} /></text>;
}

function CodeBlock({ lang, text }) {
  const lc = (lang || '').toLowerCase();
  return (
    <box style={{ flexDirection: 'column', border: true, borderColor: accent(), paddingLeft: 1, paddingRight: 1, marginTop: 0 }}>
      {lang ? <text><span fg="#888">{lang}</span></text> : null}
      {text.split('\n').map((line, j) => (
        line.trim() === ''
          ? <text key={j}> </text>
          : <text key={j}>
              {highlightLine(line, lc).map((tok, i) => {
                const c = CODE_COLORS[tok.type];
                return c ? <span key={i} fg={c}>{tok.text}</span> : <span key={i}>{tok.text}</span>;
              })}
            </text>
      ))}
    </box>
  );
}

export function RichText({ children }) {
  const text = typeof children === 'string' ? children : String(children ?? '');
  const blocks = parseBlocks(text);
  return (
    <box style={{ flexDirection: 'column' }}>
      {blocks.map((block, i) => {
        if (block.type === 'code-block') return <CodeBlock key={i} lang={block.lang} text={block.text} />;
        if (block.type === 'chart')      return <CodeBlock key={i} lang={block.config?.type || 'chart'} text={JSON.stringify(block.config, null, 2)} />;
        return <Line key={i} text={block.text} />;
      })}
    </box>
  );
}
