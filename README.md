# aTorrent

A self-hosted magnet-link downloader with a phone-first web UI. Paste a magnet
link from your iPhone, watch it download, then tap **Save** to pull the finished
file into the iOS Files app.

<!-- Screenshot: the UI is a single dark screen — magnet box on top, one card per torrent. -->

## How it works (and why it works this way)

iOS does not let a web page — or any App Store app — speak the BitTorrent
protocol to swarms of peers in the background. So aTorrent splits the job:

- **A small Node server does the torrenting.** Run it on a machine that stays
  on: a desktop, a home server, a Raspberry Pi, a VPS. It joins the swarm,
  downloads to its own disk, and keeps going whether or not your phone is awake.
- **Your iPhone is the remote control.** A mobile web UI you open in Safari to
  add magnets, watch progress, and download completed files onto the phone
  itself, where they land in Files (or Photos, for images and video, via the
  share sheet).

That means the phone only ever makes ordinary HTTP requests, which is the one
thing iOS is happy to do.

## Requirements

- Node.js 20 or newer on the machine that will do the downloading
- That machine and your iPhone on the same network (or joined by something like
  Tailscale — see [Using it away from home](#using-it-away-from-home))

## Setup

```bash
git clone <this repo>
cd aTorrent
npm install
```

Run it:

```bash
ATORRENT_PASSWORD='pick-something' npm start
```

It prints the port it is listening on (8080 by default) and the folder it saves
to.

### Configuration

All optional, all environment variables:

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `8080` | Port to listen on |
| `ATORRENT_DOWNLOAD_DIR` | `./downloads` | Where finished files are written |
| `ATORRENT_PASSWORD` | _(none)_ | Password for the web UI. **Set this.** Without it, anyone who can reach the port can add torrents |
| `ATORRENT_MAX_TORRENTS` | `25` | How many torrents may be active at once |

Active torrents are recorded in `data/torrents.json` and resume automatically
when the server restarts.

## Using it from your iPhone

1. Find the server machine's local IP (`ipconfig getifaddr en0` on a Mac,
   `hostname -I` on Linux).
2. On the iPhone, open Safari and go to `http://<that-ip>:8080`.
3. Enter your password.
4. **Share → Add to Home Screen.** It then opens full-screen with its own icon,
   like an app.

To download something: copy a magnet link, paste it into the box, tap **Add
torrent**. The card shows progress, speed, peers, and an ETA. When a file
finishes, its **⤓ Save** button lights up — tap it and Safari downloads the file
to your phone; open it from the Downloads arrow in Safari's toolbar, or find it
in Files under *On My iPhone*.

A few iPhone-specific notes:

- The **Paste** button uses the clipboard API, which Safari only allows on
  `https://` or `localhost`. Over plain `http://` on your LAN, long-press the box
  and paste the normal way.
- Big files: keep Safari in the foreground while the save runs. The server
  supports HTTP range requests, so an interrupted download can resume rather
  than start over.
- You can also deep-link a magnet straight into the app:
  `http://<ip>:8080/?magnet=magnet:?xt=...` pre-fills the box.

### Using it away from home

The simplest safe option is [Tailscale](https://tailscale.com/): install it on
both the server and the iPhone, and the server becomes reachable at its
Tailscale IP from anywhere, with no ports opened on your router. If you would
rather expose it publicly, put it behind a reverse proxy with HTTPS
(Caddy does this in about three lines) and keep `ATORRENT_PASSWORD` set — the
auth cookie is marked `Secure` automatically once it is served over HTTPS.

## Tests

```bash
npm test
```

This spins up a local BitTorrent tracker and seeder, adds the magnet through the
running server's own HTTP API, waits for a real download to complete, and checks
that the bytes streamed back to the client are identical to the seeded file. It
also covers auth, duplicate rejection, range requests, pause, and removal.

## A note on what you download

This is a general-purpose BitTorrent client, the same as uTorrent or
Transmission. Plenty of torrents are perfectly legal — Linux ISOs, Internet
Archive material, game patches, public-domain film. Downloading copyrighted
material you have no right to is not, and your ISP can see you doing it. What
you point it at is on you.

## API

Every endpoint requires the auth cookie when `ATORRENT_PASSWORD` is set.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/session` | Whether auth is required, and whether you have it |
| `POST` | `/api/login` | `{ "password": "…" }` → sets the auth cookie |
| `GET` | `/api/torrents` | All torrents with live progress |
| `POST` | `/api/torrents` | `{ "magnet": "magnet:?xt=…" }` |
| `POST` | `/api/torrents/:infoHash/pause` | `{ "paused": true \| false }` |
| `DELETE` | `/api/torrents/:infoHash` | Add `?files=keep` to leave files on disk |
| `GET` | `/api/torrents/:infoHash/files/:index` | Download a file (supports `Range`; `?inline=1` to view in-browser instead of saving) |
