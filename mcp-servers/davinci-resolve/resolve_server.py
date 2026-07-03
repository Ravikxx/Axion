#!/usr/bin/env python3.13
"""DaVinci Resolve MCP server — speaks MCP protocol (JSON-RPC 2.0) over stdio.

Usage
-----
  python3.13 resolve_server.py

Requires DaVinci Resolve 18+ running on the same machine.
Requires Python 3.13 (matching the fusionscript.dll ABI).

Environment
-----------
  RESOLVE_SCRIPT_API  Path to the DaVinci Resolve Scripting API Modules directory
  RESOLVE_SCRIPT_LIB  Path to the DaVinci Resolve scripting library (fbs.so/fbs.dll).
"""

import sys
import os
import json
import traceback
import platform
import socket
import threading
import time

_RESOLVE = None

def _find_resolve_lib():
    """Locate fusionscript.dll and set RESOLVE_SCRIPT_LIB so the wrapper can load it."""
    lib = os.environ.get('RESOLVE_SCRIPT_LIB')
    if lib and os.path.isfile(lib):
        return lib
    candidates = []
    if sys.platform == 'win32':
        for base in [
            os.environ.get('PROGRAMFILES', 'C:\\Program Files'),
            os.environ.get('PROGRAMFILES(X86)', 'C:\\Program Files (x86)'),
            'E:\\', 'D:\\', 'C:\\',
        ]:
            p = os.path.join(base, 'Blackmagic Design', 'DaVinci Resolve', 'fusionscript.dll')
            candidates.append(p)
            candidates.append(os.path.join(base, 'fusionscript.dll'))
        candidates.append(os.path.join(os.environ.get('PROGRAMDATA', ''), 'Blackmagic Design', 'DaVinci Resolve', 'Support', 'Developer', 'Scripting', 'Modules', 'fusionscript.dll'))
        # Try locating via Resolve.exe in PATH or common locations
        for d in os.environ.get('PATH', '').split(';'):
            d = d.strip().strip('"')
            if d and os.path.isfile(os.path.join(d, 'fusionscript.dll')):
                candidates.append(os.path.join(d, 'fusionscript.dll'))
    elif sys.platform == 'darwin':
        candidates.append('/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.dylib')
    else:
        candidates.append('/opt/resolve/libs/Fusion/fusionscript.so')

    for c in candidates:
        if c and os.path.isfile(c):
            os.environ['RESOLVE_SCRIPT_LIB'] = c
            return c
    return None

def _find_resolve_module():
    api = os.environ.get('RESOLVE_SCRIPT_API')
    if api and os.path.isdir(api):
        return api
    candidates = []
    if sys.platform == 'win32':
        base = os.environ.get('PROGRAMDATA', '')
        candidates.append(os.path.join(base, 'Blackmagic Design', 'DaVinci Resolve', 'Support', 'Developer', 'Scripting', 'Modules'))
    elif sys.platform == 'darwin':
        candidates.append('/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules')
        candidates.append(os.path.expanduser('~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules'))
    else:
        candidates.append('/opt/resolve/Developer/Scripting/Modules')
        candidates.append('/opt/resolve/libs/Fusion/Modules')
    for p in candidates:
        if os.path.isdir(p):
            return p
    return None

def get_resolve():
    global _RESOLVE
    if _RESOLVE is not None:
        return _RESOLVE
    lib_path = _find_resolve_lib()
    mod_path = _find_resolve_module()
    if lib_path and sys.platform == 'win32':
        lib_dir = os.path.dirname(lib_path)
        os.environ['PATH'] = lib_dir + os.pathsep + os.environ.get('PATH', '')
        try:
            os.add_dll_directory(lib_dir)
        except AttributeError:
            pass
    if mod_path and mod_path not in sys.path:
        sys.path.insert(0, mod_path)
    try:
        import DaVinciResolveScript as dvr
    except ImportError:
        _resolve_diagnose('import DaVinciResolveScript failed')
        return None
    try:
        _RESOLVE = dvr.scriptapp('Resolve')
    except Exception as e:
        _resolve_diagnose(f'scriptapp("Resolve") raised: {e}')
        return None
    if _RESOLVE is None:
        _resolve_diagnose('scriptapp("Resolve") returned None — Resolve is not accepting scripting connections')
    return _RESOLVE

