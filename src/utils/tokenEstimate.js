// Lightweight token estimation — approximate without a tokenizer.
// Heuristic: ~4 chars per token, floor of 1.

const CHARS_PER_TOKEN = 4;
const IMAGE_TOKEN_COST = 258;
const MSG_OVERHEAD = 4;
const TOOL_OVERHEAD = 10;

export function estimateTokens(input) {
  if (input == null) return 0;
  const len = typeof input === 'string' ? input.length : String(input).length;
  return Math.max(1, Math.round(len / CHARS_PER_TOKEN));
}

export function estimateMessages(messages) {
  if (!messages?.length) return 0;
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') total += estimateTokens(block.text);
        else if (block.type === 'image') total += IMAGE_TOKEN_COST;
      }
    }
    total += MSG_OVERHEAD;
  }
  return total;
}

export function estimateTools(tools) {
  if (!tools?.length) return 0;
  let total = 0;
  for (const t of tools) {
    const name = t.function?.name || t.name || '';
    const desc = t.function?.description || t.description || '';
    const params = t.function?.parameters ? JSON.stringify(t.function.parameters) : '';
    total += estimateTokens(name) + estimateTokens(desc) + estimateTokens(params);
  }
  return total + tools.length * TOOL_OVERHEAD;
}

export function estimateSystemPrompt(text) {
  return estimateTokens(text);
}

export function estimateRequest({ system, messages, tools }) {
  return estimateSystemPrompt(system) + estimateMessages(messages) + estimateTools(tools);
}

// Format token count for display (e.g., "1.2K", "34K")
export function formatTokens(count) {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
  return String(count);
}

// Rough cost estimate in USD given per-million-token rates
export function estimateCost(inputTokens, outputTokens, rates = { input: 3, output: 15 }) {
  const inputCost = (inputTokens / 1000000) * rates.input;
  const outputCost = (outputTokens / 1000000) * rates.output;
  return inputCost + outputCost;
}
