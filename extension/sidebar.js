// ── Providers & models ────────────────────────────────────────────────────────

// input/output cost per 1M tokens in USD
const PRICING = {
  'claude-haiku-4-5-20251001': [0.80,  4.00],
  'claude-sonnet-4-6':         [3.00,  15.00],
  'claude-opus-4-8':           [15.00, 75.00],
  'gpt-4o-mini':               [0.15,  0.60],
  'gpt-4o':                    [2.50,  10.00],
  'gemini-2.0-flash':          [0.10,  0.40],
  'gemini-2.5-pro':            [1.25,  10.00],
  'llama-3.3-70b-versatile':   [0.59,  0.79],
  'mistral-large-latest':      [2.00,  6.00],
};

const PROVIDERS = {
  anthropic:  { baseURL: 'https://api.anthropic.com',                        format: 'anthropic' },
  openai:     { baseURL: 'https://api.openai.com/v1',                        format: 'openai' },
  gemini:     { baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', format: 'openai' },
  groq:       { baseURL: 'https://api.groq.com/openai/v1',                   format: 'openai' },
  mistral:    { baseURL: 'https://api.mistral.ai/v1',                        format: 'openai' },
  openrouter: { baseURL: 'https://openrouter.ai/api/v1',                     format: 'openai' },
  veil:       { baseURL: 'https://ravikxxbgamin-minecraftai-chat.hf.space/v1', format: 'openai', noKey: true },
};

const BUILTIN_MODELS = [
  { id: 'veil',                      label: 'Veil (Axion Labs — free, slow up to 100s)',  provider: 'veil' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5',  provider: 'anthropic' },
  { id: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6', provider: 'anthropic' },
  { id: 'claude-opus-4-8',           label: 'Claude Opus 4.8',   provider: 'anthropic' },
  { id: 'gpt-4o-mini',               label: 'GPT-4o Mini',       provider: 'openai' },
  { id: 'gpt-4o',                    label: 'GPT-4o',            provider: 'openai' },
  { id: 'gemini-2.0-flash',          label: 'Gemini 2.0 Flash',  provider: 'gemini' },
  { id: 'gemini-2.5-pro',            label: 'Gemini 2.5 Pro',    provider: 'gemini' },
  { id: 'llama-3.3-70b-versatile',   label: 'Llama 3.3 70B (Groq)', provider: 'groq' },
  { id: 'mistral-large-latest',      label: 'Mistral Large',     provider: 'mistral' },
];

// ── State ─────────────────────────────────────────────────────────────────────

let apiKeys         = {};   // provider → key
let customEndpoints = {};   // name → { baseURL, model, apiKey }
let models          = [...BUILTIN_MODELS];
let activeModelId   = 'claude-haiku-4-5-20251001';
let history         = [];   // internal Anthropic-format history
let running         = false;
let currentChatId   = crypto.randomUUID();
let sessionIn       = 0;   // cumulative input tokens this session
let sessionOut      = 0;   // cumulative output tokens this session

// ── DOM ───────────────────────────────────────────────────────────────────────

const $messages     = document.getElementById('messages');
const $input        = document.getElementById('input');
const $sendBtn      = document.getElementById('send-btn');
const $stopBtn      = document.getElementById('stop-btn');
const $historyBtn   = document.getElementById('history-btn');
const $historyPanel = document.getElementById('history-panel');
const $historyList  = document.getElementById('history-list');
const $tokenCount   = document.getElementById('token-count');
const $modelSelect  = document.getElementById('model-select');
const $settingsBtn  = document.getElementById('settings-btn');
const $settingsPanel= document.getElementById('settings-panel');
const $clearBtn     = document.getElementById('clear-btn');
const $importBtn    = document.getElementById('import-btn');
const $importStatus = document.getElementById('import-status');
const $saveSettings = document.getElementById('save-settings-btn');
const $customList   = document.getElementById('custom-endpoints-list');

// ── Theme (light / dark) ──────────────────────────────────────────────────────

const $themeBtn = document.getElementById('theme-btn');

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  if ($themeBtn) $themeBtn.textContent = theme === 'dark' ? '☀' : '☾';
}

chrome.storage.local.get('axionTheme', (r) => {
  applyTheme(r.axionTheme || 'light');
});

$themeBtn?.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  chrome.storage.local.set({ axionTheme: next });
});

