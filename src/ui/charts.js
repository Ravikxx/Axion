// Framework-free chart geometry for terminal charts. Both the Ink and OpenTUI
// renderers turn a Chart.js-style config — { type, title, data: { labels,
// datasets: [{ data }] } } — into these plain descriptors and draw them with
// their own text/box primitives. Keeping the math here makes it testable.

export const CHART_COLORS = [
  '#e8602c', '#34d399', '#60a5fa', '#f59e0b', '#a78bfa', '#f472b6', '#14b8a6', '#f97316',
];

const color = (i) => CHART_COLORS[i % CHART_COLORS.length];

// Pull labels + the first dataset's values out of a Chart.js-style config.
export function chartData(config) {
  const ds = config?.data?.datasets?.[0];
  return { labels: config?.data?.labels || [], values: (ds?.data ?? []).map((v) => (typeof v === 'object' ? v : Number(v))) };
}

// Horizontal bar chart → one row per value.
export function barRows(values, labels = [], width = 50) {
  const nums = values.map((v) => (typeof v === 'number' ? v : 0));
  const maxVal = Math.max(...nums.map(Math.abs), 1);
  const barMax = Math.max(width - 20, 10);
  return nums.map((v, i) => {
    const len = Math.round((Math.abs(v) / maxVal) * barMax);
    return { color: color(i), bar: '▇'.repeat(Math.max(len, 1)), value: v, label: labels[i] || '' };
  });
}

// Line chart → a unicode sparkline string + sampled points for the legend.
const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
export function sparkline(values, labels = [], width = 50) {
  const nums = values.map((v) => (typeof v === 'number' ? v : 0));
  const n = Math.max(1, Math.min(nums.length, width - 4));
  const step = Math.max(1, Math.floor(nums.length / n));
  const sampled = nums.filter((_, i) => i % step === 0 || i === nums.length - 1);
  const sMax = Math.max(...sampled, 1);
  const sMin = Math.min(...sampled, 0);
  const range = sMax - sMin || 1;
  const line = sampled.map((v) => SPARK[Math.min(Math.max(Math.round(((v - sMin) / range) * 7), 0), 7)]).join('');
  const idxStep = Math.max(1, Math.floor(sampled.length / 6));
  const points = sampled
    .map((v, i) => ({ label: labels[i] || '', value: v, i }))
    .filter((p) => p.i % idxStep === 0 || p.i === sampled.length - 1);
  return { line, points };
}

// Braille bit per (dx 0..1, dy 0..3) sub-dot within a cell (Unicode U+2800 base).
const BRAILLE_DOTS = [
  [0x01, 0x02, 0x04, 0x40], // left column:  dots 1,2,3,7
  [0x08, 0x10, 0x20, 0x80], // right column: dots 4,5,6,8
];

