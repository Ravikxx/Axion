const COMPLETIONS_URL = 'https://api.amplifiedsmp.org/v1/chat/completions'

// Partial text is written to storage at most this often. Frequent enough that a
// reader attaching after an eviction sees almost everything, rare enough that a
// fast token stream doesn't turn into a storage write per token.
const PARTIAL_PERSIST_MS = 750

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorText(error) {
  return String(error?.message || error || 'Generation failed').slice(0, 1000)
}

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

// One Durable Object instance owns one website-chat generation.
//
// The object starts work from an alarm rather than from the browser request
// that created it, so closing a tab cannot cancel the model request. It streams
// the reply from the model and fans those chunks out to however many tabs are
// watching, while keeping a full copy so a tab that joins late — or comes back
// tomorrow — sees the whole thing. The finished message is committed to D1
// before the object discards its short-lived session token.
//
// There is exactly one model call per generation. The browser never calls the
// model itself; it only reads this object's stream. Running both would bill the
// user twice for one reply.
export class ChatGeneration {
  constructor(state, env) {
    this.state = state
    this.env = env

    // Live readers. Lost if the object is evicted, which is why `text` is also
    // persisted — a reconnecting tab replays from storage instead.
    this.subscribers = new Set()
    this.text = ''
    this.toolCalls = []
    this.terminal = null // { status, error } once the generation has settled
    this.persistedAt = 0
  }

  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/start') return this.start(request)
    if (request.method === 'GET' && url.pathname === '/stream') return this.openStream()
    return json({ error: 'Not found' }, 404)
  }

  async start(request) {
    const incoming = await request.json().catch(() => null)
    if (!incoming?.id || !incoming?.chatId || !incoming?.userId || !incoming?.token || !incoming?.requestBody) {
      return json({ error: 'Invalid generation payload' }, 400)
    }

    const existing = await this.state.storage.get('job')
    if (existing) {
      if (existing.id === incoming.id) return json({ ok: true, id: existing.id }, 202)
      return json({ error: 'Generation object already has a job' }, 409)
    }

    await this.state.storage.put('job', incoming)
    await this.state.storage.setAlarm(Date.now())
    return json({ ok: true, id: incoming.id }, 202)
  }

  // Replays everything generated so far, then streams the rest live. A tab that
  // joins at any point gets the same complete reply as one that watched from
  // the start, so reconnecting never shows a half message.
  async openStream() {
    const [job, partial, settled] = await Promise.all([
      this.state.storage.get('job'),
      this.state.storage.get('partial'),
      this.state.storage.get('terminal'),
    ])

    const snapshot = this.text || partial?.text || ''
    const terminal = this.terminal || settled || null
    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()

    // Queued, not awaited, for the same reason as broadcast: the response has
    // not been returned yet, so nothing is reading and an awaited write would
    // deadlock here.
    const push = (event, data) => {
      writer.write(encoder.encode(sse(event, data))).catch(() => { /* reader gone */ })
    }

    // Queued before returning so the client has state immediately rather than
    // sitting on an open connection with nothing in it.
    push('snapshot', { text: snapshot })

    if (terminal || !job) {
      push(terminal?.status === 'failed' ? 'error' : 'done', terminal || { status: 'completed' })
      writer.close().catch(() => { /* reader gone */ })
    } else {
      this.subscribers.add(writer)
    }

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': 'https://axion.amplifiedsmp.org',
        'Access-Control-Allow-Credentials': 'true',
      },
    })
  }

  // Deliberately does not await the writes. A writer only settles once its
  // reader has taken the chunk, so awaiting would let one slow or stalled tab
  // throttle the model stream for everybody — and a tab that stops reading
  // without disconnecting would stall the generation outright. Writes still
  // arrive in order because they queue per writer.
  broadcast(event, data) {
    if (!this.subscribers.size) return
    const payload = new TextEncoder().encode(sse(event, data))
    for (const writer of this.subscribers) {
      writer.write(payload).catch(() => this.subscribers.delete(writer))
    }
  }

  closeSubscribers() {
    for (const writer of this.subscribers) {
      writer.close().catch(() => { /* reader already went away */ })
    }
    this.subscribers.clear()
  }

  async append(chunk) {
    this.text += chunk
    this.broadcast('delta', { text: chunk })
    const now = Date.now()
    if (now - this.persistedAt >= PARTIAL_PERSIST_MS) {
      this.persistedAt = now
      await this.state.storage.put('partial', { text: this.text })
    }
  }

  async alarm() {
    const job = await this.state.storage.get('job')
    if (!job) return

    // The model already answered but the D1 commit failed. Retry only the
    // commit — re-running the model would charge the user a second time.
    if (job.resultMessage) {
      await this.commitResult(job)
      return
    }

    await this.env.DB.prepare(
      "UPDATE chat_generations SET status='running', started=COALESCE(started, ?) WHERE id=? AND user_id=?"
    ).bind(Date.now(), job.id, job.userId).run()

    let response
    try {
      response = await fetch(COMPLETIONS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${job.token}`,
        },
        body: JSON.stringify({ ...job.requestBody, stream: true }),
      })
    } catch (error) {
      await this.fail(job, `Could not reach Lumen: ${errorText(error)}`)
      return
    }

    if (!response.ok || !response.body) {
      const detail = (await response.text().catch(() => '')).slice(0, 800)
      await this.fail(job, detail || `Lumen returned HTTP ${response.status}`)
      return
    }

    try {
      await this.consume(response.body)
    } catch (error) {
      await this.fail(job, `Lost the connection to Lumen: ${errorText(error)}`)
      return
    }

    if (!this.text && !this.toolCalls.length) {
      await this.fail(job, 'Lumen returned an empty reply')
      return
    }

    job.resultMessage = {
      role: 'assistant',
      content: this.text,
      ...(this.toolCalls.length ? { tool_calls: this.toolCalls } : {}),
      ts: Date.now(),
      generation_id: job.id,
    }
    await this.state.storage.put('job', job)
    await this.commitResult(job)
  }

  // Parses the upstream SSE stream, appending content deltas and accumulating
  // tool calls, which arrive in fragments indexed by position.
  async consume(body) {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let pending = ''

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6).trim()
        if (!payload || payload === '[DONE]') continue

        let delta
        try { delta = JSON.parse(payload).choices?.[0]?.delta } catch { continue }
        if (!delta) continue

        if (typeof delta.content === 'string' && delta.content) await this.append(delta.content)

        for (const call of delta.tool_calls || []) {
          const index = call.index ?? 0
          const slot = this.toolCalls[index] || { id: '', type: 'function', function: { name: '', arguments: '' } }
          if (call.id) slot.id = call.id
          if (call.function?.name) slot.function.name += call.function.name
          if (call.function?.arguments) slot.function.arguments += call.function.arguments
          this.toolCalls[index] = slot
        }
      }
    }

    this.toolCalls = this.toolCalls.filter(Boolean)
  }

  async commitResult(job) {
    let row
    try {
      row = await this.env.DB.prepare(
        'SELECT messages FROM chats WHERE id=? AND user_id=?'
      ).bind(job.chatId, job.userId).first()
    } catch (error) {
      await this.retryCommit(job, error)
      return
    }

    if (!row) {
      await this.fail(job, 'The chat was deleted before the reply finished')
      return
    }

    let messages = []
    try { messages = JSON.parse(row.messages || '[]') } catch {}
    if (!Array.isArray(messages)) messages = []

    // Alarm delivery is at-least-once. A generation id on the assistant
    // message makes the D1 append idempotent if an alarm is retried.
    if (!messages.some(message => message?.generation_id === job.id)) {
      messages.push(job.resultMessage)
    }

    const completed = Date.now()
    try {
      await this.env.DB.batch([
        this.env.DB.prepare(
          'UPDATE chats SET messages=?, updated=? WHERE id=? AND user_id=?'
        ).bind(JSON.stringify(messages), completed, job.chatId, job.userId),
        this.env.DB.prepare(
          "UPDATE chat_generations SET status='completed', error=NULL, completed=? WHERE id=? AND user_id=?"
        ).bind(completed, job.id, job.userId),
      ])
    } catch (error) {
      await this.retryCommit(job, error)
      return
    }

    await this.settle({ status: 'completed' })
    await this.state.storage.delete('job')
  }

  async retryCommit(job, error) {
    await this.env.DB.prepare(
      "UPDATE chat_generations SET status='running', error=? WHERE id=? AND user_id=?"
    ).bind(`Saving reply: ${errorText(error)}`, job.id, job.userId).run().catch(() => {})
    await this.state.storage.setAlarm(Date.now() + 5000)
  }

  async fail(job, message) {
    await this.env.DB.prepare(
      "UPDATE chat_generations SET status='failed', error=?, completed=? WHERE id=? AND user_id=?"
    ).bind(errorText(message), Date.now(), job.id, job.userId).run().catch(() => {})
    await this.settle({ status: 'failed', error: errorText(message) })
    await this.state.storage.delete('job')
  }

  // Records how the generation ended and releases every reader. The terminal
  // state outlives the object so a tab reconnecting later is told the outcome
  // instead of hanging on a stream that will never produce anything.
  async settle(terminal) {
    this.terminal = terminal
    await this.state.storage.put('terminal', terminal)
    await this.state.storage.delete('partial')
    this.broadcast(terminal.status === 'failed' ? 'error' : 'done', terminal)
    this.closeSubscribers()
  }
}