// ── Load saved config ─────────────────────────────────────────────────────────

chrome.storage.local.get(['axionApiKeys', 'axionModel', 'axionCustomEndpoints'], (r) => {
  if (r.axionApiKeys)         apiKeys         = r.axionApiKeys;
  if (r.axionModel)           activeModelId   = r.axionModel;
  if (r.axionCustomEndpoints) customEndpoints = r.axionCustomEndpoints;
  populateKeyInputs();
  rebuildModelList();
  renderCustomEndpointsList();
});

// Pre-fill input from context menu selection
function checkPrefill() {
  chrome.storage.session.get('prefillText', (r) => {
    if (r.prefillText !== undefined) {
      const text = r.prefillText;
      chrome.storage.session.remove('prefillText');
      if (text) {
        $input.value = text;
        $input.style.height = 'auto';
        $input.style.height = Math.min($input.scrollHeight, 120) + 'px';
        $input.focus();
      }
    }
  });
}
checkPrefill();
window.addEventListener('focus', checkPrefill);

// ── Tools (Anthropic format — converted for OpenAI path) ──────────────────────

const ANTHROPIC_TOOLS = [
  {
    name: 'read_page',
    description: 'Read the current page\'s full text content, title, and URL. Call this first before answering questions about page content.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'find_elements',
    description: 'Find interactive elements (buttons, links, inputs) by visible text or CSS selector.',
    input_schema: {
      type: 'object',
      properties: {
        text:     { type: 'string', description: 'Visible text to search for' },
        selector: { type: 'string', description: 'CSS selector' },
        limit:    { type: 'number', description: 'Max results (default 10)' },
      },
    },
  },
  {
    name: 'click',
    description: 'Click a button, link, or any element by its visible text or CSS selector.',
    input_schema: {
      type: 'object',
      properties: {
        text:     { type: 'string', description: 'Visible text of element to click' },
        selector: { type: 'string', description: 'CSS selector (use if text is ambiguous)' },
      },
    },
  },
  {
    name: 'type_text',
    description: 'Type text into an input, textarea, or search box.',
    input_schema: {
      type: 'object',
      required: ['value'],
      properties: {
        value:    { type: 'string', description: 'Text to type' },
        text:     { type: 'string', description: 'Label or placeholder of the input' },
        selector: { type: 'string', description: 'CSS selector of the input' },
        clear:    { type: 'boolean', description: 'Clear field first (default true)' },
      },
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page or an element.',
    input_schema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up','down','left','right'] },
        amount:    { type: 'number', description: 'Pixels (default 400)' },
        selector:  { type: 'string', description: 'Scroll inside this element' },
      },
    },
  },
  {
    name: 'get_html',
    description: 'Get the HTML of part of the page.',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector (default: body)' },
        limit:    { type: 'number', description: 'Max chars (default 4000)' },
      },
    },
  },
  {
    name: 'select_option',
    description: 'Select an option from a <select> dropdown.',
    input_schema: {
      type: 'object',
      properties: {
        text:     { type: 'string', description: 'Label of the <select> element' },
        selector: { type: 'string', description: 'CSS selector of the <select>' },
        label:    { type: 'string', description: 'Option text to select' },
        value:    { type: 'string', description: 'Option value to select' },
      },
    },
  },
  {
    name: 'take_screenshot',
    description: 'Take a screenshot of the current tab and analyze it visually.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'navigate',
    description: 'Navigate the current tab to a URL.',
    input_schema: {
      type: 'object',
      required: ['url'],
      properties: { url: { type: 'string', description: 'Full URL (must include https://)' } },
    },
  },
];

