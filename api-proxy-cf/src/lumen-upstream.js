const HF_SPACE_API = 'https://axionlabsai-lumen.hf.space/gradio_api'
const CHAT_SUBMIT_URL = `${HF_SPACE_API}/call/v2/openai_chat`
const CHAT_EVENT_URL = `${HF_SPACE_API}/call/openai_chat`
const HEALTH_URL = `${HF_SPACE_API}/api/model_health`

function errorResponse(message, status = 502) {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

export function parseGradioEventBlock(block) {
  let event = 'message'
  const data = []
  for (const rawLine of block.replaceAll('\r', '').split('\n')) {
    if (rawLine.startsWith('event:')) event = rawLine.slice(6).trim()
    if (rawLine.startsWith('data:')) data.push(rawLine.slice(5).trimStart())
  }
  return { event, data: data.join('\n') }
}

function parseCompletionEnvelope(data) {
  try {
    const outputs = JSON.parse(data)
    return Array.isArray(outputs) ? outputs[0] : null
  } catch {
    return null
  }
}

function completionResponse(envelope) {
  if (!envelope || envelope.ok !== true || !envelope.response) {
    const message = envelope?.error?.message || 'Lumen returned an invalid response.'
    return errorResponse(message, Number(envelope?.status) || 502)
  }
  return new Response(JSON.stringify(envelope.response), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

async function bufferedCompletion(eventResponse) {
  const payload = await eventResponse.text()
  for (const block of payload.replaceAll('\r', '').split('\n\n')) {
    const parsed = parseGradioEventBlock(block)
    if (parsed.event === 'complete') return completionResponse(parseCompletionEnvelope(parsed.data))
    if (parsed.event === 'error') return errorResponse('Lumen generation failed.', 502)
  }
  return errorResponse('Lumen closed the request before returning a completion.', 502)
}

function openAIChunk(result, content, finishReason, includeUsage = false) {
  const chunk = {
    id: result.id || `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion.chunk',
    created: result.created || Math.floor(Date.now() / 1000),
    model: result.model || 'lumen',
    choices: [{
      index: 0,
      delta: content ? { content } : {},
      finish_reason: finishReason,
    }],
  }
  if (includeUsage && result.usage) chunk.usage = result.usage
  return `data: ${JSON.stringify(chunk)}\n\n`
}

function streamingCompletion(eventResponse) {
  const reader = eventResponse.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      let buffer = ''
      let finished = false

      const sendError = message => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message, type: 'upstream_error' } })}\n\n`))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      }

      try {
        while (true) {
          const { done, value } = await reader.read()
          buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replaceAll('\r', '')
          const blocks = buffer.split('\n\n')
          buffer = blocks.pop() || ''

          for (const block of blocks) {
            const parsed = parseGradioEventBlock(block)
            if (parsed.event === 'heartbeat') {
              controller.enqueue(encoder.encode(': keep-alive\n\n'))
              continue
            }
            if (parsed.event === 'error') {
              sendError('Lumen generation failed.')
              finished = true
              break
            }
            if (parsed.event !== 'complete') continue

            const envelope = parseCompletionEnvelope(parsed.data)
            if (!envelope || envelope.ok !== true || !envelope.response) {
              sendError(envelope?.error?.message || 'Lumen returned an invalid response.')
              finished = true
              break
            }

            const result = envelope.response
            const choice = result.choices?.[0] || {}
            const content = choice.message?.content || ''
            if (content) controller.enqueue(encoder.encode(openAIChunk(result, content, null)))
            controller.enqueue(encoder.encode(openAIChunk(result, '', choice.finish_reason || 'stop', true)))
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            finished = true
            break
          }

          if (finished || done) break
        }
        if (!finished) sendError('Lumen closed the request before returning a completion.')
      } catch (error) {
        if (!finished) sendError(`Lumen stream failed: ${error.message}`)
      } finally {
        controller.close()
        reader.releaseLock()
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  })
}

export async function proxyLumenRequest(body, fetchImpl = fetch) {
  let submission
  try {
    submission = await fetchImpl(CHAT_SUBMIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: { ...body, model: 'lumen', stream: false },
      }),
    })
  } catch (error) {
    return errorResponse(`Could not reach Lumen: ${error.message}`, 502)
  }

  if (!submission.ok) return errorResponse(`Lumen rejected the request: ${await submission.text()}`, submission.status)

  let eventId
  try {
    eventId = (await submission.json()).event_id
  } catch {}
  if (!eventId || !/^[a-zA-Z0-9_-]+$/.test(eventId)) {
    return errorResponse('Lumen did not return a valid event ID.', 502)
  }

  let events
  try {
    events = await fetchImpl(`${CHAT_EVENT_URL}/${eventId}`, {
      headers: { Accept: 'text/event-stream' },
    })
  } catch (error) {
    return errorResponse(`Could not read the Lumen response: ${error.message}`, 502)
  }
  if (!events.ok || !events.body) return errorResponse(`Lumen event stream failed: ${await events.text()}`, events.status || 502)

  return body.stream ? streamingCompletion(events) : bufferedCompletion(events)
}

export async function probeLumenHealth(fetchImpl = fetch, timeoutMs = 6000) {
  try {
    const response = await fetchImpl(HEALTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [] }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return false
    const payload = await response.json()
    return payload.data?.[0]?.ready === true
  } catch {
    return false
  }
}

export const LUMEN_UPSTREAM_URLS = {
  chat: CHAT_SUBMIT_URL,
  health: HEALTH_URL,
}
