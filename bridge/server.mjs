/**
 * Yonna local bridge.
 *
 * Runs the Claude Agent SDK — Claude Code as a library — and exposes one turn
 * of conversation over a WebSocket. The browser stays the face and the voice;
 * this process is the brain and the hands.
 *
 * Two things this buys over calling the Claude API from the browser:
 *   1. No API key. It authenticates exactly the way `claude` does, off your
 *      existing login, and bills to that same account.
 *   2. Every MCP server in your Claude Code config is available, including the
 *      local stdio ones a browser could never reach — higgsfield, elevenlabs,
 *      android, playwright, palmier-pro and the rest.
 *
 *   node bridge/server.mjs
 */

import { WebSocketServer } from 'ws'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { displayServer } from './panels.mjs'
import { uiServer } from './ui.mjs'
import { chromeAvailable, chromeServer } from './chrome.mjs'
import { visionServer } from './vision.mjs'
import { safariServer } from './safari.mjs'
import { appsServer, quitYonna } from './apps.mjs'
import { agenda, calendarServer } from './calendar.mjs'
import { forgetMemory, loadMemories, memoryPrompt, memoryServer } from './memory.mjs'
import { startIMessage } from './imessage.mjs'
import { filesServer } from './files.mjs'
import { instant } from './instant.mjs'
import { weatherServer } from './weather.mjs'
import { macServer } from './mac.mjs'
import { spawn } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { openRemote, proxyError, vetTarget, PROXY_UA } from './net.mjs'
import { probeUrl, renderPage } from './page.mjs'

const PORT = Number(process.env.YONNA_BRIDGE_PORT ?? 8787)

/**
 * A crash here takes the whole assistant down mid-sentence, and most of what
 * can reject is out of our hands — a socket dying under a write, an upstream
 * fetch aborting. Log it and keep serving; the turn that failed will surface
 * its own error to the browser.
 */
process.on('unhandledRejection', (err) => {
  console.error('[yonna] unhandled rejection:', err)
})

/**
 * Who is allowed to talk to this bridge.
 *
 * A WebSocket handshake is not subject to the same-origin policy: the browser
 * sends it on behalf of whatever page asked, no preflight stands in the way,
 * and the page reads every byte that comes back. Without a check here, any tab
 * the user happens to have open could open a socket to ws://localhost:8787,
 * drive the agent with every MCP server on this machine, and read back every
 * token and panel. The Origin header is the only thing that separates our own
 * dev server from someone else's page, so it is checked explicitly.
 *
 * A missing Origin means a non-browser client — curl, a script, a native app.
 * That is also exactly what local malware looks like, so it is refused on the
 * socket unless YONNA_ALLOW_NO_ORIGIN=1 says otherwise.
 */
const EXTRA_ORIGINS = new Set(
  (process.env.YONNA_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
)
const ALLOW_NO_ORIGIN = process.env.YONNA_ALLOW_NO_ORIGIN === '1'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Vite takes the next free port when 5173 is busy and `vite preview` starts at
 * 4173, so the dev ranges are allowed rather than two exact numbers. Anything
 * else — including localhost on a port some other app is serving — has to be
 * named in YONNA_ALLOWED_ORIGINS.
 */
const isDevPort = (port) =>
  (port >= 5173 && port <= 5199) || (port >= 4173 && port <= 4199)

function originAllowed(origin) {
  if (!origin) return ALLOW_NO_ORIGIN
  if (EXTRA_ORIGINS.has(origin.replace(/\/+$/, ''))) return true
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:') return false
  if (!LOCAL_HOSTS.has(url.hostname)) return false
  return isDevPort(Number(url.port))
}

/**
 * Voice is a bad interface for a confirmation dialog: there is no window to
 * click and the model can't pause for one. So the bridge decides.
 *
 * Read-only and generative tools run freely. Anything that writes to disk,
 * runs a shell, or changes the world waits for YONNA_ALLOW_WRITES=1. Start
 * without it, and turn it on once you trust what you're demoing.
 */
const ALLOW_WRITES = process.env.YONNA_ALLOW_WRITES === '1'

/**
 * The orchestrator model. Override with YONNA_MODEL to trade quality for pace
 * — claude-sonnet-5 is noticeably snappier on camera if Opus feels slow.
 */
const MODEL = process.env.YONNA_MODEL ?? 'claude-opus-5'

/**
 * How hard the model thinks before answering.
 *
 * This was 'low', on the reasoning that a voice assistant is judged on latency
 * — and that is true right up until the answer is thin. Low effort scopes the
 * work tightly to what was literally asked: fewer tool calls, less
 * cross-referencing, no second look. On a model of this tier that is leaving
 * most of it on the table.
 *
 * 'medium' is the compromise worth having here. It reasons and reaches for
 * tools noticeably more than 'low' while still answering inside the window a
 * spoken conversation tolerates. Raise it to 'high' or 'xhigh' when quality
 * matters more than pace; drop back to 'low' when filming and every second of
 * dead air shows.
 */
// 'low', as Atticus runs: replies were the priority, and on a voice turn the
// difference in quality is small while the difference in pace is not.
const EFFORT = process.env.YONNA_EFFORT ?? 'low'

/**
 * Both spellings of every renamed built-in are listed on purpose. The SDK
 * presents several tools to the model under newer names — Task is Agent,
 * BashOutput is TaskOutput, KillShell is TaskStop, and the MCP resource tools
 * gained a "Tool" suffix — so a set holding only the old names never matches
 * and the tool falls through to the write branch, which is the opposite of
 * what these lists mean. Keep both until the old names are certainly gone.
 */
const READ_ONLY_BUILTINS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite',
  'Task', 'Agent', 'ToolSearch',
  'ListMcpResources', 'ListMcpResourcesTool',
  'ReadMcpResource', 'ReadMcpResourceTool',
  'BashOutput', 'TaskOutput',
])
const WRITE_BUILTINS = new Set([
  'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'KillShell', 'TaskStop',
])

/**
 * Every MCP server Claude Code has configured, read out of its own config.
 *
 * This does two jobs. The HUD wants the names while the boot animation plays,
 * and the agent doesn't emit its init message — and therefore its server
 * list — until the first user message flows through, which is far too late.
 * More importantly, this bridge turns filesystem settings off (see
 * settingSources below) and the SDK stops discovering these servers on its
 * own, so handing them over explicitly is what keeps the local stdio ones —
 * the whole reason the bridge exists — in play.
 *
 * Only the global block and the home-directory project scope, because
 * homedir() is our cwd. That makes the list a close but not exact match for
 * the agent's own: the 'ready' sent on connect comes from here and the second
 * one, sent from the init message a turn later, carries live status. Expect
 * the two to differ, and treat the later one as authoritative.
 */
function configuredServers() {
  try {
    const cfg = JSON.parse(
      readFileSync(join(homedir(), '.claude.json'), 'utf8'),
    )
    return {
      ...(cfg.mcpServers ?? {}),
      // Servers scoped to the home directory apply too, since that's our cwd.
      ...(cfg.projects?.[homedir()]?.mcpServers ?? {}),
    }
  } catch {
    return {}
  }
}

const MCP_SERVERS = configuredServers()

/** MCP tools arrive as `mcp__<server>__<tool>`. */
const mcpServerOf = (toolName) =>
  toolName.startsWith('mcp__') ? toolName.split('__')[1] : null

/** The tool half, which can itself contain underscores: `mcp__x__a__b` -> `a__b`. */
const mcpToolOf = (toolName) => toolName.split('__').slice(2).join('__')

/**
 * MCP policy, and why it is shaped this way.
 *
 * A short list of "servers that can change things" is the wrong default,
 * because it is a list of what we happened to think of. Every server not on it
 * runs unconditionally — and on a real machine that quietly includes placing a
 * phone call, spending an advertising budget, deleting a generated character
 * and writing files to disk. A voice assistant cannot ask "are you sure", so
 * the bridge has to be the one that is sure.
 *
 * So the default is deny, softened in two ways so the demo stays usable:
 *
 *   1. READ_ONLY_MCP is an explicit allowlist of servers whose whole surface is
 *      lookups and generation — search, registries, analytics reads. Anything
 *      there runs in read-only mode.
 *   2. Everywhere else, the tool has to argue for itself: its own name must
 *      begin with a read verb. `list_devices` runs; `install_apk` does not.
 *
 * On top of both sits a veto: a name containing a plainly effectful verb needs
 * ALLOW_WRITES no matter which server it came from, which is what keeps
 * `make_outbound_call` and `download_lottie` still until you ask for them.
 */
const READ_ONLY_MCP = new Set([
  'exa', 'exa-code', 'serper', 'serpapi', 'lottie-search', 'mcp-registry',
  'openrouter', 'openrouter-image', 'Microsoft_Clarity',
  // The generation servers belong here too, and leaving them out was a real
  // regression: `generate_image` begins with no read verb, so it fell to the
  // deny branch and "generate an image of the Mark VII suit" — the headline
  // demo — stopped working in the default mode.
  //
  // Putting them on the allowlist is safe because the veto below still applies
  // to allowlisted servers: it is what continues to withhold
  // make_outbound_call, delete_character, create_* and edit_image. Generation
  // runs; acting on the world does not.
  'higgsfield', 'heygen', 'elevenlabs',
])

/**
 * Anchored on the tool name, so it reads the verb rather than the noun.
 * `screenshot` is in here because it is a read that doesn't sound like one,
 * and the persona is told in as many words to put screenshots on the display.
 */
const READ_VERB =
  /^(get|list|read|search|find|query|fetch|check|describe|inspect|show|view|explain|screenshot)/i

