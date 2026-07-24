import assert from 'node:assert/strict'
import test from 'node:test'

import app, { moderationEmailRow } from '../src/index.js'

test('API responses include baseline browser security headers', async () => {
  const response = await app.request('/v1/models')

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('x-frame-options'), 'DENY')
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin')
  assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()')
})

test('moderation email rows escape prompt-influenced content and identity fields', () => {
  const html = moderationEmailRow({
    id: '7<script>',
    authType: 'session<img>',
    userId: 'user&admin',
    ip: '<b>127.0.0.1</b>',
    notes: '<img src=x onerror=alert(1)>',
  }, '#e8602c')

  assert.doesNotMatch(html, /<script>|<img|<b>/)
  assert.match(html, /7&lt;script&gt;/)
  assert.match(html, /session&lt;img&gt;/)
  assert.match(html, /user&amp;admin/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
})
