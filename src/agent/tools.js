import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, unlinkSync, renameSync, mkdirSync, appendFileSync, cpSync, rmSync } from 'fs';
import { execSync, execFileSync, spawn } from 'child_process';
import { relative, resolve, dirname, basename, extname } from 'path';
import { diffLines } from '../utils/diff.js';
import { backupFile, recordFileChange } from '../persist.js';
import { API_KEYS } from '../config.js';
import { BUS } from './bus.js';
import { captureScreen, captureScreenAnnotated, uiaClickElement, mouseClick, typeText, pressKey, scrollAt, getScreenSize, ocrFindText, cropScreenRegion, MACRO_STATE } from './computer.js';
import { analyzeScreen, parseCoordinates } from './vision.js';
import { executeGoogleTool, GOOGLE_TOOL_DEFINITIONS, GOOGLE_TOOL_DEFINITIONS_OPENAI } from './google.js';
import { getOAuthToken } from '../oauth/oauth.js';

// Background tasks started via run_command background=true
const BG_TASKS = new Map();
let _bgCounter = 0;
process.on('exit', () => {
  for (const t of BG_TASKS.values()) {
    if (t.exitCode === null) { try { t.proc.kill('SIGTERM'); } catch {} }
  }
});

import { join } from 'path';

// Working directory is per-agent (keyed by agentLabel — each tab's top-level
// agent gets its own label, see App.jsx), not a single process-wide value.
// Previously this was one shared module-level `let cwd`, so change_working_dir
// in one tab silently affected every other tab's file/git tools, and the UI
// (Welcome banner, sidebar) had no way to read it since it lived only here.
const CWD_BY_LABEL = new Map();
export function getCwd(agentLabel = 'main') { return CWD_BY_LABEL.get(agentLabel) || process.cwd(); }
export function setCwd(agentLabel, dir) { if (agentLabel) CWD_BY_LABEL.set(agentLabel, dir); }

// ── Tool definitions ──────────────────────────────────────────────────────────

