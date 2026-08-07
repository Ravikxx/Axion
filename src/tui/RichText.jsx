import React from 'react';
import { accent } from '../ui/theme.js';
import { parseInline, parseBlocks, highlightLine } from '../ui/markdown.js';
import { chartData, barRows, sparkline, pieBraille } from '../ui/charts.js';
import { ellipsize, fitTableColumnWidths, maxTableColumns } from './layout.js';

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

// Terminal charts from a ```chart fenced JSON block (Chart.js-style config).
// Supports bar (default), pie/doughnut, line (sparkline), scatter, and radar.
function ChartBlock({ config }) {
  const width = Math.min(Math.max(((process.stdout.columns || 80) - 36), 24), 54);
  const { labels, values } = chartData(config || {});
  const title = config?.title;
  const Title = title ? <text><span fg="#cc785c">{`${title}${config.type ? ` (${config.type})` : ''}`}</span></text> : null;
  if (!values.length) return <text><span fg="#888">(empty chart)</span></text>;

  if (config.type === 'line') {
    const { line, points } = sparkline(values, labels, width);
    return (
      <box style={{ flexDirection: 'column', paddingLeft: 1 }}>
        {Title}
        <text><span fg="#60a5fa">{line}</span></text>
        <text><span fg="#888">{points.map((p) => (p.label ? `${p.label}=${p.value}` : `${p.value}`)).join(', ')}</span></text>
      </box>
    );
  }

  if (config.type === 'scatter') {
    const pts = values;
    const isObj = pts[0] && typeof pts[0] === 'object' && 'x' in pts[0];
    return (
      <box style={{ flexDirection: 'column', paddingLeft: 1 }}>
        {Title}
        {pts.map((p, i) => (
          <text key={i}><span fg="#888">{`(${isObj ? p.x : i}, ${isObj ? p.y : p})`}</span></text>
        ))}
      </box>
    );
  }

  if (config.type === 'pie' || config.type === 'doughnut') {
    const { rows, slices } = pieBraille(values, labels, width, config.type === 'doughnut');
    return (
      <box style={{ flexDirection: 'column', paddingLeft: 1 }}>
        {Title}
        {rows.map((groups, ri) => (
          <text key={ri}>{groups.map((g, gi) => (g.color ? <span key={gi} fg={g.color}>{g.text}</span> : <span key={gi}>{g.text}</span>))}</text>
        ))}
        {slices.map((s, i) => (
          <text key={i}><span fg={s.color}>█</span><span fg="#888">{` ${s.label}${s.label ? ': ' : ''}${s.value} (${s.pct}%)`}</span></text>
        ))}
      </box>
    );
  }

  // bar (default) + radar fall back to horizontal bars
  const bars = barRows(values, labels, width);
  return (
    <box style={{ flexDirection: 'column', paddingLeft: 1 }}>
      {Title}
      {bars.map((b, i) => (
        <text key={i}>
          <span fg={b.color}>{`  ${b.bar}`}</span>
          <span fg="#888">{` ${b.label ? `${b.label}=` : ''}${b.value}`}</span>
        </text>
      ))}
    </box>
  );
}

// Strip markdown inline markers to get the visible display length of a cell.
function displayLen(text) {
  return text.replace(/\*\*(.+?)\*\*|\*(.+?)\*|`([^`\n]+)`/g, (_, b, i, c) => (b || i || c)).length;
}

function displayText(text) {
  return text.replace(/\*\*(.+?)\*\*|\*(.+?)\*|`([^`\n]+)`/g, (_, b, i, c) => (b || i || c));
}

function fitCell(text, width) {
  return displayLen(text) <= width ? text : ellipsize(displayText(text), width);
}

function TableBlock({ headers, rows, align, maxWidth }) {
  const numCols = Math.min(headers.length, maxTableColumns(maxWidth));
  const hiddenCols = headers.length - numCols;
  const tableHeaders = headers.slice(0, numCols);
  const tableRows = rows.map((row) => row.slice(0, numCols));
  const tableAlign = align.slice(0, numCols);
  if (hiddenCols > 0) tableHeaders[numCols - 1] = `${tableHeaders[numCols - 1] || ''} …`;

  // Compute max display width per column from the visible (marker-stripped) length.
  const intrinsicWidths = Array(numCols).fill(0);
  for (const row of [tableHeaders, ...tableRows]) {
    for (let c = 0; c < numCols; c++) {
      intrinsicWidths[c] = Math.max(intrinsicWidths[c], displayLen(row[c] || ''));
    }
  }
  const colWidths = fitTableColumnWidths(intrinsicWidths, maxWidth);

  // Each cell gets 1-char left/right padding inside the box-drawing border.
  const cellTotal = colWidths.map((w) => w + 2);
  // Build a separator line between header and body with alignment colons.
  const hdrSep = cellTotal.map((w, ci) => {
    const a = tableAlign[ci] || 'left';
    if (a === 'center') return '─'.repeat(Math.floor((w - 2) / 2)) + ':' + '─'.repeat(Math.ceil((w - 2) / 2));
    if (a === 'right')  return '─'.repeat(w - 1) + ':';
    return '─'.repeat(w);
  });

  // Render a single row's cells (header or data) with inline formatting.
  const RowCells = ({ cells, force }) => {
    const children = ['│'];
    cells.forEach((rawCell, ci) => {
      const cell = fitCell(rawCell || '', colWidths[ci]);
      const visLen = displayLen(cell);
      const w = colWidths[ci];
      const a = tableAlign[ci] || 'left';
      let leftSp, rightSp;
      if (a === 'right')      { leftSp = 1 + w - visLen;  rightSp = 1; }
      else if (a === 'center') { const e = w - visLen; leftSp = 1 + Math.floor(e / 2); rightSp = 1 + Math.ceil(e / 2); }
      else                     { leftSp = 1;              rightSp = 1 + w - visLen; }
      children.push(' '.repeat(leftSp));
      children.push(<Inline key={`c${ci}`} tokens={parseInline(cell)} force={force} />);
      children.push(' '.repeat(rightSp));
      if (ci < cells.length - 1) children.push('│');
    });
    children.push('│');
    return children;
  };

  return (
    <box style={{ flexDirection: 'column', paddingLeft: 1, marginTop: 0 }}>
      {/* Top border */}
      <text>{'┌' + cellTotal.map((w) => '─'.repeat(w)).join('┬') + '┐'}</text>
      {/* Header row (bold) */}
      <text><RowCells cells={tableHeaders} force={{ bold: true }} /></text>
      {/* Header/body separator */}
      <text>{'├' + hdrSep.join('┼') + '┤'}</text>
      {/* Data rows */}
      {tableRows.map((row, ri) => (
        <text key={ri}><RowCells cells={row} /></text>
      ))}
      {/* Bottom border */}
      <text>{'└' + cellTotal.map((w) => '─'.repeat(w)).join('┴') + '┘'}</text>
    </box>
  );
}

export function RichText({ children, maxWidth = Math.max(20, (process.stdout.columns || 80) - 4) }) {
  const text = typeof children === 'string' ? children : String(children ?? '');
  const blocks = parseBlocks(text);
  return (
    <box style={{ flexDirection: 'column' }}>
      {blocks.map((block, i) => {
        if (block.type === 'code-block') return <CodeBlock key={i} lang={block.lang} text={block.text} />;
        if (block.type === 'chart')      return <ChartBlock key={i} config={block.config} />;
        if (block.type === 'table')      return <TableBlock key={i} headers={block.headers} rows={block.rows} align={block.align} maxWidth={maxWidth} />;
        return <Line key={i} text={block.text} />;
      })}
    </box>
  );
}
