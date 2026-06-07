// Curated MCP server marketplace registry
export const MCP_MARKETPLACE = [
  {
    id: 'github',
    name: 'GitHub',
    description: 'Read/write repos, issues, PRs, and files on GitHub',
    category: 'dev',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '$GITHUB_TOKEN' },
    envNote: 'Needs GITHUB_TOKEN env var (a GitHub personal access token)',
    tags: ['git', 'issues', 'pull requests', 'code'],
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read and write files on your local machine',
    category: 'core',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    tags: ['files', 'local', 'read', 'write'],
  },
  {
    id: 'fetch',
    name: 'Fetch / Web',
    description: 'Fetch URLs and scrape web pages',
    category: 'web',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    tags: ['web', 'http', 'scrape', 'browse'],
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Query and inspect a PostgreSQL database',
    category: 'database',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', '$DATABASE_URL'],
    envNote: 'Pass your connection string: /mcp install postgres postgresql://user:pass@localhost/db',
    tags: ['database', 'sql', 'postgres'],
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Query a local SQLite database file',
    category: 'database',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite', '--db-path', '$DB_PATH'],
    envNote: 'Pass your .db file path: /mcp install sqlite /path/to/db.sqlite',
    tags: ['database', 'sql', 'sqlite', 'local'],
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Read and write Notion pages and databases',
    category: 'productivity',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-notion'],
    env: { NOTION_API_KEY: '$NOTION_API_KEY' },
    envNote: 'Needs NOTION_API_KEY (get from notion.so/my-integrations)',
    tags: ['notion', 'notes', 'documents', 'databases'],
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Read and send Slack messages',
    category: 'communication',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    env: { SLACK_BOT_TOKEN: '$SLACK_BOT_TOKEN', SLACK_TEAM_ID: '$SLACK_TEAM_ID' },
    envNote: 'Needs SLACK_BOT_TOKEN and SLACK_TEAM_ID',
    tags: ['slack', 'chat', 'messages'],
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer / Browser',
    description: 'Control a Chrome browser — automate clicks, fill forms, take screenshots',
    category: 'web',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    tags: ['browser', 'automation', 'chrome', 'screenshot'],
  },
  {
    id: 'memory',
    name: 'Memory / Knowledge Graph',
    description: 'Persistent memory across conversations using a local knowledge graph',
    category: 'core',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    tags: ['memory', 'knowledge', 'persistent', 'notes'],
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Search the web using the Brave Search API',
    category: 'web',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: { BRAVE_API_KEY: '$BRAVE_API_KEY' },
    envNote: 'Needs BRAVE_API_KEY (free tier at brave.com/search/api)',
    tags: ['search', 'web', 'brave'],
  },
  {
    id: 'google-maps',
    name: 'Google Maps',
    description: 'Search places, get directions, and geocode addresses',
    category: 'utility',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-google-maps'],
    env: { GOOGLE_MAPS_API_KEY: '$GOOGLE_MAPS_API_KEY' },
    envNote: 'Needs GOOGLE_MAPS_API_KEY (console.cloud.google.com)',
    tags: ['maps', 'places', 'directions', 'geocoding'],
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    description: 'Structured multi-step reasoning for complex problems',
    category: 'ai',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    tags: ['reasoning', 'thinking', 'chain-of-thought'],
  },
  {
    id: 'everything',
    name: 'Everything (demo)',
    description: 'Demo MCP server that showcases all MCP features',
    category: 'dev',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
    tags: ['demo', 'test', 'dev'],
  },
];

export const CATEGORIES = {
  core:          'Core',
  dev:           'Development',
  database:      'Databases',
  web:           'Web & Search',
  productivity:  'Productivity',
  communication: 'Communication',
  utility:       'Utilities',
  ai:            'AI & Reasoning',
};

export function searchMarketplace(query) {
  if (!query) return MCP_MARKETPLACE;
  const q = query.toLowerCase();
  return MCP_MARKETPLACE.filter(s =>
    s.id.includes(q) ||
    s.name.toLowerCase().includes(q) ||
    s.description.toLowerCase().includes(q) ||
    s.category.includes(q) ||
    s.tags.some(t => t.includes(q))
  );
}

export function getMarketplaceEntry(id) {
  return MCP_MARKETPLACE.find(s => s.id === id);
}
