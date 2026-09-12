import express from 'express'
import WebTorrent from 'webtorrent'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.PORT || 8080)
const DOWNLOAD_DIR = path.resolve(process.env.ATORRENT_DOWNLOAD_DIR || path.join(__dirname, 'downloads'))
const STATE_FILE = path.join(__dirname, 'data', 'torrents.json')
const PASSWORD = process.env.ATORRENT_PASSWORD || ''
const MAX_TORRENTS = Number(process.env.ATORRENT_MAX_TORRENTS || 25)

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true })
fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })

const client = new WebTorrent()
client.on('error', (err) => console.error('[webtorrent]', err.message))

/* ---------------------------------------------------------------- state --- */

// Magnets we have been asked to keep, so a server restart resumes them.
function loadState () {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return []
  }
}

function saveState () {
  const entries = client.torrents.map((t) => ({
    infoHash: t.infoHash,
    magnetURI: t.magnetURI,
    addedAt: t.atAddedAt || Date.now()
  }))
  fs.writeFileSync(STATE_FILE, JSON.stringify(entries, null, 2))
}

/* --------------------------------------------------------------- helpers --- */

const MAGNET_RE = /^magnet:\?xt=urn:btih:([a-zA-Z0-9]{32,40})/

// client.get() is async in WebTorrent 3, so look torrents up synchronously.
function findTorrent (infoHash) {
  const wanted = String(infoHash || '').toLowerCase()
  return client.torrents.find((t) => t.infoHash === wanted) || null
}

function addTorrent (magnetURI) {
  return new Promise((resolve, reject) => {
    let torrent
    try {
      torrent = client.add(magnetURI, { path: DOWNLOAD_DIR })
    } catch (err) {
      return reject(err)
    }
    torrent.atAddedAt = Date.now()
    torrent.atPaused = false
    const onError = (err) => reject(err)
    torrent.once('error', onError)

    // `add` resolves once the torrent has an infoHash; metadata arrives later.
    const ready = () => {
      torrent.removeListener('error', onError)
      torrent.on('error', (err) => console.error('[torrent]', torrent.infoHash, err.message))
      torrent.on('done', () => console.log('[done]', torrent.name))
      saveState()
      resolve(torrent)
    }
    if (torrent.infoHash) ready()
    else torrent.once('infoHash', ready)
  })
}

function describe (torrent) {
  const done = torrent.progress === 1
  return {
    infoHash: torrent.infoHash,
    name: torrent.name || 'Fetching metadata…',
    magnetURI: torrent.magnetURI,
    ready: Boolean(torrent.name && torrent.files.length),
    paused: Boolean(torrent.atPaused),
    done,
    progress: torrent.progress,
    length: torrent.length,
    downloaded: torrent.downloaded,
    downloadSpeed: torrent.atPaused ? 0 : torrent.downloadSpeed,
    uploadSpeed: torrent.atPaused ? 0 : torrent.uploadSpeed,
    peers: torrent.numPeers,
    timeRemaining: done ? 0 : torrent.timeRemaining,
    addedAt: torrent.atAddedAt || null,
    files: torrent.files.map((f, index) => ({
      index,
      name: f.name,
      path: f.path,
      length: f.length,
      progress: f.progress
    }))
  }
}

function getTorrent (req, res) {
  const torrent = findTorrent(req.params.infoHash)
  if (!torrent) {
    res.status(404).json({ error: 'No such torrent' })
    return null
  }
  return torrent
}

/* ------------------------------------------------------------------ app --- */

const app = express()
app.set('trust proxy', true)
app.use(express.json({ limit: '64kb' }))

const AUTH_TOKEN = PASSWORD ? crypto.createHash('sha256').update(PASSWORD).digest('hex') : ''

function authed (req) {
  if (!PASSWORD) return true
  const cookie = req.headers.cookie || ''
  const match = cookie.match(/(?:^|;\s*)atorrent_auth=([a-f0-9]{64})/)
  if (!match) return false
  return crypto.timingSafeEqual(Buffer.from(match[1]), Buffer.from(AUTH_TOKEN))
}

