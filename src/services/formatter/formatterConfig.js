// Formatter configuration schema and defaults.
// Each rule maps file extensions to a formatter command.
// The `{file}` placeholder is replaced with the absolute file path.
//
// Config format:
//   FORMATTERS = {
//     disabled: false,
//     rules: [
//       { extensions: ['.js', '.ts'], command: ['npx', 'prettier', '--write', '{file}'] },
//       { extensions: ['.py'],        command: ['python', '-m', 'black', '-q', '{file}'] },
//       { extensions: ['.go'],        command: ['gofmt', '-w', '{file}'] },
//     ]
//   }

export const DEFAULT_FORMATTERS = {
  disabled: false,
  rules: [
    {
      extensions: ['.js', '.jsx', '.ts', '.tsx', '.json', '.css', '.html', '.md', '.yaml', '.yml'],
      command: ['npx', 'prettier', '--write', '{file}'],
    },
    {
      extensions: ['.py'],
      command: ['python', '-m', 'black', '-q', '{file}'],
    },
    {
      extensions: ['.go'],
      command: ['gofmt', '-w', '{file}'],
    },
  ],
};

export const DEFAULT_FORMATTER_CONFIG = {
  disabled: false,
  rules: [
    { extensions: ['.js', '.jsx', '.ts', '.tsx', '.json', '.css', '.html', '.md', '.yaml', '.yml'], command: ['npx', 'prettier', '--write', '{file}'] },
    { extensions: ['.py'], command: ['python', '-m', 'black', '-q', '{file}'] },
    { extensions: ['.go'], command: ['gofmt', '-w', '{file}'] },
  ],
};