def _resolve_diagnose(msg):
    if sys.version_info[:2] != (3, 13):
        from_ver = '.'.join(str(v) for v in sys.version_info[:2])
        raise RuntimeError(
            f'Python {from_ver} is incompatible with fusionscript.dll (requires Python 3.13).\n'
            f'Use /resolve status to auto-configure, or run the server manually with:\n'
            f'  python3.13 mcp-servers/davinci-resolve/resolve_server.py'
        )
    raise RuntimeError(
        f'Cannot connect to DaVinci Resolve.\n'
        f'{msg}\n\n'
        f'Troubleshooting:\n'
        f'  1. Is Resolve running? (start it)\n'
        f'  2. Enable external scripting: Resolve -> Preferences (Ctrl+,) -> System -> General\n'
        f'     -> "External scripting using" -> Local -> Save (no restart needed)\n'
        f'  3. Run /resolve in Axion to (re)start the bridge, then retry'
    )

def require_resolve():
    r = get_resolve()
    if r is None:
        raise RuntimeError('Cannot connect to DaVinci Resolve. Is it running?')
    return r

def _try_bridge():
    """Try connecting to the resolve_bridge.py TCP server."""
    try:
        s = socket.create_connection(('127.0.0.1', 9876), timeout=2)
        s.settimeout(None)
        return s
    except socket.timeout:
        return None
    except ConnectionRefusedError:
        return None
    except OSError:
        return None

_BRIDGE = {'sock': None, 'buf': b''}
_BRIDGE_LOCK = threading.Lock()

def _bridge_request(msg, timeout=25):
    """Send one JSON-RPC message to the bridge and return its decoded reply,
    or None if no bridge is reachable. Reconnects once on a broken socket."""
    with _BRIDGE_LOCK:
        for attempt in (1, 2):
            sock = _BRIDGE['sock']
            if sock is None:
                sock = _try_bridge()
                if sock is None:
                    return None
                _BRIDGE['sock'] = sock
                _BRIDGE['buf'] = b''
            try:
                sock.settimeout(timeout)
                sock.sendall((json.dumps(msg, default=str) + '\n').encode('utf-8'))
                buf = _BRIDGE['buf']
                while b'\n' not in buf:
                    data = sock.recv(65536)
                    if not data:
                        raise ConnectionError('bridge closed')
                    buf += data
                line, _BRIDGE['buf'] = buf.split(b'\n', 1)
                return json.loads(line.decode('utf-8'))
            except Exception:
                try:
                    sock.close()
                except Exception:
                    pass
                _BRIDGE['sock'] = None
                _BRIDGE['buf'] = b''
                if attempt == 2:
                    return None
    return None

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
        raise RuntimeError('No project open')
    tl = timeline if timeline else proj.GetCurrentTimeline()
    if tl is None:
        raise RuntimeError('No timeline in current project')
    return {
        'name': tl.GetName(),
        'duration': tl.GetDuration(),
        'start_timecode': tl.GetStartTimecode(),
        'video_track_count': tl.GetTrackCount('video'),
        'audio_track_count': tl.GetTrackCount('audio'),
        'subtitle_track_count': tl.GetTrackCount('subtitle'),
    }

def result_text(text):
    return {"content": [{"type": "text", "text": str(text)}]}

def result_error(text):
    return {"content": [{"type": "text", "text": str(text)}], "isError": True}

# ── Tool handlers ────────────────────────────────────────────────────────

def handle_get_resolve_info(args):
    r = require_resolve()
    projects = project_list()
    current = None
    try:
        proj = r.GetCurrentProject()
        current = proj.GetName() if proj else None
    except Exception:
        pass
    info = {
        'current_project': current,
        'project_count': len(projects),
        'projects': projects,
    }
    if current:
        try:
            proj = r.GetCurrentProject()
            info['timeline_count'] = proj.GetTimelineCount()
            tl = proj.GetCurrentTimeline()
            if tl:
                info['current_timeline'] = timeline_info(tl)
        except Exception:
            pass
    return result_text(json.dumps(info, indent=2))

def handle_load_project(args):
    name = args.get('name', '')
    if not name:
        return result_error('"name" is required')
    r = require_resolve()
    pm = r.GetProjectManager()
    if pm.LoadProject(name):
        return result_text(f'Loaded project: {name}')
    return result_error(f'Failed to load project: {name}')

def handle_create_project(args):
    name = args.get('name', '')
    if not name:
        return result_error('"name" is required')
    r = require_resolve()
    pm = r.GetProjectManager()
    proj = pm.CreateProject(name)
    if proj:
        return result_text(f'Created project: {name}')
    return result_error(f'Failed to create project: {name} (may already exist)')

