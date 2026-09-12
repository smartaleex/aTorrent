# aTorrent

A BitTorrent client that runs entirely in a browser tab, built for a phone.
Paste a magnet link, watch it download over WebRTC, play video while it is still
arriving, and save finished files into the iOS Files app. No server, no account,
no App Store.

There is also an optional Node server for the torrents the browser cannot reach —
see [Server mode](#server-mode-optional).

## Browser mode (the default)

Everything happens in the tab: peer discovery, the swarm connections, piece
verification and storage. A service worker turns each file in the torrent into a
real URL, so media streams from the swarm into a `<video>` element before the
download has finished.

**What it reaches.** Browsers can only open WebRTC connections, so aTorrent sees
the WebRTC side of a swarm: other aTorrent and WebTorrent users, and desktop
clients running in hybrid mode. It cannot connect to the plain TCP/uTP peers that
make up most of a typical public torrent. A magnet with no WebRTC seeds will sit
at 0% with 0 peers — that is the trade for needing nothing installed. Server mode
covers that case.

**Storage.** Downloads are written to the browser's own storage (OPFS) as they
arrive, so a download is not capped by RAM. Saving a file to the Files app is,
though: Safari has no streaming save, so the file passes through memory on its
way out. Files over a gigabyte will warn you before trying.

### Run it

```bash
npm install
npm run web          # http://localhost:3000
```

Any static host works in production — the whole app is `web/`, a directory of
static files with no build step. Push to `main` and the included GitHub Actions
workflow publishes it to GitHub Pages.

**Host it over https.** Service workers and the clipboard API are both blocked on
plain `http://` outside localhost, so over http you lose play-while-downloading
and the Paste button. GitHub Pages, Netlify, Cloudflare Pages and Vercel all give
you https for free on a static directory.

### On your iPhone

1. Open the https URL in Safari.
2. **Share → Add to Home Screen** — it then launches full-screen with its own icon.
3. Copy a magnet link, tap **Paste**, tap **Add torrent**.
4. When a file finishes, **⤓ Save** hands it to Safari's downloader; it lands in
   Files under *On My iPhone → Downloads*. **Play** streams video or audio
   immediately, without waiting for the rest.

Keep the tab in the foreground while downloading — iOS suspends background tabs,
which drops the peer connections.

Other things it does:

- **Share a file from this phone** seeds a file straight off the device and gives
  you a magnet link for it. Anyone with the link downloads it peer-to-peer, with
  nothing uploaded to a server in between. Both tabs have to stay open.
- `?magnet=magnet:?xt=…` pre-fills the box, so magnets can be shared into the app.
- `?tracker=wss://…` points it at your own WebSocket tracker instead of the
  public ones (repeat the parameter for several).
- Added torrents are remembered in `localStorage` and re-added on next open.

## Server mode (optional)

When you want the classic swarm — the TCP peers browsers cannot reach — or you
want downloads to continue while your phone is asleep, run the small Node server
in `server.js` on a machine that stays on. It joins the swarm properly, and the
phone talks to it over plain HTTP from the same mobile UI.

```bash
ATORRENT_PASSWORD='pick-something' npm start   # http://<that-machine>:8080
```

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `8080` | Port to listen on |
| `ATORRENT_DOWNLOAD_DIR` | `./downloads` | Where finished files are written |
| `ATORRENT_PASSWORD` | _(none)_ | Password for the UI. Without it, anyone who can reach the port can use it |
| `ATORRENT_MAX_TORRENTS` | `25` | Concurrent torrent limit |

Active torrents are saved to `data/torrents.json` and resume after a restart. To
reach it from outside your home network, the safe option is
[Tailscale](https://tailscale.com/) on both the server and the phone; the auth
cookie marks itself `Secure` automatically once you serve it over https.

<details>
<summary>Server API</summary>

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/session` | Whether auth is required, and whether you have it |
| `POST` | `/api/login` | `{ "password": "…" }` → sets the auth cookie |
| `GET` | `/api/torrents` | All torrents with live progress |
| `POST` | `/api/torrents` | `{ "magnet": "magnet:?xt=…" }` |
| `POST` | `/api/torrents/:infoHash/pause` | `{ "paused": true \| false }` |
| `DELETE` | `/api/torrents/:infoHash` | `?files=keep` leaves files on disk |
| `GET` | `/api/torrents/:infoHash/files/:index` | Download a file (supports `Range`) |

</details>

## Tests

```bash
npm test              # both suites
npm run test:browser  # two real browser tabs, peer-to-peer
npm run test:server   # the Node server against a live swarm
```

`test/browser.mjs` is the interesting one: it starts a local WebSocket tracker,
opens two separate browser profiles, seeds a file from one, adds the magnet in
the other, waits for the transfer to complete over WebRTC, saves the file, and
checks the bytes are identical to the original. It also covers inline streaming
playback, duplicate and invalid magnets, restore-after-reload, and removal.

`test/e2e.mjs` does the equivalent for server mode against a local tracker and
seeder, including auth, HTTP range requests, pause and removal.

## A note on what you download

This is a general-purpose BitTorrent client, like uTorrent or Transmission.
Plenty of torrents are perfectly legal — Linux ISOs, Internet Archive material,
game patches, public-domain film. Downloading copyrighted material you have no
right to is not, and your ISP can see you doing it. What you point it at is on you.
