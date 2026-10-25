#!/usr/bin/env node
/**
 * One-time Spotify sign-in, so Yonna can see your own playlists.
 *
 *   node scripts/spotify-login.mjs
 *
 * Opens Spotify's "allow access" page in your browser. After you agree, the
 * page comes back to this script (on 127.0.0.1:8888, the redirect URI set on
 * your Spotify app) and it saves a long-lived sign-in token next to your key
 * in ~/Library/Application Support/Yonna/spotify.json. Read-only: it can list
 * your playlists and liked songs, nothing more.
 */
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

const FILE = join(homedir(), 'Library/Application Support/Yonna/spotify.json')
const REDIRECT = 'http://127.0.0.1:8888/callback'
const SCOPES = 'playlist-read-private playlist-read-collaborative user-library-read'

const key = JSON.parse(readFileSync(FILE, 'utf8'))
if (!key.clientId || !key.clientSecret) {
  console.error('Put your clientId and clientSecret in', FILE, 'first.')
  process.exit(1)
}

const state = Math.random().toString(36).slice(2)
const server = createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT)
  if (url.pathname !== '/callback') return res.writeHead(404).end()
  const code = url.searchParams.get('code')
  if (!code || url.searchParams.get('state') !== state) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Spotify did not allow access. You can close this tab.')
    console.error('Not allowed:', url.searchParams.get('error') ?? 'bad state')
    process.exit(1)
  }
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${key.clientId}:${key.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT }),
  }).then((x) => x.json())
  if (!r.refresh_token) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Sign-in failed. You can close this tab.')
    console.error('Sign-in failed:', r)
    process.exit(1)
  }
  writeFileSync(FILE, JSON.stringify({ ...key, refreshToken: r.refresh_token }, null, 2) + '\n')
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end('<body style="font:16px -apple-system;background:#0a0a0b;color:#ededeb;display:grid;place-items:center;height:90vh">Yonna can see your playlists now. You can close this tab.</body>')
  console.log('Signed in. Saved to', FILE)
  setTimeout(() => process.exit(0), 300)
})

server.listen(8888, '127.0.0.1', () => {
  const auth = `https://accounts.spotify.com/authorize?${new URLSearchParams({
    client_id: key.clientId,
    response_type: 'code',
    redirect_uri: REDIRECT,
    scope: SCOPES,
    state,
  })}`
  console.log('Opening Spotify in your browser…')
  execFile('/usr/bin/open', [auth])
})
setTimeout(() => {
  console.error('Timed out waiting for Spotify (5 minutes).')
  process.exit(1)
}, 5 * 60_000)
