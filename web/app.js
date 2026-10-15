/* aTorrent — everything happens in this tab. A WebTorrent client joins the
   swarm over WebRTC, and a service worker turns each file into a real URL the
   browser can stream or download without buffering it all in memory first. */

import WebTorrent from './vendor/webtorrent.min.js'

const $ = (id) => document.getElementById(id)

// Browsers can only reach peers through WebSocket trackers, so every torrent
// gets these in addition to whatever the magnet link carries.
const DEFAULT_TRACKERS = [
  'wss://tracker.webtorrent.dev',
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.files.fm:7073/announce'
]

// ?tracker=wss://… points the client at your own tracker instead (repeatable).
const extraTrackers = new URLSearchParams(location.search).getAll('tracker')
const TRACKERS = extraTrackers.length ? extraTrackers : DEFAULT_TRACKERS

const STORE_KEY = 'atorrent.magnets'
// How long a torrent may sit at zero peers before we stop saying "looking"
// and explain what is actually going on. ?stalled=<seconds> overrides it.
const STALLED_AFTER = Number(new URLSearchParams(location.search).get('stalled') || 45) * 1000
const MAGNET_RE = /^magnet:\?xt=urn:btih:([a-zA-Z0-9]{32,40})/i

const client = new WebTorrent({ tracker: { announce: TRACKERS } })
let streamingReady = false

/* --------------------------------------------------------------- helpers --- */

function bytes (n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`
}

const speed = (n) => (n > 0 ? `${bytes(n)}/s` : '—')

function eta (ms) {
  if (!ms || !isFinite(ms) || ms <= 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`
}

function showError (el, message) {
  el.textContent = message
  el.hidden = !message
}

function kindOf (name) {
  const ext = name.split('.').pop().toLowerCase()
  if (['mp4', 'm4v', 'mov', 'webm'].includes(ext)) return 'video'
  if (['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg'].includes(ext)) return 'audio'
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'].includes(ext)) return 'image'
  return 'file'
}

/* ------------------------------------------------------------- persistence --- */

// Entries are { uri, paused }. Older versions stored bare magnet strings, so
// anything that is still a string gets read as a running torrent.
const remembered = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY)) || []
    return raw.map((entry) => (typeof entry === 'string' ? { uri: entry, paused: false } : entry))
  } catch {
    return []
  }
}

const save = (entries) => localStorage.setItem(STORE_KEY, JSON.stringify(entries))

function remember (magnetURI, paused = false) {
  const all = remembered()
  if (!all.some((entry) => entry.uri === magnetURI)) save([...all, { uri: magnetURI, paused }])
}

function rememberPaused (infoHash, paused) {
  save(remembered().map((entry) => (
    entry.uri.toLowerCase().includes(infoHash.toLowerCase()) ? { ...entry, paused } : entry
  )))
}

function forget (infoHash) {
  save(remembered().filter((entry) => !entry.uri.toLowerCase().includes(infoHash.toLowerCase())))
}

/* ------------------------------------------------------------- the engine --- */

// The service worker lets a download stream straight to disk. Without it we
// have to materialise the whole file as a Blob in memory, which a phone will
// not tolerate for anything large.
async function startStreaming () {
  if (!('serviceWorker' in navigator)) return 'no-sw'
  if (!window.isSecureContext) return 'insecure'
  try {
    const registration = await navigator.serviceWorker.register('sw.min.js', { scope: './' })
    await navigator.serviceWorker.ready
    // A worker only intercepts requests from pages it controls, and it does not
    // control this one until it has claimed it.
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })
        setTimeout(resolve, 3000)
      })
    }
    if (!navigator.serviceWorker.controller) return 'failed'
    client.createServer({ controller: registration })
    streamingReady = true
    return 'ok'
  } catch (err) {
    console.warn('service worker unavailable:', err)
    return 'failed'
  }
}

