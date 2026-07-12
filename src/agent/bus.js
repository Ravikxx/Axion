// Shared message bus for agent-to-agent and agent-to-main communication.
// Singleton — imported by both tools.js and agent.js.
class AgentBus {
  constructor() {
    this._mailboxes = new Map(); // label → Message[]
    this._mainInbox = [];
  }

  register(label) {
    if (!this._mailboxes.has(label)) this._mailboxes.set(label, []);
  }

  send(from, to, content) {
    const msg = { from, to, content, at: new Date().toLocaleTimeString() };
    if (to === 'main') {
      this._mainInbox.push(msg);
    } else {
      if (!this._mailboxes.has(to)) this._mailboxes.set(to, []);
      this._mailboxes.get(to).push(msg);
    }
  }

  read(label) {
    const msgs = [...(this._mailboxes.get(label) || [])];
    this._mailboxes.set(label, []);
    return msgs;
  }

  readMain() {
    const msgs = [...this._mainInbox];
    this._mainInbox = [];
    return msgs;
  }

  agents() {
    return [...this._mailboxes.keys()];
  }
}

// ── File Watcher Event Types ──────────────────────────────────────────────────
// Agents can subscribe via BUS.read('watcher') for any file change event.
// Message shape: { type, file, event, at }
export const FileWatcherEvents = {
  CREATED: 'FileWatcher:Created',
  CHANGED: 'FileWatcher:Changed',
  DELETED: 'FileWatcher:Deleted',
  ERROR:   'FileWatcher:Error',
};

export const BUS = new AgentBus();
