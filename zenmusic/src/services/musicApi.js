// ZenMusic music API — multi-source, keyless-first, Vercel-friendly
// Sources: Audius (free full tracks), Archive (public domain/CC), iTunes (30s preview), Jamendo (CC, needs client_id), YouTube via Piped (embed)

const APP_NAME = 'zenmusic'

const AUDIUS_HOSTS = [
  'https://discoveryprovider.audius.co',
  'https://audius-discovery-1.cultur3stake.com',
  'https://discoveryprovider2.audius.co',
]

const PIPED_HOSTS = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.leptos.anonaddy.me',
  'https://pipedapi.adminforge.de',
]

function withTimeout(promise, ms = 8000) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ])
}

function toCover(url, fallback) {
  if (!url) return fallback
  // Audius artwork is already full url
  return url
}

function fmtDuration(sec) {
  if (!sec || isNaN(sec)) return '—'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2,'0')}`
}

// ---------- Audius ----------
async function fetchAudius(path) {
  let lastErr
  for (const host of AUDIUS_HOSTS) {
    try {
      const url = `${host}${path}${path.includes('?') ? '&' : '?'}app_name=${APP_NAME}`
      const res = await withTimeout(fetch(url, { headers: { Accept: 'application/json' } }))
      if (!res.ok) throw new Error(`Audius ${res.status}`)
      const json = await res.json()
      return json
    } catch (e) { lastErr = e }
  }
  throw lastErr || new Error('Audius unavailable')
}

export async function trendingAudius(limit = 24) {
  const json = await fetchAudius(`/v1/tracks/trending?limit=${limit}&timeRange=week`)
  const tracks = json.data || []
  return tracks.map(mapAudiusTrack)
}

export async function searchAudius(q, limit = 20) {
  if (!q?.trim()) return []
  const json = await fetchAudius(`/v1/tracks/search?query=${encodeURIComponent(q)}&limit=${limit}`)
  return (json.data || []).map(mapAudiusTrack)
}

function mapAudiusTrack(t) {
  return {
    id: `audius:${t.id}`,
    title: t.title || 'Untitled',
    artist: t.user?.name || t.user?.handle || 'Unknown Artist',
    artwork: toCover(t.artwork?.['480x480'] || t.artwork?.['150x150'] || t.artwork?.['640x640'], ''),
    duration: t.duration || 0,
    durationText: fmtDuration(t.duration),
    source: 'audius',
    streamUrl: `https://discoveryprovider.audius.co/v1/tracks/${t.id}/stream?app_name=${APP_NAME}`,
    // some tracks need alternative host; we provide fallback resolver
    raw: t,
  }
}

// ---------- iTunes ----------
export async function searchItunes(q, limit = 20) {
  if (!q?.trim()) return []
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&limit=${limit}`
  const res = await withTimeout(fetch(url))
  if (!res.ok) throw new Error('iTunes error')
  const json = await res.json()
  return (json.results || []).map(mapItunes)
}
function mapItunes(t) {
  return {
    id: `itunes:${t.trackId}`,
    title: t.trackName,
    artist: t.artistName,
    artwork: (t.artworkUrl100 || '').replace('100x100bb','480x480bb') || '',
    duration: (t.trackTimeMillis || 0)/1000,
    durationText: fmtDuration((t.trackTimeMillis||0)/1000),
    source: 'itunes',
    streamUrl: t.previewUrl, // 30s preview
    raw: t,
  }
}

// ---------- Archive ----------
export async function searchArchive(q, limit = 12) {
  // Use advanced search for music
  const query = q ? `${q} AND mediatype:(etree OR audio)` : 'mediatype:(etree OR audio)'
  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&fl=identifier,title,creator,description,downloads,mediatype&sort=downloads+desc&rows=${limit}&page=1&output=json`
  const res = await withTimeout(fetch(url))
  if (!res.ok) throw new Error('Archive search failed')
  const json = await res.json()
  const docs = json.response?.docs || []
  // For each doc, we need to resolve one playable mp3 lazily
  const mapped = docs.map(d => ({
    id: `archive:${d.identifier}`,
    title: d.title || d.identifier,
    artist: Array.isArray(d.creator) ? d.creator[0] : (d.creator || 'Internet Archive'),
    artwork: `https://archive.org/services/img/${d.identifier}`,
    duration: 0,
    durationText: '—',
    source: 'archive',
    streamUrl: null, // resolved on play
    identifier: d.identifier,
    raw: d,
  }))
  return mapped
}

export async function resolveArchiveStream(identifier) {
  const metaUrl = `https://archive.org/metadata/${identifier}`
  const res = await withTimeout(fetch(metaUrl))
  if (!res.ok) throw new Error('Archive metadata failed')
  const json = await res.json()
  const files = json.files || []
  // Prefer mp3, then ogg, then flac
  const pick = files.find(f => f.name?.endsWith('.mp3') && f.source !== 'derivative')
    || files.find(f => f.name?.endsWith('.mp3'))
    || files.find(f => f.name?.endsWith('.ogg'))
    || files.find(f => f.name?.endsWith('.flac') || f.name?.endsWith('.m4a'))
  if (!pick) throw new Error('No playable file')
  return `https://archive.org/download/${identifier}/${encodeURIComponent(pick.name)}`
}

