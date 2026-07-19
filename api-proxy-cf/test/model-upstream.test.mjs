import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LUMEN_UPSTREAM_URLS,
  parseGradioEventBlock,
  probeLumenHealth,
  proxyLumenRequest,
} from '../src/lumen-upstream.js'

const completion = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 123,
  model: 'lumen',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
}

function gradioEvents(envelope) {
  return new Response(
    `event: heartbeat\ndata: null\n\nevent: complete\ndata: ${JSON.stringify([envelope])}\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } },
  )
}

test('uses the supported named Gradio endpoints', () => {
  assert.equal(LUMEN_UPSTREAM_URLS.chat, 'https://axionlabsai-lumen.hf.space/gradio_api/call/v2/openai_chat')
  assert.equal(LUMEN_UPSTREAM_URLS.health, 'https://axionlabsai-lumen.hf.space/gradio_api/api/model_health')
})

test('parses Gradio SSE blocks', () => {
  assert.deepEqual(parseGradioEventBlock('event: complete\ndata: [{"ok":true}]'), {
    event: 'complete',
    data: '[{"ok":true}]',
  })
})

test('converts a Gradio completion to OpenAI JSON', async () => {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options })
    if (calls.length === 1) return Response.json({ event_id: 'event-123' })
    return gradioEvents({ ok: true, status: 200, response: completion })
  }

  const response = await proxyLumenRequest({ messages: [{ role: 'user', content: 'Hi' }] }, fetchImpl)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), completion)
  assert.equal(calls[1].url, 'https://axionlabsai-lumen.hf.space/gradio_api/call/openai_chat/event-123')

  const submitted = JSON.parse(calls[0].options.body)
  assert.equal(submitted.body.model, 'lumen')
  assert.equal(submitted.body.stream, false)
})

test('converts a completed result to OpenAI-compatible SSE', async () => {
  let call = 0
  const fetchImpl = async () => {
    call += 1
    return call === 1
      ? Response.json({ event_id: 'stream-123' })
      : gradioEvents({ ok: true, status: 200, response: completion })
  }

  const response = await proxyLumenRequest({ stream: true, messages: [{ role: 'user', content: 'Hi' }] }, fetchImpl)
  const text = await response.text()
  assert.match(text, /: keep-alive/)
  assert.match(text, /"content":"Hello!"/)
  assert.match(text, /"finish_reason":"stop"/)
  assert.match(text, /data: \[DONE\]/)
})

test('maps model-loading responses to HTTP 503', async () => {
  let call = 0
  const fetchImpl = async () => {
    call += 1
    return call === 1
      ? Response.json({ event_id: 'loading-123' })
      : gradioEvents({
          ok: false,
          status: 503,
          error: { message: 'Model is still loading.', type: 'upstream_unavailable' },
        })
  }

  const response = await proxyLumenRequest({ messages: [{ role: 'user', content: 'Hi' }] }, fetchImpl)
  assert.equal(response.status, 503)
  assert.equal(await response.text(), 'Model is still loading.')
})

test('health probe requires an explicitly ready model', async () => {
  assert.equal(await probeLumenHealth(async () => Response.json({ data: [{ ready: true }] })), true)
  assert.equal(await probeLumenHealth(async () => Response.json({ data: [{ ready: false }] })), false)
  assert.equal(await probeLumenHealth(async () => new Response('no', { status: 503 })), false)
})
