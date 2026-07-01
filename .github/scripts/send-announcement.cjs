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
if (!htmlFile) { console.error('Usage: send-announcement.cjs <path>'); process.exit(1) }

// Trim defensively — secret stores can inject BOM/whitespace.
const secret = (process.env.WEBHOOK_SECRET || '').trim()
if (!secret) { console.error('WEBHOOK_SECRET env var not set'); process.exit(1) }

// ── Parse announcements from HTML ─────────────────────────────────────────

const BR = '%%BR%%' // plain-ASCII placeholder for intentional <br> line breaks

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&#\d+;/g, c => String.fromCharCode(parseInt(c.slice(2, -1))))
}

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
    const title = decodeEntities(titleM[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
    if (!title) continue

    // Extract each <p> as a body paragraph, collapsing source indentation
    const bodyParts = []
    const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi
    let pm
    while ((pm = pRe.exec(inner)) !== null) {
      const text = decodeEntities(
        pm[1]
          .replace(/<br\s*\/?>/gi, BR) // keep intentional breaks
          .replace(/<[^>]+>/g, '')
      )
        .replace(/\s+/g, ' ')                              // collapse HTML-source indentation/newlines
        .split(BR).map(s => s.trim()).join('\n')           // restore intentional breaks
        .trim()
      if (text) bodyParts.push(text)
    }
    if (!bodyParts.length) continue

    results.push({ title, body: bodyParts.join('\n\n') })
  }
  return results
}

// ── Compare to the pre-push state ─────────────────────────────────────────
// COMPARE_REF defaults to HEAD~1 for local/manual runs, but the workflow sets
// it to the push's actual "before" SHA — HEAD~1 alone is wrong whenever a
// push bundles more than one commit (the new announcement can land in a
// commit that isn't the very last one, invisible to a HEAD~1 diff).

const compareRef = (process.env.COMPARE_REF || '').trim() || 'HEAD~1'
// A brand-new branch's "before" SHA is all-zeros — nothing to compare against.
const isZeroSha = /^0+$/.test(compareRef)

let prevHtml = ''
if (!isZeroSha) {
  try {
    prevHtml = execSync(`git show ${compareRef}:${htmlFile}`, { encoding: 'utf8' })
  } catch {
    // Ref doesn't have this file yet (first commit that added it) — treat all as new
  }
}

const hashOf = a => createHash('sha256').update(a.title + '|||' + a.body).digest('hex').slice(0, 16)

const currentHtml = fs.readFileSync(htmlFile, 'utf8')
const currentAnns = parseAnnouncements(currentHtml)
const prevHashes  = new Set(parseAnnouncements(prevHtml).map(hashOf))

const newAnns = currentAnns.filter(a => !prevHashes.has(hashOf(a)))

if (!newAnns.length) {
  console.log('No new announcements detected — nothing to send.')
  process.exit(0)
}

console.log(`Found ${newAnns.length} new announcement(s).`)

// ── Send each new announcement to the API ────────────────────────────────

;(async () => {
  for (const ann of newAnns) {
    const content_hash = hashOf(ann)
    console.log(`Sending: "${ann.title}" (hash: ${content_hash})`)

    const res = await fetch(`${API}/webhook/announce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': secret },
      body: JSON.stringify({ title: ann.title, body: ann.body, content_hash }),
    })

    const data = await res.json().catch(() => ({}))
    if (res.ok) {
      if (data.skipped) console.log(`  → Already sent (skipped).`)
      else console.log(`  → Queued for ${data.id}`)
    } else {
      console.error(`  → Error: ${data.error || res.status}`)
      process.exit(1)
    }
  }
})()
