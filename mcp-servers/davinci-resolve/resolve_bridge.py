#!/usr/bin/env python3
"""
Resolve Bridge - TCP socket server that runs INSIDE DaVinci Resolve.

Place in Scripts/Utility, then in Resolve:
  Workspace > Scripts > Utility > resolve_bridge

Listens on localhost:9876 for the MCP server to connect.
"""

import sys
import os
import json
import traceback
import socket
import threading

BRIDGE_PORT = 9876

_RESOLVE = None

def get_resolve():
    global _RESOLVE
    if _RESOLVE is not None:
        return _RESOLVE
    try:
        import DaVinciResolveScript as dvr
        _RESOLVE = dvr.scriptapp("Resolve")
        return _RESOLVE
    except ImportError:
        return None

def require_resolve():
    r = get_resolve()
    if r is None:
        raise RuntimeError(
            "DaVinci Resolve refused the scripting connection. Almost always this means "
            "external scripting is disabled (the default).\n"
            "Fix: in DaVinci Resolve open Preferences (Ctrl+,) -> System -> General -> "
            "set 'External scripting using' to Local -> Save. No restart needed; just retry the tool."
        )
    return r

def project_list():
    r = require_resolve()
    pm = r.GetProjectManager()
    count = pm.GetProjectListCount()
    projects = []
    for i in range(count):
        name = pm.GetProjectList()[i] if hasattr(pm, 'GetProjectList') else pm.GetProjectNameByIndex(i + 1)
        projects.append(name)
    return projects

def timeline_info(timeline=None):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        raise RuntimeError("No project open")
    tl = timeline if timeline else proj.GetCurrentTimeline()
    if tl is None:
        raise RuntimeError("No timeline in current project")
    return {
        "name": tl.GetName(),
        "duration": tl.GetDuration(),
        "start_timecode": tl.GetStartTimecode(),
        "video_track_count": tl.GetTrackCount("video"),
        "audio_track_count": tl.GetTrackCount("audio"),
        "subtitle_track_count": tl.GetTrackCount("subtitle"),
    }

# ── Tool handlers ────────────────────────────────────────────────────────

def handle_get_info(args):
    r = require_resolve()
    projects = project_list()
    current = None
    try:
        proj = r.GetCurrentProject()
        current = proj.GetName() if proj else None
    except Exception:
        pass
    info = {"current_project": current, "project_count": len(projects), "projects": projects}
    if current:
        try:
            proj = r.GetCurrentProject()
            info["timeline_count"] = proj.GetTimelineCount()
            tl = proj.GetCurrentTimeline()
            if tl:
                info["current_timeline"] = timeline_info(tl)
        except Exception:
            pass
    return {"content": [{"type": "text", "text": json.dumps(info, indent=2)}]}

def handle_load_project(args):
    name = args.get("name", "")
    if not name:
        return {"content": [{"type": "text", "text": '"name" is required'}], "isError": True}
    r = require_resolve()
    pm = r.GetProjectManager()
    if pm.LoadProject(name):
        return {"content": [{"type": "text", "text": f"Loaded project: {name}"}]}
    return {"content": [{"type": "text", "text": f"Failed to load project: {name}"}], "isError": True}

def handle_create_project(args):
    name = args.get("name", "")
    if not name:
        return {"content": [{"type": "text", "text": '"name" is required'}], "isError": True}
    r = require_resolve()
    pm = r.GetProjectManager()
    proj = pm.CreateProject(name)
    if proj:
        return {"content": [{"type": "text", "text": f"Created project: {name}"}]}
    return {"content": [{"type": "text", "text": f"Failed to create project: {name}"}], "isError": True}

