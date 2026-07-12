import { execSync } from 'child_process';

export function findServerForFile(filePath) {
  const ext = filePath?.split('.').pop()?.toLowerCase();
  if (!ext) return null;

  const LANG_CONFIG = {
    js:  { command: 'typescript-language-server', args: ['--stdio'] },
    jsx: { command: 'typescript-language-server', args: ['--stdio'] },
    ts:  { command: 'typescript-language-server', args: ['--stdio'] },
    tsx: { command: 'typescript-language-server', args: ['--stdio'] },
    mjs: { command: 'typescript-language-server', args: ['--stdio'] },
    cjs: { command: 'typescript-language-server', args: ['--stdio'] },
    mts: { command: 'typescript-language-server', args: ['--stdio'] },
    cts: { command: 'typescript-language-server', args: ['--stdio'] },
    py:  { command: 'pyright-langserver', args: ['--stdio'] },
    go:  { command: 'gopls', args: [] },
    rs:  { command: 'rust-analyzer', args: [] },
    rb:  { command: 'solargraph', args: ['socket', '--port', '0'] },
    java: { command: 'eclipse-jdtls', args: [] },
    php: { command: 'phpactor', args: ['language-server'] },
    css: { command: 'vscode-css-language-server', args: ['--stdio'] },
    scss: { command: 'vscode-css-language-server', args: ['--stdio'] },
    less: { command: 'vscode-css-language-server', args: ['--stdio'] },
    vue: { command: 'vscode-vue-language-server', args: ['--stdio'] },
    svelte: { command: 'svelte-language-server', args: ['--stdio'] },
    json: { command: 'vscode-json-language-server', args: ['--stdio'] },
    yaml: { command: 'yaml-language-server', args: ['--stdio'] },
    yml:  { command: 'yaml-language-server', args: ['--stdio'] },
    md:  { command: 'marksman', args: [] },
  };

  const cfg = LANG_CONFIG[ext];
  if (!cfg) return null;

  return cfg;
}

export function getLanguageId(filePath) {
  const ext = filePath?.split('.').pop()?.toLowerCase();
  const LANG_IDS = {
    js: 'javascript', jsx: 'javascriptreact',
    ts: 'typescript', tsx: 'typescriptreact',
    mjs: 'javascript', cjs: 'javascript',
    mts: 'typescript', cts: 'typescript',
    py: 'python', go: 'go', rs: 'rust',
    rb: 'ruby', java: 'java', php: 'php',
    css: 'css', scss: 'scss', less: 'less',
    vue: 'vue', svelte: 'svelte',
    json: 'json', yaml: 'yaml', yml: 'yaml',
    md: 'markdown',
  };
  return LANG_IDS[ext] || null;
}

export function isServerInstalled(command) {
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    execSync(`${which} ${command}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
