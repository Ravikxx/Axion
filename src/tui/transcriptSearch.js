/**
 * Incremental transcript search utilities.
 *
 * Provides search index warming (pre-extract text for fast per-keystroke
 * matching), debounced query processing, and anchor-based search that
 * snaps back when matches drop to zero.
 */

/**
 * Extract searchable text from a message. Cached per-message via WeakMap.
 */
const lowerCache = new WeakMap();
export function extractSearchText(msg) {
  const cached = lowerCache.get(msg);
  if (cached !== undefined) return cached;
  let text = '';
  if (msg.type === 'tool') {
    const input = typeof msg.input === 'string' ? msg.input : JSON.stringify(msg.input || {});
    const output = typeof msg.output === 'string' ? msg.output : JSON.stringify(msg.output || '');
    text = [msg.name, msg.label, input, output].filter(Boolean).join(' ');
  } else if (msg.type === 'subagent-run') {
    text = [msg.label, msg.role, msg.task, msg.result].filter(Boolean).join(' ');
  } else {
    text = msg.text || '';
  }
  const lowered = text.toLowerCase();
  lowerCache.set(msg, lowered);
  return lowered;
}

/**
 * Warm the search index by pre-extracting text for all messages.
 * Yields between chunks to avoid blocking the main thread.
 * Returns elapsed ms.
 */
export async function warmSearchIndex(messages, chunkSize = 500) {
  const wallStart = performance.now();
  let workMs = 0;
  for (let i = 0; i < messages.length; i += chunkSize) {
    await new Promise((r) => setTimeout(r, 0));
    const t0 = performance.now();
    const end = Math.min(i + chunkSize, messages.length);
    for (let j = i; j < end; j++) {
      extractSearchText(messages[j]);
    }
    workMs += performance.now() - t0;
  }
  return Math.round(performance.now() - wallStart);
}

/**
 * Compute search matches for a query against messages.
 * Returns { matches, prefixSum, total } where:
 * - matches: array of message indices that contain the query
 * - prefixSum: cumulative occurrence count per match (for "3/47" display)
 * - total: total occurrence count across all messages
 */
export function computeMatches(messages, query, extractText = extractSearchText) {
  const lq = query.toLowerCase();
  const matches = [];
  const prefixSum = [0];
  if (lq) {
    for (let i = 0; i < messages.length; i++) {
      const text = extractText(messages[i]);
      let pos = text.indexOf(lq);
      let cnt = 0;
      while (pos >= 0) { cnt++; pos = text.indexOf(lq, pos + lq.length); }
      if (cnt > 0) {
        matches.push(i);
        prefixSum.push(prefixSum[prefixSum.length - 1] + cnt);
      }
    }
  }
  return { matches, prefixSum, total: prefixSum[prefixSum.length - 1] ?? 0 };
}

/**
 * Create a debounced search function.
 * Returns { setQuery, cancel } where setQuery updates the query and fires
 * the callback after delayMs of inactivity.
 */
export function createDebouncedSearch(callback, delayMs = 100) {
  let timer = null;
  return {
    setQuery(q) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; callback(q); }, delayMs);
    },
    cancel() {
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}

/**
 * Find nearest match to an anchor scroll position.
 * Returns the index into matches[] of the closest message.
 */
export function findNearestMatch(matches, offsets, anchor, start) {
  if (matches.length === 0) return 0;
  const firstTop = offsets[start] ?? 0;
  let best = Infinity;
  let ptr = 0;
  for (let k = 0; k < matches.length; k++) {
    const d = Math.abs(firstTop + (offsets[matches[k]] ?? 0) - anchor);
    if (d <= best) { best = d; ptr = k; }
  }
  return ptr;
}