def handle_save_project(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    if proj.SaveProject():
        return result_text(f'Saved project: {proj.GetName()}')
    return result_error('Failed to save project')

def handle_project_info(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    info = {
        'name': proj.GetName(),
        'timeline_count': proj.GetTimelineCount(),
        'render_job_count': proj.GetRenderJobCount(),
        'render_preset_count': proj.GetRenderPresetCount(),
    }
    return result_text(json.dumps(info, indent=2))

def handle_import_media(args):
    paths = args.get('paths', [])
    if isinstance(paths, str):
        paths = [paths]
    if not paths:
        return result_error('"paths" (string or array) is required')
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    ms = r.GetMediaStorage()
    items = []
    for p in paths:
        abs_path = os.path.abspath(os.path.expanduser(p))
        if not os.path.isfile(abs_path):
            items.append({'path': p, 'status': 'not found'})
            continue
        result = ms.AddItemToMediaPool(abs_path)
        items.append({'path': p, 'status': 'imported' if result else 'failed'})
    return result_text(json.dumps(items, indent=2))

def handle_media_pool_list(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    mp = proj.GetMediaPool()
    root = mp.GetRootFolder()
    if root is None:
        return result_text('[]')
    items = root.GetClipList()
    result = []
    for clip in items or []:
        result.append({
            'name': clip.GetName(),
            'duration': clip.GetDuration(),
        })
    return result_text(json.dumps(result, indent=2))

def handle_create_timeline(args):
    name = args.get('name', 'Timeline 1')
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    mp = proj.GetMediaPool()
    tl = mp.CreateEmptyTimeline(name)
    if tl:
        return result_text(f'Created timeline: {name}')
    return result_error(f'Failed to create timeline: {name}')

def handle_get_timeline_info(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return result_error('No timeline')
    return result_text(json.dumps(timeline_info(tl), indent=2))

def handle_set_timecode(args):
    tc = args.get('timecode', '')
    if not tc:
        return result_error('"timecode" is required (HH:MM:SS:FF)')
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return result_error('No timeline')
    if tl.SetCurrentTimecode(tc):
        return result_text(f'Set timecode to {tc}')
    return result_error(f'Failed to set timecode')

def handle_get_timecode(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return result_error('No timeline')
    tc = tl.GetCurrentTimecode()
    return result_text(tc or '00:00:00:00')

def handle_add_clip_to_timeline(args):
    clip_name = args.get('clip_name', '')
    if not clip_name:
        return result_error('"clip_name" is required')
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    mp = proj.GetMediaPool()
    root = mp.GetRootFolder()
    clips = root.GetClipList() if root else []
    target = None
    for clip in clips or []:
        if clip.GetName() == clip_name:
            target = clip
            break
    if target is None:
        return result_error(f'Clip not found: {clip_name}')
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return result_error('No timeline')
    item = mp.AppendToTimeline([target])
    if item:
        return result_text(f'Added clip "{clip_name}" to timeline')
    return result_error('Failed to add clip')

def handle_add_transition(args):
    clip_index = args.get('clip_index', 1)
    duration = args.get('duration', 15)
    transition_type = args.get('type', 'cross dissolve')
    track_type = args.get('track_type', 'video')
    track_index = args.get('track_index', 1)
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return result_error('No timeline')
    result = tl.AddTransition(clip_index, transition_type, duration, track_type, track_index)
    if result:
        return result_text(f'Added {transition_type} transition at clip {clip_index}')
    return result_error('Failed to add transition')

def handle_add_title(args):
    text = args.get('text', 'Title')
    duration = args.get('duration', 100)
    position = args.get('position', 1)
    track_index = args.get('track_index', 1)
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    mp = proj.GetMediaPool()
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return result_error('No timeline')
    result = mp.AddTitleToTimeline(text, duration, track_index, position)
    if result:
        return result_text(f'Added title "{text}" to timeline')
    return result_error('Failed to add title')

def handle_render_presets(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    presets = proj.GetRenderPresetList()
    return result_text(json.dumps(presets, indent=2) if presets else '[]')

def handle_add_render_job(args):
    preset_index = args.get('preset_index', 1)
    render_path = args.get('render_path', '')
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return result_error('No timeline')
    if render_path:
        proj.SetRenderSettings({'TargetDir': os.path.abspath(os.path.expanduser(render_path))})
    job_id = proj.AddRenderJob(preset_index)
    if job_id is not None:
        return result_text(json.dumps({'job_id': job_id, 'preset_index': preset_index}))
    return result_error('Failed to add render job')

def handle_start_render(args):
    job_id = args.get('job_id')
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    if job_id is not None:
        proj.StartRendering(job_id)
    else:
        proj.StartRendering()
    return result_text('Render started')

def handle_render_status(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    job_id = args.get('job_id')
    if job_id is not None:
        status = proj.GetRenderJobStatus(job_id)
        return result_text(json.dumps(status, indent=2) if status else '{}')
    is_rendering = proj.IsRenderingInProgress()
    return result_text(json.dumps({'is_rendering': is_rendering}, indent=2))

def handle_delete_clip(args):
    clip_index = args.get('clip_index', 1)
    track_type = args.get('track_type', 'video')
    track_index = args.get('track_index', 1)
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return result_error('No timeline')
    result = tl.DeleteClips(clip_index, track_type, track_index)
    if result:
        return result_text(f'Deleted clip at index {clip_index}')
    return result_error(f'Failed to delete clip')

# ── Tool registry ────────────────────────────────────────────────────────

TOOLS = [
    {
        'name': 'resolve_get_info',
        'description': 'Get Resolve version, current project, timeline info, and list all projects',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
    {
        'name': 'resolve_load_project',
        'description': 'Load an existing project by name',
        'inputSchema': {'type': 'object', 'required': ['name'], 'properties': {
            'name': {'type': 'string', 'description': 'Project name'},
        }},
    },
    {
        'name': 'resolve_create_project',
        'description': 'Create a new project',
        'inputSchema': {'type': 'object', 'required': ['name'], 'properties': {
            'name': {'type': 'string', 'description': 'Project name'},
        }},
    },
    {
        'name': 'resolve_save_project',
        'description': 'Save the current project',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
    {
        'name': 'resolve_project_info',
        'description': 'Get project metadata (timeline count, render jobs, etc.)',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
    {
        'name': 'resolve_import_media',
        'description': 'Import media files into the Media Pool',
        'inputSchema': {'type': 'object', 'required': ['paths'], 'properties': {
            'paths': {
                'oneOf': [{'type': 'string'}, {'type': 'array', 'items': {'type': 'string'}}],
                'description': 'File path(s) to import',
            },
        }},
    },
    {
        'name': 'resolve_media_pool_list',
        'description': 'List all clips in the Media Pool root folder',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
    {
        'name': 'resolve_create_timeline',
        'description': 'Create a new empty timeline',
        'inputSchema': {'type': 'object', 'properties': {
            'name': {'type': 'string', 'description': 'Timeline name'},
        }},
    },
    {
        'name': 'resolve_get_timeline_info',
        'description': 'Get current timeline details: name, duration, timecode, track counts',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
    {
        'name': 'resolve_set_timecode',
        'description': 'Move the playhead to a specific timecode (HH:MM:SS:FF)',
        'inputSchema': {'type': 'object', 'required': ['timecode'], 'properties': {
            'timecode': {'type': 'string', 'description': 'Timecode HH:MM:SS:FF'},
        }},
    },
    {
        'name': 'resolve_get_timecode',
        'description': 'Get the current playhead timecode',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
    {
        'name': 'resolve_add_clip_to_timeline',
        'description': 'Find a clip by name in Media Pool and append it to the timeline',
        'inputSchema': {'type': 'object', 'required': ['clip_name'], 'properties': {
            'clip_name': {'type': 'string', 'description': 'Clip name from Media Pool'},
        }},
    },
    {
        'name': 'resolve_add_transition',
        'description': 'Add a transition between clips on the timeline',
        'inputSchema': {'type': 'object', 'properties': {
            'clip_index': {'type': 'number', 'description': 'Starting clip index'},
            'duration': {'type': 'number', 'description': 'Duration in frames'},
            'type': {'type': 'string', 'description': 'Transition type (e.g. cross dissolve)'},
            'track_type': {'type': 'string', 'enum': ['video', 'audio']},
            'track_index': {'type': 'number'},
        }},
    },
    {
        'name': 'resolve_add_title',
        'description': 'Add a text title/generator to the timeline',
        'inputSchema': {'type': 'object', 'properties': {
            'text': {'type': 'string', 'description': 'Title text'},
            'duration': {'type': 'number', 'description': 'Duration in frames'},
            'position': {'type': 'number'},
            'track_index': {'type': 'number'},
        }},
    },
    {
        'name': 'resolve_get_render_presets',
        'description': 'List available render presets',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
    {
        'name': 'resolve_add_render_job',
        'description': 'Add a render job to the queue',
        'inputSchema': {'type': 'object', 'properties': {
            'preset_index': {'type': 'number', 'description': 'Preset index (1-based)'},
            'render_path': {'type': 'string', 'description': 'Output directory'},
        }},
    },
    {
        'name': 'resolve_start_render',
        'description': 'Start rendering queued jobs',
        'inputSchema': {'type': 'object', 'properties': {
            'job_id': {'type': 'number'},
        }},
    },
    {
        'name': 'resolve_render_status',
        'description': 'Check if rendering is in progress or get job status',
        'inputSchema': {'type': 'object', 'properties': {
            'job_id': {'type': 'number'},
        }},
    },
    {
        'name': 'resolve_delete_clip',
        'description': 'Delete a clip from the timeline',
        'inputSchema': {'type': 'object', 'properties': {
            'clip_index': {'type': 'number'},
            'track_type': {'type': 'string', 'enum': ['video', 'audio']},
            'track_index': {'type': 'number'},
        }},
    },
]

HANDLERS = {
    'resolve_get_info': handle_get_resolve_info,
    'resolve_load_project': handle_load_project,
    'resolve_create_project': handle_create_project,
    'resolve_save_project': handle_save_project,
    'resolve_project_info': handle_project_info,
    'resolve_import_media': handle_import_media,
    'resolve_media_pool_list': handle_media_pool_list,
    'resolve_create_timeline': handle_create_timeline,
    'resolve_get_timeline_info': handle_get_timeline_info,
    'resolve_set_timecode': handle_set_timecode,
    'resolve_get_timecode': handle_get_timecode,
    'resolve_add_clip_to_timeline': handle_add_clip_to_timeline,
    'resolve_add_transition': handle_add_transition,
    'resolve_add_title': handle_add_title,
    'resolve_get_render_presets': handle_render_presets,
    'resolve_add_render_job': handle_add_render_job,
    'resolve_start_render': handle_start_render,
    'resolve_render_status': handle_render_status,
    'resolve_delete_clip': handle_delete_clip,
}

# ── MCP stdio transport ──────────────────────────────────────────────────

def send(msg):
    sys.stdout.write(json.dumps(msg, default=str) + '\n')
    try:
        sys.stdout.flush()
    except AttributeError:
        pass

def main():
    # CRITICAL TRANSPORT NOTES (this bit stumped multiple debuggers — see git log):
    #
    # 1. Read stdin with readline(), NEVER BufferedReader.read(65536).
    #    read(n) blocks until it has ALL n bytes or hits EOF. A real MCP client
    #    writes one ~150-byte initialize line and keeps the pipe open, so
    #    read(65536) blocks forever and the client times out. Manual testing
    #    with `echo ... | python server.py` closes stdin (EOF), which is why
    #    pipe tests always passed while the real client always hung.
    #
    # 2. Answer initialize/tools/list locally and IMMEDIATELY. Never probe
    #    Resolve (scriptapp/fusionscript.dll takes 4s+, can be worse) before
    #    responding to the handshake. Backends connect lazily on first
    #    tools/call: bridge first (instant), direct scriptapp as fallback.
    while True:
        raw = sys.stdin.buffer.readline()
        if not raw:  # EOF — client closed stdin
            break
        raw = raw.decode('utf-8', errors='replace').strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            continue

        msg_id = msg.get('id')
        method = msg.get('method', '')
        params = msg.get('params', {})

        if method == 'initialize':
            send({
                'jsonrpc': '2.0', 'id': msg_id, 'result': {
                    'protocolVersion': '2024-11-05',
                    'capabilities': {'tools': {}},
                    'serverInfo': {'name': 'axion-davinci-resolve', 'version': '1.1.0'},
                },
            })

        elif method == 'notifications/initialized':
            pass

        elif method == 'tools/list':
            send({'jsonrpc': '2.0', 'id': msg_id, 'result': {'tools': TOOLS}})

        elif method == 'tools/call':
            # Prefer the bridge (runs inside Resolve, always authorized).
            reply = _bridge_request({'jsonrpc': '2.0', 'id': msg_id, 'method': method, 'params': params})
            if reply is not None:
                send(reply)
                continue
            # No bridge — fall back to a direct scriptapp connection.
            name = params.get('name', '')
            args = params.get('arguments', {})
            handler = HANDLERS.get(name)
            if handler is None:
                send({'jsonrpc': '2.0', 'id': msg_id, 'result': result_error(f'Unknown tool: {name}')})
                continue
            try:
                result = handler(args)
                send({'jsonrpc': '2.0', 'id': msg_id, 'result': result})
            except RuntimeError as e:
                # Expected operational errors — message only, no traceback noise
                send({'jsonrpc': '2.0', 'id': msg_id, 'result': result_error(str(e))})
            except Exception as e:
                tb = traceback.format_exc()
                send({'jsonrpc': '2.0', 'id': msg_id, 'result': result_error(f'{e}\n{tb}')})

        elif msg_id is not None:
            send({
                'jsonrpc': '2.0', 'id': msg_id,
                'error': {'code': -32601, 'message': f'Unknown method: {method}'},
            })

if __name__ == '__main__':
    main()
