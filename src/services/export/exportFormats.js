// Session Export — multi-format conversation export.
// Mirrors openclaudeAX/src/utils/exportFormats.ts and exportRenderer.ts.
import { extname, isAbsolute, join, dirname } from 'path';

export const ExportFormat = { TEXT: 'text', MARKDOWN: 'markdown', JSON: 'json' };

export function normalizeExportFormat(value) {
  if (!value) return null;
  const lower = String(value).toLowerCase().trim();
  switch (lower) {
    case 'text': case 'txt':       return ExportFormat.TEXT;
    case 'markdown': case 'md':   return ExportFormat.MARKDOWN;
    case 'json':                  return ExportFormat.JSON;
    default: return null;
  }
}

export function inferExportFormatFromFilename(filename) {
  const ext = extname(filename);
  if (!ext || ext === '.') return null;
  return normalizeExportFormat(ext.slice(1));
}

export function extensionForExportFormat(format) {
  switch (format) {
    case ExportFormat.TEXT:     return '.txt';
    case ExportFormat.MARKDOWN: return '.md';
    case ExportFormat.JSON:    return '.json';
    default: return '.txt';
  }
}

export function ensureExportFilenameExtension(filename, format, { preserveMarkdownExtension = false } = {}) {
  const ext = extensionForExportFormat(format);
  const currentExt = extname(filename);
  if (format === ExportFormat.MARKDOWN && preserveMarkdownExtension && currentExt.toLowerCase() === '.markdown') {
    return filename;
  }
  const base = currentExt
    ? filename.slice(0, currentExt === '.' ? -1 : -currentExt.length)
    : filename;
  return base + ext;
}

export function resolveExportFilepath(cwd, filename) {
  return isAbsolute(filename) ? filename : join(cwd, filename);
}

const SUPPORTED_FORMATS = 'Supported formats: text, markdown, json.';

function tokenizeExportArgs(args) {
  const tokens = [];
  let current = '';
  let quote = null;
  let tokenStarted = false;
  let tokenQuoted = false;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (quote === '"' && ch === '\\' && i + 1 < args.length) {
        const next = args[i + 1];
        if (next === '"' || next === '\\') { current += next; i += 1; continue; }
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; tokenStarted = true; tokenQuoted = true; continue; }
    if (/\s/.test(ch)) {
      if (tokenStarted) { tokens.push({ value: current, quoted: tokenQuoted }); current = ''; tokenStarted = false; tokenQuoted = false; }
      continue;
    }
    current += ch;
    tokenStarted = true;
  }
  if (quote) return { tokens, error: 'Unterminated quoted string in /export arguments.' };
  if (tokenStarted) tokens.push({ value: current, quoted: tokenQuoted });
  return { tokens };
}

export function parseExportArgs(args) {
  const tokenized = tokenizeExportArgs(args || '');
  if (tokenized.error) return { error: tokenized.error };
  const tokens = tokenized.tokens;
  if (!tokens.length) return {};
  let format;
  let error;
  const filenameTokens = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.quoted && token.value === '--') {
      filenameTokens.push(...tokens.slice(i + 1).map(t => t.value));
      break;
    }
    if (!token.quoted && (token.value === '--format' || token.value === '-f')) {
      const value = tokens[++i]?.value;
      if (!value) { error = `Missing value for ${token.value}. ${SUPPORTED_FORMATS}`; break; }
      const normalized = normalizeExportFormat(value);
      if (!normalized) { error = `Unsupported export format: ${value}. ${SUPPORTED_FORMATS}`; break; }
      format = normalized;
    } else if (!token.quoted && token.value.startsWith('-') && token.value !== '-') {
      error = `Unsupported export option: ${token.value}. Supported options: --format, -f.`;
      break;
    } else {
      filenameTokens.push(token.value);
    }
  }
  const filename = filenameTokens.length > 0 ? filenameTokens.join(' ') : undefined;
  if (error) return { filename, format, error };
  return { filename, format };
}

// Sanitize first user message into a clean base filename.
export function sanitizeFilename(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function extractFirstPrompt(messages) {
  const firstUser = messages.find(m => m.role === 'user' || m.type === 'user');
  if (!firstUser) return '';
  const content = firstUser.content || firstUser.text || '';
  let result = (typeof content === 'string' ? content : String(content)).trim();
  result = result.split('\n')[0] || '';
  if (result.length > 50) result = result.substring(0, 49) + '…';
  return result;
}