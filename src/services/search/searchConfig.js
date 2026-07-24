// Search engine config facade.
//
// Re-exports the central SEARCH_CONFIG from src/config.js so it can live
// alongside the other config knobs (env-var driven) while still being
// importable from the search service without a circular dependency.
// `resolveBackend()` mirrors opencodeAX's ripgrep/fff auto-selection logic.

import { SEARCH_CONFIG } from '../../config.js';
import { ripgrepAvailable } from './ripgrepAdapter.js';

export { SEARCH_CONFIG };

export function resolveBackend() {
  const configured = process.env.AXION_SEARCH_BACKEND || SEARCH_CONFIG.backend;
  if (configured === 'fs') return 'fs';
  if (configured === 'ripgrep') return 'ripgrep';
  return ripgrepAvailable() ? 'ripgrep' : 'fs';
}