export const TOOL_DEFINITIONS = [
  {
    name: 'read_file',
    description: 'Read the contents of a file.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'write_file',
    description: 'Write content to a file (creates if new, overwrites if exists). Prefer patch_file for targeted edits.',
    input_schema: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Full file content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'patch_file',
    description: 'Make a targeted edit to a file by replacing an exact string. Much safer than write_file for small changes — only the changed section is rewritten.',
    input_schema: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'File path' },
        find:    { type: 'string', description: 'Exact string to find (must match precisely including whitespace)' },
        replace: { type: 'string', description: 'String to replace it with' },
        all:     { type: 'boolean', description: 'Replace all occurrences (default: first only)' },
      },
      required: ['path', 'find', 'replace'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file. A backup is kept and can be restored with /undo.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'move_file',
    description: 'Move or rename a file.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source path' },
        to:   { type: 'string', description: 'Destination path' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'copy_file',
    description: 'Copy a file or directory (recursively) to a new location.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source path' },
        to:   { type: 'string', description: 'Destination path' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'append_file',
    description: 'Append text to the end of a file (creates the file if it does not exist). Use for logs or incremental writes instead of rewriting the whole file.',
    input_schema: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Text to append' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'file_info',
    description: 'Get metadata about a file or directory: type, size in bytes, last-modified time, and line count for text files.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'read_file_lines',
    description: 'Read a specific range of lines from a file (1-indexed, inclusive). Useful for large files where you only need part. Output is line-numbered.',
    input_schema: {
      type: 'object',
      properties: {
        path:  { type: 'string', description: 'File path' },
        start: { type: 'number', description: 'First line (1-indexed)' },
        end:   { type: 'number', description: 'Last line, inclusive (default: end of file)' },
      },
      required: ['path', 'start'],
    },
  },
  {
    name: 'read_many_files',
    description: 'Read several files in one call. Returns each file\'s contents with a header. More efficient than multiple read_file calls.',
    input_schema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'List of file paths to read' },
      },
      required: ['paths'],
    },
  },
  {
    name: 'replace_in_files',
    description: 'Find-and-replace an exact string across all files matching a glob pattern. Project-wide refactor in one call. Each changed file is backed up (restorable with /undo).',
    input_schema: {
      type: 'object',
      properties: {
        find:    { type: 'string', description: 'Exact string to find' },
        replace: { type: 'string', description: 'Replacement string' },
        pattern: { type: 'string', description: 'Glob of files to search (e.g. "src/**/*.js"). Default: all files.' },
      },
      required: ['find', 'replace'],
    },
  },
  {
    name: 'tree',
    description: 'Show a directory tree (skips node_modules, .git, dist, etc.). Good for understanding project structure at a glance.',
    input_schema: {
      type: 'object',
      properties: {
        path:  { type: 'string', description: 'Root directory (default: cwd)' },
        depth: { type: 'number', description: 'Max depth to descend (default: 3)' },
      },
      required: [],
    },
  },
  {
    name: 'create_directory',
    description: 'Create a directory (and any missing parent directories).',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path to create' } },
      required: ['path'],
    },
  },
  {
    name: 'change_working_dir',
    description: 'Change the current working directory for subsequent file and command operations. Persists across tool calls.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory to switch to (relative or absolute)' } },
      required: ['path'],
    },
  },
  {
    name: 'get_working_dir',
    description: 'Return the current working directory.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_directory',
    description: 'List files and folders in a directory.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path (default: cwd)' } },
      required: [],
    },
  },
  {
    name: 'find_files',
    description: 'Search for files matching a glob pattern (e.g. "**/*.ts", "src/**/*.jsx", "*.json"). Skips node_modules and .git.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match file paths' },
        path:    { type: 'string', description: 'Root directory to search from (default: cwd)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep_files',
    description: 'Search file contents for a pattern. Returns matching lines with file path and line number. Skips node_modules, .git, and binary files.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex or string to search for' },
        path:    { type: 'string', description: 'Directory to search in (default: cwd)' },
        include: { type: 'string', description: 'Glob pattern to filter which files to search (e.g. "*.ts")' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'fetch_url',
    description: 'Fetch a URL and return its text content. HTML is stripped to plain text. Good for reading docs, APIs, and raw files.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to fetch' } },
      required: ['url'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command and return stdout/stderr. Set background=true for long-running or interactive commands — returns a task id immediately. Use check_task to read output and send_input to write to stdin (for programs that prompt for input).',
    input_schema: {
      type: 'object',
      properties: {
        command:    { type: 'string' },
        background: { type: 'boolean', description: 'Run in background and return a task id immediately. Required for interactive programs.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'check_task',
    description: 'Check output of a background task started with run_command background=true. No id lists all tasks. Set kill=true to stop one.',
    input_schema: {
      type: 'object',
      properties: {
        id:   { type: 'string', description: 'Task id; omit to list all' },
        kill: { type: 'boolean', description: 'Stop the task' },
      },
      required: [],
    },
  },
  {
    name: 'send_input',
    description: 'Send text to stdin of a running background task. Use this to interact with programs that prompt for input — REPLs, interactive CLIs, games, anything that reads from stdin. Always start the program with run_command background=true first, then use check_task to see what it printed, then send_input to respond.',
    input_schema: {
      type: 'object',
      properties: {
        id:   { type: 'string', description: 'Background task id from run_command' },
        text: { type: 'string', description: 'Text to send. Include \\n for Enter (e.g. "42\\n"). Can send multiple lines at once.' },
        end:  { type: 'boolean', description: 'Close stdin after writing (sends EOF). Use when the program reads until end-of-input.' },
      },
      required: ['id', 'text'],
    },
  },
  {
    name: 'schedule_followup',
    description: 'Schedule a one-time reminder after a delay, instead of blocking or polling in a loop. When it fires, it pings the desktop and posts your note into the conversation as a notice for the user to act on — it does NOT automatically resume you. Good for "remind the user to check if the build finished in 2 minutes" type follow-ups that aren\'t tied to a background task (those already notify on completion — see run_command background=true).',
    input_schema: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'Delay in seconds before the follow-up fires (minimum 5).' },
        note:    { type: 'string', description: 'What to check on or remind yourself about when this fires.' },
      },
      required: ['seconds', 'note'],
    },
  },
  {
    name: 'git_status',
    description: 'Run git status.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'git_diff',
    description: 'Run git diff to see unstaged changes.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'git_log',
    description: 'Show recent git commit history.',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Number of commits to show (default: 10)' } },
      required: [],
    },
  },
  {
    name: 'git_commit',
    description: 'Stage all changes and commit.',
    input_schema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
  },
  {
    name: 'git_push',
    description: 'Push commits to origin.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'web_search',
    description: 'Search the web using DuckDuckGo.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'wait',
    description: 'Pause execution for N seconds. Use when waiting for a build, server startup, or file system operation to settle.',
    input_schema: {
      type: 'object',
      properties: { seconds: { type: 'number', description: 'Seconds to wait (max 300)' } },
      required: ['seconds'],
    },
  },
  {
    name: 'list_tools',
    description: 'List all available tools with their descriptions. Call this if you are unsure what tools you have access to.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'send_message',
    description: 'Send a message to a DIFFERENT agent in a multi-agent session. Only use this when spawn_agents has created other agents and you need to communicate with them. NEVER send a message to yourself or to "main" when you are already the main agent — that is self-messaging and serves no purpose. For thinking/reasoning, use <think> tags instead.',
    input_schema: {
      type: 'object',
      properties: {
        to:      { type: 'string', description: 'Label of the target agent (must be a different agent, not yourself)' },
        content: { type: 'string', description: 'Message content' },
      },
      required: ['to', 'content'],
    },
  },
  {
    name: 'read_messages',
    description: 'Check your inbox for messages from other agents. Returns any messages that have already arrived, then clears the inbox. If you need to wait for a message that hasn\'t arrived yet, use wait_for_message instead.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'wait_for_message',
    description: 'Block and wait until a message arrives in your inbox, then return it. Use this when you need to coordinate with another agent — e.g. agent-1 does work, sends a result to agent-2, and agent-2 calls wait_for_message to receive it before continuing.',
    input_schema: {
      type: 'object',
      properties: {
        timeout_seconds: { type: 'number', description: 'Max seconds to wait before giving up (default 60, max 300)' },
      },
      required: [],
    },
  },
  {
    name: 'spawn_agents',
    description: 'Spin up multiple AI agents running in parallel. Each agent has full tool access. Agents can communicate: sender calls send_message(label, content), receiver calls wait_for_message() to block until a message arrives. Give each agent an explicit label.',
    input_schema: {
      type: 'object',
      properties: {
        agents: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              model: { type: 'string', description: 'Model alias (default: current model)' },
              task:  { type: 'string', description: 'Full task for this agent — be specific, it has no conversation context' },
              label: { type: 'string', description: 'Short label for this agent in output' },
            },
            required: ['task'],
          },
        },
      },
      required: ['agents'],
    },
  },
  {
    name: 'end_conversation',
    description: 'Immediately end the conversation and clear session history. Use this ONLY for: (1) racial slurs or slurs targeting any group (e.g. the N-word, homophobic slurs), (2) requests to build malware, exploits, hacking tools, or attack infrastructure. Do NOT use it for general profanity, rudeness, dark humour, or security questions framed educationally. Before calling this tool, output one sentence explaining why you are ending the session.',
    input_schema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'One-sentence internal reason (logged, not shown to user).',
        },
      },
      required: ['reason'],
    },
  },
  {
    name: 'ask_question',
    description: 'Ask the user a free-form question and wait for their text response. Use this when you need clarification, preferences, or any additional information from the user.',
    input_schema: {
      type: 'object',
      properties: {
        question:   { type: 'string', description: 'The question to ask the user.' },
        placeholder: { type: 'string', description: 'Optional placeholder text shown inside the input.' },
      },
      required: ['question'],
    },
  },
  {
    name: 'ask_multiple_choice',
    description: 'Ask the user a multiple-choice question and wait for their selection. Use this when the user should pick from a predefined list of options.',
    input_schema: {
      type: 'object',
      properties: {
        question:    { type: 'string', description: 'The question to ask the user.' },
        options:     { type: 'array', items: { type: 'string' }, description: 'List of choices the user can pick from.' },
        allow_custom: { type: 'boolean', description: 'Whether to allow a custom answer not in the list (default: false).' },
      },
      required: ['question', 'options'],
    },
  },
  {
    name: 'ask_confirm',
    description: 'Ask the user a yes/no question and wait for their response. Use this when you need explicit user approval before proceeding.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The yes/no question to ask the user.' },
      },
      required: ['question'],
    },
  },
  {
    name: 'ask_questions',
    description: 'Ask the user several questions at once in a single interactive menu. Each question can be single-choice, multi-select (select all that apply), or free text, and may allow a custom typed answer. Prefer this over multiple separate ask_* calls when you need more than one piece of input.',
    input_schema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'The questions to ask, presented in order.',
          items: {
            type: 'object',
            properties: {
              question:     { type: 'string', description: 'The question text.' },
              type:         { type: 'string', enum: ['choice', 'multi', 'text'], description: "'choice' = pick one; 'multi' = select all that apply; 'text' = free-form. Defaults to 'choice' when options are given, else 'text'." },
              options:      { type: 'array', items: { type: 'string' }, description: 'Choices for choice/multi questions.' },
              allow_custom: { type: 'boolean', description: 'Also offer a custom typed answer in addition to the options.' },
            },
            required: ['question'],
          },
        },
      },
      required: ['questions'],
    },
  },
  {
    name: 'todo_add',
    description: 'Add a task to the TODO list. Use this to track work items, next steps, or things to remember for later.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The task description.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'todo_done',
    description: 'Mark a TODO item as complete by its id.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The TODO item id (from todo_list or todo_add result).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'todo_list',
    description: 'List all TODO items. Shows pending tasks first, then completed ones.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'speak',
    description: 'Speak text aloud using text-to-speech (OpenAI TTS). Use this to communicate information audibly to the user, such as alerts, confirmations, or when reading long text would be helpful.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to speak aloud.' },
        voice: { type: 'string', enum: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'], description: 'Voice to use (default: alloy).' },
      },
      required: ['text'],
    },
  },
];

