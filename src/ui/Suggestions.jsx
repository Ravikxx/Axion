import React from 'react';
import { Box, Text } from 'ink';

export const COMMANDS = [
  { cmd: 'help',            desc: 'show all commands' },
  { cmd: 'model',           desc: '<name|id>  switch model' },
  { cmd: 'mode',            desc: '<name>  ask · plan · bypass' },
  { cmd: 'api',             desc: '<model> <key>  set API key' },
  { cmd: 'endpoint',        desc: '<name> <url> [model] [key]  add/list custom endpoints' },
  { cmd: 'thinking',        desc: '[on|off|<tokens>]  toggle extended thinking' },
  { cmd: 'adviser',         desc: '[model|auto|off]  set adviser model' },
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
  { cmd: 'save',            desc: '<name>  save current chat' },
  { cmd: 'resume',          desc: '<name>  resume saved chat  (no args = list)' },
  { cmd: 'search-chats',    desc: '<query>  search across all saved chats' },
  { cmd: 'remove-chat',     desc: '<name>  delete a saved chat' },
  { cmd: 'compact',         desc: 'summarize & compress history' },
  { cmd: 'btw',             desc: '<question>  quick side question' },
  { cmd: 'oauth',           desc: 'connect|list|revoke  GitHub · Google · Notion · Slack' },
  { cmd: 'schedule',        desc: 'list|add|run|remove|enable|disable|results  scheduled tasks' },
  { cmd: 'web',             desc: '[port|stop]  open/stop web UI in browser' },
  { cmd: 'blender',         desc: 'setup|connect  Blender MCP integration' },
  { cmd: 'mcp',             desc: 'browse|search|install|toggle|enable|disable|remove|tools|reload' },
  { cmd: 'clear',           desc: 'clear history' },
  { cmd: 'exit',            desc: 'quit' },
];

export function getSuggestions(inputValue) {
  if (!inputValue.startsWith('/')) return [];
  const query = inputValue.slice(1).split(' ')[0].toLowerCase();
  if (query === '') return COMMANDS;
  return COMMANDS.filter((c) => c.cmd.startsWith(query));
}

export function getTabCompletion(inputValue) {
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
          <Text color="gray" dimColor>{s.desc}</Text>
          {i === 0 && matches.length > 1 && query !== s.cmd && (
            <Text color="gray" dimColor>  tab to complete</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}
