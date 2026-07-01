/** One-off transactional send via the worker's /webhook/send-email route. */

const secret = (process.env.WEBHOOK_SECRET || '').trim()
if (!secret) { console.error('WEBHOOK_SECRET env var not set'); process.exit(1) }

const to = process.env.TO
const subject = process.env.SUBJECT
const html = process.env.HTML
const from = process.env.FROM || undefined
const replyTo = process.env.REPLY_TO || undefined

if (!to || !subject || !html) { console.error('TO, SUBJECT, and HTML env vars are required'); process.exit(1) }

;(async () => {
  const res = await fetch('https://api.amplifiedsmp.org/webhook/send-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': secret },
    body: JSON.stringify({ to, subject, html, from, replyTo }),
  })
  const data = await res.json().catch(() => ({}))
  if (res.ok) { console.log('Sent:', JSON.stringify(data)) }
  else { console.error('Error:', res.status, JSON.stringify(data)); process.exit(1) }
})()
