import { resolve } from 'path';
import { readFileSync, existsSync } from 'fs';
import { LSPClient } from './LSPClient.js';
import { findServerForFile, getLanguageId, isServerInstalled } from './config.js';
import { fileURLToPath, pathToFileURL } from 'url';

export class LSPServerManager {
  constructor(projectRoot) {
    this._projectRoot = projectRoot || process.cwd();
    this._servers = new Map(); // key: command -> { client, langIds }
    this._openDocs = new Map(); // key: filePath -> { uri, client, langId }
  }

  getProjectRoot() { return this._projectRoot; }

  async getServerForFile(filePath) {
    const absPath = resolve(this._projectRoot, filePath);
    const cfg = findServerForFile(absPath);
    if (!cfg) return null;

    const langId = getLanguageId(absPath);
    if (!langId) return null;

    const key = cfg.command;

    // Return existing server for this command
    let entry = this._servers.get(key);
    if (entry) {
      await this._ensureDocumentOpen(absPath, entry.client, langId);
      return entry.client;
    }

    // Check if server is installed
    if (!isServerInstalled(cfg.command)) return null;

    // Start new server
    const rootUri = pathToFileURL(this._projectRoot + '/').href;
    const client = new LSPClient({ command: cfg.command, args: cfg.args, rootUri });
    try {
      await client.start();
    } catch {
      return null;
    }

    entry = { client, langIds: new Set([langId]) };
    this._servers.set(key, entry);

    await this._ensureDocumentOpen(absPath, client, langId);
    return client;
  }

  async _ensureDocumentOpen(absPath, client, langId) {
    if (this._openDocs.has(absPath)) return;
    const uri = pathToFileURL(absPath).href;
    let text = '';
    try {
      if (existsSync(absPath)) text = readFileSync(absPath, 'utf8');
    } catch {}
    await client.openDocument(uri, langId, text);
    this._openDocs.set(absPath, { uri, client, langId });
  }

  async closeAll() {
    for (const { client } of this._servers.values()) {
      await client.shutdown();
    }
    this._servers.clear();
    this._openDocs.clear();
  }

  getStatus() {
    const servers = [];
    for (const [command, entry] of this._servers) {
      servers.push({ command, ready: true, languages: [...entry.langIds] });
    }
    return servers;
  }
}
