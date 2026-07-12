// Context Priority Partitioning — zone-based message retention for smart context management.
// Splits conversation history into priority zones with configurable token budgets and
// retention policies. Lightweight and instant — no LLM call required.

import { estimateTokens } from '../utils/tokenEstimate.js';
import { CONTEXT_ZONES } from '../config.js';

const DEFAULT_ZONES = CONTEXT_ZONES;

const IMPORTANT_KEYWORDS = ['error', 'fail', 'important', 'warning', 'critical'];
const RECENT_COUNT = 6;

function extractText(msg) {
  if (msg == null) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map(b => b.text || '').join(' ');
  }
  return '';
}

function classifyMessage(msg, isRecent) {
  if (msg.role === 'system') return 'system';

  const text = extractText(msg);

  if (IMPORTANT_KEYWORDS.some(kw => text.toLowerCase().includes(kw))) return 'important';

  if (text.length > 2000) return 'important';
  if (msg.role === 'assistant' && Array.isArray(msg.content) && msg.content.some(b => b.type === 'tool_use')) return 'important';

  if (isRecent) return 'recent';

  return 'background';
}

function tokenEstimate(msg) {
  return estimateTokens(extractText(msg));
}

export function partitionContext(messages, options = {}) {
  const contextWindow = options.contextWindow || 128000;
  const zones = options.zones || DEFAULT_ZONES;
  const recentCount = options.recentCount || RECENT_COUNT;
  const systemPromptTokens = options.systemPromptTokens || 0;

  const zoneMap = new Map();
  const zoneTokens = new Map();
  for (const z of zones) {
    zoneMap.set(z.name, []);
    zoneTokens.set(z.name, 0);
  }

  const recentSlice = messages.slice(-recentCount);
  const olderSlice  = messages.slice(0, -recentCount);

  for (const msg of recentSlice) {
    const zone = classifyMessage(msg, true);
    const arr = zoneMap.get(zone);
    arr.push(msg);
    zoneTokens.set(zone, zoneTokens.get(zone) + tokenEstimate(msg));
  }

  for (const msg of olderSlice) {
    const zone = classifyMessage(msg, false);
    const cfg = zones.find(z => z.name === zone);
    if (!cfg) continue;

    if (cfg.retainPolicy === 'keep_all' || zone === 'system') {
      zoneMap.get(zone).push(msg);
      zoneTokens.set(zone, zoneTokens.get(zone) + tokenEstimate(msg));
    } else if (zone === 'important' && zoneTokens.get('important') < cfg.maxTokens) {
      zoneMap.get('important').push(msg);
      zoneTokens.set('important', zoneTokens.get('important') + tokenEstimate(msg));
    } else if (zone === 'background' && zoneTokens.get('background') < cfg.maxTokens) {
      zoneMap.get('background').push(msg);
      zoneTokens.set('background', zoneTokens.get('background') + tokenEstimate(msg));
    }
  }

  const totalTokens = systemPromptTokens + Array.from(zoneTokens.values()).reduce((a, b) => a + b, 0);
  const canFitInWindow = totalTokens <= contextWindow;

  return { zones: zoneMap, totalTokens, zoneTokens, canFitInWindow };
}

export function getAllPartitionedMessages(context) {
  const out = [];
  for (const [name, msgs] of context.zones) {
    if (name === 'system') continue;
    out.push(...msgs);
  }
  return out;
}

export function getAvailableSpace(context, contextWindow) {
  return Math.max(0, contextWindow - context.totalTokens);
}
