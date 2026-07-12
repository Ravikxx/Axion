import React, { useCallback, useRef, useEffect, useImperativeHandle, useState } from 'react';
import { useVirtualScroll } from './useVirtualScroll.js';
import { extractSearchText, computeMatches, warmSearchIndex, findNearestMatch } from './transcriptSearch.js';

const HEADROOM = 3;

/**
 * Imperative handle for transcript navigation.
 */
export const JumpHandle = {
  jumpToIndex: () => {},
  setSearchQuery: () => {},
  nextMatch: () => {},
  prevMatch: () => {},
  setAnchor: () => {},
  warmSearchIndex: () => Promise.resolve(0),
  disarmSearch: () => {},
};

/**
 * Virtualized message list for the scrollbox. Renders only visible items
 * with top/bottom spacers to maintain scroll height.
 *
 * Props:
 * - messages: array of message objects
 * - scrollRef: ref to the scrollbox
 * - columns: terminal width (for height invalidation on resize)
 * - itemKey: function(message) => string key
 * - renderItem: function(message, index) => ReactNode
 * - onItemClick: optional click handler
 * - onSearchMatchesChange: fires when match count/current changes
 */
export function VirtualMessageList({
  messages,
  scrollRef,
  columns,
  itemKey,
  renderItem,
  onItemClick,
  onSearchMatchesChange,
}) {
  // Incremental key array — append-only for streaming
  const keysRef = useRef([]);
  const prevMessagesRef = useRef(messages);
  const prevItemKeyRef = useRef(itemKey);
  if (!prevItemKeyRef.current || prevItemKeyRef.current !== itemKey || messages.length < keysRef.current.length || messages[0] !== prevMessagesRef.current[0]) {
    keysRef.current = messages.map((m) => itemKey(m));
  } else {
    for (let i = keysRef.current.length; i < messages.length; i++) {
      keysRef.current.push(itemKey(messages[i]));
    }
  }
  prevMessagesRef.current = messages;
  prevItemKeyRef.current = itemKey;
  const keys = keysRef.current;

  const {
    range,
    topSpacer,
    bottomSpacer,
    measureRef,
    spacerRef,
    offsets,
    scrollToIndex,
    totalHeight,
  } = useVirtualScroll(scrollRef, keys, columns);

  const [start, end] = range;

  // ── Search state ───────────────────────────────────────────────────────
  const searchState = useRef({
    matches: [],
    ptr: 0,
    screenOrd: 0,
    prefixSum: [],
  });
  const searchAnchor = useRef(-1);
  const indexWarmed = useRef(false);

  // Compute scroll target for message i
  function targetFor(i) {
    return Math.max(0, (offsets[i] ?? 0) - HEADROOM);
  }

  // Seek + step logic refs
  const stepRef = useRef(() => {});
  const pendingStepRef = useRef(0);

  function step(delta) {
    const st = searchState.current;
    const { matches, prefixSum } = st;
    const total = prefixSum[prefixSum.length - 1] ?? 0;
    if (matches.length === 0) return;

    const newOrd = st.screenOrd + delta;
    if (newOrd >= 0 && newOrd < (st.lastPositionCount ?? 1)) {
      st.screenOrd = newOrd;
      onSearchMatchesChange?.(total, (prefixSum[st.ptr] ?? 0) + newOrd + 1);
      return;
    }

    // Advance ptr
    const ptr = (st.ptr + delta + matches.length) % matches.length;
    st.ptr = ptr;
    st.screenOrd = 0;
    scrollToIndex(matches[ptr] ?? 0);
    const placeholder = delta < 0 ? (prefixSum[ptr + 1] ?? total) : (prefixSum[ptr] ?? 0) + 1;
    onSearchMatchesChange?.(total, placeholder);
  }
  stepRef.current = step;

  // Expose jump handle
  useImperativeHandle(
    useRef({}),
    () => ({
      jumpToIndex(i) {
        scrollToIndex(i);
      },
      setSearchQuery(q) {
        const { matches, prefixSum, total } = computeMatches(messages, q);
        let ptr = 0;
        if (matches.length > 0 && searchAnchor.current >= 0) {
          // Find nearest match to anchor
          ptr = findNearestMatch(matches, offsets, searchAnchor.current, start);
        }
        searchState.current = { matches, ptr, screenOrd: 0, prefixSum, lastPositionCount: 1 };
        if (matches.length > 0) {
          scrollToIndex(matches[ptr] ?? 0);
        }
        onSearchMatchesChange?.(total, matches.length > 0 ? (prefixSum[ptr + 1] ?? total) : 0);
      },
      nextMatch: () => step(1),
      prevMatch: () => step(-1),
      setAnchor: () => {
        const s = scrollRef.current;
        if (s) searchAnchor.current = s.scrollTop ?? 0;
      },
      disarmSearch: () => {},
      warmSearchIndex: () => warmSearchIndex(messages),
    }),
    [scrollRef, messages, offsets, start, onSearchMatchesChange],
  );

  return (
    <>
      <box ref={spacerRef} style={{ height: topSpacer, flexShrink: 0 }} />
      {messages.slice(start, end).map((msg, i) => {
        const idx = start + i;
        const k = keys[idx];
        return (
          <box key={k} ref={(el) => {
            if (el) {
              // Measure height by counting rendered lines
              const h = el.height ?? el?.props?.style?.height ?? DEFAULT_ESTIMATE;
              measureRef(k, h > 0 ? h : undefined);
            }
          }} style={{ flexDirection: 'column' }}>
            {renderItem(msg, idx)}
          </box>
        );
      })}
      {bottomSpacer > 0 && <box style={{ height: bottomSpacer, flexShrink: 0 }} />}
    </>
  );
}

const DEFAULT_ESTIMATE = 3;