def handle_save_project(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return {"content": [{"type": "text", "text": "No project open"}], "isError": True}
    if proj.SaveProject():
        return {"content": [{"type": "text", "text": f"Saved project: {proj.GetName()}"}]}
    return {"content": [{"type": "text", "text": "Failed to save project"}], "isError": True}

def handle_project_info(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return {"content": [{"type": "text", "text": "No project open"}], "isError": True}
    info = {
        "name": proj.GetName(),
        "timeline_count": proj.GetTimelineCount(),
        "render_job_count": proj.GetRenderJobCount(),
        "render_preset_count": proj.GetRenderPresetCount(),
    }
    return {"content": [{"type": "text", "text": json.dumps(info, indent=2)}]}

def handle_import_media(args):
    paths = args.get("paths", [])
    if isinstance(paths, str):
        paths = [paths]
    if not paths:
        return {"content": [{"type": "text", "text": '"paths" is required'}], "isError": True}
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return {"content": [{"type": "text", "text": "No project open"}], "isError": True}
    ms = r.GetMediaStorage()
    items = []
    for p in paths:
        abs_path = os.path.abspath(os.path.expanduser(p))
        if not os.path.isfile(abs_path):
            items.append({"path": p, "status": "not found"})
            continue
        result = ms.AddItemToMediaPool(abs_path)
        items.append({"path": p, "status": "imported" if result else "failed"})
    return {"content": [{"type": "text", "text": json.dumps(items, indent=2)}]}

def handle_media_pool_list(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return {"content": [{"type": "text", "text": "No project open"}], "isError": True}
    mp = proj.GetMediaPool()
    root = mp.GetRootFolder()
    if root is None:
        return {"content": [{"type": "text", "text": "[]"}]}
    clips = root.GetClipList()
    result = []
    for clip in clips or []:
        result.append({"name": clip.GetName(), "duration": clip.GetDuration()})
    return {"content": [{"type": "text", "text": json.dumps(result, indent=2)}]}

def handle_create_timeline(args):
    name = args.get("name", "Timeline 1")
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return {"content": [{"type": "text", "text": "No project open"}], "isError": True}
    mp = proj.GetMediaPool()
    tl = mp.CreateEmptyTimeline(name)
    if tl:
        return {"content": [{"type": "text", "text": f"Created timeline: {name}"}]}
    return {"content": [{"type": "text", "text": f"Failed to create timeline: {name}"}], "isError": True}

def handle_get_timeline_info(args):
    return {"content": [{"type": "text", "text": json.dumps(timeline_info(), indent=2)}]}

def handle_set_timecode(args):
    tc = args.get("timecode", "")
    if not tc:
        return {"content": [{"type": "text", "text": '"timecode" is required (HH:MM:SS:FF)'}], "isError": True}
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return {"content": [{"type": "text", "text": "No project open"}], "isError": True}
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return {"content": [{"type": "text", "text": "No timeline"}], "isError": True}
    if tl.SetCurrentTimecode(tc):
        return {"content": [{"type": "text", "text": f"Set timecode to {tc}"}]}
    return {"content": [{"type": "text", "text": f"Failed to set timecode"}], "isError": True}

def handle_get_timecode(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return {"content": [{"type": "text", "text": "No project open"}], "isError": True}
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return {"content": [{"type": "text", "text": "No timeline"}], "isError": True}
    tc = tl.GetCurrentTimecode()
    return {"content": [{"type": "text", "text": tc or "00:00:00:00"}]}

def handle_add_clip_to_timeline(args):
    clip_name = args.get("clip_name", "")
    if not clip_name:
        return {"content": [{"type": "text", "text": '"clip_name" is required'}], "isError": True}
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return {"content": [{"type": "text", "text": "No project open"}], "isError": True}
    mp = proj.GetMediaPool()
    root = mp.GetRootFolder()
    clips = root.GetClipList() if root else []
    target = None
    for clip in clips or []:
        if clip.GetName() == clip_name:
            target = clip
            break
    if target is None:
        return {"content": [{"type": "text", "text": f"Clip not found: {clip_name}"}], "isError": True}
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return {"content": [{"type": "text", "text": "No timeline"}], "isError": True}
    item = mp.AppendToTimeline([target])
    if item:
        return {"content": [{"type": "text", "text": f'Added clip "{clip_name}" to timeline'}]}
    return {"content": [{"type": "text", "text": "Failed to add clip"}], "isError": True}

def handle_add_transition(args):
    clip_index = args.get("clip_index", 1)
    duration = args.get("duration", 15)
    transition_type = args.get("type", "cross dissolve")
    track_type = args.get("track_type", "video")
    track_index = args.get("track_index", 1)
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return {"content": [{"type": "text", "text": "No project open"}], "isError": True}
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return {"content": [{"type": "text", "text": "No timeline"}], "isError": True}
    result = tl.AddTransition(clip_index, transition_type, duration, track_type, track_index)
    if result:
        return {"content": [{"type": "text", "text": f"Added {transition_type} transition at clip {clip_index}"}]}
    return {"content": [{"type": "text", "text": "Failed to add transition"}], "isError": True}

def handle_add_title(args):
    text = args.get("text", "Title")
    duration = args.get("duration", 100)
    position = args.get("position", 1)
    track_index = args.get("track_index", 1)
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return {"content": [{"type": "text", "text": "No project open"}], "isError": True}
    mp = proj.GetMediaPool()
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return {"content": [{"type": "text", "text": "No timeline"}], "isError": True}
    result = mp.AddTitleToTimeline(text, duration, track_index, position)
    if result:
        return {"content": [{"type": "text", "text": f'Added title "{text}" to timeline'}]}
    return {"content": [{"type": "text", "text": "Failed to add title"}], "isError": True}

def handle_render_presets(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return {"content": [{"type": "text", "text": "No project open"}], "isError": True}
    presets = proj.GetRenderPresetList()
    return {"content": [{"type": "text", "text": json.dumps(presets, indent=2) if presets else "[]"}]}

def handle_add_render_job(args):
    preset_index = args.get("preset_index", 1)
    render_path = args.get("render_path", "")
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return {"content": [{"type": "text", "text": "No project open"}], "isError": True}
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return {"content": [{"type": "text", "text": "No timeline"}], "isError": True}
    if render_path:
        proj.SetRenderSettings({"TargetDir": os.path.abspath(os.path.expanduser(render_path))})
    job_id = proj.AddRenderJob(preset_index)
    if job_id is not None:
        return {"content": [{"type": "text", "text": json.dumps({"job_id": job_id, "preset_index": preset_index})}]}
    return {"content": [{"type": "text", "text": "Failed to add render job"}], "isError": True}

def handle_start_render(args):
    job_id = args.get("job_id")
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return {"content": [{"type": "text", "text": "No project open"}], "isError": True}
    if job_id is not None:
        proj.StartRendering(job_id)
    else:
        proj.StartRendering()
    return {"content": [{"type": "text", "text": "Render started"}]}

def handle_render_status(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return {"content": [{"type": "text", "text": "No project open"}], "isError": True}
    job_id = args.get("job_id")
    if job_id is not None:
        status = proj.GetRenderJobStatus(job_id)
        return {"content": [{"type": "text", "text": json.dumps(status, indent=2) if status else "{}"}]}
    is_rendering = proj.IsRenderingInProgress()
    return {"content": [{"type": "text", "text": json.dumps({"is_rendering": is_rendering}, indent=2)}]}

def handle_delete_clip(args):
    clip_index = args.get("clip_index", 1)
    track_type = args.get("track_type", "video")
    track_index = args.get("track_index", 1)
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return {"content": [{"type": "text", "text": "No project open"}], "isError": True}
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return {"content": [{"type": "text", "text": "No timeline"}], "isError": True}
    result = tl.DeleteClips(clip_index, track_type, track_index)
    if result:
        return {"content": [{"type": "text", "text": f"Deleted clip at index {clip_index}"}]}
    return {"content": [{"type": "text", "text": "Failed to delete clip"}], "isError": True}

# ── Tool registry ────────────────────────────────────────────────────────

TOOLS = [
    {"name": "resolve_get_info", "description": "Get Resolve version, current project, timeline info, and list all projects", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "resolve_load_project", "description": "Load an existing project by name", "inputSchema": {"type": "object", "required": ["name"], "properties": {"name": {"type": "string", "description": "Project name"}}}},
    {"name": "resolve_create_project", "description": "Create a new project", "inputSchema": {"type": "object", "required": ["name"], "properties": {"name": {"type": "string", "description": "Project name"}}}},
    {"name": "resolve_save_project", "description": "Save the current project", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "resolve_project_info", "description": "Get project metadata (timeline count, render jobs, etc.)", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "resolve_import_media", "description": "Import media files into the Media Pool", "inputSchema": {"type": "object", "required": ["paths"], "properties": {"paths": {"oneOf": [{"type": "string"}, {"type": "array", "items": {"type": "string"}}], "description": "File path(s) to import"}}}},
    {"name": "resolve_media_pool_list", "description": "List all clips in the Media Pool root folder", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "resolve_create_timeline", "description": "Create a new empty timeline", "inputSchema": {"type": "object", "properties": {"name": {"type": "string", "description": "Timeline name"}}}},
    {"name": "resolve_get_timeline_info", "description": "Get current timeline details: name, duration, timecode, track counts", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "resolve_set_timecode", "description": "Move the playhead to a specific timecode (HH:MM:SS:FF)", "inputSchema": {"type": "object", "required": ["timecode"], "properties": {"timecode": {"type": "string", "description": "Timecode HH:MM:SS:FF"}}}},
    {"name": "resolve_get_timecode", "description": "Get the current playhead timecode", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "resolve_add_clip_to_timeline", "description": "Find a clip by name in Media Pool and append it to the timeline", "inputSchema": {"type": "object", "required": ["clip_name"], "properties": {"clip_name": {"type": "string", "description": "Clip name from Media Pool"}}}},
    {"name": "resolve_add_transition", "description": "Add a transition between clips on the timeline", "inputSchema": {"type": "object", "properties": {"clip_index": {"type": "number"}, "duration": {"type": "number"}, "type": {"type": "string"}, "track_type": {"type": "string", "enum": ["video", "audio"]}, "track_index": {"type": "number"}}}},
    {"name": "resolve_add_title", "description": "Add a text title/generator to the timeline", "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}, "duration": {"type": "number"}, "position": {"type": "number"}, "track_index": {"type": "number"}}}},
    {"name": "resolve_get_render_presets", "description": "List available render presets", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "resolve_add_render_job", "description": "Add a render job to the queue", "inputSchema": {"type": "object", "properties": {"preset_index": {"type": "number"}, "render_path": {"type": "string"}}}},
    {"name": "resolve_start_render", "description": "Start rendering queued jobs", "inputSchema": {"type": "object", "properties": {"job_id": {"type": "number"}}}},
    {"name": "resolve_render_status", "description": "Check if rendering is in progress or get job status", "inputSchema": {"type": "object", "properties": {"job_id": {"type": "number"}}}},
    {"name": "resolve_delete_clip", "description": "Delete a clip from the timeline", "inputSchema": {"type": "object", "properties": {"clip_index": {"type": "number"}, "track_type": {"type": "string", "enum": ["video", "audio"]}, "track_index": {"type": "number"}}}},
]

HANDLERS = {
    "resolve_get_info": handle_get_info,
    "resolve_load_project": handle_load_project,
    "resolve_create_project": handle_create_project,
    "resolve_save_project": handle_save_project,
    "resolve_project_info": handle_project_info,
    "resolve_import_media": handle_import_media,
    "resolve_media_pool_list": handle_media_pool_list,
    "resolve_create_timeline": handle_create_timeline,
    "resolve_get_timeline_info": handle_get_timeline_info,
    "resolve_set_timecode": handle_set_timecode,
    "resolve_get_timecode": handle_get_timecode,
    "resolve_add_clip_to_timeline": handle_add_clip_to_timeline,
    "resolve_add_transition": handle_add_transition,
    "resolve_add_title": handle_add_title,
    "resolve_get_render_presets": handle_render_presets,
    "resolve_add_render_job": handle_add_render_job,
    "resolve_start_render": handle_start_render,
    "resolve_render_status": handle_render_status,
    "resolve_delete_clip": handle_delete_clip,
}

# ── TCP server ───────────────────────────────────────────────────────────

def handle_client(conn):
    buf = ""
    while True:
        try:
            data = conn.recv(65536)
        except Exception:
            break
        if not data:
            break
        buf += data.decode("utf-8")
        while "\n" in buf:
            raw, buf = buf.split("\n", 1)
            raw = raw.strip()
            if not raw:
                continue
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            msg_id = msg.get("id")
            method = msg.get("method", "")
            params = msg.get("params", {})
            if method == "initialize":
                send_conn(conn, {"jsonrpc": "2.0", "id": msg_id, "result": {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "axion-davinci-resolve-bridge", "version": "1.0.0"}}})
            elif method == "notifications/initialized":
                pass
            elif method == "tools/list":
                send_conn(conn, {"jsonrpc": "2.0", "id": msg_id, "result": {"tools": TOOLS}})
            elif method == "tools/call":
                name = params.get("name", "")
                args = params.get("arguments", {})
                handler = HANDLERS.get(name)
                if handler is None:
                    send_conn(conn, {"jsonrpc": "2.0", "id": msg_id, "result": {"content": [{"type": "text", "text": f"Unknown tool: {name}"}], "isError": True}})
                    continue
                try:
                    result = handler(args)
                    send_conn(conn, {"jsonrpc": "2.0", "id": msg_id, "result": result})
                except RuntimeError as e:
                    # Expected operational errors (no project, scripting disabled…) — message only, no traceback noise
                    send_conn(conn, {"jsonrpc": "2.0", "id": msg_id, "result": {"content": [{"type": "text", "text": str(e)}], "isError": True}})
                except Exception as e:
                    send_conn(conn, {"jsonrpc": "2.0", "id": msg_id, "result": {"content": [{"type": "text", "text": f"{e}\n{traceback.format_exc()}"}], "isError": True}})
            elif msg_id is not None:
                send_conn(conn, {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32601, "message": f"Unknown method: {method}"}})
    conn.close()

def send_conn(conn, msg):
    data = json.dumps(msg, default=str) + "\n"
    conn.sendall(data.encode("utf-8"))

def main():
    r = get_resolve()
    if r is not None:
        print("Resolve connected: " + r.GetVersionString())
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", BRIDGE_PORT))
    server.listen(4)
    server.settimeout(1.0)
    print("Bridge listening on 127.0.0.1:" + str(BRIDGE_PORT))
    print("Axion MCP server can now connect. Keep this window/console open.")
    try:
        while True:
            try:
                conn, addr = server.accept()
                print("Client connected from " + str(addr))
                # Thread per client — a stale/hung client must never starve the
                # accept loop (connects would still succeed via the backlog but
                # never get served, which looks like a mystery timeout).
                threading.Thread(target=handle_client, args=(conn,), daemon=True).start()
            except socket.timeout:
                continue
    except KeyboardInterrupt:
        pass
    finally:
        server.close()
        print("Bridge stopped")

if __name__ == "__main__":
    main()
