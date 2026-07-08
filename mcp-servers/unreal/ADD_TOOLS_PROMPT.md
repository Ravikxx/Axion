# Unreal Engine MCP server — available tools

The Unreal MCP server controls the Unreal editor through the **Remote Control
HTTP API** (enable the "Remote Control API" plugin; the HTTP server starts on
`http://localhost:30010`, override with `UNREAL_RC_PORT`). No in-engine bridge
code — the MCP server is a thin HTTP client. Every `tools/call` requires the
editor to be open.

## Tools

| Tool | Purpose |
|---|---|
| `unreal_list_actors` | All actors in the level with label + object path |
| `unreal_spawn_actor` | Spawn from a class path, optional location |
| `unreal_delete_actor` | Delete an actor by object path |
| `unreal_set_actor_transform` | Set location (cm) / rotation (deg) / scale |
| `unreal_get_property` | Read a UObject property (or all) |
| `unreal_set_property` | Write a UObject property |
| `unreal_call_function` | Call any BlueprintCallable UFunction — the escape hatch |
| `unreal_console_command` | Run a console command (`stat fps`, `t.MaxFPS 120`, …) |

## Notes

- **Actor paths** look like `/Game/Maps/Map.Map:PersistentLevel.Floor_1` — get
  them from `unreal_list_actors` first; every other actor tool needs one.
- **Class paths** for spawning: native classes are
  `/Script/Engine.StaticMeshActor`, `/Script/Engine.PointLight`,
  `/Script/Engine.CameraActor`; Blueprint classes are
  `/Game/Path/BP_Name.BP_Name_C` (note the `_C` suffix).
- Units: locations in centimeters, rotations in degrees (pitch, yaw, roll).
- `unreal_call_function` calls through `/remote/object/call` — the function
  must be `BlueprintCallable`. Blueprint-exposed engine functions often have a
  `K2_` prefix internally (e.g. `K2_SetActorLocation`), which Remote Control
  requires verbatim.
- Editor subsystems are callable as objects, e.g.
  `/Script/UnrealEd.Default__EditorActorSubsystem` — that's how
  `unreal_list_actors` and `unreal_spawn_actor` work internally.

## How to add new tools

All logic lives in `mcp-servers/unreal/unreal_server.py`:

1. Write a `handle_<name>(args)` function using the `_call(object_path,
   function_name, parameters)` or `_rc(endpoint, body)` helpers. Return
   `result_text(...)` / `result_error(...)`.
2. Add the matching entry to `TOOLS` (name, description, inputSchema).
3. Add the `'unreal_<name>': handle_<name>,` entry to `HANDLERS`.
4. Verify: `python3 -m py_compile mcp-servers/unreal/unreal_server.py` and
   check `{t['name'] for t in TOOLS} == set(HANDLERS)`.