function addMagnet (magnetURI, { paused = false } = {}) {
  const uri = magnetURI.trim()
  if (!MAGNET_RE.test(uri)) throw new Error('That does not look like a magnet link.')
  const infoHash = uri.match(MAGNET_RE)[1].toLowerCase()
  if (client.torrents.some((t) => t.infoHash === infoHash)) {
    throw new Error('That torrent is already in the list.')
  }
  const torrent = client.add(uri, { announce: TRACKERS, paused })
  torrent.atAddedAt = Date.now()
  torrent.atEverHadPeers = false
  torrent.on('error', (err) => console.error('[torrent]', err.message))
  remember(uri, paused)
  return torrent
}

// WebTorrent's own pause() only refuses *new* peers — the connections already
// open keep sending pieces — so stopping for real means dropping those wires
// too. Resuming asks the tracker for peers again rather than waiting out the
// next announce interval.
function setPaused (torrent, paused) {
  if (paused) {
    torrent.pause()
    for (const wire of [...torrent.wires]) wire.destroy()
  } else {
    torrent.resume()
    try { torrent.discovery?.tracker?.update?.() } catch { /* announce when it can */ }
  }
  rememberPaused(torrent.infoHash, paused)
  draw()
}

function setPausedAll (paused) {
  // Finished torrents included: they are seeding, and that is worth stopping.
  for (const torrent of client.torrents) setPaused(torrent, paused)
}

client.on('error', (err) => showError($('add-error'), err.message))

// Handy from the console, and what the browser test drives.
window.atorrent = { client, addMagnet, TRACKERS }

/* ------------------------------------------------------------------- UI --- */

$('add-form').addEventListener('submit', (event) => {
  event.preventDefault()
  showError($('add-error'), '')
  try {
    addMagnet($('magnet').value)
    $('magnet').value = ''
    $('magnet').blur()
    draw()
  } catch (err) {
    showError($('add-error'), err.message)
  }
})

$('pause-all').addEventListener('click', () => setPausedAll(true))
$('resume-all').addEventListener('click', () => setPausedAll(false))

$('paste').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText()
    if (text) $('magnet').value = text.trim()
  } catch {
    showError($('add-error'), 'Could not read the clipboard — long-press the box and paste instead.')
  }
})

$('seed-file').addEventListener('change', (event) => {
  const files = [...event.target.files]
  if (!files.length) return
  showError($('seed-error'), '')
  client.seed(files, { announce: TRACKERS }, (torrent) => {
    remember(torrent.magnetURI)
    draw()
  })
  event.target.value = ''
})

// Lets a magnet be shared into the app: .../?magnet=magnet:?xt=…
const shared = new URLSearchParams(location.search).get('magnet')
if (shared) {
  $('magnet').value = shared
  history.replaceState(null, '', location.pathname)
}

/* --------------------------------------------------------------- drawing --- */

let lastSignature = ''

function draw () {
  const torrents = client.torrents
  $('empty').hidden = torrents.length > 0
  // Only worth showing once there is more than one thing to act on.
  $('toolbar').hidden = torrents.length < 2
  $('totals').textContent = torrents.length
    ? `↓ ${speed(client.downloadSpeed)}  ↑ ${speed(client.uploadSpeed)}`
    : '—'

  // Rebuild only when the shape changes, so taps and scroll survive the tick.
  const signature = torrents.map((t) => `${t.infoHash}:${t.files.length}`).join('|')
  if (signature !== lastSignature) {
    lastSignature = signature
    $('list').innerHTML = ''
    for (const torrent of torrents) $('list').appendChild(card(torrent))
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

  const notice = document.createElement('div')
  notice.className = 'notice'
  notice.dataset.role = 'notice'
  notice.hidden = true
  el.appendChild(notice)

  const files = document.createElement('div')
  files.className = 'files'
  files.dataset.role = 'files'
  el.appendChild(files)

  const actions = document.createElement('div')
  actions.className = 'actions'

  const pause = document.createElement('button')
  pause.className = 'btn small'
  pause.dataset.role = 'pause'
  pause.addEventListener('click', () => setPaused(torrent, !torrent.paused))
  actions.appendChild(pause)

  const copy = document.createElement('button')
  copy.className = 'btn small'
  copy.textContent = '⧉ Magnet'
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(torrent.magnetURI)
      copy.textContent = 'Copied'
      setTimeout(() => { copy.textContent = '⧉ Magnet' }, 1500)
    } catch {
      prompt('Copy this magnet link:', torrent.magnetURI)
    }
  })
  actions.appendChild(copy)

  const remove = document.createElement('button')
  remove.className = 'btn small danger'
  remove.textContent = 'Remove'
  remove.addEventListener('click', () => {
    if (!confirm('Remove this torrent and delete what has downloaded?')) return
    forget(torrent.infoHash)
    torrent.destroy({ destroyStore: true }, draw)
  })
  actions.appendChild(remove)

  el.appendChild(actions)
  return el
}

