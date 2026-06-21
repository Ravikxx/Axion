import { readFileSync, existsSync } from 'fs';
import { resolve, extname } from 'path';
import { execSync } from 'child_process';
import { createClient, resolveModel, resolveProvider } from './models.js';
import {
  TOOL_DEFINITIONS, TOOL_DEFINITIONS_OPENAI,
  COMPUTER_TOOL_DEFINITIONS, COMPUTER_TOOL_DEFINITIONS_OPENAI,
  executeTool, parseToolCallsFromText,
} from './tools.js';
import { API_KEYS } from '../config.js';
import { BUS } from './bus.js';
import { getMemories, getLearnedInstructions, getSkills, getAutoMemory } from '../persist.js';
import { MCP } from './mcp.js';
import { PLUGINS } from './plugins.js';
import { GOOGLE_TOOL_DEFINITIONS, GOOGLE_TOOL_DEFINITIONS_OPENAI } from './google.js';
import { getOAuthToken } from '../oauth/oauth.js';
import { homedir } from 'os';

// ── Project context (read once at startup) ────────────────────────────────────

function buildProjectContext() {
  const hints = [];
  const cwd   = process.cwd();

  // AXION.md — persistent project instructions (like CLAUDE.md).
  // Global (~/.axion/AXION.md) first, then project root, then ./.axion/AXION.md.
  for (const p of [
    resolve(homedir(), '.axion', 'AXION.md'),
    resolve(cwd, 'AXION.md'),
    resolve(cwd, '.axion', 'AXION.md'),
  ]) {
    try {
      const text = readFileSync(p, 'utf8').trim();
      if (text) hints.push(`Instructions from ${p} (follow these):\n${text.slice(0, 8000)}`);
    } catch {}
  }

  // package.json
  try {
    const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));
    hints.push(`Project: ${pkg.name || '(unnamed)'}${pkg.version ? ` v${pkg.version}` : ''}${pkg.description ? ` — ${pkg.description}` : ''}`);
    if (pkg.scripts && Object.keys(pkg.scripts).length) {
      hints.push(`npm scripts: ${Object.keys(pkg.scripts).join(', ')}`);
    }
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    if (deps.length) hints.push(`Key deps: ${deps.slice(0, 12).join(', ')}${deps.length > 12 ? '…' : ''}`);
  } catch {}

  // pyproject.toml / setup.py
  if (existsSync(resolve(cwd, 'pyproject.toml'))) hints.push('Stack: Python (pyproject.toml)');
  else if (existsSync(resolve(cwd, 'Cargo.toml'))) hints.push('Stack: Rust (Cargo.toml)');
  else if (existsSync(resolve(cwd, 'go.mod')))     hints.push('Stack: Go (go.mod)');

  // Git branch
  try {
    const branch = execSync('git branch --show-current', { cwd, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
    if (branch) hints.push(`Git branch: ${branch}`);
  } catch {}

  // README (first 300 chars)
  try {
    const readme = readFileSync(resolve(cwd, 'README.md'), 'utf8').trim().slice(0, 300);
    if (readme) hints.push(`README: ${readme.replace(/\n+/g, ' ')}`);
  } catch {}

  return hints.length ? `\n\nProject context (${process.cwd()}):\n${hints.map(h => `• ${h}`).join('\n')}` : '';
}

const PROJECT_CONTEXT = buildProjectContext();

// ── Vision — parse image paths from user messages ─────────────────────────────

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MEDIA_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };

function extractImages(text) {
  // Find any word that looks like an image path and exists on disk
  const images = [];
  const re = /\S+\.(?:png|jpg|jpeg|gif|webp)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const abs = resolve(process.cwd(), m[0]);
    if (existsSync(abs)) {
      const ext = extname(m[0]).toLowerCase();
      images.push({ path: m[0], abs, mediaType: MEDIA_TYPES[ext] || 'image/png' });
    }
  }
  return images;
}

function buildUserContent(text) {
  const images = extractImages(text);
  if (!images.length) return text;
  // Anthropic content block format (converted for OpenAI in _historyToOpenAI)
  return [
    { type: 'text', text },
    ...images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: readFileSync(img.abs).toString('base64') },
    })),
  ];
}

const SYSTEM_PROMPT = `You are Axion, an expert AI coding agent made by Axion Labs. You help users write, debug, and understand code directly in their terminal.

You have access to tools that let you read/write files, run commands, work with git, and search the web. Always explain what you're about to do before taking an action. Be concise but thorough. When you encounter an error, explain what went wrong and how you're fixing it.

Always show file paths relative to the current working directory. When writing code, follow the existing style of the project. Prefer patch_file over write_file for targeted edits.

REASONING: Use <think>...</think> XML tags to think before responding whenever:
- The user asks you to think, reason, reflect, or consider something
- The task is non-trivial: debugging, architecture decisions, explaining something nuanced, multi-step problems, tradeoff analysis
Write your reasoning as plain text inside the tags — never call tools inside a <think> block, and never narrate that you are using thinking. After </think>, give your actual response.

TOOL DISCIPLINE: Never use send_message to send a message to yourself or to "main" when you are the main agent — that is pointless self-messaging. send_message is only for communicating with other agents spawned by spawn_agents. Do not use any tool as a substitute for thinking.` + PROJECT_CONTEXT;

const CHAT_SYSTEM_PROMPT = `You are Axion, a helpful AI assistant made by Axion Labs. You are having a conversation — help with questions, writing, brainstorming, explaining concepts, and general topics.

You are in Chat mode. You have no access to files, the terminal, or any tools. Just talk. Be friendly, clear, and concise.

REASONING: Use <think>...</think> tags to think through nuanced or complex questions before answering. Write reasoning as plain text inside the tags, then give your response after.`;