function toOpenAITools() {
  return ANTHROPIC_TOOLS.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

const SYSTEM = `You are Axion, an AI browser assistant running in a Chrome extension sidebar.

You can read and interact with the current webpage using tools: read_page, find_elements, click, type_text, scroll, get_html, select_option, take_screenshot, navigate.

Guidelines:
- Read the page first if the user asks about its content.
- Prefer finding elements by visible text, not CSS selectors.
- Describe what you're doing in one short sentence, then do it.
- Confirm with the user before irreversible actions (submitting forms, deleting).`;

// ── Provider resolution ───────────────────────────────────────────────────────

function resolveModel(modelId) {
  // Check custom endpoints first
  if (customEndpoints[modelId]) {
    const ep = customEndpoints[modelId];
    return {
      format:  'openai',
      baseURL: ep.baseURL,
      apiKey:  ep.apiKey || 'no-key',
      modelId: ep.model || modelId,
    };
  }
  const m = models.find(m => m.id === modelId);
  if (!m) throw new Error(`Unknown model: ${modelId}`);
  const prov = PROVIDERS[m.provider];
  if (!prov) throw new Error(`Unknown provider: ${m.provider}`);
  const key = prov.noKey ? 'no-key' : (apiKeys[m.provider] || '');
  return { format: prov.format, baseURL: prov.baseURL, apiKey: key, modelId };
}

// ── API calls (streaming) ─────────────────────────────────────────────────────

async function callAnthropicAPI(baseURL, apiKey, modelId, messages, signal, onToken) {
  const res = await fetch(`${baseURL}/v1/messages`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model: modelId, max_tokens: 4096, system: SYSTEM, tools: ANTHROPIC_TOOLS, messages, stream: true }),
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e?.error?.message || `API ${res.status}`); }

  const content = [];
  let currentText = '', currentToolId = '', currentToolName = '', currentToolJson = '';
  let stopReason = 'end_turn';

  for await (const line of sseLines(res)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') break;
    let ev; try { ev = JSON.parse(data); } catch { continue; }

    if (ev.type === 'content_block_start') {
      if (ev.content_block?.type === 'tool_use') {
        if (currentText) { content.push({ type: 'text', text: currentText }); currentText = ''; }
        currentToolId   = ev.content_block.id;
        currentToolName = ev.content_block.name;
        currentToolJson = '';
      }
    } else if (ev.type === 'content_block_delta') {
      const d = ev.delta;
      if (d?.type === 'text_delta')       { currentText += d.text; onToken(d.text); }
      if (d?.type === 'input_json_delta') { currentToolJson += d.partial_json; }
    } else if (ev.type === 'content_block_stop') {
      if (currentToolName) {
        let input = {}; try { input = JSON.parse(currentToolJson); } catch {}
        content.push({ type: 'tool_use', id: currentToolId, name: currentToolName, input });
        currentToolId = currentToolName = currentToolJson = '';
      }
    } else if (ev.type === 'message_start') {
      sessionIn += ev.message?.usage?.input_tokens || 0;
    } else if (ev.type === 'message_delta') {
      stopReason = ev.delta?.stop_reason || stopReason;
      sessionOut += ev.usage?.output_tokens || 0;
      updateTokenBar();
    }
  }
  if (currentText) content.push({ type: 'text', text: currentText });
  return { content, stop_reason: stopReason };
}

async function callOpenAIAPI(baseURL, apiKey, modelId, messages, signal, onToken) {
  const oaiMessages = toOpenAIHistory(messages);
  const res = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: modelId, max_tokens: 4096, tools: toOpenAITools(), stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'system', content: SYSTEM }, ...oaiMessages] }),
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e?.error?.message || `API ${res.status}`); }

  let text = '', toolCalls = {};
  for await (const line of sseLines(res)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') break;
    let ev; try { ev = JSON.parse(data); } catch { continue; }
    if (ev.usage) {
      sessionIn  += ev.usage.prompt_tokens     || 0;
      sessionOut += ev.usage.completion_tokens || 0;
      updateTokenBar();
    }
    const delta = ev.choices?.[0]?.delta;
    if (!delta) continue;
    if (delta.content) { text += delta.content; onToken(delta.content); }
    for (const tc of (delta.tool_calls || [])) {
      const i = tc.index;
      if (!toolCalls[i]) toolCalls[i] = { id: '', name: '', args: '' };
      if (tc.id)                   toolCalls[i].id   += tc.id;
      if (tc.function?.name)       toolCalls[i].name += tc.function.name;
      if (tc.function?.arguments)  toolCalls[i].args += tc.function.arguments;
    }
  }
  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const tc of Object.values(toolCalls)) {
    let input = {}; try { input = JSON.parse(tc.args); } catch {}
    content.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
  }
  return { content, stop_reason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn' };
}

