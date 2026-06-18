import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { createRequire } from 'module';

export const name        = 'browser';
export const description = 'Headless browser — scrape pages, take screenshots, fill forms (uses Playwright if installed)';

export const tools = [
  {
    name: 'fetch_page',
    description: 'Fetch a web page and return its readable text content. Works without Playwright.',
    input_schema: {
      type: 'object',
      properties: {
        url:      { type: 'string' },
        selector: { type: 'string', description: 'CSS selector to extract a specific element (requires Playwright)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'screenshot',
    description: 'Take a screenshot of a web page. Requires Playwright (`npm install playwright`).',
    input_schema: {
      type: 'object',
      properties: {
        url:      { type: 'string' },
        path:     { type: 'string', description: 'Where to save the screenshot (default: screenshot.png in cwd)' },
        fullPage: { type: 'boolean', description: 'Capture full scrollable page (default: true)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'get_links',
    description: 'Extract all links from a page.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
  {
    name: 'fill_form',
    description: 'Fill and submit a form on a page. Requires Playwright.',
    input_schema: {
      type: 'object',
      properties: {
        url:    { type: 'string' },
        fields: {
          type: 'object',
          description: 'Map of CSS selector → value to fill (e.g. {"#email": "test@example.com"})',
          additionalProperties: { type: 'string' },
        },
        submit: { type: 'string', description: 'CSS selector of the submit button' },
      },
      required: ['url', 'fields'],
    },
  },
  {
    name: 'click',
    description: 'Click an element on a page. Requires Playwright.',
    input_schema: {
      type: 'object',
      properties: {
        url:      { type: 'string' },
        selector: { type: 'string', description: 'CSS selector of the element to click' },
        waitFor:  { type: 'string', description: 'CSS selector to wait for after clicking (optional)' },
      },
      required: ['url', 'selector'],
    },
  },
];

// ── Fetch-based (no Playwright) ───────────────────────────────────────────────

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Axion/1.0)',
      Accept: 'text/html,application/xhtml+xml,*/*',
    },
    signal: AbortSignal.timeout(15000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  const html = await res.text();
  return html;
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 8000);
}

function extractLinks(html, baseUrl) {
  const links = [];
  const re = /href=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const abs = new URL(m[1], baseUrl).href;
      links.push(abs);
    } catch {}
  }
  return [...new Set(links)].slice(0, 50);
}

// ── Playwright (optional) ─────────────────────────────────────────────────────

async function getPlaywright() {
  // Try local project node_modules first, then global
  const paths = [
    resolve(process.cwd(), 'node_modules/playwright'),
    resolve(process.cwd(), 'node_modules/@playwright/test'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      try { return await import(p); } catch {}
    }
  }
  try { return await import('playwright'); } catch {}
  return null;
}

async function withPage(cb) {
  const pw = await getPlaywright();
  if (!pw) throw new Error('Playwright not installed. Run: npm install playwright && npx playwright install chromium');
  const browser = await pw.chromium.launch({ headless: true });
  const page    = await browser.newPage();
  try {
    return await cb(page);
  } finally {
    await browser.close();
  }
}

// ── execute ───────────────────────────────────────────────────────────────────

export async function execute(toolName, args) {
  switch (toolName) {
    case 'fetch_page': {
      try {
        const html = await fetchPage(args.url);
        if (args.selector) {
          // Need Playwright for selector extraction
          return await withPage(async (page) => {
            await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
            const el = await page.$(args.selector);
            if (!el) return { success: false, output: `Selector "${args.selector}" not found on page.` };
            const text = await el.innerText();
            return { success: true, output: text.trim().slice(0, 8000) };
          });
        }
        return { success: true, output: htmlToText(html) };
      } catch (err) {
        return { success: false, output: err.message };
      }
    }

    case 'get_links': {
      try {
        const html  = await fetchPage(args.url);
        const links = extractLinks(html, args.url);
        return { success: true, output: links.join('\n') || 'No links found.' };
      } catch (err) {
        return { success: false, output: err.message };
      }
    }

    case 'screenshot': {
      try {
        return await withPage(async (page) => {
          await page.goto(args.url, { waitUntil: 'networkidle', timeout: 30000 });
          const outPath = resolve(process.cwd(), args.path || 'screenshot.png');
          await page.screenshot({ path: outPath, fullPage: args.fullPage !== false });
          return { success: true, output: `Screenshot saved to ${outPath}` };
        });
      } catch (err) {
        return { success: false, output: err.message };
      }
    }

    case 'fill_form': {
      try {
        return await withPage(async (page) => {
          await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          for (const [selector, value] of Object.entries(args.fields || {})) {
            await page.fill(selector, value);
          }
          if (args.submit) {
            await Promise.all([
              page.waitForNavigation({ timeout: 10000 }).catch(() => {}),
              page.click(args.submit),
            ]);
          }
          const url  = page.url();
          const text = htmlToText(await page.content());
          return { success: true, output: `Form submitted. Now at: ${url}\n\n${text.slice(0, 3000)}` };
        });
      } catch (err) {
        return { success: false, output: err.message };
      }
    }

    case 'click': {
      try {
        return await withPage(async (page) => {
          await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.click(args.selector);
          if (args.waitFor) await page.waitForSelector(args.waitFor, { timeout: 5000 });
          const text = htmlToText(await page.content());
          return { success: true, output: `Clicked "${args.selector}".\n\n${text.slice(0, 3000)}` };
        });
      } catch (err) {
        return { success: false, output: err.message };
      }
    }

    default:
      return { success: false, output: `Unknown browser tool: ${toolName}` };
  }
}