function fileRow (torrent, file, index) {
  const row = document.createElement('div')
  row.className = 'file'
  row.dataset.file = String(index)

  const label = document.createElement('div')
  label.className = 'file-name'
  label.textContent = file.name
  const size = document.createElement('div')
  size.className = 'file-size'
  size.textContent = bytes(file.length)
  label.appendChild(size)
  row.appendChild(label)

  const kind = kindOf(file.name)
  if (kind !== 'file') {
    const play = document.createElement('button')
    play.className = 'btn small ghost'
    play.textContent = kind === 'image' ? 'View' : 'Play'
    play.dataset.role = 'play'
    play.addEventListener('click', () => preview(row, file, kind, play))
    row.appendChild(play)
  }

  const save = document.createElement('button')
  save.className = 'btn small'
  save.dataset.role = 'save'
  save.addEventListener('click', () => saveFile(file, save))
  row.appendChild(save)

  return row
}

// Plays straight from the swarm: the service worker feeds the media element
// the pieces it asks for, so playback can start before the download finishes.
function preview (row, file, kind, button) {
  const existing = row.parentElement.querySelector(`[data-preview="${row.dataset.file}"]`)
  if (existing) {
    existing.remove()
    button.textContent = kind === 'image' ? 'View' : 'Play'
    return
  }
  const wrap = document.createElement('div')
  wrap.className = 'preview'
  wrap.dataset.preview = row.dataset.file
  const el = document.createElement(kind === 'image' ? 'img' : kind)
  if (kind !== 'image') {
    el.controls = true
    el.autoplay = true
    el.playsInline = true
  }
  if (streamingReady) {
    el.src = file.streamURL
  } else {
    file.blob().then((blob) => { el.src = URL.createObjectURL(blob) })
  }
  wrap.appendChild(el)
  row.after(wrap)
  button.textContent = 'Close'
}

// Handing the file to the browser's downloader means materialising it as a
// Blob: Safari has no way to stream a download to disk, so the file passes
// through memory on its way to the Files app.
const BIG_FILE = 1024 * 1024 * 1024

async function saveFile (file, button) {
  if (file.length > BIG_FILE &&
      !confirm(`${file.name} is ${bytes(file.length)}. Saving it has to hold the whole file in memory, which may crash the tab on a phone. Try anyway?`)) {
    return
  }
  const original = button.textContent
  button.disabled = true
  button.textContent = 'Saving…'
  try {
    const blob = await file.blob()
    const href = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = href
    link.download = file.name
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(href), 60_000)
  } catch (err) {
    alert(`Could not save that file: ${err.message}`)
  } finally {
    button.disabled = false
    button.textContent = original
  }
}

