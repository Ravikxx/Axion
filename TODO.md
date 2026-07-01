# Axion TODO — next features (in order)

Working one at a time, committing + `npm link` after each. If you're picking
this up cold (e.g. opencode resuming after a Claude limit): read the "Files"
line for each item first, `npm test` should show 116 passing before you start,
and re-run it after each item before moving to the next.

## 0. @-file tab-complete — DONE (already existed)
Checked `src/tui/App.jsx` line ~601: `if (key.name === 'tab') { insertFile(fileMatches[Math.min(fileSel, n - 1)]); return; }`
already inside the `fileActive && fileMatches.length` block, and
`FilePicker.jsx`'s hint text already says "Tab/Enter insert". No work needed.

## 1. In-chat transcript search (Ctrl+F) — DONE
Implemented: `src/tui/SearchBar.jsx` (new, mirrors QuestionMenu.jsx's panel
style) + state/wiring in `src/tui/App.jsx` (`searchOpen`/`searchQuery`/
`searchIdx`, `messageSearchText()` helper, `searchMatches` useMemo).
Ctrl+F opens/closes it (only from `inputMode === 'chat'`); ↑/↓ step through
matches; Enter (via the SearchBar's own `<input>`) also advances to the next
match; Esc closes. The matched message row gets a highlighted border (message-
level granularity, not character-level — character highlighting would need
threading a `highlight` prop through RichText's markdown renderer, skipped
for v1). Scroll-to-match is approximate: `(matchIndex / totalMessages) *
scrollHeight`, since OpenTUI's scrollbox has no per-child offset lookup — good
enough in practice but not pixel-exact. Verified the matching logic directly
(pure-function test); a full OpenTUI `testRender` render hung in this sandbox
(unrelated environment issue, not the feature) — worth a manual check in a
real terminal if picking this up.

## 2. Chat browser / fuzzy resume picker — DONE
User chose: `/resume` (no args) inside a running session. Implemented
`src/tui/ChatPicker.jsx` (new — owns its own filter `<input>`, unlike
FilePicker which reads off the main input's `@query`) + wiring in App.jsx
(`chatPickerOpen`/`chatPickerList`/`chatQuery`/`chatSel`, `chatMatches`
useMemo using `fuzzyFilter` from fileList.js against chat names). Picking a
chat calls `loadChat(name)` then `onNewTab?.(chat)` — opens it in a **new
tab**, doesn't touch the current one. Had to extend the App-level `newTab`
callback to accept an optional `resume` payload (previously always `null`).
`/resume <name>` (exact name, loads into the *current* tab) is unchanged —
this only replaces the old no-args text-listing behavior. Verified the
fuzzy-match logic directly (pure-function test); full-TUI render still hangs
in this sandbox (same unrelated environment issue as item 1).

## 3. Git panel in the sidebar — DONE
`src/utils/gitStatus.js` (new — `readGitStatus(cwd)`, parses `git status
--porcelain` for staged/unstaged counts + `git rev-parse --abbrev-ref HEAD`
for branch; returns `null` outside a repo). Sidebar.jsx shows a `git` section
(branch + counts) when non-null, following the same pattern as `diffTotals`.
App.jsx polls it every 5s, foreground tab only. Also added `/git status|diff
|commit <message>` — direct shortcuts that shell out to git without an LLM
call (the agent already had git_status/git_diff/git_commit tools for
natural-language use; this is the same actions but instant/free). Registered
in `src/ui/commands.js` for /help and tab-complete.

## 4. Spend tracker across sessions
Persist cost per session over time; add a `/cost` command showing
today/this-week/all-time spend, broken down by model.
- Files: `src/persist.js` (needs a new persisted store, e.g. `costLog` array
  of `{ ts, model, inputTokens, outputTokens, cost }`), `src/config.js`
  (`estimateCost` already exists — reuse it), `src/ui/commands.js` (register
  `/cost`), `src/tui/App.jsx` (Session already tracks `tokens` per turn —
  hook into wherever it updates to append a costLog entry).
- Keep the log bounded (e.g. last N entries or prune >90 days) so
  `~/.axion/config.json` doesn't grow forever.

## Also done (user requests mid-stream, not in the original 5)
- @-file mentions now rescan the project every time a *new* `@` mention
  starts (`src/tui/App.jsx`, the `fileActive` useEffect), not just once at
  launch — catches files created mid-session. Removed the now-unused
  `fileScannedRef`.
- `schedule_followup(seconds, note)` tool — agent requests a one-time
  delayed check-in instead of polling. Background tasks (`run_command
  background=true`) now also auto-notify on completion, no explicit call
  needed. Both desktop-ping (OSC 9) and, if the tab is idle, auto-continue
  the conversation with the result; if busy, post as an info message.
  Routed per-tab via `src/agent/bus.js` (each tab's `Agent` now gets
  `label: todoScope` instead of the default `'main'` — see `src/tui/App.jsx`
  agent init and the new BUS-polling `useEffect`). This also fixed a latent
  bug where every tab previously shared one `'main'` inbox for
  send_message/read_messages (multi-agent tools).

---
Status as of last update: items 0, 1, 2, 3 done. Item 4 (spend tracker) is
next up — the last of the original 5.
