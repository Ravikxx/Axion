// Generate prioritized, actionable suggestions based on the context
// breakdown. Mirrors openclaudeAX/src/utils/contextSuggestions.ts.

const BY_SEVERITY = { warning: 0, info: 1 };

function sortSuggestions(list) {
  return list.sort((a, b) => {
    const s = BY_SEVERITY[a.severity] - BY_SEVERITY[b.severity];
    if (s !== 0) return s;
    return (b.savings || 0) - (a.savings || 0);
  });
}

export function generateContextSuggestions(analysis, { autoCompactEnabled = true } = {}) {
  const out = [];
  const { categories, budget, pctUsed } = analysis;

  if (pctUsed >= 80) {
    out.push({
      severity: 'warning',
      message: `Context is ${pctUsed}% full (${analysis.consumed}/${budget} tokens). Consider /compact or starting a new chat.`,
      savings: Math.round(analysis.consumed * 0.5),
    });
  }

  for (const cat of categories) {
    if (cat.key === 'free' || cat.key === 'system') continue;
    if (cat.pct >= 15) {
      let hint;
      if (cat.key === 'tools') {
        hint = `${cat.label} using ${cat.tokens} tokens (${cat.pct}%). Disable unused tools or MCP servers.`;
      } else if (cat.key === 'messages') {
        const row = cat.items.find(i => i.label?.startsWith('Tool result') || i.label === 'tool');
        if (row) {
          hint = `Tool results using ${cat.tokens} tokens — pipe heavy command output through head/tail/grep.`;
        } else {
          hint = `${cat.label} using ${cat.tokens} tokens (${cat.pct}%). /compact will summarize older messages.`;
        }
      } else if (cat.key === 'memory') {
        hint = `${cat.label} using ${cat.tokens} tokens. Prune memories with /forget.`;
      } else if (cat.key === 'skills') {
        hint = `${cat.label} using ${cat.tokens} tokens. Some skills may auto-deactivate.`;
      } else {
        hint = `${cat.label} using ${cat.tokens} tokens (${cat.pct}%).`;
      }
      out.push({ severity: 'warning', message: hint, savings: Math.round(cat.tokens * 0.6) });
    }
  }

  if (pctUsed >= 50 && !autoCompactEnabled) {
    out.push({
      severity: 'info',
      message: 'Auto-compact is disabled — context will keep growing.',
    });
  }

  return sortSuggestions(out);
}