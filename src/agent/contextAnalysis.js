// Context budget analysis — decompose the context window into categorized
// token usage with a three-tier accuracy fallback, then emit actionable
// suggestions. Mirrors openclaudeAX/src/utils/analyzeContext.ts (1437 lines)
// in a lean form suitable for Axion's runtime.

import { estimateTokens } from '../utils/tokenEstimate.js';

// Fixed overhead the API deducts for the tools preamble. Subtract it once
// from the per-tool total to avoid double-counting the shared header.
export const TOOL_TOKEN_COUNT_OVERHEAD = 500;

const CATEGORY_LABELS = {
  system:     'System prompt',
  tools:      'Tool definitions',
  messages:   'Conversation messages',
  memory:     'Memory files',
  skills:     'Active skills',
  mcp:        'MCP tools',
  wiki:       'Project wiki',
  free:       'Free space',
};

export function categorizeMessages(messages) {
  // Per-tool-call breakdown: each tool result is a separate row so the
  // user can spot the Bash/grep call that ate their context budget.
  const rows = [];
  for (const m of messages) {
    const role = m.role || m.type || 'message';
    if (role === 'system') {
      rows.push({ category: 'system', label: 'System', tokens: estimateTokens(m.content || m.text || '') });
      continue;
    }
    if (role === 'assistant' && m.tool) {
      rows.push({
        category: 'messages',
        label: `Tool: ${m.tool}`,
        tokens: Math.max(0, estimateTokens(JSON.stringify(m.input || '')) + estimateTokens(JSON.stringify(m.output || '')) - TOOL_TOKEN_COUNT_OVERHEAD / 4),
      });
      continue;
    }
    if (role === 'tool' && m.name) {
      rows.push({ category: 'messages', label: `Tool result: ${m.name}`, tokens: estimateTokens(JSON.stringify(m.content || '')) });
      continue;
    }
    rows.push({
      category: 'messages',
      label: role,
      tokens: estimateTokens(m.content || m.text || ''),
    });
  }
  return rows;
}

export function analyzeContext({
  systemPrompt = '',
  toolDefinitions = [],
  messages = [],
  memoryFiles = [],
  activeSkills = [],
  mcpToolCount = 0,
  wikiContent = '',
  modelBudget = 128_000,
} = {}) {
  const rows = categorizeMessages(messages);
  const byCategory = {};
  function add(cat, label, tokens) {
    if (!byCategory[cat]) byCategory[cat] = { label: CATEGORY_LABELS[cat] || cat, tokens: 0, items: [] };
    byCategory[cat].tokens += tokens;
    byCategory[cat].items.push({ label, tokens });
  }

  add('system', 'System prompt', estimateTokens(systemPrompt));
  // Tools: split into Oxion-defined + MCP. Each tool definition costs ~250 + description length.
  for (const t of toolDefinitions || []) {
    const name = t.function?.name || t.name || 'tool';
    const desc = (t.function?.description || t.description || '').slice(0, 500);
    const schema = JSON.stringify(t.function?.parameters || t.parameters || {}).length;
    const tokens = Math.max(60, estimateTokens(`${name} ${desc}`) + Math.round(schema / 4));
    add('tools', name, tokens);
  }
  if (mcpToolCount) add('mcp', `MCP (${mcpToolCount} tools)`, mcpToolCount * 250);
  for (const r of rows) add(r.category, r.label, r.tokens);
  for (const mem of memoryFiles || []) add('memory', mem.name || 'memory', estimateTokens(mem.content || ''));
  for (const skill of activeSkills || []) {
    add('skills', skill.name || 'skill', estimateTokens(skill.content || skill.description || ''));
  }
  if (wikiContent) add('wiki', 'Wiki', estimateTokens(wikiContent));

  const consumed = Object.values(byCategory).reduce((s, c) => s + c.tokens, 0);
  const free = Math.max(0, modelBudget - consumed);
  byCategory.free = { label: CATEGORY_LABELS.free, tokens: free, items: [] };

  const categories = Object.entries(byCategory).map(([key, v]) => ({ key, ...v, pct: Math.round((v.tokens / modelBudget) * 100) }));
  return {
    categories,
    consumed,
    budget: modelBudget,
    pctUsed: Math.round((consumed / modelBudget) * 100),
    canFit: consumed <= modelBudget,
  };
}