/* Shared UI enhancements. No dependencies.
 *
 * Terminal: define window.AXION_TERMINAL = { mount: '#sel', label: 'axion', symbol: '$', lines: [...] }
 *   line types: {cmd:'…'} {out:'…', cls:'green|dim|''} {blank:true} {cursor:true}
 * Copy buttons: auto-added to every .code-block (opt out with data-nocopy).
 * Count-up: any element with [data-count] animates to its numeric text on scroll.
 * Typed code: any .code-block[data-type] types itself out when scrolled into view.
 */
(function () {
  'use strict'

  var NBSP = String.fromCharCode(160)

  // ── Animated terminal ──────────────────────────────────────────────────
  function runTerminal(cfg) {
    var mount = document.querySelector(cfg.mount)
    if (!mount) return

    var win = document.createElement('div')
    win.className = 'ax-terminal'
    win.innerHTML =
      '<div class="ax-term-bar">' +
        '<span class="ax-dot r"></span><span class="ax-dot y"></span><span class="ax-dot g"></span>' +
        '<span class="ax-term-label"></span>' +
      '</div>' +
      '<div class="ax-term-body"></div>'
    win.querySelector('.ax-term-label').textContent = cfg.label || 'axion'
    mount.appendChild(win)
    var body = win.querySelector('.ax-term-body')
    var sym = cfg.symbol || '$'

    var i = 0
    function next() {
      if (i >= cfg.lines.length) return
      var line = cfg.lines[i++]
      var el = document.createElement('div')
      el.className = 'ax-line'
      if (line.blank) {
        el.innerHTML = '&nbsp;'
      } else if (line.cursor) {
        el.innerHTML = '<span class="ax-prompt">' + sym + ' </span><span class="ax-cursor"></span>'
      } else if (line.cmd != null) {
        var p = document.createElement('span'); p.className = 'ax-prompt'; p.textContent = sym + ' '
        var c = document.createElement('span'); c.className = 'ax-cmd'; c.textContent = line.cmd
        el.appendChild(p); el.appendChild(c)
      } else {
        var s = document.createElement('span')
        s.className = line.cls ? 'ax-' + line.cls : 'ax-out'
        s.textContent = line.out
        el.appendChild(s)
      }
      body.appendChild(el)
      var delay = line.cmd != null ? 850 : line.blank ? 180 : 340
      setTimeout(next, delay)
    }
    setTimeout(next, 500)
  }

  // ── Copy buttons ───────────────────────────────────────────────────────
  function addCopyButtons() {
    var blocks = document.querySelectorAll('.code-block')
    Array.prototype.forEach.call(blocks, function (block) {
      if (block.dataset.nocopy != null || block.closest('.ax-code-wrap')) return
      var wrap = document.createElement('div')
      wrap.className = 'ax-code-wrap'
      block.parentNode.insertBefore(wrap, block)
      wrap.appendChild(block)

      var btn = document.createElement('button')
      btn.className = 'ax-copy-btn'
      btn.textContent = 'Copy'
      btn.addEventListener('click', function () {
        var text = block.innerText
          .split(NBSP).join(' ')
          .split('\n')
          .map(function (l) { return l.replace(/^\s*[$›>]\s/, '') }) // strip shell prompt prefixes
          .join('\n')
          .trim()
        copy(text)
        btn.textContent = 'Copied'
        btn.classList.add('copied')
        setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('copied') }, 1600)
      })
      wrap.appendChild(btn)
    })
  }

  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text) })
    } else {
      fallbackCopy(text)
    }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea')
    ta.value = text; document.body.appendChild(ta); ta.select()
    try { document.execCommand('copy') } catch (e) {}
    document.body.removeChild(ta)
  }

  // ── Count-up on scroll ─────────────────────────────────────────────────
  function animateCount(el) {
    var raw = el.textContent.trim()
    var m = raw.match(/([\d,]+)/)
    if (!m) return
    var target = parseInt(m[1].split(',').join(''), 10)
    if (!target || target > 100000000) return
    var prefix = raw.slice(0, m.index)
    var suffix = raw.slice(m.index + m[1].length)
    var dur = 1100
    var start = performance.now()
    function tick(now) {
      var p = Math.min((now - start) / dur, 1)
      var eased = 1 - Math.pow(1 - p, 3)
      var val = Math.round(target * eased)
      el.textContent = prefix + val.toLocaleString() + suffix
      if (p < 1) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  // ── Typed code on scroll (plain-text blocks only) ───────────────────────
  function typeCode(el) {
    var full = el.textContent
    el.textContent = ''
    var i = 0
    var step = Math.max(1, Math.round(full.length / 120))
    function tick() {
      if (i > full.length) return
      el.textContent = full.slice(0, i)
      i += step
      if (i <= full.length) requestAnimationFrame(function () { setTimeout(tick, 12) })
    }
    tick()
  }

  function observeOnce(selector, fn) {
    var els = document.querySelectorAll(selector)
    if (!els.length) return
    if (!('IntersectionObserver' in window)) { Array.prototype.forEach.call(els, fn); return }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { fn(e.target); io.unobserve(e.target) }
      })
    }, { threshold: 0.5 })
    Array.prototype.forEach.call(els, function (el) { io.observe(el) })
  }

  // ── Init ───────────────────────────────────────────────────────────────
  function init() {
    if (window.AXION_TERMINAL) runTerminal(window.AXION_TERMINAL)
    addCopyButtons()
    observeOnce('[data-count]', animateCount)
    observeOnce('.code-block[data-type]', typeCode)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
