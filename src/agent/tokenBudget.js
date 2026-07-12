// Token Budget System — parse user-specified budget from natural language
// ("+500k", "+2m", "use 2M tokens") and drive autonomous continuation until
// the budget is met. Mirrors openclaudeAX/src/utils/tokenBudget.ts and
// src/query/tokenBudget.ts.

const SHORTHAND_START_RE = /^\s*\+(\d+(?:\.\d+)?)\s*(k|m|b)\b/i
const SHORTHAND_END_RE = /\s\+(\d+(?:\.\d+)?)\s*(k|m|b)\s*[.!?]?\s*$/i
const VERBOSE_RE = /\b(?:use|spend)\s+(\d+(?:\.\d+)?)\s*(k|m|b)\s*tokens?\b/i
const VERBOSE_RE_G = new RegExp(VERBOSE_RE.source, 'gi')

const MULTIPLIERS = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }

function parseBudgetMatch(value, suffix) {
  return parseFloat(value) * MULTIPLIERS[suffix.toLowerCase()]
}

export function parseTokenBudget(text) {
  if (!text || typeof text !== 'string') return null
  const startMatch = text.match(SHORTHAND_START_RE)
  if (startMatch) return parseBudgetMatch(startMatch[1], startMatch[2])
  const endMatch = text.match(SHORTHAND_END_RE)
  if (endMatch) return parseBudgetMatch(endMatch[1], endMatch[2])
  const verboseMatch = text.match(VERBOSE_RE)
  if (verboseMatch) return parseBudgetMatch(verboseMatch[1], verboseMatch[2])
  return null
}

export function findTokenBudgetPositions(text) {
  const positions = []
  const startMatch = text.match(SHORTHAND_START_RE)
  if (startMatch) {
    const offset =
      startMatch.index +
      startMatch[0].length -
      startMatch[0].trimStart().length
    positions.push({ start: offset, end: startMatch.index + startMatch[0].length })
  }
  const endMatch = text.match(SHORTHAND_END_RE)
  if (endMatch) {
    const endStart = endMatch.index + 1
    const alreadyCovered = positions.some(p => endStart >= p.start && endStart < p.end)
    if (!alreadyCovered) {
      positions.push({ start: endStart, end: endMatch.index + endMatch[0].length })
    }
  }
  for (const match of text.matchAll(VERBOSE_RE_G)) {
    positions.push({ start: match.index, end: match.index + match[0].length })
  }
  return positions
}

export function stripTokenBudget(text) {
  const positions = findTokenBudgetPositions(text)
  if (!positions.length) return text
  let out = ''
  let cursor = 0
  for (const { start, end } of positions.sort((a, b) => a.start - b.start)) {
    out += text.slice(cursor, start)
    cursor = end
  }
  out += text.slice(cursor)
  return out.replace(/\s{2,}/g, ' ').trim()
}

const COMPLETION_THRESHOLD = 0.9
const DIMINISHING_THRESHOLD = 500

export function createBudgetTracker() {
  return {
    continuationCount: 0,
    lastDeltaTokens: 0,
    lastGlobalTurnTokens: 0,
    startedAt: Date.now(),
  }
}

const fmt = n => new Intl.NumberFormat('en-US').format(n)

export function getBudgetContinuationMessage(pct, turnTokens, budget) {
  return `Stopped at ${pct}% of token target (${fmt(turnTokens)} / ${fmt(budget)}). Keep working — do not summarize.`
}

// Per-turn decision; subagents always stop (no budget continuation).
export function checkTokenBudget(tracker, agentId, budget, globalTurnTokens) {
  if (agentId || budget === null || budget <= 0) {
    return { action: 'stop', completionEvent: null }
  }
  const turnTokens = globalTurnTokens
  const pct = Math.round((turnTokens / budget) * 100)
  const deltaSinceLastCheck = globalTurnTokens - tracker.lastGlobalTurnTokens

  const isDiminishing =
    tracker.continuationCount >= 3 &&
    deltaSinceLastCheck < DIMINISHING_THRESHOLD &&
    tracker.lastDeltaTokens < DIMINISHING_THRESHOLD

  if (!isDiminishing && turnTokens < budget * COMPLETION_THRESHOLD) {
    tracker.continuationCount++
    tracker.lastDeltaTokens = deltaSinceLastCheck
    tracker.lastGlobalTurnTokens = globalTurnTokens
    return {
      action: 'continue',
      nudgeMessage: getBudgetContinuationMessage(pct, turnTokens, budget),
      continuationCount: tracker.continuationCount,
      pct, turnTokens, budget,
    }
  }

  if (isDiminishing || tracker.continuationCount > 0) {
    return {
      action: 'stop',
      completionEvent: {
        continuationCount: tracker.continuationCount,
        pct, turnTokens, budget,
        diminishingReturns: isDiminishing,
        durationMs: Date.now() - tracker.startedAt,
      },
    }
  }
  return { action: 'stop', completionEvent: null }
}