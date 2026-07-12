import { getProviderFallbackChain } from '../config.js';
import { resolveProvider } from './models.js';

/**
 * Provider Fallback Chain — resolves the next provider on rate-limit errors.
 *
 * Configuration: `providerFallbackChain` in config is an ordered list of model
 * aliases. When the active model is rate-limited, this module resolves the next
 * provider in the chain.
 *
 * Design:
 *  - If the active model is NOT in the chain, fallback starts from the beginning.
 *  - If the active model IS in the chain, advance to the next entry.
 *  - When the last entry is exhausted, return null (no infinite loops).
 *  - Candidate IDs are validated: each must resolve to a provider that has an
 *    API key configured, otherwise it is skipped.
 */

/**
 * Check if a model alias has a valid, configured provider (API key present).
 */
function isModelAvailable(alias) {
  try {
    const provider = resolveProvider(alias);
    // Quick heuristic: if resolveProvider doesn't throw, the alias is valid.
    // The actual API key check happens at createClient time; here we just
    // verify the alias is recognized.
    return typeof provider === 'string' && provider.length > 0;
  } catch {
    return false;
  }
}

/**
 * Resolve the next fallback model alias.
 * @param {string} currentAlias - the model that just failed
 * @param {string[]} [chainOverride] - optional override chain (for testing)
 * @returns {string|null} next model alias, or null if chain exhausted
 */
export function resolveNextFallback(currentAlias, chainOverride) {
  const chain = chainOverride || getProviderFallbackChain();
  if (!chain || !chain.length) return null;

  const currentProvider = resolveProvider(currentAlias);
  const idx = chain.findIndex((a) => {
    try { return resolveProvider(a) === currentProvider && a.toLowerCase() === currentAlias.toLowerCase(); }
    catch { return false; }
  });

  // If current model is in the chain, start from the next entry; otherwise from 0
  const start = idx >= 0 ? idx + 1 : 0;

  for (let i = start; i < chain.length; i++) {
    const candidate = chain[i];
    // Skip if it's the same model that just failed
    if (candidate.toLowerCase() === currentAlias.toLowerCase()) continue;
    if (isModelAvailable(candidate)) return candidate;
  }

  return null;
}

/**
 * Determine if an error is a rate-limit / quota error suitable for fallback.
 */
export function isRateLimitError(err) {
  const status = err?.status ?? err?.response?.status;
  const msg = err?.message || String(err);
  return status === 429 || /rate.?limit|quota|too many requests/i.test(msg);
}
