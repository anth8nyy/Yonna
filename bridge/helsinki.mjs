import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as ort from 'onnxruntime-node'

/**
 * English → Greek with the University of Helsinki's opus-mt-tc-big-en-el
 * (Marian, int8 ONNX from TigreGotico/opus-mt-tc-big-en-el-onnx), run on this
 * Mac with onnxruntime. Trained for this one language pair, it reads better
 * than a general many-language model.
 *
 * The model comes as bare ONNX files, so the rest is here: the SentencePiece
 * word splitter (its .spm file read directly), and greedy decoding one word
 * piece at a time.
 */

export const DIR = join(homedir(), 'Library/Application Support/Yonna/models/opus-mt-tc-big-en-el')

/* --------------------------------------------------------- the .spm reader */

/** The pieces and scores in a SentencePiece model file (a protobuf). */
function readSpm(path) {
  const b = readFileSync(path)
  let i = 0
  const varint = () => {
    let v = 0
    let shift = 0
    for (;;) {
      const x = b[i++]
      v += (x & 0x7f) * 2 ** shift
      if (x < 0x80) return v
      shift += 7
    }
  }
  const pieces = new Map() // piece -> score
  while (i < b.length) {
    const key = varint()
    const field = Math.floor(key / 8)
    const wire = key & 7
    if (wire === 2) {
      const len = varint()
      const end = i + len
      if (field === 1) {
        // SentencePiece { 1: piece, 2: score (float), 3: type }
        let piece = ''
        let score = 0
        let type = 1
        while (i < end) {
          const k = varint()
          const f = Math.floor(k / 8)
          const w = k & 7
          if (f === 1 && w === 2) {
            const l = varint()
            piece = b.toString('utf8', i, i + l)
            i += l
          } else if (f === 2 && w === 5) {
            score = b.readFloatLE(i)
            i += 4
          } else if (f === 3 && w === 0) {
            type = varint()
          } else if (w === 0) varint()
          else if (w === 5) i += 4
          else if (w === 1) i += 8
          else if (w === 2) i += varint()
        }
        if (type === 1 || type === 4) pieces.set(piece, score) // normal, user-defined
      }
      i = end
    } else if (wire === 0) varint()
    else if (wire === 5) i += 4
    else if (wire === 1) i += 8
    else break
  }
  return pieces
}

/* ---------------------------------------------------------------- the model */

let ready = null

async function load() {
  const vocab = JSON.parse(readFileSync(join(DIR, 'vocab.json'), 'utf8'))
  const cfg = JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf8'))
  const ids = new Map(Object.entries(vocab))
  const names = []
  for (const [p, id] of ids) names[id] = p
  const src = readSpm(join(DIR, 'source.spm'))
  let longest = 0
  for (const p of src.keys()) longest = Math.max(longest, [...p].length)
  const opts = { executionProviders: ['cpu'], graphOptimizationLevel: 'all' }
  const [encoder, decoder] = await Promise.all([
    ort.InferenceSession.create(join(DIR, 'encoder_model.onnx'), opts),
    ort.InferenceSession.create(join(DIR, 'decoder_model.onnx'), opts),
  ])
  return {
    ids,
    names,
    src,
    longest,
    encoder,
    decoder,
    eos: cfg.eos_token_id,
    pad: cfg.pad_token_id,
    start: cfg.decoder_start_token_id,
    unk: ids.get('<unk>') ?? 1,
  }
}

/** SentencePiece unigram: the best-scoring split of the text into pieces. */
function split(m, text) {
  const s = '▁' + text.normalize('NFKC').trim().replace(/\s+/g, ' ').replace(/ /g, '▁')
  const ch = [...s]
  const n = ch.length
  const best = new Array(n + 1).fill(-Infinity)
  const from = new Array(n + 1).fill(-1)
  best[0] = 0
  for (let end = 1; end <= n; end++) {
    for (let len = 1; len <= Math.min(m.longest, end); len++) {
      const start = end - len
      if (best[start] === -Infinity) continue
      const piece = ch.slice(start, end).join('')
      const sc = m.src.get(piece)
      // A character no piece covers still has to go somewhere: as unknown.
      const score = sc ?? (len === 1 ? -100 : undefined)
      if (score === undefined) continue
      if (best[start] + score > best[end]) {
        best[end] = best[start] + score
        from[end] = start
      }
    }
  }
  const out = []
  for (let end = n; end > 0; end = from[end]) out.unshift(ch.slice(from[end], end).join(''))
  return out
}

const tensor = (arr) => new ort.Tensor('int64', BigInt64Array.from(arr.map(BigInt)), [1, arr.length])

/** English in, Greek out. */
export async function helsinki(text) {
  ready ??= load()
  const m = await ready
  const input = [...split(m, text).map((p) => m.ids.get(p) ?? m.unk), m.eos]
  const mask = tensor(input.map(() => 1))
  const enc = await m.encoder.run({ input_ids: tensor(input), attention_mask: mask })
  const hidden = enc.last_hidden_state ?? Object.values(enc)[0]
  const out = [m.start]
  const max = Math.min(256, input.length * 3 + 10)
  for (let step = 0; step < max; step++) {
    const dec = await m.decoder.run({
      input_ids: tensor(out),
      encoder_hidden_states: hidden,
      encoder_attention_mask: mask,
    })
    const logits = dec.logits ?? Object.values(dec)[0]
    const [, t, v] = logits.dims
    const row = logits.data.subarray((t - 1) * v, t * v)
    let id = 0
    let top = -Infinity
    for (let k = 0; k < v; k++) {
      if (k === m.pad) continue
      if (row[k] > top) {
        top = row[k]
        id = k
      }
    }
    if (id === m.eos) break
    out.push(id)
    // A model stuck repeating itself: stop.
    if (out.length > 8 && out.slice(-4).every((x) => x === id)) break
  }
  return out
    .slice(1)
    .map((id) => m.names[id] ?? '')
    .join('')
    .replace(/▁/g, ' ')
    .trim()
}

export async function inputsOf() {
  ready ??= load()
  const m = await ready
  return { encoder: m.encoder.inputNames, decoder: m.decoder.inputNames, decoderOut: m.decoder.outputNames }
}
