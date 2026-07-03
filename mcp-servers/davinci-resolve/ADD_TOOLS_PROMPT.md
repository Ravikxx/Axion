# Task: add 5 simple tools to the DaVinci Resolve MCP server

You are adding 5 new tools to an existing MCP server that controls DaVinci
Resolve. The plumbing already works — you are only adding handler functions and
registering them. Do NOT touch the transport/socket code, `get_resolve`,
`require_resolve`, or `main()`.

## Files to edit (edit BOTH, keep them identical in behavior)

1. `mcp-servers/davinci-resolve/resolve_bridge.py` — runs INSIDE Resolve (free edition). Result helpers: `_ok(text)` and `_err(text)`.
2. `mcp-servers/davinci-resolve/resolve_server.py` — stdio fallback (Studio). Result helpers: `result_text(text)` and `result_error(text)`.

The two files are mirrors. Every handler, TOOLS entry, and HANDLERS entry must
exist in BOTH. The ONLY difference is the result-helper names above.

## CRITICAL rule: the API is a minefield of methods that don't exist

Resolve's remote objects return `None` for unknown attributes, so calling a
method that doesn't exist dies with `'NoneType' object is not callable` — the
exact bug that plagued the original tools. Use ONLY the method names given
below verbatim. Do not invent, pluralize, or "improve" them. If unsure, the
tool should return an error string, never call a guessed method.

Every handler starts with this exact guard pattern (already used everywhere in
the files — copy it):

```python
def handle_XXX(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return _err("No project open")          # server: result_error(...)
    ...
```

## The 5 tools

### 1. `resolve_open_page` — switch the UI page
- Method: `r.OpenPage(name)` where `r` is `require_resolve()` (it's on the Resolve object, NOT the project).
- Valid names: `media`, `cut`, `edit`, `fusion`, `color`, `fairlight`, `deliver`. Validate the arg against this list; error if invalid.
- Returns True/False. Example: `if r.OpenPage(name): return _ok(f"Opened {name} page")`.
- Schema: required `page` (string, enum of the 7 names).

### 2. `resolve_get_project_setting` — read a project setting
- Method: `proj.GetSetting(name)` → returns a string. With no/empty name, `proj.GetSetting('')` returns a dict of ALL settings — support that (omit the arg → return the whole dict as JSON).
- Schema: optional `name` (string).

### 3. `resolve_set_project_setting` — write a project setting
- Method: `proj.SetSetting(name, value)` → returns True/False. `value` must be passed as a STRING.
- Schema: required `name` (string), required `value` (string). Error if either missing.
- On True return `_ok(f'Set {name} = {value}')`, else `_err(...)`.

### 4. `resolve_create_bin` — add a media-pool sub-folder
- Get the media pool: `mp = proj.GetMediaPool()`; root: `root = mp.GetRootFolder()`.
- Method: `mp.AddSubFolder(root, name)` → returns the new Folder object or None. (Note: AddSubFolder is on the MediaPool `mp`, and takes the PARENT folder as the first arg.)
- Schema: required `name` (string).

### 5. `resolve_clear_render_queue` — empty the render queue
- Method: `proj.DeleteAllRenderJobs()` → returns None (no useful return). Just call it and report success.
- Schema: no properties (`{"type": "object", "properties": {}}`).

## How to register each tool (do this in BOTH files)

For each tool, add THREE things:

1. **Handler function** — place it just before the `# ── Tool registry ──` comment, next to the other new handlers (`handle_list_markers`, etc.).

2. **TOOLS entry** — append to the `TOOLS` list. In `resolve_bridge.py` the entries are one-line dicts; in `resolve_server.py` they are multi-line dicts. Match the surrounding style in each file. Shape:
   ```python
   {"name": "resolve_open_page", "description": "...", "inputSchema": {"type": "object", "required": ["page"], "properties": {"page": {"type": "string", "enum": ["media","cut","edit","fusion","color","fairlight","deliver"]}}}}
   ```

3. **HANDLERS entry** — add `"resolve_open_page": handle_open_page,` to the `HANDLERS` dict.

## When done, verify (this MUST pass)

```bash
cd "<repo root>"
python3.13 -m py_compile mcp-servers/davinci-resolve/resolve_bridge.py mcp-servers/davinci-resolve/resolve_server.py
python3.13 -c "
import sys; sys.path.insert(0, 'mcp-servers/davinci-resolve')
import resolve_bridge as b, resolve_server as s
for mod, nm in ((b,'bridge'),(s,'server')):
    tools = {t['name'] for t in mod.TOOLS}; handlers = set(mod.HANDLERS.keys())
    assert tools == handlers, f'{nm}: TOOLS-only={tools-handlers} HANDLERS-only={handlers-tools}'
bt={t['name'] for t in b.TOOLS}; st={t['name'] for t in s.TOOLS}
assert bt==st, f'drift: {bt ^ st}'
print('OK —', len(bt), 'tools, both files consistent')
"
```
Expected: `OK — 30 tools, both files consistent` (25 existing + your 5).

## After it compiles, the user must reload the live bridge themselves

Copy the bridge into Resolve's script folder and tell the user to relaunch it:
```bash
cp mcp-servers/davinci-resolve/resolve_bridge.py "/c/ProgramData/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility/resolve_bridge.py"
```
Then the user runs, inside DaVinci Resolve: **Workspace → Scripts → Utility → resolve_bridge** (the running bridge doesn't hot-reload; it must be restarted from the menu). Do NOT try to launch Resolve or the bridge yourself — the free edition only accepts the bridge when started from its own menu.

## Do NOT

- Do not add playback, transition, or color-grade tools (not scriptable).
- Do not modify `get_resolve`, `require_resolve`, `main`, `handle_client`, or any socket code.
- Do not call any Resolve method not named in this document.
