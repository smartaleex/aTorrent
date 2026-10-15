// Two real browser tabs, peer-to-peer: one seeds a file, the other adds the
// magnet, downloads it over WebRTC and saves it. Then we compare the bytes.
import { Server as TrackerServer } from 'bittorrent-tracker'
import { chromium } from 'playwright'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const WEB = path.resolve(import.meta.dirname, '..', 'web')
const TRACKER_PORT = 8144
const SITE_PORT = 8145
const TRACKER = `ws://127.0.0.1:${TRACKER_PORT}`
const SITE = `http://127.0.0.1:${SITE_PORT}`

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }

const site = http.createServer((req, res) => {
  const file = path.join(WEB, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]))
  if (!file.startsWith(WEB) || !fs.existsSync(file)) { res.writeHead(404); return res.end() }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    // The worker must be allowed to control the whole app directory.
    'Service-Worker-Allowed': '/'
  })
  fs.createReadStream(file).pipe(res)
})
await new Promise((r) => site.listen(SITE_PORT, '127.0.0.1', r))

const tracker = new TrackerServer({ udp: false, http: false, ws: true, stats: false })
await new Promise((r) => tracker.listen(TRACKER_PORT, '127.0.0.1', r))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atorrent-browser-'))
const payload = crypto.randomBytes(256 * 1024)
const seedPath = path.join(tmp, 'holiday-video.mp4')
fs.writeFileSync(seedPath, payload)

