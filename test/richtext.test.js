import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInline, parseBlocks } from '../src/ui/RichText.jsx';

// ── parseInline ───────────────────────────────────────────────────────────────

test('plain text produces a single plain token', () => {
  assert.deepEqual(parseInline('hello'), [{ type: 'plain', text: 'hello' }]);
});

test('empty string produces no tokens', () => {
  assert.deepEqual(parseInline(''), []);
});

test('bold **text**', () => {
  assert.deepEqual(parseInline('**bold**'), [{ type: 'bold', text: 'bold' }]);
});

test('italic *text*', () => {
  assert.deepEqual(parseInline('*italic*'), [{ type: 'italic', text: 'italic' }]);
});

test('inline code `text`', () => {
  assert.deepEqual(parseInline('`code`'), [{ type: 'code', text: 'code' }]);
});

test('bold takes precedence over italic (** consumed before *)', () => {
  const tokens = parseInline('**strong**');
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].type, 'bold');
});

test('mixed: plain + bold + plain', () => {
  const tokens = parseInline('hello **world** bye');
  assert.equal(tokens.length, 3);
  assert.deepEqual(tokens[0], { type: 'plain',  text: 'hello '  });
  assert.deepEqual(tokens[1], { type: 'bold',   text: 'world'   });
  assert.deepEqual(tokens[2], { type: 'plain',  text: ' bye'    });
});

test('multiple inline tokens of different kinds', () => {
  const tokens = parseInline('*a* and `b`');
  assert.equal(tokens.length, 3);
  assert.equal(tokens[0].type, 'italic');
  assert.equal(tokens[1].type, 'plain');
  assert.equal(tokens[2].type, 'code');
});

test('unclosed marker treated as plain text', () => {
  const tokens = parseInline('**unclosed');
  assert.ok(tokens.every(t => t.type === 'plain'));
});

// ── parseBlocks ───────────────────────────────────────────────────────────────

test('plain text lines become line blocks', () => {
  const blocks = parseBlocks('foo\nbar');
  assert.equal(blocks.length, 2);
  assert.ok(blocks.every(b => b.type === 'line'));
  assert.equal(blocks[0].text, 'foo');
  assert.equal(blocks[1].text, 'bar');
});

test('empty string produces one empty line block', () => {
  const blocks = parseBlocks('');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'line');
  assert.equal(blocks[0].text, '');
});

test('fenced code block is a code-block entry', () => {
  const blocks = parseBlocks('```\nconsole.log(1)\n```');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'code-block');
  assert.equal(blocks[0].text, 'console.log(1)');
  assert.equal(blocks[0].lang, null);
});

test('fenced code block with language tag', () => {
  const blocks = parseBlocks('```js\nconst x = 1;\n```');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].lang, 'js');
  assert.equal(blocks[0].text, 'const x = 1;');
});

test('multi-line code block', () => {
  const blocks = parseBlocks('```\nline1\nline2\n```');
  assert.equal(blocks[0].text, 'line1\nline2');
});

test('text before and after a code block', () => {
  const blocks = parseBlocks('before\n```\ncode\n```\nafter');
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].type, 'line');
  assert.equal(blocks[0].text, 'before');
  assert.equal(blocks[1].type, 'code-block');
  assert.equal(blocks[2].type, 'line');
  assert.equal(blocks[2].text, 'after');
});

test('unterminated fence consumes remaining lines as code', () => {
  const blocks = parseBlocks('```\ncode\nmore code');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'code-block');
  assert.equal(blocks[0].text, 'code\nmore code');
});

test('indented fence opener is recognised', () => {
  const blocks = parseBlocks('  ```\ncode\n  ```');
  assert.equal(blocks[0].type, 'code-block');
});

// ── Chart blocks ────────────────────────────────────────────────────────────────

test('chart code block produces chart block', () => {
  const blocks = parseBlocks('```chart\n{"type":"pie","data":{"datasets":[{"data":[1,2]}]}}\n```');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'chart');
  assert.equal(blocks[0].config.type, 'pie');
});

test('chart block parses datasets array', () => {
  const blocks = parseBlocks('```chart\n{"type":"bar","data":{"labels":["A","B"],"datasets":[{"data":[3,7]}]}}\n```');
  assert.equal(blocks[0].config.data.datasets[0].data[0], 3);
  assert.equal(blocks[0].config.data.labels[0], 'A');
});

test('chart block with invalid JSON falls back to code-block', () => {
  const blocks = parseBlocks('```chart\n{invalid json}\n```');
  assert.equal(blocks[0].type, 'code-block');
  assert.equal(blocks[0].text, '{invalid json}');
});

test('chart block with missing datasets field still parses as chart (chart block can handle at render)', () => {
  const blocks = parseBlocks('```chart\n{"type":"line","data":{"labels":[]}}\n```');
  assert.equal(blocks[0].type, 'chart');
  assert.equal(blocks[0].config.type, 'line');
});

test('text before and after chart block', () => {
  const blocks = parseBlocks('before\n```chart\n{"type":"pie","data":{"datasets":[{"data":[1]}]}}\n```\nafter');
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].type, 'line');
  assert.equal(blocks[1].type, 'chart');
  assert.equal(blocks[2].type, 'line');
});
