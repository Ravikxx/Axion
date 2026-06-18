import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

const _dir         = dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR  = join(_dir, '../plugins');
const USER_DIR     = join(homedir(), '.axion', 'plugins');
const CONFIG_FILE  = join(homedir(), '.axion', 'plugin-config.json');

function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

function saveConfig(cfg) {
  const dir = join(homedir(), '.axion');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

class PluginManager {
  constructor() {
    this._plugins = new Map(); // name → { name, description, tools, execute, builtin }
    this._config  = {};
  }

  async init() {
    this._config = loadConfig();

    // Load built-ins
    if (existsSync(BUILTIN_DIR)) {
      for (const file of readdirSync(BUILTIN_DIR).filter(f => f.endsWith('.js'))) {
        try {
          const mod = await import(pathToFileURL(join(BUILTIN_DIR, file)).href);
          if (mod.name && mod.tools && mod.execute) {
            this._plugins.set(mod.name, { ...mod, builtin: true });
          }
        } catch (err) {
          console.error(`[plugins] Failed to load built-in ${file}: ${err.message}`);
        }
      }
    }

    // Load user plugins from ~/.axion/plugins/
    if (existsSync(USER_DIR)) {
      for (const file of readdirSync(USER_DIR).filter(f => f.endsWith('.js'))) {
        try {
          const mod = await import(pathToFileURL(join(USER_DIR, file)).href);
          if (mod.name && mod.tools && mod.execute) {
            this._plugins.set(mod.name, { ...mod, builtin: false });
          }
        } catch (err) {
          console.error(`[plugins] Failed to load user plugin ${file}: ${err.message}`);
        }
      }
    }
  }

  isEnabled(name) {
    return this._config[name]?.enabled === true;
  }

  enable(name) {
    if (!this._plugins.has(name)) return false;
    this._config[name] = { ...(this._config[name] || {}), enabled: true };
    saveConfig(this._config);
    return true;
  }

  disable(name) {
    if (!this._plugins.has(name)) return false;
    this._config[name] = { ...(this._config[name] || {}), enabled: false };
    saveConfig(this._config);
    return true;
  }

  getAnthropicTools() {
    const out = [];
    for (const [name, plugin] of this._plugins) {
      if (!this.isEnabled(name)) continue;
      for (const tool of plugin.tools) {
        out.push({
          name:         `plugin__${name}__${tool.name}`,
          description:  `[${name}] ${tool.description}`,
          input_schema: tool.input_schema || { type: 'object', properties: {} },
        });
      }
    }
    return out;
  }

  getOpenAITools() {
    return this.getAnthropicTools().map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }

  isPluginTool(name) {
    return typeof name === 'string' && name.startsWith('plugin__');
  }

  async callTool(fullName, args) {
    const withoutPrefix = fullName.slice('plugin__'.length);
    const sep = withoutPrefix.indexOf('__');
    if (sep === -1) throw new Error(`Malformed plugin tool name: "${fullName}"`);
    const pluginName = withoutPrefix.slice(0, sep);
    const toolName   = withoutPrefix.slice(sep + 2);
    const plugin = this._plugins.get(pluginName);
    if (!plugin)                  throw new Error(`Unknown plugin: "${pluginName}"`);
    if (!this.isEnabled(pluginName)) throw new Error(`Plugin "${pluginName}" is disabled`);
    return plugin.execute(toolName, args);
  }

  getStatus() {
    return [...this._plugins.values()].map(p => ({
      name:        p.name,
      description: p.description || '',
      builtin:     p.builtin,
      enabled:     this.isEnabled(p.name),
      toolCount:   p.tools?.length ?? 0,
      tools:       p.tools?.map(t => t.name) ?? [],
    }));
  }

  get totalTools() {
    let n = 0;
    for (const [name, p] of this._plugins) {
      if (this.isEnabled(name)) n += p.tools?.length ?? 0;
    }
    return n;
  }
}

export const PLUGINS = new PluginManager();
