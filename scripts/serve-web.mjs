// Serves web/ for local development. Any static host works in production —
// this one just sets Service-Worker-Allowed so the stream worker can claim
// the whole app directory.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', 'web')
const PORT = Number(process.env.PORT || 3000)
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json'
}

http.createServer((req, res) => {
  const requested = decodeURIComponent(req.url.split('?')[0])
  const file = path.join(ROOT, requested === '/' ? 'index.html' : requested)
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404)
    return res.end('Not found')
  }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    'Service-Worker-Allowed': '/',
    'Cache-Control': 'no-cache'
  })
  fs.createReadStream(file).pipe(res)
}).listen(PORT, () => {
  console.log(`aTorrent (browser build) on http://localhost:${PORT}`)
  console.log('On a phone, open it over https or the streaming worker stays off.')
})
