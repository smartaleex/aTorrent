'use strict'

const $ = (id) => document.getElementById(id)
const POLL_MS = 1000

/* --------------------------------------------------------------- helpers --- */

function bytes (n) {
  if (!n && n !== 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`
}

function speed (n) {
  return n > 0 ? `${bytes(n)}/s` : '—'
}

function eta (ms) {
  if (!ms || !isFinite(ms) || ms <= 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`
}

async function api (path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  })
  const body = res.status === 204 ? {} : await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`)
  return body
}

function showError (el, message) {
  el.textContent = message
  el.hidden = !message
}

/* ------------------------------------------------------------------ auth --- */

async function boot () {
  const session = await api('/api/session')
  if (session.authRequired && !session.authed) {
    $('login').hidden = false
    return
  }
  $('login').hidden = true
  $('app').hidden = false
  poll()
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  showError($('login-error'), '')
  try {
    await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ password: $('password').value })
    })
    $('password').value = ''
    boot()
  } catch (err) {
    showError($('login-error'), err.message)
  }
})

/* ------------------------------------------------------------ add magnet --- */

$('add-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const input = $('magnet')
  const magnet = input.value.trim()
  if (!magnet) return
  showError($('add-error'), '')
  $('add').disabled = true
  try {
    await api('/api/torrents', { method: 'POST', body: JSON.stringify({ magnet }) })
    input.value = ''
    input.blur()
    await refresh()
  } catch (err) {
    showError($('add-error'), err.message)
  } finally {
    $('add').disabled = false
  }
})

$('paste').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText()
    if (text) $('magnet').value = text.trim()
  } catch {
    // Safari denies clipboard reads without a user gesture it likes; typing works.
    showError($('add-error'), 'Could not read the clipboard — paste into the box instead.')
  }
})

// Lets you share a magnet into the app: atorrent.local/?magnet=...
const shared = new URLSearchParams(location.search).get('magnet')
if (shared) {
  $('magnet').value = shared
  history.replaceState(null, '', location.pathname)
}

/* ----------------------------------------------------------------- render --- */

let lastSignature = ''

function render (data) {
  const list = $('list')
  const torrents = data.torrents

  $('empty').hidden = torrents.length > 0
  $('totals').textContent = torrents.length
    ? `↓ ${speed(data.totals.downloadSpeed)}  ↑ ${speed(data.totals.uploadSpeed)}`
    : '—'

  // Rebuild only when the shape changes; otherwise patch the live numbers so
  // taps and scroll position survive the 1s poll.
  const signature = torrents.map((t) => `${t.infoHash}:${t.files.length}:${t.ready}`).join('|')
  if (signature !== lastSignature) {
    lastSignature = signature
    list.innerHTML = ''
    for (const torrent of torrents) list.appendChild(card(torrent))
  }
  for (const torrent of torrents) patch(torrent)
}

function card (torrent) {
  const el = document.createElement('section')
  el.className = 'card'
  el.dataset.hash = torrent.infoHash

  const name = document.createElement('p')
  name.className = 'torrent-name'
  name.dataset.role = 'name'
  el.appendChild(name)

  const bar = document.createElement('div')
  bar.className = 'bar'
  bar.dataset.role = 'bar'
  bar.appendChild(document.createElement('div'))
  el.appendChild(bar)

  const stats = document.createElement('div')
  stats.className = 'stats'
  stats.dataset.role = 'stats'
  el.appendChild(stats)

  if (torrent.files.length) {
    const files = document.createElement('div')
    files.className = 'files'
    for (const file of torrent.files) {
      const row = document.createElement('div')
      row.className = 'file'

      const label = document.createElement('div')
      label.className = 'file-name'
      label.textContent = file.name
      const size = document.createElement('div')
      size.className = 'file-size'
      size.textContent = bytes(file.length)
      label.appendChild(size)
      row.appendChild(label)

      const save = document.createElement('a')
      save.className = 'btn small'
      save.textContent = '⤓ Save'
      save.href = `/api/torrents/${torrent.infoHash}/files/${file.index}`
      save.dataset.role = 'save'
      save.dataset.index = String(file.index)
      row.appendChild(save)

      files.appendChild(row)
    }
    el.appendChild(files)
  }

  const actions = document.createElement('div')
  actions.className = 'actions'

  const pause = document.createElement('button')
  pause.className = 'btn small'
  pause.dataset.role = 'pause'
  pause.addEventListener('click', async () => {
    pause.disabled = true
    try {
      await api(`/api/torrents/${torrent.infoHash}/pause`, {
        method: 'POST',
        body: JSON.stringify({ paused: pause.dataset.paused !== 'true' })
      })
      await refresh()
    } finally {
      pause.disabled = false
    }
  })
  actions.appendChild(pause)

  const remove = document.createElement('button')
  remove.className = 'btn small danger'
  remove.textContent = 'Remove'
  remove.addEventListener('click', async () => {
    const keep = confirm('Remove this torrent.\n\nOK: keep the downloaded files on the server.\nCancel: delete them too.')
    remove.disabled = true
    try {
      await api(`/api/torrents/${torrent.infoHash}?files=${keep ? 'keep' : 'delete'}`, { method: 'DELETE' })
      await refresh()
    } finally {
      remove.disabled = false
    }
  })
  actions.appendChild(remove)

  el.appendChild(actions)
  return el
}

function patch (torrent) {
  const el = document.querySelector(`[data-hash="${torrent.infoHash}"]`)
  if (!el) return
  const pct = Math.round(torrent.progress * 100)

  el.querySelector('[data-role=name]').textContent = torrent.name

  const bar = el.querySelector('[data-role=bar]')
  bar.classList.toggle('done', torrent.done)
  bar.firstChild.style.width = `${pct}%`

  const status = torrent.done ? 'Done' : torrent.paused ? 'Paused' : `${pct}%`
  el.querySelector('[data-role=stats]').textContent = [
    status,
    `${bytes(torrent.downloaded)} of ${bytes(torrent.length)}`,
    `↓ ${speed(torrent.downloadSpeed)}`,
    `${torrent.peers} peers`,
    torrent.done || torrent.paused ? '' : `ETA ${eta(torrent.timeRemaining)}`
  ].filter(Boolean).join(' · ')

  const pause = el.querySelector('[data-role=pause]')
  pause.textContent = torrent.paused ? 'Resume' : 'Pause'
  pause.dataset.paused = String(torrent.paused)
  pause.hidden = torrent.done

  // A file is only worth saving once its bytes are all here.
  for (const link of el.querySelectorAll('[data-role=save]')) {
    const file = torrent.files[Number(link.dataset.index)]
    const ready = file && file.progress === 1
    link.classList.toggle('ghost', !ready)
    link.style.pointerEvents = ready ? '' : 'none'
    link.style.opacity = ready ? '' : '0.45'
    link.textContent = ready ? '⤓ Save' : `${Math.round((file?.progress || 0) * 100)}%`
  }
}

/* ------------------------------------------------------------------ poll --- */

async function refresh () {
  const data = await api('/api/torrents')
  render(data)
}

let timer = null
async function poll () {
  clearTimeout(timer)
  try {
    await refresh()
  } catch (err) {
    if (/401/.test(err.message) || /Unauthorized/i.test(err.message)) return boot()
  }
  timer = setTimeout(poll, POLL_MS)
}

// Stop hammering the server while the tab is in the background on iOS.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(timer)
  else if (!$('app').hidden) poll()
})

boot().catch((err) => showError($('add-error'), err.message))
