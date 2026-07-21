import assert from 'node:assert/strict'
import test from 'node:test'

import { runPythonDisposable } from '../src/sandbox.js'

const env = { DAYTONA_API_KEY: 'dtn-test-key' }

function fetchStub({ createOk = true, sandboxId = 'sb-123', codeRunResponse, codeRunStatus = 200, deleteOk = true } = {}) {
  const calls = []
  return {
    calls,
    fn: async (url, options) => {
      calls.push({ url, options })
      if (url === 'https://app.daytona.io/api/sandbox' && options.method === 'POST') {
        if (!createOk) return new Response('nope', { status: 500 })
        return Response.json({ id: sandboxId, state: 'started' })
      }
      if (url === `https://proxy.app.daytona.io/toolbox/${sandboxId}/process/code-run`) {
        return new Response(JSON.stringify(codeRunResponse), { status: codeRunStatus })
      }
      if (url === `https://app.daytona.io/api/sandbox/${sandboxId}` && options.method === 'DELETE') {
        if (!deleteOk) throw new Error('delete failed')
        return Response.json({ id: sandboxId, state: 'destroying' })
      }
      throw new Error(`unexpected fetch: ${url}`)
    },
  }
}

test('creates a sandbox, runs code, and always destroys it — success case', async () => {
  const stub = fetchStub({ codeRunResponse: { exitCode: 0, result: 'hello\n' } })
  const result = await runPythonDisposable(env, 'print("hello")', { networkAccess: false, timeoutMs: 10_000 }, stub.fn)

  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, 'hello\n')
  assert.equal(result.error, null)
  assert.equal(result.timedOut, false)

  const createCall = stub.calls.find(c => c.url === 'https://app.daytona.io/api/sandbox')
  const createBody = JSON.parse(createCall.options.body)
  assert.equal(createBody.networkBlockAll, true, 'networkAccess:false must map to networkBlockAll:true')

  const runCall = stub.calls.find(c => c.url.includes('/process/code-run'))
  const runBody = JSON.parse(runCall.options.body)
  assert.equal(runBody.timeout, 10, 'timeoutMs must convert to whole seconds for Daytona')

  assert.ok(stub.calls.some(c => c.options.method === 'DELETE'), 'sandbox must always be destroyed')
})

test('networkAccess:true maps to networkBlockAll:false', async () => {
  const stub = fetchStub({ codeRunResponse: { exitCode: 0, result: '' } })
  await runPythonDisposable(env, 'pass', { networkAccess: true, timeoutMs: 20_000 }, stub.fn)
  const createBody = JSON.parse(stub.calls[0].options.body)
  assert.equal(createBody.networkBlockAll, false)
})

test('a non-zero exit code and traceback still come back as a normal (non-error) result', async () => {
  const stub = fetchStub({ codeRunResponse: { exitCode: 1, result: 'Traceback...\nValueError: boom\n' } })
  const result = await runPythonDisposable(env, 'raise ValueError("boom")', { networkAccess: false, timeoutMs: 10_000 }, stub.fn)
  assert.equal(result.exitCode, 1)
  assert.match(result.stdout, /ValueError: boom/)
  assert.equal(result.error, null)
})

test('a Daytona execution timeout (408/REQUEST_TIMEOUT) is reported as timedOut, not a generic error', async () => {
  const stub = fetchStub({
    codeRunResponse: { statusCode: 408, message: 'request timeout: command execution timeout', code: 'REQUEST_TIMEOUT' },
    codeRunStatus: 408,
  })
  const result = await runPythonDisposable(env, 'while True: pass', { networkAccess: false, timeoutMs: 5_000 }, stub.fn)
  assert.equal(result.timedOut, true)
  assert.equal(result.error, null)
  assert.equal(result.exitCode, null)
})

test('sandbox creation failure surfaces as an error result, no code-run attempted', async () => {
  const stub = fetchStub({ createOk: false })
  const result = await runPythonDisposable(env, 'print(1)', { networkAccess: false, timeoutMs: 10_000 }, stub.fn)
  assert.match(result.error, /Daytona sandbox creation failed/)
  assert.ok(!stub.calls.some(c => c.url.includes('/process/code-run')))
})

test('a failed cleanup (destroy) does not overwrite a successful execution result', async () => {
  const stub = fetchStub({ codeRunResponse: { exitCode: 0, result: 'ok\n' }, deleteOk: false })
  const result = await runPythonDisposable(env, 'print("ok")', { networkAccess: false, timeoutMs: 10_000 }, stub.fn)
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, 'ok\n')
})

test('missing DAYTONA_API_KEY short-circuits with a clear error, no fetch calls', async () => {
  const calls = []
  const fn = async (url) => { calls.push(url); throw new Error('should not be called') }
  const result = await runPythonDisposable({}, 'print(1)', { networkAccess: false, timeoutMs: 10_000 }, fn)
  assert.match(result.error, /DAYTONA_API_KEY/)
  assert.equal(calls.length, 0)
})