export const TOOL_DEFINITIONS_OPENAI = TOOL_DEFINITIONS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

// ── Computer use tool definitions (added when /computer on) ──────────────────

export const COMPUTER_TOOL_DEFINITIONS = [
  {
    name: 'screenshot',
    description: 'Take a screenshot of the current screen and describe what you see using the vision model. Returns a text description — the image itself is never stored in context.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'What to look for or describe. E.g. "What windows are open?" or "Describe the current state of the screen."' },
      },
      required: ['question'],
    },
  },
  {
    name: 'click_on',
    description: 'Take a screenshot, locate the described UI element using the vision model, then click on it. More robust than click_at when exact coordinates are unknown.',
    input_schema: {
      type: 'object',
      properties: {
        target:  { type: 'string', description: 'Plain-text description of the element to click, e.g. "the Submit button" or "the search bar near the top".' },
        button:  { type: 'string', enum: ['left', 'right'], description: 'Mouse button (default: left).' },
      },
      required: ['target'],
    },
  },
  {
    name: 'click_at',
    description: 'Click at specific pixel coordinates on screen. Use this when you already know the coordinates from a previous screenshot.',
    input_schema: {
      type: 'object',
      properties: {
        x:      { type: 'number', description: 'X coordinate in pixels from the left edge.' },
        y:      { type: 'number', description: 'Y coordinate in pixels from the top edge.' },
        button: { type: 'string', enum: ['left', 'right'], description: 'Mouse button (default: left).' },
        times:  { type: 'number', description: 'Number of times to click (default: 1). Use 2 for double-click.' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'type_text',
    description: 'Type text into the currently focused element. Text is pasted via clipboard to avoid encoding issues.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'press_key',
    description: 'Press a keyboard key or shortcut. Uses Windows SendKeys format: ^c=Ctrl+C, %{F4}=Alt+F4, {ENTER}, {TAB}, {ESC}, {BACKSPACE}, +{TAB}=Shift+Tab, ^a=Ctrl+A.',
    input_schema: {
      type: 'object',
      properties: {
        keys: { type: 'string', description: 'Key(s) to press in SendKeys format.' },
      },
      required: ['keys'],
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the mouse wheel at a screen position.',
    input_schema: {
      type: 'object',
      properties: {
        x:         { type: 'number', description: 'X coordinate to scroll at.' },
        y:         { type: 'number', description: 'Y coordinate to scroll at.' },
        direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction (default: down).' },
        amount:    { type: 'number', description: 'Number of scroll ticks (default: 3).' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'screen_size',
    description: 'Get the current primary screen dimensions in pixels. Useful for calculating relative positions.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'find_text',
    description: 'Locate text on screen via OCR and return its pixel coordinates. Uses Windows OCR on Windows, Tesseract on macOS/Linux. More reliable than vision-based click_on for clearly visible text labels, buttons, or menu items.',
    input_schema: {
      type: 'object',
      properties: {
        text:  { type: 'string', description: 'The text to search for on screen (case-insensitive partial match).' },
        click: { type: 'boolean', description: 'If true, also click on the found text (default: false).' },
      },
      required: ['text'],
    },
  },
];

export const COMPUTER_TOOL_DEFINITIONS_OPENAI = COMPUTER_TOOL_DEFINITIONS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

// ── Execution ─────────────────────────────────────────────────────────────────

const MACRO_RECORDABLE = new Set(['click_on', 'click_at', 'type_text', 'press_key', 'scroll', 'find_text']);

export async function executeTool(name, input, { agentLabel = 'main', onNotify = () => {}, askUser = null, todoScope = 'global' } = {}) {
  // Log to active macro recording before executing
  if (MACRO_STATE.recording && MACRO_RECORDABLE.has(name)) {
    MACRO_STATE.steps.push({ name, input: { ...input } });
  }

  let cwd = getCwd(agentLabel);
  const relPath = (p) => relative(cwd, resolve(cwd, p)) || '.';

  // Silently run formatter after a file write if project config is detected.
  const tryAutoFormat = (absPath) => {
    const ext = extname(absPath).toLowerCase();
    try {
      const hasPrettier = ['.prettierrc', '.prettierrc.json', '.prettierrc.js',
                           'prettier.config.js', 'prettier.config.mjs', 'prettier.config.cjs']
                          .some(f => existsSync(join(cwd, f)));
      if (hasPrettier && ['.js','.jsx','.ts','.tsx','.json','.css','.html','.md','.yaml','.yml'].includes(ext)) {
        execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['prettier', '--write', absPath], { cwd, stdio: 'pipe', timeout: 15000 });
        return ' (auto-formatted)';
      }
      if (ext === '.go') {
        execFileSync('gofmt', ['-w', absPath], { cwd, stdio: 'pipe', timeout: 5000 });
        return ' (gofmt)';
      }
      if (ext === '.py') {
        const hasPyConf = existsSync(join(cwd, 'pyproject.toml')) || existsSync(join(cwd, '.black'));
        if (hasPyConf) {
          execFileSync('python', ['-m', 'black', absPath, '-q'], { cwd, stdio: 'pipe', timeout: 15000 });
          return ' (black)';
        }
      }
    } catch {} // formatter not installed or failed — silent skip
    return '';
  };

  try {
    switch (name) {

      case 'read_file': {
        const content = readFileSync(resolve(cwd, input.path), 'utf8');
        return { success: true, output: content };
      }

      case 'write_file': {
        const absPath = resolve(cwd, input.path);
        let oldContent = '';
        try { oldContent = readFileSync(absPath, 'utf8'); } catch {}
        if (oldContent) backupFile(absPath, oldContent);
        recordFileChange(absPath, existsSync(absPath) ? oldContent : null);
        const destDir = dirname(absPath);
        if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
        writeFileSync(absPath, input.content, 'utf8');
        const fmt  = tryAutoFormat(absPath);
        const diff = diffLines(oldContent, existsSync(absPath) ? readFileSync(absPath, 'utf8') : input.content);
        return { success: true, output: `Written ${relPath(input.path)}${fmt}`, diff };
      }

      case 'patch_file': {
        const absPath = resolve(cwd, input.path);
        const oldContent = readFileSync(absPath, 'utf8');
        const count = (oldContent.split(input.find).length - 1);
        if (count === 0) return { success: false, output: `String not found in ${relPath(input.path)}` };
        backupFile(absPath, oldContent);
        recordFileChange(absPath, oldContent);
        // Use a function replacer to prevent JS from interpreting $& $1 $` $' etc. in the replacement string
        const newContent = input.all
          ? oldContent.split(input.find).join(input.replace)
          : oldContent.replace(input.find, () => input.replace);
        writeFileSync(absPath, newContent, 'utf8');
        const fmt  = tryAutoFormat(absPath);
        const diff = diffLines(oldContent, newContent);
        return { success: true, output: `Patched ${relPath(input.path)} (${count} match${count > 1 ? 'es' : ''})${fmt}`, diff };
      }

      case 'delete_file': {
        const absPath = resolve(cwd, input.path);
        if (!existsSync(absPath)) return { success: false, output: `File not found: ${relPath(input.path)}` };
        const content = readFileSync(absPath, 'utf8');
        backupFile(absPath, content);
        recordFileChange(absPath, content);
        unlinkSync(absPath);
        return { success: true, output: `Deleted ${relPath(input.path)} (backup kept — use /undo to restore)` };
      }

      case 'move_file': {
        const src = resolve(cwd, input.from);
        const dst = resolve(cwd, input.to);
        if (!existsSync(src)) return { success: false, output: `Source not found: ${relPath(input.from)}` };
        const destDir = dirname(dst);
        if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
        try { renameSync(src, dst); }
        catch (e) {
          if (e.code !== 'EXDEV') throw e;
          cpSync(src, dst, { recursive: true });
          rmSync(src, { recursive: true, force: true });
        }
        return { success: true, output: `Moved ${relPath(input.from)} → ${relPath(input.to)}` };
      }

      case 'read_many_files': {
        const paths = Array.isArray(input.paths) ? input.paths : [];
        if (!paths.length) return { success: false, output: 'No paths provided.' };
        const parts = [];
        for (const p of paths) {
          try {
            const content = readFileSync(resolve(cwd, p), 'utf8');
            parts.push(`── ${relPath(p)} ──\n${content}`);
          } catch (e) {
            parts.push(`── ${relPath(p)} ──\n[error: ${e.code === 'ENOENT' ? 'not found' : e.message}]`);
          }
        }
        return { success: true, output: parts.join('\n\n') };
      }

      case 'replace_in_files': {
        if (!input.find) return { success: false, output: 'find string is required.' };
        const pattern = input.pattern || '**/*';
        const matches = walkGlob(cwd, pattern);
        if (!matches.length) return { success: false, output: `No files match pattern: ${pattern}` };
        const changed = [];
        let totalHits = 0;
        for (const rel of matches) {
          const absPath = resolve(cwd, rel);
          let content;
          try { content = readFileSync(absPath, 'utf8'); } catch { continue; }
          const count = content.split(input.find).length - 1;
          if (count === 0) continue;
          backupFile(absPath, content);
          recordFileChange(absPath, content);
          writeFileSync(absPath, content.split(input.find).join(input.replace), 'utf8');
          changed.push(`${rel} (${count})`);
          totalHits += count;
        }
        if (!changed.length) return { success: true, output: `No occurrences of the string found in ${matches.length} file(s).` };
        return { success: true, output: `Replaced ${totalHits} occurrence(s) across ${changed.length} file(s):\n${changed.join('\n')}` };
      }

      case 'tree': {
        const root = input.path ? resolve(cwd, input.path) : cwd;
        if (!existsSync(root)) return { success: false, output: `Not found: ${relPath(input.path || '.')}` };
        const maxDepth = input.depth != null ? Math.max(1, Math.floor(input.depth)) : 3;
        const out = [];
        let count = 0;
        const walk = (dir, prefix, depth) => {
          if (depth > maxDepth || count > 800) return;
          let entries;
          try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
          entries = entries.filter(e => !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
            .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
          entries.forEach((e, i) => {
            if (count > 800) return;
            const last = i === entries.length - 1;
            out.push(`${prefix}${last ? '└─ ' : '├─ '}${e.name}${e.isDirectory() ? '/' : ''}`);
            count++;
            if (e.isDirectory()) walk(resolve(dir, e.name), prefix + (last ? '   ' : '│  '), depth + 1);
          });
        };
        out.push(`${relPath(input.path || '.')}/`);
        walk(root, '', 1);
        const truncated = count > 800 ? '\n… (truncated at 800 entries)' : '';
        return { success: true, output: out.join('\n') + truncated };
      }

      case 'create_directory': {
        const absPath = resolve(cwd, input.path);
        mkdirSync(absPath, { recursive: true });
        return { success: true, output: `Created ${relPath(input.path)}` };
      }

      case 'copy_file': {
        const src = resolve(cwd, input.from);
        const dst = resolve(cwd, input.to);
        if (!existsSync(src)) return { success: false, output: `Source not found: ${relPath(input.from)}` };
        const destDir = dirname(dst);
        if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
        cpSync(src, dst, { recursive: true });
        return { success: true, output: `Copied ${relPath(input.from)} → ${relPath(input.to)}` };
      }

      case 'append_file': {
        const absPath = resolve(cwd, input.path);
        const existed = existsSync(absPath);
        let oldContent = '';
        if (existed) { oldContent = readFileSync(absPath, 'utf8'); backupFile(absPath, oldContent); }
        recordFileChange(absPath, existed ? oldContent : null);
        const destDir = dirname(absPath);
        if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
        appendFileSync(absPath, input.content, 'utf8');
        return { success: true, output: `Appended ${input.content.length} chars to ${relPath(input.path)}${existed ? '' : ' (new file)'}` };
      }

      case 'file_info': {
        const absPath = resolve(cwd, input.path);
        if (!existsSync(absPath)) return { success: false, output: `Not found: ${relPath(input.path)}` };
        const st = statSync(absPath);
        const lines = [
          `path: ${relPath(input.path)}`,
          `type: ${st.isDirectory() ? 'directory' : 'file'}`,
          `size: ${st.size} bytes`,
          `modified: ${st.mtime.toISOString()}`,
        ];
        if (st.isFile() && st.size < 5_000_000) {
          try { lines.push(`lines: ${readFileSync(absPath, 'utf8').split('\n').length}`); } catch {}
        }
        return { success: true, output: lines.join('\n') };
      }

      case 'read_file_lines': {
        const absPath = resolve(cwd, input.path);
        if (!existsSync(absPath)) return { success: false, output: `Not found: ${relPath(input.path)}` };
        const all = readFileSync(absPath, 'utf8').split('\n');
        const start = Math.max(1, Math.floor(input.start) || 1);
        const end = input.end ? Math.min(all.length, Math.floor(input.end)) : all.length;
        if (start > all.length) return { success: false, output: `start ${start} is past end of file (${all.length} lines)` };
        const numbered = all.slice(start - 1, end).map((l, i) => `${start + i}\t${l}`).join('\n');
        return { success: true, output: numbered || '(no lines in range)' };
      }

      case 'ask_question': {
        if (!askUser) return { success: false, output: 'User interaction is not available in this context.' };
        const qAns = await askUser({ type: 'question', question: input.question, placeholder: input.placeholder });
        return { success: true, output: qAns };
      }
      case 'ask_multiple_choice': {
        if (!askUser) return { success: false, output: 'User interaction is not available in this context.' };
        const mcAns = await askUser({ type: 'multiple_choice', question: input.question, options: input.options, allow_custom: input.allow_custom });
        return { success: true, output: mcAns };
      }
      case 'ask_confirm': {
        if (!askUser) return { success: false, output: 'User interaction is not available in this context.' };
        const cAns = await askUser({ type: 'confirm', question: input.question });
        return { success: true, output: cAns ? 'yes' : 'no' };
      }
      case 'ask_questions': {
        if (!askUser) return { success: false, output: 'User interaction is not available in this context.' };
        const fAns = await askUser({ type: 'form', questions: input.questions || [] });
        return { success: true, output: fAns };
      }

      case 'speak': {
        const { speakText } = await import('./voice.js');
        try {
          await speakText(input.text, { voice: input.voice || 'alloy' });
          return { success: true, output: `Spoken: "${input.text}"` };
        } catch (err) {
          return { success: false, output: `TTS failed: ${err.message}` };
        }
      }

      case 'todo_add': {
        const { addTodo } = await import('../persist.js');
        const result = addTodo(input.text, { source: 'agent', scope: todoScope });
        const pending = result.list.filter(t => !t.done).length;
        return { success: true, output: `✔ Added: "${input.text}"  (${pending} pending, ${result.list.length} total)` };
      }

      case 'todo_done': {
        const { toggleTodo, getTodos } = await import('../persist.js');
        const toggled = toggleTodo(input.id, todoScope);
        if (!toggled) {
          const all = getTodos(todoScope);
          const fuzzy = all.find(t => t.text.toLowerCase().includes((input.id || '').toLowerCase()));
          if (fuzzy) { const r = toggleTodo(fuzzy.id, todoScope); return { success: true, output: `✔ Completed: "${r.text}" (matched by text, not id)` }; }
          return { success: false, output: `No TODO found with id "${input.id}". Use todo_list to see ids.` };
        }
        return { success: true, output: toggled.done ? `✔ Completed: "${toggled.text}"` : `↩ Reopened: "${toggled.text}"` };
      }

      case 'todo_list': {
        const { getTodos } = await import('../persist.js');
        const all = getTodos(todoScope);
        if (!all.length) return { success: true, output: 'TODO list is empty.' };
        const pending = all.filter(t => !t.done);
        const done = all.filter(t => t.done);
        const lines = [];
        if (pending.length) {
          lines.push(`── Pending (${pending.length}) ──`);
          pending.forEach(t => lines.push(`  ☐ ${t.text}  [${t.id}]`));
        }
        if (done.length) {
          lines.push(`── Completed (${done.length}) ──`);
          done.slice(-5).forEach(t => lines.push(`  ☑ ${t.text}`));
          if (done.length > 5) lines.push(`  … and ${done.length - 5} more`);
        }
        return { success: true, output: lines.join('\n') };
      }

      case 'change_working_dir': {
        const target = resolve(cwd, input.path);
        if (!existsSync(target)) return { success: false, output: `No such directory: ${relPath(input.path)}` };
        if (!statSync(target).isDirectory()) return { success: false, output: `Not a directory: ${relPath(input.path)}` };
        cwd = target;
        setCwd(agentLabel, cwd);
        return { success: true, output: `Working directory → ${cwd}` };
      }

      case 'get_working_dir': {
        return { success: true, output: cwd };
      }

      case 'list_directory': {
        const dir = input.path ? resolve(cwd, input.path) : cwd;
        const entries = readdirSync(dir, { withFileTypes: true });
        const annotated = entries.map((e) => e.isDirectory() ? `${e.name}/` : e.name);
        return { success: true, output: annotated.join('\n') };
      }

      case 'find_files': {
        const root = input.path ? resolve(cwd, input.path) : cwd;
        const matches = walkGlob(root, input.pattern);
        if (!matches.length) return { success: true, output: 'No files found.' };
        return { success: true, output: matches.slice(0, 200).join('\n') + (matches.length > 200 ? `\n… (${matches.length - 200} more)` : '') };
      }

      case 'grep_files': {
        const root = input.path ? resolve(cwd, input.path) : cwd;
        let re;
        try { re = new RegExp(input.pattern, 'i'); } catch { re = new RegExp(escapeRegex(input.pattern), 'i'); }
        const hits = grepWalk(root, re, input.include || null);
        if (!hits.length) return { success: true, output: 'No matches found.' };
        return { success: true, output: hits.slice(0, 100).join('\n') + (hits.length > 100 ? `\n… (${hits.length - 100} more matches)` : '') };
      }

      case 'fetch_url': {
        // Block cloud instance-metadata endpoints (SSRF → credential theft).
        // Localhost/private ranges stay reachable — fetching your own dev
        // server is a core coding-agent use case.
        try {
          const host = new URL(input.url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
          if (host.startsWith('169.254.') || host === 'metadata.google.internal'
              || host === '100.100.100.200' || host === 'fd00:ec2::254') {
            return { success: false, output: `Blocked: ${host} is a cloud instance-metadata endpoint.` };
          }
        } catch { return { success: false, output: `Invalid URL: ${input.url}` }; }
        const res = await fetch(input.url, {
          headers: { 'User-Agent': 'Axion-CLI/1.0' },
          signal: AbortSignal.timeout(15000),
        });
        let text = await res.text();
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('html')) {
          text = text
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/\s{2,}/g, ' ').trim();
        }
        if (text.length > 10000) text = text.slice(0, 10000) + '\n… (truncated)';
        return { success: true, output: `[${res.status}] ${input.url}\n\n${text}` };
      }

      case 'run_command': {
        // Intercept bare `cd <path>` (no shell operators) so cwd persists across calls.
        // Compound commands like `cd /tmp && ls` are left for the shell to handle.
        const cdMatch = input.command.trim().match(/^cd\s+((?:[^\s;&|`()\n]|\\.)+)\s*$/);
        if (cdMatch) {
          const target = resolve(cwd, cdMatch[1].trim());
          if (!existsSync(target)) return { success: false, output: `cd: no such directory: ${target}` };
          cwd = target;
          setCwd(agentLabel, cwd);
          return { success: true, output: `(cwd → ${cwd})` };
        }
        if (input.background) {
          const id = `task-${++_bgCounter}`;
          const proc = spawn(input.command, { cwd, shell: true, detached: false });
          const task = { id, command: input.command, proc, output: '', exitCode: null, startedAt: Date.now() };
          const append = (chunk) => {
            task.output = (task.output + chunk.toString()).slice(-20000); // keep last 20k chars
          };
          proc.stdout.on('data', append);
          proc.stderr.on('data', append);
          proc.on('close', (code) => {
            task.exitCode = code;
            BUS.send('bgtask', agentLabel, {
              title: code === 0 ? '✔ Axion background task done' : '✖ Axion background task failed',
              text: `[Background task ${id} finished, exit code ${code}] \`${input.command}\`\n${task.output.slice(-2000) || '(no output)'}`,
            });
          });
          proc.on('error', (err) => { task.output += `\n[spawn error] ${err.message}`; task.exitCode = -1; });
          BG_TASKS.set(id, task);
          return { success: true, output: `Started background task ${id}: \`${input.command}\`\nUse check_task with id "${id}" to read output.` };
        }
        try {
          const result = execSync(input.command, { cwd, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
          return { success: true, output: result || '(no output)' };
        } catch (err) {
          // execSync throws on non-zero exit — expose the actual stdout/stderr so the agent sees the failure reason
          const combined = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
          return { success: false, output: combined || err.message };
        }
      }

      case 'check_task': {
        if (!input.id) {
          if (!BG_TASKS.size) return { success: true, output: 'No background tasks.' };
          const lines = [...BG_TASKS.values()].map(t => {
            const status = t.exitCode === null ? 'running' : `exited (${t.exitCode})`;
            const age = Math.round((Date.now() - t.startedAt) / 1000);
            return `${t.id}  [${status}, ${age}s]  ${t.command.slice(0, 60)}`;
          });
          return { success: true, output: lines.join('\n') };
        }
        const task = BG_TASKS.get(input.id);
        if (!task) return { success: false, output: `No such task: ${input.id}` };
        if (input.kill && task.exitCode === null) {
          try { task.proc.kill('SIGTERM'); } catch {}
          return { success: true, output: `Sent SIGTERM to ${input.id}.` };
        }
        const status = task.exitCode === null ? 'running' : `exited with code ${task.exitCode}`;
        if (task.exitCode !== null) BG_TASKS.delete(input.id); // final read cleans up
        return { success: true, output: `${task.id} (${status})\n── output (last 20k chars) ──\n${task.output || '(no output yet)'}` };
      }

      case 'send_input': {
        const task = BG_TASKS.get(input.id);
        if (!task) return { success: false, output: `No such task: ${input.id}` };
        if (task.exitCode !== null) return { success: false, output: `Task ${input.id} has already exited (code ${task.exitCode}).` };
        if (!task.proc.stdin || task.proc.stdin.destroyed) return { success: false, output: `Task ${input.id} stdin is closed or unavailable.` };
        task.proc.stdin.write(input.text);
        if (input.end) task.proc.stdin.end();
        // Brief wait so output from the program has time to arrive
        await new Promise(r => setTimeout(r, 250));
        const st = task.exitCode === null ? 'running' : `exited (${task.exitCode})`;
        return { success: true, output: `Input sent. [${st}]\n── output ──\n${task.output || '(no output yet)'}` };
      }

      case 'schedule_followup': {
        const secs = Math.max(5, Number(input.seconds) || 60);
        const note = String(input.note || '').slice(0, 500);
        setTimeout(() => {
          BUS.send('scheduler', agentLabel, { title: '⏰ Axion follow-up', text: `[Scheduled follow-up] ${note}` });
        }, secs * 1000);
        return { success: true, output: `Follow-up scheduled in ${secs}s: "${note}"` };
      }

      case 'git_status': {
        return { success: true, output: execSync('git status', { cwd, encoding: 'utf8' }) };
      }

      case 'git_diff': {
        const out = execSync('git diff', { cwd, encoding: 'utf8' });
        return { success: true, output: out || '(no changes)' };
      }

      case 'git_log': {
        const n = Math.min(input.limit || 10, 50);
        const out = execSync(`git log --oneline -${n}`, { cwd, encoding: 'utf8' });
        return { success: true, output: out || '(no commits)' };
      }

      case 'git_commit': {
        execSync('git add -A', { cwd, encoding: 'utf8' });
        const out = execFileSync('git', ['commit', '-m', input.message], { cwd, encoding: 'utf8' });
        return { success: true, output: out };
      }

      case 'git_push': {
        const out = execSync('git push origin', { cwd, encoding: 'utf8' });
        return { success: true, output: out || 'Pushed successfully.' };
      }

      case 'web_search': {
        if (API_KEYS.tavily) {
          // Tavily — purpose-built for AI agents, returns clean content
          const res = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              api_key: API_KEYS.tavily,
              query: input.query,
              search_depth: 'basic',
              max_results: 6,
              include_answer: true,
            }),
            signal: AbortSignal.timeout(15000),
          });
          const data = await res.json();
          if (!res.ok) return { success: false, output: data.detail || 'Tavily search failed.' };
          const lines = [];
          if (data.answer) lines.push(`Answer: ${data.answer}\n`);
          (data.results || []).forEach((r, i) => {
            lines.push(`[${i + 1}] ${r.title}`);
            lines.push(`    ${r.url}`);
            if (r.content) lines.push(`    ${r.content.slice(0, 300).replace(/\n/g, ' ')}`);
          });
          return { success: true, output: lines.length ? lines.join('\n') : 'No results.' };
        }

        // Fallback: DuckDuckGo Instant Answers (no key, limited)
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(input.query)}&format=json&no_redirect=1&no_html=1`;
        const res = await fetch(url);
        const data = await res.json();
        const results = [];
        if (data.AbstractText) results.push(`Summary: ${data.AbstractText}`);
        if (data.RelatedTopics) {
          data.RelatedTopics.slice(0, 6).forEach((t) => { if (t.Text) results.push(`- ${t.Text}`); });
        }
        const hint = '\n\nTip: set a Tavily key with `/api tavily <key>` for real search results (tavily.com is free).';
        return { success: true, output: (results.length ? results.join('\n') : 'No results found.') + hint };
      }

      case 'wait': {
        const secs = Math.min(Math.max(input.seconds || 1, 1), 300);
        await new Promise((r) => setTimeout(r, secs * 1000));
        return { success: true, output: `Waited ${secs}s.` };
      }

      case 'list_tools': {
        const list = TOOL_DEFINITIONS.map((t) => `• ${t.name} — ${t.description}`).join('\n');
        return { success: true, output: `Available tools:\n${list}` };
      }

      case 'send_message': {
        BUS.send(agentLabel, input.to, input.content);
        onNotify({ type: 'agent-msg', from: agentLabel, to: input.to, content: input.content });
        return { success: true, output: `Message sent to "${input.to}".` };
      }

      case 'read_messages': {
        const msgs = BUS.read(agentLabel);
        if (!msgs.length) return { success: true, output: 'No messages.' };
        for (const m of msgs) {
          onNotify({ type: 'agent-msg', from: m.from, to: agentLabel, content: m.content });
        }
        const text = msgs.map((m) => `[${m.at}] from ${m.from}: ${m.content}`).join('\n');
        return { success: true, output: text };
      }

      case 'wait_for_message': {
        const timeoutMs = Math.min((input.timeout_seconds || 60) * 1000, 300_000);
        const POLL_MS   = 300;
        const deadline  = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const msgs = BUS.read(agentLabel);
          if (msgs.length) {
            for (const m of msgs) {
              onNotify({ type: 'agent-msg', from: m.from, to: agentLabel, content: m.content });
            }
            const text = msgs.map((m) => `[${m.at}] from ${m.from}: ${m.content}`).join('\n');
            return { success: true, output: text };
          }
          await new Promise((r) => setTimeout(r, POLL_MS));
        }
        return { success: false, output: `No message received within ${input.timeout_seconds || 60}s.` };
      }

      // ── Computer use ──────────────────────────────────────────────────────────

      case 'screenshot': {
        const { base64, mediaType, width, height } = captureScreen();
        const description = await analyzeScreen({ base64, mediaType, question: input.question, width, height });
        return { success: true, output: description };
      }

      case 'click_on': {
        // Strategy 1: UIAutomation — programmatic invoke (no mouse, no Z-order issues).
        const uia = uiaClickElement(input.target);
        if (uia?.invoked) {
          return { success: true, output: `Activated "${uia.name || input.target}" via UIAutomation (no mouse click needed).` };
        }
        if (uia && !uia.invoked) {
          mouseClick(uia.x, uia.y, input.button || 'left');
          return { success: true, output: `Clicked ${input.button || 'left'} on "${uia.name || input.target}" at (${uia.x}, ${uia.y}) [UIAutomation coords].` };
        }

        // Strategy 2: Windows OCR — fast, accurate for visible text labels.
        const ocr = ocrFindText(input.target);
        if (ocr && !ocr.error) {
          mouseClick(ocr.x, ocr.y, input.button || 'left');
          return { success: true, output: `Clicked ${input.button || 'left'} on "${input.target}" at (${ocr.x}, ${ocr.y}) [OCR].` };
        }

        // Strategy 3: Vision with pixel-labeled grid — fallback for icons/images with no text.
        const { base64, mediaType, width, height } = captureScreenAnnotated();
        const sw = width  || 1920;
        const sh = height || 1080;
        const posPrompt = `This screenshot has a red coordinate grid overlaid. Lines appear every 5% of the screen. Every 10% line is labeled with its actual pixel value (e.g. "192" at the line means X=192 pixels from the left; "108" means Y=108 pixels from the top). Corners show: "0,0" top-left, "${sw},0" top-right, "0,${sh}" bottom-left, "${sw},${sh}" bottom-right.\n\nFind "${input.target}" and report its pixel position.\nReply with ONLY two integers: X,Y (e.g. 960,540)\nNothing else.`;
        const posText = await analyzeScreen({ base64, mediaType, question: posPrompt, width: 0, height: 0 });

        const nums = posText.match(/(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/);
        if (!nums) {
          return { success: false, output: `Could not locate "${input.target}".\nUIAutomation: not found.\nOCR: ${ocr?.error || 'not found'}.\nVision response: "${posText.trim()}"\nTry using click_at with explicit coordinates from a screenshot.` };
        }

        let px = Math.round(parseFloat(nums[1]));
        let py = Math.round(parseFloat(nums[2]));
        // Clamp to screen bounds
        px = Math.max(1, Math.min(px, sw - 1));
        py = Math.max(1, Math.min(py, sh - 1));
        mouseClick(px, py, input.button || 'left');
        return { success: true, output: `Clicked ${input.button || 'left'} on "${input.target}" at (${px}, ${py}) [vision/pixel-grid].` };
      }

      case 'click_at': {
        const times = Math.max(1, Math.min(input.times || 1, 20));
        mouseClick(input.x, input.y, input.button || 'left', times);
        const label = times > 1 ? `${times}× ${input.button || 'left'}` : input.button || 'left';
        return { success: true, output: `Clicked ${label} at (${input.x}, ${input.y}).` };
      }

      case 'type_text': {
        typeText(input.text);
        return { success: true, output: `Typed ${input.text.length} character(s).` };
      }

      case 'press_key': {
        pressKey(input.keys);
        return { success: true, output: `Pressed: ${input.keys}` };
      }

      case 'scroll': {
        scrollAt(input.x, input.y, input.direction || 'down', input.amount || 3);
        return { success: true, output: `Scrolled ${input.direction || 'down'} ${input.amount || 3} tick(s) at (${input.x}, ${input.y}).` };
      }

      case 'screen_size': {
        const { width, height } = getScreenSize();
        return { success: true, output: `Screen: ${width}×${height} pixels.` };
      }

      case 'find_text': {
        const result = ocrFindText(input.text);
        if (!result) return { success: false, output: `"${input.text}" not found on screen via OCR.` };
        if (result.error) return { success: false, output: result.error };

        // Crop a region around the match so the agent can visually verify it
        const crop = cropScreenRegion(result.x, result.y);

        if (input.click) {
          mouseClick(result.x, result.y, 'left');
          const msg = `Found "${input.text}" at (${result.x}, ${result.y}) and clicked it.`;
          if (crop) return { success: true, output: msg, image: crop };
          return { success: true, output: msg };
        }
        const msg = `Found "${input.text}" at (${result.x}, ${result.y}).`;
        if (crop) return { success: true, output: msg, image: crop };
        return { success: true, output: msg };
      }

      case 'end_conversation': {
        return { success: true, output: input.reason || 'Conversation ended.', terminate: true };
      }

      default: {
        // Google tools — only if connected
        if (name.startsWith('google_') && getOAuthToken('google')) {
          const result = await executeGoogleTool(name, input);
          if (result !== null) return { success: true, output: typeof result === 'string' ? result : JSON.stringify(result, null, 2) };
        }
        return { success: false, output: `Unknown tool: ${name}` };
      }
    }
  } catch (err) {
    const combined = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
    return { success: false, output: combined || err.message || String(err) };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__', 'target', '.cache']);

function globToRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      // ** (any depth). "**/" also matches zero segments so it works at the root.
      if (pattern[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
      else { re += '.*'; i += 1; }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

function walkGlob(root, pattern, results = [], dir = root) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = resolve(dir, e.name);
    const rel  = relative(root, full).replace(/\\/g, '/');
    if (e.isDirectory()) {
      walkGlob(root, pattern, results, full);
    } else {
      const re = globToRegex(pattern);
      if (re.test(rel) || re.test(e.name)) results.push(rel);
    }
  }
  return results;
}

function grepWalk(root, re, include, results = [], dir = root) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = resolve(dir, e.name);
    if (e.isDirectory()) {
      grepWalk(root, re, include, results, full);
    } else {
      if (include) {
        const includeRe = globToRegex(include);
        if (!includeRe.test(e.name)) continue;
      }
      // Skip likely binary files
      const ext = extname(e.name).toLowerCase();
      if (['.png','.jpg','.jpeg','.gif','.webp','.ico','.svg','.woff','.woff2','.ttf','.eot','.bin','.zip','.gz'].includes(ext)) continue;
      try {
        const lines = readFileSync(full, 'utf8').split('\n');
        const rel   = relative(root, full).replace(/\\/g, '/');
        lines.forEach((line, i) => {
          if (re.test(line)) results.push(`${rel}:${i + 1}: ${line.trim().slice(0, 150)}`);
        });
      } catch {}
    }
  }
  return results;
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ── Text tool-call fallback parser ────────────────────────────────────────────

export function parseToolCallsFromText(text) {
  const calls = [];
  const pattern = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.name && parsed.input !== undefined) calls.push({ name: parsed.name, input: parsed.input });
    } catch {}
  }
  return calls;
}
