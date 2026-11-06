import React, { useEffect, useRef, useState, useMemo } from 'react'
import { trendingAudius, searchAll, searchArchive, resolveArchiveStream, fetchLyrics, MOCK_TRACKS } from './services/musicApi.js'

const STORAGE = {
  fav: 'zenmusic:favs',
  queue: 'zenmusic:queue',
  history: 'zenmusic:history',
  playlists: 'zenmusic:playlists',
  volume: 'zenmusic:volume',
}

function useLocal(key, init) {
  const [val, setVal] = useState(() => {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : init } catch { return init }
  })
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(val)) } catch {} }, [key, val])
  return [val, setVal]
}

export default function App() {
  const [view, setView] = useState('discover')
  const [source, setSource] = useState('all')
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [trending, setTrending] = useState([])
  const [archiveGems, setArchiveGems] = useState([])
  const [queue, setQueue] = useLocal(STORAGE.queue, [])
  const [favorites, setFavorites] = useLocal(STORAGE.fav, [])
  const [history, setHistory] = useLocal(STORAGE.history, [])
  const [playlists, setPlaylists] = useLocal(STORAGE.playlists, [])
  const [activePlaylistId, setActivePlaylistId] = useState(null)
  const [volume, setVolume] = useLocal(STORAGE.volume, 85)

  const [current, setCurrent] = useState(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [shuffle, setShuffle] = useState(false)
  const [repeat, setRepeat] = useState('off') // off | one | all
  const [showQueue, setShowQueue] = useState(false)
  const [showFs, setShowFs] = useState(false)
  const [lyrics, setLyrics] = useState(null)
  const [mobileMenu, setMobileMenu] = useState(false)

  const audioRef = useRef(null)
  const ytPlayerRef = useRef(null)
  const ytReadyRef = useRef(false)
  const progressRef = useRef(null)

  // Load trending & archive on mount
  useEffect(() => {
    let cancelled = false
    trendingAudius(18).then(data => { if (!cancelled) setTrending(data.length ? data : MOCK_TRACKS.slice(0,6)) }).catch(()=> setTrending(MOCK_TRACKS.slice(0,6)))
    searchArchive('jazz').then(d => { if (!cancelled) setArchiveGems(d.slice(0,6)) }).catch(()=> setArchiveGems(MOCK_TRACKS.slice(2,5)))
    return () => { cancelled = true }
  }, [])

  // persist volume
  useEffect(() => { if (audioRef.current) audioRef.current.volume = volume/100 }, [volume])

  // YT API ready — poll
  useEffect(() => {
    const check = () => {
      if (window.YT && window.YT.Player && !ytPlayerRef.current) {
        ytPlayerRef.current = new window.YT.Player('ytPlayer', {
          height: '1', width: '1',
          playerVars: { playsinline: 1, controls: 0, modestbranding: 1, rel: 0 },
          events: {
            onReady: () => { ytReadyRef.current = true; if (ytPlayerRef.current) ytPlayerRef.current.setVolume(volume) },
            onStateChange: (e) => {
              if (e.data === window.YT.PlayerState.ENDED) handleNext()
              if (e.data === window.YT.PlayerState.PLAYING) setIsPlaying(true)
              if (e.data === window.YT.PlayerState.PAUSED) setIsPlaying(false)
            }
          }
        })
      }
    }
    window.onYouTubeIframeAPIReady = check
    const id = setInterval(check, 500)
    return () => clearInterval(id)
  }, [])

  // Lyrics fetch
  useEffect(() => {
    if (!current) { setLyrics(null); return }
    let cancelled = false
    setLyrics({ plainLyrics: 'Loading lyrics…' })
    fetchLyrics(current.artist, current.title).then(res => {
      if (cancelled) return
      if (res?.plainLyrics || res?.syncedLyrics) setLyrics(res)
      else setLyrics({ plainLyrics: 'No lyrics found for this track.\n\nTip: Lyrics powered by lrclib.net — open source.' })
    }).catch(()=> setLyrics({ plainLyrics: 'Lyrics unavailable.' }))
    return () => { cancelled = true }
  }, [current?.id])

  // audio events
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onTime = () => {
      setCurrentTime(audio.currentTime)
      setDuration(audio.duration || duration)
      setProgress(audio.duration ? (audio.currentTime / audio.duration) * 1000 : 0)
    }
    const onEnded = () => handleNext()
    const onLoaded = () => setDuration(audio.duration || 0)
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('loadedmetadata', onLoaded)
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('loadedmetadata', onLoaded)
    }
  }, [current, queue, repeat, shuffle])

  // handle YT time via polling when YT active
  useEffect(() => {
    if (current?.source !== 'youtube' || !ytReadyRef.current) return
    const id = setInterval(() => {
      try {
        const p = ytPlayerRef.current
        if (!p?.getCurrentTime) return
        const ct = p.getCurrentTime()
        const dur = p.getDuration()
        setCurrentTime(ct)
        setDuration(dur)
        setProgress(dur ? (ct/dur)*1000 : 0)
      } catch {}
    }, 500)
    return () => clearInterval(id)
  }, [current?.id, current?.source])

  function toast(msg) {
    const el = document.getElementById('toast')
    if (!el) return
    el.textContent = msg
    el.hidden = false
    clearTimeout(el._t)
    el._t = setTimeout(()=> el.hidden = true, 2500)
  }

  async function playTrack(track, addToHistory = true) {
    if (!track) return
    // resolve archive stream if needed
    if (track.source === 'archive' && track.identifier && !track.streamUrl) {
      try {
        toast('Resolving Archive file…')
        const url = await resolveArchiveStream(track.identifier)
        track = { ...track, streamUrl: url }
      } catch (e) {
        toast('Failed to resolve Archive track')
        return
      }
    }
    setCurrent(track)
    setIsPlaying(true)
    setShowQueue(false)
    // push to queue if not already
    setQueue(q => {
      const exists = q.find(t => t.id === track.id)
      if (exists) return q
      return [track, ...q].slice(0,100)
    })
    if (addToHistory) setHistory(h => [track, ...h.filter(t=>t.id!==track.id)].slice(0,50))

    // play via correct engine
    if (track.source === 'youtube') {
      try {
        if (audioRef.current) { audioRef.current.pause() }
        if (ytPlayerRef.current && ytReadyRef.current) {
          ytPlayerRef.current.loadVideoById(track.youtubeId)
          ytPlayerRef.current.setVolume(volume)
          // YT will autoplay
        } else {
          toast('YouTube player not ready — try again')
        }
      } catch { toast('YouTube playback failed') }
    } else {
      try {
        if (ytPlayerRef.current?.pauseVideo) ytPlayerRef.current.pauseVideo()
        const audio = audioRef.current
        if (!track.streamUrl) { toast('No stream URL for this track'); return }
        audio.src = track.streamUrl
        audio.volume = volume/100
        await audio.play()
      } catch (e) {
        toast('Playback blocked — tap play again')
        setIsPlaying(false)
      }
    }
  }

  function togglePlay() {
    if (!current) {
      if (trending[0]) playTrack(trending[0])
      return
    }
    if (current.source === 'youtube') {
      const p = ytPlayerRef.current
      if (!p) return
      const state = p.getPlayerState?.()
      if (state === window.YT?.PlayerState?.PLAYING) { p.pauseVideo(); setIsPlaying(false) }
      else { p.playVideo(); setIsPlaying(true) }
      return
    }
    const audio = audioRef.current
    if (!audio) return
    if (isPlaying) { audio.pause(); setIsPlaying(false) }
    else { audio.play().then(()=> setIsPlaying(true)).catch(()=> toast('Play failed')) }
  }

  function handleNext() {
    const list = queue.length ? queue : trending
    if (!list.length) return
    if (repeat === 'one' && current) { playTrack(current, false); return }
    let idx = list.findIndex(t => t.id === current?.id)
    if (shuffle) {
      const next = list[Math.floor(Math.random()*list.length)]
      playTrack(next, false)
      return
    }
    let nextIdx = idx + 1
    if (nextIdx >= list.length) {
      if (repeat === 'all') nextIdx = 0
      else { setIsPlaying(false); return }
    }
    playTrack(list[nextIdx], false)
  }
  function handlePrev() {
    if (currentTime > 3) {
      if (current?.source === 'youtube') ytPlayerRef.current?.seekTo(0, true)
      else if (audioRef.current) audioRef.current.currentTime = 0
      return
    }
    const list = queue.length ? queue : trending
    let idx = list.findIndex(t => t.id === current?.id)
    let prevIdx = idx - 1
    if (prevIdx < 0) prevIdx = list.length - 1
    if (list[prevIdx]) playTrack(list[prevIdx], false)
  }

  async function doSearch(e) {
    e?.preventDefault()
    if (!query.trim()) { setSearchResults([]); setView('discover'); return }
    setView('search')
    setSearchLoading(true)
    try {
      const res = await searchAll(query, source)
      if (!res.length) {
        // fallback to mock filtered
        const filtered = MOCK_TRACKS.filter(t => t.title.toLowerCase().includes(query.toLowerCase()) || t.artist.toLowerCase().includes(query.toLowerCase()))
        setSearchResults(filtered.length ? filtered : [])
      } else setSearchResults(res)
    } catch {
      setSearchResults([])
    } finally { setSearchLoading(false) }
  }

  function toggleLike(track) {
    const id = track.id
    setFavorites(f => {
      const exists = f.find(t => t.id === id)
      if (exists) { toast('Removed from favorites'); return f.filter(t=>t.id!==id) }
      toast('Added to favorites ♥')
      return [track, ...f]
    })
  }
  function isLiked(id) { return favorites.some(t => t.id === id) }

  function createPlaylist(name) {
    if (!name?.trim()) return
    const pl = { id: 'pl_'+Date.now(), name: name.trim(), tracks: [], createdAt: Date.now() }
    setPlaylists(p => [pl, ...p])
    toast(`Playlist “${pl.name}” created`)
  }
  function addToPlaylist(plId, track) {
    setPlaylists(p => p.map(pl => pl.id===plId ? { ...pl, tracks: [...pl.tracks.filter(t=>t.id!==track.id), track] } : pl))
    toast('Added to playlist')
  }
  function removeFromPlaylist(plId, trackId) {
    setPlaylists(p => p.map(pl => pl.id===plId ? { ...pl, tracks: pl.tracks.filter(t=>t.id!==trackId)} : pl))
  }

  const activePlaylist = useMemo(()=> playlists.find(p=>p.id===activePlaylistId) || null, [playlists, activePlaylistId])

  // keyboard
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT') return
      if (e.key === ' ' ) { e.preventDefault(); togglePlay() }
      if (e.key === '/' ) { e.preventDefault(); document.getElementById('searchInput')?.focus() }
      if (e.key === 'n' && (e.metaKey||e.ctrlKey)) return
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, isPlaying, trending])

  const heroTrack = trending[0]
  const heroSecond = trending[1]

  return (
    <>
      <header className="topbar">
        <a className="brand" href="#" onClick={e=>{e.preventDefault(); setView('discover')}}>
          <span className="brand-mark">
            <svg viewBox="0 0 32 32" width="28" height="28"><rect width="32" height="32" rx="9" fill="#8b5cf6"/><path d="M14.6 9.2a1.2 1.2 0 0 0-1.2 1.2v11.1a3 3 0 1 0 1.2 0V10.4a1.2 1.2 0 0 0-1.2-1.2Zm5 4a1.2 1.2 0 0 0-1.2 1.2v7.1a2.2 2.2 0 1 0 1.2 0v-7.1a1.2 1.2 0 0 0-1.2-1.2Z" fill="white"/></svg>
          </span>
          <span className="brand-text"><strong>zenmusic</strong><em>•</em><span>beta</span></span>
        </a>

        <form className="search-center" onSubmit={doSearch}>
          <div className="search-field">
            <svg className="icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m16 16 4 4"/></svg>
            <input id="searchInput" type="search" placeholder="Search songs, artists, or mood — try 'chill', 'lofi', 'phonk'" value={query} onChange={e=>setQuery(e.target.value)} />
            <kbd>/</kbd>
            <button type="submit" className="search-go">↵</button>
          </div>
          <div className="source-pills" role="tablist">
            {['all','audius','youtube','archive','jamendo','itunes'].map(s=>(
              <button key={s} type="button" className={`pill ${source===s?'active':''}`} onClick={()=>setSource(s)}>{s==='all'?'All': s.charAt(0).toUpperCase()+s.slice(1)}</button>
            ))}
          </div>
        </form>

        <div className="top-actions">
          <button className="icon-btn" title="About sources" onClick={()=>document.getElementById('sourceDialog')?.showModal()}>ⓘ</button>
          <a className="icon-btn ghost" href="https://github.com/kushagrasinghx/BitChord" target="_blank" rel="noopener" title="Inspired by BitChord">↗</a>
          <button className="icon-btn mobile-only" onClick={()=>setMobileMenu(m=>!m)}>☰</button>
        </div>
      </header>

      <div className="shell">
        <aside className={`sidebar ${mobileMenu?'open':''}`} id="sidebar">
          <nav className="nav primary-nav">
            {[
              {id:'discover', label:'Discover', icon:'◈', badge:'new'},
              {id:'search', label:'Search', icon:'⌕', count: searchResults.length||''},
              {id:'queue', label:'Queue', icon:'≡', count: queue.length},
              {id:'favorites', label:'Favorites', icon:'♡', count: favorites.length},
              {id:'playlists', label:'Playlists', icon:'▭'},
              {id:'history', label:'History', icon:'◷'},
            ].map(item=>(
              <button key={item.id} className={`nav-item ${view===item.id?'active':''}`} onClick={()=>{setView(item.id); setMobileMenu(false)}}>
                <span className="nav-icon">{item.icon}</span> {item.label} {item.badge && <span className="nav-badge">{item.badge}</span>} {item.count? <span className="nav-count">{item.count}</span> : null}
              </button>
            ))}
          </nav>

          <div className="sidebar-block">
            <div className="block-head"><h3>Your playlists</h3><button className="mini-btn" onClick={()=>document.getElementById('playlistDialog')?.showModal()}>＋ New</button></div>
            <div className="playlist-list">
              {playlists.length===0 ? <div className="muted small">No playlists yet. Create one to organize your collection.</div>
              : playlists.map(pl=>(
                <button key={pl.id} className="playlist-item" onClick={()=>{setActivePlaylistId(pl.id); setView('playlists')}}>
                  <span className="playlist-cover-mini">♫</span> {pl.name} <span className="muted small" style={{marginLeft:'auto'}}>{pl.tracks.length}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="sidebar-block mood-block">
            <h3>Quick moods</h3>
            <div className="mood-pills">
              {['chill','lofi','phonk','indie','edm','jazz','sad','workout'].map(m=>(
                <button key={m} onClick={()=>{ setQuery(m); setSource('all'); setTimeout(()=>doSearch(),0); setView('search')}}>{m}</button>
              ))}
            </div>
          </div>

          <div className="sidebar-foot">
            <div className="foot-card">
              <strong>ZenMusic v1 — free & open</strong>
              <p>We don't host music. We stream from public libraries & official embeds: Audius (artist uploads), Internet Archive (public domain/CC), Jamendo (CC), iTunes previews, and YouTube via official IFrame API.</p>
              <p className="muted small">Inspired by <a href="https://github.com/kushagrasinghx/BitChord" target="_blank" rel="noopener">BitChord</a> • <a href="https://github.com/akshay-k-a-dev/Cantio" target="_blank" rel="noopener">Cantio</a> • <a href="https://github.com/rootscripts/riff" target="_blank" rel="noopener">Riff</a></p>
            </div>
            <div className="foot-links">
              <button onClick={()=>document.getElementById('sourceDialog')?.showModal()}>Disclaimer & API</button>
              <a href="https://vercel.com/new" target="_blank" rel="noopener">Deploy to Vercel ↗</a>
            </div>
          </div>
        </aside>

        <main className="main">
          {/* DISCOVER */}
          <section className={`view ${view==='discover'?'active':''}`} id="view-discover">
            <div className="hero">
              <div className="hero-copy">
                <div className="eyebrow"><span className="dot"></span> LESS NOISE. MORE MUSIC. — NO ADS EVER</div>
                <h1>Listen <em>freely.</em><br/><span>No limits, no ads.</span></h1>
                <p>One player for everything. Audius for full free tracks, Archive for rare gems, YouTube for hits via official embed — BitChord for the web.</p>
                <div className="hero-actions">
                  <button className="primary-btn" onClick={()=> trending[0] && playTrack(trending[0])}><span>▶</span> Play Trending</button>
                  <button className="secondary-btn" onClick={()=>{ setQueue(trending.slice(0,10)); if(trending[0]) playTrack(trending[Math.floor(Math.random()*trending.length)]) }}>🔀 Shuffle Discover</button>
                </div>
                <div className="hero-meta">
                  <span><strong>{trending.length || '∞'}</strong> tracks ready</span>
                  <span><strong>5</strong> sources</span>
                  <span><strong>0</strong> ads</span>
                  <span className="live-dot"><i></i> live</span>
                </div>
                <div className="trust-row"><span>✓ No login</span><span>✓ No tracking</span><span>✓ PWA ready</span><span>✓ Vercel-ready</span></div>
              </div>
              <div className="hero-art">
                <div className="stack">
                  <div className="stack-card c1"><img alt="" src={heroTrack?.artwork || 'https://picsum.photos/seed/zenhero1/400/400'} /><div className="card-meta"><strong>{heroTrack?.title || '—'}</strong><span>{heroTrack?.artist || '—'}</span></div></div>
                  <div className="stack-card c2"><img alt="" src={heroSecond?.artwork || 'https://picsum.photos/seed/zenhero2/400/400'} /><div className="card-meta"><strong>{heroSecond?.title || '—'}</strong><span>{heroSecond?.artist || '—'}</span></div></div>
                  <div className="stack-card c3"><div className="vinyl"><div className="vinyl-hole"></div></div><div className="stack-label"><span>NOW PLAYING</span><strong>{current?.title || 'Pick a song to start'}</strong></div></div>
                </div>
                <div className="hero-equalizer"><i></i><i></i><i></i><i></i><i></i></div>
              </div>
            </div>

            <div className="section">
              <div className="section-head">
                <h2><span className="h-icon">🔥</span> Trending — Audius</h2>
                <div className="head-actions">
                  <span className="muted small">direct from Audius • free full tracks</span>
                  <button className="text-btn" onClick={async()=>{
                    const t = await trendingAudius(18).catch(()=>MOCK_TRACKS.slice(0,6))
                    setTrending(t)
                  }}>↻ Refresh</button>
                </div>
              </div>
              <div className="card-grid">
                {trending.map(track=>(
                  <div key={track.id} className={`track-card ${current?.id===track.id?'selected':''}`} onClick={()=>playTrack(track)}>
                    <div className="card-art">
                      <img alt="" src={track.artwork || `https://picsum.photos/seed/${track.id}/400/400`} loading="lazy" onError={e=>e.target.style.display='none'} />
                      <div className="play-overlay"><span>▶</span></div>
                    </div>
                    <div className="card-actions">
                      <button onClick={e=>{e.stopPropagation(); toggleLike(track)}} className={isLiked(track.id)?'liked':''}>♡</button>
                      <button onClick={e=>{e.stopPropagation(); setQueue(q=>[...q, track]); toast('Added to queue')}}>＋</button>
                    </div>
                    <div className="card-body">
                      <div className="card-title">{track.title}</div>
                      <div className="card-artist">{track.artist}</div>
                      <div className="card-source"><span className="source-badge">{track.source}</span><span className="muted small">{track.durationText}</span></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="section">
              <div className="section-head"><h2><span className="h-icon">✦</span> Pick your mood</h2></div>
              <div className="mood-grid">
                {[
                  {q:'lofi chill beats', emoji:'🌙', title:'Chill Lofi', sub:'for focus'},
                  {q:'indie pop', emoji:'◐', title:'Indie Pop', sub:'light & happy'},
                  {q:'phonk drift', emoji:'🏁', title:'Phonk', sub:'midnight drive'},
                  {q:'jazz bossa nova', emoji:'🎷', title:'Jazz Night', sub:'warm'},
                ].map(m=>(
                  <button key={m.q} className="mood-card" onClick={()=>{ setQuery(m.q); setSource('all'); setTimeout(()=>{ document.querySelector('.search-center form')?.requestSubmit() },0)}}><span className="mood-emoji">{m.emoji}</span><strong>{m.title}</strong><span>{m.sub}</span></button>
                ))}
              </div>
            </div>

            <div className="two-col">
              <div className="section">
                <div className="section-head"><h3>Recently played</h3><button className="text-btn" onClick={()=>setView('history')}>View all</button></div>
                <div className="mini-list">
                  {history.slice(0,5).map(t=>(
                    <div key={t.id} className="mini-row" onClick={()=>playTrack(t)} style={{cursor:'pointer'}}>
                      <img alt="" src={t.artwork || 'https://picsum.photos/seed/mini1/100/100'} />
                      <div><strong>{t.title}</strong><br/><span>{t.artist}</span></div>
                      <span className="source-badge" style={{marginLeft:'auto'}}>{t.source}</span>
                    </div>
                  ))}
                  {history.length===0 && <div className="empty small">No history yet. Play something!</div>}
                </div>
              </div>
              <div className="section">
                <div className="section-head"><h3>Archive Gems — rare & legal</h3><span className="muted small">78rpm • netlabels • live</span></div>
                <div className="mini-list">
                  {archiveGems.map(t=>(
                    <div key={t.id} className="mini-row" onClick={()=>playTrack(t)} style={{cursor:'pointer'}}>
                      <img alt="" src={t.artwork || 'https://picsum.photos/seed/mini2/100/100'} />
                      <div><strong>{t.title}</strong><br/><span>{t.artist}</span></div>
                      <button className="mini-btn" onClick={e=>{e.stopPropagation(); playTrack(t)}}>▶</button>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="section">
              <div className="section-head"><h2>Why ZenMusic?</h2></div>
              <div className="feature-grid">
                <div className="feature"><h4>BitChord for Web</h4><p>Apple-Music-inspired glassmorphism, buttery motion, and artwork-driven theming — no install needed.</p></div>
                <div className="feature"><h4>5 Sources, 1 Queue</h4><p>Audius, Archive, Jamendo, iTunes preview, YouTube official embed. Switch sources anytime, queue keeps playing.</p></div>
                <div className="feature"><h4>Vercel Ready</h4><p>1-click deploy. Serverless proxies for search, lyrics, and streams keep CORS clean & keys safe.</p></div>
                <div className="feature"><h4>Own your data</h4><p>Favorites, playlists, history live in your browser. Export/import JSON. Zero tracking.</p></div>
              </div>
            </div>
          </section>

          {/* SEARCH */}
          <section className={`view ${view==='search'?'active':''}`} id="view-search">
            <div className="search-head">
              <h2>Search results</h2>
              <p className="muted">Type above and hit Enter. Try “tulus”, “hindia”, “lofi”, or “travis”.</p>
              {searchResults.length>0 && <div className="search-stats">{searchResults.length} tracks • source: {source}</div>}
            </div>
            {searchLoading && <div className="loading"><span className="spinner"></span> Searching across sources…</div>}
            <div className="track-list">
              {searchResults.map((track, idx)=>(
                <div key={track.id} className={`track-row ${current?.id===track.id?'active':''}`}>
                  <span className="track-index">{idx+1}</span>
                  <button className="play-mini" onClick={()=>playTrack(track)}>{current?.id===track.id && isPlaying ? '❚❚' : '▶'}</button>
                  <img alt="" src={track.artwork || 'https://picsum.photos/seed/search/100/100'} />
                  <div className="track-main">
                    <div className="track-title">{track.title}</div>
                    <div className="track-artist">{track.artist} • <span className="source-badge">{track.source}</span></div>
                  </div>
                  <div className="track-meta">
                    <span className="track-duration">{track.durationText}</span>
                    <div className="track-actions">
                      <button className={isLiked(track.id)?'liked':''} onClick={()=>toggleLike(track)}>♡</button>
                      <button onClick={()=>{ setQueue(q=>[...q, track]); toast('Added to queue')}}>＋</button>
                      <button onClick={()=>{
                        const pl = playlists[0]
                        if (!pl) { document.getElementById('playlistDialog')?.showModal(); return }
                        // quick add to first playlist
                        addToPlaylist(pl.id, track)
                      }}>▭</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {!searchLoading && searchResults.length===0 && query && <div className="empty"><div className="empty-art">⌕</div><h3>No results</h3><p>Try another keyword or switch source.</p></div>}
            {!searchResults.length && !query && <div className="empty"><p>Start typing to search across Audius, YouTube, Archive, and more.</p></div>}
          </section>

          {/* QUEUE */}
          <section className={`view ${view==='queue'?'active':''}`} id="view-queue">
            <div className="section-head"><h2>Queue</h2><div className="head-actions"><button className="secondary-btn small" onClick={()=>setQueue(q=>[...q].sort(()=>Math.random()-0.5))}>🔀 Shuffle</button><button className="secondary-btn small" onClick={()=>setQueue([])}>🗑 Clear</button></div></div>
            <div className="track-list">
              {queue.map((t, idx)=>(
                <div key={t.id} className={`track-row ${current?.id===t.id?'active':''}`}>
                  <span className="track-index">{idx+1}</span>
                  <button className="play-mini" onClick={()=>playTrack(t, false)}>▶</button>
                  <img alt="" src={t.artwork || 'https://picsum.photos/seed/q/100/100'} />
                  <div className="track-main"><div className="track-title">{t.title}</div><div className="track-artist">{t.artist}</div></div>
                  <div className="track-meta">
                    <button className="text-btn" onClick={()=>setQueue(q=>q.filter(x=>x.id!==t.id))}>remove</button>
                  </div>
                </div>
              ))}
            </div>
            {queue.length===0 && <div className="empty"><p>Queue empty. Search and tap ＋ or ▶ to add.</p></div>}
          </section>

          {/* FAVORITES */}
          <section className={`view ${view==='favorites'?'active':''}`} id="view-favorites">
            <div className="section-head"><h2>Favorites</h2><span className="muted small">{favorites.length} tracks</span></div>
            <div className="track-list">
              {favorites.map(t=>(
                <div key={t.id} className="track-row">
                  <span className="track-index">♥</span>
                  <button className="play-mini" onClick={()=>playTrack(t)}>▶</button>
                  <img alt="" src={t.artwork || 'https://picsum.photos/seed/f/100/100'} />
                  <div className="track-main"><div className="track-title">{t.title}</div><div className="track-artist">{t.artist}</div></div>
                  <div className="track-actions"><button onClick={()=>toggleLike(t)}>✕</button><button onClick={()=>{ setQueue(q=>[...q, t]); toast('Added to queue')}}>＋</button></div>
                </div>
              ))}
            </div>
            {favorites.length===0 && <div className="empty"><div className="empty-art">♡</div><h3>No favorites yet</h3><p>Tap ♥ on any track or player.</p></div>}
          </section>

          {/* PLAYLISTS */}
          <section className={`view ${view==='playlists'?'active':''}`} id="view-playlists">
            <div className="section-head"><h2>Playlists</h2><button className="primary-btn small" onClick={()=>document.getElementById('playlistDialog')?.showModal()}>＋ New playlist</button></div>
            {!activePlaylist ? (
              <div className="playlist-grid">
                {playlists.map(pl=>(
                  <div key={pl.id} className="playlist-tile" onClick={()=>setActivePlaylistId(pl.id)}>
                    <div className="playlist-cover">♫</div>
                    <strong>{pl.name}</strong>
                    <span className="muted small">{pl.tracks.length} tracks • {new Date(pl.createdAt).toLocaleDateString()}</span>
                  </div>
                ))}
                {playlists.length===0 && <div className="empty">No playlists. Create your first collection.</div>}
              </div>
            ) : (
              <div>
                <button className="text-btn" onClick={()=>setActivePlaylistId(null)}>‹ Back</button>
                <div className="playlist-header">
                  <div className="playlist-cover">{activePlaylist.name[0].toUpperCase()}</div>
                  <div>
                    <h3>{activePlaylist.name}</h3>
                    <p className="muted small">{activePlaylist.tracks.length} tracks</p>
                    <div className="playlist-actions">
                      <button className="primary-btn small" onClick={()=>{ if(activePlaylist.tracks[0]) playTrack(activePlaylist.tracks[0]); setQueue(activePlaylist.tracks) }}>▶ Play all</button>
                      <button className="secondary-btn small" onClick={()=>{ const shuffled=[...activePlaylist.tracks].sort(()=>Math.random()-0.5); setQueue(shuffled); if(shuffled[0]) playTrack(shuffled[0]) }}>🔀 Shuffle</button>
                      <button className="danger-btn small" onClick={()=>{ if(confirm('Delete playlist?')){ setPlaylists(p=>p.filter(x=>x.id!==activePlaylist.id)); setActivePlaylistId(null)}}}>Delete</button>
                    </div>
                  </div>
                </div>
                <div className="track-list" style={{marginTop:12}}>
                  {activePlaylist.tracks.map(t=>(
                    <div key={t.id} className="track-row">
                      <button className="play-mini" onClick={()=>playTrack(t)}>▶</button>
                      <img alt="" src={t.artwork || 'https://picsum.photos/seed/p/100/100'} />
                      <div className="track-main"><div className="track-title">{t.title}</div><div className="track-artist">{t.artist}</div></div>
                      <button className="text-btn" onClick={()=>removeFromPlaylist(activePlaylist.id, t.id)}>remove</button>
                    </div>
                  ))}
                  {activePlaylist.tracks.length===0 && <div className="empty small">Empty playlist. Add tracks from Search.</div>}
                </div>
              </div>
            )}
          </section>

          {/* HISTORY */}
          <section className={`view ${view==='history'?'active':''}`} id="view-history">
            <div className="section-head"><h2>History</h2><button className="secondary-btn small" onClick={()=>setHistory([])}>Clear</button></div>
            <div className="track-list">
              {history.map(t=>(
                <div key={t.id+'h'} className="track-row">
                  <button className="play-mini" onClick={()=>playTrack(t)}>▶</button>
                  <img alt="" src={t.artwork || 'https://picsum.photos/seed/h/100/100'} />
                  <div className="track-main"><div className="track-title">{t.title}</div><div className="track-artist">{t.artist}</div></div>
                  <span className="source-badge">{t.source}</span>
                </div>
              ))}
              {history.length===0 && <div className="empty">No history yet.</div>}
            </div>
          </section>
        </main>

        <aside className="right-panel">
          <div className="panel-card queue-card">
            <div className="panel-head"><h3>Next up</h3><button className="mini-btn" onClick={()=>setView('queue')}>open</button></div>
            <div className="mini-list">
              {queue.slice(0,6).map(t=>(
                <div key={t.id} className="mini-row" onClick={()=>playTrack(t)} style={{cursor:'pointer'}}>
                  <img alt="" src={t.artwork || 'https://picsum.photos/seed/next/100/100'} />
                  <div><strong>{t.title}</strong><br/><span>{t.artist}</span></div>
                </div>
              ))}
              {queue.length===0 && <div className="muted small">Queue empty.</div>}
            </div>
          </div>
          <div className="panel-card now-card">
            <img alt="" src={current?.artwork || 'https://picsum.photos/seed/now/400/400'} />
            <div className="now-meta">
              <strong>{current?.title || '—'}</strong>
              <span>{current?.artist || 'Pick a song'}</span>
              <span className="source-badge">{current?.source || '—'}</span>
            </div>
          </div>
          <div className="panel-card lyrics-card">
            <div className="panel-head"><h3>Lyrics</h3><button className="text-btn" onClick={()=>setShowFs(true)}>fullscreen</button></div>
            <div className="lyrics-mini" style={{whiteSpace:'pre-wrap'}}>{lyrics?.plainLyrics || lyrics?.syncedLyrics || 'No lyrics. Lyrics auto-fetch from lrclib.net when available.'}</div>
          </div>
        </aside>
      </div>

      <footer className="player" id="playerBar">
        <div className="progress-wrap">
          <div className="progress-track" id="progressTrack">
            <div className="progress-fill" style={{width: `${progress/10}%`}}></div>
            <div className="progress-handle" style={{left: `calc(${progress/10}% )`}}></div>
          </div>
          <input type="range" min="0" max="1000" value={progress} onChange={e=>{
            const v = Number(e.target.value)
            setProgress(v)
            const seek = duration ? (v/1000)*duration : 0
            if (current?.source==='youtube') ytPlayerRef.current?.seekTo(seek, true)
            else if (audioRef.current) audioRef.current.currentTime = seek
          }} aria-label="Seek" />
          <div className="progress-time">
            <span>{fmt(duration>0? currentTime:0)}</span>
            <span>{fmt(duration)}</span>
          </div>
        </div>

        <div className="player-main">
          <div className="player-left">
            <button className="player-art-wrap" onClick={()=>setShowFs(true)} aria-label="Open fullscreen">
              <img alt="" src={current?.artwork || ''} onError={e=>e.target.style.display='none'} />
              <span className="art-fallback">♫</span>
            </button>
            <div className="player-meta">
              <strong>{current?.title || 'No song'}</strong>
              <span>{current?.artist || 'Pick from Discover or Search'}</span>
            </div>
            <button className={`icon-btn like ${current && isLiked(current.id)?'active':''}`} onClick={()=> current && toggleLike(current)}>♡</button>
          </div>

          <div className="player-center">
            <div className="controls">
              <button className={`control-btn ${shuffle?'active':''}`} onClick={()=>setShuffle(s=>!s)} title="Shuffle">🔀</button>
              <button className="control-btn" onClick={handlePrev}>⏮</button>
              <button className="play-btn" onClick={togglePlay}><span>{isPlaying?'❚❚':'▶'}</span></button>
              <button className="control-btn" onClick={handleNext}>⏭</button>
              <button className={`control-btn ${repeat!=='off'?'active':''}`} onClick={()=>setRepeat(r=> r==='off'?'all': r==='all'?'one':'off')} title="Repeat">↻</button>
            </div>
          </div>

          <div className="player-right">
            <button className="icon-btn" onClick={()=>setView('queue')}>≡ <span className="badge">{queue.length}</span></button>
            <div className="volume">
              <button className="icon-btn" onClick={()=>{
                const audio = audioRef.current
                if (!audio) return
                const nv = volume>0?0:85
                setVolume(nv)
              }}>🔊</button>
              <input type="range" min="0" max="100" value={volume} onChange={e=>setVolume(Number(e.target.value))} />
            </div>
            <button className="icon-btn" onClick={()=>setShowFs(true)}>⛶</button>
          </div>
        </div>

        <div id="ytWrap" hidden><div id="ytPlayer"></div></div>
        <audio ref={audioRef} preload="metadata" crossOrigin="anonymous" />
      </footer>

      {showFs && (
        <dialog open className="fullscreen" onClick={e=>{ if(e.target===e.currentTarget) setShowFs(false)}}>
          <div className="fs-bg"></div>
          <div className="fs-content">
            <div className="fs-top"><span className="fs-eyebrow">NOW PLAYING • {current?.source || '—'}</span><button className="icon-btn" onClick={()=>setShowFs(false)}>✕</button></div>
            <div className="fs-main">
              <div className="fs-art-wrap"><img alt="" src={current?.artwork || 'https://picsum.photos/seed/fs/800/800'} /><div className="fs-vinyl"></div></div>
              <div className="fs-info">
                <h2>{current?.title || 'No song'}</h2>
                <p>{current?.artist || '—'}</p>
                <div className="fs-lyrics" style={{whiteSpace:'pre-wrap'}}>{lyrics?.plainLyrics || lyrics?.syncedLyrics || 'Lyrics will appear here if available from lrclib.net.'}</div>
                <div className="fs-controls">
                  <button className="control-btn" onClick={handlePrev}>⏮</button>
                  <button className="play-btn large" onClick={togglePlay}><span>{isPlaying?'❚❚':'▶'}</span></button>
                  <button className="control-btn" onClick={handleNext}>⏭</button>
                  <button className={`icon-btn like ${current && isLiked(current.id)?'active':''}`} onClick={()=> current && toggleLike(current)}>♡</button>
                </div>
                <div className="fs-progress"><span>{fmt(currentTime)}</span><input type="range" min="0" max="1000" value={progress} onChange={e=>{
                  const v=Number(e.target.value)
                  setProgress(v)
                  const seek = duration ? (v/1000)*duration : 0
                  if (current?.source==='youtube') ytPlayerRef.current?.seekTo(seek,true)
                  else if (audioRef.current) audioRef.current.currentTime = seek
                }} /><span>{fmt(duration)}</span></div>
              </div>
            </div>
          </div>
        </dialog>
      )}

      {/* dialogs */}
      <dialog id="playlistDialog" className="modal">
        <form method="dialog" onSubmit={e=>{
          e.preventDefault()
          const fd = new FormData(e.target)
          const name = e.target.playlistName.value
          createPlaylist(name)
          e.target.reset()
          e.target.closest('dialog')?.close()
        }}>
          <h3>Create new playlist</h3>
          <p className="muted small">Store your favorite collections locally in this browser.</p>
          <label>Playlist name
            <input name="playlistName" type="text" placeholder="e.g. Rainy Nights" required maxLength="40" />
          </label>
          <div className="modal-actions">
            <button type="button" className="secondary-btn" onClick={()=>document.getElementById('playlistDialog')?.close()}>Cancel</button>
            <button type="submit" className="primary-btn">Create</button>
          </div>
        </form>
      </dialog>

      <dialog id="sourceDialog" className="modal">
        <div>
          <h3>How ZenMusic is free — sources & disclaimer</h3>
          <div className="source-info">
            <p><strong>Audius</strong> — open music platform where artists upload directly. Full tracks free via discovery nodes. <em>Keyless</em>.</p>
            <p><strong>Internet Archive</strong> — 4M+ public-domain/CC recordings: netlabels, live concerts, 78rpm. Keyless.</p>
            <p><strong>Jamendo</strong> — 600k+ Creative Commons tracks. Requires free <code>client_id</code> from developer.jamendo.com. Set <code>VITE_JAMENDO_CLIENT_ID</code> in Vercel env.</p>
            <p><strong>iTunes Search</strong> — 30s previews, no key, great for discovery.</p>
            <p><strong>YouTube</strong> — popular hits via <strong>official YouTube IFrame Player API</strong> (compliant embed, respects ToS). Search via Piped public API so no API key needed. We never host or re-encode audio.</p>
          </div>
          <p className="muted small" style={{marginTop:8}}>Disclaimer: ZenMusic does not host a catalog. It plays public libraries & official embeds. Ensure your use respects each track's license. Inspired by BitChord (Android) & Cantio (web).</p>
          <div className="modal-actions"><button className="primary-btn" onClick={()=>document.getElementById('sourceDialog')?.close()}>Got it</button></div>
          <details className="small muted" style={{marginTop:10}}><summary>Vercel env</summary><code>VITE_JAMENDO_CLIENT_ID=xxx<br/>VITE_AUDIUS_HOST=https://discoveryprovider.audius.co</code></details>
        </div>
      </dialog>

      <div id="toast" className="toast" hidden role="status" aria-live="polite"></div>
    </>
  )
}

function fmt(s) {
  if (!s || isNaN(s)) return '0:00'
  const m = Math.floor(s/60)
  const sec = Math.floor(s%60)
  return `${m}:${String(sec).padStart(2,'0')}`
}