async function* sseLines(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) yield l;
  }
  if (buf) yield buf;
}

// Convert internal Anthropic-format history to OpenAI format
function toOpenAIHistory(msgs) {
  const out = [];
  for (const msg of msgs) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'user', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        // tool_result blocks → tool messages
        const toolResults = msg.content.filter(b => b.type === 'tool_result');
        for (const tr of toolResults) {
          const content = Array.isArray(tr.content)
            ? tr.content.map(c => c.type === 'image'
                ? { type: 'image_url', image_url: { url: `data:image/png;base64,${c.source.data}` } }
                : { type: 'text', text: c.text || JSON.stringify(c) })
            : tr.content;
          out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: typeof content === 'string' ? content : JSON.stringify(content) });
        }
        // non-tool user text
        const texts = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
        if (texts) out.push({ role: 'user', content: texts });
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'assistant', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('') || null;
        const toolUse = msg.content.filter(b => b.type === 'tool_use');
        const oai = { role: 'assistant', content: text };
        if (toolUse.length) {
          oai.tool_calls = toolUse.map(t => ({
            id: t.id, type: 'function',
            function: { name: t.name, arguments: JSON.stringify(t.input) },
          }));
        }
        out.push(oai);
      }
    }
  }
  return out;
}

// Normalize OpenAI response to match Anthropic-shaped result for unified agent loop
function normalizeOpenAIResponse(data) {
  const choice  = data.choices?.[0];
  const message = choice?.message || {};
  const content = [];
  if (message.content) content.push({ type: 'text', text: message.content });
  for (const tc of (message.tool_calls || [])) {
    content.push({
      type: 'tool_use',
      id:   tc.id,
      name: tc.function.name,
      input: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })(),
    });
  }
  return {
    content,
    stop_reason: message.tool_calls?.length ? 'tool_use' : 'end_turn',
  };
}

// ── Tool execution (same as before) ──────────────────────────────────────────

async function executeTool(name, input) {
  if (name === 'take_screenshot') {
    return new Promise(resolve =>
      chrome.runtime.sendMessage({ action: 'screenshot' }, r =>
        resolve(r?.dataUrl ? { dataUrl: r.dataUrl } : { error: r?.error || 'failed' })
      )
    );
  }
  if (name === 'navigate') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.update(tab.id, { url: input.url });
    await new Promise(r => setTimeout(r, 1500));
    return { navigated: input.url };
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const send = () => new Promise(resolve =>
    chrome.tabs.sendMessage(tab.id, { action: 'page_tool', tool: name, input }, r =>
      chrome.runtime.lastError
        ? resolve(null)
        : resolve(r?.ok ? r.result : { error: r?.error || 'failed' })
    )
  );

  let result = await send();
  if (result === null) {
    // Content script not injected — inject it now and retry
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await new Promise(r => setTimeout(r, 200));
      result = await send();
    } catch (e) {
      result = { error: e.message };
    }
  }
  return result ?? { error: 'failed' };
}

// ── Agent loop ────────────────────────────────────────────────────────────────

let abortController = null;

