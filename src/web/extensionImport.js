import { timingSafeEqual } from 'crypto';

export function tokensMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function copyApiKeys(apiKeys) {
  return Object.fromEntries(
    Object.entries(apiKeys || {}).filter(([, value]) => typeof value === 'string' && value.length > 0),
  );
}

function copyEndpoints(customEndpoints) {
  const out = {};
  for (const [name, endpoint] of Object.entries(customEndpoints || {})) {
    if (!endpoint || typeof endpoint.baseURL !== 'string') continue;
    out[name] = {
      baseURL: endpoint.baseURL,
      model: typeof endpoint.model === 'string' ? endpoint.model : '',
      apiKey: typeof endpoint.apiKey === 'string' ? endpoint.apiKey : '',
    };
  }
  return out;
}

export function createExtensionImportResponse({
  providedToken,
  expectedToken,
  apiKeys,
  customEndpoints,
  model,
}) {
  const headers = {
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
  };
  if (!tokensMatch(providedToken, expectedToken)) {
    return { status: 403, headers, body: { error: 'Invalid extension import token' } };
  }
  return {
    status: 200,
    headers,
    body: {
      apiKeys: copyApiKeys(apiKeys),
      customEndpoints: copyEndpoints(customEndpoints),
      model: typeof model === 'string' && model ? model : null,
    },
  };
}
