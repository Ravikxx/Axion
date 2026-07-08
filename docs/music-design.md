# Music Production Feature — Design Doc

## Primary capability: Reaper DAW control via MCP

**Decision: DAW control, targeting Reaper.**

Of the three options (generation API / MIDI / DAW control), DAW control delivers the most practical value: it lets the agent actually drive a real project the user already has open, rather than producing a standalone audio file with nowhere to go. Reaper is the right target because:

- **First-class scripting.** Reaper has ReaScript (Python, Lua, EEL2) built in, and a built-in **Web Interface** plugin that exposes an HTTP API on localhost — no third-party library, no Max for Live, no custom bridge at the OS level.
- **Cross-platform.** Windows, macOS, Linux — same API everywhere.
- **Contrast with alternatives.** Ableton requires Max for Live or unofficial Python remote-scripts (fragile, version-locked). FL Studio has no external scripting. Logic is macOS-only and AppleScript-only.

MIDI generation is included as a **secondary tool** (`reaper_create_midi`) using Python's `midiutil` library — it generates a `.mid` file and imports it into Reaper via the web interface. This adds compositional capability without a separate capability tier.

Music **generation APIs** (Suno, Udio) are intentionally out of scope: they have no stable programmatic API at the time of writing, and the generate-then-land-in-project problem is better solved once Reaper control is solid.

---

## How Reaper's Web Interface works

Enable in Reaper: *Preferences → Control/OSC/web → Web interface → Enable*.  
Default: `http://localhost:8080` (user-configurable; surfaced as `REAPER_PORT` env var).

Key endpoints (unofficial but stable across Reaper 6/7):

| HTTP | Purpose |
|---|---|
| `GET /_/TRANSPORT` | play state, position, BPM |
| `GET /_/TRACK/{n}/...` | track info (name, vol, mute, solo) |
| `GET /?action=<id>` | run any Reaper action by command ID |
| `GET /reascript-run` | run arbitrary ReaScript (Lua/EEL2/Python) — **most powerful path** |

The `reascript-run` endpoint accepts a small Lua snippet and returns its output. This is the Swiss-army-knife: anything the scripting API can do (add tracks, insert items, set FX params, read MIDI, change BPM) can be expressed in a short Lua call and executed via one HTTP request. The MCP server generates Lua stubs from tool inputs.

No authentication on the web interface (localhost only — acceptable for a developer tool).

---

## How it ties into #2 (audio analysis) and the Resolve pipeline

```
Audio file / recording
       │
       ▼
analyze_audio (feature #2)
  → tempo, key, mood, instrument list, lyrics snippet
       │
       ├─── feed BPM to reaper_set_bpm
       ├─── suggest track arrangement in Reaper
       └─── generate MIDI (reaper_create_midi) matching detected key/tempo
                 │
                 ▼
        Import into Reaper project
                 │
                 ▼
        Export stems / mix
                 │
                 ▼
        Import into DaVinci Resolve timeline (ffmpeg / Resolve MCP)
```

The analyze → arrange → export loop is the primary workflow: user says "analyze this stem and build a rough arrangement in Reaper at its tempo." The agent calls `analyze_audio`, extracts tempo and key, calls `reaper_set_bpm`, creates tracks via `reaper_create_track`, optionally generates MIDI via `reaper_create_midi`, and imports everything.

---

## Hard integration risks

1. **Web Interface must be enabled manually.** No way to detect it programmatically before the first request. `/reaper setup` must print clear instructions.

2. **Port is user-configurable.** Default 8080 conflicts with common dev servers. Surface as `REAPER_PORT` env var (default `8080`). The setup instructions must mention this.

3. **`reascript-run` is undocumented.** Works in Reaper 6.x and 7.x; Cockos hasn't committed to it formally. If it breaks in a future version, fall back to the named action endpoint for simple cases. Risk: low (endpoint has been stable for 5+ years).

4. **Reaper must be open.** Unlike the Resolve server (which can answer `initialize`/`tools/list` instantly while Resolve is closed), every `tools/call` requires a live Reaper HTTP server. **Mitigation: answer `initialize`/`tools/list` instantly (locally) and only hit Reaper on `tools/call`** — same pattern as Resolve.

5. **`midiutil` is a pip install.** Add to setup instructions. Degrade gracefully (skip `reaper_create_midi` and return a clear error) if import fails.

---

## Files to create

```
mcp-servers/reaper/
  reaper_server.py        MCP stdio server — JSON-RPC 2.0, talks to Reaper via HTTP
  ADD_TOOLS_PROMPT.md     Prompt injected when server is active (list of tools + usage hints)
```

`src/agent/mcp-marketplace.js` — add catalog entry (category `creative`, `PKG_SERVER` helper):
```js
{
  id: 'reaper',
  name: 'Reaper',
  description: 'Control Reaper DAW — project info, tracks, transport, BPM, markers, MIDI generation, and arbitrary action execution via the built-in web interface',
  cmd: 'python3',
  args: ['-u', PKG_SERVER('reaper/reaper_server.py')],
  envNote: 'Requires Reaper running with the Web Interface enabled (Preferences → Control/OSC/web). Set REAPER_PORT if not 8080.',
  tags: ['reaper', 'daw', 'music', 'midi', 'audio', 'production'],
  category: 'creative',
}
```

`src/tui/App.jsx` — add `/reaper` command handler (mirror `/resolve`).  
`src/ui/commands.js` — add `{ cmd: 'reaper', desc: 'connect the Reaper DAW MCP server' }`.

---

## Tools (initial set)

| Tool | What it does |
|---|---|
| `reaper_get_project_info` | Project name, BPM, time signature, sample rate, total length, play state |
| `reaper_get_tracks` | List all tracks: index, name, volume (dB), pan, muted, soloed, armed |
| `reaper_transport` | Play / pause / stop / rewind / seek to timecode |
| `reaper_set_bpm` | Set project BPM |
| `reaper_create_track` | Add a new track, optionally set name |
| `reaper_set_track_volume` | Set volume (dB) and/or pan for a track by index |
| `reaper_get_markers` | List all markers and regions with their times and names |
| `reaper_add_marker` | Add a named marker at a given timecode |
| `reaper_run_action` | Run any Reaper action by command ID (e.g. 40157 = render) |
| `reaper_create_midi` | Generate a `.mid` file from a note array (pitch, duration, velocity) and import it into Reaper as a new MIDI item on a track |

All Lua stubs are kept short and generated inline by `reaper_server.py` — no external Lua files.

---

## Acceptance criteria (design phase)

- [x] Picks one primary capability (DAW control → Reaper)
- [x] Names the target tool/API (Reaper Web Interface + `reascript-run` endpoint)
- [x] Flags the hard integration risks (3 meaningful ones above)
- [x] Lists the files to create
- [x] No code written yet
