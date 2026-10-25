import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Playing what was asked for on Spotify: "play Blinding Lights", "play some
 * Daft Punk", "play the album Random Access Memories".
 *
 * Spotify's own scripting can play a spotify: link but cannot search. The
 * link comes from Spotify's search API when a free developer key is in
 * ~/Library/Application Support/Yonna/spotify.json ({"clientId", "clientSecret"}
 * from developer.spotify.com); without one, from a web search restricted to
 * open.spotify.com, which those sites sometimes refuse. If nothing is found,
 * Spotify opens on its own search page instead.
 */

const osa = (script) =>
  new Promise((resolve) => execFile('/usr/bin/osascript', ['-e', script], (err, out) => resolve(err ? null : String(out).trim())))
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

let token = null

/** An app token from Spotify, with the key in spotify.json; null without one. */
async function apiToken() {
  if (token && token.until > Date.now()) return token.value
  let key
  try {
    key = JSON.parse(readFileSync(join(homedir(), 'Library/Application Support/Yonna/spotify.json'), 'utf8'))
  } catch {
    return null
  }
  if (!key?.clientId || !key?.clientSecret) return null
  try {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${key.clientId}:${key.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(5000),
    }).then((x) => x.json())
    if (!r.access_token) return null
    token = { value: r.access_token, until: Date.now() + (r.expires_in - 60) * 1000 }
    return token.value
  } catch {
    return null
  }
}

/** What kind of thing was asked for, and the words to search for. */
function parse(query) {
  const kind = /\balbum\b/i.test(query)
    ? 'album'
    : /\b(playlist|mix)\b/i.test(query)
      ? 'playlist'
      : /^(some|something by|music by|songs by|anything by)\b/i.test(query)
        ? 'artist'
        : 'track'
  const q = query
    .replace(/^(some|something by|music by|songs by|anything by|the (album|playlist|song))\s+/i, '')
    .replace(/\b(the )?(album|playlist)\b/i, '')
    .trim()
  return { kind, q }
}

async function fromApi(kind, q) {
  const t = await apiToken()
  if (!t) return null
  try {
    const r = await fetch(`https://api.spotify.com/v1/search?${new URLSearchParams({ q, type: kind, limit: '1' })}`, {
      headers: { Authorization: `Bearer ${t}` },
      signal: AbortSignal.timeout(5000),
    }).then((x) => x.json())
    return r?.[`${kind}s`]?.items?.find(Boolean)?.uri ?? null
  } catch {
    return null
  }
}

async function fromWeb(kind, q) {
  const site = kind === 'track' ? 'open.spotify.com' : `open.spotify.com/${kind}`
  const query = encodeURIComponent(`site:${site} ${q}`)
  // Two search engines, in case one is busy or asks if we are a robot.
  for (const url of [`https://search.brave.com/search?q=${query}`, `https://html.duckduckgo.com/html/?q=${query}`]) {
    try {
      const html = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15' },
        signal: AbortSignal.timeout(4000),
      }).then((r) => r.text())
      const m = html.match(/open\.spotify\.com(?:\/intl-[a-z]+)?\/(track|album|playlist|artist)\/([A-Za-z0-9]{22})/)
      if (m) return `spotify:${m[1]}:${m[2]}`
    } catch {
      /* try the next */
    }
  }
  return null
}

/** The Spotify link for a song, album, playlist or artist, or null. */
export async function findOnSpotify(query) {
  const { kind, q } = parse(query)
  return (await fromApi(kind, q)) ?? (await fromWeb(kind, q))
}

/* ------------------------------------------------------------ your library */

let userTok = null
let library = null // { at, me, playlists: [{ name, uri }] }
const LIBRARY_MS = 10 * 60_000

/** A token for your own account, from the sign-in scripts/spotify-login.mjs
 *  saved; null if you have not signed in. */
async function userToken() {
  if (userTok && userTok.until > Date.now()) return userTok.value
  let key
  try {
    key = JSON.parse(readFileSync(join(homedir(), 'Library/Application Support/Yonna/spotify.json'), 'utf8'))
  } catch {
    return null
  }
  if (!key?.refreshToken) return null
  try {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${key.clientId}:${key.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: key.refreshToken }),
      signal: AbortSignal.timeout(5000),
    }).then((x) => x.json())
    if (!r.access_token) return null
    userTok = { value: r.access_token, until: Date.now() + (r.expires_in - 60) * 1000 }
    return userTok.value
  } catch {
    return null
  }
}

