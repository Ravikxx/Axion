import { spawn } from 'child_process';
import { createInterface } from 'readline';

export class LSPClient {
  constructor({ command, args, rootUri }) {
    this._command = command;
    this._args = args || [];
    this._rootUri = rootUri || 'file://' + process.cwd();
    this._proc = null;
    this._pending = new Map();
    this._reqId = 0;
    this._closed = false;
    this._initPromise = null;
  }

  async start() {
    if (this._proc) return;
    this._proc = spawn(this._command, this._args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const rl = createInterface({ input: this._proc.stdout, crlfDelay: Infinity });
    let buffer = '';

    rl.on('line', (line) => {
      buffer += line + '\n';
      if (line.trim() === '' && buffer.includes('Content-Length:')) {
        const match = buffer.match(/Content-Length: (\d+)/);
        if (match) {
          const len = parseInt(match[1], 10);
          const headerEnd = buffer.indexOf('\r\n\r\n') + 4;
          const body = buffer.slice(headerEnd).trim();
          if (body.length >= len) {
            try {
              this._handleResponse(JSON.parse(body.slice(0, len)));
            } catch {}
            buffer = body.slice(len);
          } else {
            // Wait for more data
          }
        } else {
          buffer = '';
        }
      }
    });

    this._proc.on('error', () => this._close());
    this._proc.on('exit', () => this._close());

    // Initialize
    this._initPromise = this._initialize();
    return this._initPromise;
  }

  async _initialize() {
    const capabilities = {
      capabilities: {
        textDocument: {
          synchronization: { didOpen: true, didChange: false, willSave: false, didSave: false, didClose: true },
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          hover: { dynamicRegistration: false },
          documentSymbol: { dynamicRegistration: false },
          workspaceSymbol: { dynamicRegistration: false },
          implementation: { dynamicRegistration: false },
          callHierarchy: { dynamicRegistration: false },
        },
      },
    };

    const result = await this.request('initialize', { ...capabilities, rootUri: this._rootUri, processId: process.pid });
    await this.notify('initialized', {});
    return result;
  }

  async initialized() {
    return this._initPromise;
  }

  request(method, params) {
    if (this._closed) throw new Error('LSP client closed');
    const id = ++this._reqId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this._write(body);
    });
  }

  notify(method, params) {
    if (this._closed) return Promise.resolve();
    const body = JSON.stringify({ jsonrpc: '2.0', method, params });
    return this._write(body);
  }

  _write(body) {
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
    return new Promise((resolve, reject) => {
      if (!this._proc || !this._proc.stdin || this._proc.stdin.destroyed) {
        reject(new Error('LSP stdin not available'));
        return;
      }
      this._proc.stdin.write(header + body, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  _handleResponse(msg) {
    if (msg.id != null && this._pending.has(msg.id)) {
      const { resolve, reject } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  }

  _close() {
    if (this._closed) return;
    this._closed = true;
    for (const { reject } of this._pending.values()) {
      reject(new Error('LSP server closed'));
    }
    this._pending.clear();
    try { this._proc?.stdin?.end(); } catch {}
    try { this._proc?.kill(); } catch {}
    this._proc = null;
  }

  async shutdown() {
    try { await this.request('shutdown', {}); } catch {}
    try { await this.notify('exit', {}); } catch {}
    this._close();
  }

  async openDocument(uri, languageId, text) {
    await this.initialized();
    return this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text },
    });
  }

  async closeDocument(uri) {
    return this.notify('textDocument/didClose', { textDocument: { uri } });
  }
}
