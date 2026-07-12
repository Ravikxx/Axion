import { resolve } from 'path';
import { existsSync } from 'fs';
import { LSPServerManager } from './LSPServerManager.js';
import { pathToFileURL } from 'url';

let _manager = null;

export function ensureLspManager(projectRoot) {
  if (!_manager) {
    _manager = new LSPServerManager(projectRoot || process.cwd());
  }
  return _manager;
}

export function getLspManager() {
  return _manager;
}

export async function closeLspManager() {
  if (_manager) {
    await _manager.closeAll();
    _manager = null;
  }
}

function posToLsp(line, col) {
  return { line: Math.max(0, (line || 1) - 1), character: Math.max(0, (col || 1) - 1) };
}

function lspToPos(pos) {
  return { line: pos.line + 1, col: pos.character + 1 };
}

function lspRange(range) {
  if (!range) return null;
  return {
    start: lspToPos(range.start),
    end: lspToPos(range.end),
  };
}

function lspLocation(loc) {
  if (!loc) return null;
  return {
    uri: loc.uri,
    range: lspRange(loc.range),
  };
}

// ── Tool API ──────────────────────────────────────────────────────────────────

export async function goToDefinition(filePath, line, col) {
  const mgr = ensureLspManager();
  const absPath = resolve(mgr.getProjectRoot(), filePath);
  if (!existsSync(absPath)) return { success: false, output: `File not found: ${filePath}` };

  const client = await mgr.getServerForFile(absPath);
  if (!client) return { success: false, output: `No LSP server available for ${filePath}` };

  const uri = pathToFileURL(absPath).href;
  try {
    const result = await client.request('textDocument/definition', {
      textDocument: { uri },
      position: posToLsp(line, col),
    });
    if (!result) return { success: true, output: 'No definition found.' };
    const locs = Array.isArray(result) ? result : [result];
    return {
      success: true,
      output: locs.map(l => `${l.uri.replace(/^file:\/\//, '')}:${(l.range?.start?.line || 0) + 1}:${(l.range?.start?.character || 0) + 1}`).join('\n'),
      locations: locs.map(lspLocation),
    };
  } catch (err) {
    return { success: false, output: `LSP error: ${err.message}` };
  }
}

export async function findReferences(filePath, line, col) {
  const mgr = ensureLspManager();
  const absPath = resolve(mgr.getProjectRoot(), filePath);
  if (!existsSync(absPath)) return { success: false, output: `File not found: ${filePath}` };

  const client = await mgr.getServerForFile(absPath);
  if (!client) return { success: false, output: `No LSP server available for ${filePath}` };

  const uri = pathToFileURL(absPath).href;
  try {
    const result = await client.request('textDocument/references', {
      textDocument: { uri },
      position: posToLsp(line, col),
      context: { includeDeclaration: true },
    });
    if (!result || !result.length) return { success: true, output: 'No references found.' };
    return {
      success: true,
      output: result.map(l => `${l.uri.replace(/^file:\/\//, '')}:${(l.range?.start?.line || 0) + 1}`).join('\n'),
      locations: result.map(lspLocation),
    };
  } catch (err) {
    return { success: false, output: `LSP error: ${err.message}` };
  }
}

export async function hover(filePath, line, col) {
  const mgr = ensureLspManager();
  const absPath = resolve(mgr.getProjectRoot(), filePath);
  if (!existsSync(absPath)) return { success: false, output: `File not found: ${filePath}` };

  const client = await mgr.getServerForFile(absPath);
  if (!client) return { success: false, output: `No LSP server available for ${filePath}` };

  const uri = pathToFileURL(absPath).href;
  try {
    const result = await client.request('textDocument/hover', {
      textDocument: { uri },
      position: posToLsp(line, col),
    });
    if (!result || !result.contents) return { success: true, output: 'No hover information.' };
    const contents = typeof result.contents === 'string'
      ? result.contents
      : Array.isArray(result.contents)
        ? result.contents.map(c => typeof c === 'string' ? c : c.value || '').join('\n')
        : result.contents.value || JSON.stringify(result.contents);
    return { success: true, output: contents };
  } catch (err) {
    return { success: false, output: `LSP error: ${err.message}` };
  }
}

