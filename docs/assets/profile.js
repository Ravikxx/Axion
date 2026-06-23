/* Signed-in profile menu. Include on any page with a top <nav>.
 * Shows an avatar in the top-right when localStorage.axion_token exists;
 * clicking it opens a dropdown (API Keys, Playground, Settings, Admin, Log out).
 */
(function () {
  'use strict'
  var API = 'https://api.amplifiedsmp.org'

  var token = localStorage.getItem('axion_token')
  var email = localStorage.getItem('axion_email') || ''
  if (!token) return // not signed in — leave the default nav (Get started / Sign in)

  var nav = document.querySelector('nav')
  if (!nav) return

  function el(tag, cls, html) {
    var e = document.createElement(tag)
    if (cls) e.className = cls
    if (html != null) e.innerHTML = html
    return e
  }

  // ── Build avatar + menu ──────────────────────────────────────────────
  var wrap = el('div', 'ax-profile')
  var initial = (email.trim()[0] || 'A').toUpperCase()
  var avatar = el('button', 'ax-avatar', initial)
  avatar.setAttribute('aria-label', 'Account menu')
  wrap.appendChild(avatar)

  var menu = el('div', 'ax-menu')
  menu.innerHTML =
    '<div class="ax-menu-head"><div class="ax-hi">Signed in as</div><div class="ax-email"></div></div>' +
    '<a class="ax-menu-item" href="/chat"><span class="ax-ico">💬</span> Chat</a>' +
    '<a class="ax-menu-item" href="/keys"><span class="ax-ico">🔑</span> API Keys</a>' +
    '<a class="ax-menu-item" href="/playground"><span class="ax-ico">▶</span> Playground</a>' +
    '<button class="ax-menu-item" data-act="settings"><span class="ax-ico">⚙</span> Settings</button>' +
    '<div class="ax-admin-slot"></div>' +
    '<div class="ax-menu-sep"></div>' +
    '<button class="ax-menu-item danger" data-act="logout"><span class="ax-ico">⏻</span> Log out</button>'
  menu.querySelector('.ax-email').textContent = email || 'your account'
  wrap.appendChild(menu)

  // Place in nav-right if present, else push to the right of the nav.
  var navRight = nav.querySelector('.nav-right')
  if (navRight) {
    var getStarted = navRight.querySelector('.nav-btn')
    if (getStarted) getStarted.style.display = 'none' // already signed in
    navRight.appendChild(wrap)
  } else {
    wrap.style.marginLeft = 'auto'
    nav.appendChild(wrap)
  }

  // ── Toggle menu ──────────────────────────────────────────────────────
  function closeMenu() { menu.classList.remove('open') }
  avatar.addEventListener('click', function (e) {
    e.stopPropagation()
    menu.classList.toggle('open')
  })
  document.addEventListener('click', function (e) {
    if (!wrap.contains(e.target)) closeMenu()
  })
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu() })

  // ── Admin link (only if the user is an admin) ────────────────────────
  fetch(API + '/admin/check', { headers: { Authorization: 'Bearer ' + token } })
    .then(function (r) { return r.json() })
    .then(function (d) {
      if (d && d.admin) {
        var a = el('a', 'ax-menu-item', '<span class="ax-ico">🛡</span> Admin')
        a.href = '/admin'
        menu.querySelector('.ax-admin-slot').appendChild(a)
      }
    })
    .catch(function () {})

  // ── Actions ──────────────────────────────────────────────────────────
  menu.addEventListener('click', function (e) {
    var item = e.target.closest('[data-act]')
    if (!item) return
    var act = item.dataset.act
    if (act === 'logout') {
      localStorage.removeItem('axion_token')
      localStorage.removeItem('axion_email')
      location.href = '/'
    } else if (act === 'settings') {
      closeMenu()
      openSettings()
    }
  })

  // ── Settings modal (email preferences via /dashboard/prefs) ──────────
  var overlay
  function openSettings() {
    if (!overlay) {
      overlay = el('div', 'ax-modal-overlay')
      overlay.innerHTML =
        '<div class="ax-modal">' +
          '<h3>Settings</h3>' +
          '<p class="ax-sub"></p>' +
          '<div class="ax-field"><label>Usage alerts<span class="ax-field-sub">Email me when an API key hits 80% of its monthly limit.</span></label>' +
            '<input type="checkbox" class="ax-toggle" data-pref="notify_limit"></div>' +
          '<div class="ax-field"><label>Announcements<span class="ax-field-sub">Email me about new releases and updates.</span></label>' +
            '<input type="checkbox" class="ax-toggle" data-pref="notify_announcements"></div>' +
          '<div class="ax-modal-actions">' +
            '<span class="ax-modal-msg" style="display:none">Saved</span>' +
            '<button class="ax-btn ghost" data-x="close">Close</button>' +
            '<button class="ax-btn primary" data-x="save">Save</button>' +
          '</div>' +
        '</div>'
      document.body.appendChild(overlay)
      overlay.querySelector('.ax-sub').textContent = email
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay || e.target.dataset.x === 'close') overlay.classList.remove('open')
        if (e.target.dataset.x === 'save') savePrefs()
      })
    }
    // Load current prefs
    fetch(API + '/dashboard/prefs', { headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) { return r.json() })
      .then(function (p) {
        overlay.querySelector('[data-pref="notify_limit"]').checked = p.notify_limit !== 0
        overlay.querySelector('[data-pref="notify_announcements"]').checked = p.notify_announcements !== 0
      })
      .catch(function () {})
    overlay.classList.add('open')
  }

  function savePrefs() {
    var body = {
      notify_limit: overlay.querySelector('[data-pref="notify_limit"]').checked,
      notify_announcements: overlay.querySelector('[data-pref="notify_announcements"]').checked,
    }
    var msg = overlay.querySelector('.ax-modal-msg')
    fetch(API + '/dashboard/prefs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    }).then(function (r) {
      msg.textContent = r.ok ? 'Saved' : 'Failed to save'
      msg.style.color = r.ok ? '#34d399' : '#f87171'
      msg.style.display = 'inline'
      setTimeout(function () { msg.style.display = 'none' }, 2000)
    }).catch(function () {
      msg.textContent = 'Failed to save'; msg.style.color = '#f87171'; msg.style.display = 'inline'
    })
  }
})()
