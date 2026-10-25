#!/usr/bin/env node
/**
 * English → Greek translation for meetings, entirely on this Mac.
 *
 * Uses the University of Helsinki's English→Greek model (helsinki.mjs) when it
 * is in the models folder; otherwise the general NLLB model below.
 *
 * Apple's on-device translation has no Greek, and its on-device model cannot
 * write it, so this runs Meta's open NLLB-200 (distilled 600M, quantized)
 * locally with transformers.js. The model is downloaded once into
 * ~/Library/Application Support/Yonna/models; after that it runs offline, and
 * no text ever leaves the Mac — remote loading is switched off once the files
 * are there.
 *
 * Run by the shortcut helper's meeting window, talking JSON lines:
 *   in   {"id": "…", "text": "…"}
 *   out  {"id": "…", "text": "<Greek>"}  or  {"id": "…", "error": "…"}
 *        {"ready": true} once the model is loaded
 *
 *   node bridge/translator.mjs --warm   downloads the model and exits
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { env, pipeline } from '@huggingface/transformers'
import { DIR as HELSINKI_DIR, helsinki } from './helsinki.mjs'

const MODEL = 'Xenova/nllb-200-distilled-600M'
env.cacheDir = join(homedir(), 'Library/Application Support/Yonna/models')
// Once downloaded, never reach the network again.
const have = existsSync(join(env.cacheDir, MODEL, 'onnx', 'encoder_model_quantized.onnx'))
env.allowRemoteModels = !have

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')

// The Helsinki English→Greek model (helsinki.mjs) when it is downloaded:
// trained for this pair, it is better and several times faster. NLLB otherwise.
const useHelsinki = existsSync(join(HELSINKI_DIR, 'encoder_model.onnx'))
const nllb = useHelsinki ? null : await pipeline('translation', MODEL, { dtype: 'q8' })
const translate = async (text) =>
  useHelsinki
    ? [{ translation_text: await helsinki(text) }]
    : nllb(text, { src_lang: 'eng_Latn', tgt_lang: 'ell_Grek', max_new_tokens: 200 })
if (useHelsinki) await helsinki('Ready.') // loaded before the first real line
if (process.argv.includes('--warm')) {
  const r = await translate('The meeting starts at ten.')
  console.error('model ready:', r?.[0]?.translation_text)
  process.exit(0)
}

/* ------------------------------------------------- εσύ or εσείς, by meaning */

/**
 * Greek says "you" two ways: εσύ (one person, familiar) and εσείς (several
 * people, or one person politely). The model has no switch for it, but it
 * follows cues in the English — "…, sir?" comes back as εσείς — so:
 *
 *   talking to several people ("everyone", "team", "you all")  → εσείς
 *   a polite or senior tone ("please", "could you", "sir", Mr…) → εσείς
 *   casual ("hey", "buddy", "what's up", "gonna")               → εσύ
 *   no cue: εσείς — this is a work meeting
 *
 * For εσείς the English gets a quiet ", sir" before its last mark, and the
 * "κύριε" it brings is taken out of the Greek again.
 */
const YOU = /\byou(r|rs|rself|selves)?\b/i
const GROUP = /\b(everyone|everybody|all of you|you all|y'all|you guys|guys|team|folks|both of you|you two|ladies and gentlemen|people)\b/i
const POLITE = /\b(please|could you|would you|would you mind|kindly|sir|madam|ma'am|mr|mrs|ms|dr|professor|i would appreciate|if you don't mind)\b/i
const CASUAL = /\b(hey|hi there|buddy|dude|mate|man|bro|what's up|whats up|gonna|wanna|gotta|yeah|cool)\b/i

function register(text) {
  if (!YOU.test(text)) return 'none'
  if (GROUP.test(text)) return 'plural' // the model already says εσείς for these
  if (POLITE.test(text)) return 'formal'
  if (CASUAL.test(text)) return 'familiar'
  return 'formal'
}

/** The model now and then adds a dash-led second line of its own ("- Καλή τύχη"). */
const tidy = (g) =>
  g
    .replace(/^\s*[-–—]\s*/, '')
    .split(/\s[-–—]\s/)[0]
    .trim()

async function greek(text) {
  const how = register(text)
  let en = text.trim()
  if (how === 'formal' && !/\bsir\b/i.test(en)) {
    const end = en.match(/[.?!…]+$/)?.[0] ?? ''
    en = `${en.slice(0, en.length - end.length)}, sir${end || '.'}`
  }
  const r = await translate(en)
  let g = tidy(r?.[0]?.translation_text ?? '')
  if (how === 'formal' && !/\bsir\b/i.test(text)) g = g.replace(/,?\s*κύριε(?=[\s.;!,…]|$)/u, '').replace(/\s+([.;!,…])/g, '$1')
  return g
}

/* ----------------------------------------------------------------- the queue */

// Live: the same phrase arrives again and again as it grows. Only its newest
// wording waits; an older one still waiting is replaced, so the translation
// keeps up with the speaker instead of falling behind.
let busy = false
const waiting = new Map() // id -> text, in arrival order
async function pump() {
  if (busy) return
  busy = true
  while (waiting.size) {
    const [id, text] = waiting.entries().next().value
    waiting.delete(id)
    try {
      out({ id, text: await greek(text) })
    } catch (err) {
      out({ id, error: String(err?.message ?? err) })
    }
  }
  busy = false
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  if (!m?.id || !m.text) return
  waiting.delete(m.id) // keeps its newest wording, moved to the back
  waiting.set(m.id, m.text)
  while (waiting.size > 6) waiting.delete(waiting.keys().next().value)
  void pump()
})

// node bridge/translator.mjs --test "Can you send it?" …  prints each in Greek.
if (process.argv.includes('--test')) {
  for (const t of process.argv.slice(process.argv.indexOf('--test') + 1)) console.log(t, '→', await greek(t))
  process.exit(0)
}
out({ ready: true })
