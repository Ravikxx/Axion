import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Text, Static, useApp } from 'ink';
import { execSync, spawn } from 'child_process';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import Spinner from 'ink-spinner';
import { MessageRow } from './ChatPane.jsx';
import { InputBox, YesNoPrompt } from './Input.jsx';
import { SuggestionBox, getTabCompletion } from './Suggestions.jsx';
import { Agent } from '../agent/agent.js';
import { MODELS, setApiKey, CUSTOM_ENDPOINTS, VISION_MODEL, IMAGE_GEN_MODEL, estimateCost, getContextWindow } from '../config.js';
import {
  saveModel, saveMode, saveApiKey, saveCustomEndpoints, getCompareModels, saveCompareModels, searchChats,
  getAdviserModel, saveAdviserModel,
  saveChat, loadChat, listChats, deleteChat,
  undoLastBackup, undoStackSize, exportChat,
  getMemories, addMemory, removeMemory,
  getSavedVisionModel, saveVisionModel,
  getSavedImageModel, saveImageModel,
  saveMacro, loadMacro, listMacros, deleteMacro,
  appendLearnedInstructions, clearLearnedInstructions, getLearnedInstructions,
  getSchedules, saveSchedules, saveScheduleResult, getScheduleResults,
} from '../persist.js';
import { parseSchedule, isDue, tickScheduler } from '../scheduler.js';
import { connectOAuth, listOAuthTokens, revokeOAuthToken, getOAuthToken } from '../oauth/oauth.js';
import { OAUTH_PROVIDERS } from '../oauth/providers.js';
import { captureScreen, MACRO_STATE, showOverlay, hideOverlay } from '../agent/computer.js';
import { MCP, getMcpConfig, saveMcpConfig } from '../agent/mcp.js';
import { MCP_MARKETPLACE, CATEGORIES, searchMarketplace, getMarketplaceEntry } from '../agent/mcp-marketplace.js';
import { analyzeScreen } from '../agent/vision.js';
import { generateImage } from '../agent/image.js';
import { executeTool } from '../agent/tools.js';
import { homedir } from 'os';

// ── Constants ─────────────────────────────────────────────────────────────────

const THINKING_WORDS = [
  'baking', 'brewing', 'conjuring', 'weaving', 'crafting',
  'simmering', 'forging', 'hatching', 'distilling', 'wrangling',
  'cooking up', 'scheming', 'assembling', 'calibrating', 'synthesizing',
  'plotting', 'whittling', 'ruminating', 'percolating', 'manifesting',
  'untangling', 'chiseling', 'mulling', 'marinating', 'decoding',
  'reverse-engineering', 'daydreaming', 'noodling', 'spelunking', 'simulating',
  'hallucinating productively', 'connecting dots', 'running the numbers', 'vibing',
];

const MODE_COLORS = { ask: 'cyan', plan: 'yellow', auto: 'greenBright', bypass: 'greenBright' };
const CYCLE_MODES = ['ask', 'plan', 'auto']; // internal values; auto displays as 'bypass'
const MAX_GOAL_ITERS = 25;

const HELP_TEXT = `  Commands
  ──────────────────────────────────────────────────
  /help                         this screen
  /model <name|id>              switch model (alias or raw ID)
  /mode  <name>                 switch mode: ask · plan · bypass  (Ctrl+P to cycle)
  /api   <model> <key>          set API key (saved)
  /endpoint <name> <url> [model] [key]  add a custom endpoint
  /endpoint                             list saved endpoints
  /thinking [on|off|<tokens>]   toggle extended thinking (all models)
  /adviser [model|auto|off]     set model used as adviser when agent gets stuck
  /computer [on|off]            toggle computer use (screen control)
  /vision  <model>              set vision model for computer use (saved)
  /vision                       show current vision model
  /ss      [question]           screenshot + describe screen (quick, no agent loop)
  /img-gen <prompt>             generate an image using OpenAI (saved to ~/.axion/images/)
  /img-gen-model [model]        set/show image generation model (dall-e-3, dall-e-2, gpt-image-1)
  /macro record <name>          start recording a macro (computer use actions)
  /macro stop                   save the recorded macro
  /macro play <name>            replay a saved macro
  /macro list                   list all saved macros
  /macro delete <name>          delete a saved macro
  /watch                        start watch-and-learn (analyzes your messages for preferences)
  /watch stop                   stop + save learned preferences to ~/.axion/learned.md
  /watch show                   view current learned preferences
  /watch clear                  delete all learned preferences
  /remember <text>              save a persistent note (always injected into system prompt)
  /remember                     list all saved notes
  /forget <index>               remove a saved note by number
  /models                       list all available models + custom endpoints
  /history <query>              search message history
  /system [text]                set/clear extra system prompt instructions
  /include <file>               pin a file into context for the session
  /include                      list pinned files
  /include remove <file>        unpin a file
  /include clear                unpin all files
  /compare <prompt>             run prompt through saved/default models side by side
  /compare <m1,m2,...> <prompt> override models for this run  e.g. /compare claude,ollama <prompt>
  /compare-models               show saved compare model list
  /compare-models <m1,m2,...>   save default models for /compare  e.g. /compare-models claude,gpt,ollama
  /compare-models reset         restore built-in defaults (claude · gpt · gemini)
  /review                       code review of current git diff (structured feedback)
  /goal <description>           work autonomously until the goal is met
  /goal                         show or cancel current goal
  /retry                        re-run the last message
  /copy                         copy last AI response to clipboard
  /copy-block <n>               copy the Nth code block from the last response
  /export <filename>            save chat as markdown file
  /undo                         restore last overwritten/deleted file
  /save          <name>         save current chat
  /remove-chat   <name>         delete a saved chat
  /resume        <name>         resume a saved chat (no name = list all)
  /search-chats  <query>        search across all saved chats
  /compact                      summarize & compress history
  /btw   <question>             quick side question, no history
  /clear                        clear history
  /blender setup                show Blender add-on install instructions
  /blender connect              connect Blender MCP server to Axion
  /mcp                          show connected MCP servers + tool counts
  /mcp browse                   browse MCP marketplace (curated servers)
  /mcp search <query>           search marketplace by keyword
  /mcp install <id>             install a server from the marketplace
  /mcp add <name> <cmd> [args]  connect a custom MCP server (saved)
  /mcp enable <name>            enable a disabled server
  /mcp disable <name>           pause a server (keeps config)
  /mcp remove <name>            disconnect + delete config
  /mcp tools [name]             list tools from connected servers
  /mcp reload                   restart all servers
  /web   [port]                 open web UI in browser (default port 3000)
  /web   stop                   stop the running web server
  /oauth connect <service>      connect GitHub · Google · Notion · Slack
  /oauth list                   show connected services
  /oauth revoke <service>       disconnect a service
  /schedule                     list scheduled tasks
  /schedule add <n> "<expr>" <prompt>  add a scheduled task
  /schedule run <name>          run a task now
  /schedule remove <name>       delete a task
  /schedule enable/disable <n>  toggle a task
  /schedule results [name]      show result files
  /exit                         quit

  Models: ${Object.keys(MODELS).join(' · ')}

  Ollama: /model ollama  (ollama must be running at localhost:11434)

  .axionrc  — drop a JSON file in your project root to set defaults:
    { "model": "claude", "mode": "bypass", "systemPrompt": "...", "thinking": true }`;

function shortCwd() {
  const cwd = process.cwd();
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

function formatTokens(n) {
  if (!n) return null;
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatCost(dollars) {
  if (dollars == null) return null;
  if (dollars < 0.001) return '<$0.001';
  if (dollars < 0.01)  return `$${dollars.toFixed(3)}`;
  return `$${dollars.toFixed(2)}`;
}

function contextGauge(used, total, width = 8) {
  const pct   = Math.min(used / total, 1);
  const filled = Math.round(pct * width);
  const bar   = '█'.repeat(filled) + '░'.repeat(width - filled);
  const color = pct > 0.85 ? 'red' : pct > 0.6 ? 'yellow' : 'gray';
  return { bar, pct, color };
}

function copyToClipboard(text) {
  const cmd = process.platform === 'win32' ? 'clip'
            : process.platform === 'darwin' ? 'pbcopy'
            : 'xclip -selection clipboard';
  execSync(cmd, { input: text });
}

function pickThinkingWord() {
  return THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)];
}

const CWD = shortCwd();

// ── Welcome banner ────────────────────────────────────────────────────────────

function modeLabel(mode) { return mode === 'auto' ? 'bypass' : mode; }

