# Yonna

A voice assistant for the Mac. Hold **fn**, talk, let go — or just say
**"Hey Yonna"** — and she answers out loud, sees your screen when you ask, and
does real things: opens apps, plays your Spotify playlists, checks your
calendar, clears your Desktop, and drafts emails and messages for you to send.

She lives in a glass window on your Mac, with a small box in the top-left
corner when you call her from any other app. Her brain is Claude (Sonnet, or
Opus when you switch to it), run through your Claude Code login. Meetings are
different: there, nothing is sent anywhere — see [Meetings](#meetings).

---

## What she does

**Talk to her**

- **Hold fn** in any app, talk, let go to send. She sees your screen too, and
  understands where your mouse is (circle something to point at it).
- **"Hey Yonna"** in her window, or **Space** to talk without her name.
- She speaks with the Mac's Siri voice, in one or two short sentences.
- **Sonnet** answers by default; click the name at the top right for **Opus**.

**Instant commands** — done at once, no AI, free:

- Time, date, time elsewhere, the weather and rain, timers and stopwatches
- Open or close apps, volume up and down, maths, units, currency, definitions
- **Spotify:** *"play Blinding Lights"*, *"play my gym playlist"* (yours before
  a public one), *"shuffle my chill playlist"*, *"play this playlist from the
  beginning"*, *"play my liked songs"*, pause, skip, previous, *"what's playing"*

**Doing things for you**

- Your calendar and reminders (Apple Calendar)
- Clearing files: *"delete the screenshots on my desktop"* — always to the
  **Trash**, never deleted for good
- Drafts: *"reply to that email"* opens it written in Gmail, *"text Maria I'm
  late"* opens it written in Messages — **you** press Send, never her
- iMessage: ask her from your phone
- Remembering things you tell her, the camera and hand gestures

## Meetings

Say *"I'm getting ready for a meeting"* — or just join a **Zoom**, **Google
Meet** or **Teams** call — and a glass meeting window opens. Pick:

| | |
|---|---|
| **Translate** | What the others say, into **Greek**, live, as one flowing paragraph — with **εσύ** or **εσείς** chosen from the meaning |
| **Answer** | When someone asks a question, the answer to give, in formal sentences, as it is being asked |
| **Save** | The conversation as a **Word** file in `Documents/Yonna Meetings` |

Save goes with either of the others; Translate and Answer not together.
**Clear** wipes the window (a saved file keeps everything).

**Private by design.** Nothing from a meeting goes to Claude or leaves your Mac:

- She hears only the meeting's own sound — **never your microphone**.
- Speech is turned into text by Apple's on-device recogniser.
- Greek comes from a translation model running on your Mac
  ([opus-mt-tc-big-en-el](https://huggingface.co/Helsinki-NLP/opus-mt-tc-big-en-el)).
- Answers come from Apple's on-device model (Apple Intelligence).
- The window is hidden when you share your screen.

---

## Requirements

- A Mac with **macOS 26** and Apple silicon (Apple Intelligence on for meeting answers)
- **Claude Code**, installed and logged in — the only account you need:
  `npm install -g @anthropic-ai/claude-code`, then run `claude` once
- **Node.js 20+** and the **Xcode command line tools** (`xcode-select --install`)
- Optional: **Spotify** with a free developer key, for playing by name

## Setup

```bash
npm install
bash scripts/desktop-app/build.sh
```

This builds **Yonna.app** on your Desktop and her helpers in
`~/Library/Application Support/Yonna`. Open Yonna.app: the **welcome screen**
lists what she needs from your Mac — Microphone, Speech Recognition, Screen
Recording, Calendar, and optionally the Camera, Messages and Spotify — each with
an **Allow** button. Press **W** to see it again.

The shortcut helper (Yonna Keys) starts by itself when you log in, so **fn**
works even before you open her window.

**Spotify**, to play by name and use your own playlists:

1. Create a free app at <https://developer.spotify.com/dashboard> (redirect URI
   `http://127.0.0.1:8888/callback`, Web API).
2. Put its Client ID and Secret in
   `~/Library/Application Support/Yonna/spotify.json`:
   `{"clientId": "…", "clientSecret": "…"}`
3. `node scripts/spotify-login.mjs` once, and allow access in the browser.

**Meeting translation** needs its model once (about 0.4 GB), into
`~/Library/Application Support/Yonna/models/opus-mt-tc-big-en-el`:

```bash
M="$HOME/Library/Application Support/Yonna/models/opus-mt-tc-big-en-el"; mkdir -p "$M"; for f in config.json generation_config.json source.spm target.spm vocab.json special_tokens_map.json tokenizer_config.json encoder_model.onnx decoder_model.onnx; do curl -L --fail -o "$M/$f" "https://huggingface.co/TigreGotico/opus-mt-tc-big-en-el-onnx/resolve/main/int8/$f"; done
```

Without it, `node bridge/translator.mjs --warm` fetches the general NLLB model
instead (about 0.9 GB; slower, and non-commercial use only).

Developing without the app: `npm start` runs the brain and the page together
(http://localhost:5173).

---

## Keys

| Key | Does |
|---|---|
| **fn** (hold) | Talk from any app; let go to send |
| **Space** | Talk without saying her name |
| **T** | Type a question instead |
| **M** | Mute or unmute the microphone |
| **G** | Hand gestures (camera) |
| **V** | Try the next voice |
| **I** | All shortcuts |
| **W** | Welcome — what she needs, with Allow buttons |
| **D** | Diagnostics |

To use a different shortcut, edit
`~/Library/Application Support/Yonna/keys.json` — `{"key": "fn"}`, or
`{"modifiers": ["option", "control"], "key": "space"}`.

---

## How it works

```
 Yonna Window (native, glass)        Yonna Keys (shortcut, box, meetings)
   the React page: orb, voice           fn · screen · on-device speech
            │  ws://localhost:8787          │
            └──────────┬────────────────────┘
                       ▼
        bridge/server.mjs — Claude Agent SDK (Claude Code, headless)
        instant commands · Spotify · calendar · files · drafts · memory
```

- **`src/`** — the page: orb (thinking-orbs), conversation, voice loop.
- **`bridge/`** — the brain: `server.mjs` (Claude, tools, permission gate),
  `instant.mjs` / `quick.mjs` (no-AI commands), `spotify.mjs`, `mac.mjs`
  (Spotify, Trash, drafts), `translator.mjs` + `helsinki.mjs` (Greek).
- **`scripts/desktop-app/`** — the Mac side: `window-app` (glass window with the
  Mac's speech recognition), `keys-helper` (the fn shortcut, the box, the
  meeting window), calendar and Messages helpers, and `build.sh`.

### Configuration

| Variable | Default | Effect |
|---|---|---|
| `YONNA_MODEL` | `claude-opus-5` | The model used when Opus is chosen |
| `YONNA_EFFORT` | `low` | Reasoning effort (low keeps answers fast) |
| `YONNA_ALLOW_WRITES` | off | `1` also allows shell and other effectful tools |
| `YONNA_BRIDGE_PORT` | `8787` | Port for the bridge |

### Safety

- Effectful tools are **default-deny** (`decideTool()` in `bridge/server.mjs`).
  Her own tools are narrow on purpose: files go to the Trash, drafts are never
  sent, apps are opened only by name.
- The bridge accepts only local connections; remote media goes through
  SSRF-guarded endpoints; panel markup is sanitised under a strict CSP.

---

## Credits & licences

MIT — see `LICENSE`.

- **JARVIS** by Aditya Dewaskar (MIT) — the browser voice assistant with Claude
  Code as its brain that Yonna grew out of: the bridge, the voice loop, the
  permission gate.
- **[Atticus](https://github.com/SaarthurR/atticus-mac)** (MIT) — the idea for
  the shortcut box, instant commands and meeting copilot; its meeting audio
  capture is followed closely in `keys-helper/meeting.swift`.
- **[thinking-orbs](https://github.com/Jakubantalik/thinking-orbs)** (MIT, Jakub
  Antalik) — the orb.
- **[opus-mt-tc-big-en-el](https://huggingface.co/Helsinki-NLP/opus-mt-tc-big-en-el)**
  (CC BY 4.0, University of Helsinki) — Greek translation; ONNX conversion by
  TigreGotico.
- **[NLLB-200 distilled 600M](https://huggingface.co/facebook/nllb-200-distilled-600M)**
  (CC BY-NC 4.0, Meta) — fallback translator; **non-commercial use only**.
- Audio in `public/audio/` ships for the demo; clear its rights before any
  commercial use.