/**
 * Unanchored on purpose — `make_outbound_call` and `Bulk-Edit-Events` both
 * hide their verb in the middle. `download` is here because it writes a file
 * even though it sounds like a read.
 */
const EFFECTFUL_VERB =
  /(send|call|post|create|delete|remove|update|edit|write|install|launch|tap|swipe|press|type|buy|pay|charge|publish|deploy|outbound|download)/i

/**
 * Tools whose names trip the veto without deserving it.
 *
 * The veto reads verbs out of names, which is the right instinct and
 * occasionally the wrong answer. `openrouter send-message` sends a prompt to a
 * language model and gets text back — nothing in the world changes — but it is
 * indistinguishable by name from sending mail. Asking a second model a question
 * is one of the better things this assistant can do, so it is named here
 * instead of being lost to a regex.
 *
 * Full `server__tool` keys, so an exemption can never leak across servers.
 */
const VETO_EXEMPT = new Set([
  'openrouter__send-message',
  'openrouter__send-feedback',
])

function decideTool(name) {
  if (READ_ONLY_BUILTINS.has(name)) return true
  if (WRITE_BUILTINS.has(name)) return ALLOW_WRITES

  const server = mcpServerOf(name)
  if (server) {
    // The HUD, and the interface controls beside it. Both run in this process
    // and draw on our own screen, so neither is something to withhold —
    // without them Yonna has no display at all. They also have to be named
    // here rather than left to the verb rules below, which read `ui_theme` as
    // a write and would hold the whole surface back behind ALLOW_WRITES.
    if (server === 'yonna' || server === 'yonna_ui') return true

    // The browser server gates itself, at construction: chromeServer() only
    // builds the acting tools — click, type, form input, close tab — when
    // ALLOW_WRITES is set, so anything that reaches here at all is something
    // the same policy has already permitted. Deciding it a second time by
    // reading verbs out of the name would only get it wrong: `chrome_navigate`
    // begins with no read verb and would fall to the write branch, which would
    // withhold the one tool the whole server is for.
    if (server === 'yonna_chrome') return true

    // The camera. Not withheld behind ALLOW_WRITES: looking changes nothing,
    // and the real gate is the browser's own camera permission plus an
    // indicator the user can see for as long as it is live.
    if (server === 'yonna_eyes') return true

    // Opens a search or a page in Safari for the user to watch. It can do
    // nothing else — see safari.mjs — so, like the display, it is not held
    // back behind ALLOW_WRITES.
    if (server === 'yonna_safari') return true

    // Launches an installed app the user named, and nothing else — see
    // apps.mjs. Asked for in so many words, so not held behind ALLOW_WRITES.
    if (server === 'yonna_apps') return true

    // The user's own calendar, reminders and Yonna's memory file — asked for
    // explicitly. Deletions are confirmed out loud first; see the prompt.
    if (server === 'yonna_calendar' || server === 'yonna_memory') return true

    // Creating files and folders the user asked for. Create-only: it cannot
    // delete, and refuses to replace a file without an explicit overwrite —
    // see files.mjs for the places it will not touch.
    if (server === 'yonna_files') return true

    // Reading a weather forecast changes nothing.
    if (server === 'yonna_weather') return true

    // Spotify, clearing files to the Trash (never a real delete), and email or
    // iMessage drafts left unsent — see mac.mjs. Asked for in so many words.
    if (server === 'yonna_mac') return true

    const tool = mcpToolOf(name)
    if (EFFECTFUL_VERB.test(tool) && !VETO_EXEMPT.has(`${server}__${tool}`)) {
      return ALLOW_WRITES
    }
    // The session tools this bridge is developed inside count as read-only too.
    if (READ_ONLY_MCP.has(server) || server.startsWith('ccd_session')) return true
    return READ_VERB.test(tool) ? true : ALLOW_WRITES
  }
  return ALLOW_WRITES
}

const SYSTEM_PROMPT = `You are Yonna (said "YON-na"), a woman, speaking out loud to one person. If
you refer to yourself it is as Yonna, she/her. You were once called Yonna;
never call yourself that.

How you talk:
- Like a smart, warm friend sitting next to them — relaxed, natural, a bit of
  personality. Not a butler, not a customer-service bot. Never say "sir" or
  "madam", never use formal stock phrases ("Very good", "Shall I", "I'm
  afraid", "Certainly"). Use contractions: "it's", "you'll", "that's".
- Short, the way people actually talk: one short sentence, two at the very
  most. Every word is spoken aloud while they wait. Never read out an email,
  message, document or page — say in one sentence what it is about, and only
  if they asked.
- Answer straight away, naturally: "It's twenty-four degrees and sunny." not
  "The temperature today is twenty-four degrees Celsius." Skip units and
  details nobody needs out loud.
- Light humour is fine when it fits; never forced. You can have a bit of an
  opinion when asked. No exclamation-mark enthusiasm, no fake excitement.
- If something didn't work or you can't do it, just say it plainly and
  simply ("That didn't work — Spotify isn't installed."). No apologising
  speeches.
- Plain spoken words only: no markdown, lists, emoji or asterisks. Numbers,
  dates and times as you'd say them ("eight fifteen", "the first of August").
- Never narrate tool use ("Let me search", "I'll take a look", "One sec") —
  just do it, then answer. Never read out a path, URL, ID or JSON; no sources
  or links. If you don't know, say so.

Doing things on the Mac (yonna_mac):
- Music: spotify_play plays a song, artist, album or one of their own
  playlists (theirs first); shuffle and from_start as asked. spotify_control
  for play, pause, next, previous, shuffle on and off. Then just say what is
  playing, in a few words.
- Clearing files: list_files (or find_screenshots for screenshots) to find
  them, then move_to_trash. Things go to
  the Trash, never deleted for good. If it is clear what they meant ("delete
  the screenshots on my desktop"), just do it and say how many; if not, ask
  in one short question first.
- Writing for them: an email reply → draft_email; a text → draft_imessage.
  You write it, they send it — you never send anything yourself. Write it in
  their voice, short. Afterwards say only that it is ready to check and send;
  do not read the draft aloud.

Showing things — blades:
- Anything visual they asked for goes on a blade: \`blade\` opens a page,
  image, video or gallery; \`display\` composes your own markup. Blades stack
  and can be moved, resized and read in place. Never read a blade aloud.
- Use \`probe_url\` when unsure what a URL is. Articles open in reader mode;
  use the live page when layout matters (dashboards, tables, charts).
- A browser tab is not a way of showing something: bring it back as a blade.
- \`ui_*\` tools change the interface; use them only when it means something,
  put it back after, and never mention it.

Their screen (asked by holding the fn shortcut):
- A message ending "[Screen: …]" comes with a screenshot of their screen as
  it was when they pressed the keys. A red ring marks where the mouse pointer
  was. If they drew a loop with the mouse, it is drawn in red and a close-up
  of what is inside it is attached too — that is what "this", "that" or
  "here" means. Answer about what is actually there; read the text in it.
- Only use the screenshot when the question is about the screen or what they
  point at; otherwise just answer the question.

Their browser:
- For any web page, account or login, use the \`chrome_*\` tools first: their
  own signed-in Chrome. It is your hands, not your display — show results on a
  blade. Never use playwright or other browser automation. Read a page before
  acting on it. Before sending, buying, deleting or posting, say what you are
  about to do; afterwards, what happened.

Your eyes (\`look\` = one frame; \`watch\` = several seconds as a grid):
- Two cameras: "face" (default, built-in, at them) and "desk" (the Logitech
  aimed at their desk). "What am I holding / what is this" → face; anything
  about the desk or table → desk. If the face camera shows nothing in their
  hands, try the desk once.
- Only look when asked. Each look is a fresh picture: identify from scratch.
  Read printed names, chip markings, connectors, resistor bands, wire colours
  and breadboard rows; say plainly when something is too small or blurry, and
  ask them to bring it closer.
- "Look at my desk", "open the desk camera": open the camera blade
  (\`camera: "desk"\`, \`hold: "sticky"\`, size "wide", title "DESK"), say only
  "Desk camera's on." — no \`look\`, no description. Wait for a
  question. Looking with the blade closed reopens it; closing it turns the
  camera off.
- Answer exactly what was asked; never tour everything on the desk.
- Guiding any hands-on task ("how do I…", "help me…", "what next"): look at
  the desk first, but do not list what you see; mention only what is missing
  or wrong. Then ONE short, exact step: the pin as printed ("digital pin 13",
  "GND next to it"), the breadboard row, the LED's long leg, the part and
  value, the wire colour — or for anything else, which part, which side,
  which hole. Then wait.
- On "done" / "next" / "is this right": look again and check that step
  against the picture. Say plainly if it's right; if not, what's wrong and
  how to fix it, and don't move on. Never claim to see what the picture does
  not show.
- One short safety word when it matters (a resistor with an LED, nothing from
  5V straight to GND, unplug before rewiring, hot irons, drinks near
  electronics). \`watch\` past seconds only works while the camera blade is
  open. Never take a picture they did not ask for.`


/**
 * Whether the user's Chrome can be driven. Learned once at startup (see the
 * banner below); the prompt is built per connection from it.
 */
let chromeReady = false

/**
 * Said instead of the Chrome section when the extension is not there.
 *
 * The base prompt orders every web task through the chrome_* tools first. With
 * no extension that order sends him to a tool that cannot work — so "what's in
 * the news today" spent the turn failing at Chrome and came back with nothing.
 */
const NO_CHROME = `The user's Chrome cannot be driven on this machine: there are no chrome_*
tools. Do not mention Chrome or try to reach it.`

