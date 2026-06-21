/**
 * Parses announcements.html and emails subscribers about any new announcement
 * (detected by comparing the current file to the previous commit).
 *
 * Idempotency: the API uses a content hash to skip already-sent announcements,
 * so re-runs and force-pushes are safe.
 */

const { execSync } = require('child_process')
const { createHash } = require('crypto')
const fs = require('fs')

const API = 'https://api.amplifiedsmp.org'
const htmlFile = process.argv[2]
if (!htmlFile) { console.error('Usage: send-announcement.js <path>'); process.exit(1) }

const secret = process.env.WEBHOOK_SECRET
if (!secret) { console.error('WEBHOOK_SECRET env var not set'); process.exit(1) }

// ── Parse announcements from HTML ─────────────────────────────────────────

function parseAnnouncements(html) {
  const results = []
  // Match each .announcement div (non-greedy, handles nested divs via outer match)
  const divRe = /<div\s[^>]*class="[^"]*announcement[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div|\s*$|<!--)/g
  let m
  while ((m = divRe.exec(html)) !== null) {
    const inner = m[1]
    // Extract h2 title (strip inner tags)
    const titleM = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(inner)
    if (!titleM) continue
    const title = titleM[1].replace(/<[^>]+>/g, '').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').trim()
    if (!title) continue

    // Extract first <p> as body (strip tags)
    const bodyParts = []
    const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi
    let pm
    while ((pm = pRe.exec(inner)) !== null) {
      const text = pm[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&#\d+;/g, c => String.fromCharCode(parseInt(c.slice(2,-1)))).trim()
      if (text) bodyParts.push(text)
    }
    if (!bodyParts.length) continue

    results.push({ title, body: bodyParts.join('\n\n') })
  }
  return results
}

// ── Compare to previous commit ────────────────────────────────────────────

let prevHtml = ''
try {
  prevHtml = execSync(`git show HEAD~1:${htmlFile}`, { encoding: 'utf8' })
} catch {
  // First commit or file didn't exist before — treat all as new
}

const currentHtml = fs.readFileSync(htmlFile, 'utf8')
const currentAnns = parseAnnouncements(currentHtml)
const prevAnns    = parseAnnouncements(prevHtml)
const prevHashes  = new Set(prevAnns.map(a => createHash('sha256').update(a.title + '|||' + a.body).digest('hex').slice(0, 16)))

const newAnns = currentAnns.filter(a => {
  const h = createHash('sha256').update(a.title + '|||' + a.body).digest('hex').slice(0, 16)
  return !prevHashes.has(h)
})

if (!newAnns.length) {
  console.log('No new announcements detected — nothing to send.')
  process.exit(0)
}

console.log(`Found ${newAnns.length} new announcement(s).`)

// ── Send each new announcement to the API ────────────────────────────────

;(async () => {
  for (const ann of newAnns) {
    const content_hash = createHash('sha256').update(ann.title + '|||' + ann.body).digest('hex').slice(0, 16)
    console.log(`Sending: "${ann.title}" (hash: ${content_hash})`)

    const res = await fetch(`${API}/webhook/announce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': secret },
      body: JSON.stringify({ title: ann.title, body: ann.body, content_hash }),
    })

    const data = await res.json()
    if (res.ok) {
      if (data.skipped) console.log(`  → Already sent (skipped).`)
      else console.log(`  → Queued for ${data.id}`)
    } else {
      console.error(`  → Error: ${data.error}`)
      process.exit(1)
    }
  }
})()