const TOOL_FALLBACK_PROMPT_BASE = `
You have access to the following tools. To use one, emit exactly this XML (one call per block):
<tool_call>{"name": "TOOL_NAME", "input": {ARGS_JSON}}</tool_call>

Tools: read_file(path), write_file(path, content), list_directory(path), run_command(command), git_status(), git_diff(), git_commit(message), git_push(), web_search(query)`;

const TOOL_FALLBACK_COMPUTER_EXTRA = `
Computer use tools (use these instead of run_command for anything screen-related):
  screenshot()                              — take a screenshot and get a description
  click_on(target)                          — find a UI element by description and click it
  click_at(x, y, button?, times?)          — click at exact pixel coordinates
  type_text(text)                           — type text into the focused field
  press_key(keys)                           — press keyboard shortcuts (e.g. "^c" for Ctrl+C)
  scroll(x, y, direction?, amount?)        — scroll at coordinates
  screen_size()                             — get screen dimensions
IMPORTANT: NEVER use run_command with scrot/xdotool/screencapture/xclip for screenshots or clicks — always use the computer use tools above.`;

function getToolFallbackPrompt(computerUse) {
  return TOOL_FALLBACK_PROMPT_BASE +
    (computerUse ? TOOL_FALLBACK_COMPUTER_EXTRA : '') +
    '\n\nCall the right tool rather than guessing. You will be called again after each result.';
}

// ── Streaming think-tag filter ────────────────────────────────────────────────
// Processes chunks in real time, routing <think> content to onThought and the
// rest to onText. Handles tags that span multiple chunks.

class ThinkStreamFilter {
  constructor(onText, onThought) {
    this._onText    = onText;
    this._onThought = onThought;
    this._buf       = '';
    this._thinking  = false;
    this._thinkBuf  = '';
  }

  push(chunk) {
    this._buf += chunk;
    this._drain();
  }

  flush() {
    if (!this._thinking && this._buf)       { this._onText(this._buf);              this._buf = ''; }
    if (this._thinking  && this._thinkBuf)  { this._onThought(this._thinkBuf.trim()); this._thinkBuf = ''; }
  }