async function run(userMessage) {
  if (running) return;
  running = true;
  abortController = new AbortController();
  setInputDisabled(true);
  $stopBtn.classList.remove('hidden');

  // Auto-read page on the first message of a new chat
  if (history.length === 0) {
    const pageEl = showPageReadIndicator();
    try {
      const ctx = await executeTool('read_page', {});
      if (ctx && !ctx.error) {
        const pageMsg = `[Page context — auto-read]\nURL: ${ctx.url}\nTitle: ${ctx.title}\n\n${ctx.text}`;
        history.push({ role: 'user',      content: pageMsg });
        history.push({ role: 'assistant', content: 'I can see the page. What would you like to know?' });
      }
    } catch {}
    pageEl.remove();
  }

  history.push({ role: 'user', content: userMessage });
  renderUser(userMessage);

  let resolved;
  try { resolved = resolveModel(activeModelId); }
  catch (e) { renderError(e.message); running = false; setInputDisabled(false); $stopBtn.classList.add('hidden'); return; }

  try {
    while (true) {
      // Create a streaming bubble
      const { bubble, finalize } = createStreamBubble();
      const onToken = (t) => { bubble.innerHTML = renderMarkdown(bubble._raw = (bubble._raw || '') + t); scrollBottom(); };

      const response = resolved.format === 'anthropic'
        ? await callAnthropicAPI(resolved.baseURL, resolved.apiKey, resolved.modelId, history, abortController.signal, onToken)
        : await callOpenAIAPI(resolved.baseURL, resolved.apiKey, resolved.modelId, history, abortController.signal, onToken);

      const { content, stop_reason } = response;
      const textBlocks = content.filter(b => b.type === 'text');
      const toolBlocks = content.filter(b => b.type === 'tool_use');

      const text = textBlocks.map(b => b.text).join('').trim();
      finalize(text); // replace streaming bubble with final rendered text (or remove if empty)

      history.push({ role: 'assistant', content });

      if (stop_reason !== 'tool_use' || !toolBlocks.length) break;

      const toolResults = [];
      for (const tb of toolBlocks) {
        const toolEl = renderToolCall(tb.name, tb.id, tb.input);
        let result;
        try { result = await executeTool(tb.name, tb.input); }
        catch (e) { result = { error: e.message }; }

        if (tb.name === 'take_screenshot' && result?.dataUrl) {
          const base64 = result.dataUrl.replace(/^data:image\/\w+;base64,/, '');
          showScreenshotThumbnail(toolEl, result.dataUrl);
          resolveToolEl(toolEl, true, 'Screenshot taken');
          toolResults.push({
            type: 'tool_result', tool_use_id: tb.id,
            content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }],
          });
        } else {
          const output = JSON.stringify(result, null, 2);
          const isThinking = tb.name && tb.name.includes('sequentialthinking');
          resolveToolEl(toolEl, !result?.error, isThinking ? null : (result?.error || output.slice(0, 120)));
          toolResults.push({ type: 'tool_result', tool_use_id: tb.id, content: output });
        }
      }
      history.push({ role: 'user', content: toolResults });
    }
  } catch (err) {
    if (err.name !== 'AbortError') renderError(err.message);
  } finally {
    running = false;
    abortController = null;
    setInputDisabled(false);
    $stopBtn.classList.add('hidden');
    scrollBottom();
    saveCurrentChat();
  }
}

// ── Model list ────────────────────────────────────────────────────────────────

function rebuildModelList() {
  // Built-in models that have a key set, or don't need one (e.g. Veil)
  const available = BUILTIN_MODELS.filter(m => PROVIDERS[m.provider]?.noKey || apiKeys[m.provider]);
  // Custom endpoints
  const customs = Object.entries(customEndpoints).map(([name, ep]) => ({
    id: name, label: `${name} (${ep.model || name})`, provider: 'custom',
  }));
  models = [...available, ...customs];
  // If no keys set yet, show all built-ins so user can still pick
  if (!models.length) models = [...BUILTIN_MODELS];

  $modelSelect.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    if (m.id === activeModelId) opt.selected = true;
    $modelSelect.appendChild(opt);
  }
  // If saved model no longer available, pick first
  if (!models.find(m => m.id === activeModelId) && models.length) {
    activeModelId = models[0].id;
    $modelSelect.value = activeModelId;
  }
}

// ── Settings ──────────────────────────────────────────────────────────────────

function populateKeyInputs() {
  for (const input of document.querySelectorAll('[data-provider]')) {
    input.value = apiKeys[input.dataset.provider] || '';
  }
}

