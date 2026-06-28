// OpenTUI entry point for the Axion TUI. Runs under Bun (OpenTUI's renderer
// requires Bun's FFI). Launched in production via the Node→Bun bootstrap.
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { App } from './App.jsx';
import { getSavedModel, getSavedMode, getSavedApiKeys, getSavedCustomEndpoints } from '../persist.js';
import { API_KEYS, CUSTOM_ENDPOINTS, DEFAULT_MODEL, DEFAULT_MODE } from '../config.js';

// ── Seed runtime config from saved settings (mirrors src/index.js) ──────────────
const savedKeys = getSavedApiKeys();
for (const [provider, key] of Object.entries(savedKeys)) {
  if (key && !API_KEYS[provider]) API_KEYS[provider] = key;
}
const savedEndpoints = getSavedCustomEndpoints();
for (const [name, ep] of Object.entries(savedEndpoints)) {
  if (ep?.baseURL) CUSTOM_ENDPOINTS[name] = ep;
}

const initialModel = getSavedModel() || DEFAULT_MODEL;
const initialMode  = getSavedMode()  || DEFAULT_MODE;

const renderer = await createCliRenderer({ exitOnCtrlC: true });
createRoot(renderer).render(<App initialModel={initialModel} initialMode={initialMode} />);