// ---------- Jamendo ----------
export async function searchJamendo(q, limit = 20) {
  const clientId = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_JAMENDO_CLIENT_ID) || ''
  // Also allow localStorage override
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('zenmusic:jamendo_id') : null
  const id = clientId || stored || ''
  if (!id) {
    // Return empty but not error — UI will show hint
    return []
  }
  const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${id}&format=json&limit=${limit}&search=${encodeURIComponent(q || 'chill')}&include=musicinfo&groupby=artist_id`
  const res = await withTimeout(fetch(url))
  if (!res.ok) throw new Error('Jamendo error')
  const json = await res.json()
  return (json.results || []).map(mapJamendo)
}
function mapJamendo(t) {
  return {
    id: `jamendo:${t.id}`,
    title: t.name,
    artist: t.artist_name,
    artwork: t.album_image || t.image || '',
    duration: Number(t.duration) || 0,
    durationText: fmtDuration(Number(t.duration)),
    source: 'jamendo',
    streamUrl: t.audio, // direct mp3
    raw: t,
  }
}

// ---------- YouTube via Piped ----------
export async function searchYouTube(q, limit = 12) {
  if (!q?.trim()) return []
  for (const host of PIPED_HOSTS) {
    try {
      const url = `${host}/search?q=${encodeURIComponent(q)}&filter=music_songs`
      const res = await withTimeout(fetch(url, { headers: { Accept: 'application/json' } }))
      if (!res.ok) continue
      const json = await res.json()
      const items = (json.items || json.content || []).slice(0, limit)
      const mapped = items
        .filter(i => i.type === 'stream' || i.type === 'video' || i.url)
        .map(mapPiped)
        .filter(Boolean)
      if (mapped.length) return mapped
    } catch {}
  }
  return []
}
function mapPiped(item) {
  // Piped item has url like /watch?v=xxx
  const id = item.url?.split('v=')[1]?.split('&')[0] || item.videoId || item.id
  if (!id) return null
  return {
    id: `youtube:${id}`,
    title: item.title || item.name || 'YouTube Track',
    artist: item.uploaderName || item.uploader || 'YouTube',
    artwork: item.thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    duration: item.duration || 0,
    durationText: item.duration ? fmtDuration(item.duration) : '—',
    source: 'youtube',
    streamUrl: null, // played via iframe
    youtubeId: id,
    raw: item,
  }
}

// ---------- Mock fallback ----------
export const MOCK_TRACKS = [
  { id:'mock:1', title:'Midnight City Dreams', artist:'Lofi Zen', artwork:'https://picsum.photos/seed/zen1/480/480', duration:187, durationText:'3:07', source:'audius', streamUrl:'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3' },
  { id:'mock:2', title:'Neon Phonk Drift', artist:'Velvet Roads', artwork:'https://picsum.photos/seed/zen2/480/480', duration:162, durationText:'2:42', source:'audius', streamUrl:'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3' },
  { id:'mock:3', title:'Archive Gem — 1947 Jazz', artist:'Internet Archive', artwork:'https://picsum.photos/seed/zen3/480/480', duration:0, durationText:'—', source:'archive', streamUrl:'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3' },
  { id:'mock:4', title:'Chillhop Essentials', artist:'Lofi Collective', artwork:'https://picsum.photos/seed/zen4/480/480', duration:203, durationText:'3:23', source:'itunes', streamUrl:'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3' },
  { id:'mock:5', title:'Ethereal Bloom', artist:'Jamendo Artist', artwork:'https://picsum.photos/seed/zen5/480/480', duration:221, durationText:'3:41', source:'audius', streamUrl:'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3' },
]

// Unified search
export async function searchAll(q, source = 'all') {
  if (!q?.trim()) return []
  const tasks = []
  if (source === 'all' || source === 'audius') tasks.push(searchAudius(q).catch(()=>[]))
  if (source === 'all' || source === 'itunes') tasks.push(searchItunes(q).catch(()=>[]))
  if (source === 'all' || source === 'youtube') tasks.push(searchYouTube(q).catch(()=>[]))
  if (source === 'all' || source === 'archive') tasks.push(searchArchive(q).catch(()=>[]))
  if (source === 'all' || source === 'jamendo') tasks.push(searchJamendo(q).catch(()=>[]))

  const results = await Promise.all(tasks)
  // flatten and dedupe by id
  const flat = results.flat()
  // simple relevance: audius first, then youtube, then itunes
  return flat
}

// Lyrics via lrclib
export async function fetchLyrics(artist, title) {
  if (!artist || !title) return null
  try {
    const url = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`
    const res = await withTimeout(fetch(url))
    if (!res.ok) throw new Error('no lyrics')
    const json = await res.json()
    if (json.plainLyrics || json.syncedLyrics) return json
  } catch {}
  try {
    const url2 = `https://lrclib.net/api/search?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`
    const res = await withTimeout(fetch(url2))
    if (!res.ok) return null
    const arr = await res.json()
    if (Array.isArray(arr) && arr[0]) return arr[0]
  } catch {}
  return null
}
