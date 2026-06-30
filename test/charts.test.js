import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chartData, barRows, sparkline, pieRows, pieBraille, CHART_COLORS } from '../src/ui/charts.js';

// ── chartData ─────────────────────────────────────────────────────────────────

test('chartData pulls labels + first dataset values', () => {
  const { labels, values } = chartData({ data: { labels: ['A', 'B'], datasets: [{ data: [1, 2] }] } });
  assert.deepEqual(labels, ['A', 'B']);
  assert.deepEqual(values, [1, 2]);
});

test('chartData tolerates missing data', () => {
  assert.deepEqual(chartData({}), { labels: [], values: [] });
  assert.deepEqual(chartData(undefined), { labels: [], values: [] });
});

// ── barRows ───────────────────────────────────────────────────────────────────

test('barRows scales the largest value to the full width', () => {
  const rows = barRows([10, 30, 20], ['A', 'B', 'C'], 50);
  assert.equal(rows.length, 3);
  // tallest bar is the longest
  assert.ok(rows[1].bar.length > rows[0].bar.length);
  assert.ok(rows[1].bar.length >= rows[2].bar.length);
  assert.equal(rows[0].label, 'A');
  assert.equal(rows[0].color, CHART_COLORS[0]);
});

test('barRows always draws at least one block', () => {
  const rows = barRows([0, 100], [], 50);
  assert.ok(rows[0].bar.length >= 1);
});

// ── sparkline ─────────────────────────────────────────────────────────────────

test('sparkline maps the peak to the tallest glyph', () => {
  const { line } = sparkline([0, 5, 2, 9, 3], [], 50);
  assert.equal(line.length, 5);
  assert.ok(line.includes('█')); // the 9 hits the top glyph
  assert.ok(line.includes('▁')); // the 0 hits the bottom glyph (baseline clamped to 0)
});

// ── pieRows ───────────────────────────────────────────────────────────────────

test('pie slices sum to 100% and carry colors', () => {
  const { slices } = pieRows([50, 30, 20], ['X', 'Y', 'Z'], 50, false);
  assert.equal(slices.length, 3);
  assert.equal(slices.map((s) => s.pct).join(','), '50.0,30.0,20.0');
  assert.equal(slices[0].label, 'X');
  assert.equal(slices[0].color, CHART_COLORS[0]);
});

test('pie produces a square grid of colored runs', () => {
  const { rows } = pieRows([1, 1, 1, 1], [], 50, false);
  assert.ok(rows.length > 0);
  // each row is an array of { color, text } groups
  for (const row of rows) {
    assert.ok(Array.isArray(row));
    for (const g of row) assert.equal(typeof g.text, 'string');
  }
});

test('pieBraille emits braille glyphs and the same slice legend', () => {
  const { rows, slices } = pieBraille([50, 30, 20], ['X', 'Y', 'Z'], 50, false);
  assert.ok(rows.length > 0);
  assert.equal(slices.map((s) => s.pct).join(','), '50.0,30.0,20.0');
  // at least one cell uses a braille glyph (U+2800..U+28FF)
  const anyBraille = rows.some((row) => row.some((g) => [...g.text].some((ch) => ch.charCodeAt(0) >= 0x2800 && ch.charCodeAt(0) <= 0x28ff)));
  assert.ok(anyBraille);
});

test('doughnut carves a hole the pie does not have', () => {
  const filled = (rows) => rows.reduce((n, row) => n + row.filter((g) => g.color).reduce((a, g) => a + g.text.length, 0), 0);
  const pie = pieRows([1, 1, 1, 1], [], 50, false);
  const dough = pieRows([1, 1, 1, 1], [], 50, true);
  assert.ok(filled(dough.rows) < filled(pie.rows));
});
