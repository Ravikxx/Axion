<p align="center">
  <img src="docs/logo.svg" width="96" height="96" alt="Axion logo">
</p>

# ◈ Axion

**Axion** is an open-source AI coding agent ecosystem built by Axion Labs. It includes a terminal CLI, a Chrome extension, a web UI, and an IDE integration — all sharing the same models, tools, and memory.

---

## What's included

| Component | Description |
|---|---|
| **CLI** | Terminal agent — reads, writes, and runs code in any directory |
| **Chrome Extension** | Browser sidebar — ask questions about pages, automate the web |
| **Web UI** | Browser-based chat with the same agent (`/web`) |
| **MCP Servers** | Connect Blender, GitHub, Notion, Slack, and more |
| **OAuth** | Connect GitHub and Google Drive/Calendar with `/oauth` |
| **Scheduled Tasks** | Run AI tasks on a schedule with `/schedule` |

---

## Installation

### Requirements
- [Node.js](https://nodejs.org) v18+
- npm

### Steps

```bash
git clone https://github.com/Ravikxx/axion.git
cd axion
npm install
node build.js
npm install -g .
```

Then run from anywhere:

```bash
axion
```

### Linux computer-use dependencies (optional)

Computer-use tools (screenshots, mouse, keyboard) require:

```bash
# Debian/Ubuntu
sudo apt install xdotool scrot xclip

# Arch
sudo pacman -S xdotool scrot xclip
```

`xdotool` is the only hard requirement — `scrot` is for screenshots, `xclip` is a fallback for text input.

### macOS computer-use dependencies (optional)

```bash
brew install cliclick   # for scroll support
```

Grant **Accessibility** and **Screen Recording** permissions to Terminal (or iTerm) in System Settings → Privacy & Security.

---

## API Keys

Set keys before running, or use `/api` inside the chat:

```bash
# Option 1 — environment variables
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export GEMINI_API_KEY=...
export GROQ_API_KEY=gsk_...
export MISTRAL_API_KEY=...

# Option 2 — .env file (place in ~/.axion/.env or your project root)
# Copy .env.example to get started
cp .env.example ~/.axion/.env
```

Or set them live inside the CLI:

```
/api claude sk-ant-...
/api gpt sk-...
/api gemini AI...
```

---

## Models

| Alias | Provider | Notes |
|---|---|---|
| `lumen` | Axion Labs | No key required — Axion Labs' own 8B model, fine-tuned by RavikxxBGamin |
| `veil` | Axion Labs | No key required — free but slow (up to 100s), not broken |
| `openrouter` / `or` | OpenRouter | 200+ models via one key |
| `fable` | Anthropic | claude-fable-5 |
| `claude` | Anthropic | claude-sonnet-4-6 |
| `claude-opus` | Anthropic | claude-opus-4-8 |
| `claude-haiku` | Anthropic | claude-haiku-4-5 |
| `gpt` | OpenAI | gpt-4o |
| `gpt-mini` | OpenAI | gpt-4o-mini |
| `gemini` | Google | gemini-2.0-flash |
| `gemini-2.5-pro` | Google | gemini-2.5-pro |
| `groq` | Groq | llama-3.3-70b |
| `mistral` | Mistral | mistral-large |
| `ollama` | Local | Requires Ollama running |

Switch models anytime:

```
/model veil
/model claude
/model gpt
/model gemini-2.5-pro
/model ollama
```

### OpenAI-compatible endpoints (OpenRouter, LM Studio, etc.)

Any OpenAI-compatible API works — including OpenRouter, LM Studio, Together AI, and self-hosted models:

```
/endpoint openrouter https://openrouter.ai/api/v1 meta-llama/llama-3.3-70b-instruct sk-or-...
/endpoint lmstudio   http://localhost:1234/v1       lmstudio-community/meta-llama-3-8b
/endpoint together   https://api.together.xyz/v1    mistralai/Mixtral-8x7B-Instruct-v0.1 sk-...
```

Format: `/endpoint <alias> <base-url> <model-id> [api-key]`

Custom endpoints are saved and show up in `/models`.

---

## Modes

| Mode | Behavior |
|---|---|
| `ask` | Confirms every tool call before running |
| `plan` | Shows a plan first, then confirms |
| `auto` / `bypass` | Runs everything without asking |

Switch with `/mode auto` or press `Ctrl+P` to cycle.

---

## CLI Commands

```
/help                         show all commands
/model <name>                 switch model
/mode <name>                  switch mode: ask · plan · auto
/theme [name]                 accent color: ember · violet · ocean · jade · rose · gold
/api <model> <key>            set API key
/endpoint <name> <url> [model] [key]   add custom endpoint
/thinking [on|off|tokens]     enable extended thinking
/web [port]                   open web UI in browser
/web stop                     stop web server

/oauth connect <service>      connect GitHub · Google · Notion · Slack
/oauth list                   show connected services
/oauth revoke <service>       disconnect

/schedule add <name> "<expr>" <prompt>   add scheduled task
/schedule list                list all tasks
/schedule run <name>          run a task now
/schedule results [name]      show result files

/mcp                          show connected MCP servers
/mcp add <name> <cmd> [args]  connect an MCP server
/mcp tools [name]             list available tools

/remember <text>              save a persistent note
/forget <index>               remove a note
/goal <description>           run autonomously until goal is met
/save <name>                  save current chat
/resume <name>                resume a saved chat
/export <filename>            export chat as markdown
/undo                         restore last overwritten file
/rewind [list|<n>]            undo the last n turns' file changes
/permissions [clear]          list/reset always-allowed tools ("a" on confirms)
/clear                        clear history
/exit                         quit
```

---

## Project memory & customization

- **AXION.md** — put persistent project instructions in `./AXION.md`, `./.axion/AXION.md`, or `~/.axion/AXION.md`; they're loaded into every session's system prompt.
- **@file mentions** — type `@src/file.js` in any message to pin that file into context (tab-completes paths).
- **Custom slash commands** — drop `.md` files in `~/.axion/commands/` or `./.axion/commands/`; `review-pr.md` becomes `/review-pr`, and `$ARGUMENTS` in the body is replaced with whatever follows the command.
- **Skills** — `/skill-generator minecraft remember X, Y, Z whenever minecraft comes up` has the AI write `~/.axion/skills/minecraft.md` (frontmatter: name, description, triggers). The skill auto-injects into the system prompt whenever a trigger word appears in your message. `/skills` lists them, `/skills delete <name>` removes one, or edit the `.md` directly.
- **Message queueing** — type while the agent is working; messages queue and send when the turn finishes.
- **Background tasks** — the agent can start dev servers/watchers with `run_command background=true` and poll them with `check_task`.

---

## Schedule formats

```
/schedule add morning-report "daily 09:00" Summarize my GitHub notifications
/schedule add weekly-review  "weekly mon 09:00" Review what I worked on this week
/schedule add price-check    "every 30m" Check Bitcoin price and alert if > 100k
```

Results are saved as markdown files in `~/.axion/schedule-results/`.

---

## OAuth integrations

Connect services to give the agent access to them:

```
/oauth connect github     → device flow, auto-adds GitHub MCP server
/oauth connect google     → opens browser, connects Drive + Calendar
/oauth connect notion     → paste integration token
/oauth connect slack      → paste bot token
```

To enable OAuth, register your own apps and add credentials to `~/.axion/.env`:

```
AXION_GITHUB_CLIENT_ID=...
AXION_GITHUB_CLIENT_SECRET=...
AXION_GOOGLE_CLIENT_ID=...
AXION_GOOGLE_CLIENT_SECRET=...
```

---

## Chrome Extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `extension/` folder from this repo
5. Click the Axion icon or press `Alt+Shift+A`

The extension sidebar lets you ask about the current page, run browser automation, take screenshots, and chat using any supported model — no API key required if using Veil. Links in AI responses are clickable and open in a new tab.

---

## Web UI

```
/web          # opens http://localhost:3000
/web 8080     # custom port
/web stop     # stop the server
```

The web UI shares the same agent session as the CLI.

---

## MCP Servers

Axion includes a built-in MCP marketplace with 13 curated servers:

```
/mcp browse               # see all available servers
/mcp search database      # filter by keyword
/mcp install github       # install by ID
/mcp install puppeteer
/mcp install postgres postgresql://user:pass@localhost/db
```

Or connect any MCP server manually:

```
/mcp add github npx -y @modelcontextprotocol/server-github
/mcp add notion npx -y @modelcontextprotocol/server-notion
/mcp add blender /blender connect
```

Config is saved to `~/.axion/mcp.json`.

Available marketplace IDs: `github`, `filesystem`, `fetch`, `postgres`, `sqlite`, `notion`, `slack`, `puppeteer`, `memory`, `brave-search`, `google-maps`, `sequential-thinking`, `everything`

---

## Rebuilding after edits

```bash
node build.js       # rebuild CLI
node build-web.js   # rebuild web UI
npm install -g .    # update global install
```

---

## Project structure

```
axion/
├── src/
│   ├── agent/          # Agent loop, tools, models, MCP, OAuth APIs
│   ├── ui/             # CLI React/Ink UI
│   ├── web/            # Web server + React web client
│   ├── oauth/          # OAuth providers + flow
│   ├── config.js       # Models, providers, API keys
│   ├── persist.js      # Local storage (~/.axion/)
│   └── scheduler.js    # Scheduled tasks
├── extension/          # Chrome extension
├── mcp-servers/        # Bundled MCP servers (Blender)
├── build.js            # CLI bundler
└── build-web.js        # Web UI bundler
```

---

## License

MIT — made by [Axion Labs](https://github.com/Ravikxx)