const WEB_SECTION = `Looking things up:
- Weather, temperature, rain, wind, what to wear → the \`weather\` tool, always
  (no place = where they are), then just say it. Never search the web for
  weather, and never open the Weather app unless they ask for the app.
- Anything else current or uncertain (news, prices, scores, people): search
  with WebSearch, read with WebFetch. Never answer it from memory.
- Search quietly, not in Safari. Show what you found with \`display\` and say
  the gist in a sentence or two.
- Safari only when they ask for Safari, or to BUY something: then open the
  best real shop page with \`safari_open\` (or \`safari_search\`), no blade, and
  say where in one sentence with the price if seen.`

const CALC_SECTION = `Calculations: show them with \`display\` — the expression small, the result
large: <div><span class="hud-unit">17 × 23 + 4</span><span class="hud-metric">395</span></div>
— and say only the answer. Work it out exactly.`

const APPS_SECTION = `Apps: \`open_app\`, \`close_app\`, \`close_all_apps\` (never closes you). Act,
then report in a few words. Several matches: pick the obvious one or ask once.`

const CALENDAR_SECTION = `Calendar and reminders:
- A day's agenda → \`calendar_events\` (+ \`reminders_list\` for that range):
  read it briefly in time order and show it as rows on a blade.
- "Remind me to…" → \`reminder_create\`; meetings and plans →
  \`calendar_create_event\`. Exact local times from the [Local time] stamp;
  confirm with the day and time in one sentence.
- To change or delete, list first for the id. Deleting: name it and ask
  "Shall I delete it?" first.`

const IMESSAGE_SECTION = `A message starting "[iMessage]" was texted from their phone: reply in up to
four short plain sentences (digits for times and numbers), not on a blade,
and ask "Reply yes to confirm." before anything that sends, deletes or
changes something. Do not open apps or change the screen for a text.`

const FILES_SECTION = `Files: \`create_folder\` / \`create_file\` (paths may start with ~; default the
Desktop; reveal: true). If it exists, ask "Shall I replace it?" and only then
pass overwrite: true. Confirm where in one sentence. You cannot delete files.`

const LIVE_SECTION = `Live panels: the time in another city → \`clock\` with its IANA zone and the
city as label; local time → \`clock\` with no zone. A countdown →
\`countdown\`; a stopwatch → \`stopwatch\`; stopping → \`countdown_cancel\`.
Always say the exact answer first in one sentence (work it out from the
[Local time] stamp), then call the tool and write nothing after it.`

const TIMING_SECTION = `Speak first, show second: when you already know the answer, write the
spoken sentence before calling \`display\`; only look-ups come first. Say it
once — never repeat or reword it after a tool.`

const LANGUAGE_SECTION = `Always answer in English. They often type in Greek: understand it exactly
and just answer, in English, without commenting on the language.`


function systemPrompt() {
  let prompt = SYSTEM_PROMPT
  if (!chromeReady) {
    prompt = prompt.replace(/Their browser:[\s\S]*?(?=\nYour eyes )/, NO_CHROME + '\n')
  }
  return [prompt, TIMING_SECTION, LIVE_SECTION, LANGUAGE_SECTION, WEB_SECTION, CALC_SECTION, APPS_SECTION, CALENDAR_SECTION, FILES_SECTION, IMESSAGE_SECTION, memoryPrompt()].join('\n\n')
}

/**
 * ElevenLabs credentials, borrowed from the MCP server config.
 *
 * If you've set up the elevenlabs MCP server, the key is already on this
 * machine — no reason to make you paste it into a second .env file. The browser
 * never sees it: it POSTs text to /tts here and gets audio back.
 */
function elevenKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY
  try {
    const cfg = JSON.parse(
      readFileSync(join(homedir(), '.claude.json'), 'utf8'),
    )
    return cfg.mcpServers?.elevenlabs?.env?.ELEVENLABS_API_KEY ?? null
  } catch {
    return null
  }
}

const VOICE_ID = process.env.YONNA_VOICE_ID ?? 'JBFqnCBsd6RMkjVDRZzb'

/**
 * Where /file is permitted to read from, and how big a read may get.
 *
 * The roots are realpath'd once at boot so the containment check below compares
 * like with like — on macOS os.tmpdir() is a symlink into /private/var, and a
 * string prefix test against the unresolved form would reject every screenshot.
 */
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  // .svg is deliberately absent. An SVG is a scriptable document, and this
  // endpoint serves it from the bridge's own origin — the one origin allowed
  // to open the agent socket. A picture is not worth that.
}

const MAX_FILE_BYTES = 25 * 1024 * 1024

