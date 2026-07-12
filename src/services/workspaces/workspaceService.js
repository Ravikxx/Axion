// Workspace service — routes a workspace id to its project context
// (working directory) and tracks the active workspace for the session.
//
// The active workspace id is persisted in config.json (via persist.js). On
// agent startup, the active workspace's path becomes the agent's working
// directory, scoping sessions/snapshots/state to that project. Switching
// workspaces updates the active id and the cwd.

import {
  listWorkspaces, getWorkspace, createWorkspace, removeWorkspace,
  touchWorkspace, findWorkspaceByPath,
} from './workspaceStore.js';
import {
  getCurrentWorkspaceId, setCurrentWorkspaceId,
} from '../../persist.js';

export function activeWorkspace() {
  const id = getCurrentWorkspaceId();
  if (!id) return null;
  return getWorkspace(id);
}

// Resolve the path to use as the agent's cwd for this session. Falls back to
// process.cwd() when no workspace is active.
export function activeWorkspacePath() {
  const ws = activeWorkspace();
  return ws?.path || process.cwd();
}

export function switchWorkspace(id) {
  const ws = getWorkspace(id);
  if (!ws) throw new Error(`Unknown workspace: ${id}`);
  setCurrentWorkspaceId(id);
  touchWorkspace(id);
  return ws;
}

// Activate (or create) a workspace for an arbitrary path. If a workspace
// already points at this path, reuse it; otherwise create one with a name
// derived from the directory basename.
export function activateForPath(path, { name } = {}) {
  const existing = findWorkspaceByPath(path);
  if (existing) {
    setCurrentWorkspaceId(existing.id);
    touchWorkspace(existing.id);
    return existing;
  }
  const derived = name || (path.split('/').filter(Boolean).pop() || 'workspace');
  const ws = createWorkspace({ name: derived, path });
  setCurrentWorkspaceId(ws.id);
  return ws;
}

export function clearActiveWorkspace() {
  setCurrentWorkspaceId(null);
}

export {
  listWorkspaces, getWorkspace, createWorkspace, removeWorkspace,
} from './workspaceStore.js';