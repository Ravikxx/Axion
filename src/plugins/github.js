import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

export const name        = 'github';
export const description = 'GitHub API — PRs, issues, reviews, repo search';

export const tools = [
  {
    name: 'list_prs',
    description: 'List pull requests for a GitHub repo.',
    input_schema: {
      type: 'object',
      properties: {
        repo:  { type: 'string', description: 'owner/repo (auto-detected from git remote if omitted)' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state (default: open)' },
      },
      required: [],
    },
  },
  {
    name: 'create_pr',
    description: 'Create a pull request.',
    input_schema: {
      type: 'object',
      properties: {
        repo:  { type: 'string', description: 'owner/repo (auto-detected if omitted)' },
        title: { type: 'string' },
        body:  { type: 'string' },
        head:  { type: 'string', description: 'Branch to merge from (auto-detected from git if omitted)' },
        base:  { type: 'string', description: 'Branch to merge into (default: main)' },
        draft: { type: 'boolean' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues for a GitHub repo.',
    input_schema: {
      type: 'object',
      properties: {
        repo:   { type: 'string' },
        state:  { type: 'string', enum: ['open', 'closed', 'all'] },
        labels: { type: 'string', description: 'Comma-separated label names to filter by' },
      },
      required: [],
    },
  },
  {
    name: 'create_issue',
    description: 'Create a GitHub issue.',
    input_schema: {
      type: 'object',
      properties: {
        repo:   { type: 'string' },
        title:  { type: 'string' },
        body:   { type: 'string' },
        labels: { type: 'array', items: { type: 'string' } },
      },
      required: ['title'],
    },
  },
  {
    name: 'get_pr',
    description: 'Get details and diff of a pull request.',
    input_schema: {
      type: 'object',
      properties: {
        repo:   { type: 'string' },
        number: { type: 'number', description: 'PR number' },
      },
      required: ['number'],
    },
  },
  {
    name: 'comment',
    description: 'Add a comment to a PR or issue.',
    input_schema: {
      type: 'object',
      properties: {
        repo:   { type: 'string' },
        number: { type: 'number' },
        body:   { type: 'string' },
      },
      required: ['number', 'body'],
    },
  },
  {
    name: 'search_repos',
    description: 'Search GitHub repositories.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (e.g. "language:typescript stars:>1000")' },
        limit: { type: 'number', description: 'Max results (default: 10)' },
      },
      required: ['query'],
    },
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function getToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  // Try gh CLI token
  try {
    const t = execSync('gh auth token', { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
    if (t) return t;
  } catch {}
  return null;
}

function detectRepo() {
  try {
    const remote = execSync('git remote get-url origin', { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
    const m = remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    return m ? m[1] : null;
  } catch { return null; }
}

function detectBranch() {
  try {
    return execSync('git branch --show-current', { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
  } catch { return null; }
}

async function ghFetch(path, opts = {}) {
  const token = getToken();
  if (!token) throw new Error('No GitHub token found. Set GITHUB_TOKEN env var or run: gh auth login');
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

function fmtPR(pr) {
  return `#${pr.number} [${pr.state}] ${pr.title}\n  by ${pr.user?.login} | ${pr.head?.ref} → ${pr.base?.ref}\n  ${pr.html_url}`;
}

function fmtIssue(issue) {
  return `#${issue.number} [${issue.state}] ${issue.title}\n  by ${issue.user?.login}${issue.labels?.length ? ' | ' + issue.labels.map(l => l.name).join(', ') : ''}\n  ${issue.html_url}`;
}

// ── execute ───────────────────────────────────────────────────────────────────

export async function execute(toolName, args) {
  const repo = args.repo || detectRepo();

  switch (toolName) {
    case 'list_prs': {
      if (!repo) return { success: false, output: 'Could not detect repo. Pass repo as "owner/repo".' };
      const state = args.state || 'open';
      const prs = await ghFetch(`/repos/${repo}/pulls?state=${state}&per_page=20`);
      if (!prs.length) return { success: true, output: `No ${state} PRs found in ${repo}.` };
      return { success: true, output: prs.map(fmtPR).join('\n\n') };
    }

    case 'create_pr': {
      if (!repo) return { success: false, output: 'Could not detect repo. Pass repo as "owner/repo".' };
      const head = args.head || detectBranch();
      if (!head) return { success: false, output: 'Could not detect current branch. Pass head branch explicitly.' };
      const pr = await ghFetch(`/repos/${repo}/pulls`, {
        method: 'POST',
        body: JSON.stringify({
          title: args.title,
          body:  args.body || '',
          head,
          base:  args.base || 'main',
          draft: args.draft || false,
        }),
      });
      return { success: true, output: `PR created: ${pr.html_url}\n#${pr.number} — ${pr.title}` };
    }

    case 'list_issues': {
      if (!repo) return { success: false, output: 'Could not detect repo. Pass repo as "owner/repo".' };
      const state  = args.state || 'open';
      const labels = args.labels ? `&labels=${encodeURIComponent(args.labels)}` : '';
      const issues = await ghFetch(`/repos/${repo}/issues?state=${state}&per_page=20${labels}`);
      const filtered = issues.filter(i => !i.pull_request);
      if (!filtered.length) return { success: true, output: `No ${state} issues found in ${repo}.` };
      return { success: true, output: filtered.map(fmtIssue).join('\n\n') };
    }

    case 'create_issue': {
      if (!repo) return { success: false, output: 'Could not detect repo. Pass repo as "owner/repo".' };
      const issue = await ghFetch(`/repos/${repo}/issues`, {
        method: 'POST',
        body: JSON.stringify({ title: args.title, body: args.body || '', labels: args.labels || [] }),
      });
      return { success: true, output: `Issue created: ${issue.html_url}\n#${issue.number} — ${issue.title}` };
    }

    case 'get_pr': {
      if (!repo) return { success: false, output: 'Could not detect repo. Pass repo as "owner/repo".' };
      const [pr, files] = await Promise.all([
        ghFetch(`/repos/${repo}/pulls/${args.number}`),
        ghFetch(`/repos/${repo}/pulls/${args.number}/files`),
      ]);
      const fileList = files.slice(0, 20).map(f => `  ${f.status.padEnd(8)} ${f.filename} (+${f.additions}/-${f.deletions})`).join('\n');
      return {
        success: true,
        output: `${fmtPR(pr)}\n\nFiles changed (${files.length}):\n${fileList}${files.length > 20 ? `\n  … and ${files.length - 20} more` : ''}`,
      };
    }

    case 'comment': {
      if (!repo) return { success: false, output: 'Could not detect repo. Pass repo as "owner/repo".' };
      const comment = await ghFetch(`/repos/${repo}/issues/${args.number}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: args.body }),
      });
      return { success: true, output: `Comment added: ${comment.html_url}` };
    }

    case 'search_repos': {
      const limit = Math.min(args.limit || 10, 30);
      const data  = await ghFetch(`/search/repositories?q=${encodeURIComponent(args.query)}&per_page=${limit}`);
      if (!data.items?.length) return { success: true, output: 'No repos found.' };
      const lines = data.items.map(r => `${r.full_name} ★${r.stargazers_count}\n  ${r.description || '(no description)'}\n  ${r.html_url}`);
      return { success: true, output: lines.join('\n\n') };
    }

    default:
      return { success: false, output: `Unknown github tool: ${toolName}` };
  }
}