app.post('/api/login', (req, res) => {
  const supplied = String(req.body?.password ?? '')
  const ok = PASSWORD && crypto.timingSafeEqual(
    crypto.createHash('sha256').update(supplied).digest(),
    crypto.createHash('sha256').update(PASSWORD).digest()
  )
  if (!ok) return res.status(401).json({ error: 'Wrong password' })
  const secure = req.secure ? '; Secure' : ''
  res.setHeader('Set-Cookie',
    `atorrent_auth=${AUTH_TOKEN}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`)
  res.json({ ok: true })
})

app.get('/api/session', (req, res) => {
  res.json({ authRequired: Boolean(PASSWORD), authed: authed(req) })
})

app.use('/api', (req, res, next) => {
  if (authed(req)) return next()
  res.status(401).json({ error: 'Unauthorized' })
})

app.get('/api/torrents', (req, res) => {
  res.json({
    torrents: client.torrents.map(describe),
    totals: {
      downloadSpeed: client.downloadSpeed,
      uploadSpeed: client.uploadSpeed
    }
  })
})

app.post('/api/torrents', async (req, res) => {
  const magnetURI = String(req.body?.magnet ?? '').trim()
  if (!MAGNET_RE.test(magnetURI)) {
    return res.status(400).json({ error: 'That does not look like a magnet link.' })
  }
  if (client.torrents.length >= MAX_TORRENTS) {
    return res.status(429).json({ error: `Limit of ${MAX_TORRENTS} torrents reached. Remove one first.` })
  }
  const infoHash = magnetURI.match(MAGNET_RE)[1].toLowerCase()
  if (findTorrent(infoHash)) {
    return res.status(409).json({ error: 'That torrent is already in the list.' })
  }
  try {
    const torrent = await addTorrent(magnetURI)
    res.status(201).json(describe(torrent))
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.post('/api/torrents/:infoHash/pause', (req, res) => {
  const torrent = getTorrent(req, res)
  if (!torrent) return
  const pause = req.body?.paused !== false
  torrent.atPaused = pause
  if (pause) torrent.pause()
  else torrent.resume()
  res.json(describe(torrent))
})

app.delete('/api/torrents/:infoHash', (req, res) => {
  const torrent = getTorrent(req, res)
  if (!torrent) return
  // ?files=keep leaves whatever has been written to disk in place.
  const destroyStore = req.query.files !== 'keep'
  torrent.destroy({ destroyStore }, (err) => {
    if (err) return res.status(500).json({ error: err.message })
    saveState()
    res.json({ ok: true })
  })
})

// Streams one file out of a torrent. Supports Range so iOS can resume a
// download and so Safari can scrub a video without fetching the whole thing.
app.get('/api/torrents/:infoHash/files/:index', (req, res) => {
  const torrent = getTorrent(req, res)
  if (!torrent) return
  const file = torrent.files[Number(req.params.index)]
  if (!file) return res.status(404).json({ error: 'No such file' })

  const total = file.length
  const range = req.headers.range
  let start = 0
  let end = total - 1
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!m) return res.status(416).set('Content-Range', `bytes */${total}`).end()
    if (m[1]) start = Number(m[1])
    if (m[2]) end = Number(m[2])
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= total) {
      return res.status(416).set('Content-Range', `bytes */${total}`).end()
    }
    res.status(206).set('Content-Range', `bytes ${start}-${end}/${total}`)
  }

  const filename = path.basename(file.name)
  const disposition = req.query.inline === '1' ? 'inline' : 'attachment'
  res.set({
    'Accept-Ranges': 'bytes',
    'Content-Length': String(end - start + 1),
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`
  })

  const stream = file.createReadStream({ start, end })
  stream.on('error', (err) => {
    console.error('[stream]', err.message)
    res.destroy()
  })
  req.on('close', () => stream.destroy())
  stream.pipe(res)
})

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }))

/* ---------------------------------------------------------------- start --- */

for (const entry of loadState()) {
  addTorrent(entry.magnetURI)
    .then((t) => { t.atAddedAt = entry.addedAt || Date.now() })
    .catch((err) => console.error('[resume]', err.message))
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`aTorrent listening on http://0.0.0.0:${PORT}`)
  console.log(`Saving downloads to ${DOWNLOAD_DIR}`)
  if (!PASSWORD) console.log('No ATORRENT_PASSWORD set — anyone who can reach this port can use it.')
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n${signal} — shutting down`)
    saveState()
    server.close()
    client.destroy(() => process.exit(0))
  })
}
