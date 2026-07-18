import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ellipsize, fitTableColumnWidths, maxTableColumns, visibleTabWindow } from '../src/tui/layout.js';
import { decodeSessionMouse } from '../src/tui/sessionPickerInput.js';

test('ellipsize preserves short labels and bounds long labels', () => {
  assert.equal(ellipsize('chat', 8), 'chat');
  assert.equal(ellipsize('a very long tab', 6), 'a ver…');
});

test('fitTableColumnWidths keeps the complete table inside max width', () => {
  const widths = fitTableColumnWidths([60, 60], 80);
  const completeWidth = widths.reduce((sum, width) => sum + width, 0) + 3 * widths.length + 1;
  assert.ok(completeWidth <= 80, `${completeWidth} columns exceeds the 80-column limit`);
  assert.deepEqual(fitTableColumnWidths([3, 5], 80), [3, 5]);
  const visibleColumns = maxTableColumns(20);
  assert.ok(4 * visibleColumns + 1 <= 20);
});

test('visibleTabWindow stays within width and always includes the active tab', () => {
  for (const width of [20, 40, 80, 120]) {
    for (const active of [0, 9, 19]) {
      const layout = visibleTabWindow(20, active, width);
      assert.ok(layout.start <= active && active < layout.end);
      const count = layout.end - layout.start;
      const markers = (layout.start > 0 ? 1 : 0) + (layout.end < 20 ? 1 : 0);
      const worstCaseWidth = 7 + markers + count * (9 + layout.titleWidth);
      assert.ok(worstCaseWidth <= Math.max(20, width), `${worstCaseWidth} > ${width}`);
    }
  }
});

test('decodeSessionMouse reads X10 row from Cy and activates left clicks', () => {
  const packet = Buffer.from([27, 91, 77, 32, 42, 36]); // left click, x=10, y=4 => row 1
  assert.deepEqual(decodeSessionMouse(packet), { handled: true, row: 1 });
});

test('decodeSessionMouse accepts SGR press and ignores its release', () => {
  assert.deepEqual(decodeSessionMouse(Buffer.from('\x1b[<0;10;5M')), { handled: true, row: 2 });
  assert.deepEqual(decodeSessionMouse(Buffer.from('\x1b[<0;10;5m')), { handled: true, row: null });
});