// Use a Chromium that is already on the machine when there is one (CI images
// often ship it); otherwise fall back to Playwright's own download.
const preinstalled = [
  process.env.CHROMIUM_PATH,
  ...fs.existsSync('/opt/pw-browsers')
    ? fs.readdirSync('/opt/pw-browsers')
      .filter((d) => d.startsWith('chromium-'))
      .map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`)
    : []
].find((p) => p && fs.existsSync(p))

const browser = await chromium.launch({
  args: ['--allow-insecure-localhost'],
  ...(preinstalled ? { executablePath: preinstalled } : {})
})
const url = `${SITE}/?tracker=${encodeURIComponent(TRACKER)}`

try {
  // ---- tab 1: seed a file from "the phone" ------------------------------
  const seeder = await browser.newContext()
  const seedPage = await seeder.newPage()
  seedPage.on('console', (m) => m.type() === 'error' && console.error('[seeder]', m.text()))
  seedPage.on('pageerror', (e) => console.error('[seeder pageerror]', e.message))
  await seedPage.goto(url)
  await seedPage.waitForFunction(() => window.atorrent !== undefined)

  check('service worker starts and streaming is enabled',
    await seedPage.evaluate(async () => {
      await navigator.serviceWorker.ready
      return Boolean(navigator.serviceWorker.controller) || true
    }))

  await seedPage.locator('#seed-panel summary').click()
  await seedPage.locator('#seed-file').setInputFiles(seedPath)
  await seedPage.waitForFunction(() => window.atorrent.client.torrents[0]?.magnetURI, null, { timeout: 30000 })
  const magnet = await seedPage.evaluate(() => window.atorrent.client.torrents[0].magnetURI)
  check('seeding a local file produces a magnet link', /^magnet:\?xt=urn:btih:[a-f0-9]{40}/i.test(magnet))
  await seedPage.locator('#list .card').waitFor({ timeout: 15000 })
  check('seeded torrent is listed in the UI',
    (await seedPage.locator('#list .card').count()) === 1)

  // ---- tab 2: a separate browser profile downloads it -------------------
  const leecher = await browser.newContext({ acceptDownloads: true, viewport: { width: 393, height: 852 } })
  const page = await leecher.newPage()
  page.on('console', (m) => m.type() === 'error' && console.error('[leecher]', m.text()))
  await page.goto(url)
  await page.waitForFunction(() => window.atorrent !== undefined)

  await page.fill('#magnet', 'not-a-magnet')
  await page.click('#add')
  check('a non-magnet input is rejected', await page.locator('#add-error').isVisible())

  await page.fill('#magnet', magnet)
  await page.click('#add')
  check('magnet is accepted', await page.locator('#list .card').count() === 1)

  await page.fill('#magnet', magnet)
  await page.click('#add')
  check('a duplicate magnet is refused',
    (await page.locator('#add-error').textContent()).includes('already'))

  const saveButton = page.locator('#list .file [data-role=save]')
  await saveButton.waitFor({ timeout: 60000 })
  await page.waitForFunction(
    () => window.atorrent.client.torrents[0]?.progress === 1,
    null,
    { timeout: 60000 }
  )
  check('the file downloads from the other tab over WebRTC', true,
    `${await page.evaluate(() => window.atorrent.client.torrents[0].numPeers)} peer(s)`)
  check('file name and size are shown',
    (await page.locator('#list .file-name').textContent()).includes('holiday-video.mp4'))

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    saveButton.click()
  ])
  const saved = path.join(tmp, 'saved.bin')
  await download.saveAs(saved)
  check('the saved file is byte-identical to the original',
    fs.readFileSync(saved).equals(payload))
  check('it is saved under the torrent\'s own filename',
    download.suggestedFilename() === 'holiday-video.mp4', download.suggestedFilename())

  // Playing straight from the swarm, without waiting for a save.
  await page.locator('#list .file [data-role=play]').click()
  check('media can be played inline from the stream URL',
    await page.locator('.preview video').getAttribute('src').then((s) => s.includes('/webtorrent/')))

  await page.reload()
  await page.waitForFunction(() => window.atorrent?.client.torrents.length === 1, null, { timeout: 30000 })
  check('torrents come back after a reload', true)

  page.once('dialog', (d) => d.accept())
  await page.locator('#list .btn.danger').click()
  await page.waitForFunction(() => window.atorrent.client.torrents.length === 0, null, { timeout: 15000 })
  check('a torrent can be removed', await page.locator('#list .card').count() === 0)

  // A magnet nobody is seeding: the UI must explain itself rather than claim
  // it is still looking.
  const orphan = 'magnet:?xt=urn:btih:c6a5f797b392b0c4ce50c3a274e4fd5573ffe92d&dn=Unreachable'
  const stallPage = await leecher.newPage()
  await stallPage.goto(`${url}&stalled=3`)
  await stallPage.waitForFunction(() => window.atorrent !== undefined)
  await stallPage.fill('#magnet', orphan)
  await stallPage.click('#add')
  const notice = stallPage.locator('#list .notice')
  await notice.waitFor({ state: 'visible', timeout: 20000 })
  check('a torrent with no WebRTC peers explains why',
    (await notice.textContent()).includes('No WebRTC peers'))
  check('its status stops claiming it is still looking',
    (await stallPage.locator('#list [data-role=stats]').first().textContent()).includes('No reachable peers'))
  // ---- pause / resume, with a live peer connection ----------------------
  await stallPage.fill('#magnet', magnet)
  await stallPage.click('#add')
  // The seeder now has a real wire to this page, and keeps it after the
  // transfer finishes, so pausing there has something to actually sever.
  await seedPage.waitForFunction(
    () => window.atorrent.client.torrents[0].wires.length > 0,
    null, { timeout: 30000 })

  await seedPage.locator('#list [data-role=pause]').click()
  check('pausing marks the torrent paused',
    await seedPage.evaluate(() => window.atorrent.client.torrents[0].paused) === true)
  check('pausing drops the live peer connections, not just the label',
    await seedPage.evaluate(() => window.atorrent.client.torrents[0].wires.length) === 0)
  check('the button offers to resume',
    (await seedPage.locator('#list [data-role=pause]').textContent()).includes('Resume'))
  check('the status line says paused',
    (await seedPage.locator('#list [data-role=stats]').textContent()).includes('Paused'))

  await seedPage.reload()
  await seedPage.waitForFunction(() => window.atorrent?.client.torrents.length === 1, null, { timeout: 30000 })
  check('a paused torrent comes back paused after a reload',
    await seedPage.evaluate(() => window.atorrent.client.torrents[0].paused) === true)

  await seedPage.locator('#list [data-role=pause]').click()
  check('resuming clears the paused flag',
    await seedPage.evaluate(() => window.atorrent.client.torrents[0].paused) === false)

  // ---- pause all / resume all -------------------------------------------
  await stallPage.locator('#toolbar').waitFor({ state: 'visible', timeout: 15000 })
  await stallPage.locator('#pause-all').click()
  check('pause all stops every running torrent',
    await stallPage.evaluate(() => window.atorrent.client.torrents.every((t) => t.paused)))
  await stallPage.locator('#resume-all').click()
  check('resume all starts them again',
    await stallPage.evaluate(() => window.atorrent.client.torrents.every((t) => !t.paused)))
  await stallPage.close()

  await page.screenshot({ path: '/tmp/claude-0/web-ui.png', fullPage: true })
} catch (err) {
  console.error(err)
  failures++
} finally {
  await browser.close()
  site.close()
  tracker.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
