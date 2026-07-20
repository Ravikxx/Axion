import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LUMEN_UPSTREAM_URLS,
  probeLumenHealth,
  proxyLumenRequest,
} from '../src/lumen-upstream.js'

const env = { RUNPOD_ENDPOINT_ID: 'ep-test', RUNPOD_API_KEY: 'rp-test-key' }

const completion = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 123,
  model: 'lumen',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
}

test('resolves the RunPod OpenAI-compatible chat and health URLs', () => {
  assert.equal(LUMEN_UPSTREAM_URLS.chat(env), 'https://api.runpod.ai/v2/ep-test/openai/v1/chat/completions')
  assert.equal(LUMEN_UPSTREAM_URLS.health(env), 'https://api.runpod.ai/v2/ep-test/health')
})

test('sends the RunPod bearer token and forces model: lumen', async () => {
  let seen
  const fetchImpl = async (url, options) => {
    seen = { url, options }
    return Response.json(completion)
  }

  const response = await proxyLumenRequest({ messages: [{ role: 'user', content: 'Hi' }] }, env, fetchImpl)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), completion)
  assert.equal(seen.url, 'https://api.runpod.ai/v2/ep-test/openai/v1/chat/completions')
  assert.equal(seen.options.headers.Authorization, 'Bearer rp-test-key')

  const sent = JSON.parse(seen.options.body)
  assert.equal(sent.model, 'lumen')
})

test('asks vLLM for real usage in the final chunk when streaming', async () => {
  let seen
  const fetchImpl = async (url, options) => {
    seen = { url, options }
    return new Response('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }

  const response = await proxyLumenRequest({ stream: true, messages: [{ role: 'user', content: 'Hi' }] }, env, fetchImpl)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Content-Type'), 'text/event-stream; charset=utf-8')
  assert.match(await response.text(), /"content":"Hi"/)

  const sent = JSON.parse(seen.options.body)
  assert.equal(sent.stream, true)
  assert.deepEqual(sent.stream_options, { include_usage: true })
})

test('surfaces a non-2xx RunPod response as an upstream error', async () => {
  const fetchImpl = async () => new Response('model is cold-starting', { status: 503 })
  const response = await proxyLumenRequest({ messages: [{ role: 'user', content: 'Hi' }] }, env, fetchImpl)
  assert.equal(response.status, 503)
  assert.match(await response.text(), /model is cold-starting/)
})

test('a network failure reaching RunPod maps to a 502', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed') }
  const response = await proxyLumenRequest({ messages: [{ role: 'user', content: 'Hi' }] }, env, fetchImpl)
  assert.equal(response.status, 502)
  assert.match(await response.text(), /Could not reach Lumen/)
})

test('health probe treats scale-to-zero (a reachable but cold endpoint) as healthy', async () => {
  assert.equal(await probeLumenHealth(env, async () => new Response('{}', { status: 200 })), true)
  assert.equal(await probeLumenHealth(env, async () => new Response('nope', { status: 503 })), false)
  assert.equal(await probeLumenHealth(env, async () => { throw new Error('down') }), false)
})