  _drain() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (!this._thinking) {
        const open = this._buf.search(/<think(?:ing)?>/i);
        if (open === -1) {
          // Flush everything except a possible partial opening tag at the tail
          const safe = this._safeTail(this._buf, '<think');
          if (safe > 0) { this._onText(this._buf.slice(0, safe)); this._buf = this._buf.slice(safe); }
          break;
        }
        if (open > 0) { this._onText(this._buf.slice(0, open)); }
        const tagEnd = this._buf.indexOf('>', open);
        this._buf = this._buf.slice(tagEnd + 1);
        this._thinking = true;
        this._thinkBuf = '';
      } else {
        const close = this._buf.search(/<\/think(?:ing)?>/i);
        if (close === -1) {
          const safe = this._safeTail(this._buf, '</think');
          this._thinkBuf += this._buf.slice(0, safe);
          this._buf = this._buf.slice(safe);
          break;
        }
        this._thinkBuf += this._buf.slice(0, close);
        const m = this._buf.match(/<\/think(?:ing)?>/i);
        this._buf = this._buf.slice(close + (m ? m[0].length : 8));
        if (this._thinkBuf.trim()) this._onThought(this._thinkBuf.trim());
        this._thinkBuf = '';
        this._thinking = false;
      }
    }
  }

  // Returns safe flush length — keeps a suffix that might be the start of `needle`
  _safeTail(str, needle) {
    for (let i = Math.min(needle.length - 1, str.length); i > 0; i--) {
      if (needle.toLowerCase().startsWith(str.slice(-i).toLowerCase())) return str.length - i;
    }
    return str.length;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export class Agent {
  constructor({ modelAlias, mode, label = 'main', onToolCall, onToolResult, onMessage, onTokens, onStreamChunk, onStreamEnd, onNotify }) {
    this.modelAlias   = modelAlias;
    this.mode         = mode;
    this.label        = label;
    this.history      = [];
    this.totalTokens  = 0;
    this.inputTokens  = 0;
    this.outputTokens = 0;
    // Extended thinking
    this.thinking     = { enabled: false, budget: 10000 };
    // Per-turn flag: inject a think reminder when the user's message requests it
    this._thinkReminder = false;
    // System prompt customisation
    this.systemOverride = '';
    // Goal mode — null means off
    this.goal = null;
    // Computer use — adds screen interaction tools when on
    this.computerUse  = false;
    // Adviser model — null means auto-pick
    this.adviserModel = null;
    // Chat mode — simplified prompt, no tools
    this.chatMode = false;
    // Skills activated this session (name → skill); auto-triggered per message
    this.activeSkills = new Map();
    this.onSkillActivated = null; // optional UI callback (skillName) => void
    // Interrupt support — cancel() aborts the in-flight request and stops the loop
    this.cancelled  = false;
    this._abortCtrl = null;

    this.onToolCall    = onToolCall    || (() => {});
    this.onToolResult  = onToolResult  || (() => {});
    this.onMessage     = onMessage     || (() => {});
    this.onTokens      = onTokens      || (() => {});
    this.onStreamChunk = onStreamChunk || (() => {});
    this.onStreamEnd   = onStreamEnd   || (() => {});
    this.onNotify      = onNotify      || ((n) => this.onMessage(n));

    BUS.register(label);
  }

  setMode(mode)            { this.mode = mode; }
  setModel(alias)          { this.modelAlias = alias; }
  setSystemOverride(text)  { this.systemOverride = text; }
  setChatMode(enabled)     { this.chatMode = !!enabled; }
  setThinking(enabled, budget = 10000) { this.thinking = { enabled, budget }; }
  setGoal(description)     { this.goal = description || null; }
  setComputerUse(enabled)  { this.computerUse = !!enabled; }
  setAdviserModel(alias)   { this.adviserModel = alias || null; }

  // Interrupt the current run: abort the in-flight API request and let the
  // agent loop wind down. History stays consistent — pending tool calls get
  // "Interrupted" results so the next turn doesn't break tool_use pairing.
  cancel() {
    this.cancelled = true;
    try { this._abortCtrl?.abort(); } catch {}
  }

  clearHistory() {
    this.history = [];
    this.activeSkills.clear();
    this.totalTokens = this.inputTokens = this.outputTokens = 0;
    this.onTokens({ total: 0, input: 0, output: 0 });
  }

  // Activate any skill whose trigger words appear in the message.
  // Once active, a skill stays in the system prompt for the session.
  _activateSkills(text) {
    const lower = String(text || '').toLowerCase();
    for (const skill of getSkills()) {
      const key = skill.name.toLowerCase();
      if (this.activeSkills.has(key)) continue;
      // Whole-word match so short triggers (e.g. "mc") don't fire inside other words
      const matches = (t) => {
        if (!t) return false;
        const esc = t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(lower);
      };
      if (skill.triggers.some(matches)) {
        this.activeSkills.set(key, skill);
        this.onSkillActivated?.(skill.name);
      }
    }
  }

  getTokens() { return this.totalTokens; }

  _skillsPrompt() {
    return `\n\n## Active skills (follow these instructions for the rest of the session):\n` +
      [...this.activeSkills.values()]
        .map(s => `### Skill: ${s.name}${s.description ? ` — ${s.description}` : ''}\n${s.body}`)
        .join('\n\n');
  }

  _getSystemPrompt() {
    // Chat tab: simplified conversational prompt — no tools, no coding context
    if (this.chatMode) {
      let prompt = CHAT_SYSTEM_PROMPT;
      const memories = getMemories();
      if (memories.length) {
        prompt += `\n\nUser's notes (always remember these):\n${memories.map((m, i) => `${i + 1}. ${m.text}`).join('\n')}`;
      }
      if (this.activeSkills.size) {
        prompt += this._skillsPrompt();
      }
      if (this.systemOverride) {
        prompt += `\n\nADDITIONAL INSTRUCTIONS: ${this.systemOverride}`;
      }
      return prompt;
    }

    let prompt = SYSTEM_PROMPT;
    const memories = getMemories();
    if (memories.length) {
      prompt += `\n\nUser's persistent notes (always remember these):\n${memories.map((m, i) => `${i + 1}. ${m.text}`).join('\n')}`;
    }
    const learned = getLearnedInstructions();
    if (learned) {
      prompt += `\n\n## Learned preferences from your usage:\n${learned}`;
    }
    const autoMemory = getAutoMemory();
    if (autoMemory) {
      prompt += `\n\n## Context from previous session:\n${autoMemory}`;
    }
    if (this.goal) {
      prompt += `\n\nCURRENT GOAL: ${this.goal}\nWork autonomously until this goal is fully achieved. When the goal is complete, include exactly "GOAL_COMPLETE" on its own line at the end of your response.`;
    }
    if (this.computerUse) {
      prompt += `\n\nCOMPUTER USE ENABLED: You can control the user's screen using the screenshot, click_on, click_at, type_text, press_key, scroll, and screen_size tools.

CRITICAL RULES — follow these exactly:
- NEVER use run_command or bash to take screenshots (no scrot, gnome-screenshot, import, screencapture, xdotool click, ydotool, etc.) — always call the screenshot or click_on or click_at tool directly.
- To LAUNCH an application, use run_command (e.g. "start chrome" on Windows, "google-chrome &" on Linux) — never click a desktop icon.
- To interact with UI elements in an open app, use click_on (describe the element) or click_at (known pixel coords).
- Always call screenshot first to understand the current screen state.
- After each click or action, call screenshot again to verify the result.`;
    }
    if (this.activeSkills.size) {
      prompt += this._skillsPrompt();
    }
    if (this.systemOverride) {
      prompt += `\n\nADDITIONAL INSTRUCTIONS: ${this.systemOverride}`;
    }
    if (this._thinkReminder && !this.thinking.enabled) {
      prompt += `\n\nIMPORTANT: The user has asked you to think or reason. You MUST use <think>...</think> tags to show your reasoning before responding. Write your thoughts as plain text inside the tags — do not call any tools inside a <think> block.`;
    }
    if (MCP.getStatus().some(s => s.name === 'sequential-thinking' && s.ready)) {
      prompt += `\n\nSEQUENTIAL THINKING: You have the sequentialthinking tool. Use it silently and immediately before any non-trivial response — do NOT announce that you're going to think, do NOT ask permission, just call it. Never say "let me think" or "I'll use sequential thinking" — simply invoke the tool and then respond. Only skip it for one-word/trivial answers.`;
    }
    return prompt;
  }

  // ── Plan step ────────────────────────────────────────────────────────────

  async planStep(userMessage) {
    const { client, type } = createClient(this.modelAlias);
    const model = resolveModel(this.modelAlias);
    const planPrompt = `The user asked: "${userMessage}"\n\nProduce a numbered list of every step you will take. Do NOT execute any tools yet — only output the plan.`;
    const planHistory = [...this.history, { role: 'user', content: planPrompt }];

    let planText = '';
    if (type === 'anthropic') {
      const resp = await client.messages.create({ model, max_tokens: 1024, system: this._getSystemPrompt(), messages: planHistory });
      planText = resp.content.find((b) => b.type === 'text')?.text || '';
      this._addTokens(resp.usage?.input_tokens, resp.usage?.output_tokens);
    } else {
      const resp = await client.chat.completions.create({ model, max_tokens: 1024, messages: [{ role: 'system', content: this._getSystemPrompt() }, ...planHistory] });
      planText = resp.choices[0]?.message?.content || '';
      this._addTokens(resp.usage?.prompt_tokens, resp.usage?.completion_tokens);
    }
    return planText;
  }

  // ── Main run ─────────────────────────────────────────────────────────────

  async run(userMessage, { askConfirm, askPlanConfirm } = {}) {
    this.cancelled = false;
    this._activateSkills(userMessage);
    // Set think reminder if the user's message asks for reasoning
    this._thinkReminder = /\bthink(?:ing)?\b|\breason(?:ing)?\b|\bconsider\b|\breflect\b|\bponder\b/i.test(userMessage);
    this.history.push({ role: 'user', content: buildUserContent(userMessage) });

    if (this.mode === 'plan') {
      const plan = await this.planStep(userMessage);
      this.onMessage({ role: 'plan', content: plan });
      const confirmed = await askPlanConfirm?.(plan);
      if (!confirmed) {
        this.onMessage({ role: 'assistant', content: 'Plan cancelled.' });
        this.history.push({ role: 'assistant', content: 'Plan cancelled.' });
        return;
      }
    }

    await this._agentLoop(askConfirm);
  }

  // ── Agent loop ────────────────────────────────────────────────────────────

  // Tools that are read-only and safe to execute concurrently
  static PARALLEL_SAFE = new Set([
    'read_file', 'list_directory', 'git_status', 'git_diff',
    'web_search', 'fetch_url', 'screenshot', 'screen_size',
  ]);

  async _agentLoop(askConfirm) {
    const MAX = 20;
    let iterations = 0;
    let lastBatchSig = null;
    let sameToolStreak = 0;
    let adviceSent = false;

    while (iterations < MAX) {
      if (this.cancelled) break;
      iterations++;

      // Stuck: too many iterations without finishing
      if (iterations === 10 && !adviceSent) {
        adviceSent = true;
        await this._getAdvice('The agent has been iterating for a long time without finishing.');
      }

      const response = await this._callModel();
      if (!response) break;

      const { text, toolCalls } = response;
      if (text) this.onMessage({ role: 'assistant', content: text });

      if (!toolCalls || toolCalls.length === 0) {
        if (text) this.history.push({ role: 'assistant', content: text });
        break;
      }

      this._pushAssistantWithTools(text, toolCalls, response.raw);

      // Stuck: same batch of tool calls back-to-back
      const batchSig = toolCalls.map(tc => tc.name + ':' + JSON.stringify(tc.input)).join('|');
      if (batchSig === lastBatchSig) {
        sameToolStreak++;
        if (sameToolStreak >= 2 && !adviceSent) {
          adviceSent = true;
          await this._getAdvice(`The agent repeated the same tool call(s) ${sameToolStreak + 1} times in a row.`);
        }
      } else {
        lastBatchSig = batchSig;
        sameToolStreak = 0;
      }

      // Parallel execution: run all read-only tools concurrently when not in ask mode
      const canParallel = this.mode !== 'ask' &&
        toolCalls.length > 1 &&
        toolCalls.every(tc => Agent.PARALLEL_SAFE.has(tc.name));

      const toolResults = [];

      if (canParallel) {
        toolCalls.forEach(tc => this.onToolCall({ name: tc.name, input: tc.input, id: tc.id }));
        const settled = await Promise.allSettled(
          toolCalls.map(tc =>
            MCP.isMcpTool(tc.name)
              ? MCP.callTool(tc.name, tc.input)
              : PLUGINS.isPluginTool(tc.name)
                ? PLUGINS.callTool(tc.name, tc.input)
                : executeTool(tc.name, tc.input, { agentLabel: this.label, onNotify: this.onNotify })
          )
        );
        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i];
          const r  = settled[i];
          const result = r.status === 'fulfilled'
            ? r.value
            : { output: r.reason?.message || 'Tool error', success: false };
          toolResults.push({ id: tc.id, name: tc.name, ...result });
          this.onToolResult({ id: tc.id, name: tc.name, ...result });
        }
      } else {
        for (const tc of toolCalls) {
          if (this.cancelled) {
            const skipped = { id: tc.id, name: tc.name, output: 'Interrupted by user.', success: false };
            toolResults.push(skipped);
            this.onToolResult(skipped);
            continue;
          }

          this.onToolCall({ name: tc.name, input: tc.input, id: tc.id });

          if (this.mode === 'ask' && askConfirm) {
            const approved = await askConfirm(tc);
            if (!approved) {
              const declined = { id: tc.id, name: tc.name, output: 'User declined.', success: false };
              toolResults.push(declined);
              this.onToolResult({ id: tc.id, name: tc.name, output: 'User declined.', success: false });
              continue;
            }
          }

          let result;
          if (tc.name === 'spawn_agents') {
            result = await this._spawnAgents(tc.input?.agents || []);
          } else if (MCP.isMcpTool(tc.name)) {
            result = await MCP.callTool(tc.name, tc.input);
          } else if (PLUGINS.isPluginTool(tc.name)) {
            result = await PLUGINS.callTool(tc.name, tc.input);
          } else {
            result = await executeTool(tc.name, tc.input, { agentLabel: this.label, onNotify: this.onNotify });
          }
          toolResults.push({ id: tc.id, name: tc.name, ...result });
          this.onToolResult({ id: tc.id, name: tc.name, ...result });
        }
      }

      this._pushToolResults(toolResults, response.type);

      // end_conversation tool — surface to UI and stop the loop
      const termination = toolResults.find(r => r.terminate);
      if (termination) {
        this.terminated = true;
        this.onMessage({ role: 'session-ended', content: termination.output });
        break;
      }
    }
  }

  // ── Compact (summarize history) ───────────────────────────────────────────

  async compact() {
    const { client, type } = createClient(this.modelAlias);
    const model = resolveModel(this.modelAlias);

    const convText = this.history.map((m) => {
      const role = m.role === 'assistant' ? 'Axion' : m.role === 'user' ? 'User' : m.role;
      const content = typeof m.content === 'string' ? m.content.slice(0, 600) : '[tool interaction]';
      return `${role}: ${content}`;
    }).join('\n\n');

    const prompt = `Summarize this conversation between a user and an AI coding agent. Capture: the goal, what was done, the current state, and any context needed to continue seamlessly.\n\n${convText}`;

    let summary = '';
    if (type === 'anthropic') {
      const resp = await client.messages.create({ model, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] });
      summary = resp.content[0]?.text || '';
      this._addTokens(resp.usage?.input_tokens, resp.usage?.output_tokens);
    } else {
      const resp = await client.chat.completions.create({ model, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] });
      summary = resp.choices[0]?.message?.content || '';
      this._addTokens(resp.usage?.prompt_tokens, resp.usage?.completion_tokens);
    }

    if (summary) {
      this.history = [
        { role: 'user', content: `[Conversation summary — continuing from here]: ${summary}` },
        { role: 'assistant', content: 'Got it. I have the full context and can continue from where we left off.' },
      ];
      // Recalibrate token counters to the new, small history so the context
      // gauge reflects reality (otherwise auto-compact would re-trigger forever)
      this.inputTokens  = Math.round(summary.length / 4) + 200;
      this.outputTokens = 0;
      this.totalTokens  = this.inputTokens;
      this.onTokens({ total: this.totalTokens, input: this.inputTokens, output: this.outputTokens });
    }
    return summary;
  }

  // ── BTW (one-shot side question) ──────────────────────────────────────────

  async askBtw(question) {
    const { client, type } = createClient(this.modelAlias);
    const model = resolveModel(this.modelAlias);

    const recentCtx = this.history.slice(-4)
      .map((m) => {
        if (m.role === 'user' && typeof m.content === 'string') return `User: ${m.content}`;
        if (m.role === 'assistant' && typeof m.content === 'string') return `Axion: ${m.content}`;
        return null;
      })
      .filter(Boolean)
      .join('\n');

    const prompt = recentCtx
      ? `Current task context:\n${recentCtx}\n\nQuick question: ${question}`
      : question;

    let answer = '';
    if (type === 'anthropic') {
      const resp = await client.messages.create({
        model, max_tokens: 512,
        system: 'You are a concise assistant. Answer briefly and directly.',
        messages: [{ role: 'user', content: prompt }],
      });
      answer = resp.content[0]?.text || '';
      this._addTokens(resp.usage?.input_tokens, resp.usage?.output_tokens);
    } else {
      const resp = await client.chat.completions.create({
        model, max_tokens: 512,
        messages: [
          { role: 'system', content: 'You are a concise assistant. Answer briefly and directly.' },
          { role: 'user', content: prompt },
        ],
      });
      answer = resp.choices[0]?.message?.content || '';
      this._addTokens(resp.usage?.prompt_tokens, resp.usage?.completion_tokens);
    }
    return answer;
  }

  // ── Watch-and-learn: extract preferences from a batch of user messages ───

  async extractLearnedInstructions(messages) {
    const { client, type } = createClient(this.modelAlias);
    const model = resolveModel(this.modelAlias);
    const convText = messages.map((m, i) => `${i + 1}. ${m}`).join('\n');
    const prompt = `Based on the user messages below sent to an AI coding assistant, extract specific preferences and recurring patterns as bullet points. Focus on: preferred coding style, tools/approaches they like or dislike, things to avoid, and repeated requests. Be concise and specific. Output only the bullet list, nothing else.\n\nMessages:\n${convText}`;

    let result = '';
    if (type === 'anthropic') {
      const resp = await client.messages.create({
        model, max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      });
      result = resp.content[0]?.text || '';
      this._addTokens(resp.usage?.input_tokens, resp.usage?.output_tokens);
    } else {
      const resp = await client.chat.completions.create({
        model, max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      });
      result = resp.choices[0]?.message?.content || '';
      this._addTokens(resp.usage?.prompt_tokens, resp.usage?.completion_tokens);
    }
    return result;
  }

  // ── Auto-adviser ─────────────────────────────────────────────────────────

  async _getAdvice(reason) {
    const adviser = this._pickAdviser();
    if (!adviser) return;

    this.onMessage({ role: 'adviser', content: `consulting ${adviser}…` });

    const recentCtx = this.history.slice(-8).map((m) => {
      const role = m.role === 'assistant' ? 'Axion' : m.role === 'user' ? 'User' : m.role;
      const content = typeof m.content === 'string' ? m.content.slice(0, 400) : '[tool interaction]';
      return `[${role}]: ${content}`;
    }).join('\n');

    const prompt = `An AI coding agent is stuck. Reason: ${reason}\n\nRecent conversation:\n${recentCtx}\n\nProvide brief, specific, actionable advice on what the agent should try next.`;

    try {
      const { client, type } = createClient(adviser);
      const model = resolveModel(adviser);
      let advice = '';

      if (type === 'anthropic') {
        const resp = await client.messages.create({ model, max_tokens: 512, messages: [{ role: 'user', content: prompt }] });
        advice = resp.content[0]?.text || '';
        this._addTokens(resp.usage?.input_tokens, resp.usage?.output_tokens);
      } else {
        const resp = await client.chat.completions.create({ model, max_tokens: 512, messages: [{ role: 'user', content: prompt }] });
        advice = resp.choices[0]?.message?.content || '';
        this._addTokens(resp.usage?.prompt_tokens, resp.usage?.completion_tokens);
      }

      if (advice) {
        this.onMessage({ role: 'adviser', content: advice });
        this.history.push({ role: 'user', content: `[Adviser (${adviser})]: ${advice}` });
      }
    } catch {
      // Don't crash the main loop if adviser fails
    }
  }

  _pickAdviser() {
    // Explicit adviser model set by user
    if (this.adviserModel) {
      if (this.adviserModel === 'off') return null;
      if (this.adviserModel === this.modelAlias) return null; // no point asking yourself
      return this.adviserModel;
    }
    // Auto-pick: highest capability model with a key that isn't the current one
    const priority = ['claude-opus', 'claude', 'gpt', 'gpt-mini', 'groq'];
    for (const m of priority) {
      if (m === this.modelAlias) continue;
      if (API_KEYS[resolveProvider(m)]) return m;
    }
    return null;
  }

  // ── Sub-agents ────────────────────────────────────────────────────────────

  async _spawnAgents(agentDefs) {
    if (!agentDefs.length) return { success: false, output: 'No agents specified.' };

    this.onMessage({ role: 'assistant', content: `Spawning ${agentDefs.length} agent(s)…` });

    const results = await Promise.all(
      agentDefs.map(async ({ model, task, label }, i) => {
        const modelToUse = model || this.modelAlias;
        const agentLabel = label || `agent-${i + 1}`;

        BUS.register(agentLabel);

        let subStreamBuf = '';
        const sub = new Agent({
          modelAlias: modelToUse,
          label: agentLabel,
          mode: 'auto',
          onMessage: ({ role, content }) => {
            if (role === 'assistant' && content) {
              this.onMessage({ role: 'sub-agent', content, label: agentLabel });
            }
          },
          onToolCall:    () => {},
          onToolResult:  () => {},
          onTokens: ({ total }) => this.onTokens({ total: this.totalTokens + total, input: this.inputTokens, output: this.outputTokens }),
          onStreamChunk: (chunk) => { subStreamBuf += chunk; },
          onStreamEnd:   () => {
            if (subStreamBuf.trim()) {
              this.onMessage({ role: 'sub-agent', content: subStreamBuf, label: agentLabel });
              subStreamBuf = '';
            }
          },
          onNotify: (n) => this.onMessage(n),
        });

        try {
          await sub.run(task, {
            askConfirm:     () => Promise.resolve(true),
            askPlanConfirm: () => Promise.resolve(true),
          });
          // Drain any messages the sub-agent sent to main
          const mainMsgs = BUS.readMain();
          for (const m of mainMsgs) {
            this.onMessage({ role: 'sub-agent', content: `📨 ${m.from} → main: ${m.content}`, label: m.from });
            this.history.push({ role: 'user', content: `[Message from ${m.from}]: ${m.content}` });
          }
          const lastMsg = [...sub.history].reverse().find((m) => m.role === 'assistant');
          const content = typeof lastMsg?.content === 'string'
            ? lastMsg.content
            : lastMsg?.content?.find?.((c) => c.type === 'text')?.text || '(completed)';
          return `[${agentLabel}]:\n${content}`;
        } catch (err) {
          return `[${agentLabel}] ERROR: ${err.message}`;
        }
      })
    );

    return { success: true, output: results.join('\n\n───\n\n') };
  }

  // ── Thinking helpers (non-Anthropic) ─────────────────────────────────────

  _getThinkingInjection() {
    return `\n\nExtended reasoning mode is ON. You must reason through your response by writing inside <think>...</think> XML tags before giving your answer. Rules:\n- This is plain text inside your message — do NOT call any tools during the thinking phase\n- Do NOT use run_command, echo, or any tool just to "demonstrate" thinking — write your thoughts directly\n- The <think> block is for reasoning only (analysis, planning, edge cases) — it is shown separately to the user\n- After </think>, write your normal response\n\nFormat:\n<think>\n[Your step-by-step reasoning here — think freely, no tools]\n</think>\n[Your response here]`;
  }

  // Extract <think> or <thinking> blocks from model output.
  // Always called on OpenAI-path responses so models like DeepSeek R1 that
  // naturally think are handled even when thinking mode is off.
  _parseThinking(text) {
    const re = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;
    const thoughts = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const trimmed = m[1].trim();
      if (trimmed) thoughts.push(trimmed);
    }
    const clean = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
    return { thoughts, clean };
  }

  // ── Model calls ───────────────────────────────────────────────────────────

  async _callModel() {
    const { client, type } = createClient(this.modelAlias);
    const model = resolveModel(this.modelAlias);
    this._abortCtrl = new AbortController();
    try {
      if (type === 'anthropic') return await this._callAnthropic(client, model);
      if (type === 'veil')      return await this._callVeil(client, model);
      // 'other' uses the same path as openai but gets the same fallback treatment
      return await this._callOpenAI(client, model);
    } catch (err) {
      if (this.cancelled || /abort/i.test(err?.name || '') || /abort/i.test(err?.message || '')) {
        this.onStreamEnd(); // flush whatever partial text streamed before the abort
        return null;
      }
      this.onMessage({ role: 'error', content: friendlyError(err, this.modelAlias) });
      return null;
    } finally {
      this._abortCtrl = null;
    }
  }

  _getToolList() {
    const base = this.computerUse
      ? [...TOOL_DEFINITIONS, ...COMPUTER_TOOL_DEFINITIONS]
      : TOOL_DEFINITIONS;
    const google = getOAuthToken('google') ? GOOGLE_TOOL_DEFINITIONS : [];
    return [...base, ...google, ...MCP.getAnthropicTools(), ...PLUGINS.getAnthropicTools()];
  }

  _getToolListOpenAI() {
    const base = this.computerUse
      ? [...TOOL_DEFINITIONS_OPENAI, ...COMPUTER_TOOL_DEFINITIONS_OPENAI]
      : TOOL_DEFINITIONS_OPENAI;
    const google = getOAuthToken('google') ? GOOGLE_TOOL_DEFINITIONS_OPENAI : [];
    return [...base, ...google, ...MCP.getOpenAITools(), ...PLUGINS.getOpenAITools()];
  }

  async _callAnthropic(client, model) {
    const params = {
      model,
      max_tokens: this.thinking.enabled ? Math.max(this.thinking.budget * 2, 16000) : 8192,
      system: this._getSystemPrompt(),
      messages: this.history,
      tools: this._getToolList(),
    };
    if (this.thinking.enabled) params.thinking = { type: 'enabled', budget_tokens: this.thinking.budget };

    const stream = client.messages.stream(params, { signal: this._abortCtrl?.signal });
    let thinkBuf = '', inThink = false;

    for await (const evt of stream) {
      if (evt.type === 'content_block_start') {
        inThink = evt.content_block?.type === 'thinking';
        if (inThink) thinkBuf = '';
      } else if (evt.type === 'content_block_delta') {
        if (evt.delta.type === 'text_delta' && evt.delta.text) {
          this.onStreamChunk(evt.delta.text);
        } else if (evt.delta.type === 'thinking_delta' && evt.delta.thinking) {
          thinkBuf += evt.delta.thinking;
        }
      } else if (evt.type === 'content_block_stop' && inThink) {
        if (thinkBuf.trim()) this.onMessage({ role: 'thinking', content: thinkBuf.trim() });
        inThink = false;
      }
    }

    this.onStreamEnd();
    const msg = await stream.getFinalMessage();
    this._addTokens(msg.usage?.input_tokens, msg.usage?.output_tokens);
    const toolCalls = (msg.content || []).filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input }));
    return { type: 'anthropic', text: '', toolCalls, raw: msg.content };
  }

  async _callOpenAI(client, model) {
    const sysContent = this._getSystemPrompt() + (this.thinking.enabled ? this._getThinkingInjection() : '');
    const maxTok     = this.thinking.enabled ? 16000 : 4096;
    const msgs       = [{ role: 'system', content: sysContent }, ...this._historyToOpenAI()];

    const tcBufs = {};
    const filter = new ThinkStreamFilter(
      (txt)     => this.onStreamChunk(txt),
      (thought) => this.onMessage({ role: 'thinking', content: thought })
    );
    let usage = null;
    let toolErrFallback = false;

    try {
      const streamResp = await client.chat.completions.create({
        model, messages: msgs, tools: this._getToolListOpenAI(),
        tool_choice: 'auto', max_tokens: maxTok, stream: true,
      }, { signal: this._abortCtrl?.signal });

      for await (const chunk of streamResp) {
        if (chunk.usage) usage = chunk.usage;
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) filter.push(delta.content);
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            if (!tcBufs[i]) tcBufs[i] = { id: '', name: '', args: '' };
            if (tc.id)                  tcBufs[i].id   += tc.id;
            if (tc.function?.name)      tcBufs[i].name += tc.function.name;
            if (tc.function?.arguments) tcBufs[i].args += tc.function.arguments;
          }
        }
      }

      filter.flush();
      this.onStreamEnd();
      if (usage) this._addTokens(usage.prompt_tokens, usage.completion_tokens);

      const toolCalls = Object.values(tcBufs).filter(tc => tc.name).map((tc, i) => {
        let input = {};
        try { input = JSON.parse(tc.args || '{}'); } catch {}
        return { id: tc.id || `tc-${i}`, name: tc.name, input };
      });
      return { type: 'openai', text: '', toolCalls, raw: null };

    } catch (err) {
      if (this.cancelled) throw err; // handled (silently) by _callModel
      this.onStreamEnd(); // close any partial stream in the UI
      const errBody = err?.message || err?.error?.message || '';
      const isToolError =
        /function|tool|failed_generation|does not support tools|tool_use/i.test(errBody) ||
        (err?.status === 400 && /invalid|unsupported|parameter/i.test(errBody)) ||
        err?.status === 500;
      if (!isToolError) throw err;
      toolErrFallback = true;
    }

    // Non-streaming fallback for tool-call failures (some providers)
    const fallbackMsgs = msgs.map((m, i) => i === 0 ? { ...m, content: m.content + getToolFallbackPrompt(this.computerUse) } : m);
    const resp = await client.chat.completions.create({ model, messages: fallbackMsgs, max_tokens: maxTok });
    const raw  = resp.choices[0]?.message?.content || '';
    this._addTokens(resp.usage?.prompt_tokens, resp.usage?.completion_tokens);
    const { thoughts, clean } = this._parseThinking(raw);
    for (const t of thoughts) this.onMessage({ role: 'thinking', content: t });
    return {
      type: 'openai',
      text: clean.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim(),
      toolCalls: parseToolCallsFromText(clean).map((tc, i) => ({ id: `fallback-${i}`, ...tc })),
      raw: resp.choices[0]?.message,
    };
  }

  async _callVeil(client, model) {
    return this._callOpenAI(client, model);
  }

  // ── History helpers ───────────────────────────────────────────────────────

  _historyToOpenAI() {
    const out = [];
    for (const msg of this.history) {
      if (msg.role === 'user') {
        if (Array.isArray(msg.content)) {
          // Convert Anthropic image blocks to OpenAI format
          const openaiContent = msg.content.map((b) => {
            if (b.type === 'text') return { type: 'text', text: b.text };
            if (b.type === 'image') return { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } };
            return { type: 'text', text: JSON.stringify(b) };
          });
          out.push({ role: 'user', content: openaiContent });
        } else {
          out.push({ role: 'user', content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) });
        }
      } else if (msg.role === 'assistant') {
        out.push(msg._openai || { role: 'assistant', content: msg.content || '' });
      } else if (msg.role === 'tool') {
        out.push({ role: 'tool', tool_call_id: msg.tool_call_id, content: msg.content });
      }
    }
    return out;
  }

  _pushAssistantWithTools(text, toolCalls, raw) {
    if (resolveProvider(this.modelAlias) === 'anthropic') {
      this.history.push({ role: 'assistant', content: raw });
    } else {
      const assistantMsg = {
        role: 'assistant', content: text || null,
        tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.input) } })),
      };
      this.history.push({ role: 'assistant', content: text, _openai: assistantMsg });
    }
  }

  _pushToolResults(toolResults, responseType) {
    if (resolveProvider(this.modelAlias) === 'anthropic') {
      this.history.push({
        role: 'user',
        content: toolResults.map((r) => {
          if (r.imageData && r.mimeType) {
            return {
              type: 'tool_result',
              tool_use_id: r.id,
              content: [
                { type: 'text', text: r.output },
                { type: 'image', source: { type: 'base64', media_type: r.mimeType, data: r.imageData } },
              ],
            };
          }
          return { type: 'tool_result', tool_use_id: r.id, content: r.output };
        }),
      });
    } else {
      for (const r of toolResults) {
        this.history.push({ role: 'tool', tool_call_id: r.id, content: r.output });
      }
      // OpenAI doesn't support images inside tool messages — inject as a follow-up user message
      const images = toolResults.filter((r) => r.imageData && r.mimeType);
      if (images.length) {
        this.history.push({
          role: 'user',
          content: images.map((r) => ({
            type: 'image_url',
            image_url: { url: `data:${r.mimeType};base64,${r.imageData}` },
          })),
        });
      }
    }
  }

  _addTokens(inTok = 0, outTok = 0) {
    this.inputTokens  += (inTok  || 0);
    this.outputTokens += (outTok || 0);
    this.totalTokens   = this.inputTokens + this.outputTokens;
    this.onTokens({ total: this.totalTokens, input: this.inputTokens, output: this.outputTokens });
  }
}

