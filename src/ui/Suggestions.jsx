import React from 'react';
import { Box, Text } from 'ink';
import { readdirSync } from 'fs';
import { getCustomCommands } from '../persist.js';

export const COMMANDS = [
  { cmd: 'help',            desc: 'show all commands' },
  { cmd: 'model',           desc: '<name|id>  switch model' },
  { cmd: 'mode',            desc: '<name>  ask · plan · bypass' },
  { cmd: 'theme',           desc: '[name]  switch accent color (no args = list)' },
  { cmd: 'permissions',     desc: '[clear]  list/reset always-allowed tools' },
  { cmd: 'skills',          desc: '[delete <name>]  list skills (auto-activate on triggers)' },
  { cmd: 'skill-generator', desc: '<name> <instructions>  AI-generate a skill .md' },
  { cmd: 'skill-delete',    desc: '<name>  delete a skill' },
  { cmd: 'api',             desc: '<model> <key>  set API key' },
  { cmd: 'axion-key',       desc: '[key|remove|test]  set/clear/verify Axion API key for Lumen' },
  { cmd: 'login',           desc: 'sign in to Axion Labs via browser (sets API key automatically)' },
  { cmd: 'endpoint',        desc: '<name> <url> [model] [key]  add/list custom endpoints' },
  { cmd: 'thinking',        desc: '[on|off|<tokens>]  toggle extended thinking' },
  { cmd: 'adviser',         desc: '[model|auto|off]  set adviser model' },
  { cmd: 'run',             desc: '<cmd>  run a shell command and feed output to the agent' },
  { cmd: 'pr',              desc: '[context]  draft a PR title+body from recent commits' },
  { cmd: 'computer',        desc: '[on|off]  toggle computer use (screen control)  (alias: /cu)' },
  { cmd: 'cu',              desc: '[on|off]  shortcut for /computer' },
  { cmd: 'vision',          desc: '<model>  set vision model for computer use' },
  { cmd: 'ss',              desc: '[question]  screenshot + describe screen' },
  { cmd: 'img-gen',         desc: '<prompt>  generate an image (OpenAI)' },
  { cmd: 'img-gen-model',   desc: '[model]  set/show image generation model' },
  { cmd: 'macro',           desc: 'record|stop|play|list|delete  manage macros' },
  { cmd: 'watch',           desc: 'start|stop|show|clear  watch-and-learn preferences' },
  { cmd: 'remember',        desc: '[text]  save a persistent note or list all' },
  { cmd: 'forget',          desc: '<number>  remove a saved note' },
  { cmd: 'models',          desc: 'list all available models + custom endpoints' },
  { cmd: 'history',         desc: '<query>  search message history' },
  { cmd: 'system',          desc: '[text|clear]  set extra system instructions' },
  { cmd: 'include',         desc: '<file>  pin file into context  (no args = list)' },
  { cmd: 'compare',         desc: '[m1,m2,...] <prompt>  compare models side by side' },
  { cmd: 'compare-models',  desc: '[m1,m2,...]  get/set default compare models' },
  { cmd: 'review',          desc: 'code review of current git diff' },
  { cmd: 'goal',            desc: '<description>  work until condition is met' },
  { cmd: 'retry',           desc: 're-run the last message' },
  { cmd: 'copy',            desc: 'copy last AI response to clipboard' },
  { cmd: 'copy-block',      desc: '<n>  copy Nth code block from last response' },
  { cmd: 'export',          desc: '<filename>  save chat as markdown' },
  { cmd: 'undo',            desc: 'restore last overwritten/deleted file' },
  { cmd: 'rewind',          desc: '[list|<n>]  undo last n turns of file changes' },
  { cmd: 'save',            desc: '<name>  save current chat' },
  { cmd: 'resume',          desc: '<name>  resume saved chat  (no args = list)' },
  { cmd: 'search-chats',    desc: '<query>  search across all saved chats' },
  { cmd: 'remove-chat',     desc: '<name>  delete a saved chat' },
  { cmd: 'compact',         desc: 'summarize & compress history' },
  { cmd: 'btw',             desc: '<question>  quick side question' },
  { cmd: 'discord',         desc: 'token|start|stop|status  Discord bot — DMs appear in CLI' },
  { cmd: 'oauth',           desc: 'connect|list|revoke  GitHub · Google · Notion · Slack' },
  { cmd: 'schedule',        desc: 'list|add|run|remove|enable|disable|results  scheduled tasks' },
  { cmd: 'web',             desc: '[port|stop]  open/stop web UI in browser' },
  { cmd: 'blender',         desc: 'setup|connect  Blender MCP integration' },
  { cmd: 'mcp',             desc: 'browse|search|install|toggle|enable|disable|remove|tools|reload' },
  { cmd: 'contribute',      desc: 'share this session as training data  (skip | optout)' },
  { cmd: 'cost',            desc: 'show session token usage and estimated cost' },
  { cmd: 'clear',           desc: 'clear history' },
  { cmd: 'exit',            desc: 'quit' },
];

