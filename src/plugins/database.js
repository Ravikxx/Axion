import { execSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { resolve, extname } from 'path';

export const name        = 'database';
export const description = 'Query SQLite, Postgres, and MySQL databases';

export const tools = [
  {
    name: 'query',
    description: 'Run a SQL query against the database. Auto-detects SQLite files in the project.',
    input_schema: {
      type: 'object',
      properties: {
        sql:      { type: 'string', description: 'SQL query to execute' },
        database: { type: 'string', description: 'Database file path (SQLite), or connection name. Auto-detected if omitted.' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'tables',
    description: 'List all tables in the database.',
    input_schema: {
      type: 'object',
      properties: {
        database: { type: 'string', description: 'Database file/connection (auto-detected if omitted)' },
      },
      required: [],
    },
  },
  {
    name: 'schema',
    description: 'Show the schema (columns and types) for a table.',
    input_schema: {
      type: 'object',
      properties: {
        table:    { type: 'string' },
        database: { type: 'string' },
      },
      required: ['table'],
    },
  },
];

// ── Detection ─────────────────────────────────────────────────────────────────

function findSqliteFile(hint) {
  if (hint) return existsSync(resolve(process.cwd(), hint)) ? resolve(process.cwd(), hint) : null;
  // Walk cwd shallowly for .sqlite / .db files (skip node_modules)
  const cwd = process.cwd();
  const SKIP = new Set(['node_modules', '.git', 'dist', '.next']);
  function scan(dir, depth = 0) {
    if (depth > 2) return null;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      if (e.isFile() && (e.name.endsWith('.sqlite') || e.name.endsWith('.sqlite3') || e.name.endsWith('.db'))) {
        return resolve(dir, e.name);
      }
    }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP.has(e.name)) {
        const found = scan(resolve(dir, e.name), depth + 1);
        if (found) return found;
      }
    }
    return null;
  }
  return scan(cwd);
}

function getConnectionType(database) {
  const url = database || process.env.DATABASE_URL || '';
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return { type: 'postgres', url };
  if (url.startsWith('mysql://'))                                         return { type: 'mysql',    url };
  const file = findSqliteFile(database || null);
  if (file) return { type: 'sqlite', file };
  return null;
}

// ── Runners ───────────────────────────────────────────────────────────────────

async function runSqlite(file, sql) {
  try {
    const out = execSync(`sqlite3 -column -header ${JSON.stringify(file)} ${JSON.stringify(sql)}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
    }).trim();
    return { success: true, output: out || '(0 rows)' };
  } catch (cliErr) {
    // sqlite3 CLI not available — try better-sqlite3 node driver
    try {
      const { default: Database } = await import('better-sqlite3');
      const readonly = /^\s*(SELECT|PRAGMA)/i.test(sql);
      const db   = new Database(file, { readonly });
      const stmt = db.prepare(sql);
      if (readonly) {
        const rows = stmt.all();
        if (!rows.length) return { success: true, output: '(0 rows)' };
        const cols  = Object.keys(rows[0]);
        const lines = [
          cols.join(' | '),
          cols.map(c => '-'.repeat(c.length)).join('-|-'),
          ...rows.map(r => cols.map(c => String(r[c] ?? '')).join(' | ')),
        ];
        return { success: true, output: lines.join('\n') };
      } else {
        const info = stmt.run();
        return { success: true, output: `Changes: ${info.changes}, last insert rowid: ${info.lastInsertRowid}` };
      }
    } catch (nodeErr) {
      const msg = (cliErr.stderr || cliErr.message || String(cliErr)).trim();
      return { success: false, output: `sqlite3 CLI not found and better-sqlite3 unavailable.\nError: ${msg}\n\nInstall sqlite3: https://sqlite.org/download.html\nOr install better-sqlite3: npm install better-sqlite3` };
    }
  }
}

function runPostgres(url, sql) {
  try {
    const out = execSync(`psql ${JSON.stringify(url)} -c ${JSON.stringify(sql)}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
    }).trim();
    return { success: true, output: out };
  } catch (err) {
    const msg = (err.stderr || err.message || String(err)).trim();
    return { success: false, output: `psql error: ${msg}` };
  }
}

function runMysql(url, sql) {
  try {
    const out = execSync(`mysql --table "${url}" -e ${JSON.stringify(sql)}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
    }).trim();
    return { success: true, output: out };
  } catch (err) {
    const msg = (err.stderr || err.message || String(err)).trim();
    return { success: false, output: `mysql error: ${msg}` };
  }
}

function runQuery(conn, sql) {
  if (conn.type === 'sqlite')   return runSqlite(conn.file, sql);
  if (conn.type === 'postgres') return runPostgres(conn.url, sql);
  if (conn.type === 'mysql')    return runMysql(conn.url, sql);
  return { success: false, output: 'No database detected. Set DATABASE_URL or pass a .sqlite file path.' };
}

// ── execute ───────────────────────────────────────────────────────────────────

export async function execute(toolName, args) {
  const conn = getConnectionType(args.database);
  if (!conn) {
    return { success: false, output: 'No database detected.\n\nFor SQLite: place a .sqlite/.db file in your project, or pass database path.\nFor Postgres/MySQL: set DATABASE_URL env var.' };
  }

  switch (toolName) {
    case 'query':
      return runQuery(conn, args.sql);

    case 'tables': {
      const sql =
        conn.type === 'sqlite'   ? "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;" :
        conn.type === 'postgres' ? "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;" :
                                   'SHOW TABLES;';
      return runQuery(conn, sql);
    }

    case 'schema': {
      const sql =
        conn.type === 'sqlite'   ? `PRAGMA table_info(${args.table});` :
        conn.type === 'postgres' ? `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name='${args.table}' ORDER BY ordinal_position;` :
                                   `DESCRIBE ${args.table};`;
      return runQuery(conn, sql);
    }

    default:
      return { success: false, output: `Unknown database tool: ${toolName}` };
  }
}
