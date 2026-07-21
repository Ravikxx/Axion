// Runs untrusted, model-generated Python in a disposable Daytona sandbox
// (daytona.io) — create, execute, destroy, every time. No state or files
// persist between calls; that's a deliberate v1 simplification (see the
// sandbox plan doc), not an oversight.
//
// API shapes below were verified directly against Daytona's live API
// (not just docs) while building this:
//   - POST https://app.daytona.io/api/sandbox
//       body: { language, autoDeleteInterval, networkBlockAll }
//       → { id, state, ... }
//   - POST https://proxy.app.daytona.io/toolbox/{id}/process/code-run
//       body: { code, language, timeout }  (timeout is SECONDS, not ms)
//       success → { exitCode, result }   (stdout+stderr combined into `result`;
//         Daytona doesn't separate them, confirmed empirically)
//       Daytona-level failure (e.g. the sandbox's own execution timeout
//       firing) → a differently-shaped error object with `statusCode`/`code`
//       instead of `exitCode`/`result` — distinguished by checking for
//       `exitCode` being a number, not by status code alone.
//   - DELETE https://app.daytona.io/api/sandbox/{id} → 200
//
// Network blocking (`networkBlockAll: true`) doesn't make a blocked
// request fail fast — it hangs until something times out. Confirmed by
// testing: a blocked outbound request just sat until Daytona's own
// execution-timeout fired. This is why `timeoutMs` should stay short.

const CREATE_URL = 'https://app.daytona.io/api/sandbox'
const TOOLBOX_BASE = 'https://proxy.app.daytona.io/toolbox'

function deleteUrl(id) {
  return `${CREATE_URL}/${id}`
}

async function createSandbox(env, networkAccess, fetchImpl) {
  const res = await fetchImpl(CREATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.DAYTONA_API_KEY}` },
    body: JSON.stringify({
      language: 'python',
      autoDeleteInterval: 0, // also deleted explicitly below; this is a backstop if that call fails
      networkBlockAll: !networkAccess,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Daytona sandbox creation failed (${res.status}): ${body}`)
  }
  const data = await res.json()
  return data.id
}

async function destroySandbox(sandboxId, env, fetchImpl) {
  try {
    await fetchImpl(deleteUrl(sandboxId), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${env.DAYTONA_API_KEY}` },
    })
  } catch (err) {
    // Best-effort — a failed cleanup shouldn't mask the execution result,
    // and autoDeleteInterval:0 is the backstop if this genuinely fails.
    console.error(`[sandbox] failed to destroy sandbox ${sandboxId}: ${err?.message || err}`)
  }
}

export async function runPythonDisposable(env, code, { networkAccess, timeoutMs }, fetchImpl = fetch) {
  if (!env.DAYTONA_API_KEY) return { stdout: '', stderr: '', exitCode: null, artifacts: [], timedOut: false, error: 'DAYTONA_API_KEY not set' }

  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  let sandboxId
  try {
    sandboxId = await createSandbox(env, networkAccess, fetchImpl)
  } catch (err) {
    return { stdout: '', stderr: '', exitCode: null, artifacts: [], timedOut: false, error: String(err?.message || err) }
  }

  try {
    const res = await fetchImpl(`${TOOLBOX_BASE}/${sandboxId}/process/code-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.DAYTONA_API_KEY}` },
      body: JSON.stringify({ code, language: 'python', timeout: timeoutSeconds }),
    })
    const data = await res.json().catch(() => ({}))

    if (typeof data.exitCode === 'number') {
      return {
        stdout: data.result || '',
        stderr: '',
        exitCode: data.exitCode,
        artifacts: [], // chart/image artifact shape is unconfirmed against a real matplotlib run — treat as absent for now
        timedOut: false,
        error: null,
      }
    }

    const timedOut = data.code === 'REQUEST_TIMEOUT' || res.status === 408
    return {
      stdout: '',
      stderr: '',
      exitCode: null,
      artifacts: [],
      timedOut,
      error: timedOut ? null : (data.message || `Daytona execution failed (${res.status})`),
    }
  } catch (err) {
    return { stdout: '', stderr: '', exitCode: null, artifacts: [], timedOut: false, error: String(err?.message || err) }
  } finally {
    await destroySandbox(sandboxId, env, fetchImpl)
  }
}
