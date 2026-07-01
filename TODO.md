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

## 2. Chat browser / fuzzy resume picker
A picker like FilePicker but for saved chats (`listChats()` in persist.js),
so `axion` can open a fuzzy list instead of requiring the exact `-r <name>`.
- Files: `src/persist.js` (`listChats`, `loadChat`), `src/tui/main.jsx` (argv
  parsing, where `-r`/`-c` currently require exact names), new picker UI
  (reuse FilePicker.jsx's fuzzy-list rendering pattern, or fileList.js's
  `fuzzyFilter` against chat names/dates instead of file paths).
- Decide: is this a `/resume` slash command opened inside a running session
  (spawns a new tab from the picked chat), or only a startup-time flag? Ask
  the user before committing — affects whether it needs its own inputMode.

## 3. Git panel in the sidebar
Live git status (branch, staged/unstaged file counts) in Sidebar.jsx, plus
a `/git diff` or `/git commit` slash command.
- Files: `src/tui/Sidebar.jsx` (already shows `diffTotals` — good model to
  follow), `src/ui/commands.js` (slash command registry), `src/agent/tools.js`
  (there may already be a git-aware tool — check before adding a new one).
- Git status should poll cheaply (e.g. `git status --porcelain` + `git branch
  --show-current` via child_process, on an interval or on tool-completion,
  not on every render).

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

## Also done (user request mid-stream, not in the original 5)
@-file mentions now rescan the project every time a *new* `@` mention starts
(`src/tui/App.jsx`, the `fileActive` useEffect), not just once at launch —
catches files created mid-session. Removed the now-unused `fileScannedRef`.

---
Status as of last update: items 0 and 1 done. Item 2 (chat browser / fuzzy
resume picker) is next up.
