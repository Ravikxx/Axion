<p align="center">
  <img src="docs/logo.svg" width="96" height="96" alt="Axion logo">
</p>

# ⚛ Axion

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
| **Discord Bot** | Chat with the agent via Discord DMs (`/discord start`) |
| **Dataset Collection** | Contribute sessions to improve future models (`/contribute`) |
| **Plugins** | Extend the agent with browser, Docker, GitHub, and database tools (`/plugin`) |
| **Axion Vision** | Free image understanding & OCR endpoint — read text in screenshots, analyse images |

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
| `lumen` | Axion Labs | ⚠️ Temporarily suspended — safety retraining in progress. See [safety report](https://axionlabs.dev/lumen-suspension). |
| `veil` | Axion Labs | No key required — free but slow (up to 100s) |
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
| `glm` / `glm-5.2` | Z.ai | GLM-5.2, 753B, beats GPT-5.5 on coding. Requires Z.ai key (`/api glm`) |
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
/help                              show all commands
/model <name|id>                   switch model (alias or raw ID)
/mode  <name>                      switch mode: ask · plan · auto  (Ctrl+P to cycle)
/models                            list all available models + custom endpoints
/theme [name]                      accent color: ember · violet · ocean · jade · rose · gold
/api <model> <key>                 set API key (saved)
/endpoint <name> <url> [model] [key]  add a custom OpenAI-compatible endpoint
/endpoint                          list saved endpoints
/thinking [on|off|<tokens>]        toggle extended thinking
/adviser [model|auto|off]          set a second model that helps when the agent gets stuck
/cost                              show session token usage and estimated cost

# Running things
/run <cmd>                         run a shell command and feed output to the agent
!<cmd>                             shorthand for /run  e.g. !git status
/goal <description>                work autonomously until goal is met
/goal                              show or cancel current goal
/retry                             re-run the last message
/btw <question>                    quick side question without affecting chat history
/review                            code review of current git diff (structured feedback)
/pr [context]                      draft a PR title+body from recent commits

# Context & memory
/remember <text>                   save a persistent note (injected into every session)
/remember                          list saved notes
/forget <index>                    remove a note by number
/system [text]                     set/clear extra system prompt instructions for this session
/include <file>                    pin a file into context for the session (tab-completes)
/include                           list pinned files
/include remove <file>             unpin a file
/include clear                     unpin all files

# Chat history
/save <name>                       save current chat
/resume [name]                     resume a saved chat (no name = list all)
/remove-chat <name>                delete a saved chat
/search-chats <query>             search across all saved chats
/history <query>                   search message history
/export <filename>                 save chat as markdown
/compact                           summarize & compress history to free context
/clear                             clear history

# Comparing models
/compare <prompt>                  run prompt through saved/default models side by side
/compare <m1,m2,...> <prompt>      override models for this run
/compare-models                    show saved compare model list
/compare-models <m1,m2,...>        save default models for /compare
/compare-models reset              restore built-in defaults (claude · gpt · gemini)

# Undo & checkpoints
/undo                              restore last overwritten/deleted file
/rewind [list|<n>]                 undo the last n turns' file changes (checkpoints)

# Computer use
/computer [on|off]                 toggle computer use / screen control  (alias: /cu)
/vision [model]                    set/show vision model for computer use
/ss [question]                     screenshot + describe the screen (quick, no agent loop)
/macro record <name>               start recording a macro (computer use actions)
/macro stop                        save the recorded macro
/macro play <name>                 replay a saved macro
/macro list                        list all saved macros
/macro delete <name>               delete a saved macro

# Image generation
/img-gen <prompt>                  generate an image (saved to ~/.axion/images/)
/img-gen-model [model]             set/show image model (dall-e-3, dall-e-2, gpt-image-1)

# Skills & automation
/skills                            list skills (auto-activate when trigger words appear)
/skill-generator <name> <txt>      AI-generates a skill .md in ~/.axion/skills/
/skill-delete <name>               delete a skill
/watch                             start watch-and-learn (saves preferences from your messages)
/watch stop                        stop + save learned preferences to ~/.axion/learned.md
/watch show                        view current learned preferences
/watch clear                       delete all learned preferences
/permissions [clear]               list/reset always-allowed tools (press "a" on confirms)

# Dataset contribution
/contribute                        share this session as training data (auto-prompted)
/contribute skip                   dismiss for this session
/contribute optout [off]           permanently opt out (or re-enable)

# Web UI
/web [port]                        open web UI in browser (default port 3000)
/web stop                          stop web server

# MCP servers
/mcp                               show connected MCP servers + tool counts
/mcp browse                        browse MCP marketplace (curated servers)
/mcp search <query>                search marketplace by keyword
/mcp install <id>                  install a server from the marketplace
/mcp add <name> <cmd> [args]       connect a custom MCP server (saved)
/mcp enable <name>                 enable a disabled server
/mcp disable <name>                pause a server (keeps config)
/mcp remove <name>                 disconnect + delete config
/mcp tools [name]                  list tools from connected servers
/mcp reload                        restart all servers

# Blender
/blender setup                     show Blender add-on install instructions
/blender connect                   connect Blender MCP server to Axion

# OAuth
/oauth connect <service>           connect GitHub · Google · Notion · Slack
/oauth list                        show connected services
/oauth revoke <service>            disconnect

# Scheduled tasks
/schedule                          list scheduled tasks
/schedule add <name> "<expr>" <p>  add a scheduled task
/schedule run <name>               run a task now
/schedule remove <name>            delete a task
/schedule enable/disable <name>    toggle a task
/schedule results [name]           show result files

# Plugins
/plugin                            list available plugins + status
/plugin enable <name>              enable a plugin
/plugin disable <name>             disable a plugin
/plugin tools <name>               show tools a plugin provides
/plugin install <name>             install a plugin

# Discord
/discord token <TOKEN>             save bot token
/discord start                     connect bot (auto-reconnects on next launch)
/discord stop                      disconnect
/discord status                    show connection info

/exit                              quit
```

**Keyboard shortcuts:** `Ctrl+R` search history · `Ctrl+P` cycle mode · `Ctrl+T` toggle thinking · `Ctrl+O` expand tool output · `\` + `Enter` newline

---

## Project memory & customization

- **AXION.md** — put persistent project instructions in `./AXION.md`, `./.axion/AXION.md`, or `~/.axion/AXION.md`; they're loaded into every session's system prompt.
- **@file mentions** — type `@src/file.js` in any message to pin that file into context (tab-completes paths).
- **Custom slash commands** — drop `.md` files in `~/.axion/commands/` or `./.axion/commands/`; `review-pr.md` becomes `/review-pr`, and `$ARGUMENTS` in the body is replaced with whatever follows the command.
- **Skills** — `/skill-generator minecraft remember X, Y, Z whenever minecraft comes up` has the AI write `~/.axion/skills/minecraft.md` (frontmatter: name, description, triggers). The skill auto-injects into the system prompt whenever a trigger word appears in your message. `/skills` lists them, `/skill-delete <name>` removes one, or edit the `.md` directly.
- **Per-project settings** — drop a `.axion-settings.json` in your project root to override global defaults for that project: `{ "model": "claude", "mode": "auto", "theme": "ocean", "systemPrompt": "...", "thinking": true }`. Takes priority over `.axionrc`.
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

## Dataset Contribution

Help improve future Axion models by sharing interesting sessions. Axion automatically suggests contributing after complex or frustrating conversations.

```
/contribute           # share this session
/contribute skip      # not now
/contribute optout    # never ask again (run with "off" to re-enable)
```

Sessions are sent to the Axion Labs collector automatically — no setup needed. If you're offline, they're saved locally in `~/.axion/donations/` and uploaded the next time Axion starts with a connection.

### axion-collect (local daemon)

Run a persistent local collector to capture sessions before they're uploaded:

```bash
axion-collect               # saves to ~/.axion/dataset/ on port 47832
axion-collect --port 12345  # custom port
axion-collect --out ~/data  # custom output directory
```

Axion checks for the daemon on startup and routes sessions to it first when running.

---

## Discord Bot

Chat with the Axion agent directly from Discord DMs.

### Setup
1. Create a bot at [discord.com/developers](https://discord.com/developers/applications)
2. Enable **Message Content Intent** under Bot → Privileged Gateway Intents
3. Invite the bot to your server (or DM it directly)
4. Save the token: `/discord token <BOT_TOKEN>`
5. Connect: `/discord start`

### How it works
- DMs sent to the bot appear in the CLI labeled `[Discord: username]`
- The full agent responds — file access, tools, confirmations, MCP servers
- The response is sent back to Discord automatically (long replies are split)
- If the agent needs permission to run a tool, it DMs you a y/n prompt
- The bot shows a typing indicator while processing

### Commands
| Command | Description |
|---|---|
| `/discord token <TOKEN>` | Save bot token |
| `/discord start` | Connect (auto-reconnects on next launch) |
| `/discord stop` | Disconnect (disables auto-reconnect) |
| `/discord status` | Show connection info |

### Standalone daemon
`axion-discord` runs a persistent bot without the TUI — useful for a server:

```bash
axion-discord
axion-discord --model claude
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

## Axion Vision

A free image understanding & OCR endpoint, hosted separately from Lumen.

- Powered by **Qwen2.5-VL-3B** (Alibaba open-weights vision model)
- Reads text in screenshots, error messages, UI mockups, diagrams
- OpenAI-compatible `/v1/chat/completions` — send images as base64 `image_url` content blocks
- No API key required

Deploy from `axion-vision-space/app.py` to a HuggingFace Space.

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
│   ├── scheduler.js    # Scheduled tasks
│   ├── discord-daemon.js  # axion-discord standalone bot
│   └── collect-daemon.js  # axion-collect local dataset daemon
├── collect-worker/     # Cloudflare Worker for remote session collection
├── extension/          # Chrome extension
├── mcp-servers/        # Bundled MCP servers (Blender)
├── build.js            # CLI bundler
└── build-web.js        # Web UI bundler
```

---

## License

MIT — made by [Axion Labs](https://github.com/Ravikxx)
