// Framework-agnostic helpers for tool-confirmation prompts. Shared by the Ink and
// OpenTUI UIs. permissionKey scopes the "always allow" list (shell commands by
// binary); confirmLabel is the short human label shown in the confirm prompt.

export function permissionKey(name, input) {
  if (name === 'run_command') {
    const tokens = (input?.command || '').trim().split(/\s+/);
    const bin = tokens[0];
    if (!bin) return 'run_command';
    // Include up to 2 tokens so git commit ≠ git push, etc.
    return tokens.length >= 2 ? `run_command:${bin}:${tokens[1]}` : `run_command:${bin}`;
  }
  return name;
}

export function confirmLabel(name, input) {
  if (!input) return '';
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'patch_file':   return input.path || '';
    case 'delete_file':  return input.path || '';
    case 'move_file':    return `${input.from} → ${input.to}`;
    case 'list_directory': return input.path || '.';
    case 'run_command':  return `\`${(input.command || '').slice(0, 60)}\``;
    case 'git_commit':   return `"${(input.message || '').slice(0, 50)}"`;
    case 'web_search':   return `"${(input.query || '').slice(0, 60)}"`;
    case 'fetch_url':    return input.url || '';
    case 'screenshot':   return `"${(input.question || '').slice(0, 60)}"`;
    case 'click_on':     return `"${(input.target || '').slice(0, 60)}"`;
    case 'click_at':     return `(${input.x}, ${input.y})`;
    case 'type_text':    return `"${(input.text || '').slice(0, 40)}"`;
    case 'press_key':    return input.keys || '';
    case 'scroll':       return `(${input.x}, ${input.y}) ${input.direction || 'down'}`;
    case 'find_text':    return `"${(input.text || '').slice(0, 60)}"${input.click ? ' + click' : ''}`;
    default: return '';
  }
}
