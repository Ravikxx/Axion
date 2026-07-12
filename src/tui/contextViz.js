// /context command — render the context breakdown as a half-block grid and
// list actionable suggestions. Mirrors openclaudeAX/src/components/ContextVisualization.tsx.

import { analyzeContext } from '../agent/contextAnalysis.js';
import { generateContextSuggestions } from './contextSuggestions.js';
import { formatTokens } from '../utils/tokenEstimate.js';

const HALF = ['▀', '▄', '█'];

function bar(pct) {
  const width = 28;
  const filled = Math.min(width, Math.max(0, Math.round((pct / 100) * width)));
  return HALF[2].repeat(filled) + ' '.repeat(width - filled);
}

export async function renderContextBreakdown({
  systemPrompt = '',
  toolDefinitions = [],
  messages = [],
  memoryFiles = [],
  activeSkills = [],
  mcpToolCount = 0,
  wikiContent = '',
  modelBudget,
  autoCompactEnabled = true,
}) {
  const analysis = analyzeContext({
    systemPrompt, toolDefinitions, messages, memoryFiles,
    activeSkills, mcpToolCount, wikiContent, modelBudget,
  });
  const suggestions = generateContextSuggestions(analysis, { autoCompactEnabled });

  const lines = [];
  lines.push('Context budget breakdown', '');
  lines.push(`Total used: ${formatTokens(analysis.consumed)} / ${formatTokens(analysis.budget)} (${analysis.pctUsed}%)  [${analysis.canFit ? 'fits' : 'OVER'}]`);
  lines.push('');

  for (const cat of analysis.categories) {
    lines.push(`${cat.label.padEnd(20)} ${formatTokens(cat.tokens).padStart(8)}  ${cat.pct}%  ${bar(cat.pct)}`);
    if (cat.items && cat.items.length > 1) {
      const top = cat.items.slice().sort((a, b) => b.tokens - a.tokens).slice(0, 3);
      for (const it of top) {
        const ipct = Math.round((it.tokens / analysis.budget) * 100);
        lines.push(`    ├ ${it.label.padEnd(16)} ${formatTokens(it.tokens).padStart(8)}  ${ipct}%`);
      }
    }
  }
  lines.push('');

  if (suggestions.length) {
    lines.push('Suggestions:');
    for (const s of suggestions) {
      const tag = s.severity === 'warning' ? '⚠' : '·';
      const save = s.savings ? ` (save ~${formatTokens(s.savings)})` : '';
      lines.push(`  ${tag} ${s.message}${save}`);
    }
  } else {
    lines.push('Context utilization looks healthy.');
  }

  return { text: lines.join('\n'), analysis, suggestions };
}