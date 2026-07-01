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

## 4. Spend tracker across sessions — DONE
`src/persist.js`: `getCostLog()`/`appendCostLog(entry)` — own file
(`~/.axion/cost-log.json`, not the encrypted config blob), bounded to 5000
entries / 90 days. `App.jsx`'s `runAgentTurn` logs a delta on each turn's
`.finally()`: reads `agentRef.current.inputTokens`/`outputTokens` directly
(NOT the `tokens`/`model` React state, which the memoized callback's closure
could go stale on) and diffs against a `lastLoggedTokensRef` snapshot, so
each entry is a per-turn delta rather than a cumulative re-log. `/cost`
(registered in `src/ui/commands.js`) prints today/this-week/all-time spend
broken down by model, priciest-first. Verified
the log round-trips on disk and the time-bucket math directly (pure-function
tests); cleaned up the test entry from the real `~/.axion/cost-log.json`
afterward.

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
Status as of last update: all 5 original items done, plus 2 mid-stream
requests (@-file rescan, schedule_followup/bgtask ping). Nothing queued —
check with the user for what's next.