function WelcomeBanner({ model, mode }) {
  const modeColor  = MODE_COLORS[mode] || 'cyan';
  const isFirstRun = model === 'veil' && !getMemories().length;
  return (
    <Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor="gray" paddingX={2} paddingY={0}>
      <Box gap={4}>
        {/* Left column */}
        <Box flexDirection="column" minWidth={28}>
          <Box gap={1} marginBottom={0}>
            <Text color="blueBright" bold>◈ Axion</Text>
            <Text color="gray" dimColor>by Axion Labs</Text>
          </Box>
          <Box gap={1} marginLeft={2}>
            <Text color="gray" dimColor>model </Text>
            <Text color="cyan">{model}</Text>
          </Box>
          <Box gap={1} marginLeft={2}>
            <Text color="gray" dimColor>mode  </Text>
            <Text color={modeColor}>{modeLabel(mode)}</Text>
          </Box>
          <Box marginLeft={2} marginTop={0}>
            <Text color="gray" dimColor>dir   {CWD}</Text>
          </Box>
        </Box>

        {/* Right column */}
        <Box flexDirection="column">
          {isFirstRun ? (
            <>
              <Text color="yellowBright" bold>Welcome to Axion!</Text>
              <Text color="gray">  You're on <Text color="cyan">Veil</Text> — no API key needed, start chatting now.</Text>
              <Text color="yellow" dimColor>  ⚠ Veil is free but slow — responses can take up to 100s. Not broken!</Text>
              <Text color="gray">  To use Claude/GPT/Gemini: <Text color="white">/api claude sk-ant-...</Text></Text>
              <Text color="gray">  Switch models anytime:    <Text color="white">/model claude</Text></Text>
              <Text color="gray">  Browse MCP integrations:  <Text color="white">/mcp browse</Text></Text>
              <Text color="gray">  Connect GitHub/Google:    <Text color="white">/oauth connect github</Text></Text>
              <Text color="gray">  See everything:           <Text color="white">/help</Text></Text>
            </>
          ) : (
            <>
              <Text color="yellowBright" bold>Quick reference</Text>
              <Text color="gray">  /help for all commands</Text>
              <Text color="gray">  /model · /mode · /api to configure</Text>
              <Text color="gray">  /mcp browse · /mcp install &lt;id&gt;</Text>
              <Text color="gray">  /thinking to enable extended reasoning</Text>
              <Text color="gray">  /goal to run until a condition is met</Text>
            </>
          )}
        </Box>
      </Box>
    </Box>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

export function App({
  initialModel,
  initialMode,
  initialSystemOverride = '',
  initialThinking       = false,
  initialThinkingBudget = 10000,
  webServerPath         = '',
}) {
  const { exit } = useApp();
  const [model, setModel]         = useState(initialModel);
  const [mode, setMode]           = useState(initialMode);
  const [staticMessages, setStaticMessages] = useState([
    { type: '_banner', model: initialModel, mode: initialMode },
  ]);
  const [liveMessages, setLiveMessages]   = useState([]);
  const [thinking, setThinking]           = useState(false);
  const [thinkingWord, setThinkingWord]   = useState('baking');
  const [inputMode, setInputMode]         = useState('chat');
  const [pendingConfirm, setPendingConfirm] = useState(null);
  const [inputValue, setInputValue]       = useState('');
  const [tokens, setTokens]               = useState({ total: 0, input: 0, output: 0 });
  const [diffsExpanded, setDiffsExpanded] = useState(false);
  const [thinkingExpanded, setThinkingExpanded] = useState(true);

  // Extended thinking config
  const [extThinking, setExtThinking]     = useState(initialThinking);
  const [thinkingBudget, setThinkingBudget] = useState(initialThinkingBudget);

  // System override
  const [systemOverride, setSystemOverride] = useState(initialSystemOverride);

  // Goal mode
  const [goal, setGoal]                 = useState(null);
  const [goalIteration, setGoalIteration] = useState(0);
  const goalActiveRef = useRef(false);

  // Computer use
  const [computerUse, setComputerUse]   = useState(false);

  // Watch-and-learn
  const [watchActive, setWatchActive]   = useState(false);
  const watchBufferRef                  = useRef([]);

  // Pinned files (/include)
  const [includedFiles, setIncludedFiles] = useState([]);

  // Session cost accumulator
  const [sessionCost, setSessionCost]   = useState(0);
  const prevTokRef                       = useRef({ input: 0, output: 0 });

  // Streaming state — separate from liveMessages to allow throttled updates
  const [streamContent, setStreamContent]  = useState(null); // null = not streaming
  const streamBufRef   = useRef('');
  const streamTimerRef = useRef(null);

  const agentRef           = useRef(null);
  const confirmResolverRef = useRef(null);
  const lastUserMsgRef     = useRef('');

  const liveRef    = useRef([]);
  const addLive    = useCallback((msg) => {
    liveRef.current = [...liveRef.current, msg];
    setLiveMessages(liveRef.current);
  }, []);
  const pushStatic = useCallback((msg) => setStaticMessages((p) => [...p, msg]), []);

  const finalizeTurn = useCallback(() => {
    const live = liveRef.current;
    liveRef.current = [];
    setLiveMessages([]);
    if (live.length > 0) setStaticMessages((p) => [...p, ...live]);
  }, []);

  // ── Init agent ─────────────────────────────────────────────────────────────

  // Flush accumulated stream buffer to React state (throttled to ~30 fps)
  const flushStream = useCallback(() => {
    streamTimerRef.current = null;
    const buf = streamBufRef.current;
    if (buf) setStreamContent(buf);
  }, []);

  useEffect(() => {
    agentRef.current = new Agent({
      modelAlias: initialModel,
      mode:       initialMode,
      onTokens: (t) => {
        const tok = typeof t === 'object' ? t : { total: t, input: 0, output: t };
        setTokens(tok);
        const di  = (tok.input  || 0) - prevTokRef.current.input;
        const dout = (tok.output || 0) - prevTokRef.current.output;
        if (di > 0 || dout > 0) {
          prevTokRef.current = { input: tok.input || 0, output: tok.output || 0 };
        }
      },
      onStreamChunk: (chunk) => {
        streamBufRef.current += chunk;
        if (!streamTimerRef.current) {
          streamTimerRef.current = setTimeout(flushStream, 30);
        }
      },
      onStreamEnd: () => {
        if (streamTimerRef.current) { clearTimeout(streamTimerRef.current); streamTimerRef.current = null; }
        const raw = streamBufRef.current;
        streamBufRef.current = '';
        setStreamContent(null);
        // Fallback: extract <think> tags that weren't caught mid-stream
        const thinkRe = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;
        const thoughts = [];
        let m;
        while ((m = thinkRe.exec(raw)) !== null) {
          if (m[1].trim()) thoughts.push(m[1].trim());
        }
        const content = thoughts.length
          ? raw.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim()
          : raw;
        // Single atomic update so thinking always appears before assistant in the same render
        const newMsgs = [
          ...thoughts.map(t => ({ type: 'thinking', content: t })),
          ...(content.trim() ? [{ type: 'assistant', content }] : []),
        ];
        if (newMsgs.length > 0) {
          liveRef.current = [...liveRef.current, ...newMsgs];
          setLiveMessages(liveRef.current);
        }
      },
      onToolCall: ({ name, input, id }) => {
        const msg = { type: 'tool', id, name, input, output: null, success: null, pending: true };
        liveRef.current = [...liveRef.current, msg];
        setLiveMessages(liveRef.current);
      },
      onToolResult: ({ name, output, success, diff }) => {
        const idx = [...liveRef.current].reverse().findIndex((m) => m.type === 'tool' && m.name === name && m.pending);
        if (idx === -1) return;
        const ri = liveRef.current.length - 1 - idx;
        const updated = [...liveRef.current];
        updated[ri] = { ...updated[ri], output, success, pending: false, diff: diff || null };
        liveRef.current = updated;
        setLiveMessages(liveRef.current);
      },
      onMessage: ({ role, content, label, tokens: toks }) => {
        if (role === 'assistant')  addLive({ type: 'assistant',  content });
        else if (role === 'thinking')   addLive({ type: 'thinking',   content, tokens: toks });
        else if (role === 'plan')       addLive({ type: 'plan',       content });
        else if (role === 'error')      addLive({ type: 'error',      content });
        else if (role === 'adviser')    addLive({ type: 'adviser',    content });
        else if (role === 'sub-agent')  addLive({ type: 'sub-agent',  content, label });
      },
      onNotify: (n) => {
        if (n.type === 'agent-msg') addLive({ type: 'agent-msg', from: n.from, to: n.to, content: n.content });
      },
    });
    // Apply .axionrc / initial props
    if (initialSystemOverride) agentRef.current.setSystemOverride(initialSystemOverride);
    if (initialThinking)       agentRef.current.setThinking(true, initialThinkingBudget);
    // Seed adviser model from saved config
    const savedAdviser = getAdviserModel();
    if (savedAdviser) agentRef.current.setAdviserModel(savedAdviser);
    // Seed vision model from saved config
    const savedVision = getSavedVisionModel();
    if (savedVision) VISION_MODEL.current = savedVision;
    // Seed image model from saved config
    const savedImg = getSavedImageModel();
    if (savedImg) IMAGE_GEN_MODEL.current = savedImg;
  }, []);

  useEffect(() => {
    if (agentRef.current) {
      agentRef.current.setModel(model);
      agentRef.current.setMode(mode);
    }
  }, [model, mode]);

  useEffect(() => {
    agentRef.current?.setThinking(extThinking, thinkingBudget);
  }, [extThinking, thinkingBudget]);

  useEffect(() => {
    const pinned = includedFiles.map(f =>
      `<pinned-file path="${f.path}">\n${f.content}\n</pinned-file>`
    ).join('\n\n');
    agentRef.current?.setSystemOverride([systemOverride, pinned].filter(Boolean).join('\n\n'));
  }, [systemOverride, includedFiles]);

  useEffect(() => {
    agentRef.current?.setGoal(goal);
  }, [goal]);

  useEffect(() => {
    agentRef.current?.setComputerUse(computerUse);
    if (computerUse) showOverlay(); else hideOverlay();
  }, [computerUse]);

  // ── Core run (handles goal loop) ───────────────────────────────────────────

  const runAgent = useCallback(
    async (message, isRetry = false) => {
      const askConfirm = (tc) => {
        // Never prompt for sequential thinking — it's internal reasoning, not an action
        if (tc.name && tc.name.includes('sequentialthinking')) return Promise.resolve(true);
        return new Promise((resolve) => {
          setPendingConfirm({ name: tc.name, label: confirmLabel(tc.name, tc.input) });
          setInputMode('confirm-tool');
          confirmResolverRef.current = resolve;
        });
      };
      const askPlanConfirm = () =>
        new Promise((resolve) => {
          setInputMode('confirm-plan');
          confirmResolverRef.current = resolve;
        });

      if (goal) {
        // Goal loop — keep running until GOAL_COMPLETE or max iterations
        goalActiveRef.current = true;
        for (let iter = 0; iter < MAX_GOAL_ITERS && goalActiveRef.current; iter++) {
          setGoalIteration(iter + 1);
          const msg = iter === 0 ? message : 'Continue working on the goal.';
          if (iter > 0) {
            pushStatic({ type: 'info', content: `── goal iteration ${iter + 1} ──` });
            liveRef.current = []; setLiveMessages([]);
          }
          await agentRef.current.run(msg, { askConfirm, askPlanConfirm });

          // Check last assistant message for completion signal
          const hist = agentRef.current.history;
          const last = [...hist].reverse().find((m) => m.role === 'assistant');
          const lastText = typeof last?.content === 'string' ? last.content
            : last?.content?.find?.((c) => c.type === 'text')?.text || '';
          if (lastText.includes('GOAL_COMPLETE')) {
            pushStatic({ type: 'info', content: `✔ Goal complete after ${iter + 1} iteration(s).` });
            setGoal(null);
            goalActiveRef.current = false;
            break;
          }
          finalizeTurn();
        }
        if (goalActiveRef.current && goalIteration >= MAX_GOAL_ITERS) {
          pushStatic({ type: 'info', content: `Goal reached max iterations (${MAX_GOAL_ITERS}). Use /goal to reset.` });
        }
        goalActiveRef.current = false;
        setGoalIteration(0);
      } else {
        await agentRef.current.run(message, { askConfirm, askPlanConfirm });
      }
    },
    [goal, finalizeTurn, pushStatic]
  );

  // ── Slash commands ─────────────────────────────────────────────────────────

  const handleSlashCommand = useCallback(
    async (input) => {
      const [cmd, ...args] = input.slice(1).trim().split(/\s+/);
      const arg = args.join(' ');

      switch (cmd.toLowerCase()) {
        case 'help':
          pushStatic({ type: 'info', content: HELP_TEXT });
          return true;

        case 'exit':
          exit();
          return true;

        case 'clear':
          setStaticMessages([{ type: '_banner', model, mode }]);
          liveRef.current = []; setLiveMessages([]);
          agentRef.current?.clearHistory();
          setTokens({ total: 0, input: 0, output: 0 });
          setSessionCost(0);
          prevTokRef.current = { input: 0, output: 0 };
          lastUserMsgRef.current = '';
          return true;

        case 'model':
          if (!arg) {
            pushStatic({ type: 'info', content: `current: ${model}  available: ${Object.keys(MODELS).join(' · ')}` });
          } else {
            setModel(arg);
            saveModel(arg);
            pushStatic({ type: 'info', content: `model → ${arg} (saved)` });
          }
          return true;

        case 'mode': {
          // 'bypass' is the user-facing alias for 'auto'
          const normalizedMode = arg === 'bypass' ? 'auto' : arg;
          if (!['ask', 'plan', 'auto'].includes(normalizedMode)) {
            pushStatic({ type: 'error', content: `unknown mode "${arg}" — use ask, plan, or bypass` });
          } else {
            setMode(normalizedMode);
            saveMode(normalizedMode);
            pushStatic({ type: 'info', content: `mode → ${modeLabel(normalizedMode)} (saved)` });
          }
          return true;
        }

        case 'api': {
          const [apiTarget, apiKey] = args;
          if (!apiTarget || !apiKey) {
            pushStatic({ type: 'error', content: 'usage: /api <model> <key>   e.g. /api claude sk-ant-…' });
            return true;
          }
          try {
            const provider = setApiKey(apiTarget, apiKey);
            saveApiKey(provider, apiKey);
            pushStatic({ type: 'info', content: `API key set for ${provider} (saved)` });
          } catch (err) {
            pushStatic({ type: 'error', content: err.message });
          }
          return true;
        }

        case 'thinking': {
          if (!arg || arg === 'off') {
            setExtThinking(false);
            pushStatic({ type: 'info', content: 'Extended thinking off.' });
          } else if (arg === 'on') {
            setExtThinking(true);
            pushStatic({ type: 'info', content: `Extended thinking on  (budget: ${thinkingBudget.toLocaleString()} tokens)` });
          } else {
            const budget = parseInt(arg, 10);
            if (isNaN(budget) || budget < 1000) {
              pushStatic({ type: 'error', content: 'usage: /thinking [on|off|<tokens>]  e.g. /thinking 20000' });
            } else {
              setExtThinking(true);
              setThinkingBudget(budget);
              pushStatic({ type: 'info', content: `Extended thinking on  (budget: ${budget.toLocaleString()} tokens)` });
            }
          }
          return true;
        }

        case 'adviser':
        case 'advisor': {
          if (!arg) {
            const current = agentRef.current?.adviserModel;
            if (current) {
              pushStatic({ type: 'info', content: `Adviser model: ${current}\n\n  /adviser auto      — let Axion auto-pick\n  /adviser off       — disable adviser\n  /adviser <model>   — set to any model alias` });
            } else {
              pushStatic({ type: 'info', content: `Adviser model: auto (picks highest-capability available model)\n\n  /adviser <model>   — pin to a specific model e.g. /adviser claude-opus\n  /adviser off       — disable adviser entirely` });
            }
            return true;
          }
          if (arg === 'auto') {
            agentRef.current?.setAdviserModel(null);
            saveAdviserModel(null);
            pushStatic({ type: 'info', content: 'Adviser model set to auto.' });
            return true;
          }
          if (arg === 'off') {
            agentRef.current?.setAdviserModel('off');
            saveAdviserModel('off');
            pushStatic({ type: 'info', content: 'Adviser disabled. Axion will not consult a second model when stuck.' });
            return true;
          }
          agentRef.current?.setAdviserModel(arg);
          saveAdviserModel(arg);
          pushStatic({ type: 'info', content: `Adviser model → ${arg} (saved)` });
          return true;
        }

        case 'system': {
          if (!arg) {
            if (systemOverride) {
              pushStatic({ type: 'info', content: `Current system override:\n  ${systemOverride}\n\nUse /system clear to remove.` });
            } else {
              pushStatic({ type: 'info', content: 'No system override set. Usage: /system <instructions>' });
            }
          } else if (arg === 'clear') {
            setSystemOverride('');
            pushStatic({ type: 'info', content: 'System override cleared.' });
          } else {
            setSystemOverride(arg);
            pushStatic({ type: 'info', content: `System override set: ${arg}` });
          }
          return true;
        }

        case 'include': {
          const [sub, ...incRest] = args;
          if (!sub) {
            if (!includedFiles.length) {
              pushStatic({ type: 'info', content: 'No files pinned. Usage: /include <file>' });
            } else {
              const lines = includedFiles.map((f, i) => `  ${i + 1}. ${f.path}  (${f.content.length} chars)`).join('\n');
              pushStatic({ type: 'info', content: `Pinned files (${includedFiles.length}):\n${lines}\n\nUse /include remove <file> or /include clear` });
            }
            return true;
          }
          if (sub === 'clear') {
            setIncludedFiles([]);
            pushStatic({ type: 'info', content: 'All pinned files removed.' });
            return true;
          }
          if (sub === 'remove') {
            const target = incRest.join(' ');
            if (!target) {
              pushStatic({ type: 'error', content: 'usage: /include remove <file>' });
              return true;
            }
            setIncludedFiles(prev => prev.filter(f => f.path !== target));
            pushStatic({ type: 'info', content: `Unpinned: ${target}` });
            return true;
          }
          // Otherwise, sub is the file path (possibly with rest args)
          const filePath = [sub, ...incRest].join(' ');
          try {
            const abs = resolve(process.cwd(), filePath);
            if (!existsSync(abs)) throw new Error(`File not found: ${filePath}`);
            const content = readFileSync(abs, 'utf8');
            setIncludedFiles(prev => {
              if (prev.some(f => f.path === filePath)) return prev;
              return [...prev, { path: filePath, content }];
            });
            pushStatic({ type: 'info', content: `Pinned: ${filePath}  (${content.length} chars — always in context)` });
          } catch (err) {
            pushStatic({ type: 'error', content: `include failed: ${err.message}` });
          }
          return true;
        }

        case 'compare': {
          if (!arg) {
            pushStatic({ type: 'error', content: 'usage: /compare [model1,model2,...] <prompt>\n  e.g. /compare what is a monad\n       /compare claude,gpt,ollama what is a monad\n       /compare claude-opus,gemini-2.5-pro explain async/await' });
            return true;
          }
          // If first token contains a comma, or is a known model/endpoint, treat it as the model list
          const firstToken = args[0];
          const isModelList = firstToken.includes(',') ||
            (MODELS[firstToken] != null) ||
            (CUSTOM_ENDPOINTS[firstToken] != null);
          let compareModels, prompt;
          if (isModelList) {
            compareModels = firstToken.split(',').map(s => s.trim()).filter(Boolean);
            prompt = args.slice(1).join(' ');
          } else {
            compareModels = getCompareModels() || ['claude', 'gpt', 'gemini'];
            prompt = arg;
          }
          if (!prompt) {
            pushStatic({ type: 'error', content: 'prompt is required after the model list' });
            return true;
          }
          pushStatic({ type: 'info', content: `Comparing across ${compareModels.join(' · ')}…` });
          setThinking(true);
          setThinkingWord('comparing');
          try {
            const results = await Promise.allSettled(
              compareModels.map(async (m) => {
                const tmp = new Agent({
                  modelAlias: m, mode: 'auto',
                  onToolCall: () => {}, onToolResult: () => {},
                  onMessage: () => {}, onTokens: () => {},
                  onStreamChunk: () => {}, onStreamEnd: () => {}, onNotify: () => {},
                });
                const answer = await tmp.askBtw(prompt);
                return { model: m, answer };
              })
            );
            for (const r of results) {
              if (r.status === 'fulfilled') {
                pushStatic({ type: 'assistant', content: `**[${r.value.model}]**\n\n${r.value.answer}` });
              } else {
                pushStatic({ type: 'error', content: `[${r.reason?.model || '?'}] ${r.reason?.message || String(r.reason)}` });
              }
            }
          } catch (err) {
            pushStatic({ type: 'error', content: `compare failed: ${err.message}` });
          } finally {
            setThinking(false);
          }
          return true;
        }

        case 'compare-models': {
          if (!arg) {
            const saved = getCompareModels();
            if (saved) {
              pushStatic({ type: 'info', content: `Compare models: ${saved.join(' · ')}\n\nUse /compare-models <m1,m2,...> to change, /compare-models reset to restore defaults.` });
            } else {
              pushStatic({ type: 'info', content: `Compare models: claude · gpt · gemini  (defaults)\n\nUse /compare-models <m1,m2,...> to save a custom list.` });
            }
            return true;
          }
          if (arg === 'reset') {
            saveCompareModels(null);
            pushStatic({ type: 'info', content: 'Compare models reset to defaults (claude · gpt · gemini).' });
            return true;
          }
          const newModels = arg.split(',').map(s => s.trim()).filter(Boolean);
          if (newModels.length < 2) {
            pushStatic({ type: 'error', content: 'Provide at least 2 comma-separated models, e.g. /compare-models claude,gpt,ollama' });
            return true;
          }
          saveCompareModels(newModels);
          pushStatic({ type: 'info', content: `Compare models saved: ${newModels.join(' · ')}  (used by /compare as default)` });
          return true;
        }

        case 'review': {
          let diff = '';
          try {
            const staged   = execSync('git diff --cached', { cwd: process.cwd(), encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
            const unstaged = execSync('git diff HEAD',    { cwd: process.cwd(), encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
            diff = [staged, unstaged].filter(Boolean).join('\n');
          } catch {
            diff = '';
          }
          if (!diff.trim()) {
            pushStatic({ type: 'info', content: 'No changes to review (git diff is empty).' });
            return true;
          }
          const reviewPrompt = `Review the following git diff and give structured feedback.\n\nFor each section, only include it if there are findings. Skip sections with nothing to report.\n\n**Bugs**: logic errors, off-by-ones, null/undefined issues, incorrect conditions.\n**Security**: injections, exposed secrets, insecure patterns.\n**Style**: naming, consistency, readability issues.\n**Suggestions**: improvements that aren't bugs.\n\nBe concise. One line per finding.\n\n\`\`\`diff\n${diff.slice(0, 12000)}\n\`\`\``;
          setThinking(true);
          setThinkingWord('reviewing');
          try {
            const feedback = await agentRef.current.askBtw(reviewPrompt);
            pushStatic({ type: 'assistant', content: feedback });
          } catch (err) {
            pushStatic({ type: 'error', content: `review failed: ${err.message}` });
          } finally {
            setThinking(false);
          }
          return true;
        }

        case 'copy-block': {
          const n = parseInt(arg, 10);
          if (!arg || isNaN(n) || n < 1) {
            pushStatic({ type: 'error', content: 'usage: /copy-block <n>  e.g. /copy-block 2' });
            return true;
          }
          const allMsgs = [...staticMessages, ...liveMessages];
          const lastAsst = [...allMsgs].reverse().find(m => m.type === 'assistant');
          if (!lastAsst?.content) {
            pushStatic({ type: 'info', content: 'No AI response to copy from.' });
            return true;
          }
          const blocks = [];
          const blockRe = /```(?:[^\n]*)?\n([\s\S]*?)```/g;
          let bm;
          while ((bm = blockRe.exec(lastAsst.content)) !== null) blocks.push(bm[1]);
          if (!blocks.length) {
            pushStatic({ type: 'info', content: 'No code blocks found in last response.' });
            return true;
          }
          if (n > blocks.length) {
            pushStatic({ type: 'info', content: `Only ${blocks.length} code block(s) found. Use /copy-block 1–${blocks.length}.` });
            return true;
          }
          try {
            copyToClipboard(blocks[n - 1]);
            pushStatic({ type: 'info', content: `✔ Code block ${n}/${blocks.length} copied.` });
          } catch {
            pushStatic({ type: 'error', content: 'Clipboard unavailable.' });
          }
          return true;
        }

        case 'goal': {
          if (!arg) {
            if (goal) {
              goalActiveRef.current = false;
              setGoal(null);
              setGoalIteration(0);
              pushStatic({ type: 'info', content: `Goal cancelled: "${goal}"` });
            } else {
              pushStatic({ type: 'info', content: 'No active goal. Usage: /goal <description>' });
            }
          } else {
            setGoal(arg);
            pushStatic({ type: 'info', content: `Goal set: "${arg}"\nAxion will work autonomously until this is achieved (max ${MAX_GOAL_ITERS} iterations).` });
          }
          return true;
        }

        case 'retry': {
          if (!lastUserMsgRef.current) {
            pushStatic({ type: 'info', content: 'Nothing to retry yet.' });
            return true;
          }
          // Roll back history to before last user message
          if (agentRef.current) {
            const h = agentRef.current.history;
            const lastUserIdx = [...h].reverse().findIndex((m) => m.role === 'user');
            if (lastUserIdx !== -1) {
              agentRef.current.history = h.slice(0, h.length - 1 - lastUserIdx);
            }
          }
          pushStatic({ type: 'info', content: `↩ Retrying: "${lastUserMsgRef.current}"` });
          pushStatic({ type: 'user', content: lastUserMsgRef.current });
          liveRef.current = []; setLiveMessages([]);
          setThinking(true);
          setThinkingWord(pickThinkingWord());
          try {
            await runAgent(lastUserMsgRef.current, true);
          } catch (err) {
            addLive({ type: 'error', content: err.message });
          } finally {
            setThinking(false);
            setInputMode('chat');
            setPendingConfirm(null);
            finalizeTurn();
          }
          return true;
        }

        case 'copy': {
          // Find last assistant message (live first, then static)
          const allMsgs = [...staticMessages, ...liveMessages];
          const last = [...allMsgs].reverse().find((m) => m.type === 'assistant');
          if (!last?.content) {
            pushStatic({ type: 'info', content: 'No AI response to copy yet.' });
            return true;
          }
          try {
            copyToClipboard(last.content);
            pushStatic({ type: 'info', content: '✔ Copied to clipboard.' });
          } catch {
            pushStatic({ type: 'error', content: 'Clipboard unavailable. Try installing xclip (Linux) or check permissions.' });
          }
          return true;
        }

        case 'export': {
          if (!arg) {
            pushStatic({ type: 'error', content: 'usage: /export <filename>   e.g. /export chat-2026-06' });
            return true;
          }
          const displayMsgs = staticMessages.filter((m) => m.type !== '_banner');
          try {
            const outPath = exportChat(arg, displayMsgs);
            pushStatic({ type: 'info', content: `✔ Exported to ${outPath}` });
          } catch (err) {
            pushStatic({ type: 'error', content: `Export failed: ${err.message}` });
          }
          return true;
        }

        case 'endpoint': {
          const [first, second, third, fourth] = args;
          if (!first) {
            const entries = Object.entries(CUSTOM_ENDPOINTS);
            if (!entries.length) {
              pushStatic({ type: 'info', content: `No custom endpoints saved.\n\nUsage: /endpoint <name> <url> [model] [key]\n\nExamples:\n  /endpoint ollama http://localhost:11434/v1 llama3\n  /endpoint openrouter https://openrouter.ai/api/v1 google/gemini-2.0-flash sk-or-…` });
            } else {
              const lines = entries.map(([n, e]) => `  ${n.padEnd(16)} ${e.baseURL}  model: ${e.model}`).join('\n');
              pushStatic({ type: 'info', content: `Saved endpoints:\n${lines}` });
            }
            return true;
          }
          let epName, epURL, epModel, epKey;
          if (first.startsWith('http')) {
            epName = 'other'; epURL = first; epModel = second; epKey = third;
          } else {
            epName = first; epURL = second; epModel = third; epKey = fourth;
          }
          if (!epURL) {
            const ep = CUSTOM_ENDPOINTS[epName];
            if (ep) {
              pushStatic({ type: 'info', content: `${epName}: ${ep.baseURL}\n  model: ${ep.model}  key: ${ep.apiKey && ep.apiKey !== 'no-key' ? '(set)' : 'none'}` });
            } else {
              pushStatic({ type: 'error', content: `No endpoint named "${epName}". Run /endpoint to list all.` });
            }
            return true;
          }
          CUSTOM_ENDPOINTS[epName] = {
            baseURL: epURL,
            model:   epModel || CUSTOM_ENDPOINTS[epName]?.model || epName,
            apiKey:  epKey   || CUSTOM_ENDPOINTS[epName]?.apiKey || 'no-key',
          };
          saveCustomEndpoints({ ...CUSTOM_ENDPOINTS });
          setModel(epName);
          saveModel(epName);
          const ep = CUSTOM_ENDPOINTS[epName];
          pushStatic({ type: 'info', content: `Endpoint "${epName}" saved → ${ep.baseURL}\n  model: ${ep.model}  key: ${epKey ? '(set)' : 'none'}\nSwitched to "${epName}"` });
          return true;
        }

        case 'undo': {
          const restored = undoLastBackup();
          if (restored) {
            pushStatic({ type: 'info', content: `↩ Restored: ${restored}  (${undoStackSize()} more undo${undoStackSize() !== 1 ? 's' : ''} available)` });
          } else {
            pushStatic({ type: 'info', content: 'Nothing to undo.' });
          }
          return true;
        }

        case 'save': {
          if (!arg) {
            pushStatic({ type: 'error', content: 'usage: /save <chatname>' });
            return true;
          }
          const displayMsgs = staticMessages.filter((m) => m.type !== '_banner');
          saveChat(arg, {
            model, mode, tokenCount: tokens.total,
            agentHistory: agentRef.current?.history || [],
            displayMessages: displayMsgs,
          });
          pushStatic({ type: 'info', content: `Chat saved as "${arg}" (${displayMsgs.length} messages).` });
          return true;
        }

        case 'resume': {
          if (!arg) {
            const chats = listChats();
            if (!chats.length) {
              pushStatic({ type: 'info', content: 'No saved chats. Use /save <chatname> to save one.' });
            } else {
              const lines = chats.map((c) => {
                const date = c.savedAt ? new Date(c.savedAt).toLocaleString() : '?';
                return `  ${c.name.padEnd(20)} ${(c.model || '?').padEnd(14)} ${c.messages ?? '?'} msgs  ${date}`;
              }).join('\n');
              pushStatic({ type: 'info', content: `Saved chats:\n${lines}\n\nUse /resume <chatname> to load one.` });
            }
            return true;
          }
          const chat = loadChat(arg);
          if (!chat) {
            pushStatic({ type: 'error', content: `No saved chat named "${arg}". Run /resume to list all.` });
            return true;
          }
          if (agentRef.current) {
            agentRef.current.history = chat.agentHistory || [];
            agentRef.current.totalTokens = chat.tokenCount || 0;
          }
          setModel(chat.model || model);
          setMode(chat.mode || mode);
          setTokens({ total: chat.tokenCount || 0, input: 0, output: chat.tokenCount || 0 });
          const date = chat.savedAt ? new Date(chat.savedAt).toLocaleString() : 'unknown';
          setStaticMessages([
            { type: '_banner', model: chat.model || model, mode: chat.mode || mode },
            { type: 'info', content: `── Resumed "${arg}" (saved ${date}) ──` },
            ...(chat.displayMessages || []),
            { type: 'info', content: `── End of saved chat — continuing from here ──` },
          ]);
          liveRef.current = []; setLiveMessages([]);
          lastUserMsgRef.current = '';
          return true;
        }

        case 'search-chats': {
          if (!arg) {
            pushStatic({ type: 'error', content: 'usage: /search-chats <query>' });
            return true;
          }
          const hits = searchChats(arg);
          if (!hits.length) {
            pushStatic({ type: 'info', content: `No saved chats contain "${arg}".` });
            return true;
          }
          const lines = hits.flatMap(h => {
            const date = h.savedAt ? new Date(h.savedAt).toLocaleString() : '?';
            const header = `  ${h.name.padEnd(20)} ${h.model.padEnd(14)} ${date}`;
            const snippets = h.matches.slice(0, 3).map(m => `    [${m.type}] ${m.snippet}`);
            return [header, ...snippets];
          });
          pushStatic({ type: 'info', content: `${hits.length} chat(s) matching "${arg}":\n\n${lines.join('\n')}\n\nUse /resume <name> to open one.` });
          return true;
        }

        case 'remove-chat': {
          if (!arg) {
            pushStatic({ type: 'error', content: 'usage: /remove-chat <chatname>' });
            return true;
          }
          if (deleteChat(arg)) {
            pushStatic({ type: 'info', content: `Chat "${arg}" deleted.` });
          } else {
            pushStatic({ type: 'error', content: `No saved chat named "${arg}".` });
          }
          return true;
        }

        case 'compact': {
          if (!agentRef.current?.history?.length) {
            pushStatic({ type: 'info', content: 'Nothing to compact yet.' });
            return true;
          }
          pushStatic({ type: 'info', content: 'Compacting history…' });
          setThinking(true);
          setThinkingWord('compressing');
          try {
            const summary = await agentRef.current.compact();
            pushStatic({ type: 'info', content: `✔ Compacted. Summary:\n${summary}` });
          } catch (err) {
            pushStatic({ type: 'error', content: `Compact failed: ${err.message}` });
          } finally {
            setThinking(false);
          }
          return true;
        }

        case 'computer': {
          const turnOn = arg === 'on' || (!arg && !computerUse);
          if (!turnOn) {
            setComputerUse(false);
            pushStatic({ type: 'info', content: 'Computer use off. Screen control tools removed.' });
          } else {
            setComputerUse(true);
            const vm = VISION_MODEL.current || '(none — set one with /vision <model>)';
            pushStatic({ type: 'info', content: `Computer use on. Vision model: ${vm}\n  Tools added: screenshot · click_on · click_at · type_text · press_key · scroll · screen_size\n  ⚠ Clicks and keystrokes go to whatever window is currently focused.\n  Use /vision <model> to change the vision model.` });
          }
          return true;
        }

        case 'vision': {
          if (!arg) {
            pushStatic({ type: 'info', content: `Vision model: ${VISION_MODEL.current || '(none set)'}\n  Usage: /vision <model>  e.g. /vision claude  or /vision gpt` });
            return true;
          }
          VISION_MODEL.current = arg;
          saveVisionModel(arg);
          pushStatic({ type: 'info', content: `Vision model → ${arg} (saved)\n  Use /computer on to enable screen control.` });
          return true;
        }

        case 'ss': {
          if (!VISION_MODEL.current) {
            pushStatic({ type: 'error', content: 'No vision model set. Use /vision <model> first.' });
            return true;
          }
          const ssQuestion = arg || 'Describe what is currently on screen in detail. List all open windows, what is visible, and what the user appears to be doing.';
          setThinking(true);
          setThinkingWord('looking');
          try {
            const { base64, mediaType, width, height } = captureScreen();
            const description = await analyzeScreen({ base64, mediaType, question: ssQuestion, width, height });
            pushStatic({ type: 'assistant', content: description });
          } catch (err) {
            pushStatic({ type: 'error', content: `Screenshot failed: ${err.message}` });
          } finally {
            setThinking(false);
          }
          return true;
        }

        case 'img-gen': {
          if (!arg) {
            pushStatic({ type: 'error', content: 'usage: /img-gen <prompt>   e.g. /img-gen a sunset over a mountain lake' });
            return true;
          }
          setThinking(true);
          setThinkingWord('painting');
          try {
            const { filePath, revisedPrompt, model: imgModel } = await generateImage(arg);
            const display = revisedPrompt !== arg ? `\nRevised prompt: ${revisedPrompt}` : '';
            pushStatic({ type: 'info', content: `◈ Image generated with ${imgModel}${display}\n  Saved to: ${filePath}` });
            // Try to open with default viewer (non-blocking)
            try {
              const { spawn } = await import('child_process');
              if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', filePath], { detached: true, stdio: 'ignore' }).unref();
              else if (process.platform === 'darwin') spawn('open', [filePath], { detached: true, stdio: 'ignore' }).unref();
              else spawn('xdg-open', [filePath], { detached: true, stdio: 'ignore' }).unref();
            } catch {}
          } catch (err) {
            pushStatic({ type: 'error', content: `Image generation failed: ${err.message}` });
          } finally {
            setThinking(false);
          }
          return true;
        }

        case 'img-gen-model': {
          if (!arg) {
            pushStatic({ type: 'info', content: `Image model: ${IMAGE_GEN_MODEL.current}\n  Available: dall-e-3  dall-e-2  gpt-image-1\n  Usage: /img-gen-model <model>` });
            return true;
          }
          IMAGE_GEN_MODEL.current = arg;
          saveImageModel(arg);
          pushStatic({ type: 'info', content: `Image model → ${arg} (saved)` });
          return true;
        }

        case 'macro': {
          const [sub, ...macroArgs] = args;
          const macroName = macroArgs[0];
          switch (sub?.toLowerCase()) {
            case 'record': {
              if (!macroName) {
                pushStatic({ type: 'error', content: 'usage: /macro record <name>' });
                return true;
              }
              MACRO_STATE.recording = true;
              MACRO_STATE.name = macroName;
              MACRO_STATE.steps = [];
              pushStatic({ type: 'info', content: `Recording macro "${macroName}"… do your actions, then /macro stop.  ⚠ Enable /computer on first.` });
              return true;
            }
            case 'stop': {
              if (!MACRO_STATE.recording) {
                pushStatic({ type: 'info', content: 'No macro is being recorded.' });
                return true;
              }
              MACRO_STATE.recording = false;
              const name = MACRO_STATE.name;
              const steps = [...MACRO_STATE.steps];
              MACRO_STATE.name = null;
              MACRO_STATE.steps = [];
              if (!steps.length) {
                pushStatic({ type: 'info', content: 'No steps recorded — macro not saved.' });
                return true;
              }
              saveMacro(name, steps);
              const summary = steps.map((s, i) => `  ${i + 1}. ${s.name}(${JSON.stringify(s.input).slice(0, 60)})`).join('\n');
              pushStatic({ type: 'info', content: `Macro "${name}" saved (${steps.length} step${steps.length !== 1 ? 's' : ''}):\n${summary}` });
              return true;
            }
            case 'play': {
              if (!macroName) {
                pushStatic({ type: 'error', content: 'usage: /macro play <name>' });
                return true;
              }
              const steps = loadMacro(macroName);
              if (!steps) {
                pushStatic({ type: 'error', content: `No macro named "${macroName}". Run /macro list to see all.` });
                return true;
              }
              pushStatic({ type: 'info', content: `Playing macro "${macroName}" (${steps.length} step${steps.length !== 1 ? 's' : ''})…` });
              setThinking(true);
              setThinkingWord('replaying');
              try {
                for (const step of steps) {
                  const result = await executeTool(step.name, step.input);
                  addLive({ type: 'tool', id: `macro-${step.name}`, name: step.name, input: step.input, output: result.output, success: result.success, pending: false });
                  if (!result.success) {
                    pushStatic({ type: 'error', content: `Macro step failed (${step.name}): ${result.output}` });
                    break;
                  }
                  await new Promise((r) => setTimeout(r, 80));
                }
                pushStatic({ type: 'info', content: `Macro "${macroName}" complete.` });
              } catch (err) {
                addLive({ type: 'error', content: `Macro failed: ${err.message}` });
              } finally {
                setThinking(false);
                finalizeTurn();
              }
              return true;
            }
            case 'list': {
              const macros = listMacros();
              if (!macros.length) {
                pushStatic({ type: 'info', content: 'No macros saved. Use /macro record <name> to create one.' });
              } else {
                const lines = macros.map((m) => {
                  const date = m.savedAt ? new Date(m.savedAt).toLocaleString() : '?';
                  return `  ${(m.name || '?').padEnd(20)} ${m.steps ?? '?'} steps  ${date}`;
                }).join('\n');
                pushStatic({ type: 'info', content: `Saved macros:\n${lines}\n\nUse /macro play <name> to replay.` });
              }
              return true;
            }
            case 'delete': {
              if (!macroName) {
                pushStatic({ type: 'error', content: 'usage: /macro delete <name>' });
                return true;
              }
              if (deleteMacro(macroName)) {
                pushStatic({ type: 'info', content: `Macro "${macroName}" deleted.` });
              } else {
                pushStatic({ type: 'error', content: `No macro named "${macroName}".` });
              }
              return true;
            }
            default:
              pushStatic({ type: 'info', content: `Macro commands:\n  /macro record <name>   start recording\n  /macro stop            save recording\n  /macro play <name>     replay a macro\n  /macro list            list saved macros\n  /macro delete <name>   delete a macro${MACRO_STATE.recording ? `\n\n  ⏺ Currently recording: "${MACRO_STATE.name}" (${MACRO_STATE.steps.length} step${MACRO_STATE.steps.length !== 1 ? 's' : ''} so far)` : ''}` });
              return true;
          }
        }

        case 'watch':
        case 'watch-and-learn': {
          const watchSub = arg?.toLowerCase();
          if (watchSub === 'stop' || watchSub === 'off' || (watchActive && !watchSub)) {
            setWatchActive(false);
            const msgs = watchBufferRef.current.slice();
            watchBufferRef.current = [];
            if (!msgs.length) {
              pushStatic({ type: 'info', content: 'Watch stopped. No messages collected.' });
              return true;
            }
            pushStatic({ type: 'info', content: `Analyzing ${msgs.length} message(s) to extract preferences…` });
            setThinking(true);
            setThinkingWord('learning');
            try {
              const summary = await agentRef.current.extractLearnedInstructions(msgs);
              if (summary) {
                appendLearnedInstructions(summary);
                pushStatic({ type: 'info', content: `Preferences saved to ~/.axion/learned.md and will be injected into future prompts:\n\n${summary}` });
              } else {
                pushStatic({ type: 'info', content: 'Could not extract preferences from the collected messages.' });
              }
            } catch (err) {
              pushStatic({ type: 'error', content: `Learning failed: ${err.message}` });
            } finally {
              setThinking(false);
            }
            return true;
          }
          if (watchSub === 'clear') {
            clearLearnedInstructions();
            pushStatic({ type: 'info', content: 'Learned preferences cleared.' });
            return true;
          }
          if (watchSub === 'show') {
            const learned = getLearnedInstructions();
            pushStatic({ type: 'info', content: learned ? `Learned preferences:\n\n${learned}` : 'No learned preferences yet.' });
            return true;
          }
          if (!watchActive) {
            setWatchActive(true);
            watchBufferRef.current = [];
            pushStatic({ type: 'info', content: 'Watch started — your messages will be analyzed for preferences when you run /watch stop.\n  /watch stop    save + apply learned preferences\n  /watch show    view current learned.md\n  /watch clear   delete all learned preferences' });
          } else {
            pushStatic({ type: 'info', content: `Watch is active (${watchBufferRef.current.length} message${watchBufferRef.current.length !== 1 ? 's' : ''} collected). Run /watch stop to analyze.` });
          }
          return true;
        }

        case 'remember': {
          if (!arg) {
            const mems = getMemories();
            if (!mems.length) {
              pushStatic({ type: 'info', content: 'No memories saved. Use /remember <text> to add one.' });
            } else {
              const lines = mems.map((m, i) => `  ${i + 1}. ${m.text}`).join('\n');
              pushStatic({ type: 'info', content: `Persistent notes (${mems.length}):\n${lines}\n\nUse /forget <number> to remove one.` });
            }
          } else {
            const list = addMemory(arg);
            pushStatic({ type: 'info', content: `Remembered: "${arg}"  (${list.length} total — always injected into system prompt)` });
          }
          return true;
        }

        case 'forget': {
          const idx = parseInt(arg, 10) - 1;
          if (isNaN(idx)) {
            pushStatic({ type: 'error', content: 'usage: /forget <number>  (use /remember to see numbered list)' });
            return true;
          }
          const mems = getMemories();
          if (idx < 0 || idx >= mems.length) {
            pushStatic({ type: 'error', content: `No memory #${idx + 1}. Run /remember to see the list.` });
            return true;
          }
          const removed = mems[idx].text;
          removeMemory(idx);
          pushStatic({ type: 'info', content: `Forgotten: "${removed}"` });
          return true;
        }

        case 'models': {
          const built = Object.entries(MODELS)
            .map(([alias, id]) => `  ${alias.padEnd(22)} ${id}`)
            .join('\n');
          const custom = Object.entries(CUSTOM_ENDPOINTS);
          const customStr = custom.length
            ? '\n\nCustom endpoints (use /model <name> to switch):\n' +
              custom.map(([n, e]) => `  ${n.padEnd(22)} ${e.model}  ${e.baseURL}`).join('\n')
            : '\n\nNo custom endpoints yet. Use /endpoint to add one.';
          pushStatic({ type: 'info', content: `Available models:\n${built}${customStr}` });
          return true;
        }

        case 'history': {
          if (!arg) {
            pushStatic({ type: 'error', content: 'usage: /history <query>  e.g. /history webpack' });
            return true;
          }
          const q = arg.toLowerCase();
          const matches = staticMessages.filter(
            (m) => (m.type === 'user' || m.type === 'assistant') &&
                   typeof m.content === 'string' &&
                   m.content.toLowerCase().includes(q)
          );
          if (!matches.length) {
            pushStatic({ type: 'info', content: `No messages found containing "${arg}".` });
          } else {
            const lines = matches.slice(-8).map(
              (m) => `  [${m.type}] ${m.content.trim().slice(0, 120).replace(/\n/g, ' ')}`
            ).join('\n');
            pushStatic({ type: 'info', content: `${matches.length} match(es) for "${arg}":\n${lines}` });
          }
          return true;
        }

        case 'btw': {
          if (!arg) {
            pushStatic({ type: 'error', content: 'usage: /btw <question>' });
            return true;
          }
          pushStatic({ type: 'user', content: `btw: ${arg}` });
          setThinking(true);
          setThinkingWord('checking');
          try {
            const answer = await agentRef.current.askBtw(arg);
            pushStatic({ type: 'btw', content: answer });
          } catch (err) {
            pushStatic({ type: 'error', content: `btw failed: ${err.message}` });
          } finally {
            setThinking(false);
          }
          return true;
        }

        case 'web': {
          const pidFile = join(homedir(), '.axion', 'web-server.pid');

          // /web stop
          if (args[0] === 'stop') {
            if (!existsSync(pidFile)) {
              pushStatic({ type: 'info', content: 'No web server appears to be running.' });
              return true;
            }
            try {
              const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
              process.kill(pid);
              try { unlinkSync(pidFile); } catch {}
              pushStatic({ type: 'info', content: `◈ Web server stopped (PID ${pid}).` });
            } catch (err) {
              // Process already dead — clean up stale file
              try { unlinkSync(pidFile); } catch {}
              pushStatic({ type: 'error', content: `Failed to stop web server: ${err.message}` });
            }
            return true;
          }

          const port = parseInt(args[0], 10) || 3000;
          const serverFile = webServerPath || 'axion-serve';

          if (webServerPath && !existsSync(webServerPath)) {
            pushStatic({ type: 'error', content: `Web server not found at ${webServerPath}.\nTry running: axion-serve` });
            return true;
          }

          try {
            const child = spawn(process.execPath, [serverFile], {
              detached: true,
              stdio:    'ignore',
              env:      { ...process.env, AXION_WEB_PORT: String(port) },
              cwd:      process.cwd(),
            });
            child.unref();

            pushStatic({ type: 'info', content: `◈ Web UI starting at http://localhost:${port}\n  Opening browser…\n  Run axion-serve to start it independently.` });

            // Open browser (non-blocking)
            const url = `http://localhost:${port}`;
            if (process.platform === 'win32') {
              spawn('cmd', ['/c', 'start', url], { detached: true, stdio: 'ignore' }).unref();
            } else if (process.platform === 'darwin') {
              spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
            } else {
              spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
            }
          } catch (err) {
            pushStatic({ type: 'error', content: `Failed to start web server: ${err.message}` });
          }
          return true;
        }

        case 'blender': {
          if (arg === 'connect' || !arg) {
            // Connect the MCP server if not already connected
            const already = MCP.getStatus().find(s => s.name === 'blender');
            if (already?.ready) {
              pushStatic({ type: 'info', content: `Blender MCP already connected (${already.toolCount} tools). Use /mcp tools blender to see them.` });
              return true;
            }
            pushStatic({ type: 'info', content: 'Connecting Blender MCP server…' });
            setThinking(true);
            setThinkingWord('connecting');
            try {
              const srv = await MCP.addServer('blender', { command: 'axion-blender', args: [] });
              if (srv.ready) {
                pushStatic({ type: 'info', content: `✔ Blender MCP connected — ${srv.tools.length} tools available.\n\nMake sure Blender is open with the Axion add-on enabled.\nThen just ask Axion to work in Blender naturally.` });
              } else {
                pushStatic({ type: 'error', content: `Blender MCP server failed: ${srv.error}\n\nMake sure the package is installed globally: npm install -g .` });
              }
            } catch (err) {
              pushStatic({ type: 'error', content: `Connection failed: ${err.message}` });
            } finally {
              setThinking(false);
            }
            return true;
          }

          if (arg === 'setup') {
            // Find path to the add-on file
            const { fileURLToPath: f } = await import('url');
            const { dirname: d, join: j } = await import('path');
            const here    = d(f(import.meta.url));
            const addonPath = j(here, '../mcp-servers/blender/axion_blender.py');
            const exists  = existsSync(addonPath);
            pushStatic({ type: 'info', content: `Blender add-on setup:\n\n1. Open Blender\n2. Edit → Preferences → Add-ons → Install…\n3. Select this file:\n   ${exists ? addonPath : '(run: npm install -g . first, then axion-blender path)'}\n4. Enable the add-on (check the box)\n5. Run /blender connect in Axion\n\nThe add-on starts an HTTP server on port 8765 inside Blender.\nAxion's MCP server bridges between Axion and that port.` });
            return true;
          }

          pushStatic({ type: 'info', content: `Blender MCP commands:\n  /blender setup    — show add-on install instructions\n  /blender connect  — connect the MCP server to Axion` });
          return true;
        }

        case 'mcp': {
          const [sub, ...mcpRest] = args;

          if (!sub || sub === 'status') {
            const status = MCP.getStatus();
            if (!status.length) {
              pushStatic({ type: 'info', content: 'No MCP servers configured.\n\nUsage:\n  /mcp browse               — browse marketplace\n  /mcp install <id>         — install from marketplace\n  /mcp add <name> <cmd>     — add custom server\n\nConfig file: ~/.axion/mcp.json' });
              return true;
            }
            const lines = status.map(s => {
              const badge = s.disabled
                ? '⏸ disabled'
                : s.ready
                  ? `✔ ${s.toolCount} tool${s.toolCount !== 1 ? 's' : ''}`
                  : `✗ ${s.error || 'not ready'}`;
              return `  ${s.name.padEnd(20)} ${badge}\n    ${s.command}`;
            });
            pushStatic({ type: 'info', content: `MCP servers (${status.length}):\n\n${lines.join('\n\n')}\n\n/mcp enable <name> · /mcp disable <name> · /mcp tools [name] · /mcp reload` });
            return true;
          }

          if (sub === 'tools') {
            const filterName = mcpRest[0];
            const status = MCP.getStatus().filter(s => !filterName || s.name === filterName);
            if (!status.length) {
              pushStatic({ type: 'info', content: filterName ? `No MCP server named "${filterName}".` : 'No MCP servers connected.' });
              return true;
            }
            const lines = status.flatMap(s => [
              `  ${s.name} (${s.ready ? s.toolCount + ' tools' : 'not ready'}):`,
              ...(s.ready ? s.tools.map(t => `    mcp__${s.name}__${t}`) : [`    ${s.error}`]),
            ]);
            pushStatic({ type: 'info', content: `MCP tools:\n${lines.join('\n')}` });
            return true;
          }

          if (sub === 'add') {
            // /mcp add <name> <command> [args...]
            const [name, command, ...cmdArgs] = mcpRest;
            if (!name || !command) {
              pushStatic({ type: 'error', content: 'usage: /mcp add <name> <command> [args...]\n  e.g. /mcp add github npx -y @modelcontextprotocol/server-github' });
              return true;
            }
            pushStatic({ type: 'info', content: `Starting MCP server "${name}"…` });
            setThinking(true);
            setThinkingWord('connecting');
            try {
              const srv = await MCP.addServer(name, { command, args: cmdArgs });
              if (srv.ready) {
                pushStatic({ type: 'info', content: `✔ MCP server "${name}" connected — ${srv.tools.length} tool${srv.tools.length !== 1 ? 's' : ''} available` });
              } else {
                pushStatic({ type: 'error', content: `MCP server "${name}" failed to start: ${srv.error}` });
              }
            } catch (err) {
              pushStatic({ type: 'error', content: `MCP add failed: ${err.message}` });
            } finally {
              setThinking(false);
            }
            return true;
          }

          if (sub === 'remove') {
            const name = mcpRest[0];
            if (!name) {
              pushStatic({ type: 'error', content: 'usage: /mcp remove <name>' });
              return true;
            }
            const removed = MCP.removeServer(name);
            pushStatic({ type: 'info', content: removed ? `MCP server "${name}" removed.` : `No server named "${name}".` });
            return true;
          }

          if (sub === 'reload') {
            pushStatic({ type: 'info', content: 'Reloading MCP servers…' });
            setThinking(true);
            setThinkingWord('reconnecting');
            try {
              await MCP.reload();
              const status = MCP.getStatus();
              const ok  = status.filter(s => s.ready).length;
              const bad = status.filter(s => !s.ready).length;
              pushStatic({ type: 'info', content: `✔ MCP reload complete — ${ok} connected${bad ? `, ${bad} failed` : ''}` });
            } catch (err) {
              pushStatic({ type: 'error', content: `MCP reload failed: ${err.message}` });
            } finally {
              setThinking(false);
            }
            return true;
          }

          if (sub === 'disable') {
            const name = mcpRest[0];
            if (!name) {
              pushStatic({ type: 'error', content: 'usage: /mcp disable <name>' });
              return true;
            }
            const ok = MCP.disableServer(name);
            pushStatic({ type: 'info', content: ok ? `⏸ "${name}" disabled — config kept. Use /mcp enable ${name} to restart.` : `No server named "${name}".` });
            return true;
          }

          if (sub === 'toggle') {
            const name = mcpRest[0];
            if (!name) { pushStatic({ type: 'error', content: 'usage: /mcp toggle <name>' }); return true; }
            const status = MCP.getStatus().find(s => s.name === name);
            if (!status) { pushStatic({ type: 'error', content: `No server named "${name}". Use /mcp browse to see available.` }); return true; }
            if (status.disabled) {
              // Enable it
              pushStatic({ type: 'info', content: `Starting "${name}"…` });
              setThinking(true); setThinkingWord('connecting');
              try {
                const srv = await MCP.enableServer(name);
                if (srv?.ready) pushStatic({ type: 'info', content: `✔ "${name}" enabled — ${srv.tools.length} tool${srv.tools.length !== 1 ? 's' : ''} available` });
                else pushStatic({ type: 'error', content: `"${name}" failed to start: ${srv?.error}` });
              } catch (err) { pushStatic({ type: 'error', content: `Enable failed: ${err.message}` }); }
              finally { setThinking(false); }
            } else {
              MCP.disableServer(name);
              pushStatic({ type: 'info', content: `⏸ "${name}" disabled. Use /mcp toggle ${name} to re-enable.` });
            }
            return true;
          }

          if (sub === 'enable') {
            const name = mcpRest[0];
            if (!name) {
              pushStatic({ type: 'error', content: 'usage: /mcp enable <name>' });
              return true;
            }
            pushStatic({ type: 'info', content: `Starting "${name}"…` });
            setThinking(true);
            setThinkingWord('connecting');
            try {
              const srv = await MCP.enableServer(name);
              if (!srv) {
                pushStatic({ type: 'error', content: `No saved config for "${name}". Use /mcp add or /mcp install first.` });
              } else if (srv.ready) {
                pushStatic({ type: 'info', content: `✔ "${name}" enabled — ${srv.tools.length} tool${srv.tools.length !== 1 ? 's' : ''} available` });
              } else {
                pushStatic({ type: 'error', content: `"${name}" failed to start: ${srv.error}` });
              }
            } catch (err) {
              pushStatic({ type: 'error', content: `Enable failed: ${err.message}` });
            } finally {
              setThinking(false);
            }
            return true;
          }

          if (sub === 'browse' || sub === 'marketplace') {
            const byCategory = {};
            for (const entry of MCP_MARKETPLACE) {
              if (!byCategory[entry.category]) byCategory[entry.category] = [];
              byCategory[entry.category].push(entry);
            }
            const installed = new Set(MCP.getStatus().map(s => s.name));
            const lines = [];
            for (const [cat, entries] of Object.entries(byCategory)) {
              lines.push(`\n  ${CATEGORIES[cat] || cat}`);
              for (const e of entries) {
                const badge = installed.has(e.id) ? ' ✔' : '';
                lines.push(`    ${e.id.padEnd(22)} ${e.description}${badge}`);
              }
            }
            pushStatic({ type: 'info', content: `MCP Marketplace — ${MCP_MARKETPLACE.length} servers available\n${lines.join('\n')}\n\n  /mcp install <id>          install by ID above\n  /mcp search <query>        filter by keyword\n  /mcp search database` });
            return true;
          }

          if (sub === 'search') {
            const query = mcpRest.join(' ');
            const results = searchMarketplace(query);
            if (!results.length) {
              pushStatic({ type: 'info', content: `No MCP servers found for "${query}". Try /mcp browse to see all.` });
              return true;
            }
            const installed = new Set(MCP.getStatus().map(s => s.name));
            const lines = results.map(e => {
              const badge = installed.has(e.id) ? ' ✔' : '';
              return `  ${e.id.padEnd(22)} ${e.description}${badge}`;
            });
            pushStatic({ type: 'info', content: `Search results for "${query}" (${results.length}):\n\n${lines.join('\n')}\n\n  /mcp install <id>` });
            return true;
          }

          if (sub === 'install') {
            const id = mcpRest[0];
            const extraArgs = mcpRest.slice(1); // optional positional params (db path, connection string, etc.)
            if (!id) {
              pushStatic({ type: 'error', content: 'usage: /mcp install <id>\n\nRun /mcp browse to see available servers.' });
              return true;
            }
            const entry = getMarketplaceEntry(id);
            if (!entry) {
              pushStatic({ type: 'error', content: `No marketplace entry for "${id}".\n\nRun /mcp browse to see available IDs, or use /mcp add for a custom server.` });
              return true;
            }
            // Resolve args — replace $DB_PATH / $DATABASE_URL placeholders with positional extras
            let resolvedArgs = entry.args.map((a, i) => {
              if (a.startsWith('$') && extraArgs.length) return extraArgs.shift() || a;
              return a;
            });
            pushStatic({ type: 'info', content: `Installing ${entry.name} MCP server…\n  command: ${entry.command} ${resolvedArgs.join(' ')}${entry.envNote ? '\n\n  Note: ' + entry.envNote : ''}` });
            setThinking(true);
            setThinkingWord('installing');
            try {
              const srv = await MCP.addServer(id, { command: entry.command, args: resolvedArgs });
              if (srv.ready) {
                pushStatic({ type: 'info', content: `✔ ${entry.name} installed — ${srv.tools.length} tool${srv.tools.length !== 1 ? 's' : ''} available\n\nYou can now ask Axion to use ${entry.name} naturally.` });
              } else {
                pushStatic({ type: 'error', content: `${entry.name} failed to start: ${srv.error}\n\nThis usually means the package download failed or Node.js isn't in your PATH.` });
              }
            } catch (err) {
              pushStatic({ type: 'error', content: `Install failed: ${err.message}` });
            } finally {
              setThinking(false);
            }
            return true;
          }

          pushStatic({ type: 'info', content: `MCP commands:\n  /mcp                      show server status\n  /mcp browse               browse marketplace\n  /mcp search <query>       search marketplace\n  /mcp install <id>         install from marketplace\n  /mcp add <n> <cmd> [args] connect a custom server (saved)\n  /mcp enable <name>        enable a disabled server\n  /mcp disable <name>       pause a server (keeps config)\n  /mcp remove <name>        disconnect + delete config\n  /mcp tools [name]         list available tools\n  /mcp reload               restart all servers\n\nExample:\n  /mcp install github\n  /mcp disable github\n  /mcp enable github` });
          return true;
        }

        case 'oauth': {
          const [sub, svc] = args;

          if (!sub || sub === 'list') {
            const connected = listOAuthTokens();
            if (!connected.length) {
              pushStatic({ type: 'info', content: 'No services connected.\n\nUsage:\n  /oauth connect github\n  /oauth connect google\n  /oauth connect notion\n  /oauth connect slack' });
              return true;
            }
            const lines = connected.map(t => `  ✔ ${t.service.padEnd(10)} connected ${new Date(t.connectedAt).toLocaleDateString()}`);
            pushStatic({ type: 'info', content: `Connected services (${connected.length}):\n\n${lines.join('\n')}` });
            return true;
          }

          if (sub === 'revoke') {
            if (!svc) { pushStatic({ type: 'error', content: 'usage: /oauth revoke <service>' }); return true; }
            const ok = revokeOAuthToken(svc);
            pushStatic(ok
              ? { type: 'info',  content: `✔ Disconnected ${svc}` }
              : { type: 'error', content: `No connection found for "${svc}"` });
            return true;
          }

          if (sub === 'connect') {
            if (!svc) {
              pushStatic({ type: 'info', content: 'Available services: github · google · notion · slack\n\nUsage: /oauth connect <service>' });
              return true;
            }
            const cfg = OAUTH_PROVIDERS[svc];
            if (!cfg) {
              pushStatic({ type: 'error', content: `Unknown service "${svc}". Available: ${Object.keys(OAUTH_PROVIDERS).join(', ')}` });
              return true;
            }

            if (cfg.tokenFlow === 'paste') {
              // Prompt user to paste token interactively
              pushStatic({ type: 'info', content: `${cfg.label} — ${cfg.hint}\n\nPaste your token below:` });
              setInputMode('oauth-paste');
              return new Promise((resolve) => {
                const orig = handleSlashCommand;
                const unsub = () => { setInputMode('chat'); resolve(true); };
                // handled via special inputMode in handleSubmit
                window.__oauthPasteResolve = async (token) => {
                  unsub();
                  try {
                    setThinking(true); setThinkingWord('connecting');
                    await connectOAuth(svc, { pastedToken: token });
                    pushStatic({ type: 'info', content: `✔ ${cfg.label} connected!` });
                    if (cfg.mcpCommand) {
                      pushStatic({ type: 'info', content: `Adding MCP server "${cfg.mcpServer}"…` });
                      await MCP.addServer(svc, { command: cfg.mcpCommand, args: cfg.mcpArgs, env: cfg.mcpEnv(token) });
                      pushStatic({ type: 'info', content: `✔ MCP server "${svc}" connected` });
                    }
                  } catch (err) {
                    pushStatic({ type: 'error', content: `Failed: ${err.message}` });
                  } finally {
                    setThinking(false);
                  }
                };
              });
            }

            // Device flow
            setThinking(true); setThinkingWord('connecting');
            try {
              let token;
              await connectOAuth(svc, {
                onStatus: (info) => {
                  setThinking(false);
                  if (info.authUrl) {
                    pushStatic({ type: 'info', content: `${cfg.label} authorization\n\nYour browser should open automatically.\nIf not, visit:\n  ${info.authUrl}\n\nWaiting for you to approve…` });
                  } else {
                    pushStatic({ type: 'info', content: `${cfg.label} authorization\n\n  1. Open:  ${info.verification_uri}\n  2. Enter code:  ${info.user_code}\n\nWaiting for you to approve…` });
                  }
                  setThinking(true); setThinkingWord('waiting');
                },
                onToken: (t) => { token = t; },
              });
              pushStatic({ type: 'info', content: `✔ ${cfg.label} connected!` });
              if (cfg.mcpCommand) {
                pushStatic({ type: 'info', content: `Adding MCP server "${cfg.mcpServer}"…` });
                try {
                  await MCP.addServer(svc, { command: cfg.mcpCommand, args: cfg.mcpArgs, env: cfg.mcpEnv(token) });
                  pushStatic({ type: 'info', content: `✔ MCP server "${svc}" ready` });
                } catch (mcpErr) {
                  pushStatic({ type: 'error', content: `Connected but MCP setup failed: ${mcpErr.message}\nRun /mcp add ${svc} manually.` });
                }
              }
            } catch (err) {
              pushStatic({ type: 'error', content: `OAuth failed: ${err.message}` });
            } finally {
              setThinking(false);
            }
            return true;
          }

          pushStatic({ type: 'info', content: `OAuth commands:\n  /oauth connect <service>   connect a service\n  /oauth list                show connected services\n  /oauth revoke <service>    disconnect\n\nServices: github · google · notion · slack` });
          return true;
        }

        case 'schedule': {
          const [sub, ...schRest] = args;

          // /schedule  — list all
          if (!sub || sub === 'list') {
            const list = getSchedules();
            if (!list.length) {
              pushStatic({ type: 'info', content: 'No scheduled tasks.\n\nUsage:\n  /schedule add <name> "<schedule>" <prompt>\n\nSchedule formats:\n  every 30m · every 2h · daily 09:00 · weekly mon 09:00' });
              return true;
            }
            const lines = list.map(t => {
              const status = t.enabled ? '✔' : '✗';
              const last   = t.lastRun ? `last ran ${new Date(t.lastRun).toLocaleString()}` : 'never run';
              return `  ${status} ${t.name.padEnd(18)} ${t.schedule.padEnd(18)} ${last}`;
            });
            pushStatic({ type: 'info', content: `Scheduled tasks (${list.length}):\n\n${lines.join('\n')}` });
            return true;
          }

          // /schedule add <name> "<schedule>" <prompt…>
          if (sub === 'add') {
            const [name, scheduleExpr, ...promptParts] = schRest;
            if (!name || !scheduleExpr || !promptParts.length) {
              pushStatic({ type: 'error', content: 'usage: /schedule add <name> "<schedule>" <prompt>\n  e.g. /schedule add daily-standup "daily 09:00" Summarize what I should work on today' });
              return true;
            }
            if (!parseSchedule(scheduleExpr)) {
              pushStatic({ type: 'error', content: `invalid schedule "${scheduleExpr}"\n\nValid formats: every 30m · every 2h · daily 09:00 · weekly mon 09:00` });
              return true;
            }
            const list = getSchedules();
            if (list.find(t => t.name === name)) {
              pushStatic({ type: 'error', content: `a schedule named "${name}" already exists — remove it first with /schedule remove ${name}` });
              return true;
            }
            const task = {
              id:        crypto.randomUUID?.() || `${Date.now()}`,
              name,
              schedule:  scheduleExpr,
              prompt:    promptParts.join(' '),
              model:     model,
              enabled:   true,
              lastRun:   null,
              createdAt: new Date().toISOString(),
            };
            list.push(task);
            saveSchedules(list);
            pushStatic({ type: 'info', content: `✔ Schedule "${name}" added — runs ${scheduleExpr}\n\nPrompt: ${task.prompt}\n\nResults saved to ~/.axion/schedule-results/\nRun now with: /schedule run ${name}` });
            return true;
          }

          // /schedule remove <name>
          if (sub === 'remove' || sub === 'delete') {
            const name = schRest[0];
            if (!name) { pushStatic({ type: 'error', content: 'usage: /schedule remove <name>' }); return true; }
            const list    = getSchedules();
            const updated = list.filter(t => t.name !== name);
            if (updated.length === list.length) {
              pushStatic({ type: 'error', content: `no schedule named "${name}"` });
              return true;
            }
            saveSchedules(updated);
            pushStatic({ type: 'info', content: `✔ Schedule "${name}" removed` });
            return true;
          }

          // /schedule enable|disable <name>
          if (sub === 'enable' || sub === 'disable') {
            const name = schRest[0];
            if (!name) { pushStatic({ type: 'error', content: `usage: /schedule ${sub} <name>` }); return true; }
            const list = getSchedules();
            const task = list.find(t => t.name === name);
            if (!task) { pushStatic({ type: 'error', content: `no schedule named "${name}"` }); return true; }
            task.enabled = sub === 'enable';
            saveSchedules(list);
            pushStatic({ type: 'info', content: `✔ Schedule "${name}" ${sub}d` });
            return true;
          }

          // /schedule run <name>
          if (sub === 'run') {
            const name = schRest[0];
            if (!name) { pushStatic({ type: 'error', content: 'usage: /schedule run <name>' }); return true; }
            const list = getSchedules();
            const task = list.find(t => t.name === name);
            if (!task) { pushStatic({ type: 'error', content: `no schedule named "${name}"` }); return true; }
            pushStatic({ type: 'info', content: `Running "${name}"…` });
            setThinking(true);
            setThinkingWord('scheduling');
            try {
              const agent = agentRef.current || new (await import('../agent/agent.js')).Agent({ model, mode });
              let result = '';
              await agent.run(task.prompt, { onText: t => { result += t; } });
              const header = `# ${task.name}\n*Ran: ${new Date().toLocaleString()}*\n*Schedule: ${task.schedule}*\n\n---\n\n`;
              const saved  = saveScheduleResult(task.name, header + result);
              task.lastRun = new Date().toISOString();
              saveSchedules(list);
              pushStatic({ type: 'info', content: `✔ "${name}" complete — saved to:\n  ${saved}` });
            } catch (err) {
              pushStatic({ type: 'error', content: `Failed to run "${name}": ${err.message}` });
            } finally {
              setThinking(false);
            }
            return true;
          }

          // /schedule results [name]
          if (sub === 'results') {
            const name    = schRest[0] || null;
            const results = getScheduleResults(name);
            if (!results.length) {
              pushStatic({ type: 'info', content: name ? `No results for "${name}"` : 'No schedule results yet' });
              return true;
            }
            const lines = results.slice(0, 10).map(r => `  ${r.name}`);
            pushStatic({ type: 'info', content: `Schedule results${name ? ` for "${name}"` : ''}:\n\n${lines.join('\n')}\n\nFiles at ~/.axion/schedule-results/` });
            return true;
          }

          pushStatic({ type: 'info', content: `Schedule commands:\n  /schedule                          list all\n  /schedule add <n> "<expr>" <prompt> add a new task\n  /schedule run <name>               run now\n  /schedule remove <name>            delete\n  /schedule enable/disable <name>    toggle\n  /schedule results [name]           show result files\n\nSchedule formats:\n  every 30m · every 2h · daily 09:00 · weekly mon 09:00` });
          return true;
        }

        default:
          pushStatic({ type: 'error', content: `unknown command /${cmd} — type /help` });
          return true;
      }
    },
    [model, mode, exit, pushStatic, addLive, finalizeTurn, runAgent,
     goal, extThinking, thinkingBudget, systemOverride, staticMessages, liveMessages, tokens, computerUse, watchActive,
     includedFiles]
  );

  // ── Submit ─────────────────────────────────────────────────────────────────

  const handleSubmit = useCallback(
    async (input) => {
      if (thinking) {
        if (input.startsWith('/')) {
          handleSlashCommand(input);
        } else {
          pushStatic({ type: 'info', content: `Axion is still ${thinkingWord}… try /btw for a quick side question.` });
        }
        return;
      }

      if (input.startsWith('/')) {
        handleSlashCommand(input);
        return;
      }

      // OAuth paste mode — token input
      if (inputMode === 'oauth-paste') {
        setInputMode('chat');
        window.__oauthPasteResolve?.(input);
        window.__oauthPasteResolve = null;
        return;
      }

      if (watchActive) watchBufferRef.current.push(input);

      lastUserMsgRef.current = input;
      pushStatic({ type: 'user', content: input });
      liveRef.current = []; setLiveMessages([]);
      setThinking(true);
      setThinkingWord(pickThinkingWord());

      const preIn  = agentRef.current?.inputTokens  || 0;
      const preOut = agentRef.current?.outputTokens || 0;
      try {
        await runAgent(input);
      } catch (err) {
        addLive({ type: 'error', content: err.message });
      } finally {
        const di   = (agentRef.current?.inputTokens  || 0) - preIn;
        const dout = (agentRef.current?.outputTokens || 0) - preOut;
        const turnCost = estimateCost(model, di, dout);
        if (turnCost) setSessionCost(c => c + turnCost);
        setThinking(false);
        setInputMode('chat');
        setPendingConfirm(null);
        confirmResolverRef.current = null;
        finalizeTurn();
      }
    },
    [thinking, thinkingWord, handleSlashCommand, addLive, pushStatic, finalizeTurn, runAgent, watchActive]
  );

  const handleConfirmAnswer = useCallback((answer) => {
    confirmResolverRef.current?.(answer);
    confirmResolverRef.current = null;
    setInputMode('chat');
    setPendingConfirm(null);
  }, []);

  const handleCycleMode = useCallback(() => {
    const idx  = CYCLE_MODES.indexOf(mode);
    const next = CYCLE_MODES[(idx + 1) % CYCLE_MODES.length];
    setMode(next);
    saveMode(next);
    agentRef.current?.setMode(next);
    pushStatic({ type: 'info', content: `mode → ${modeLabel(next)}` });
  }, [mode, pushStatic]);

  const modeColor   = MODE_COLORS[mode] || 'cyan';
  const tabComplete = getTabCompletion(inputValue);
  const tokStr      = formatTokens(tokens.total);
  const sessionCostStr = sessionCost > 0 ? formatCost(sessionCost) : null;
  const ctxWindow   = getContextWindow(model);
  const gauge       = tokens.total > 0 ? contextGauge(tokens.total, ctxWindow) : null;

  const hintLeft  = '? for help  · /goal to set a target  · /retry to redo  · Ctrl+P to cycle mode';
  const hintRight = [
    extThinking  ? `◎ thinking(${(thinkingBudget / 1000).toFixed(0)}k)` : null,
    computerUse  ? `⊞ computer` : null,
    watchActive  ? `👁 watching` : null,
    MACRO_STATE.recording ? `⏺ rec:${MACRO_STATE.name}` : null,
    goal         ? `⟳ goal: iter ${goalIteration}` : null,
    includedFiles.length  ? `📎 ${includedFiles.length} pinned` : null,
    MCP.totalTools > 0    ? `⬡ ${MCP.totalTools} mcp` : null,
  ].filter(Boolean).join('  ') || '';

  return (
    <Box flexDirection="column">
      {/* ── Finalized history ───────────────────────────────────────── */}
      <Static items={staticMessages}>
        {(msg, i) =>
          msg.type === '_banner'
            ? <WelcomeBanner key={i} model={msg.model} mode={msg.mode} />
            : <MessageRow key={i} msg={msg} />
        }
      </Static>

      {/* ── Live in-progress turn ───────────────────────────────────── */}
      <Box flexDirection="column">
        {liveMessages.map((msg, i) => (
          <MessageRow key={i} msg={msg} expanded={diffsExpanded} thinkingExpanded={thinkingExpanded} />
        ))}
        {/* Streaming text — shown separately so it renders incrementally */}
        {streamContent !== null && (
          <MessageRow
            msg={{ type: 'assistant', content: streamContent, streaming: true }}
            expanded={diffsExpanded}
            thinkingExpanded={thinkingExpanded}
          />
        )}
      </Box>

      {/* ── Status bar ─────────────────────────────────────────────── */}
      <Box marginX={1} marginTop={1} justifyContent="space-between">
        <Text>
          <Text color="gray" dimColor>── </Text>
          <Text color="blueBright" bold>Axion</Text>
          <Text color="gray" dimColor>  {CWD}  </Text>
          <Text color="cyan">{model}</Text>
          <Text color="gray" dimColor>  </Text>
          <Text color={modeColor} bold>{modeLabel(mode)}</Text>
          {tokStr && <Text color="gray" dimColor>  {tokStr} tok</Text>}
          {gauge  && <Text color={gauge.color} dimColor>  {gauge.bar} {Math.round(gauge.pct * 100)}%</Text>}
          {sessionCostStr && <Text color="gray" dimColor>  session {sessionCostStr}</Text>}
        </Text>
        {hintRight ? <Text color="gray" dimColor>{hintRight}</Text> : null}
      </Box>

      {/* ── Thinking label (spinner + word on same line) ────────────── */}
      {thinking && (
        <Box marginX={2} gap={1}>
          <Text color="greenBright"><Spinner type="dots" /></Text>
          <Text color="greenBright">{thinkingWord}…</Text>
        </Box>
      )}

      {/* ── Confirm prompts ─────────────────────────────────────────── */}
      {inputMode === 'confirm-tool' && pendingConfirm && (
        <Box marginX={2} marginTop={0} gap={1}>
          <Text color="yellow">?</Text>
          <Text color="white">run</Text>
          <Text color="cyan" bold>{pendingConfirm.name}</Text>
          {pendingConfirm.label ? <Text color="gray">{pendingConfirm.label}</Text> : null}
          <Text color="gray" dimColor>(y/n)</Text>
          <YesNoPrompt onAnswer={handleConfirmAnswer} />
        </Box>
      )}
      {inputMode === 'confirm-plan' && (
        <Box marginX={2} marginTop={0} gap={1}>
          <Text color="yellow">?</Text>
          <Text color="white">execute this plan?</Text>
          <Text color="gray" dimColor>(y/n)</Text>
          <YesNoPrompt onAnswer={handleConfirmAnswer} />
        </Box>
      )}

      {/* ── Command autocomplete ─────────────────────────────────────── */}
      {!thinking && inputMode === 'chat' && (
        <SuggestionBox inputValue={inputValue} />
      )}

      {/* ── Hint bar ────────────────────────────────────────────────── */}
      <Box marginX={2} justifyContent="space-between">
        <Text color="gray" dimColor>{hintLeft}</Text>
        {systemOverride && <Text color="gray" dimColor>sys: on</Text>}
      </Box>

      {/* ── Input ───────────────────────────────────────────────────── */}
      <InputBox
        onSubmit={handleSubmit}
        disabled={inputMode !== 'chat' && inputMode !== 'oauth-paste'}
        placeholder={inputMode === 'oauth-paste' ? 'Paste your token here and press Enter…' : goal ? `goal active (iter ${goalIteration}) — send message or /goal to cancel` : 'ask Axion something…  or type / for commands'}
        onChange={setInputValue}
        tabCompletion={tabComplete}
        onToggleExpand={() => setDiffsExpanded(v => !v)}
        onToggleThinking={() => setThinkingExpanded(v => !v)}
        onCycleMode={handleCycleMode}
      />
    </Box>
  );
}

function confirmLabel(name, input) {
  if (!input) return '';
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'patch_file':   return input.path || '';
    case 'delete_file':  return input.path || '';
    case 'move_file':    return `${input.from} → ${input.to}`;
    case 'list_directory': return input.path || '.';
    case 'run_command':  return `\`${(input.command || '').slice(0, 60)}\``;
    case 'git_commit':   return `"${(input.message || '').slice(0, 50)}"`;
    case 'web_search':   return `"${(input.query || '').slice(0, 60)}"`;
    case 'fetch_url':    return input.url || '';
    case 'screenshot':   return `"${(input.question || '').slice(0, 60)}"`;
    case 'click_on':     return `"${(input.target || '').slice(0, 60)}"`;
    case 'click_at':     return `(${input.x}, ${input.y})`;
    case 'type_text':    return `"${(input.text || '').slice(0, 40)}"`;
    case 'press_key':    return input.keys || '';
    case 'scroll':       return `(${input.x}, ${input.y}) ${input.direction || 'down'}`;
    case 'find_text':    return `"${(input.text || '').slice(0, 60)}"${input.click ? ' + click' : ''}`;
    default: return '';
  }
}
