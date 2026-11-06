# ZenMusic — Listen Freely.

**No ads. No paywall. No tracking.** A beautiful BitChord-inspired web music player that streams from free & legal sources in one queue. Built with React + Vite, ready for Vercel in 1 click.

> Inspired by **BitChord** (Android YouTube Music client by Kushagra Singh), **Cantio** (React + Vercel open player), and **Riff** (Electron + WebGL player).

![ZenMusic](https://img.shields.io/badge/React-18-61DAFB?logo=react) ![Vercel](https://img.shields.io/badge/Deploy-Vercel-black?logo=vercel) ![No Ads](https://img.shields.io/badge/ads-0-10b981)

## Features

- **5 sources, 1 queue** — switch anytime, playback keeps going
  - **Audius** — open artist-upload platform, full tracks free, no API key
  - **Internet Archive** — ~4M public-domain / CC recordings (netlabels, liveetree, 78rpm)
  - **Jamendo** — 600k+ Creative Commons tracks (needs free `client_id`)
  - **iTunes Search** — 30s previews, keyless, great for discovery
  - **YouTube** — popular hits via **official YouTube IFrame Player API** (compliant embed). Search via Piped public API so no Google API key needed.
- **BitChord-grade UI** — frosted glass, artwork-driven gradients, vinyl stack, sync lyrics, queue drawer, fullscreen player
- **Own your data** — favorites, playlists, history, volume stored locally. No login, no telemetry
- **Lyrics** — auto-fetched from [lrclib.net](https://lrclib.net) (open, no key)
- **PWA-ready** + fully responsive (desktop sidebar + right panel, mobile bottom player)
- **Vercel-ready** — `vite build` → `dist`, `vercel.json` included

## Quick start

```bash
cd zenmusic
npm install
npm run dev      # http://localhost:5173
npm run build    # production to dist/
```

## Deploy to Vercel (1 click)

1. Push this repo to GitHub
2. Vercel → **Add New Project** → Import repo
3. **Set Root Directory to `zenmusic`** (important!)
   - Framework Preset: `Vite`
   - Build Command: `npm run build`
   - Output Directory: `dist`
   - Install Command: `npm install`
4. (Optional) Add env var: `VITE_JAMENDO_CLIENT_ID` — get from https://developer.jamendo.com/
5. Deploy → you’re live!

> `zenmusic/vercel.json` is already configured if you set Root Directory to `zenmusic`. If you deploy the whole repo as monorepo, Vercel auto-detects it.

## How free listening stays legal

ZenMusic **does not host music**. It does what BitChord/Cantio/Riff do:

- Audius & Archive & Jamendo provide audio URLs you’re licensed to play
- iTunes gives 30s previews
- YouTube is played via the **official IFrame Player API** — same as embedding a YouTube video. We never scrape, re-encode, or proxy audio bytes.

This keeps the app distributable under MIT, with a disclaimer like BitChord’s: *Not affiliated with YouTube/Google, respect each track’s license & the source ToS.*

## Project structure

```
zenmusic/
  index.html           Vite entry
  vite.config.js       Vite + React
  vercel.json          Vercel rewrites
  src/
    main.jsx           React root
    App.jsx            All views + player logic
    styles.css         BitChord-inspired design system
    services/musicApi.js  Audius/Archive/iTunes/Jamendo/YouTube/Piped + lyrics
```

## Environment

Create `.env` from `.env.example`:

```
VITE_JAMENDO_CLIENT_ID=xxx
```

If empty, Jamendo tab shows empty with a hint — other sources keep working. For 100% keyless, Audius + Archive + iTunes + YouTube are enough.

## Customize

- **Colors**: edit CSS variables in `src/styles.css` (`--accent`, `--bg`, etc.)
- **Moods**: edit quick moods in `src/App.jsx`
- **Add source**: add a fetcher in `services/musicApi.js` and include it in `searchAll()`

## Credits

- BitChord by Kushagra Singh (GPL-3.0) — UI & Innertube idea
- Cantio by akshay-k-a-dev (MIT) — Vercel + React structure
- Riff by rootscripts (MIT) — multi-source + design
- Nuclear / ByTune / SimpMusic — additional streaming patterns

## License

MIT — free to fork, deploy, remix. Keep the disclaimer if you distribute publicly.

---
Made with ♫ for free music.