/** Your playlists (made or followed), fetched at most every ten minutes. */
export async function myLibrary() {
  if (library && Date.now() - library.at < LIBRARY_MS) return library
  const t = await userToken()
  if (!t) return null
  // A refused request (Spotify limits how often it may be asked) throws, so
  // it is never mistaken for "no playlists" and remembered as such.
  const get = (u) =>
    fetch(u, { headers: { Authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(6000) }).then((x) => {
      if (!x.ok) throw new Error(`Spotify ${x.status}`)
      return x.json()
    })
  try {
    const me = await get('https://api.spotify.com/v1/me')
    const playlists = []
    for (let u = 'https://api.spotify.com/v1/me/playlists?limit=20'; u && playlists.length < 1000; ) {
      let page = await get(u)
      // Spotify sometimes answers with a count but an empty page: ask once
      // more, and if it is still empty, give up rather than believe it.
      if (page.total > 0 && !page.items?.length) {
        await pause(500)
        page = await get(u)
        if (!page.items?.length) throw new Error('Spotify: empty page')
      }
      for (const p of page.items ?? []) if (p?.uri) playlists.push({ name: p.name, uri: p.uri })
      u = page.next
    }
    if (!me?.id) throw new Error('Spotify: no account')
    library = { at: Date.now(), me: me.id, playlists }
    return library
  } catch {
    // Whatever was known before, kept as it was (and asked again next time).
    return library
  }
}

/** Letters and digits only, no accents, no filler — so a spoken name meets
 *  the written one ("my chill vibes playlist" → "chill vibes"). */
const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(my|the|playlist|on spotify|from my library|songs?)\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/** Your playlist with this name, if there is one that plainly matches. */
export function matchPlaylist(lib, said) {
  const want = norm(said)
  if (!want || !lib?.playlists.length) return null
  const named = lib.playlists.map((p) => ({ ...p, n: norm(p.name) })).filter((p) => p.n)
  const exact = named.find((p) => p.n === want)
  if (exact) return exact
  // One contains the other: "gym" finds "Gym 2026", "summer hits playlist" finds "Summer Hits".
  const within = want.length < 3 ? [] : named.filter((p) => p.n.length >= 3 && (p.n.includes(want) || want.includes(p.n)))
  if (within.length) return within.sort((a, b) => Math.abs(a.n.length - want.length) - Math.abs(b.n.length - want.length))[0]
  // Most words in common, if most of them are.
  const words = new Set(want.split(' '))
  let best = null
  for (const p of named) {
    const pw = p.n.split(' ')
    const same = pw.filter((w) => words.has(w)).length
    const score = same / Math.max(words.size, pw.length)
    if (score >= 0.6 && (!best || score > best.score)) best = { ...p, score }
  }
  return best
}

/** Spotify sometimes takes the link but stays paused: press play if so. */
async function ensurePlaying() {
  await pause(900)
  if ((await osa('tell application "Spotify" to player state as string')) !== 'playing') {
    await osa('tell application "Spotify" to play')
  }
}

/** Plays it, and says what is now playing. Your own playlists come first: a
 *  name that matches one in your library plays that, not a public one. */
export async function playOnSpotify(query) {
  const q = String(query ?? '').replace(/\s+on spotify$/i, '').trim()
  if (!q) return null
  const liked = /^(?:my )?(?:liked|favou?rite|saved) (?:songs|tracks|music)$/i.test(q)
  const [lib, wasRunning] = await Promise.all([myLibrary(), osa('application "Spotify" is running')])
  const mine = liked ? null : matchPlaylist(lib, q)
  const uri =
    liked && lib?.me
      ? `spotify:user:${lib.me}:collection`
      : (mine?.uri ?? (await findOnSpotify(q)))
  if (wasRunning !== 'true') {
    await osa('tell application "Spotify" to launch')
    await pause(2500)
  }
  if (!uri) {
    await osa(`open location "spotify:search:${q.replace(/["\\]/g, '')}"`)
    return liked
      ? 'Sign Yonna in to Spotify first to play your liked songs — I\'ve opened Spotify instead.'
      : `I couldn't find ${q} straight away, so I've opened the search in Spotify.`
  }
  await osa(`tell application "Spotify" to play track "${uri}"`)
  await ensurePlaying()
  remember(uri, liked ? 'your liked songs' : mine ? `your ${mine.name} playlist` : q)
  if (liked) return 'Playing your liked songs.'
  if (mine) return `Playing your ${mine.name} playlist.`
  await pause(700)
  const now = await osa('tell application "Spotify" to (name of current track) & " by " & (artist of current track)')
  return now ? `Playing ${now}.` : `Playing ${q}.`
}

/* ----------------------------------------------- shuffle and starting over */

const LAST = join(homedir(), 'Library/Application Support/Yonna/spotify-last.json')

/** What she last started, so "this playlist" means something. Kept on disk
 *  so it survives a restart. */
function remember(uri, name) {
  try {
    writeFileSync(LAST, JSON.stringify({ uri, name, at: Date.now() }))
  } catch {
    /* fine */
  }
}
function lastPlayed() {
  try {
    return JSON.parse(readFileSync(LAST, 'utf8'))
  } catch {
    return null
  }
}

/** Shuffle on or off. */
export async function setShuffle(on) {
  await osa(`tell application "Spotify" to set shuffling to ${on ? 'true' : 'false'}`)
  return on ? 'Shuffle on.' : 'Shuffle off — playing in order.'
}

/**
 * A song inside a playlist, album or your liked songs: the first, or one at
 * random. Spotify resumes a playlist where it last was, so "from the start"
 * has to name the first song; and a shuffle should not always open the same way.
 */
async function songIn(uri, which, me) {
  const t = await userToken()
  if (!t) return null
  const [, kind, id] = uri.split(':')
  const base =
    kind === 'playlist'
      ? `https://api.spotify.com/v1/playlists/${id}/items`
      : kind === 'album'
        ? `https://api.spotify.com/v1/albums/${id}/tracks`
        : uri === `spotify:user:${me}:collection`
          ? 'https://api.spotify.com/v1/me/tracks'
          : null
  if (!base) return null
  const get = (offset) =>
    fetch(`${base}?limit=1&offset=${offset}`, { headers: { Authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(5000) })
      .then((x) => x.json())
      .catch(() => null)
  let page = await get(0)
  if (which === 'random' && page?.total > 1) page = await get(Math.floor(Math.random() * page.total))
  const item = page?.items?.[0]
  return (item?.track ?? item?.item ?? item)?.uri ?? null
}

/** Starts a playlist, album or liked songs in order from the first song, or
 *  shuffled from a random one. Anything else just plays. */
async function start(uri, shuffle) {
  await osa(`tell application "Spotify" to set shuffling to ${shuffle ? 'true' : 'false'}`)
  // Spotify takes a moment to switch; starting sooner can begin the old way.
  const [song] = await Promise.all([songIn(uri, shuffle ? 'random' : 'first', (await myLibrary())?.me), pause(800)])
  await osa(
    song
      ? `tell application "Spotify" to play track "${song}" in context "${uri}"`
      : `tell application "Spotify" to play track "${uri}"`,
  )
  await ensurePlaying()
}

/**
 * Play something in order from its first song, or shuffled: "play my gym
 * playlist from the beginning", "shuffle my chill playlist". With no name
 * ("this playlist", "it"), what she last started.
 */
export async function playFrom(query, { shuffle }) {
  const here = !query || /^(?:this|it|that|the|this one|the (?:same )?(?:playlist|album|songs?|music)|this (?:playlist|album|music|songs?))$/i.test(query.trim())
  let last = here ? lastPlayed() : null
  if (!here) {
    // Found the usual way (your playlists first), then started properly.
    const said = await playOnSpotify(query)
    last = lastPlayed()
    if (!said || !last?.uri || /couldn't find|Sign Yonna in/.test(said)) return said
  }
  if (!last?.uri) return shuffle ? setShuffle(true) : "Tell me which playlist — I don't know what's playing."
  await start(last.uri, shuffle)
  return shuffle ? `Shuffling ${last.name}.` : `Playing ${last.name} from the start.`
}

/** Play, pause, next, previous — for her tools. */
export async function spotifyControl(action) {
  const cmd = { play: 'play', pause: 'pause', next: 'next track', previous: 'previous track' }[action]
  if (!cmd) return 'Unknown action.'
  // Past the first few seconds "previous" only restarts the song: start first.
  if (action === 'previous') await osa('tell application "Spotify" to set player position to 0')
  await osa(`tell application "Spotify" to ${cmd}`)
  return 'Done.'
}
