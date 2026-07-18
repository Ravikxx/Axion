export function ellipsize(text, maxWidth) {
  const value = String(text ?? '');
  const width = Math.max(1, Math.floor(maxWidth || 1));
  if (value.length <= width) return value;
  if (width === 1) return '…';
  return `${value.slice(0, width - 1)}…`;
}

// Fit intrinsic table column widths inside a complete table width. A table has
// two padding cells per column, one outer border on each side, and n-1 inner
// separators: 3*n + 1 columns of non-content overhead.
export function fitTableColumnWidths(intrinsicWidths, maxTableWidth) {
  const widths = intrinsicWidths.map((w) => Math.max(1, Math.floor(w || 1)));
  if (!widths.length) return [];

  const overhead = 3 * widths.length + 1;
  const contentBudget = Math.max(widths.length, Math.floor(maxTableWidth || overhead) - overhead);
  const fitted = widths.map(() => 1);
  let remaining = contentBudget - fitted.length;

  // Water-fill columns evenly, stopping a column once it reaches its intrinsic
  // width. Terminal widths keep this loop small and predictable.
  while (remaining > 0) {
    let changed = false;
    for (let i = 0; i < fitted.length && remaining > 0; i++) {
      if (fitted[i] >= widths[i]) continue;
      fitted[i]++;
      remaining--;
      changed = true;
    }
    if (!changed) break;
  }
  return fitted;
}

export function maxTableColumns(maxTableWidth) {
  // A one-character column still needs two padding cells plus its share of
  // borders/separators, so n columns require at least 4*n + 1 cells.
  return Math.max(1, Math.floor((Math.max(5, maxTableWidth) - 1) / 4));
}

export function visibleTabWindow(tabCount, activeIndex, terminalWidth) {
  if (tabCount <= 0) return { start: 0, end: 0, titleWidth: 3 };
  const width = Math.max(20, Math.floor(terminalWidth || 80));
  const reserved = 7; // left pad + “+ new”
  const targetTabWidth = 18; // favor readable titles; overflow tabs stay reachable by cycling
  const maxVisible = Math.max(1, Math.min(tabCount, Math.floor((width - reserved - 2) / targetTabWidth)));
  const safeActive = Math.min(Math.max(0, activeIndex), tabCount - 1);
  let start = Math.max(0, safeActive - Math.floor(maxVisible / 2));
  start = Math.min(start, tabCount - maxVisible);
  const end = start + maxVisible;
  const hiddenMarkerWidth = (start > 0 ? 1 : 0) + (end < tabCount ? 1 : 0);
  const perTab = Math.floor((width - reserved - hiddenMarkerWidth) / maxVisible);
  return { start, end, titleWidth: Math.max(2, Math.min(16, perTab - 9)) };
}
