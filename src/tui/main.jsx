// OpenTUI entry point for the Axion TUI. Runs under Bun (OpenTUI's renderer
// requires Bun's FFI). Launched in production via the Node→Bun bootstrap.
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { App } from './App.jsx';

const renderer = await createCliRenderer({ exitOnCtrlC: true });
createRoot(renderer).render(<App />);