function renderCustomEndpointsList() {
  const entries = Object.entries(customEndpoints);
  if (!entries.length) { $customList.innerHTML = '<span class="hint">None added yet.</span>'; return; }
  $customList.innerHTML = entries.map(([name, ep]) =>
    `<div class="ep-row">
      <span class="ep-name">${esc(name)}</span>
      <span class="hint">${esc(ep.model || '')} · ${esc(ep.baseURL)}</span>
      <button class="ep-del" data-ep="${esc(name)}" title="Remove">✕</button>
    </div>`
  ).join('');
  for (const btn of $customList.querySelectorAll('.ep-del')) {
    btn.addEventListener('click', () => {
      delete customEndpoints[btn.dataset.ep];
      chrome.storage.local.set({ axionCustomEndpoints: customEndpoints });
      rebuildModelList();
      renderCustomEndpointsList();
    });
  }
}

function saveAll() {
  chrome.storage.local.set({
    axionApiKeys:         apiKeys,
    axionModel:           activeModelId,
    axionCustomEndpoints: customEndpoints,
  });
}

// ── Import from Axion CLI (/web) ──────────────────────────────────────────────

$importBtn.addEventListener('click', async () => {
  $importStatus.textContent = 'Connecting…';
  $importStatus.className = '';
  try {
    const res = await fetch('http://localhost:3000/api/config', { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const data = await res.json();
    if (data.apiKeys)         Object.assign(apiKeys, data.apiKeys);
    if (data.customEndpoints) Object.assign(customEndpoints, data.customEndpoints);
    if (data.model)           activeModelId = data.model;
    saveAll();
    populateKeyInputs();
    rebuildModelList();
    renderCustomEndpointsList();
    const kc = Object.values(apiKeys).filter(Boolean).length;
    const ec = Object.keys(customEndpoints).length;
    $importStatus.textContent = `Imported ${kc} key(s), ${ec} endpoint(s)`;
    $importStatus.className = 'import-ok';
  } catch (e) {
    $importStatus.textContent = `${e.message} — run /web in Axion first`;
    $importStatus.className = 'import-err';
  }
});

// ── Save API keys ─────────────────────────────────────────────────────────────

$saveSettings.addEventListener('click', () => {
  for (const input of document.querySelectorAll('[data-provider]')) {
    const v = input.value.trim();
    if (v) apiKeys[input.dataset.provider] = v;
    else   delete apiKeys[input.dataset.provider];
  }
  activeModelId = $modelSelect.value;
  saveAll();
  rebuildModelList();
  renderCustomEndpointsList();
  $settingsPanel.classList.add('hidden');
});

// ── Add custom endpoint ───────────────────────────────────────────────────────

document.getElementById('ep-add-btn').addEventListener('click', () => {
  const epName  = document.getElementById('ep-name').value.trim();
  const epUrl   = document.getElementById('ep-url').value.trim();
  const epModel = document.getElementById('ep-model').value.trim();
  const epKey   = document.getElementById('ep-key').value.trim();
  if (!epName || !epUrl || !epModel) {
    $importStatus.textContent = 'Name, Base URL and Model ID are required';
    $importStatus.className = 'import-err';
    return;
  }
  customEndpoints[epName] = { baseURL: epUrl, model: epModel, apiKey: epKey };
  activeModelId = epName;
  saveAll();
  rebuildModelList();
  renderCustomEndpointsList();
  $importStatus.textContent = `Added "${epName}"`;
  $importStatus.className = 'import-ok';
  document.getElementById('ep-name').value  = '';
  document.getElementById('ep-url').value   = '';
  document.getElementById('ep-model').value = '';
  document.getElementById('ep-key').value   = '';
});

$modelSelect.addEventListener('change', () => {
  activeModelId = $modelSelect.value;
  chrome.storage.local.set({ axionModel: activeModelId });
});

// ── Render helpers ────────────────────────────────────────────────────────────

function renderUser(text) {
  const wrap = div('msg msg-user'); const b = div('bubble'); b.textContent = text;
  wrap.appendChild(b); $messages.appendChild(wrap); scrollBottom();
}

function renderAssistant(text) {
  const wrap = div('msg msg-assistant'); const b = div('bubble');
  b.innerHTML = renderMarkdown(text);
  wrap.appendChild(b); $messages.appendChild(wrap); scrollBottom();
}

function createStreamBubble() {
  const wrap = div('msg msg-assistant'); const b = div('bubble');
  b._raw = '';
  wrap.appendChild(b); $messages.appendChild(wrap); scrollBottom();
  return {
    bubble: b,
    finalize(fullText) {
      if (!fullText) { wrap.remove(); return; }
      b.innerHTML = renderMarkdown(fullText);
      scrollBottom();
    },
  };
}

function renderError(text) {
  const wrap = div('msg msg-error'); const b = div('bubble'); b.textContent = '⚠ ' + text;
  wrap.appendChild(b); $messages.appendChild(wrap); scrollBottom();
}

function updateTokenBar() {
  if (!sessionIn && !sessionOut) { $tokenCount.textContent = ''; return; }
  const price = PRICING[activeModelId];
  let txt = `↑${fmtN(sessionIn)} ↓${fmtN(sessionOut)}`;
  if (price) {
    const cost = (sessionIn / 1e6) * price[0] + (sessionOut / 1e6) * price[1];
    txt += `  $${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}`;
  }
  $tokenCount.textContent = txt;
}
function fmtN(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }

function showPageReadIndicator() {
  const el = div('page-read-indicator');
  el.textContent = 'Reading page…';
  $messages.appendChild(el);
  scrollBottom();
  return el;
}

function renderToolCall(name, id, input) {
  const isThinking = name && name.includes('sequentialthinking');

  const wrap = div('msg-tool'); wrap.dataset.toolId = id;
  const icon = div('tool-icon pending');
  icon.textContent = isThinking ? '💭' : '◌';
  const body = div('tool-body');
  const nameEl = div('tool-name');

  if (isThinking && input) {
    const num   = input.thoughtNumber || '?';
    const total = input.totalThoughts || '?';
    nameEl.textContent = `Thought ${num}/${total}`;
    if (input.thought) {
      const preview = div('tool-output');
      preview.style.color = 'var(--text-muted, #888)';
      preview.textContent = input.thought.slice(0, 180) + (input.thought.length > 180 ? '…' : '');
      body.appendChild(nameEl);
      body.appendChild(preview);
    } else {
      body.appendChild(nameEl);
    }
  } else {
    nameEl.textContent = name;
    body.appendChild(nameEl);
  }

  wrap.append(icon, body);
  $messages.appendChild(wrap);
  scrollBottom();
  return wrap;
}

function resolveToolEl(wrap, success, output) {
  const icon = wrap.querySelector('.tool-icon');
  icon.className = `tool-icon ${success ? 'success' : 'error'}`;
  icon.textContent = success ? '✔' : '✖';
  if (output) { const o = div('tool-output'); o.textContent = output; wrap.querySelector('.tool-body').appendChild(o); }
  scrollBottom();
}

function showScreenshotThumbnail(wrap, dataUrl) {
  const img = document.createElement('img');
  img.src = dataUrl; img.style.cssText = 'max-width:100%;border-radius:4px;margin-top:4px;';
  wrap.querySelector('.tool-body').appendChild(img);
}

function renderMarkdown(text) {
  // Extract code blocks and links before escaping so their content is preserved
  const codeBlocks = [];
  text = text.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, c) => {
    codeBlocks.push(c.trim());
    return `\x00CODE${codeBlocks.length - 1}\x00`;
  });
  const links = [];
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, label, url) => {
    links.push({ label, url });
    return `\x00LINK${links.length - 1}\x00`;
  });
  // Also linkify bare URLs
  text = text.replace(/(?<!\x00LINK\d)(https?:\/\/[^\s<>"']+)/g, (url) => {
    links.push({ label: url, url });
    return `\x00LINK${links.length - 1}\x00`;
  });

  let h = esc(text);
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');
  h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  h = h.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  h = h.replace(/^---$/gm, '<hr>');
  h = h.replace(/^[*-] (.+)$/gm, '<li>$1</li>');
  h = h.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, m => `<ul>${m}</ul>`);
  h = h.replace(/\n/g, '<br>');

  // Restore code blocks and links
  h = h.replace(/\x00CODE(\d+)\x00/g, (_, i) => `<pre><code>${esc(codeBlocks[+i])}</code></pre>`);
  h = h.replace(/\x00LINK(\d+)\x00/g, (_, i) => {
    const { label, url } = links[+i];
    return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
  });
  return h;
}