export function getSuggestions(inputValue) {
  if (!inputValue.startsWith('/')) return [];
  const query  = inputValue.slice(1).split(' ')[0].toLowerCase();
  const custom = Object.keys(getCustomCommands())
    .filter((name) => !COMMANDS.some((c) => c.cmd === name))
    .map((name) => ({ cmd: name, desc: 'custom command (.axion/commands)' }));
  const all = [...COMMANDS, ...custom];
  if (query === '') return all;
  return all.filter((c) => c.cmd.startsWith(query));
}

// Complete an @path mention at the end of the input. Returns the full new
// input string, or null if nothing to complete.
function completeAtMention(inputValue) {
  const m = inputValue.match(/(^|\s)@([^\s@]*)$/);
  if (!m) return null;
  const partial = m[2];
  const slash   = partial.lastIndexOf('/');
  const dir     = slash >= 0 ? partial.slice(0, slash + 1) : '';
  const base    = slash >= 0 ? partial.slice(slash + 1) : partial;
  try {
    const entries = readdirSync(dir || '.', { withFileTypes: true })
      .filter(e => e.name.startsWith(base))
      .filter(e => base.startsWith('.') || !e.name.startsWith('.'))
      .filter(e => e.name !== 'node_modules')
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!entries.length) return null;
    const e = entries[0];
    const completed = dir + e.name + (e.isDirectory() ? '/' : ' ');
    if (dir + e.name === partial) return null; // already complete
    return inputValue.slice(0, inputValue.length - partial.length) + completed;
  } catch {
    return null;
  }
}

export function getTabCompletion(inputValue) {
  const atCompletion = completeAtMention(inputValue);
  if (atCompletion) return atCompletion;
  const matches = getSuggestions(inputValue);
  if (!matches.length) return null;
  const top   = matches[0];
  const typed = inputValue.slice(1).split(' ')[0];
  if (typed === top.cmd) return null;
  return `/${top.cmd} `;
}

export function SuggestionBox({ inputValue }) {
  const matches = getSuggestions(inputValue);
  if (!matches.length) return null;

  const query = inputValue.slice(1).split(' ')[0];

  return (
    <Box
      flexDirection="column"
      marginX={2}
      marginBottom={0}
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
    >
      {matches.slice(0, 6).map((s, i) => (
        <Box key={s.cmd} gap={1}>
          <Text color={i === 0 ? 'yellow' : 'gray'} bold={i === 0}>
            {'/'}<Text color={i === 0 ? 'white' : 'gray'} bold={i === 0}>{s.cmd}</Text>
          </Text>
          <Text color="gray">{s.desc}</Text>
          {i === 0 && matches.length > 1 && query !== s.cmd && (
            <Text color="gray">  tab to complete</Text>
          )}
        </Box>
      ))}
      {matches.length > 6 && (
        <Text color="gray">  … {matches.length - 6} more — keep typing to filter</Text>
      )}
    </Box>
  );
}
