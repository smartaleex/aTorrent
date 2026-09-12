// End-to-end check: local tracker + seeder, add the magnet through the HTTP API,
// wait for the download, then verify the bytes the API streams back.
import { Server as TrackerServer } from 'bittorrent-tracker'
import WebTorrent from 'webtorrent'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const PORT = 8123
const TRACKER_PORT = 8124
const BASE = `http://127.0.0.1:${PORT}`
const PASSWORD = 'test-password'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atorrent-e2e-'))
const payload = crypto.randomBytes(512 * 1024)
const seedFile = path.join(tmp, 'payload.bin')
fs.writeFileSync(seedFile, payload)

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const tracker = new TrackerServer({ udp: false, ws: false, stats: false })
await new Promise((resolve) => tracker.listen(TRACKER_PORT, '127.0.0.1', resolve))
const announce = [`http://127.0.0.1:${TRACKER_PORT}/announce`]

const seeder = new WebTorrent()
const magnet = await new Promise((resolve) => {
  seeder.seed(seedFile, { announce }, (torrent) => resolve(torrent.magnetURI))
})

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    ATORRENT_PASSWORD: PASSWORD,
    ATORRENT_DOWNLOAD_DIR: path.join(tmp, 'downloads')
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))

async function waitForServer () {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/api/session`); return } catch { await sleep(200) }
  }
  throw new Error('server never came up')
}

let cookie = ''
const call = (p, init = {}) => fetch(BASE + p, {
  ...init,
  headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...init.headers }
})

try {
  await waitForServer()

  check('unauthenticated list is rejected', (await call('/api/torrents')).status === 401)
  check('wrong password is rejected',
    (await call('/api/login', { method: 'POST', body: JSON.stringify({ password: 'nope' }) })).status === 401)

  const login = await call('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }) })
  cookie = (login.headers.get('set-cookie') || '').split(';')[0]
  check('login sets an auth cookie', login.ok && cookie.startsWith('atorrent_auth='))

  check('non-magnet input is rejected',
    (await call('/api/torrents', { method: 'POST', body: JSON.stringify({ magnet: 'https://example.com' }) })).status === 400)

  const added = await call('/api/torrents', { method: 'POST', body: JSON.stringify({ magnet }) })
  const torrent = await added.json()
  check('magnet is accepted', added.status === 201 && /^[a-f0-9]{40}$/.test(torrent.infoHash || ''))

  check('duplicate magnet is refused',
    (await call('/api/torrents', { method: 'POST', body: JSON.stringify({ magnet }) })).status === 409)

  let state
  for (let i = 0; i < 120; i++) {
    state = (await (await call('/api/torrents')).json()).torrents[0]
    if (state?.done) break
    await sleep(500)
  }
  check('torrent downloads to completion', Boolean(state?.done),
    `progress ${Math.round((state?.progress || 0) * 100)}%, ${state?.peers || 0} peers`)
  check('file list is reported', state?.files?.[0]?.name === 'payload.bin')

  const url = `/api/torrents/${state.infoHash}/files/0`
  const whole = await call(url)
  const body = Buffer.from(await whole.arrayBuffer())
  check('full file streams back byte-identical', body.equals(payload))
  check('download is sent as an attachment',
    (whole.headers.get('content-disposition') || '').startsWith('attachment'))

  const ranged = await call(url, { headers: { Range: 'bytes=100-199' } })
  const chunk = Buffer.from(await ranged.arrayBuffer())
  check('range request returns 206 with the right slice',
    ranged.status === 206 && chunk.equals(payload.subarray(100, 200)),
    `status ${ranged.status}, ${chunk.length} bytes`)

  const bad = await call(url, { headers: { Range: 'bytes=99999999-' } })
  check('out-of-bounds range returns 416', bad.status === 416)

  const paused = await (await call(`/api/torrents/${state.infoHash}/pause`, {
    method: 'POST', body: JSON.stringify({ paused: true })
  })).json()
  check('torrent can be paused', paused.paused === true)

  const removed = await call(`/api/torrents/${state.infoHash}?files=delete`, { method: 'DELETE' })
  check('torrent can be removed', removed.ok)
  check('list is empty after removal', (await (await call('/api/torrents')).json()).torrents.length === 0)
} catch (err) {
  console.error(err)
  failures++
} finally {
  server.kill('SIGTERM')
  await new Promise((r) => seeder.destroy(r))
  tracker.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
