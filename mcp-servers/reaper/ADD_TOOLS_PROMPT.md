# Reaper MCP server — available tools

The Reaper MCP server controls Reaper DAW via its built-in HTTP Web Interface
(`Preferences → Control/OSC/web → Web interface → Enable`, default port 8080).
Every `tools/call` requires Reaper to be running with the web interface active.
Set `REAPER_PORT` env var if your port differs from 8080.

## Tools

| Tool | Purpose |
|---|---|
| `reaper_get_project_info` | Project name, BPM, length, track count, transport state |
| `reaper_get_tracks` | All tracks: index, name, volume (dB), pan, muted, soloed, armed |
| `reaper_transport` | Play / stop / pause / record / rewind / seek |
| `reaper_set_bpm` | Set project BPM |
| `reaper_create_track` | Add a new named track |
| `reaper_set_track_volume` | Set volume (dB) and/or pan for a track by index |
| `reaper_get_markers` | List all project markers and regions |
| `reaper_add_marker` | Add a named marker at a timecode position |
| `reaper_run_action` | Run any Reaper action by integer command ID |
| `reaper_create_midi` | Generate a MIDI file from a note array and import it |

## Typical workflow — analyze audio → arrange in Reaper

1. Use `analyze_audio` (feature #2) on a stem to extract BPM and key.
2. Call `reaper_set_bpm` with the detected BPM.
3. Call `reaper_create_track` for each instrument layer.
4. Call `reaper_create_midi` with notes matching the detected key/tempo.
5. Use `reaper_run_action` with action ID 40157 to open the render dialog.

## Notes

- Track indices are **1-based** in all tool arguments.
- `reaper_run_action` accepts any command ID from the Reaper Actions dialog
  (`Actions menu → Show action list`). Common IDs:
  - `40157` — File: Render project (opens render dialog)
  - `40346` — Track: Insert virtual instrument on new track
  - `1007`  — Transport: Play
  - `1016`  — Transport: Stop
- `reaper_create_midi` requires `pip install midiutil`; the tool degrades
  gracefully with a clear error if the library is missing.