function formatResetTime(isoStr) {
  try {
    const d = new Date(isoStr);
    const diffMs = d - Date.now();
    if (diffMs <= 0) return 'soon';
    const mins = Math.floor(diffMs / 60000);
    if (mins < 60) return `in ${mins} minute${mins !== 1 ? 's' : ''}`;
    const hrs = Math.floor(diffMs / 3600000);
    if (hrs < 24) return `in ${hrs} hour${hrs !== 1 ? 's' : ''}`;
    return `on ${d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`;
  } catch { return 'soon'; }
}

function friendlyError(err, modelAlias) {
  const status = err?.status ?? err?.response?.status;
  const msg    = err?.message || String(err);
  const errObj = err?.error || {};

  if (status === 401 || /unauthorized|invalid.*key|api.?key/i.test(msg)) {
    if (modelAlias === 'other') return `Auth failed for custom endpoint. Use /endpoint <url> <model> <key> to set the API key.`;
    return `Invalid API key for "${modelAlias}". Use /api ${modelAlias} <your-key> to set it.`;
  }
  if (status === 429 || /rate.?limit|quota/i.test(msg)) {
    const resetStr = errObj.reset_at ? ` Resets ${formatResetTime(errObj.reset_at)}.` : '';
    if (errObj.free_tier) return `Lumen free tier limit reached (50 req/day).${resetStr} Get a key at axion.amplifiedsmp.org/keys for 1,000/month.`;
    if (errObj.window)    return `Lumen rate limit reached (40 req/2h).${resetStr}`;
    if (/monthly/i.test(msg)) return `Lumen monthly limit reached (1,000/month).${resetStr}`;
    return `Rate limited by "${modelAlias}".${resetStr || ' Wait a moment and try again.'}`;
  }
  if (status === 404 || /model.*not.*found|no.*model/i.test(msg)) {
    return `Model not found: "${modelAlias}". Try /model <name> to switch.`;
  }
  if (status === 403 || /forbidden|permission/i.test(msg)) {
    return `Access denied for "${modelAlias}". Check that your API key has the right permissions.`;
  }
  if (status === 500 || status === 503) {
    if (/gemini/i.test(modelAlias)) {
      return `Gemini returned a server error. The model name "${modelAlias}" may be wrong or not yet available. Try "gemini-2.0-flash", "gemini-1.5-pro", or the full preview name like "gemini-2.5-flash-preview-05-20".`;
    }
    return `The "${modelAlias}" API returned a server error (${status}). Try again in a moment.`;
  }
  return `Model error (${modelAlias}): ${msg}`;
}