function esc(t) { return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function div(cls) { const e = document.createElement('div'); e.className = cls; return e; }
function scrollBottom() { $messages.scrollTop = $messages.scrollHeight; }
function setInputDisabled(v) { $input.disabled = v; $sendBtn.disabled = v; }

// ── Events ────────────────────────────────────────────────────────────────────

// ── Chat history ──────────────────────────────────────────────────────────────

function saveCurrentChat() {
  if (!history.some(m => m.role === 'user' && typeof m.content === 'string' && !m.content.startsWith('[Page context'))) return;
  const firstUser = history.find(m => m.role === 'user' && typeof m.content === 'string' && !m.content.startsWith('[Page context'));
  const title = (firstUser?.content || 'Chat').slice(0, 80);
  // Strip base64 images to keep storage lean
  const stripped = history.map(m => {
    if (m.role !== 'user' || !Array.isArray(m.content)) return m;
    return { ...m, content: m.content.map(b => {
      if (b.type === 'tool_result' && Array.isArray(b.content))
        return { ...b, content: b.content.filter(c => c.type !== 'image') };
      return b;
    })};
  });
  const chat = { id: currentChatId, title, savedAt: Date.now(), history: stripped };
  chrome.storage.local.get('axionChats', (r) => {
    const chats = (r.axionChats || []).filter(c => c.id !== currentChatId);
    chats.unshift(chat);
    chrome.storage.local.set({ axionChats: chats.slice(0, 40) });
  });
}

function renderHistoryPanel() {
  chrome.storage.local.get('axionChats', (r) => {
    const chats = r.axionChats || [];
    if (!chats.length) { $historyList.innerHTML = '<div class="hist-empty">No saved chats yet.</div>'; return; }
    $historyList.innerHTML = '';
    for (const chat of chats) {
      const item  = div('hist-item');
      const body  = div('hist-body');
      const title = div('hist-title'); title.textContent = chat.title;
      const date  = div('hist-date');  date.textContent  = new Date(chat.savedAt).toLocaleString();
      const del   = document.createElement('button'); del.className = 'hist-del'; del.textContent = '✕';
      body.append(title, date); item.append(body, del);
      item.addEventListener('click', (e) => { if (e.target === del) return; restoreChat(chat); });
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.storage.local.get('axionChats', (r2) => {
          const updated = (r2.axionChats || []).filter(c => c.id !== chat.id);
          chrome.storage.local.set({ axionChats: updated }, renderHistoryPanel);
        });
      });
      $historyList.appendChild(item);
    }
  });
}

