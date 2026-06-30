import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useKeyboard, useTerminalDimensions, useRenderer } from '@opentui/react';
import { accent, THEMES, setTheme, themeName } from '../ui/theme.js';
import { Agent } from '../agent/agent.js';
import { MODELS, getContextWindow, estimateCost } from '../config.js';
import {
  getTodos, saveModel, saveMode, saveTheme, getAllowedTools, allowTool, autosaveSession, autosaveWorkspace, clearTodos,
  getMemories, addMemory, removeMemory, addTodo, toggleTodo, removeTodo, setTodosFor, dropTodoScope,
  listChats, loadChat, deleteChat, saveChat, exportChat,
  exportSession, importSession,
  listProfiles, saveProfile, loadProfile, deleteProfile,
  saveApiKey, saveCustomEndpoints, getAxionKey, saveAxionKey,
  saveAdviserModel, saveVisionModel, saveImageModel,
  getSkills, saveSkill, deleteSkill,
  undoLastBackup, listCheckpoints, rewindCheckpoints,
  getCompareModels, saveCompareModels, clearAllowedTools,
  searchChats, saveDiscordToken, getDiscordToken,
  undoStackSize, saveDiscordAutoStart,
  saveMacro, loadMacro, listMacros, deleteMacro,
  getLearnedInstructions, appendLearnedInstructions, clearLearnedInstructions,
  getSchedules, saveSchedules, saveScheduleResult, getScheduleResults,
  saveDonateOptOut, saveDonation,
} from '../persist.js';
import { COMMANDS, getTabCompletion } from '../ui/commands.js';
import { permissionKey, confirmLabel } from '../ui/toolPrompts.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { Sidebar } from './Sidebar.jsx';
import { RichText } from './RichText.jsx';
import { ToolBlock } from './ToolBlock.jsx';
import { SuggestionBox } from './Suggestions.jsx';
import { FilePicker } from './FilePicker.jsx';
import { listProjectFiles, fuzzyFilter } from '../utils/fileList.js';
import { diffStats } from '../utils/diff.js';
import { Welcome } from './Welcome.jsx';
import { Thinking } from './Thinking.jsx';
import { QuestionMenu } from './QuestionMenu.jsx';
import { pickThinkingWord } from '../ui/thinkingWords.js';
import { execSync, spawn } from 'child_process';
import { existsSync, readFileSync, unlinkSync, writeSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { homedir } from 'os';
import { MACRO_STATE, captureScreen } from '../agent/computer.js';
import { analyzeScreen } from '../agent/vision.js';
import { MCP } from '../agent/mcp.js';
import { MCP_MARKETPLACE, CATEGORIES, searchMarketplace, getMarketplaceEntry } from '../agent/mcp-marketplace.js';
import { DISCORD_STATE, startDiscord, stopDiscord } from '../agent/discord.js';
import { OAUTH_PROVIDERS } from '../oauth/providers.js';
import { connectOAuth, listOAuthTokens, revokeOAuthToken } from '../oauth/oauth.js';
import { parseSchedule } from '../scheduler.js';
import { executeTool } from '../agent/tools.js';

// ── Milestone 2: real agent wired into the OpenTUI shell ────────────────────────
// Reuses the UI-agnostic Agent class (callbacks → message list). Row layout:
// scrollable message pane + framed input on the left, workspace sidebar on right.
// NOTE (preview): tool confirms / question prompts are auto-approved for now —
// the real prompt UI is a later milestone. Shipped `axion` stays on Ink until parity.

// Expand `@path` file mentions: prepend each referenced file's contents to the
// text sent to the agent (the displayed message keeps the bare @mention).
function expandMentions(text) {
  const mentions = [...new Set([...text.matchAll(/@([^\s@]+)/g)].map((m) => m[1]))];
  if (!mentions.length) return text;
  const blocks = [];
  for (const p of mentions) {
    try {
      const abs = resolve(process.cwd(), p);
      if (existsSync(abs) && statSync(abs).isFile()) {
        const content = readFileSync(abs, 'utf8').slice(0, 100_000);
        blocks.push(`Contents of \`${p}\`:\n\`\`\`\n${content}\n\`\`\``);
      }
    } catch {}
  }
  return blocks.length ? `${blocks.join('\n\n')}\n\n${text}` : text;
}

// Normalize the various ask_* tool payloads into a single QuestionMenu "form".
function normalizeQuestionSpec(spec) {
  const normQ = (q) => {
    const t = (q.type === 'multi' || q.type === 'multiple' || q.type === 'select_all') ? 'multi'
            : (q.type === 'text' || !q.options?.length) ? 'text'
            : 'choice';
    return {
      question: q.question,
      type: t,
      options: q.options || [],
      allowCustom: !!(q.allow_custom ?? q.allowCustom),
      placeholder: q.placeholder,
    };
  };
  if (spec?.type === 'form') return { questions: (spec.questions || []).map(normQ) };
  if (spec?.type === 'multiple_choice') return { questions: [{ question: spec.question, type: 'choice', options: spec.options || [], allowCustom: !!spec.allow_custom }] };
  if (spec?.type === 'confirm') return { questions: [{ question: spec.question, type: 'choice', options: ['Yes', 'No'] }] };
  return { questions: [{ question: spec?.question, type: 'text', placeholder: spec?.placeholder }] };
}

const MODE_ICONS  = { ask: '?', plan: '◈', auto: '⚡', bypass: '⚡', decide: '🤖' };
const MODE_COLORS = { ask: 'cyan', plan: 'yellow', auto: '#7ee787', bypass: '#7ee787', decide: '#c678dd' };
const modeLabel = (m) => (m === 'auto' ? 'bypass' : m === 'decide' ? 'decide-for-me' : m);

function ActionBtn({ label, color, onClick }) {
  return (
    <box onMouseDown={() => onClick?.()} style={{ paddingLeft: 1, paddingRight: 1 }}>
      <text><span fg={color}>{label}</span></text>
    </box>
  );
}

function MessageRow({ msg, expanded = false, onToggle, index, onCopy, onEdit, onDelete, onRetry }) {
  const A = accent();
  const [hovered, setHovered] = useState(false);
  switch (msg.type) {
    case 'user':
      return (
        <box
          onMouseOver={() => setHovered(true)}
          onMouseOut={() => setHovered(false)}
          style={{
            flexDirection: 'column', marginTop: 1, border: true,
            borderColor: hovered ? A : '#444',
            backgroundColor: hovered ? '#26282e' : '#1e1f23',
            paddingLeft: 1, paddingRight: 1,
          }}
        >
          <box style={{ flexDirection: 'row' }}>
            <text><span fg="#b08869">you</span></text>
            {hovered ? (
              <box style={{ flexDirection: 'row', marginLeft: 2 }}>
                <ActionBtn label="⎘ copy" color={A} onClick={() => onCopy?.(index)} />
                <ActionBtn label="✎ edit" color="#7ee787" onClick={() => onEdit?.(index)} />
                <ActionBtn label="✕ delete" color="#f85149" onClick={() => onDelete?.(index)} />
              </box>
            ) : null}
          </box>
          {(msg.text || ' ').split('\n').map((l, i) => <text key={i}>{l}</text>)}
        </box>
      );
    case 'assistant':
      return (
        <box
          onMouseOver={() => setHovered(true)}
          onMouseOut={() => setHovered(false)}
          style={{ flexDirection: 'column', marginTop: 1, paddingLeft: 1, paddingRight: 1 }}
        >
          <box style={{ flexDirection: 'row' }}>
            <text><span fg={A}>✻ Axion</span></text>
            {hovered ? (
              <box style={{ flexDirection: 'row', marginLeft: 2 }}>
                <ActionBtn label="⎘ copy" color={A} onClick={() => onCopy?.(index)} />
                <ActionBtn label="↻ retry" color="#7ee787" onClick={() => onRetry?.(index)} />
              </box>
            ) : null}
          </box>
          <RichText>{msg.text || ' '}</RichText>
        </box>
      );
    case 'thinking': {
      const lines = (msg.text || '').split('\n').filter((l) => l.trim());
      const big = lines.length > 1 || (lines[0] || '').length > 100;
      const shown = expanded || !big ? lines : lines.slice(0, 1);
      return (
        <box style={{ flexDirection: 'column', marginTop: 1, paddingLeft: 1, paddingRight: 1 }}>
          <box onMouseDown={() => big && onToggle?.()}>
            <text>
              <span fg="#a371f7">{big ? (expanded ? '▾ ' : '▸ ') : ''}◈ thinking</span>
              {big && !expanded ? <span fg="#666">{'   click to expand'}</span> : null}
            </text>
          </box>
          {shown.map((l, i) => (
            <text key={i}><span fg="#a371f7">{expanded ? l : l.slice(0, 100)}</span></text>
          ))}
        </box>
      );
    }
    case 'tool':
      return (
        <box style={{ flexDirection: 'column', marginTop: 1 }}>
          <ToolBlock
            name={msg.name}
            input={msg.input}
            output={msg.output}
            success={msg.success}
            pending={msg.pending}
            diff={msg.diff || null}
            expanded={expanded}
            onToggle={onToggle}
          />
        </box>
      );
    case 'error':
      return (
        <box style={{ flexDirection: 'column', marginTop: 1, paddingLeft: 1, paddingRight: 1 }}>
          <text><span fg="red">✖ {msg.text}</span></text>
        </box>
      );
    case 'plan':
      return (
        <box style={{ flexDirection: 'column', marginTop: 1, paddingLeft: 1, paddingRight: 1 }}>
          <text><span fg="yellow">◈ Plan</span></text>
          <RichText>{msg.text || ' '}</RichText>
        </box>
      );
    case 'info':
      return (
        <box style={{ marginTop: 0, paddingLeft: 1, paddingRight: 1 }}>
          <text><span fg="#888">{msg.text}</span></text>
        </box>
      );
    default:
      return null;
  }
}

function Session({
  initialModel = 'lumen', initialMode = 'ask', initialResume = null,
  onExit = () => process.exit(0),
  isActive = true,
  onTitleChange, onNewTab, onCloseTab, onSwitchTab, onBusyChange, onSnapshot,
}) {
  const { width, height } = useTerminalDimensions();
  const A = accent();

  // Per-session TODO scope: resumed chats key by name (stable across resumes),
  // fresh tabs get a unique id so concurrent tabs keep separate lists.
  const scopeRef = useRef();
  if (scopeRef.current === undefined) {
    scopeRef.current = initialResume?.name
      ? `chat:${initialResume.name}`
      : `tab:${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  }
  const todoScope = scopeRef.current;

  const [model, setModel] = useState(initialModel);
  const [mode, setMode]   = useState(initialMode);
  const [messages, setMessages] = useState([]);
  const [streamText, setStreamText] = useState(null); // live streaming assistant text
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [tokens, setTokens] = useState({ total: 0, input: 0, output: 0, context: 0 });
  const [todos, setTodos] = useState(() => getTodos(todoScope));
  const [inputMode, setInputMode] = useState('chat'); // chat | confirm-tool | confirm-plan | question
  const [pendingConfirm, setPendingConfirm] = useState(null);
  const [pendingForm, setPendingForm] = useState(null); // normalized question form for the menu
  const [expandedTools, setExpandedTools] = useState(() => new Set()); // message indices shown in full
  const [atBottom, setAtBottom] = useState(true); // scrollback pinned to bottom?
  const [diffTotals, setDiffTotals] = useState({ added: 0, removed: 0 }); // session edit stats
  const [extThinking, setExtThinking] = useState(false);
  const [thinkingBudget, setThinkingBudget] = useState(10000);
  const [systemOverride, setSystemOverride] = useState('');
  const [includedFiles, setIncludedFiles] = useState([]);
  const [fileList, setFileList] = useState([]);     // project files, scanned lazily on first '@'
  const [fileSel, setFileSel] = useState(0);        // highlighted file in the @-picker
  const fileScannedRef = useRef(false);
  const [goal, setGoal] = useState(null);
  const [computerUse, setComputerUse] = useState(false);
  const [thinkingWord, setThinkingWord] = useState('thinking');
  const [thinkingElapsed, setThinkingElapsed] = useState(0);

  const agentRef  = useRef(null);
  const streamRef = useRef('');
  const flushTimer = useRef(null);
  const inputRef  = useRef('');
  const scrollRef = useRef(null);
  const inputElRef = useRef(null);
  const confirmResolverRef = useRef(null);
  const questionResolverRef = useRef(null);
  const questionSpecRef = useRef(null);
  const pendingAllowKeyRef = useRef(null);
  const lastUserTextRef = useRef('');

  const push = useCallback((msg) => setMessages((m) => [...m, msg]), []);
  const setInputSafe = useCallback((v) => { inputRef.current = v; setInput(v); }, []);
  const toggleExpand = useCallback((i) => {
    // Defer the re-render/relayout out of the native mouse/key event — running a
    // big scrollbox relayout synchronously inside OpenTUI's FFI event dispatch
    // can re-enter the native renderer and segfault Bun.
    setTimeout(() => {
      setExpandedTools((prev) => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; });
    }, 0);
  }, []);
  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    try { el.scrollTo(el.scrollHeight); } catch { try { el.scrollBy(el.scrollHeight || 9999); } catch {} }
    setAtBottom(true);
  }, []);

  // ── Per-message actions (hover bar on your own messages) ──────────────────────
  const copyMessage = useCallback((i) => {
    const t = messages[i]?.text || '';
    if (t) { copyToClipboard(t); push({ type: 'info', text: '✔ copied message to clipboard.' }); }
  }, [messages, push]);

  // Roll the agent history back to just before the user turn shown at display
  // index `i` (the k-th user message ↔ the k-th real user turn in history; skips
  // tool-result 'user' messages). Returns that message's text.
  const rollbackToUserMsg = useCallback((i) => {
    let k = 0;
    for (let j = 0; j <= i; j++) if (messages[j]?.type === 'user') k++;
    const h = agentRef.current?.history || [];
    let count = 0, cut = h.length;
    for (let j = 0; j < h.length; j++) {
      const m = h[j];
      const isTurn = m.role === 'user' && (typeof m.content === 'string' || (Array.isArray(m.content) && m.content.some((c) => c.type === 'text')));
      if (isTurn) { count++; if (count === k) { cut = j; break; } }
    }
    if (agentRef.current) agentRef.current.history = h.slice(0, cut);
    return messages[i]?.text || '';
  }, [messages]);

  const editMessage = useCallback((i) => {
    if (busy) return;
    const t = rollbackToUserMsg(i);
    setMessages((m) => m.slice(0, i));
    setInputSafe(t);
    // OpenTUI focuses the clicked element's scrollbox after this handler returns,
    // so defer re-focusing the input until the click cycle is done.
    setTimeout(() => { try { inputElRef.current?.focus?.(); } catch {} }, 0);
  }, [busy, rollbackToUserMsg, setInputSafe]);

  const deleteFrom = useCallback((i) => {
    if (busy) return;
    const removed = messages.length - i;
    rollbackToUserMsg(i);
    setMessages((m) => m.slice(0, i));
    push({ type: 'info', text: `Removed this message and ${removed - 1} after it.` });
  }, [busy, messages, rollbackToUserMsg, push]);

  // Throttled flush of streaming text to state.
  const flushStream = useCallback(() => {
    flushTimer.current = null;
    setStreamText(streamRef.current);
  }, []);

  // ── Init the agent once ───────────────────────────────────────────────────────
  useEffect(() => {
    const agent = new Agent({
      modelAlias: initialModel,
      mode: initialMode,
      todoScope,
      onTokens: (t) => setTokens(typeof t === 'object' ? t : { total: t, input: 0, output: t, context: t }),
      onStreamChunk: (chunk) => {
        streamRef.current += chunk;
        if (!flushTimer.current) flushTimer.current = setTimeout(flushStream, 30);
      },
      onStreamEnd: () => {
        if (flushTimer.current) { clearTimeout(flushTimer.current); flushTimer.current = null; }
        streamRef.current = '';
        setStreamText(null);
      },
      onToolCall: ({ name, input, id }) => push({ type: 'tool', id, name, input, pending: true }),
      onToolResult: ({ id, name, output, success, diff }) => {
        if (diff && diff.length && success !== false) {
          const s = diffStats(diff);
          setDiffTotals((t) => ({ added: t.added + (s.added || 0), removed: t.removed + (s.removed || 0) }));
        }
        setMessages((m) => {
          let ri = id != null ? m.findIndex((x) => x.type === 'tool' && x.id === id && x.pending) : -1;
          if (ri === -1) ri = m.findIndex((x) => x.type === 'tool' && x.name === name && x.pending);
          if (ri === -1) return m;
          const copy = m.slice();
          copy[ri] = { ...copy[ri], output, success, diff: diff || null, pending: false };
          return copy;
        });
      },
      onMessage: ({ role, content }) => {
        if (role === 'assistant')      push({ type: 'assistant', text: content });
        else if (role === 'thinking')  push({ type: 'thinking', text: content });
        else if (role === 'plan')      push({ type: 'plan', text: content });
        else if (role === 'error')     push({ type: 'error', text: content });
      },
    });
    agentRef.current = agent;

    // Resume: seed the agent history + message log from a saved/last session.
    if (initialResume && Array.isArray(initialResume.agentHistory)) {
      agent.history = initialResume.agentHistory;
      agent.totalTokens = initialResume.tokenCount || 0;
      // Estimate context pressure from the loaded history (~4 chars/token); the
      // next request replaces it with the exact input_tokens from the API.
      const ctxEst = Math.round(JSON.stringify(agent.history || []).length / 4);
      agent.contextTokens = ctxEst;
      const tok = { total: initialResume.tokenCount || 0, input: 0, output: initialResume.tokenCount || 0, context: ctxEst };
      setTokens(tok);
      const when = initialResume.savedAt ? new Date(initialResume.savedAt).toLocaleString() : 'earlier';
      setMessages([
        { type: 'info', text: `── continuing previous session (saved ${when}) ──` },
        ...(initialResume.displayMessages || []),
        { type: 'info', text: '── end of previous session — continuing from here ──' },
      ]);
      // Restore this chat's saved todos into its scope.
      try { setTodosFor(todoScope, initialResume.todos || []); } catch {}
      setTodos(getTodos(todoScope));
    } else {
      // Fresh tab — start with a clean, isolated todo list for this scope.
      try { clearTodos(todoScope); } catch {}
      setTodos([]);
    }

    return () => { try { agent.cancel(); } catch {} };
  }, [initialModel, initialMode, push, flushStream]); // eslint-disable-line

  // On unmount (tab closed / app exit), drop this scope's scratch todo list.
  // Named-chat todos are already persisted inside the saved chat, so this only
  // reclaims ephemeral per-tab lists; 'global' is left untouched by dropTodoScope.
  useEffect(() => () => { try { dropTodoScope(todoScope); } catch {} }, [todoScope]);

  // Build the serializable session for autosave / resume / exit summary.
  const buildSession = useCallback(() => {
    const displayMessages = messages.filter((m) => m.type !== 'info');
    const inTok = tokens.input || 0, outTok = tokens.output || 0;
    return {
      model, mode,
      cwd: process.cwd(),
      tokenCount: tokens.total || 0,
      cost: estimateCost(model, inTok, outTok) || 0,
      agentHistory: agentRef.current?.history || [],
      displayMessages,
      todos: getTodos(todoScope),
    };
  }, [messages, model, mode, tokens, todoScope]);

  // Report this tab's session snapshot up to the shell 1s after it settles. The
  // shell persists the active tab to the "last session" slot (for `axion -c`) and
  // all tabs to the workspace file (so background tabs survive a crash/exit).
  const autosaveTimer = useRef(null);
  useEffect(() => {
    const hist = agentRef.current?.history;
    if (!hist || hist.length === 0) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      try { onSnapshot?.(buildSession(), isActive); } catch {}
    }, 1000);
    return () => { if (autosaveTimer.current) clearTimeout(autosaveTimer.current); };
  }, [messages, model, mode, buildSession, isActive, onSnapshot]);

  // Refresh this scope's todos periodically (the agent can add them via tools).
  useEffect(() => {
    const id = setInterval(() => setTodos(getTodos(todoScope)), 2000);
    return () => clearInterval(id);
  }, [todoScope]);

  // Poll scroll position to show/hide the "jump to bottom" button. No scroll
  // event in OpenTUI, so we sample scrollTop vs. the max scroll a few times/sec.
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => {
      const el = scrollRef.current;
      if (!el) return;
      try {
        const vh = el.viewport?.height ?? el.height ?? 0;
        const max = (el.scrollHeight || 0) - vh;
        const bottom = max <= 1 || el.scrollTop >= max - 1;
        setAtBottom((prev) => (prev === bottom ? prev : bottom));
      } catch {}
    }, 200);
    return () => clearInterval(id);
  }, [isActive]);

  // Thinking timer — counts up (seconds) while the agent is working.
  useEffect(() => {
    if (!busy) return;
    setThinkingElapsed(0);
    const start = Date.now();
    const id = setInterval(() => setThinkingElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [busy]);

  // Report this tab's working/idle status up to the shell (drives the terminal
  // title spinner + the desktop "done" ping, even for background tabs).
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  // Ctrl+C double-tap exits. Ctrl+Shift+C is ignored (OS paste).
  // Esc interrupts a running turn. Tab completes a slash command.
  // PageUp/Down + arrows scroll the message history (input keeps focus;
  // mouse wheel works natively). Scrolling up disengages sticky-to-bottom.
  const lastCtrlCRef = useRef(0);
  const resolveConfirm = useCallback((val) => {
    const r = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setPendingConfirm(null);
    setInputMode('chat');
    r?.(val);
  }, []);

  // ── @file mentions ────────────────────────────────────────────────────────────
  // Active when the input ends with `@<query>` (in chat mode, not a slash command).
  const atMatch = (inputMode === 'chat' && !input.startsWith('/')) ? input.match(/(^|\s)@([^\s@]*)$/) : null;
  const fileQuery = atMatch ? atMatch[2] : null;
  const fileActive = fileQuery !== null;
  const fileMatches = fileActive ? fuzzyFilter(fileList, fileQuery, 8) : [];

  // Scan the project the first time '@' is used; reset highlight as the query changes.
  useEffect(() => {
    if (fileActive && !fileScannedRef.current) { fileScannedRef.current = true; try { setFileList(listProjectFiles()); } catch {} }
  }, [fileActive]);
  useEffect(() => { setFileSel(0); }, [fileQuery]);

  // Replace the trailing `@<query>` with the chosen path, then re-focus the input.
  const insertFile = useCallback((f) => {
    if (!f) return;
    const replaced = inputRef.current.replace(/(^|\s)@([^\s@]*)$/, (m, pre) => `${pre}@${f} `);
    setInputSafe(replaced);
    setFileSel(0);
    setTimeout(() => { try { inputElRef.current?.focus?.(); } catch {} }, 0);
  }, [setInputSafe]);

  useKeyboard((key) => {
    if (!isActive) return; // only the foreground tab handles keys
    const ch = (key.name || '').toLowerCase();

    // Tab management: Ctrl+T new, Ctrl+W close, Shift+Tab cycle, Ctrl+1..9 jump.
    // (Ctrl+Tab is intercepted by Windows Terminal, so Shift+Tab is the cycle key.)
    if (key.ctrl && ch === 't') { onNewTab?.(); return; }
    if (key.ctrl && ch === 'w') { onCloseTab?.(buildSession()); return; }
    if (key.name === 'backtab' || (key.name === 'tab' && key.shift)) { onSwitchTab?.('next'); return; }
    if (key.ctrl && /^[1-9]$/.test(key.name || '')) { onSwitchTab?.(parseInt(key.name, 10) - 1); return; }

    // Ctrl+Shift+C: copy last assistant response. Ctrl+C: double-tap to quit.
    if (key.ctrl && ch === 'c') {
      if (key.shift) {
        const last = [...messages].reverse().find(m => m.type === 'assistant');
        if (last?.text) { copyToClipboard(last.text); push({ type: 'info', text: '✔ copied last response.' }); }
        return;
      }
      const now = Date.now();
      if (now - lastCtrlCRef.current < 1000) { onExit(buildSession()); return; }
      lastCtrlCRef.current = now;
      push({ type: 'info', text: 'Press Ctrl+C again to quit' });
      return;
    }

    // Tool-confirmation prompt: y = allow once, a = always allow, n/Esc = deny.
    if (inputMode === 'confirm-tool') {
      if (ch === 'y' || key.name === 'return') resolveConfirm(true);
      else if (ch === 'a') { try { allowTool(pendingAllowKeyRef.current); } catch {} resolveConfirm(true); }
      else if (ch === 'n' || key.name === 'escape') resolveConfirm(false);
      return;
    }
    if (inputMode === 'confirm-plan') {
      if (ch === 'y' || key.name === 'return') resolveConfirm(true);
      else if (ch === 'n' || key.name === 'escape') resolveConfirm(false);
      return;
    }
    // Question prompt is fully handled by <QuestionMenu> (its own useKeyboard).
    if (inputMode === 'question') return;

    // @file picker: ↑/↓ move, Tab inserts (Enter inserts via the input's onSubmit).
    if (fileActive && fileMatches.length) {
      const n = fileMatches.length;
      if (key.name === 'up')   { setFileSel((s) => (s - 1 + n) % n); return; }
      if (key.name === 'down') { setFileSel((s) => (s + 1) % n); return; }
      if (key.name === 'tab')  { insertFile(fileMatches[Math.min(fileSel, n - 1)]); return; }
    }

    // Chat mode
    if (key.name === 'escape' && busy) { try { agentRef.current?.cancel(); } catch {} return; }
    // Ctrl+R: expand/collapse the most recent tool or thinking block.
    if (key.ctrl && ch === 'r') {
      setMessages((m) => {
        const ri = [...m].reverse().findIndex((x) => (x.type === 'tool' && !x.pending) || x.type === 'thinking');
        if (ri !== -1) toggleExpand(m.length - 1 - ri);
        return m;
      });
      return;
    }
    if (key.name === 'tab' && inputRef.current.startsWith('/')) {
      const completed = getTabCompletion(inputRef.current);
      if (completed) setInputSafe(completed);
      return;
    }
    const sb = scrollRef.current;
    if (sb && typeof sb.scrollBy === 'function') {
      if (key.name === 'pageup')   { sb.scrollBy(-12); return; }
      if (key.name === 'pagedown') { sb.scrollBy(12);  return; }
      if (key.name === 'up')       { sb.scrollBy(-2);  return; }
      if (key.name === 'down')     { sb.scrollBy(2);   return; }
    }
  });

  const submitRef = useRef(null);

  // ── Slash commands (essential set; others report "coming soon") ─────────────────
  const runCommand = useCallback(async (raw) => {
    const [cmd, ...rest] = raw.slice(1).trim().split(/\s+/);
    const args = rest;
    const arg = rest.join(' ').trim();
    const c = (cmd || '').toLowerCase();
    switch (c) {
      case 'exit': case 'quit':
        onExit(buildSession());
        return;
      case 'stats': {
        const inTok = tokens.input || 0, outTok = tokens.output || 0;
        const cost = estimateCost(model, inTok, outTok) || 0;
        const msgCount = messages.filter((m) => m.type === 'user' || m.type === 'assistant').length;
        push({ type: 'info', text:
          `Session stats\n  model     ${model}\n  mode      ${modeLabel(mode)}\n  messages  ${msgCount}` +
          `\n  tokens    ${tokens.total || 0}  (in ${inTok} / out ${outTok})\n  est. cost ${cost ? '$' + cost.toFixed(4) : '$0.00'}` });
        return;
      }
      case 'clear':
        try { agentRef.current?.clearHistory(); } catch {}
        setMessages([{ type: 'info', text: 'Conversation cleared.' }]);
        setTokens({ total: 0, input: 0, output: 0, context: 0 });
        return;
      case 'help':
        push({ type: 'info', text: 'Commands:\n' + COMMANDS.map((x) => `  /${x.cmd}  —  ${x.desc}`).join('\n') });
        return;
      case 'models': {
        const { CUSTOM_ENDPOINTS } = await import('../config.js');
        const fmtCtx = (v) => (v >= 1_000_000 ? (v / 1_000_000).toFixed(1) + 'M' : (v / 1000).toFixed(0) + 'k');
        const lines = ['Models:'];
        for (const [alias, id] of Object.entries(MODELS)) {
          const cur = alias === model ? '▸' : ' ';
          lines.push(`${cur} ${alias.padEnd(20)} ${fmtCtx(getContextWindow(alias)).padStart(5)}  ${id}`);
        }
        const eps = Object.entries(CUSTOM_ENDPOINTS);
        if (eps.length) {
          lines.push('', 'Endpoints:');
          for (const [name, e] of eps) {
            const cur = name === model ? '▸' : ' ';
            const ctx = e.context || getContextWindow(name);
            lines.push(`${cur} ${name.padEnd(20)} ${fmtCtx(ctx).padStart(5)}  ${e.model || ''} @ ${e.baseURL}`);
          }
        }
        lines.push('', 'Use /model <name> to switch  ·  /endpoint to add one.');
        push({ type: 'info', text: lines.join('\n') });
        return;
      }
      case 'model': {
        if (!arg) {
          const ctx = getContextWindow(model);
          push({ type: 'info', text: `current model: ${model}  ·  context: ${ctx >= 1_000_000 ? (ctx / 1_000_000).toFixed(1) + 'M' : (ctx / 1000).toFixed(0) + 'k'} tokens` });
          return;
        }
        const { CUSTOM_ENDPOINTS } = await import('../config.js');
        if (!MODELS[arg] && !CUSTOM_ENDPOINTS[arg] && !arg.includes('/')) { push({ type: 'error', text: `Unknown model "${arg}". /models to list.` }); return; }
        setModel(arg); agentRef.current?.setModel(arg); try { saveModel(arg); } catch {}
        const ctx = getContextWindow(arg);
        push({ type: 'info', text: `model → ${arg}  ·  context: ${ctx >= 1_000_000 ? (ctx / 1_000_000).toFixed(1) + 'M' : (ctx / 1000).toFixed(0) + 'k'} tokens` });
        return;
      }
      case 'mode': {
        if (!arg) { push({ type: 'info', text: `current mode: ${modeLabel(mode)}` }); return; }
        if (!['ask', 'plan', 'auto', 'bypass', 'decide', 'decide-for-me'].includes(arg)) { push({ type: 'error', text: 'Mode must be ask | plan | bypass | decide-for-me.' }); return; }
        const norm = arg === 'bypass' ? 'auto' : arg === 'decide-for-me' ? 'decide' : arg;
        setMode(norm); agentRef.current?.setMode(norm); try { saveMode(norm); } catch {}
        push({ type: 'info', text: `mode → ${modeLabel(norm)}` });
        return;
      }
      case 'theme': {
        if (!arg) { push({ type: 'info', text: `themes: ${Object.keys(THEMES).join(' · ')}  (current: ${themeName()})` }); return; }
        if (!setTheme(arg)) { push({ type: 'error', text: `Unknown theme "${arg}". Options: ${Object.keys(THEMES).join(', ')}` }); return; }
        try { saveTheme(arg); } catch {}
        push({ type: 'info', text: `theme → ${arg}` });
        return;
      }
      case 'cost': {
        const inTok = tokens.input || 0, outTok = tokens.output || 0;
        const ctx = getContextWindow(model);
        const cost = estimateCost(model, inTok, outTok);
        push({ type: 'info', text: `tokens: ${tokens.total || 0}  (in ${inTok} / out ${outTok}) · context: ${ctx >= 1_000_000 ? (ctx / 1_000_000).toFixed(1) + 'M' : (ctx / 1000).toFixed(0) + 'k'} · est. cost ${cost ? '$' + cost.toFixed(4) : '$0.00'}` });
        return;
      }
      case 'thinking': {
        const lower = arg.toLowerCase();
        if (!arg) {
          push({ type: 'info', text: `extended thinking: ${extThinking ? 'on (budget ' + (agentRef.current?.thinking?.budget || thinkingBudget) + ')' : 'off'}` });
          return;
        }
        if (lower === 'off') { setExtThinking(false); agentRef.current?.setThinking(false); push({ type: 'info', text: 'extended thinking off' }); return; }
        if (lower === 'on') { setExtThinking(true); agentRef.current?.setThinking(true, thinkingBudget); push({ type: 'info', text: `extended thinking on (budget ${thinkingBudget})` }); return; }
        const budget = parseInt(arg, 10);
        if (!isNaN(budget) && budget >= 1000) { setExtThinking(true); setThinkingBudget(budget); agentRef.current?.setThinking(true, budget); push({ type: 'info', text: `extended thinking on (budget ${budget})` }); return; }
        push({ type: 'error', text: 'usage: /thinking [on|off|<tokens>]  e.g. /thinking 20000' });
        return;
      }
      case 'system': {
        if (!arg || arg === 'clear') { setSystemOverride(''); agentRef.current?.setSystemOverride(''); push({ type: 'info', text: 'system override cleared' }); return; }
        setSystemOverride(arg); agentRef.current?.setSystemOverride(arg);
        push({ type: 'info', text: `system override set: ${arg}` });
        return;
      }
      case 'retry': {
        const lastMsg = lastUserTextRef.current;
        if (!lastMsg) { push({ type: 'info', text: 'Nothing to retry yet.' }); return; }
        const h = agentRef.current?.history;
        if (h) {
          const lastUserIdx = [...h].reverse().findIndex((m) => m.role === 'user');
          if (lastUserIdx !== -1) agentRef.current.history = h.slice(0, h.length - 1 - lastUserIdx);
        }
        push({ type: 'info', text: `↩ Retrying: "${lastMsg}"` });
        push({ type: 'user', text: lastMsg });
        setThinkingWord(pickThinkingWord());
        setBusy(true);
        agentRef.current
          .run(lastMsg, {
            askConfirm: () => Promise.resolve(true),
            askPlanConfirm: () => Promise.resolve(true),
            askUser: () => Promise.resolve(''),
          })
          .catch((err) => push({ type: 'error', text: err?.message || String(err) }))
          .finally(() => setBusy(false));
        return;
      }
      case 'compact':
        if (!agentRef.current) { push({ type: 'error', text: 'Agent not initialized.' }); return; }
        push({ type: 'info', text: 'Compacting agent history…' });
        agentRef.current.compact().then(() => {
          push({ type: 'info', text: 'History compacted.' });
        }).catch((err) => push({ type: 'error', text: `Compact failed: ${err?.message || err}` }));
        return;
      case 'remember':
        if (!arg) {
          const mems = getMemories();
          if (!mems.length) { push({ type: 'info', text: 'No memories saved. Use /remember <text> to add one.' }); return; }
          push({ type: 'info', text: `Persistent notes (${mems.length}):\n${mems.map((m, i) => `  ${i + 1}. ${m.text}`).join('\n')}\n\nUse /forget <number> to remove one.` });
          return;
        }
        addMemory(arg);
        push({ type: 'info', text: `Remembered: "${arg}"` });
        return;
      case 'forget': {
        const idx = parseInt(arg, 10) - 1;
        if (isNaN(idx) || idx < 0) { push({ type: 'error', text: 'usage: /forget <number>  (use /remember to see numbered list)' }); return; }
        const mems = getMemories();
        if (idx >= mems.length) { push({ type: 'error', text: `No memory #${idx + 1}. Run /remember to see the list.` }); return; }
        removeMemory(idx);
        push({ type: 'info', text: `Forgotten: "${mems[idx].text}"` });
        return;
      }
      case 'todo': {
        const [sub, ...todoRest] = args;
        const todoText = todoRest.join(' ').trim();
        if (!sub) {
          const all = getTodos(todoScope);
          if (!all.length) { push({ type: 'info', text: 'TODO list is empty.\n  /todo add <text>   add a task\n  /todo done <id>    mark complete\n  /todo list         show all\n  /todo clear        clear completed' }); return; }
          const pending = all.filter(t => !t.done);
          const done = all.filter(t => t.done);
          push({ type: 'info', text: `Pending: ${pending.length}  Done: ${done.length}  Total: ${all.length}\n${pending.map(t => `  ☐ ${t.text}  [${t.id}]`).join('\n')}${done.length ? `\n  ☑ ${done.length} completed (use /todo list to see)` : ''}` });
          return;
        }
        if (sub === 'add') {
          if (!todoText) { push({ type: 'error', text: 'usage: /todo add <text>' }); return; }
          addTodo(todoText, { scope: todoScope }); setTodos(getTodos(todoScope));
          push({ type: 'info', text: `✔ Added: "${todoText}"` });
          return;
        }
        if (sub === 'done') {
          if (!todoText) { push({ type: 'error', text: 'usage: /todo done <id>' }); return; }
          const toggled = toggleTodo(todoText, todoScope);
          if (!toggled) { push({ type: 'error', text: `No TODO found with id "${todoText}". Use /todo to see ids.` }); return; }
          setTodos(getTodos(todoScope));
          push({ type: 'info', text: toggled.done ? `✔ Completed: "${toggled.text}"` : `↩ Reopened: "${toggled.text}"` });
          return;
        }
        if (sub === 'list') {
          const all = getTodos(todoScope);
          if (!all.length) { push({ type: 'info', text: 'TODO list is empty.' }); return; }
          const pending = all.filter(t => !t.done);
          const done = all.filter(t => t.done);
          push({ type: 'info', text: `── TODOs ──  Pending: ${pending.length}  Done: ${done.length}\n${pending.map(t => `  ☐ ${t.text}  [${t.id}]`).join('\n')}\n${done.map(t => `  ☑ ${t.text}  [${t.id}]`).join('\n')}` });
          return;
        }
        if (sub === 'clear') {
          const completed = getTodos(todoScope).filter(t => t.done);
          completed.forEach(t => removeTodo(t.id, todoScope)); setTodos(getTodos(todoScope));
          push({ type: 'info', text: `Cleared ${completed.length} completed tasks.` });
          return;
        }
        push({ type: 'error', text: `Unknown subcommand: /todo ${sub}\nUsage: /todo add|done|list|clear` });
        return;
      }
      case 'copy': {
        const lastAssistants = [...messages].reverse().filter((m) => m.type === 'assistant');
        if (!lastAssistants.length) { push({ type: 'error', text: 'No assistant response to copy.' }); return; }
        copyToClipboard(lastAssistants[0].text || '');
        push({ type: 'info', text: '✔ copied last response to clipboard.' });
        return;
      }
      case 'copy-block': {
        const n = parseInt(arg, 10);
        if (!arg || isNaN(n) || n < 1) { push({ type: 'error', text: 'usage: /copy-block <n>' }); return; }
        const allMsgs = messages;
        const lastAsst = [...allMsgs].reverse().find(m => m.type === 'assistant');
        if (!lastAsst?.text) { push({ type: 'info', text: 'No AI response to copy from.' }); return; }
        const blocks = []; const blockRe = /```(?:[^\n]*)?\n([\s\S]*?)```/g; let bm;
        while ((bm = blockRe.exec(lastAsst.text)) !== null) blocks.push(bm[1]);
        if (!blocks.length) { push({ type: 'info', text: 'No code blocks found in last response.' }); return; }
        if (n > blocks.length) { push({ type: 'info', text: `Only ${blocks.length} code block(s) found. Use /copy-block 1–${blocks.length}.` }); return; }
        copyToClipboard(blocks[n - 1]);
        push({ type: 'info', text: `✔ Code block ${n}/${blocks.length} copied.` });
        return;
      }
      case 'undo': {
        const restored = undoLastBackup();
        if (restored) { push({ type: 'info', text: `↩ Restored: ${restored}  (${undoStackSize()} more undo${undoStackSize() !== 1 ? 's' : ''} available)` }); }
        else { push({ type: 'info', text: 'Nothing to undo.' }); }
        return;
      }
      case 'rewind': {
        if (!arg || arg === 'list') {
          const cps = listCheckpoints();
          if (!cps.length) { push({ type: 'info', text: 'No checkpoints yet — one is created each time the agent edits files in a turn.' }); return; }
          const lines = cps.map((c, i) => `  ${i + 1}. ${new Date(c.ts).toLocaleTimeString()}  ${c.fileCount} file${c.fileCount !== 1 ? 's' : ''}  "${c.label}"`).join('\n');
          push({ type: 'info', text: `Checkpoints (most recent first):\n${lines}\n\n/rewind <n> restores the last n turns' file changes` });
          return;
        }
        const n = parseInt(arg, 10);
        if (!Number.isInteger(n) || n < 1) { push({ type: 'error', text: 'usage: /rewind [list|<n>]' }); return; }
        const { undone, restored, deleted } = rewindCheckpoints(n);
        if (!undone) { push({ type: 'info', text: 'Nothing to rewind.' }); return; }
        const parts = [];
        if (restored?.length) parts.push(`restored: ${restored.map(p => p.replace(process.cwd() + '/', '')).join(', ')}`);
        if (deleted?.length) parts.push(`deleted: ${deleted.map(p => p.replace(process.cwd() + '/', '')).join(', ')}`);
        push({ type: 'info', text: `⏪ rewound ${undone} checkpoint${undone > 1 ? 's' : ''}${parts.length ? ' — ' + parts.join(' · ') : ' (no file changes)'}` });
        return;
      }
      case 'permissions': {
        if (arg === 'clear') { clearAllowedTools(); push({ type: 'info', text: 'Cleared all always-allow permissions for this project.' }); return; }
        const allowed = getAllowedTools();
        if (!allowed.length) { push({ type: 'info', text: 'No always-allowed tools. Press "a" on any tool confirm to add one.\n/permissions clear to reset.' }); return; }
        push({ type: 'info', text: `Always allowed:\n${allowed.map(k => `  • ${k}`).join('\n')}\n\n/permissions clear to reset` });
        return;
      }
      case 'adviser':
      case 'advisor': {
        if (!arg) {
          const current = agentRef.current?.adviserModel;
          push({ type: 'info', text: current ? `Adviser model: ${current}` : 'Adviser model: auto (picks highest-capability available model)\n/adviser <model> to pin, /adviser off to disable' });
          return;
        }
        if (arg === 'auto') { agentRef.current?.setAdviserModel(null); saveAdviserModel(null); push({ type: 'info', text: 'Adviser model set to auto.' }); return; }
        if (arg === 'off') { agentRef.current?.setAdviserModel('off'); saveAdviserModel('off'); push({ type: 'info', text: 'Adviser disabled.' }); return; }
        agentRef.current?.setAdviserModel(arg); saveAdviserModel(arg);
        push({ type: 'info', text: `Adviser model → ${arg} (saved)` });
        return;
      }
      case 'include': {
        const [sub, ...incRest] = args;
        if (!sub) {
          if (!includedFiles.length) { push({ type: 'info', text: 'No files pinned. Usage: /include <file>' }); return; }
          push({ type: 'info', text: `Pinned files (${includedFiles.length}):\n${includedFiles.map((f, i) => `  ${i + 1}. ${f.path}  (${f.content.length} chars)`).join('\n')}\n\nUse /include remove <file> or /include clear` });
          return;
        }
        if (sub === 'clear') { setIncludedFiles([]); push({ type: 'info', text: 'All pinned files removed.' }); return; }
        if (sub === 'remove') {
          const target = incRest.join(' ');
          if (!target) { push({ type: 'error', text: 'usage: /include remove <file>' }); return; }
          setIncludedFiles(prev => prev.filter(f => f.path !== target));
          push({ type: 'info', text: `Unpinned: ${target}` });
          return;
        }
        const filePath = [sub, ...incRest].join(' ');
        try {
          const abs = resolve(process.cwd(), filePath);
          if (!existsSync(abs)) throw new Error(`File not found: ${filePath}`);
          const content = readFileSync(abs, 'utf8');
          setIncludedFiles(prev => prev.some(f => f.path === filePath) ? prev : [...prev, { path: filePath, content }]);
          push({ type: 'info', text: `Pinned: ${filePath}  (${content.length} chars)` });
        } catch (err) { push({ type: 'error', text: `include failed: ${err.message}` }); }
        return;
      }
      case 'run': {
        if (!arg) { push({ type: 'error', text: 'usage: /run <shell command>' }); return; }
        push({ type: 'info', text: `▶ ${arg}` });
        try {
          const output = execSync(arg, { encoding: 'utf8', cwd: process.cwd(), timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
          push({ type: 'info', text: output || '(no output)' });
          if (output) { submitRef.current(`Output of \`${arg}\`:\n\`\`\`\n${output.slice(0, 8000)}\n\`\`\``); }
        } catch (err) {
          const out = ((err.stdout || '') + (err.stderr || '')).trim();
          push({ type: 'error', text: `exited ${err.status ?? '?'}: ${out || err.message}` });
          if (out) { submitRef.current(`Command \`${arg}\` failed (exit ${err.status ?? '?'}):\n\`\`\`\n${out.slice(0, 8000)}\n\`\`\``); }
        }
        return;
      }
      case 'pr': {
        try {
          const log = execSync('git log @{u}..HEAD --oneline --no-decorate 2>nul || git log HEAD~5..HEAD --oneline --no-decorate', { encoding: 'utf8', cwd: process.cwd() }).trim();
          const diff = execSync('git diff @{u}..HEAD --stat 2>nul || git diff HEAD~5..HEAD --stat', { encoding: 'utf8', cwd: process.cwd() }).trim();
          if (!log) { push({ type: 'info', text: 'No commits ahead of upstream. Nothing to PR.' }); return; }
          const prompt = arg
            ? `Create a PR for these commits. Extra context: ${arg}\n\nCommits:\n${log}\n\nChanged files:\n${diff}\n\nRespond with ONLY:\nTITLE: <title>\nBODY:\n<markdown body>`
            : `Create a PR for these commits.\n\nCommits:\n${log}\n\nChanged files:\n${diff}\n\nRespond with ONLY:\nTITLE: <title>\nBODY:\n<markdown body>`;
          push({ type: 'info', text: `Drafting PR from ${log.split('\n').length} commit(s)…` });
          submitRef.current(prompt);
        } catch (err) { push({ type: 'error', text: `git error: ${err.message.split('\n')[0]}` }); }
        return;
      }
      case 'review': {
        let diff = '';
        try {
          diff = [execSync('git diff --cached', { cwd: process.cwd(), encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }),
                  execSync('git diff HEAD', { cwd: process.cwd(), encoding: 'utf8', stdio: ['pipe','pipe','pipe'] })].filter(Boolean).join('\n');
        } catch { diff = ''; }
        if (!diff.trim()) { push({ type: 'info', text: 'No changes to review.' }); return; }
        push({ type: 'info', text: 'Reviewing diff…' });
        const reviewPrompt = `Review this git diff. Be concise. One line per finding.\n\n\`\`\`diff\n${diff.slice(0, 12000)}\n\`\`\``;
        agentRef.current?.askBtw(reviewPrompt).then((feedback) => {
          push({ type: 'assistant', text: feedback });
        }).catch((err) => push({ type: 'error', text: `review failed: ${err.message}` }));
        return;
      }
      case 'btw': {
        if (!arg) { push({ type: 'error', text: 'usage: /btw <question>' }); return; }
        push({ type: 'user', text: `btw: ${arg}` });
        setThinkingWord('checking');
        agentRef.current?.askBtw(arg).then((answer) => {
          push({ type: 'assistant', text: answer });
        }).catch((err) => push({ type: 'error', text: `btw failed: ${err.message}` }));
        return;
      }
      case 'export': {
        if (!arg) { push({ type: 'error', text: 'usage: /export <filename>' }); return; }
        try {
          const outPath = exportChat(arg, messages.filter(m => m.type !== 'info'));
          push({ type: 'info', text: `✔ Exported to ${outPath}` });
        } catch (err) { push({ type: 'error', text: `Export failed: ${err.message}` }); }
        return;
      }
      case 'export-session': {
        if (!arg) { push({ type: 'error', text: 'usage: /export-session <path>' }); return; }
        try {
          const sessionData = { model, mode, agentHistory: agentRef.current?.history || [], displayMessages: messages, tokenCount: tokens.total, systemOverride };
          const outPath = exportSession(arg, sessionData);
          push({ type: 'info', text: `✔ Session exported to ${outPath}` });
        } catch (err) { push({ type: 'error', text: `Export failed: ${err.message}` }); }
        return;
      }
      case 'import-session': {
        if (!arg) { push({ type: 'error', text: 'usage: /import-session <path>' }); return; }
        try {
          const data = importSession(arg);
          if (!data) { push({ type: 'error', text: `Not a valid session file: ${arg}` }); return; }
          if (data.model) { setModel(data.model); agentRef.current?.setModel(data.model); saveModel(data.model); }
          if (data.mode) { setMode(data.mode); agentRef.current?.setMode(data.mode); saveMode(data.mode); }
          if (data.agentHistory) agentRef.current.history = data.agentHistory;
          if (data.systemOverride) { setSystemOverride(data.systemOverride); agentRef.current?.setSystemOverride(data.systemOverride); }
          setTokens({ total: data.tokenCount || 0, input: 0, output: data.tokenCount || 0, context: 0 });
          push({ type: 'info', text: `✔ Session imported: ${data.model || model} · ${data.mode || mode}` });
        } catch (err) { push({ type: 'error', text: `Import failed: ${err.message}` }); }
        return;
      }
      case 'save': {
        if (!arg) { push({ type: 'error', text: 'usage: /save <chatname>' }); return; }
        try {
          saveChat(arg, { model, mode, tokenCount: tokens.total, agentHistory: agentRef.current?.history || [], displayMessages: messages.filter(m => m.type !== 'info') });
          push({ type: 'info', text: `Chat saved as "${arg}".` });
        } catch (err) { push({ type: 'error', text: `Save failed: ${err.message}` }); }
        return;
      }
      case 'resume': {
        if (!arg) {
          const chats = listChats();
          if (!chats.length) { push({ type: 'info', text: 'No saved chats. Use /save <chatname> to save one.' }); return; }
          push({ type: 'info', text: `Saved chats:\n${chats.map(c => `  ${c.name.padEnd(20)} ${(c.model || '?').padEnd(14)} ${c.messages ?? '?'} msgs  ${c.savedAt ? new Date(c.savedAt).toLocaleString() : '?'}`).join('\n')}\n\nUse /resume <chatname> to load one.` });
          return;
        }
        const chat = loadChat(arg);
        if (!chat) { push({ type: 'error', text: `No saved chat named "${arg}". Run /resume to list all.` }); return; }
        if (agentRef.current) { agentRef.current.history = chat.agentHistory || []; agentRef.current.totalTokens = chat.tokenCount || 0; }
        setModel(chat.model || model); setMode(chat.mode || mode);
        setTokens({ total: chat.tokenCount || 0, input: 0, output: chat.tokenCount || 0, context: 0 });
        push({ type: 'info', text: `Resumed "${arg}" (saved ${chat.savedAt ? new Date(chat.savedAt).toLocaleString() : 'unknown'})` });
        return;
      }
      case 'sessions': {
        const chats = listChats();
        if (!chats.length) { push({ type: 'info', text: 'No saved sessions.' }); return; }
        push({ type: 'info', text: `Sessions:\n${chats.map(c => `  ${c.name.padEnd(20)} ${(c.model || '?').padEnd(14)} ${c.messages ?? '?'} msgs`).join('\n')}` });
        return;
      }
      case 'remove-chat': {
        if (!arg) { push({ type: 'error', text: 'usage: /remove-chat <name>' }); return; }
        const existed = deleteChat(arg);
        push({ type: existed ? 'info' : 'error', text: existed ? `Chat "${arg}" deleted.` : `No chat named "${arg}".` });
        return;
      }
      case 'search-chats': {
        if (!arg) { push({ type: 'error', text: 'usage: /search-chats <query>' }); return; }
        try {
          const results = searchChats(arg);
          if (!results.length) { push({ type: 'info', text: `No chats found for "${arg}".` }); return; }
          push({ type: 'info', text: `Chats matching "${arg}":\n${results.map(r => `  ${r.name} — ${r.matches} match(es)`).join('\n')}` });
        } catch (err) { push({ type: 'error', text: `Search failed: ${err.message}` }); }
        return;
      }
      case 'search': {
        if (!arg) { push({ type: 'error', text: 'usage: /search <query>' }); return; }
        const q = arg.toLowerCase();
        const matches = messages.filter(m => (m.type === 'user' || m.type === 'assistant') && typeof m.text === 'string' && m.text.toLowerCase().includes(q));
        if (!matches.length) { push({ type: 'info', text: `No messages found containing "${arg}".` }); return; }
        push({ type: 'info', text: `${matches.length} match(es) for "${arg}":\n${matches.slice(-8).map(m => `  [${m.type}] ${m.text.trim().slice(0, 120).replace(/\n/g, ' ')}`).join('\n')}` });
        return;
      }
      case 'history': {
        if (!arg) { push({ type: 'error', text: 'usage: /history <query>' }); return; }
        return runCommand(`/search ${arg}`);
      }
      case 'api': {
        const [apiTarget, apiKey] = args;
        if (!apiTarget || !apiKey) { push({ type: 'error', text: 'usage: /api <model> <key>' }); return; }
        if (apiTarget === 'lumen' || apiTarget === 'axion') { return runCommand(`/axion-key ${apiKey}`); }
        try {
          const { setApiKey } = await import('../config.js');
          const provider = setApiKey(apiTarget, apiKey);
          saveApiKey(provider, apiKey);
          push({ type: 'info', text: `API key set for ${provider} (saved)` });
        } catch (err) { push({ type: 'error', text: err.message }); }
        return;
      }
      case 'axion-key': {
        const [keyArg] = args;
        if (!keyArg) {
          const existing = getAxionKey();
          push({ type: 'info', text: existing ? `Axion API key: ${existing.slice(0, 14)}••••••••` : 'No Axion API key set. Lumen works without a key (50 req/day free).\n/axion-key <your-axion-sk-key> to set one.' });
          return;
        }
        if (keyArg === 'remove') { saveAxionKey(null); push({ type: 'info', text: 'Axion API key removed. Lumen will use the free tier (50 req/day).' }); return; }
        if (keyArg === 'test') {
          const testKey = getAxionKey();
          if (!testKey) { push({ type: 'error', text: 'No Axion key set.' }); return; }
          push({ type: 'info', text: 'Testing key…' });
          fetch('https://api.amplifiedsmp.org/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${testKey}` },
            body: JSON.stringify({ model: 'lumen', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
          }).then(async r => {
            if (r.status === 200) push({ type: 'info', text: 'Key is valid. Lumen is reachable.' });
            else if (r.status === 401) push({ type: 'error', text: 'Key rejected by server (401). Generate a fresh key at axion.amplifiedsmp.org/keys' });
            else if (r.status === 429) push({ type: 'info', text: 'Key is valid but rate-limited.' });
            else push({ type: 'error', text: `Unexpected response: HTTP ${r.status}` });
          }).catch(e => push({ type: 'error', text: `Network error: ${e.message}` }));
          return;
        }
        saveAxionKey(keyArg);
        push({ type: 'info', text: `Axion API key saved (${keyArg.slice(0, 14)}••••••••). /axion-key test to verify.` });
        return;
      }
      case 'endpoint': {
        const { CUSTOM_ENDPOINTS } = await import('../config.js');
        const [first, second, third, fourth, fifth] = args;
        if (!first) {
          const entries = Object.entries(CUSTOM_ENDPOINTS);
          if (!entries.length) { push({ type: 'info', text: 'No custom endpoints saved.\n\n/endpoint <name> <url> [model] [key] [context]\ne.g. /endpoint ollama http://localhost:11434/v1 llama3' }); return; }
          const fmtCtx = (v) => v >= 1_000_000 ? (v / 1_000_000).toFixed(1) + 'M' : (v / 1000).toFixed(0) + 'k';
          push({ type: 'info', text: `Saved endpoints:\n${entries.map(([n, e]) => `  ${n.padEnd(16)} ${e.baseURL}  model: ${e.model}${e.context ? ' ctx: ' + fmtCtx(e.context) : ''}`).join('\n')}` });
          return;
        }
        let epName, epURL, epModel, epKey, epCtx;
        if (first.startsWith('http')) { epName = 'other'; epURL = first; epModel = second; epKey = third; epCtx = fourth; }
        else { epName = first; epURL = second; epModel = third; epKey = fourth; epCtx = fifth; }
        if (!epURL) {
          const ep = CUSTOM_ENDPOINTS[epName];
          const fmtCtx = (v) => v >= 1_000_000 ? (v / 1_000_000).toFixed(1) + 'M' : (v / 1000).toFixed(0) + 'k';
          push({ type: 'info', text: ep ? `${epName}: ${ep.baseURL}\n  model: ${ep.model}  key: ${ep.apiKey && ep.apiKey !== 'no-key' ? '(set)' : 'none'}${ep.context ? '  context: ' + fmtCtx(ep.context) : ''}` : `No endpoint "${epName}".` });
          return;
        }
        let context = CUSTOM_ENDPOINTS[epName]?.context || 0;
        if (epCtx) {
          const m = epCtx.match(/^(\d+)(k)?$/i);
          context = m ? (m[2] ? parseInt(m[1], 10) * 1000 : parseInt(m[1], 10)) : 0;
          if (context) CONTEXT_WINDOWS[epName] = context;
        }
        CUSTOM_ENDPOINTS[epName] = { baseURL: epURL, model: epModel || CUSTOM_ENDPOINTS[epName]?.model || epName, apiKey: epKey || CUSTOM_ENDPOINTS[epName]?.apiKey || 'no-key', context };
        saveCustomEndpoints({ ...CUSTOM_ENDPOINTS });
        setModel(epName); saveModel(epName);
        const ctxInfo = context ? ` · context: ${context >= 1_000_000 ? (context / 1_000_000).toFixed(1) + 'M' : (context / 1000).toFixed(0) + 'k'}` : '';
        push({ type: 'info', text: `Endpoint "${epName}" saved → ${epURL}\nSwitched to "${epName}"${ctxInfo}` });
        return;
      }
      case 'skills': {
        const [skSub, ...skRest] = args;
        if (skSub === 'delete' || skSub === 'remove') {
          const target = skRest.join(' ');
          if (!target) { push({ type: 'error', text: 'usage: /skills delete <name>' }); return; }
          agentRef.current?.activeSkills?.delete(target.toLowerCase());
          push(deleteSkill(target) ? { type: 'info', text: `Deleted skill "${target}".` } : { type: 'error', text: `No skill named "${target}".` });
          return;
        }
        const skills = getSkills();
        if (!skills.length) { push({ type: 'info', text: 'No skills yet.\n/skill-generator <name> <instructions> to create one.' }); return; }
        const active = agentRef.current?.activeSkills || new Map();
        push({ type: 'info', text: `Skills (● = active):\n${skills.map(s => `  ${active.has(s.name.toLowerCase()) ? '●' : ' '} ${s.name.padEnd(16)} ${s.description || ''}`).join('\n')}\n\n/skills delete <name> to remove` });
        return;
      }
      case 'skill-generator':
      case 'skill': {
        const [skillName, ...instrParts] = args;
        const instructions = instrParts.join(' ');
        if (!skillName) { push({ type: 'error', text: 'usage: /skill-generator <name> <instructions>' }); return; }
        push({ type: 'info', text: `Generating skill "${skillName}"…` });
        const genPrompt = `Create a skill file for an AI assistant. Skill name: ${skillName}\nWhat it should do: ${instructions || '(infer)'}\n\nRespond with ONLY:\n---\nname: ${skillName.toLowerCase()}\ndescription: <one-line>\ntriggers: ${skillName.toLowerCase()}\n---\n\n<instructions>`;
        agentRef.current?.askBtw(genPrompt).then(async (content) => {
          let c = content.replace(/^```(?:md)?\n?/, '').replace(/\n?```$/, '').trim();
          if (!c.startsWith('---')) { c = `---\nname: ${skillName.toLowerCase()}\ndescription: ${instructions || skillName}\ntriggers: ${skillName.toLowerCase()}\n---\n\n${c}`; }
          const path = saveSkill(skillName, c);
          push({ type: 'info', text: `✔ Skill saved → ${path.replace(process.env.HOME || process.env.USERPROFILE || '~', '~')}` });
        }).catch((err) => push({ type: 'error', text: `skill generation failed: ${err.message}` }));
        return;
      }
      case 'skill-delete': {
        if (!arg) { push({ type: 'error', text: 'usage: /skill-delete <name>' }); return; }
        agentRef.current?.activeSkills?.delete(arg.toLowerCase());
        push(deleteSkill(arg) ? { type: 'info', text: `Deleted skill "${arg}".` } : { type: 'error', text: `No skill named "${arg}".` });
        return;
      }
      case 'profile': {
        const [prSub, ...prArgs] = args;
        const pName = prArgs.join(' ');
        if (prSub === 'save' && pName) { saveProfile(pName, { model, mode }); push({ type: 'info', text: `Profile saved: "${pName}" (${model}, ${mode})` }); return; }
        if (prSub === 'load' && pName) {
          const p = loadProfile(pName);
          if (!p) { push({ type: 'error', text: `No profile "${pName}". /profile list` }); return; }
          setModel(p.model); saveModel(p.model); setMode(p.mode); saveMode(p.mode); agentRef.current?.setMode(p.mode);
          push({ type: 'info', text: `Profile loaded: "${pName}" → ${p.model}, ${p.mode}` });
          return;
        }
        if (prSub === 'delete' && pName) { deleteProfile(pName); push({ type: 'info', text: `Deleted profile "${pName}".` }); return; }
        if (prSub === 'list' || !prSub) {
          const list = listProfiles();
          push({ type: 'info', text: list.length ? `Profiles:\n${list.map(n => `  ${n}`).join('\n')}` : 'No saved profiles. /profile save <name>' });
          return;
        }
        push({ type: 'error', text: 'usage: /profile save|load|delete|list [name]' });
        return;
      }
      case 'compare': {
        if (!arg) { push({ type: 'error', text: 'usage: /compare [model1,model2,...] <prompt>' }); return; }
        const firstToken = args[0];
        const isModelList = firstToken.includes(',') || MODELS[firstToken] != null;
        let compareModels, comparePrompt;
        if (isModelList) { compareModels = firstToken.split(',').map(s => s.trim()).filter(Boolean); comparePrompt = args.slice(1).join(' '); }
        else { compareModels = getCompareModels() || ['claude', 'gpt', 'gemini']; comparePrompt = arg; }
        if (!comparePrompt) { push({ type: 'error', text: 'prompt is required' }); return; }
        push({ type: 'info', text: `Comparing: ${compareModels.join(' · ')}…` });
        Promise.allSettled(compareModels.map(async (m) => {
          const tmp = new Agent({ modelAlias: m, mode: 'auto', onToolCall: () => {}, onToolResult: () => {}, onMessage: () => {}, onTokens: () => {}, onStreamChunk: () => {}, onStreamEnd: () => {} });
          return { model: m, answer: await tmp.askBtw(comparePrompt) };
        })).then((results) => {
          for (const r of results) {
            if (r.status === 'fulfilled') push({ type: 'assistant', text: `[${r.value.model}]\n${r.value.answer}` });
            else push({ type: 'error', text: `[${r.reason?.model || '?'}] ${r.reason?.message || String(r.reason)}` });
          }
        }).catch((err) => push({ type: 'error', text: `compare failed: ${err.message}` }));
        return;
      }
      case 'compare-models': {
        if (!arg) {
          const saved = getCompareModels();
          push({ type: 'info', text: saved ? `Compare models: ${saved.join(' · ')}` : 'Compare models: claude · gpt · gemini (defaults)' });
          return;
        }
        if (arg === 'reset') { saveCompareModels(null); push({ type: 'info', text: 'Compare models reset to defaults.' }); return; }
        const newModels = arg.split(',').map(s => s.trim()).filter(Boolean);
        if (newModels.length < 2) { push({ type: 'error', text: 'Provide at least 2 comma-separated models.' }); return; }
        saveCompareModels(newModels);
        push({ type: 'info', text: `Compare models saved: ${newModels.join(' · ')}` });
        return;
      }
      case 'goal': {
        if (!arg) {
          if (goal) { setGoal(null); push({ type: 'info', text: 'Goal cancelled.' }); }
          else { push({ type: 'info', text: 'No active goal. Usage: /goal <description>' }); }
          return;
        }
        setGoal(arg);
        push({ type: 'info', text: `Goal set: "${arg}"\nAxion will work autonomously until this is achieved.` });
        return;
      }
      case 'add': {
        if (!arg) { push({ type: 'error', text: 'usage: /add <filepath>' }); return; }
        try {
          const abs = resolve(process.cwd(), arg);
          if (!existsSync(abs)) throw new Error(`File not found: ${arg}`);
          const content = readFileSync(abs, 'utf8');
          submitRef.current(`Read the file ${arg}:\n\`\`\`\n${content.slice(0, 12000)}\n\`\`\``);
        } catch (err) { push({ type: 'error', text: `add failed: ${err.message}` }); }
        return;
      }
      case 'computer':
      case 'cu': {
        const turnOn = arg === 'on' || (!arg && !computerUse);
        if (!turnOn) { setComputerUse(false); push({ type: 'info', text: 'Computer use off.' }); }
        else { setComputerUse(true); push({ type: 'info', text: 'Computer use on.\n/vision <model> to set vision model.' }); }
        return;
      }
      case 'vision': {
        if (!arg) { push({ type: 'info', text: `Vision model: ${'(none set)'}\n/vision <model> e.g. /vision claude` }); return; }
        saveVisionModel(arg);
        push({ type: 'info', text: `Vision model → ${arg} (saved)\n/computer on to enable screen control.` });
        return;
      }
      case 'img-gen': {
        if (!arg) { push({ type: 'error', text: 'usage: /img-gen <prompt>' }); return; }
        push({ type: 'info', text: 'Generating image…' });
        const { generateImage } = await import('../agent/image.js').catch(() => ({ generateImage: null }));
        if (!generateImage) { push({ type: 'error', text: 'Image generation module not available.' }); return; }
        try {
          const { filePath, revisedPrompt } = await generateImage(arg);
          push({ type: 'info', text: `◈ Image generated${revisedPrompt !== arg ? '\nRevised prompt: ' + revisedPrompt : ''}\nSaved to: ${filePath}` });
        } catch (err) { push({ type: 'error', text: `Image generation failed: ${err.message}` }); }
        return;
      }
      case 'img-gen-model': {
        if (!arg) { push({ type: 'info', text: `Image model: ${'(default)'}\n/usage: /img-gen-model <model>` }); return; }
        saveImageModel(arg);
        push({ type: 'info', text: `Image model → ${arg} (saved)` });
        return;
      }
      case 'speak': {
        if (!arg) { push({ type: 'error', text: 'usage: /speak <text>' }); return; }
        const { speakText } = await import('../agent/voice.js').catch(() => ({ speakText: null }));
        if (!speakText) { push({ type: 'error', text: 'TTS module not available.' }); return; }
        try { await speakText(arg); push({ type: 'info', text: `🔊 "${arg}"` }); }
        catch (err) { push({ type: 'error', text: `TTS failed: ${err.message}` }); }
        return;
      }
      case 'login': {
        const AXION_API = 'https://api.amplifiedsmp.org';
        push({ type: 'info', text: 'Opening browser to authorize your Axion account…' });
        try {
          const res = await fetch(`${AXION_API}/auth/device`, { method: 'POST' });
          if (!res.ok) throw new Error('Failed to start login flow');
          const { device_code, expires_in } = await res.json();
          const loginUrl = `https://axion.amplifiedsmp.org/keys#device=${device_code}`;
          try { if (process.platform === 'win32') execSync(`start "" "${loginUrl}"`); else if (process.platform === 'darwin') execSync(`open "${loginUrl}"`); else execSync(`xdg-open "${loginUrl}"`); }
          catch { push({ type: 'info', text: `Open this URL in your browser:\n${loginUrl}` }); }
          push({ type: 'info', text: `Waiting for authorization… (expires in ${Math.floor(expires_in / 60)} min)` });
          const deadline = Date.now() + expires_in * 1000;
          const poll = async () => {
            if (Date.now() > deadline) { push({ type: 'error', text: 'Login timed out.' }); return; }
            try {
              const pollRes = await fetch(`${AXION_API}/auth/device/poll?code=${device_code}`);
              const data = await pollRes.json();
              if (data.pending) { setTimeout(poll, 2500); return; }
              if (data.token) {
                const keyRes = await fetch(`${AXION_API}/dashboard/keys`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.token}` },
                  body: JSON.stringify({ label: `axion-cli (${new Date().toLocaleDateString()})` }),
                });
                const keyData = await keyRes.json();
                if (keyData.key_value) { saveAxionKey(keyData.key_value); push({ type: 'info', text: `Logged in as ${data.email}\nAPI key created and saved.` }); }
                else { push({ type: 'error', text: 'Authorized but could not create API key. Try /axion-key <key> manually.' }); }
                return;
              }
              if (data.error) { push({ type: 'error', text: `Login failed: ${data.error}` }); return; }
              setTimeout(poll, 2500);
            } catch { setTimeout(poll, 2500); }
          };
          setTimeout(poll, 2500);
        } catch (e) { push({ type: 'error', text: `Login failed: ${e.message}` }); }
        return;
      }
      case 'ss': {
        push({ type: 'info', text: 'Taking screenshot…' });
        try {
          const { base64, mediaType, width, height } = captureScreen();
          const ssQuestion = arg || 'Describe what is currently on screen in detail.';
          const description = await analyzeScreen({ base64, mediaType, question: ssQuestion, width, height });
          push({ type: 'assistant', text: description });
        } catch (err) { push({ type: 'error', text: `Screenshot failed: ${err.message}` }); }
        return;
      }
      case 'macro': {
        const [maSub, ...maArgs] = args;
        const maName = maArgs[0];
        if (maSub === 'record') {
          if (!maName) { push({ type: 'error', text: 'usage: /macro record <name>' }); return; }
          MACRO_STATE.recording = true; MACRO_STATE.name = maName; MACRO_STATE.steps = [];
          push({ type: 'info', text: `Recording macro "${maName}"… do your actions, then /macro stop.` });
          return;
        }
        if (maSub === 'stop') {
          if (!MACRO_STATE.recording) { push({ type: 'info', text: 'No macro is being recorded.' }); return; }
          MACRO_STATE.recording = false;
          const recName = MACRO_STATE.name; const steps = [...MACRO_STATE.steps];
          MACRO_STATE.name = null; MACRO_STATE.steps = [];
          if (!steps.length) { push({ type: 'info', text: 'No steps recorded — macro not saved.' }); return; }
          saveMacro(recName, steps);
          push({ type: 'info', text: `Macro "${recName}" saved (${steps.length} step${steps.length !== 1 ? 's' : ''}).` });
          return;
        }
        if (maSub === 'play') {
          if (!maName) { push({ type: 'error', text: 'usage: /macro play <name>' }); return; }
          const steps = loadMacro(maName);
          if (!steps) { push({ type: 'error', text: `No macro named "${maName}".` }); return; }
          push({ type: 'info', text: `Playing macro "${maName}" (${steps.length} steps)…` });
          try {
            for (const step of steps) {
              const result = await executeTool(step.name, step.input, { askUser: () => Promise.resolve('') });
              if (!result.success) { push({ type: 'error', text: `Macro step failed (${step.name}): ${result.output}` }); break; }
            }
            push({ type: 'info', text: `Macro "${maName}" complete.` });
          } catch (err) { push({ type: 'error', text: `Macro failed: ${err.message}` }); }
          return;
        }
        if (maSub === 'list') {
          const macros = listMacros();
          if (!macros.length) { push({ type: 'info', text: 'No macros saved.' }); return; }
          push({ type: 'info', text: `Saved macros:\n${macros.map(m => `  ${(m.name || '?').padEnd(20)} ${m.steps ?? '?'} steps`).join('\n')}` });
          return;
        }
        if (maSub === 'delete') {
          if (!maName) { push({ type: 'error', text: 'usage: /macro delete <name>' }); return; }
          push({ type: deleteMacro(maName) ? 'info' : 'error', text: deleteMacro(maName) ? `Macro "${maName}" deleted.` : `No macro "${maName}".` });
          return;
        }
        push({ type: 'info', text: 'Macro: record|stop|play|list|delete' });
        return;
      }
      case 'watch':
      case 'watch-and-learn': {
        const waSub = arg?.toLowerCase();
        if (waSub === 'stop' || waSub === 'off') {
          const learned = getLearnedInstructions();
          if (learned) { push({ type: 'info', text: `Current learned preferences:\n${learned}` }); }
          else { push({ type: 'info', text: 'No learned preferences yet.' }); }
          return;
        }
        if (waSub === 'clear') { clearLearnedInstructions(); push({ type: 'info', text: 'Learned preferences cleared.' }); return; }
        if (waSub === 'show') {
          const learned = getLearnedInstructions();
          push({ type: 'info', text: learned ? `Learned preferences:\n${learned}` : 'No learned preferences yet.' });
          return;
        }
        push({ type: 'info', text: 'Watch: /watch stop|show|clear' });
        return;
      }
      case 'discord': {
        const [diSub, ...diRest] = args;
        if (diSub === 'token') {
          const token = diRest[0];
          if (!token) { push({ type: 'error', text: 'usage: /discord token <BOT_TOKEN>' }); return; }
          saveDiscordToken(token);
          push({ type: 'info', text: '✔ Discord bot token saved. Run /discord start to connect.' });
          return;
        }
        if (diSub === 'start') {
          const token = getDiscordToken();
          if (!token) { push({ type: 'error', text: 'No token saved. Run /discord token <BOT_TOKEN> first.' }); return; }
          if (DISCORD_STATE.running) { push({ type: 'info', text: 'Discord bot already running.' }); return; }
          push({ type: 'info', text: 'Connecting Discord bot…' });
          try {
            const handler = (msg) => { push({ type: 'user', text: `[Discord] ${msg}` }); };
            await startDiscord(token, handler);
            saveDiscordAutoStart(true);
            push({ type: 'info', text: `✔ Discord bot connected as ${DISCORD_STATE.username}.` });
          } catch (err) { push({ type: 'error', text: `Failed to connect: ${err.message}` }); }
          return;
        }
        if (diSub === 'stop') {
          if (!DISCORD_STATE.running) { push({ type: 'info', text: 'Discord bot is not running.' }); return; }
          await stopDiscord();
          saveDiscordAutoStart(false);
          push({ type: 'info', text: '◈ Discord bot disconnected.' });
          return;
        }
        if (!diSub || diSub === 'status') {
          push({ type: 'info', text: DISCORD_STATE.running ? `Discord bot running as ${DISCORD_STATE.username}` : `Discord bot not running. ${getDiscordToken() ? 'Run /discord start' : 'Set token first with /discord token <TOKEN>'}` });
          return;
        }
        push({ type: 'info', text: 'Discord: token|start|stop|status' });
        return;
      }
      case 'oauth': {
        const [oaSub, oaSvc] = args;
        if (!oaSub || oaSub === 'list') {
          const connected = listOAuthTokens();
          if (!connected.length) { push({ type: 'info', text: 'No services connected.\n/oauth connect <github|google|notion|slack>' }); return; }
          push({ type: 'info', text: `Connected services:\n${connected.map(t => `  ✔ ${t.service.padEnd(10)} connected ${new Date(t.connectedAt).toLocaleDateString()}`).join('\n')}` });
          return;
        }
        if (oaSub === 'revoke') {
          if (!oaSvc) { push({ type: 'error', text: 'usage: /oauth revoke <service>' }); return; }
          push(revokeOAuthToken(oaSvc) ? { type: 'info', text: `✔ Disconnected ${oaSvc}` } : { type: 'error', text: `No connection for "${oaSvc}"` });
          return;
        }
        if (oaSub === 'connect') {
          if (!oaSvc) { push({ type: 'info', text: 'Available: github · google · notion · slack\n/oauth connect <service>' }); return; }
          const cfg = OAUTH_PROVIDERS[oaSvc];
          if (!cfg) { push({ type: 'error', text: `Unknown service "${oaSvc}".` }); return; }
          push({ type: 'info', text: `Connecting ${cfg.label}…` });
          try {
            let token;
            await connectOAuth(oaSvc, {
              onStatus: (info) => {
                if (info.authUrl) push({ type: 'info', text: `Open: ${info.authUrl}` });
                if (info.user_code) push({ type: 'info', text: `Open ${info.verification_uri} and enter code: ${info.user_code}` });
              },
              onToken: (t) => { token = t; },
            });
            push({ type: 'info', text: `✔ ${cfg.label} connected!` });
            if (cfg.mcpCommand && token) {
              try { await MCP.addServer(oaSvc, { command: cfg.mcpCommand, args: cfg.mcpArgs, env: cfg.mcpEnv(token) }); }
              catch (mcpErr) { push({ type: 'error', text: `Connected but MCP setup failed: ${mcpErr.message}` }); }
            }
          } catch (err) { push({ type: 'error', text: `OAuth failed: ${err.message}` }); }
          return;
        }
        push({ type: 'info', text: 'OAuth: connect|list|revoke  Services: github · google · notion · slack' });
        return;
      }
      case 'schedule': {
        const [scSub, ...scRest] = args;
        if (!scSub || scSub === 'list') {
          const list = getSchedules();
          if (!list.length) { push({ type: 'info', text: 'No scheduled tasks.\n/schedule add <name> "<schedule>" <prompt>' }); return; }
          push({ type: 'info', text: `Scheduled tasks:\n${list.map(t => `  ${t.enabled ? '✔' : '✗'} ${t.name.padEnd(18)} ${t.schedule.padEnd(18)} ${t.lastRun ? `last ran ${new Date(t.lastRun).toLocaleString()}` : 'never run'}`).join('\n')}` });
          return;
        }
        if (scSub === 'add') {
          const name = scRest[0]; const rest = scRest.slice(1);
          const restStr = rest.join(' ');
          const qm = restStr.match(/^"([^"]+)"\s+([\s\S]+)$/) || restStr.match(/^'([^']+)'\s+([\s\S]+)$/);
          let scheduleExpr = null, promptText = '';
          if (qm) { scheduleExpr = qm[1].trim(); promptText = qm[2].trim(); }
          else { for (let n = Math.min(3, rest.length - 1); n >= 1; n--) { const cand = rest.slice(0, n).join(' '); if (parseSchedule(cand)) { scheduleExpr = cand; promptText = rest.slice(n).join(' '); break; } } }
          if (!name || !scheduleExpr || !promptText) { push({ type: 'error', text: 'usage: /schedule add <name> "<schedule>" <prompt>' }); return; }
          if (!parseSchedule(scheduleExpr)) { push({ type: 'error', text: 'Invalid schedule.' }); return; }
          const list = getSchedules();
          if (list.find(t => t.name === name)) { push({ type: 'error', text: `Schedule "${name}" already exists.` }); return; }
          list.push({ id: crypto.randomUUID?.() || `${Date.now()}`, name, schedule: scheduleExpr, prompt: promptText, model, enabled: true, lastRun: null, createdAt: new Date().toISOString() });
          saveSchedules(list);
          push({ type: 'info', text: `✔ Schedule "${name}" added — runs ${scheduleExpr}\n/schedule run ${name} to run now.` });
          return;
        }
        if (scSub === 'remove' || scSub === 'delete') {
          const name = scRest[0]; if (!name) { push({ type: 'error', text: 'usage: /schedule remove <name>' }); return; }
          const list = getSchedules(); const updated = list.filter(t => t.name !== name);
          if (updated.length === list.length) { push({ type: 'error', text: `No schedule "${name}".` }); return; }
          saveSchedules(updated); push({ type: 'info', text: `✔ Schedule "${name}" removed` });
          return;
        }
        if (scSub === 'enable' || scSub === 'disable') {
          const name = scRest[0]; if (!name) { push({ type: 'error', text: `usage: /schedule ${scSub} <name>` }); return; }
          const list = getSchedules(); const task = list.find(t => t.name === name);
          if (!task) { push({ type: 'error', text: `No schedule "${name}".` }); return; }
          task.enabled = scSub === 'enable'; saveSchedules(list);
          push({ type: 'info', text: `✔ Schedule "${name}" ${scSub}d` });
          return;
        }
        if (scSub === 'run') {
          const name = scRest[0]; if (!name) { push({ type: 'error', text: 'usage: /schedule run <name>' }); return; }
          const list = getSchedules(); const task = list.find(t => t.name === name);
          if (!task) { push({ type: 'error', text: `No schedule "${name}".` }); return; }
          push({ type: 'info', text: `Running "${name}"…` });
          try {
            const preLen = agentRef.current.history.length;
            await agentRef.current.run(task.prompt, { askConfirm: () => Promise.resolve(true), askPlanConfirm: () => Promise.resolve(true), askUser: () => Promise.resolve('') });
            const result = agentRef.current.history.slice(preLen).filter(m => m.role === 'assistant').map(m => typeof m.content === 'string' ? m.content : (m.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n')).filter(Boolean).join('\n\n');
            const saved = saveScheduleResult(task.name, result);
            task.lastRun = new Date().toISOString(); saveSchedules(list);
            push({ type: 'info', text: `✔ "${name}" complete — saved to ${saved}` });
          } catch (err) { push({ type: 'error', text: `Failed: ${err.message}` }); }
          return;
        }
        if (scSub === 'results') {
          const name = scRest[0] || null;
          const results = getScheduleResults(name);
          if (!results.length) { push({ type: 'info', text: name ? `No results for "${name}"` : 'No schedule results yet' }); return; }
          push({ type: 'info', text: `Schedule results${name ? ` for "${name}"` : ''}:\n${results.slice(0, 10).map(r => `  ${r.name}`).join('\n')}` });
          return;
        }
        push({ type: 'info', text: 'Schedule: list|add|run|remove|enable|disable|results' });
        return;
      }
      case 'web': {
        const pidFile = join(homedir(), '.axion', 'web-server.pid');
        if (args[0] === 'stop') {
          const webPort = Number(process.env.AXION_WEB_PORT) || 3000;
          if (!existsSync(pidFile)) {
            try {
              if (process.platform === 'win32') { const out = execSync(`netstat -ano -p TCP 2>nul | findstr :${webPort}`, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }); const m = out.match(/\s+(\d+)\s*$/m); if (m) { execSync(`taskkill /F /PID ${m[1]}`, { stdio: 'ignore' }); push({ type: 'info', text: `Web server stopped (PID ${m[1]}).` }); } else { push({ type: 'info', text: 'No web server running.' }); } }
              else { const pid = execSync(`lsof -ti tcp:${webPort}`, { encoding: 'utf8' }).trim(); if (pid) { process.kill(parseInt(pid, 10)); push({ type: 'info', text: `Web server stopped (PID ${pid}).` }); } else { push({ type: 'info', text: 'No web server running.' }); } }
            } catch { push({ type: 'info', text: 'No web server running.' }); }
            return;
          }
          try { const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10); process.kill(pid); try { unlinkSync(pidFile); } catch {} push({ type: 'info', text: `Web server stopped (PID ${pid}).` }); }
          catch (err) { try { unlinkSync(pidFile); } catch {} push({ type: 'error', text: `Failed: ${err.message}` }); }
          return;
        }
        const port = parseInt(args[0], 10) || 3000;
        try {
          const child = spawn(process.execPath, ['axion-serve'], { detached: true, stdio: 'ignore', env: { ...process.env, AXION_WEB_PORT: String(port) }, cwd: process.cwd() });
          child.unref();
          const url = `http://localhost:${port}`;
          push({ type: 'info', text: `◈ Web UI starting at ${url}…` });
          try { if (process.platform === 'win32') spawn('cmd', ['/c', 'start', url], { detached: true, stdio: 'ignore' }).unref(); else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref(); else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref(); } catch {}
        } catch (err) { push({ type: 'error', text: `Failed: ${err.message}` }); }
        return;
      }
      case 'blender': {
        if (arg === 'setup') {
          push({ type: 'info', text: 'Blender add-on setup:\n1. Open Blender\n2. Edit → Preferences → Add-ons → Install…\n3. Select axion_blender.py from mcp-servers/blender/\n4. Enable the add-on\n5. Run /blender connect' });
          return;
        }
        push({ type: 'info', text: 'Connecting Blender MCP…' });
        try {
          const srv = await MCP.addServer('blender', { command: 'axion-blender', args: [] });
          if (srv.ready) push({ type: 'info', text: `✔ Blender MCP connected — ${srv.tools.length} tools available.` });
          else push({ type: 'error', text: `Blender MCP failed: ${srv.error}` });
        } catch (err) { push({ type: 'error', text: `Connection failed: ${err.message}` }); }
        return;
      }
      case 'mcp': {
        const [mcSub, ...mcRest] = args;
        if (!mcSub || mcSub === 'status') {
          const status = MCP.getStatus();
          if (!status.length) { push({ type: 'info', text: 'No MCP servers configured.\n/mcp browse | /mcp install <id> | /mcp add <name> <cmd>' }); return; }
          push({ type: 'info', text: `MCP servers:\n${status.map(s => `  ${s.name.padEnd(20)} ${s.disabled ? '⏸ disabled' : s.ready ? `✔ ${s.toolCount} tools` : `✗ ${s.error || 'not ready'}`}`).join('\n')}` });
          return;
        }
        if (mcSub === 'tools') {
          const filterName = mcRest[0]; const status = MCP.getStatus().filter(s => !filterName || s.name === filterName);
          if (!status.length) { push({ type: 'info', text: filterName ? `No server "${filterName}".` : 'No MCP servers.' }); return; }
          push({ type: 'info', text: `MCP tools:\n${status.flatMap(s => [`  ${s.name}:`, ...(s.ready ? s.tools.map(t => `    mcp__${s.name}__${t}`) : [`    ${s.error}`])]).join('\n')}` });
          return;
        }
        if (mcSub === 'add') {
          const [name, command, ...cmdArgs] = mcRest;
          if (!name || !command) { push({ type: 'error', text: 'usage: /mcp add <name> <command> [args]' }); return; }
          push({ type: 'info', text: `Starting MCP server "${name}"…` });
          try {
            const srv = await MCP.addServer(name, { command, args: cmdArgs });
            if (srv.ready) push({ type: 'info', text: `✔ MCP "${name}" connected — ${srv.tools.length} tools.` });
            else push({ type: 'error', text: `MCP "${name}" failed: ${srv.error}` });
          } catch (err) { push({ type: 'error', text: `MCP add failed: ${err.message}` }); }
          return;
        }
        if (mcSub === 'remove') { const name = mcRest[0]; if (!name) { push({ type: 'error', text: 'usage: /mcp remove <name>' }); return; } push({ type: MCP.removeServer(name) ? 'info' : 'error', text: MCP.removeServer(name) ? `MCP "${name}" removed.` : `No server "${name}".` }); return; }
        if (mcSub === 'reload') {
          push({ type: 'info', text: 'Reloading MCP servers…' });
          try { await MCP.reload(); const status = MCP.getStatus(); push({ type: 'info', text: `✔ MCP reload complete — ${status.filter(s => s.ready).length} connected${status.filter(s => !s.ready).length ? `, ${status.filter(s => !s.ready).length} failed` : ''}.` }); }
          catch (err) { push({ type: 'error', text: `Reload failed: ${err.message}` }); }
          return;
        }
        if (mcSub === 'disable') { const name = mcRest[0]; if (!name) { push({ type: 'error', text: 'usage: /mcp disable <name>' }); return; } push({ type: MCP.disableServer(name) ? 'info' : 'error', text: MCP.disableServer(name) ? `⏸ "${name}" disabled.` : `No server "${name}".` }); return; }
        if (mcSub === 'enable') {
          const name = mcRest[0]; if (!name) { push({ type: 'error', text: 'usage: /mcp enable <name>' }); return; }
          push({ type: 'info', text: `Starting "${name}"…` });
          try { const srv = await MCP.enableServer(name); if (srv?.ready) push({ type: 'info', text: `✔ "${name}" enabled — ${srv.tools.length} tools.` }); else push({ type: 'error', text: `"${name}" failed: ${srv?.error}` }); }
          catch (err) { push({ type: 'error', text: `Enable failed: ${err.message}` }); }
          return;
        }
        if (mcSub === 'toggle') {
          const name = mcRest[0]; if (!name) { push({ type: 'error', text: 'usage: /mcp toggle <name>' }); return; }
          const st = MCP.getStatus().find(s => s.name === name);
          if (!st) { push({ type: 'error', text: `No server "${name}".` }); return; }
          if (st.disabled) { return runCommand(`/mcp enable ${name}`); }
          else { MCP.disableServer(name); push({ type: 'info', text: `⏸ "${name}" disabled.` }); }
          return;
        }
        if (mcSub === 'browse' || mcSub === 'marketplace') {
          const byCategory = {};
          for (const entry of MCP_MARKETPLACE) {
            if (!byCategory[entry.category]) byCategory[entry.category] = [];
            byCategory[entry.category].push(entry);
          }
          const installed = new Set(MCP.getStatus().map(s => s.name));
          const lines = [];
          for (const [cat, entries] of Object.entries(byCategory)) {
            lines.push(`\n  ${CATEGORIES[cat] || cat}`);
            for (const e of entries) { lines.push(`    ${e.id.padEnd(22)} ${e.description}${installed.has(e.id) ? ' ✔' : ''}`); }
          }
          push({ type: 'info', text: `MCP Marketplace — ${MCP_MARKETPLACE.length} servers\n${lines.join('\n')}\n\n/mcp install <id>` });
          return;
        }
        if (mcSub === 'search') {
          const query = mcRest.join(' '); const results = searchMarketplace(query);
          if (!results.length) { push({ type: 'info', text: `No results for "${query}".` }); return; }
          const installed = new Set(MCP.getStatus().map(s => s.name));
          push({ type: 'info', text: `Results for "${query}":\n${results.map(e => `  ${e.id.padEnd(22)} ${e.description}${installed.has(e.id) ? ' ✔' : ''}`).join('\n')}` });
          return;
        }
        if (mcSub === 'install') {
          const id = mcRest[0]; const extraArgs = mcRest.slice(1);
          if (!id) { push({ type: 'error', text: 'usage: /mcp install <id>' }); return; }
          const entry = getMarketplaceEntry(id);
          if (!entry) { push({ type: 'error', text: `No marketplace entry "${id}".` }); return; }
          let resolvedArgs = entry.args.map((a, i) => { if (a.startsWith('$') && extraArgs.length) return extraArgs.shift() || a; return a; });
          push({ type: 'info', text: `Installing ${entry.name}…` });
          try {
            const srv = await MCP.addServer(id, { command: entry.command, args: resolvedArgs });
            if (srv.ready) push({ type: 'info', text: `✔ ${entry.name} installed — ${srv.tools.length} tools.` });
            else push({ type: 'error', text: `${entry.name} failed: ${srv.error}` });
          } catch (err) { push({ type: 'error', text: `Install failed: ${err.message}` }); }
          return;
        }
        push({ type: 'info', text: 'MCP: status|browse|search|install|add|enable|disable|toggle|remove|reload|tools' });
        return;
      }
      case 'contribute': {
        const coSub = args[0]?.toLowerCase();
        if (coSub === 'skip') { push({ type: 'info', text: 'Contribution prompt dismissed for this session.' }); return; }
        if (coSub === 'optout') {
          if (args[1] === 'off') { saveDonateOptOut(false); push({ type: 'info', text: '✔ Contribution prompts re-enabled.' }); }
          else { saveDonateOptOut(true); push({ type: 'info', text: '✔ Opted out. Run /contribute optout off to re-enable.' }); }
          return;
        }
        const hist = agentRef.current?.history;
        if (!hist || hist.length === 0) { push({ type: 'info', text: 'Nothing to contribute.' }); return; }
        const payload = { donatedAt: new Date().toISOString(), turns: hist.length, history: hist };
        push({ type: 'info', text: 'Contributing session…' });
        const sendToCloud = () => {
          fetch('https://axion-collect.axion-collect.workers.dev/collect', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
          }).then(r => { if (r.ok) push({ type: 'info', text: '✔ Session contributed — thanks!' }); else { saveDonation(hist); push({ type: 'info', text: '✔ Saved locally.' }); } }).catch(() => { saveDonation(hist); push({ type: 'info', text: '✔ Saved locally.' }); });
        };
        sendToCloud();
        return;
      }
      default:
        push({ type: 'info', text: `/${c} isn't wired into the new UI yet — coming soon.` });
        return;
    }
  }, [model, mode, tokens, messages, push, onExit, buildSession, extThinking, thinkingBudget, systemOverride, goal, computerUse, includedFiles]);

  // Push a user message and run one agent turn with the interactive prompts
  // (tool-confirm, plan-confirm, free-form questions). Shared by submit + retry.
  const runAgentTurn = useCallback((displayText, agentText) => {
    const text = agentText ?? displayText;
    push({ type: 'user', text: displayText });
    if (!lastUserTextRef.current) onTitleChange?.(displayText); // first prompt names the tab
    lastUserTextRef.current = displayText;
    setThinkingWord(pickThinkingWord());
    setBusy(true);

    const askConfirm = (tc) => {
      if (tc.name && tc.name.includes('sequentialthinking')) return Promise.resolve(true);
      const key = permissionKey(tc.name, tc.input);
      if (getAllowedTools().includes(key)) return Promise.resolve(true);
      return new Promise((resolve) => {
        pendingAllowKeyRef.current = key;
        setPendingConfirm({ name: tc.name, label: confirmLabel(tc.name, tc.input) });
        setInputMode('confirm-tool');
        confirmResolverRef.current = resolve;
      });
    };
    const askPlanConfirm = () => new Promise((resolve) => {
      setInputMode('confirm-plan');
      confirmResolverRef.current = resolve;
    });
    const askUser = (spec) => new Promise((resolve) => {
      questionResolverRef.current = resolve;
      questionSpecRef.current = spec;
      setPendingForm(normalizeQuestionSpec(spec));
      setInputMode('question');
    });

    agentRef.current
      .run(text, { askConfirm, askPlanConfirm, askUser })
      .catch((err) => push({ type: 'error', text: err?.message || String(err) }))
      .finally(() => setBusy(false));
  }, [push, onTitleChange]);

  const submit = useCallback((value) => {
    const text = (value || '').trim();
    if (!text || busy) return;
    setInputSafe('');
    if (text.startsWith('/')) { runCommand(text); return; }
    runAgentTurn(text, expandMentions(text)); // @file mentions → file contents for the agent
  }, [busy, runCommand, setInputSafe, runAgentTurn]);

  // Retry: regenerate the AI's answer to the prompt that produced this assistant
  // message — roll back to before that user turn and re-run it.
  const retryMessage = useCallback((i) => {
    if (busy) return;
    let u = -1;
    for (let j = i; j >= 0; j--) if (messages[j]?.type === 'user') { u = j; break; }
    if (u === -1) return;
    const text = rollbackToUserMsg(u);
    if (!text) return;
    setMessages((m) => m.slice(0, u));
    setTimeout(() => runAgentTurn(text), 0); // defer out of the click event
  }, [busy, messages, rollbackToUserMsg, runAgentTurn]);

  useEffect(() => { submitRef.current = submit; });

  // QuestionMenu finished — map the per-question answers back to what each tool
  // expects: bool for confirm, a readable Q→A block for a multi-question form,
  // a single string (multi-select joined by ', ') otherwise.
  const completeQuestion = useCallback((answers) => {
    const spec = questionSpecRef.current;
    const r = questionResolverRef.current;
    questionResolverRef.current = null;
    setPendingForm(null);
    setInputMode('chat');
    const flat = (a) => (Array.isArray(a) ? a.join(', ') : (a ?? ''));
    let result;
    if (spec?.type === 'form') {
      result = (spec.questions || []).map((q, i) => `${q.question} → ${flat(answers[i])}`).join('\n');
    } else if (spec?.type === 'confirm') {
      result = answers[0] === 'Yes';
    } else {
      result = flat(answers[0]);
    }
    r?.(result);
  }, []);

  const cancelQuestion = useCallback(() => {
    const r = questionResolverRef.current;
    questionResolverRef.current = null;
    const wasConfirm = questionSpecRef.current?.type === 'confirm';
    setPendingForm(null);
    setInputMode('chat');
    r?.(wasConfirm ? false : '');
  }, []);

  const ctxWindow = getContextWindow(model) || 0;
  const ctxUsed = tokens.context || 0; // real context-window pressure, not cumulative billed tokens

  return (
    <box style={{ flexGrow: 1, flexDirection: 'row' }}>
      <box style={{ flexGrow: 1, flexDirection: 'column' }}>
        <Welcome model={model} mode={mode} />
        <scrollbox ref={scrollRef} style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }} stickyScroll stickyStart="bottom">
          {messages.map((msg, i) => (
            <MessageRow
              key={i} msg={msg} index={i}
              expanded={expandedTools.has(i)} onToggle={() => toggleExpand(i)}
              onCopy={copyMessage} onEdit={editMessage} onDelete={deleteFrom} onRetry={retryMessage}
            />
          ))}
          {streamText !== null && (
            <box style={{ flexDirection: 'column', marginTop: 1, paddingLeft: 1, paddingRight: 1 }}>
              <text><span fg={A}>✻ Axion</span></text>
              <RichText>{streamText || ' '}</RichText>
            </box>
          )}
        </scrollbox>
        {/* Jump-to-bottom pill — only while scrolled up */}
        {!atBottom && inputMode === 'chat' && (
          <box style={{ flexShrink: 0, flexDirection: 'row', justifyContent: 'center' }}>
            <box onMouseDown={jumpToBottom} style={{ backgroundColor: '#2a2c33', paddingLeft: 1, paddingRight: 1 }}>
              <text><span fg={A}>{'↓ jump to bottom'}</span></text>
            </box>
          </box>
        )}
        {/* Thinking indicator */}
        {busy && inputMode === 'chat' && (
          <Thinking word={thinkingWord} elapsed={thinkingElapsed} tokens={tokens.context || 0} />
        )}

        {/* Confirmation / question prompts */}
        {inputMode === 'confirm-tool' && pendingConfirm && (
          <box style={{ paddingLeft: 1 }}>
            <text>
              <span fg="#f0c674">? </span>
              <span>run </span>
              <span fg="cyan">{pendingConfirm.name}</span>
              {pendingConfirm.label ? <span fg="#888">{`  ${pendingConfirm.label}`}</span> : null}
              <span fg="#888">{'   (y allow · a always · n deny)'}</span>
            </text>
          </box>
        )}
        {inputMode === 'confirm-plan' && (
          <box style={{ paddingLeft: 1 }}>
            <text><span fg="#f0c674">? </span><span>execute this plan? </span><span fg="#888">(y / n)</span></text>
          </box>
        )}
        {inputMode === 'question' && pendingForm && (
          <QuestionMenu form={pendingForm} isActive={isActive} onComplete={completeQuestion} onCancel={cancelQuestion} />
        )}

        {inputMode === 'chat' && input.startsWith('/') && <SuggestionBox inputValue={input} />}
        {fileActive && fileMatches.length ? (
          <FilePicker matches={fileMatches} selected={Math.min(fileSel, fileMatches.length - 1)} onPick={(i) => insertFile(fileMatches[i])} onHover={setFileSel} accentColor={A} />
        ) : null}
        {inputMode !== 'question' && (
        <box style={{ flexShrink: 0, border: true, borderColor: inputMode === 'chat' ? A : '#f0c674', height: 3, paddingLeft: 1, paddingRight: 1 }}>
          <input
            ref={inputElRef}
            value={input}
            onInput={setInputSafe}
            onSubmit={fileActive && fileMatches.length ? () => insertFile(fileMatches[Math.min(fileSel, fileMatches.length - 1)]) : submit}
            focused={isActive}
            placeholder={
              inputMode === 'confirm-tool' || inputMode === 'confirm-plan' ? 'press y / n …' :
              busy ? 'Axion is working…  (Esc to interrupt)' :
              'ask Axion something…  (Enter to send · / for commands · Ctrl+C twice to quit)'
            }
          />
        </box>
        )}
      </box>

      <Sidebar
        model={model}
        modeIcon={MODE_ICONS[mode] || '·'}
        modeLabel={modeLabel(mode)}
        modeColor={MODE_COLORS[mode] || 'cyan'}
        ctxUsed={ctxUsed}
        ctxWindow={ctxWindow}
        sessionCost={estimateCost(model, tokens.input || 0, tokens.output || 0) || 0}
        diffTotals={diffTotals}
        todos={todos}
      />
    </box>
  );
}

// ── Tabs ────────────────────────────────────────────────────────────────────────
// Each tab is an independent <Session> with its own Agent, history, model, and
// mode. All tabs stay mounted; inactive ones are `display:'none'` (zero layout)
// so their agents keep running in the background. Only the active tab takes keys.

let TAB_SEQ = 0;
const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function TabBar({ tabs, activeId, accentColor, onSwitchTab, onNewTab, onCloseTab }) {
  return (
    <box style={{ flexDirection: 'row', height: 1, backgroundColor: '#15161a', paddingLeft: 1 }}>
      {tabs.map((t, i) => {
        const on = t.id === activeId;
        const bg = on ? '#2a2c33' : undefined;
        return (
          <box key={t.id} style={{ flexDirection: 'row', backgroundColor: bg }}>
            <box onMouseDown={() => onSwitchTab?.(i)} style={{ flexDirection: 'row', paddingLeft: 1 }}>
              <text>
                <span fg={on ? accentColor : '#666'}>{`${i + 1} `}</span>
                <span fg={on ? '#ffffff' : '#888'}>{t.title || 'chat'}</span>
                {t.busy ? <span fg="#f0c674"> ●</span> : null}
              </text>
            </box>
            <box onMouseDown={() => onCloseTab?.(t.id)} style={{ paddingLeft: 1, paddingRight: 1 }}>
              <text><span fg={on ? '#aaaaaa' : '#555'}>✕</span></text>
            </box>
          </box>
        );
      })}
      <box onMouseDown={() => onNewTab?.()} style={{ paddingLeft: 1, paddingRight: 1 }}>
        <text><span fg={accentColor}>＋</span><span fg="#555"> new</span></text>
      </box>
    </box>
  );
}

export function App({ initialModel = 'lumen', initialMode = 'ask', initialResume = null, initialTabs = null, onExit = () => process.exit(0) }) {
  const { width, height } = useTerminalDimensions();
  const A = accent();
  // Build the opening tab set: a restored multi-tab workspace, or a single tab.
  const initialTabState = useRef(null);
  if (!initialTabState.current) {
    initialTabState.current = (initialTabs && initialTabs.length)
      ? initialTabs.map((t) => ({ id: ++TAB_SEQ, model: t.model || initialModel, mode: t.mode || initialMode, resume: t, title: t.title || t.name || null, busy: false }))
      : [{ id: ++TAB_SEQ, model: initialModel, mode: initialMode, resume: initialResume, title: initialResume?.name || null, busy: false }];
  }
  const [tabs, setTabs] = useState(initialTabState.current);
  const [activeId, setActiveId] = useState(initialTabState.current[0].id);

  // Keep a live ref to tabs + each tab's latest snapshot for workspace autosave.
  const tabsRef = useRef(tabs); tabsRef.current = tabs;
  const snapshotsRef = useRef(new Map());
  const wsTimerRef = useRef(null);
  const persistWorkspace = useCallback(() => {
    if (wsTimerRef.current) clearTimeout(wsTimerRef.current);
    wsTimerRef.current = setTimeout(() => {
      const list = tabsRef.current.map((t) => {
        const s = snapshotsRef.current.get(t.id);
        return s ? { ...s, title: t.title, name: `tab_${t.id}` } : null;
      }).filter(Boolean);
      try { autosaveWorkspace(list); } catch {}
    }, 800);
  }, []);
  const handleSnapshot = useCallback((tabId, snap, active) => {
    snapshotsRef.current.set(tabId, snap);
    if (active) { try { autosaveSession(snap); } catch {} }
    persistWorkspace();
  }, [persistWorkspace]);

  const newTab = useCallback(() => {
    const id = ++TAB_SEQ;
    setTabs((ts) => [...ts, { id, model: initialModel, mode: initialMode, resume: null, title: null }]);
    setActiveId(id);
  }, [initialModel, initialMode]);

  const switchTab = useCallback((target) => {
    setTabs((ts) => {
      if (ts.length < 2) return ts;
      const cur = ts.findIndex((t) => t.id === activeId);
      const idx = target === 'next' ? (cur + 1) % ts.length : Math.min(Math.max(0, target), ts.length - 1);
      setActiveId(ts[idx].id);
      return ts;
    });
  }, [activeId]);

  const setTitle = useCallback((id, title) => {
    const t = String(title).replace(/\s+/g, ' ').trim().slice(0, 16);
    setTabs((ts) => ts.map((x) => (x.id === id && !x.title) ? { ...x, title: t } : x));
  }, []);

  // ── Terminal-title spinner + desktop "done" ping ───────────────────────────────
  // While any tab's agent is working, the terminal/PowerShell tab title shows a
  // spinner. When a tab finishes, we ping the desktop (OSC 9 toast + bell) and
  // flash a 🔔 in the title. This works for background tabs too.
  const renderer = useRenderer();
  const busyTabsRef = useRef(new Set());
  const spinnerRef = useRef(null);
  const pingTimerRef = useRef(null);
  const spinFrameRef = useRef(0);

  const setTitleBar = useCallback((s) => { try { renderer?.setTerminalTitle?.(s); } catch {} }, [renderer]);
  const stopSpinner = useCallback(() => { if (spinnerRef.current) { clearInterval(spinnerRef.current); spinnerRef.current = null; } }, []);
  const startSpinner = useCallback(() => {
    if (spinnerRef.current) return;
    spinnerRef.current = setInterval(() => {
      setTitleBar(`${SPIN_FRAMES[spinFrameRef.current++ % SPIN_FRAMES.length]} Axion — working…`);
    }, 120);
  }, [setTitleBar]);
  const notifyDone = useCallback(() => {
    // OSC 9 desktop toast (Windows Terminal / iTerm2) + terminal bell. No-op
    // elsewhere; both are out-of-band control sequences, safe to interleave.
    try { writeSync(1, `\x1b]9;Axion finished a task\x07\x07`); } catch {}
    setTitleBar('🔔 Axion — done');
    if (pingTimerRef.current) clearTimeout(pingTimerRef.current);
    pingTimerRef.current = setTimeout(() => { if (busyTabsRef.current.size === 0) setTitleBar('Axion'); }, 5000);
  }, [setTitleBar]);

  const handleBusy = useCallback((tabId, busy) => {
    const s = busyTabsRef.current;
    const was = s.has(tabId);
    if (was === busy) return; // no actual change — avoid a needless re-render loop
    if (busy) s.add(tabId); else s.delete(tabId);
    setTabs((ts) => {
      const t = ts.find((x) => x.id === tabId);
      if (!t || t.busy === busy) return ts; // same reference → React bails, no re-render
      return ts.map((x) => (x.id === tabId ? { ...x, busy } : x));
    });
    if (busy) startSpinner();
    else if (was) { if (s.size === 0) stopSpinner(); notifyDone(); } // a tab just finished
  }, [startSpinner, stopSpinner, notifyDone]);

  useEffect(() => () => { stopSpinner(); if (pingTimerRef.current) clearTimeout(pingTimerRef.current); }, [stopSpinner]);

  // Remove a specific tab (the × button, or Ctrl+W for the active one). Closing
  // the last tab exits. Clears the removed tab's busy state so the spinner stops.
  const removeTab = useCallback((id, session) => {
    busyTabsRef.current.delete(id);
    snapshotsRef.current.delete(id);
    if (busyTabsRef.current.size === 0) stopSpinner();
    setTabs((ts) => {
      if (ts.length <= 1) { onExit(session); return ts; }
      const idx = ts.findIndex((t) => t.id === id);
      if (idx === -1) return ts;
      const next = ts.filter((t) => t.id !== id);
      setActiveId((cur) => (cur === id ? (next[Math.max(0, idx - 1)] || next[0]).id : cur));
      return next;
    });
    persistWorkspace();
  }, [onExit, stopSpinner, persistWorkspace]);
  const closeTab = useCallback((session) => removeTab(activeId, session), [removeTab, activeId]);

  return (
    <box style={{ width, height, flexDirection: 'column' }}>
      <TabBar tabs={tabs} activeId={activeId} accentColor={A} onSwitchTab={switchTab} onNewTab={newTab} onCloseTab={removeTab} />
      <box style={{ flexGrow: 1, position: 'relative' }}>
        {tabs.map((t) => {
          const on = t.id === activeId;
          // All tabs stay mounted (background agents keep running). Inactive tabs
          // are hidden via `visible`, NOT by resizing — OpenTUI doesn't reliably
          // repaint a subtree that was collapsed to 0×0 and re-expanded (static
          // text stays blank). So every pane is absolutely positioned at full
          // size and overlaps; switching only toggles visibility (no resize →
          // clean repaint). Explicit width/height keeps the inner flex laid out.
          return (
            <box
              key={t.id}
              visible={on}
              style={{ position: 'absolute', top: 0, left: 0, width, height: Math.max(0, height - 1), flexDirection: 'row' }}
            >
              <Session
                initialModel={t.model}
                initialMode={t.mode}
                initialResume={t.resume}
                isActive={on}
                onExit={onExit}
                onTitleChange={(title) => setTitle(t.id, title)}
                onBusyChange={(busy) => handleBusy(t.id, busy)}
                onSnapshot={(snap, active) => handleSnapshot(t.id, snap, active)}
                onNewTab={newTab}
                onCloseTab={closeTab}
                onSwitchTab={switchTab}
              />
            </box>
          );
        })}
      </box>
    </box>
  );
}
