// Render the message stream to text, markdown, or JSON for export.
// Mirrors openclaudeAX/src/utils/exportRenderer.ts.

const ROLE_LABEL = {
  user: 'User',
  assistant: 'Assistant',
  system: 'System',
  tool: 'Tool',
  plan: 'Plan',
};

function messageContent(m) {
  if (typeof m.content === 'string') return m.content;
  if (m.text) return m.text;
  if (Array.isArray(m.content)) {
    return m.content
      .filter(c => c.type === 'text' && c.text)
      .map(c => c.text)
      .join('\n');
  }
  return '';
}

function toolSummary(m) {
  // Tool-call/result messages in our display layer (App.jsx) carry
  // {tool, input, output} fields. Preserve them on export.
  if (m.tool) return `\`\`\`json\n{"tool": ${JSON.stringify(m.tool)}, "input": ${JSON.stringify(m.input || null)}, "output": ${JSON.stringify(m.output || null)}}\n\`\`\``;
  return '';
}

export function renderText(messages) {
  return messages.map(m => {
    const role = ROLE_LABEL[m.role] || m.role || ROLE_LABEL[m.type] || m.type || 'Message';
    const body = messageContent(m) || toolSummary(m);
    return `── ${role} ─────────────────────────────────\n${body}\n`;
  }).join('\n');
}

export function renderMarkdown(messages) {
  const lines = ['# Conversation', ''];
  for (const m of messages) {
    const role = ROLE_LABEL[m.role] || m.role || ROLE_LABEL[m.type] || m.type || 'Message';
    const body = messageContent(m) || toolSummary(m);
    lines.push(`## ${role}`, '');
    if (body) { lines.push(body, ''); }
  }
  return lines.join('\n');
}

export function renderJson(messages) {
  return JSON.stringify(
    messages.map(m => ({
      role: m.role || m.type || 'message',
      content: messageContent(m),
      ...(m.tool ? { tool: m.tool, input: m.input, output: m.output } : {}),
      ...(m.timestamp ? { timestamp: m.timestamp } : {}),
    })),
    null, 2,
  );
}

export function renderMessagesForExport(messages, { format } = {}) {
  switch (format) {
    case 'markdown': return renderMarkdown(messages);
    case 'json':     return renderJson(messages);
    case 'text':     return renderText(messages);
    default:         return renderText(messages);
  }
}