const FILE_ROOTS = [
  homedir(),
  // Both temp directories, because on macOS os.tmpdir() is the per-user
  // $TMPDIR under /var/folders while half the tools that take a screenshot
  // still write it to /tmp. Dropping one of them loses real panels.
  tmpdir(),
  '/tmp',
  ...(process.env.YONNA_FILE_ROOTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
].map((root) => {
  try {
    return realpathSync(root)
  } catch {
    return resolvePath(root)
  }
})

/** True when `real` sits inside one of the roots, after both are resolved. */
const withinRoots = (real) =>
  FILE_ROOTS.some((root) => {
    const rel = relative(root, real)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  })

// ---------------------------------------------------------------------------

/**
 * Remote media, fetched by the bridge instead of by the page.
 *
 * Yonna used to refuse to show anything he found on the web, and the refusal
 * was not squeamishness — a bare <img src="https://some-cdn/..."> in a panel
 * genuinely did not work. Three reasons, and all three are fixed by moving the
 * fetch to this side of the wire:
 *
 *   1. Hotlink blocking. News sites and image CDNs check Referer and User-Agent
 *      and hand a browser-that-isn't-their-page a 403 or a placeholder. That is
 *      why thumbnails rendered as empty rectangles. A server-side fetch that
 *      looks like an ordinary browser and sends no referrer gets the bytes.
 *   2. Privacy. Panel HTML is authored by a model that has just been reading
 *      untrusted web pages, so a remote URL in it is a prompt-injection beacon:
 *      load it directly and the user's IP, and the fact they asked, go to a host
 *      the page chose. Proxying means the browser only ever talks to localhost
 *      and the page CSP can stay tight.
 *   3. One place to cap size, set timeouts and insist the bytes really are the
 *      media type they claim.
 *
 * The cost is that this process — unlike a browser tab — can reach the user's
 * LAN, their router's admin page, and cloud metadata endpoints. So everything
 * below is an SSRF gate first and a proxy second.
 */

const MAX_IMG_BYTES = 15 * 1024 * 1024
const MAX_MEDIA_BYTES = 200 * 1024 * 1024
const IMG_TIMEOUT_MS = 10_000
const MEDIA_TIMEOUT_MS = 30_000

// The SSRF gate and the guarded outbound clients now live in ./net.mjs, so the
// media proxy below and the page proxy share one implementation of the rules
// rather than two that can drift apart.

/**
 * The shared body of /img and /media.
 *
 * `kinds` is the list of content-type prefixes we are willing to hand back.
 * That check is load-bearing: without it this is an open proxy that will serve
 * an attacker's HTML from the bridge's own origin — the one origin allowed to
 * open the agent socket — which is the same reason IMAGE_TYPES has no .svg.
 */
async function proxyRemote(req, res, cors, { kinds, maxBytes, timeoutMs, ranged }) {
  const asked = new URL(req.url, 'http://x').searchParams.get('url') ?? ''
  const target = vetTarget(asked)

  const headers = {
    'user-agent': PROXY_UA,
    accept: ranged ? '*/*' : 'image/*,*/*;q=0.8',
    // Identity encoding so the byte cap counts the bytes we actually stream and
    // content-length means what it says. Media is already compressed anyway.
    'accept-encoding': 'identity',
  }
  // Range is the difference between a <video> that seeks and one Safari refuses
  // to play at all, so the browser's request is passed through verbatim.
  if (ranged && typeof req.headers.range === 'string') {
    headers.range = req.headers.range
  }

  const { res: upstream } = await openRemote(target, headers, timeoutMs)
  const status = upstream.statusCode ?? 0

  if (status !== 200 && status !== 206) {
    upstream.resume()
    throw proxyError(status === 404 ? 404 : 502, `upstream said ${status}`)
  }

  const type = String(upstream.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (!kinds.some((kind) => type.startsWith(kind))) {
    upstream.resume()
    throw proxyError(415, `not ${kinds.join(' or ')} (got ${type || 'nothing'})`)
  }

  const declared = Number(upstream.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    upstream.resume()
    throw proxyError(413, 'too large')
  }

  const out = {
    ...cors,
    'content-type': type,
    'x-content-type-options': 'nosniff',
    // Thumbnails get looked at, panelled again, and re-rendered on every HUD
    // repaint; re-fetching from the CDN each time is slow and rude.
    'cache-control': 'private, max-age=600',
  }
  if (Number.isFinite(declared)) out['content-length'] = String(declared)
  if (ranged) {
    // Only claim range support when the origin actually demonstrated it — a
    // 206, or an explicit accept-ranges of its own. Plenty of hosts ignore the
    // Range header and hand back the whole file with a 200; advertising
    // accept-ranges on top of that tells the video element it may seek by
    // issuing byte requests that will never be honoured, and the scrub bar
    // then misbehaves in a way that looks like our bug rather than theirs.
    if (status === 206 || upstream.headers['accept-ranges'] === 'bytes') {
      out['accept-ranges'] = 'bytes'
    }
    if (upstream.headers['content-range']) {
      out['content-range'] = upstream.headers['content-range']
    }
  }
  res.writeHead(status, out)

  // Stream with a running cap. Buffering a 200 MB video into this process
  // would stall the token stream the voice is riding on, and trusting
  // content-length would let a host that lies about it eat the heap.
  let sent = 0
  upstream.on('data', (chunk) => {
    sent += chunk.length
    if (sent > maxBytes) {
      // Headers went out long ago, so a truncated body is the only way left to
      // say no. The player sees a short read; we see this line in the log.
      console.warn(`[yonna] proxy cut ${target.href} at ${maxBytes} bytes`)
      upstream.destroy()
      res.destroy()
      return
    }
    if (!res.write(chunk)) {
      upstream.pause()
      res.once('drain', () => upstream.resume())
    }
  })
  upstream.on('end', () => res.end())
  upstream.on('error', () => res.destroy())
  req.on('close', () => upstream.destroy())
}

// ---------------------------------------------------------------------------

/**
 * CORS, reflected rather than wildcarded.
 *
 * `*` on this origin means any page on the internet can read whatever the
 * bridge serves, so the same allowlist that guards the socket picks the
 * header. A request carrying an Origin we don't know is refused outright —
 * but a request with no Origin at all is served, because an <img src> load
 * (which is how panels fetch screenshots) never sends one.
 */
function corsFor(req) {
  const origin = req.headers.origin
  const headers = { vary: 'origin' }
  if (origin) {
    headers['access-control-allow-origin'] = origin
    headers['access-control-allow-headers'] = 'content-type'
  }
  return headers
}

// One HTTP server for both the speech proxy and the WebSocket upgrade.
const http = await import('node:http')

const handleRequest = async (req, res) => {
  const origin = req.headers.origin
  if (origin && !originAllowed(origin)) {
    console.warn(`[yonna] refused http request from origin ${origin}`)
    res.writeHead(403, { vary: 'origin' })
    return res.end('forbidden')
  }
  const cors = corsFor(req)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    return res.end()
  }

  // Today's calendar and reminders, for the agenda box in the corner.
  if (req.method === 'GET' && req.url === '/agenda') {
    const data = await agenda().catch((err) => ({ ok: false, error: String(err?.message ?? err) }))
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(JSON.stringify(data))
  }

  // The settings panel: what she remembers, and whether Spotify is set up.
  if (req.method === 'GET' && req.url === '/settings') {
    let spotify = {}
    try {
      spotify = JSON.parse(readFileSync(join(homedir(), 'Library/Application Support/Yonna/spotify.json'), 'utf8'))
    } catch {
      /* not set up */
    }
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(
      JSON.stringify({
        memory: loadMemories().map(({ id, fact }) => ({ id, fact })),
        spotify: { key: Boolean(spotify.clientId && spotify.clientSecret), signedIn: Boolean(spotify.refreshToken) },
      }),
    )
  }
  if (req.method === 'POST' && req.url === '/memory/forget') {
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 1024) break
    }
    let id = ''
    try {
      id = String(JSON.parse(body || '{}').id ?? '')
    } catch {
      /* nothing to forget */
    }
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: forgetMemory(id) }))
  }

  // The welcome screen: what is set up, and the Allow buttons. See Welcome.tsx.
  if (req.method === 'GET' && req.url === '/setup') {
    const support = join(homedir(), 'Library/Application Support/Yonna')
    const json = (f) => {
      try {
        return JSON.parse(readFileSync(join(support, f), 'utf8'))
      } catch {
        return null
      }
    }
    const keys = json('keys-status.json')
    const msgs = json('messages/status.json')
    const spot = json('spotify.json')
    const cal = await agenda().catch(() => ({ ok: false }))
    const state = (v) => (v === 'allowed' ? 'allowed' : v === 'not asked yet' ? 'ask' : v ? 'denied' : 'ask')
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(
      JSON.stringify({
        keys: keys
          ? { microphone: state(keys.microphone), speech: state(keys.speechRecognition), screen: state(keys.screenRecording) }
          : null,
        calendar: cal?.ok ? 'allowed' : 'ask',
        messages: msgs ? (msgs.ok ? 'allowed' : /phone number/.test(msgs.error ?? '') ? 'off' : 'ask') : 'off',
        spotify: spot?.refreshToken ? 'allowed' : 'ask',
      }),
    )
  }
  if (req.method === 'POST' && req.url === '/setup/do') {
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 1024) break
    }
    let what = ''
    try {
      what = String(JSON.parse(body || '{}').what ?? '')
    } catch {
      /* nothing */
    }
    const support = join(homedir(), 'Library/Application Support/Yonna')
    const open = (...args) => spawn('/usr/bin/open', args, { stdio: 'ignore', detached: true }).unref()
    const pane = (name) => open(`x-apple.systempreferences:com.apple.preference.security?${name}`)
    switch (what) {
      // The shortcut helper asks for the Microphone and Speech Recognition
      // itself when it starts; started (again) here so it does.
      case 'keys':
        open('-g', join(support, 'Yonna Keys.app'))
        break
      case 'keys-settings':
        pane('Privacy_Microphone')
        break
      case 'screen':
        open('-R', join(support, 'Yonna Keys.app'))
        pane('Privacy_ScreenCapture')
        break
      // Asking the calendar is what makes its helper show macOS's prompt; the
      // settings page only if it is still refused after that.
      case 'calendar': {
        const r = await agenda().catch(() => null)
        if (!r?.ok) pane('Privacy_Calendars')
        break
      }
      case 'messages':
        open('-R', join(support, 'Yonna Messages.app'))
        pane('Privacy_AllFiles')
        break
      case 'spotify':
        spawn(process.execPath, [join(process.cwd(), 'scripts/spotify-login.mjs')], { stdio: 'ignore', detached: true }).unref()
        break
    }
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end('{"ok":true}')
  }

  // Her voice: the Mac's own, through `say` — the Siri voice set in Spoken
  // Content, as Atticus speaks. Browsers cannot use Siri voices, so the
  // window sends each sentence here; the answer comes back when it has been
  // said. /say/stop cuts her off.
  if (req.method === 'POST' && req.url === '/say') {
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 8192) break
    }
    let text = ''
    try {
      text = String(JSON.parse(body || '{}').text ?? '').slice(0, 4000)
    } catch {
      /* nothing to say */
    }
    const ok = text.trim() ? await sayAloud(text) : false
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok }))
  }
  if (req.method === 'POST' && req.url === '/say/stop') {
    for (const p of saying) p.kill()
    saying.clear()
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end('{"ok":true}')
  }

  // Instant commands: simple things done with no AI. See instant.mjs.
  if (req.method === 'POST' && req.url === '/instant') {
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 4096) break
    }
    let text = ''
    try {
      text = String(JSON.parse(body || '{}').text ?? '')
    } catch {
      /* not JSON: nothing to do */
    }
    const out = await instant(text).catch((err) => {
      console.warn(`[yonna] instant failed: ${err?.message ?? err}`)
      return { handled: false }
    })
    if (out.handled) console.log(`[yonna] instant: "${text.slice(0, 60)}" -> ${out.say || '(done)'}`)
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(JSON.stringify(out))
  }

  if (req.method === 'GET' && req.url === '/health') {
    // The browser reads this once at boot to decide which voice engine to use.
    // Both premium paths ride the same ElevenLabs key, so both flags track it:
    // with a key the app transcribes with Scribe and speaks with ElevenLabs;
    // without one it falls back to the browser's own recogniser and voice, so a
    // student with nothing configured still has a working assistant.
    const eleven = Boolean(elevenKey())
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    // `windows` lets the desktop launcher tell a live Yonna window from a
    // leftover background Chrome with nothing in it.
    return res.end(JSON.stringify({ ok: true, tts: eleven, stt: eleven, windows: windowCount }))
  }

  // Serve local image files to the page. Screenshots and generated art land on
  // disk as absolute paths, and a page served over http can't read file:// —
  // so the bridge, which can, hands them over.
  if (req.method === 'GET' && req.url?.startsWith('/file?')) {
    const asked = new URL(req.url, 'http://x').searchParams.get('path') ?? ''
    // Resolve symlinks BEFORE judging anything. A name ending in .png can be a
    // link pointing at /etc/hosts, and checking the suffix the caller supplied
    // would wave that straight through — which is exactly how this endpoint
    // used to serve the contents of arbitrary system files.
    let real = null
    try {
      if (isAbsolute(asked)) real = await realpath(asked)
    } catch {
      real = null
    }
    const dot = real ? real.lastIndexOf('.') : -1
    const ext = dot === -1 ? '' : real.slice(dot).toLowerCase()
    // Images only, absolute paths only, and only under roots we expect things
    // to be written to. This endpoint exists to show pictures, not to be a
    // general file read for whatever the model — or another page — asks for.
    if (!real || !Object.hasOwn(IMAGE_TYPES, ext) || !withinRoots(real)) {
      res.writeHead(400, cors)
      return res.end('images only')
    }
    try {
      const info = await stat(real)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) {
        res.writeHead(413, cors)
        return res.end('too large')
      }
      // Asynchronous because this process is also pumping the agent's token
      // stream; a synchronous read of a large screenshot stalls the voice.
      const body = await readFile(real)
      res.writeHead(200, {
        ...cors,
        'content-type': IMAGE_TYPES[ext],
        'x-content-type-options': 'nosniff',
      })
      return res.end(body)
    } catch {
      res.writeHead(404, cors)
      return res.end('not found')
    }
  }

  // Remote images, fetched here so the page never talks to the wider web. The
  // renderer rewrites every http(s) <img src> in a panel to this endpoint.
  if (req.method === 'GET' && req.url?.startsWith('/img?')) {
    try {
      await proxyRemote(req, res, cors, {
        kinds: ['image/'],
        maxBytes: MAX_IMG_BYTES,
        timeoutMs: IMG_TIMEOUT_MS,
        ranged: false,
      })
    } catch (err) {
      if (res.headersSent) return res.destroy()
      res.writeHead(err.status ?? 502, cors)
      return res.end(err.message ?? 'proxy failed')
    }
    return
  }

  // The same, for video and audio. Separate from /img because the limits and
  // the Range handling are genuinely different, not because the code is.
  if (req.method === 'GET' && req.url?.startsWith('/media?')) {
    try {
      await proxyRemote(req, res, cors, {
        kinds: ['video/', 'audio/'],
        maxBytes: MAX_MEDIA_BYTES,
        timeoutMs: MEDIA_TIMEOUT_MS,
        ranged: true,
      })
    } catch (err) {
      if (res.headersSent) return res.destroy()
      res.writeHead(err.status ?? 502, cors)
      return res.end(err.message ?? 'proxy failed')
    }
    return
  }

  // A whole web page, fetched here and served from this origin so it can be
  // framed. The publisher's X-Frame-Options and CORS rules are enforced against
  // the browser, and from the browser's point of view this document is ours —
  // so an article that refuses to be embedded anywhere still opens on the
  // display. See page.mjs for what each mode does to the markup.
  //
  // No Origin header arrives on an iframe navigation, so this rides the same
  // path as an <img> load through the check at the top of this handler.
  if (req.method === 'GET' && req.url?.startsWith('/page?')) {
    const asked = new URL(req.url, 'http://x')
    const target = asked.searchParams.get('url') ?? ''
    const mode = asked.searchParams.get('mode') === 'live' ? 'live' : 'reader'
    try {
      const page = await renderPage(target, mode, `http://localhost:${PORT}`)
      res.writeHead(200, { ...cors, ...page.headers })
      return res.end(page.body)
    } catch (err) {
      // Rendered as a page rather than returned as a status, because this lands
      // inside an iframe: a bare 502 body is a blank rectangle on the display,
      // which reads as the interface being broken rather than as the article
      // being unavailable.
      res.writeHead(err.status ?? 502, {
        ...cors,
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      })
      return res.end(
        `<!doctype html><meta charset="utf-8"><style>
           body{margin:0;padding:26px;background:transparent;color:#7fb6bf;
                font:400 13px/1.6 ui-monospace,monospace}
           b{color:#cfe9ee;font-weight:500;display:block;margin-bottom:6px}
         </style><b>This page could not be opened.</b>${
           String(err?.message ?? 'unknown error').replace(/[<&]/g, '')
         }`,
      )
    }
  }

  if (req.method === 'POST' && req.url === '/tts') {
    const key = elevenKey()
    if (!key) {
      res.writeHead(503, cors)
      return res.end('no elevenlabs key')
    }
    // A spoken line is a few hundred bytes. Anything approaching this is not a
    // sentence, and buffering it unbounded would let one request eat the heap.
    let body = ''
    let overflowed = false
    for await (const chunk of req) {
      body += chunk
      if (body.length > 64 * 1024) {
        overflowed = true
        break
      }
    }
    if (overflowed) {
      req.destroy()
      res.writeHead(400, cors)
      return res.end('body too large')
    }
    // Inside a try: this handler is async with nothing catching its rejection,
    // so a malformed body used to take the entire bridge down with it.
    let text
    try {
      ;({ text } = JSON.parse(body || '{}'))
    } catch {
      res.writeHead(400, cors)
      return res.end('bad json')
    }
    if (!text) {
      res.writeHead(400, cors)
      return res.end('no text')
    }
    try {
      const upstream = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream` +
          // 22kHz mono is half the bytes of 44kHz and indistinguishable through
          // a laptop speaker; optimize_streaming_latency=3 trades a little
          // prosody for a much earlier first byte.
          `?output_format=mp3_22050_32&optimize_streaming_latency=3`,
        {
          method: 'POST',
          headers: { 'xi-api-key': key, 'content-type': 'application/json' },
          body: JSON.stringify({
            text,
            // Flash is the low-latency model — a conversation needs speed more
            // than it needs the last few percent of quality.
            model_id: 'eleven_flash_v2_5',
            voice_settings: {
              stability: 0.4,
              similarity_boost: 0.75,
              speed: 1.05,
            },
          }),
        },
      )
      if (!upstream.ok) {
        res.writeHead(upstream.status, cors)
        return res.end(await upstream.text())
      }

      // Pipe it through rather than buffering. Waiting for the whole file here
      // would throw away everything the streaming endpoint just bought us.
      res.writeHead(200, {
        ...cors,
        'content-type': 'audio/mpeg',
        'cache-control': 'no-cache',
      })
      for await (const chunk of upstream.body) res.write(Buffer.from(chunk))
      return res.end()
    } catch (err) {
      res.writeHead(502, cors)
      return res.end(String(err?.message ?? err))
    }
  }

  // Speech to text. The browser captures one spoken segment as a compressed
  // audio blob and posts the raw bytes here; the bridge hands them to
  // ElevenLabs Scribe and returns the transcript. This is what replaced the
  // browser's own SpeechRecognition — that API dies silently under always-on
  // use, and a server-side transcriber cannot. Detecting that the user is
  // speaking at all is done locally with voice-activity detection, which never
  // touches this endpoint; this is only for the words.
  if (req.method === 'POST' && req.url === '/stt') {
    const key = elevenKey()
    if (!key) {
      res.writeHead(503, cors)
      return res.end('no elevenlabs key')
    }

    const type = req.headers['content-type'] || 'audio/webm'
    const chunks = []
    let size = 0
    let overflowed = false
    // A few seconds of Opus is well under a megabyte; 25 MB is a generous
    // ceiling that still refuses a runaway stream before it eats the heap.
    for await (const chunk of req) {
      chunks.push(chunk)
      size += chunk.length
      if (size > 25 * 1024 * 1024) {
        overflowed = true
        break
      }
    }
    if (overflowed) {
      req.destroy()
      res.writeHead(413, cors)
      return res.end('audio too large')
    }
    // Silence, or a click. Nothing to transcribe, and calling out to the API
    // for it would only add latency to a non-answer.
    if (size < 1200) {
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ text: '' }))
    }

    try {
      // The filename extension is the only hint Scribe gets about the codec, so
      // derive it from the content-type the MediaRecorder reported rather than
      // hard-coding one.
      const ext = type.includes('ogg')
        ? 'ogg'
        : type.includes('mp4') || type.includes('mpeg')
          ? 'mp4'
          : type.includes('wav')
            ? 'wav'
            : 'webm'
      const form = new FormData()
      form.append('model_id', 'scribe_v1')
      form.append(
        'file',
        new Blob([Buffer.concat(chunks)], { type }),
        `speech.${ext}`,
      )

      const upstream = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST',
        headers: { 'xi-api-key': key },
        body: form,
      })
      if (!upstream.ok) {
        res.writeHead(upstream.status, cors)
        return res.end(await upstream.text())
      }
      const data = await upstream.json()
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ text: (data.text ?? '').trim() }))
    } catch (err) {
      res.writeHead(502, cors)
      return res.end(String(err?.message ?? err))
    }
  }

  res.writeHead(404, cors)
  res.end()
}

const server = http.createServer((req, res) => {
  // The handler is async, so anything it throws would otherwise become an
  // unhandled rejection and leave the browser waiting on a socket that is
  // never going to answer.
  handleRequest(req, res).catch((err) => {
    console.error('[yonna] request failed:', err)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})

const wss = new WebSocketServer({
  server,
  // The handshake is the only place a page can be turned away, so it happens
  // here rather than after the socket is open. Rejections are logged loudly:
  // the likeliest cause is a dev server on an unexpected port, and a silent
  // 403 would look like the bridge simply isn't running.
  verifyClient: ({ origin, req }, done) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path !== '/' && path !== '/ws') {
      console.warn(`[yonna] rejected websocket on path ${path}`)
      return done(false, 403, 'Forbidden')
    }
    if (!originAllowed(origin)) {
      console.warn(
        `[yonna] rejected websocket from origin ${origin ?? '(none)'}` +
          ' — set YONNA_ALLOWED_ORIGINS to permit it',
      )
      return done(false, 403, 'Forbidden')
    }
    done(true)
  },
})
server.listen(PORT)
// Texting Yonna from the user's phone. Does nothing unless configured.
// YONNA_NO_IMESSAGE=1 for a second, test bridge: two bridges watching the
// same inbox would both answer every message.
if (process.env.YONNA_NO_IMESSAGE !== '1') startIMessage(PORT)

console.log(`[yonna] bridge listening on ws://localhost:${PORT}`)
console.log(
  `[yonna] speech ${elevenKey() ? 'via ElevenLabs (key from MCP config)' : 'using browser fallback voice'}`,
)
console.log(`[yonna] model ${MODEL} · effort ${EFFORT}`)
/** What the HUD's model switch may choose between. */
const MODELS = {
  opus: MODEL,
  sonnet: process.env.YONNA_FAST_MODEL ?? 'claude-sonnet-5-5',
}

/** The switch's choice, kept on disk so the shortcut box uses it too and it
 *  survives a restart. Sonnet unless Opus was chosen. */
const BRAIN_FILE = join(homedir(), 'Library/Application Support/Yonna/brain.json')
function chosenBrain() {
  try {
    return JSON.parse(readFileSync(BRAIN_FILE, 'utf8')).brain === 'opus' ? 'opus' : 'sonnet'
  } catch {
    return 'sonnet'
  }
}
function chooseBrain(brain) {
  try {
    writeFileSync(BRAIN_FILE, JSON.stringify({ brain }))
  } catch {
    /* fine */
  }
}
console.log(
  `[yonna] writes ${ALLOW_WRITES ? 'ENABLED' : 'disabled'}` +
    (ALLOW_WRITES ? '' : ' — set YONNA_ALLOW_WRITES=1 to permit shell/file/device actions'),
)
// Asynchronous, so it lands a beat after the rest of the banner. Worth printing
// at all because an extension that is simply not running is indistinguishable
// at the tool boundary from one that is broken, and this is the one place the
// difference can be stated before anybody asks a question that depends on it.
void chromeAvailable().then((ok) => {
  chromeReady = ok
  console.log(
    ok
      ? `[yonna] browser control ready${ALLOW_WRITES ? '' : ' (reading only — clicking and typing need YONNA_ALLOW_WRITES=1)'}`
      : '[yonna] browser control unavailable — open Chrome with the Claude extension enabled',
  )
})

console.log(
  '[yonna] accepting local dev origins' +
    (EXTRA_ORIGINS.size ? ` plus ${[...EXTRA_ORIGINS].join(', ')}` : '') +
    (ALLOW_NO_ORIGIN ? ' and clients that send no origin' : ''),
)

/**
 * What to tell the browser when a turn ends badly. Plain sentences, because
 * whatever reaches the client is liable to be spoken.
 */
const RESULT_FAILURES = {
  error_during_execution: 'The turn failed part way through.',
  error_max_turns: 'The turn ran too long and was stopped.',
  error_max_budget_usd: 'The budget for this turn ran out.',
  error_max_structured_output_retries: 'The answer could not be assembled.',
  default: 'The turn ended without an answer.',
}

/**
 * Closing the window closes Yonna.
 *
 * On a Mac, closing a Chrome window leaves Chrome itself running, so the
 * desktop app's servers never stopped — and the next launch had to clear up a
 * half-alive Yonna, which is where opening went wrong. The window's socket is
 * the clearest sign it is gone: when the last one has been closed for a few
 * seconds (long enough to survive a reload), quit Yonna's own Chrome, and the
 * launcher stops everything else. Minimising or switching Spaces keeps the
 * socket open, so neither counts. The iMessage link is not a window.
 */
let windowCount = 0
let everHadWindow = false
let closeTimer = null
const WINDOW_GRACE_MS = 5000

/**
 * The global shortcut helper ("Yonna Keys", scripts/desktop-app/keys-helper):
 * Option+Space from any app. It is not a conversation of its own — it tells
 * the Yonna window to start and stop listening, hands over a screenshot taken
 * at the press (with the mouse pointer, and any circle drawn with it, marked),
 * and shows her answer in a small box at the top left of the screen.
 */
/** `say` processes still talking, so /say/stop can cut them off. */
const saying = new Set()
function sayAloud(text) {
  return new Promise((resolve) => {
    const p = spawn('/usr/bin/say', ['--', text], { stdio: 'ignore' })
    saying.add(p)
    p.on('error', () => {
      saying.delete(p)
      resolve(false)
    })
    p.on('exit', (code, signal) => {
      saying.delete(p)
      resolve(code === 0 && !signal)
    })
  })
}

const keysClients = new Set()
const pageSockets = new Set()
/** The screen as it was at the last press, for the question that follows. */
let pendingVision = null
const VISION_FRESH_MS = 45_000

const toKeys = (msg) => {
  const raw = JSON.stringify(msg)
  for (const k of keysClients) if (k.readyState === k.OPEN) k.send(raw)
}

async function readImage(path) {
  try {
    const data = (await readFile(path)).toString('base64')
    return { type: 'image', source: { type: 'base64', media_type: path.endsWith('.png') ? 'image/png' : 'image/jpeg', data } }
  } catch {
    return null
  }
}

/** Tells the helper whether a Yonna window is open: if one is, the shortcut
 *  talks in the window instead of opening the box. */
const tellKeysPages = () => toKeys({ type: 'pages', open: pageSockets.size > 0 })

/** The helper's screenshot for the question it is about to ask — or, with a
 *  window open, the shortcut itself, passed on to the window as push-to-talk. */
async function onKeys(raw) {
  let msg
  try {
    msg = JSON.parse(raw.toString())
  } catch {
    return
  }
  if (msg.type === 'ptt') {
    const out = JSON.stringify({ type: 'ptt', down: Boolean(msg.down) })
    for (const p of pageSockets) if (p.readyState === p.OPEN) p.send(out)
    return
  }
  if (msg.type !== 'vision') return
  const images = (await Promise.all([msg.image, msg.crop].filter(Boolean).map(readImage))).filter(Boolean)
  pendingVision = images.length
    ? { at: Date.now(), images, note: String(msg.note ?? '').slice(0, 400) }
    : null
}

/**
 * A brain started by the shortcut helper on a press (YONNA_IDLE_EXIT_MIN set)
 * goes away again after that long unused with no window open — like Atticus,
 * nothing runs in the background between questions.
 */
let lastUse = Date.now()
const IDLE_EXIT_MIN = Number(process.env.YONNA_IDLE_EXIT_MIN) || 0
if (IDLE_EXIT_MIN > 0) {
  setInterval(() => {
    if (windowCount === 0 && Date.now() - lastUse > IDLE_EXIT_MIN * 60_000) {
      console.log('[yonna] idle with no window — the brain stops until the next press')
      process.exit(0)
    }
  }, 30_000)
}

wss.on('connection', (socket, req) => {
  console.log('[yonna] client connected')
  // The shortcut helper: a conversation of its own, plus screenshots.
  const isKeys = String(req?.url ?? '').includes('client=keys')
  if (isKeys) {
    keysClients.add(socket)
    socket.on('message', (raw) => void onKeys(raw))
    socket.on('close', () => keysClients.delete(socket))
    tellKeysPages()
  }
  socket.on('message', () => {
    lastUse = Date.now()
  })
  const isWindow = !isKeys && !String(req?.url ?? '').includes('client=imessage')
  if (isWindow) {
    pageSockets.add(socket)
    tellKeysPages()
    socket.on('close', () => {
      pageSockets.delete(socket)
      tellKeysPages()
    })
    windowCount++
    everHadWindow = true
    clearTimeout(closeTimer)
    socket.on('close', () => {
      windowCount--
      if (windowCount > 0 || !everHadWindow) return
      clearTimeout(closeTimer)
      closeTimer = setTimeout(() => {
        if (windowCount > 0) return
        console.log('[yonna] window closed — shutting down')
        void quitYonna()
      }, WINDOW_GRACE_MS)
    })
  }

  // Answer the HUD straight away rather than making it wait for the agent's
  // first turn. Refined later by the real init message.
  socket.send(
    JSON.stringify({ type: 'ready', servers: Object.keys(MCP_SERVERS) }),
  )

  /** Resolves the pending user message into the SDK's input generator. */
  let deliver = null
  let closed = false
  const inbox = []

  async function* userMessages() {
    while (!closed) {
      const text =
        inbox.shift() ??
        (await new Promise((resolve) => {
          deliver = resolve
        }))
      if (closed || text == null) return
      // The model has no clock. Asked the time, it reached for `date` in a
      // shell, which the read-only gate rightly refuses — and the answer died
      // with it. Stamping each question with the machine's local time lets
      // "what time is it" and "what's today" be answered without a tool.
      const now = new Date().toLocaleString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
        timeZoneName: 'short',
      })
      // Asked with the shortcut: their screen as it was, attached.
      const vision = pendingVision && Date.now() - pendingVision.at < VISION_FRESH_MS ? pendingVision : null
      if (vision) pendingVision = null
      yield {
        type: 'user',
        message: {
          role: 'user',
          content: vision
            ? [{ type: 'text', text: `[Local time: ${now}]\n${text}\n\n[Screen: ${vision.note}]` }, ...vision.images]
            : `[Local time: ${now}]\n${text}`,
        },
        parent_tool_use_id: null,
      }
    }
  }

  const send = (msg) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg))
  }

  /**
   * Which question the agent is currently answering.
   *
   * The stream carries no notion of a turn, so without this the client cannot
   * tell the tail of an abandoned answer from the start of the new one — it
   * attaches a listener and receives whatever is on the socket. Echoing the
   * id the client sent lets it ignore anything that is not its own, which is
   * the only reliable fix: no amount of waiting on this side changes what a
   * listener over there has already heard.
   */
  let answering = null
  const sendTurn = (msg) => send({ ...msg, ask: answering })

  /**
   * Asking the browser for something and waiting for the answer.
   *
   * Every other tool here pushes — a panel, a blade, a retint — and never needs
   * a reply. The camera is the exception: the hardware is over there and the
   * model is here, so a frame has to come back. Correlated by id because a turn
   * can have more than one request in flight, and timed out because a browser
   * that has been closed mid-question would otherwise hang the turn until the
   * two-minute idle timer noticed.
   */
  const waiting = new Map()
  let asks = 0

  const ask = (kind, args, timeoutMs = 20_000) =>
    new Promise((resolve, reject) => {
      if (socket.readyState !== socket.OPEN) {
        return reject(new Error('the interface is not connected'))
      }
      const id = `q${++asks}`
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new Error('the interface did not answer in time'))
      }, timeoutMs)
      waiting.set(id, { resolve, timer })
      send({ type: kind, id, ...args })
    })

  /**
   * Announcing a tool on the HUD, once, and only if it actually runs.
   *
   * A tool_use block surfaces twice — as a partial stream event and again on
   * the completed assistant message — so ids are remembered. The harder part
   * is timing, because a refused tool that lights the badge, plays the sound
   * and provokes a "working on it" line, for work that never happens, reads as
   * a bug on camera.
   *
   * The SDK's order is: the block starts streaming, then canUseTool is asked,
   * then the tool runs. So nothing is known at content_block_start. Announcing
   * from inside canUseTool would know the verdict but miss tools entirely —
   * measured on this SDK, the callback is consulted only for calls the CLI
   * hasn't already settled, so a `Bash: echo` its own classifier waves through
   * never reaches us at all.
   *
   * So: announce immediately for anything decideTool permits, since those run.
   * Hold the rest, and let the tool_result settle it — a refusal comes back as
   * is_error, anything else really did execute and has earned its badge, a
   * beat late. Nothing is ever announced for work that didn't happen.
   */
  const seenTools = new Set()
  const heldTools = new Map()

  /**
   * Resolves when the turn in flight has actually finished.
   *
   * Waiting on session.interrupt() alone is not enough. It resolves when the
   * agent has been *told* to stop, not when it has, so the last tokens of the
   * abandoned answer are still on their way — and since nothing on the wire
   * identifies which question a delta belongs to, they land on the next turn's
   * listener. Measured: ask for ALPHA, interrupt, ask for BRAVO, and BRAVO's
   * answer arrives as "ALPHA\nBRAVO".
   *
   * The SDK emits exactly one `result` per turn, so that is the boundary worth
   * waiting for. Raced against a timeout because a turn that never reports one
   * must not wedge the conversation for ever — a stray word is a blemish, a
   * deadlocked assistant is not.
   */
  let settling = Promise.resolve()
  let finishTurn = null

  const turnFinished = () =>
    new Promise((resolve) => {
      finishTurn = resolve
    })

  /**
   * A brief pause so the abandoned turn's frames are tagged with the OLD id
   * before the new one is adopted. Short, because correctness now comes from
   * the tag rather than from the wait — this only has to cover the gap, not
   * outlast the whole turn.
   */
  const SETTLE_CAP_MS = 400

  /**
   * After a live panel — clock, countdown, stopwatch — the answer is complete:
   * he has already said it, and the panel shows the rest. The model kept adding
   * a line after the tool anyway ("The clock is refreshed, sir."), so from that
   * point in the turn its text is simply not passed on. `turnText` is what was
   * actually said, which is what the turn's result should carry.
   */
  let afterLive = false
  let turnText = ''
  /**
   * After an ordinary panel the model often signs off with a word — "Done.",
   * "Shown." — which is then spoken. Text after a panel is held until it is
   * clearly more than that (over four words, then it flows) or the turn ends
   * (a short tail is dropped).
   */
  let afterPanel = false
  let tail = ''
  const flushTail = () => {
    if (!tail) return
    turnText += tail
    sendTurn({ type: 'text', delta: tail })
    tail = ''
  }
  const LIVE_TOOL = /^mcp__yonna__(clock|countdown|stopwatch)$/

  /**
   * The opening line, held until it is clearly the answer.
   *
   * The user wants answers, not narration — no "I'll take a look.", no
   * "Searching.", no "Certainly, sir." before the actual reply. The prompt says
   * so and the model still does it now and then, so the first sentence of a
   * turn is held until it ends: a short preamble is dropped, anything else is
   * released at once. Costs one sentence of latency on ordinary answers, which
   * is a few hundred milliseconds of streaming.
   */
  const PREAMBLE =
    /^(?:(?:okay|ok|right|very well|certainly|of course|sure|understood|absolutely|one moment|just a moment|a moment|bear with me|on it|working on it|searching|checking|looking|scanning|retrieving|stand by|let me\b.*|let's (?:see|look|check|have a look)\b.*|i'?ll (?:take a look|have a look|look|check|search|find|pull|fetch|see)\b.*|i will (?:take a look|have a look|look|check|search|find)\b.*|i'?m (?:checking|looking|searching|pulling|bringing|opening)\b.*|allow me\b.*|give me a (?:moment|second|sec)\b.*|taking a look\b.*|having a look\b.*|opening (?:it|that|the camera)\b.*)(?:,? sir)?)[.!…]*$/i
  let opening = ''
  let openingDone = false
  const say = (text) => {
    turnText += text
    sendTurn({ type: 'text', delta: text })
  }
  /** Let the held opening out, minus a first sentence that is only preamble. */
  const releaseOpening = (final = false) => {
    if (openingDone) return
    const m = opening.match(/^\s*([^.!?…]*[.!?…]+)(\s+|$)([\s\S]*)$/)
    const first = m ? m[1].trim() : opening.trim()
    const rest = m ? m[3] : ''
    const words = first.split(/\s+/).filter(Boolean).length
    const drop = words <= 9 && PREAMBLE.test(first) && !(final && !rest.trim() && !turnText.trim())
    openingDone = true
    const out = drop ? rest : opening
    opening = ''
    if (drop) console.log(`[yonna] dropped preamble: "${first}"`)
    if (out) say(out)
  }

  const announceTool = (id, name) => {
    if (!name || (id && seenTools.has(id))) return
    if (id) seenTools.add(id)
    // The display tool isn't work being done, it's the HUD drawing itself —
    // announcing it would put "yonna · display" in the tool badge and trigger
    // a "working on it" filler for something already on screen.
    if (name === 'mcp__yonna__display') return
    // The ui_* tools are the same case one step further: retinting the
    // interface is the interface talking about itself, not work being done for
    // the user, and the badge would be describing the very thing they can see.
    if (name.startsWith('mcp__yonna_ui__')) return
    if (decideTool(name)) return sendTurn({ type: 'tool', name })
    if (id) heldTools.set(id, name)
  }

  const settleTool = (id, failed) => {
    const name = heldTools.get(id)
    if (name === undefined) return
    heldTools.delete(id)
    if (!failed) sendTurn({ type: 'tool', name })
  }

  const session = query({
    prompt: userMessages(),
    options: {
      // Everything Claude Code has configured, plus the HUD as an in-process
      // server. The HUD's handler closes over this socket, so a `display` call
      // lands on screen directly — which is also why this object is built per
      // connection rather than once.
      mcpServers: {
        ...MCP_SERVERS,
        yonna: displayServer(
          (panel) => send({ type: 'panel', panel }),
          (blade) => send({ type: 'blade', blade }),
        ),
        // The interface controls, on the same socket. A separate key because
        // MCP tool names are `mcp__<key>__<tool>` and one key can only carry
        // one server; the underscore in it is why decideTool and announceTool
        // both name `yonna_ui` explicitly.
        yonna_ui: uiServer((op, args) => send({ type: 'ui', op, args })),
        // The user's own Chrome, over the extension's native-host socket. It
        // holds no per-connection state, but it is built here with the rest so
        // the write gate is read once, at the same point as everything else.
        yonna_chrome: chromeServer({ allowWrites: ALLOW_WRITES }),
        // The camera, which unlike everything else here has to ask and wait.
        yonna_eyes: visionServer(ask),
        // Safari, so the user can watch a search happen. See safari.mjs.
        yonna_safari: safariServer(),
        // Opening the user's applications by name. See apps.mjs.
        yonna_apps: appsServer(),
        // Apple Calendar and Reminders, through the native helper. See calendar.mjs.
        yonna_calendar: calendarServer(),
        // What survives a restart. See memory.mjs.
        yonna_memory: memoryServer(),
        // Making files and folders on the Mac. See files.mjs.
        yonna_files: filesServer(),
        // Weather from a weather service, not a web search. See weather.mjs.
        yonna_weather: weatherServer(),
        // Spotify, the Trash, and unsent drafts. See mac.mjs.
        yonna_mac: macServer(),
      },
      // A plain system prompt, not the claude_code preset. The preset is
      // tuned for a coding agent — verbose, file-oriented, and a large chunk
      // of input tokens on every turn. Replacing it makes the persona stick,
      // keeps answers short enough to speak, and cuts cost per turn.
      systemPrompt: systemPrompt(),
      // Run from the home directory so project-scoped MCP servers don't shadow
      // the global ones, and so file tools have a sane root.
      cwd: homedir(),
      // No filesystem settings at all. Left to its default the SDK loads
      // ~/.claude/settings.json and settings.local.json exactly as the CLI
      // does — which on a working machine means a bypassPermissions default
      // and a pile of allow-rules for Bash. Allow-rules are matched before the
      // permission callback, so decideTool below would never even be asked
      // about the tools it most needs to refuse. Empty makes this bridge the
      // only authority. It also stops the global CLAUDE.md riding along on
      // every voice turn, carrying instructions written for a coding agent
      // into a conversation that is meant to be two sentences long.
      //
      // The cost is that MCP servers stop being discovered too, which is why
      // mcpServers above passes them in by hand.
      settingSources: [],
      // Stated explicitly, and it has to be.
      //
      // With no `model` here the SDK falls back to its own default, which on
      // this machine resolved to claude-opus-4-8[1m] — not what src/config.ts
      // declares for the browser-direct path, and not anything anyone chose.
      // Normally your own `/model` preference would decide, but that lives in
      // the settings files `settingSources: []` deliberately stops loading, so
      // without this line nothing in the project has a say at all.
      model: MODEL,
      effort: EFFORT,
      maxTurns: 24,
      permissionMode: 'default',
      // Without this the SDK only emits whole assistant messages, and Yonna
      // would sit silent until the entire answer was written. Partial events
      // are what let speech start on the first finished sentence.
      includePartialMessages: true,
      // Signature is (toolName, input, options) and it must return a
      // PermissionResult object. Returning a bare boolean silently denies
      // everything, with the tool name arriving undefined.
      //
      // Worth knowing: this is a last gate, not the only one. Calls the CLI
      // has already settled never arrive here — its own classifier waves
      // through a `Bash: echo hello` without asking, and only reaches us for
      // something with a consequence, like a `touch`. So a deny here is
      // reliable; an absence of a call here is not proof nothing ran.
      canUseTool: async (toolName) => {
        const ok = decideTool(toolName)
        console.log(`[yonna] tool ${toolName} -> ${ok ? 'allow' : 'deny'}`)
        return ok
          ? { behavior: 'allow' }
          : {
              behavior: 'deny',
              // Every word of this can end up spoken, so it carries no command
              // to read out — the persona is forbidden from saying one aloud.
              message:
                'Blocked: Yonna is running in read-only mode and cannot take' +
                ' actions that change anything. Tell the user this action is' +
                ' unavailable until they enable write access on the machine.',
            }
      },
    },
  })

  // Pump the session's output stream to the browser for as long as it lives.
  ;(async () => {
    try {
      for await (const msg of session) {
        if (process.env.YONNA_DEBUG === '1') {
          console.log('[msg]', msg.type, msg.event?.type ?? '')
        }

        switch (msg.type) {
          // Raw Anthropic stream events, surfaced by includePartialMessages.
          // This is the ONLY place spoken text arrives: there is no top-level
          // text_delta message in the SDK union and the 'assistant' message
          // carries no deltas either. Turn includePartialMessages off and
          // Yonna goes completely mute.
          case 'stream_event': {
            const ev = msg.event
            if (
              ev?.type === 'content_block_delta' &&
              ev.delta?.type === 'text_delta' &&
              ev.delta.text &&
              !afterLive
            ) {
              if (afterPanel) {
                tail += ev.delta.text
                if (tail.trim().split(/\s+/).length > 4) {
                  afterPanel = false
                  flushTail()
                }
              } else if (!openingDone) {
                opening += ev.delta.text
                // Released once the first sentence has ended and more follows,
                // or it has run long enough that it cannot be a preamble.
                if (/[.!?…]\s/.test(opening) || opening.split(/\s+/).length > 12) releaseOpening()
              } else {
                say(ev.delta.text)
              }
            }
            if (
              ev?.type === 'content_block_start' &&
              ev.content_block?.type === 'tool_use'
            ) {
              // Text before a tool is the classic preamble ("I'll take a look.").
              if (!openingDone && opening) releaseOpening()
              if (LIVE_TOOL.test(ev.content_block.name ?? '')) afterLive = true
              else if (ev.content_block.name === 'mcp__yonna__display' || ev.content_block.name === 'mcp__yonna__blade') {
                // A held tail before this panel was real text: let it out.
                flushTail()
                afterPanel = true
              } else {
                // Any other tool: work is continuing, whatever follows is real.
                afterPanel = false
                flushTail()
              }
              announceTool(ev.content_block.id, ev.content_block.name)
            }
            break
          }

          case 'assistant': {
            // Fallback for builds that emit whole assistant messages rather
            // than partial events. Deduped against the stream_event path.
            for (const block of msg.content ?? msg.message?.content ?? []) {
              if (block.type === 'tool_use') {
                announceTool(block.id, block.name)
              }
            }
            break
          }

          case 'user': {
            // Tool results come back as a user message. This is the only place
            // a held announcement can be resolved: a refused tool arrives with
            // is_error set and stays off the HUD, anything else ran.
            const blocks = msg.message?.content
            if (!Array.isArray(blocks)) break
            for (const block of blocks) {
              if (block?.type === 'tool_result') {
                settleTool(block.tool_use_id, block.is_error === true)
              }
            }
            break
          }

          case 'result':
            // A result is not automatically a success. The error subtypes
            // carry no `result` field at all, so reporting them as 'done' with
            // empty text is indistinguishable from a turn that simply had
            // nothing to say — the HUD stops spinning and Yonna stands there
            // silent. Say what happened instead.
            if (msg.subtype === 'success') {
              // A short line after a panel is only dropped when something was
              // said before it — if it is the whole answer, it is the answer.
              releaseOpening(true)
              if (tail && !turnText.trim()) flushTail()
              sendTurn({
                type: 'done',
                // What was actually said, when a live panel cut the turn short;
                // otherwise the model's own final text, as before.
                text: (afterLive || afterPanel) && turnText ? turnText : (msg.result ?? ''),
                costUsd: msg.total_cost_usd ?? null,
              })
            } else {
              console.error(
                `[yonna] turn failed: ${msg.subtype}`,
                msg.errors ?? '',
              )
              sendTurn({
                type: 'error',
                message: RESULT_FAILURES[msg.subtype] ?? RESULT_FAILURES.default,
              })
            }
            // Whatever was waiting on this turn to finish can go now. This is
            // the only place a turn is genuinely over.
            finishTurn?.()
            finishTurn = null
            afterLive = false
            afterPanel = false
            tail = ''
            turnText = ''
            opening = ''
            openingDone = false
            // One turn's tool ids are never referred to again, and these
            // otherwise grow for as long as the socket is open.
            seenTools.clear()
            heldTools.clear()
            break

          case 'system':
            if (msg.subtype === 'init') {
              // Servers report 'pending' until first use — they connect
              // lazily — so only drop the ones that are actually unusable.
              const usable = (msg.mcp_servers ?? [])
                .filter((s) => s.status !== 'needs-auth' && s.status !== 'failed')
                .map((s) => s.name)
              send({ type: 'ready', servers: usable })
              console.log(`[yonna] ${usable.length} MCP servers available: ${usable.join(", ")}`)
            }
            break
        }
      }
    } catch (err) {
      console.error('[yonna] session error:', err)
      send({ type: 'error', message: String(err?.message ?? err) })
      // The stream is finished either way — nothing will ever be read from it
      // again. Leaving the socket open would leave the client believing it has
      // a working bridge, and every later question would hang for ever waiting
      // on a pump that has already stopped. Close it so it reconnects.
      closed = true
      deliver?.(null)
      session.close?.()
      socket.close()
    }
  })()

  /** Which Claude model this conversation is on; switched before a question
   *  that needs the other one, behind any interrupt still settling. */
  let currentModel = MODEL
  const useModel = (brain) => {
    const want = MODELS[brain]
    if (!want || want === currentModel) return
    currentModel = want
    settling = settling
      .then(() => session.setModel(want))
      .then(() => console.log(`[yonna] model switched to ${want}`))
      .catch((err) => console.warn(`[yonna] model switch failed: ${err?.message ?? err}`))
  }

  socket.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    // Sonnet or Opus, whichever the switch says, from this question on.
    if (msg.type === 'ask' && typeof msg.text === 'string') useModel(chosenBrain())

    if (msg.type === 'ask' && typeof msg.text === 'string') {
      /**
       * Queued behind any interrupt that is still settling.
       *
       * A barge-in is two messages in quick succession — interrupt, then the
       * new question — and session.interrupt() is asynchronous. Delivering the
       * question the instant it arrives means the agent can still be winding
       * down the previous turn, so its last tokens are emitted after the new
       * one has begun and land on the new turn's listener. Measured: ask "one",
       * interrupt, ask "two", and the answer to "two" comes back as "One."
       *
       * Waiting costs nothing when nothing is interrupting — the chain is an
       * already-resolved promise — and removes the cross-talk when there is.
       */
      // From the shortcut box: there may be no window to show anything on.
      const text = isKeys
        ? `[Asked from the shortcut box at the top left; your answer is spoken and shown there as text.${pageSockets.size ? '' : ' No Yonna window is open: no blades or panels — answer in words only.'}]\n${msg.text}`
        : msg.text
      const id = typeof msg.id === 'string' ? msg.id : null
      void settling.then(() => {
        answering = id
        if (deliver) {
          const resolve = deliver
          deliver = null
          resolve(text)
        } else {
          inbox.push(text)
        }
      })
    }

    // What the window is doing, for the shortcut helper's box.
    if (msg.type === 'overlay') {
      toKeys({ type: 'overlay', state: String(msg.state ?? ''), text: String(msg.text ?? '').slice(0, 2000) })
      return
    }

    if (msg.type === 'reply' && typeof msg.id === 'string') {
      const slot = waiting.get(msg.id)
      if (slot) {
        waiting.delete(msg.id)
        clearTimeout(slot.timer)
        slot.resolve(msg)
      }
    }

    // A short phrase the page did not take as his name — logged so missed
    // spellings of "Yonna" can be found. Only ever written to the local log.
    if (msg.type === 'heard' && typeof msg.text === 'string') {
      console.log(`[yonna] heard, not taken as his name: "${msg.text.slice(0, 120)}"`)
      return
    }

    // The brain switch on the HUD: Sonnet (the default) or Opus, for the
    // window and the shortcut box. Remembered across restarts; takes effect
    // from the next question.
    if (msg.type === 'model') {
      if (MODELS[msg.model]) chooseBrain(msg.model)
      useModel(msg.model)
      return
    }

    // "Goodbye, Yonna." The page has already said its farewell; close it.
    if (msg.type === 'goodbye') {
      console.log('[yonna] goodbye — closing')
      void quitYonna()
      return
    }

    if (msg.type === 'interrupt') {
      // Held so the next question can wait for it rather than racing it.
      const stopped = turnFinished()
      settling = Promise.resolve(session.interrupt?.())
        .catch(() => {})
        .then(() =>
          Promise.race([
            stopped,
            new Promise((r) => setTimeout(r, SETTLE_CAP_MS)),
          ]),
        )
    }
  })

  socket.on('close', () => {
    console.log('[yonna] client disconnected')
    closed = true
    deliver?.(null)
    session.close?.()
  })
})
