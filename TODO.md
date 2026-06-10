# Axion TODO

## Computer use — cross-platform parity

- [x] **Annotated screenshots on Linux/macOS** — uses ImageMagick `convert` to draw a labeled grid (labels show logical pixel coords, handles Retina 2x via `identify`). Falls back to plain screenshot if `convert` is not installed.

- [x] **`pressKey` on macOS** — now uses `key code N using {mod down}` for special keys and Cmd/Option/Shift combos. `^` maps to command, `%` to option, `+` to shift (macOS convention). Runs via a temp .scpt file to avoid escaping issues.

- [x] **`mouseClick` double-click on macOS** — uses `cliclick dc:x,y` for true double-click when available; falls back to a single osascript invocation with 50ms inter-click delay so the OS registers it within the double-click threshold.

- [x] **`ocrFindText()` on Linux/macOS** — uses `tesseract` hOCR output; supports multi-word phrase matching and single-word partial fallback. Returns helpful install hint if tesseract is missing.

- [x] **`showOverlay()` on Linux/macOS** — Python+tkinter corner-glow overlay; tries to set `_NET_WM_WINDOW_TYPE_SPLASH` for click-through on X11. Silently skips if Python unavailable.

- [x] **`uiaClickElement()` on Linux/macOS** — macOS uses System Events osascript to search the frontmost app's UI tree; Linux uses `xdotool search --name` to find windows by title and returns their center coords.

## CLI

- [x] **`/web` link mode in chat sessions** — removed the session-type gate; `axion --link` now works with both code and chat sessions. All events (stream, tools, confirm, etc.) were already handled by LinkedApp.

- [x] **Streaming for OpenAI-compatible endpoints** — tightened the tool-error fallback condition so generic 400s (auth, model-not-found) from Ollama/LM Studio are no longer silently swallowed and now surface as real errors.

## Tooling

- [x] **`axion --doctor` — MCP server health** — now spawns each configured server, sends an MCP `initialize` handshake, and reports ok/fail per server (3s timeout, all servers checked in parallel).

- [x] **Auto-update check** — `axion --doctor` now compares local HEAD against remote via `git ls-remote` and prompts `axion --update` if behind.

## Docs / DX

- [x] **`.env.example`** — added with all API keys, OAuth vars, and AXION_* overrides.

- [x] **Extension auto-reload** — `npm run watch` starts esbuild in watch mode for the CLI bundle and a live-reload server (port 35729) for the extension. background.js polls the server and calls `chrome.runtime.reload()` when the token changes.
