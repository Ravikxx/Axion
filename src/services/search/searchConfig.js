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
  if (SEARCH_CONFIG.backend === 'fs') return 'fs';
  if (SEARCH_CONFIG.backend === 'ripgrep') return 'ripgrep';
  return ripgrepAvailable() ? 'ripgrep' : 'fs';
}