function patch (torrent) {
  const el = document.querySelector(`[data-hash="${torrent.infoHash}"]`)
  if (!el) return
  const done = torrent.progress === 1
  const pct = Math.round(torrent.progress * 100)

  if (torrent.numPeers > 0) torrent.atEverHadPeers = true
  const stalled = !done &&
    !torrent.paused &&
    torrent.numPeers === 0 &&
    !torrent.atEverHadPeers &&
    Date.now() - (torrent.atAddedAt || 0) > STALLED_AFTER


  el.querySelector('[data-role=name]').textContent = torrent.name || 'Finding peers…'

  const bar = el.querySelector('[data-role=bar]')
  bar.classList.toggle('done', done)
  bar.classList.toggle('paused', torrent.paused && !done)
  bar.firstChild.style.width = `${pct}%`

  el.querySelector('[data-role=stats]').textContent = [
    torrent.paused ? (done ? 'Paused · seeding stopped' : `Paused · ${pct}%`)
      : torrent.ready ? (done ? 'Done' : `${pct}%`)
        : (stalled ? 'No reachable peers' : 'Looking for peers…'),
    torrent.length ? `${bytes(torrent.downloaded)} of ${bytes(torrent.length)}` : '',
    `↓ ${speed(torrent.downloadSpeed)}`,
    `${torrent.numPeers} peers`,
    done || torrent.paused || !torrent.ready ? '' : `ETA ${eta(torrent.timeRemaining)}`
  ].filter(Boolean).join(' · ')

  const notice = el.querySelector('[data-role=notice]')
  notice.hidden = !stalled
  if (stalled && !notice.childElementCount) {
    notice.innerHTML = '<strong>No WebRTC peers for this torrent.</strong> ' +
      'A seed count on a torrent site counts classic TCP peers, which no browser ' +
      'tab can connect to — only peers that also speak WebRTC are reachable from ' +
      'here, and most public torrents have none. Nothing is wrong with the link. ' +
      'To download this one you need <em>server mode</em>: run aTorrent\'s Node ' +
      'server on a computer at home and open it from this phone.'
  }

  const pause = el.querySelector('[data-role=pause]')
  // Still offered on a finished torrent: it is seeding to other people, and
  // pausing is how you stop that.
  pause.textContent = torrent.paused ? '▶ Resume' : '❚❚ Pause'

  const files = el.querySelector('[data-role=files]')
  if (files.childElementCount === 0 && torrent.files.length) {
    torrent.files.forEach((file, index) => files.appendChild(fileRow(torrent, file, index)))
  }

  for (const row of files.querySelectorAll('.file')) {
    const file = torrent.files[Number(row.dataset.file)]
    if (!file) continue
    // A finished torrent means every file is finished, and torrent.done settles
    // a moment before the per-file counters catch up.
    const ready = done || file.progress === 1
    const save = row.querySelector('[data-role=save]')
    if (save.disabled) continue // mid-save; leave the label alone
    save.textContent = ready ? '⤓ Save' : `${Math.round(file.progress * 100)}%`
    save.classList.toggle('ghost', !ready)
    save.style.opacity = ready ? '' : '0.45'
    save.style.pointerEvents = ready ? '' : 'none'
  }
}

/* ----------------------------------------------------------------- start --- */

startStreaming().then((mode) => {
  const notes = {
    ok: 'Ready. Video and audio play while they download.',
    'no-sw': 'No service worker here, so files have to finish before you can play them.',
    insecure: 'Served over plain http, so playback-while-downloading is off. Host this over https to turn it on.',
    failed: 'The streaming worker did not start, so files have to finish before you can play them.'
  }
  const store = window.FileSystemFileHandle?.prototype?.createWritable
    ? 'Downloads are written to this device’s storage as they arrive.'
    : 'This browser holds downloads in memory, so keep them well under a gigabyte.'
  $('engine-status').textContent = `${notes[mode]} ${store}`
})

for (const entry of remembered()) {
  try { addMagnet(entry.uri, { paused: entry.paused }) } catch (err) {
    console.warn('could not restore', err.message)
  }
}

setInterval(draw, 1000)
draw()