function restoreChat(chat) {
  history = chat.history;
  currentChatId = chat.id;
  $messages.innerHTML = '';
  $historyPanel.classList.add('hidden');
  for (const msg of history) {
    if (msg.role === 'user' && typeof msg.content === 'string' && !msg.content.startsWith('[Page context')) {
      renderUser(msg.content);
    } else if (msg.role === 'assistant') {
      const text = Array.isArray(msg.content)
        ? msg.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()
        : typeof msg.content === 'string' ? msg.content : '';
      if (text) renderAssistant(text);
    }
  }
  scrollBottom();
}

$historyBtn.addEventListener('click', () => {
  const opening = $historyPanel.classList.toggle('hidden');
  if (!opening) renderHistoryPanel(); // panel is now visible
});

$sendBtn.addEventListener('click', submit);
$stopBtn.addEventListener('click', () => { abortController?.abort(); });
$input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
$input.addEventListener('input', () => { $input.style.height = 'auto'; $input.style.height = Math.min($input.scrollHeight, 120) + 'px'; });
$settingsBtn.addEventListener('click', () => $settingsPanel.classList.toggle('hidden'));
$clearBtn.addEventListener('click', () => { history = []; $messages.innerHTML = ''; currentChatId = crypto.randomUUID(); sessionIn = 0; sessionOut = 0; updateTokenBar(); });

function submit() {
  const text = $input.value.trim();
  if (!text || running) return;
  $input.value = ''; $input.style.height = 'auto';
  run(text);
}
