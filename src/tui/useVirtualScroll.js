import { useState, useRef, useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

/**
 * Estimated height (rows) for items not yet measured.
 * Intentionally LOW — overestimating causes blank space (viewport shows
 * empty spacer), while underestimating mounts a few extra items (harmless).
 */
const DEFAULT_ESTIMATE = 3;
/** Extra rows rendered above and below the viewport. */
const OVERSCAN_ROWS = 80;
/** Items rendered before the scrollbox has measured viewport height. */
const COLD_START_COUNT = 30;
/**
 * Quantization for useSyncExternalStore snapshot. Without this, every wheel
 * tick triggers a full React commit. Visual scroll stays smooth because
 * the scrollbox reads real scrollTop independently.
 */
const SCROLL_QUANTUM = OVERSCAN_ROWS >> 1;
/** Cap on mounted items to bound fiber allocation in degenerate cases. */
const MAX_MOUNTED_ITEMS = 300;
/**
 * Max new items to mount in a single commit to keep per-frame cost bounded.
 */
const SLIDE_STEP = 25;

const NOOP_UNSUB = () => {};

/**
 * React-level virtualization for items inside a scrollbox.
 *
 * Mounts only items in viewport + overscan. Spacer boxes hold scroll height
 * constant for the rest at O(1) cost each. Height estimation uses a fixed
 * DEFAULT_ESTIMATE for unmeasured items, replaced by real counts after
 * measurement.
 */
export function useVirtualScroll(scrollRef, itemKeys, columns) {
  const heightCache = useRef(new Map());
  const offsetVersionRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const offsetsRef = useRef({ arr: new Float64Array(0), version: -1, n: -1 });
  const itemRefs = useRef(new Map());
  const refCache = useRef(new Map());
  const prevColumns = useRef(columns);
  const skipMeasurementRef = useRef(false);
  const prevRangeRef = useRef(null);
  const freezeRendersRef = useRef(0);
  const listOriginRef = useRef(0);
  const spacerRef = useRef(null);

  // Handle column changes: scale cached heights by ratio
  if (prevColumns.current !== columns) {
    const ratio = prevColumns.current / columns;
    prevColumns.current = columns;
    for (const [k, h] of heightCache.current) {
      heightCache.current.set(k, Math.max(1, Math.round(h * ratio)));
    }
    offsetVersionRef.current++;
    skipMeasurementRef.current = true;
    freezeRendersRef.current = 2;
  }
  const frozenRange = freezeRendersRef.current > 0 ? prevRangeRef.current : null;

  // useSyncExternalStore: quantized scrollTop snapshot for render gating
  const subscribe = useCallback(
    (listener) => scrollRef.current?.subscribe?.(listener) ?? NOOP_UNSUB,
    [scrollRef],
  );
  useSyncExternalStore(subscribe, () => {
    const s = scrollRef.current;
    if (!s) return NaN;
    const target = (s.scrollTop ?? 0) + (s.pendingDelta ?? 0);
    const bin = Math.floor(target / SCROLL_QUANTUM);
    return s.isSticky?.() ? ~bin : bin;
  });

  const scrollTop = scrollRef.current?.scrollTop ?? -1;
  const pendingDelta = scrollRef.current?.pendingDelta ?? 0;
  const viewportH = scrollRef.current?.viewport?.height ?? scrollRef.current?.height ?? 0;
  const isSticky = scrollRef.current?.isSticky?.() ?? true;

  // GC stale cache entries
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useMemo(() => {
    const live = new Set(itemKeys);
    let dirty = false;
    for (const k of heightCache.current.keys()) {
      if (!live.has(k)) { heightCache.current.delete(k); dirty = true; }
    }
    for (const k of refCache.current.keys()) {
      if (!live.has(k)) refCache.current.delete(k);
    }
    if (dirty) offsetVersionRef.current++;
  }, [itemKeys]);

  // Build offsets array
  const n = itemKeys.length;
  if (offsetsRef.current.version !== offsetVersionRef.current || offsetsRef.current.n !== n) {
    const arr = offsetsRef.current.arr.length >= n + 1 ? offsetsRef.current.arr : new Float64Array(n + 1);
    arr[0] = 0;
    for (let i = 0; i < n; i++) {
      arr[i + 1] = arr[i] + (heightCache.current.get(itemKeys[i]) ?? DEFAULT_ESTIMATE);
    }
    offsetsRef.current = { arr, version: offsetVersionRef.current, n };
  }
  const offsets = offsetsRef.current.arr;
  const totalHeight = offsets[n] ?? 0;

  let start, end;

  if (frozenRange) {
    [start, end] = frozenRange;
    start = Math.min(start, n);
    end = Math.min(end, n);
  } else if (viewportH === 0 || scrollTop < 0) {
    start = Math.max(0, n - COLD_START_COUNT);
    end = n;
  } else {
    if (isSticky) {
      const budget = viewportH + OVERSCAN_ROWS;
      start = n;
      while (start > 0 && totalHeight - (offsets[start - 1] ?? 0) < budget) start--;
      end = n;
    } else {
      const listOrigin = listOriginRef.current;
      const effLo = Math.max(0, scrollTop - listOrigin);
      const effHi = (scrollTop + pendingDelta) - listOrigin;
      const lo = Math.max(0, Math.min(effLo, effHi) - OVERSCAN_ROWS);
      // Binary search for start
      {
        let l = 0, r = n;
        while (l < r) {
          const m = (l + r) >> 1;
          if ((offsets[m + 1] ?? Infinity) <= lo) l = m + 1; else r = m;
        }
        start = l;
      }
      // Guard: don't advance past mounted-but-unmeasured items
      {
        const p = prevRangeRef.current;
        if (p && p[0] < start) {
          for (let i = p[0]; i < Math.min(start, p[1]); i++) {
            const k = itemKeys[i];
            if (itemRefs.current.has(k) && !heightCache.current.has(k)) { start = i; break; }
          }
        }
      }
      const needed = viewportH + 2 * OVERSCAN_ROWS;
      const maxEnd = Math.min(n, start + MAX_MOUNTED_ITEMS);
      let coverage = 0;
      end = start;
      while (end < maxEnd && (coverage < needed || (offsets[end] ?? 0) < effHi + viewportH + OVERSCAN_ROWS)) {
        coverage += heightCache.current.get(itemKeys[end]) ?? 1;
        end++;
      }
    }
    // Coverage guarantee
    const needed = viewportH + 2 * OVERSCAN_ROWS;
    const minStart = Math.max(0, end - MAX_MOUNTED_ITEMS);
    let coverage = 0;
    for (let i = start; i < end; i++) coverage += heightCache.current.get(itemKeys[i]) ?? 1;
    while (start > minStart && coverage < needed) {
      start--;
      coverage += heightCache.current.get(itemKeys[start]) ?? 1;
    }
    // Slide cap
    const prev = prevRangeRef.current;
    const scrollVelocity = Math.abs(scrollTop - lastScrollTopRef.current) + Math.abs(pendingDelta);
    if (prev && scrollVelocity > viewportH * 2) {
      const [pS, pE] = prev;
      if (start < pS - SLIDE_STEP) start = pS - SLIDE_STEP;
      if (end > pE + SLIDE_STEP) end = pE + SLIDE_STEP;
      if (start > end) end = Math.min(start + SLIDE_STEP, n);
    }
    lastScrollTopRef.current = scrollTop;
  }

  if (freezeRendersRef.current > 0) {
    freezeRendersRef.current--;
  } else {
    prevRangeRef.current = [start, end];
  }

  // Final clamp
  if (end - start > MAX_MOUNTED_ITEMS) {
    const mid = ((offsets[start] ?? 0) + (offsets[end] ?? 0)) / 2;
    if (scrollTop - listOriginRef.current < mid) {
      end = start + MAX_MOUNTED_ITEMS;
    } else {
      start = end - MAX_MOUNTED_ITEMS;
    }
  }

  const effTopSpacer = offsets[start] ?? 0;
  const effBottomSpacer = totalHeight - (offsets[end] ?? 0);

  // Measure heights from previous render (non-blocking via useLayoutEffect)
  useEffect(() => {
    if (skipMeasurementRef.current) { skipMeasurementRef.current = false; return; }
    let anyChanged = false;
    for (const [key, h] of itemRefs.current) {
      if (h > 0 && heightCache.current.get(key) !== h) {
        heightCache.current.set(key, h);
        anyChanged = true;
      }
    }
    if (anyChanged) offsetVersionRef.current++;
  });

  const measureRef = useCallback((key, height) => {
    if (height != null && height > 0) {
      itemRefs.current.set(key, height);
    } else {
      itemRefs.current.delete(key);
    }
  }, []);

  const scrollToIndex = useCallback((i) => {
    if (i < 0 || i >= n) return;
    scrollRef.current?.scrollTo?.((offsets[i] ?? 0) + listOriginRef.current);
  }, [scrollRef, n, offsets]);

  return {
    range: [start, end],
    topSpacer: effTopSpacer,
    bottomSpacer: effBottomSpacer,
    measureRef,
    spacerRef,
    offsets,
    scrollToIndex,
    totalHeight,
  };
}