export async function documentSymbol(filePath) {
  const mgr = ensureLspManager();
  const absPath = resolve(mgr.getProjectRoot(), filePath);
  if (!existsSync(absPath)) return { success: false, output: `File not found: ${filePath}` };

  const client = await mgr.getServerForFile(absPath);
  if (!client) return { success: false, output: `No LSP server available for ${filePath}` };

  const uri = pathToFileURL(absPath).href;
  try {
    const result = await client.request('textDocument/documentSymbol', {
      textDocument: { uri },
    });
    if (!result || !result.length) return { success: true, output: 'No symbols found.' };

    const flat = [];
    const walk = (items, depth) => {
      for (const item of items) {
        if (item.name) {
          flat.push('  '.repeat(depth) + `${_symbolKind(item.kind)} ${item.name} — ${item.range ? `line ${item.range.start.line + 1}` : '?'}`);
        }
        if (item.children) walk(item.children, depth + 1);
      }
    };
    walk(result, 0);
    return { success: true, output: flat.join('\n'), symbols: result };
  } catch (err) {
    return { success: false, output: `LSP error: ${err.message}` };
  }
}

export async function workspaceSymbol(query) {
  const mgr = ensureLspManager();
  const servers = mgr._servers;
  if (!servers || !servers.size) return { success: false, output: 'No LSP servers are active.' };

  const results = [];
  for (const [, entry] of servers) {
    try {
      const symbols = await entry.client.request('workspace/symbol', { query });
      if (symbols) results.push(...symbols);
    } catch {}
  }
  if (!results.length) return { success: true, output: 'No matching symbols found.' };
  return {
    success: true,
    output: results.map(s => `${_symbolKind(s.kind)} ${s.name}${s.containerName ? ` (in ${s.containerName})` : ''} — ${s.location.uri.replace(/^file:\/\//, '')}:${(s.location.range?.start?.line || 0) + 1}`).join('\n'),
    symbols: results,
  };
}

export async function callHierarchy(filePath, line, col) {
  const mgr = ensureLspManager();
  const absPath = resolve(mgr.getProjectRoot(), filePath);
  if (!existsSync(absPath)) return { success: false, output: `File not found: ${filePath}` };

  const client = await mgr.getServerForFile(absPath);
  if (!client) return { success: false, output: `No LSP server available for ${filePath}` };

  const uri = pathToFileURL(absPath).href;
  try {
    const prep = await client.request('textDocument/prepareCallHierarchy', {
      textDocument: { uri },
      position: posToLsp(line, col),
    });
    if (!prep) return { success: true, output: 'No call hierarchy available at this position.' };
    const items = Array.isArray(prep) ? prep : [prep];

    const parts = [];
    for (const item of items) {
      const inc = await client.request('callHierarchy/incomingCalls', { item });
      const outg = await client.request('callHierarchy/outgoingCalls', { item });
      const lines = [`${_symbolKind(item.kind)} ${item.name} (${item.uri.replace(/^file:\/\//, '')}:${(item.range?.start?.line || 0) + 1})`];
      if (inc?.length) {
        lines.push('  Called by:');
        for (const call of inc.slice(0, 10)) {
          lines.push(`    ${_symbolKind(call.from?.kind || 0)} ${call.from?.name} — ${call.from?.uri?.replace(/^file:\/\//, '')}:${(call.from?.range?.start?.line || 0) + 1}`);
        }
      }
      if (outg?.length) {
        lines.push('  Calls:');
        for (const call of outg.slice(0, 10)) {
          lines.push(`    ${_symbolKind(call.to?.kind || 0)} ${call.to?.name} — ${call.to?.uri?.replace(/^file:\/\//, '')}:${(call.to?.range?.start?.line || 0) + 1}`);
        }
      }
      parts.push(lines.join('\n'));
    }
    return { success: true, output: parts.join('\n\n') || 'No hierarchy data.', hierarchy: items };
  } catch (err) {
    return { success: false, output: `LSP error: ${err.message}` };
  }
}

// ── Symbol kind names (LSP SymbolKind) ──────────────────────────────────────

function _symbolKind(k) {
  const kinds = {
    1: 'File', 2: 'Module', 3: 'Namespace', 4: 'Package', 5: 'Class',
    6: 'Method', 7: 'Property', 8: 'Field', 9: 'Constructor', 10: 'Enum',
    11: 'Interface', 12: 'Function', 13: 'Variable', 14: 'Constant',
    15: 'String', 16: 'Number', 17: 'Boolean', 18: 'Array',
    19: 'Object', 20: 'Key', 21: 'Null', 22: 'EnumMember',
    23: 'Struct', 24: 'Event', 25: 'Operator', 26: 'TypeParameter',
  };
  return kinds[k] || 'Symbol';
}
