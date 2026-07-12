// Retry utility with transient error detection and exponential backoff.

const TRANSIENT_PATTERNS = [
  /load failed/i,
  /network connection was lost/i,
  /network request failed/i,
  /failed to fetch/i,
  /econnreset/i,
  /econnrefused/i,
  /etimedout/i,
  /socket hang.?up/i,
  /timeout/i,
  /rate.?limit/i,
  /too many requests/i,
  /service unavailable/i,
  /overloaded/i,
  /temporarily unavailable/i,
  /internal server error/i,
];

export function isTransientError(error) {
  if (!error) return false;
  const msg = typeof error === 'string' ? error : (error.message || String(error));
  const status = error.status ?? error.response?.status ?? error.error?.status;
  if (status === 429 || status === 502 || status === 503) return true;
  return TRANSIENT_PATTERNS.some(p => p.test(msg));
}

export async function retry(fn, {
  attempts = 3,
  delay = 500,
  factor = 2,
  maxDelay = 10000,
  retryIf = isTransientError,
  onRetry = null,
} = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i === attempts - 1) break;
      if (!retryIf(err)) throw err;
      const wait = Math.min(delay * Math.pow(factor, i), maxDelay);
      if (onRetry) onRetry({ error: err, attempt: i + 1, delay: wait });
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastError;
}