// Pie / doughnut rendered with braille — 2×4 sub-dots per character cell. Those
// dots are ~square in a 2:1 terminal cell, so the circle's edge is much rounder
// than the half-block version. Each cell takes the dominant slice color of its
// lit dots. Returns rows of colored runs (same shape as pieRows) + the legend.
export function pieBraille(values, labels = [], width = 50, doughnut = false) {
  const nums = values.map((v) => (typeof v === 'number' ? Math.abs(v) : 0));
  const total = nums.reduce((a, b) => a + b, 0) || 1;
  const R = Math.min(Math.max(Math.round(width * 0.38), 11), 20); // radius in dots
  const holeR = doughnut ? R * 0.45 : 0;
  const diam = R * 2 + 1;
  const cellsW = Math.ceil(diam / 2);
  const cellsH = Math.ceil(diam / 4);

  let cum = Math.PI / 2;
  const slices = nums.map((v, i) => {
    const a = (v / total) * 2 * Math.PI;
    const s = { start: cum, end: cum + a, color: color(i), label: labels[i] || '', value: values[i], pct: ((v / total) * 100).toFixed(1) };
    cum += a;
    return s;
  });
  const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const sliceColor = (x, yUp) => {
    const a = norm(Math.atan2(yUp, x));
    for (const s of slices) {
      const sA = norm(s.start), sB = norm(s.end);
      if (sA < sB ? (a >= sA && a < sB) : (a >= sA || a < sB)) return s.color;
    }
    return slices[slices.length - 1].color;
  };

  const rows = [];
  for (let cy = 0; cy < cellsH; cy++) {
    const cells = [];
    for (let cx = 0; cx < cellsW; cx++) {
      let bits = 0;
      const tally = {};
      for (let dx = 0; dx < 2; dx++) {
        for (let dy = 0; dy < 4; dy++) {
          const x = (cx * 2 + dx) - R;
          const y = (cy * 4 + dy) - R; // screen y (down-positive)
          const d2 = x * x + y * y;
          if (d2 <= R * R && d2 >= holeR * holeR) {
            bits |= BRAILLE_DOTS[dx][dy];
            const c = sliceColor(x, -y); // flip to math up-positive for the angle
            tally[c] = (tally[c] || 0) + 1;
          }
        }
      }
      if (!bits) { cells.push({ color: null, char: ' ' }); continue; }
      let best = null, bestN = -1;
      for (const c in tally) if (tally[c] > bestN) { bestN = tally[c]; best = c; }
      cells.push({ color: best, char: String.fromCharCode(0x2800 + bits) });
    }
    // merge consecutive same-color cells into runs (concatenate their glyphs)
    const groups = [];
    for (let i = 0; i < cells.length; ) {
      const cur = cells[i];
      let j = i, text = '';
      while (j < cells.length && cells[j].color === cur.color) { text += cells[j].char; j++; }
      groups.push({ color: cur.color, text });
      i = j;
    }
    rows.push(groups);
  }
  return { rows, slices };
}

// Pie / doughnut → rows of colored half-block runs + a legend of slices.
// Rendered with the same sub-pixel (▀▄█) trick the Ink version uses so the
// circle looks round despite the 2:1 character aspect ratio.
export function pieRows(values, labels = [], width = 50, doughnut = false) {
  const nums = values.map((v) => (typeof v === 'number' ? Math.abs(v) : 0));
  const total = nums.reduce((a, b) => a + b, 0) || 1;
  const AR = 2;
  const R = Math.min(Math.max(5, Math.floor(width / 5)), 10);
  const diam = R * 2 + 1;
  const holeR = doughnut ? R * 0.3 : 0;

  let cumAngle = Math.PI / 2;
  const slices = nums.map((v, i) => {
    const a = (v / total) * 2 * Math.PI;
    const s = { start: cumAngle, end: cumAngle + a, color: color(i), label: labels[i] || '', value: values[i], pct: ((v / total) * 100).toFixed(1) };
    cumAngle += a;
    return s;
  });

  const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
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
    for (let sub = 0; sub < 2; sub++) {
      for (let px = 0; px < diam; px++) {
        const x = px - R;
        const y = (R - py) + (sub === 0 ? -0.25 : 0.25);
        const d2 = x * x + (y * AR) * (y * AR);
        const edge = R + 0.5;
        if (d2 > edge * edge || d2 < holeR * holeR) runs.push(null);
        else runs.push(sliceAt(x, y).color);
      }
    }
    const top = runs.slice(0, diam), bot = runs.slice(diam);
    const merged = [];
    for (let i = 0; i < diam; i++) {
      const sub0 = top[i], sub1 = bot[i];
      if (sub0 && sub1)       merged.push({ char: '█', color: sub1 });
      else if (sub0 && !sub1) merged.push({ char: '▄', color: sub0 });
      else if (!sub0 && sub1) merged.push({ char: '▀', color: sub1 });
      else                    merged.push({ char: ' ', color: null });
    }
    // merge consecutive same-color/char runs into spans
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
  return { rows, slices };
}
