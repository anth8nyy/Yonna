/**
 * Hearing his name, however the recogniser spells it.
 *
 * Exact spellings were not enough. In Greek especially, the recogniser writes
 * "Τζάρβις" a different way almost every time — Τζάρμπις, Τσάρβις, Τζάβις,
 * Ζάρβης, Yonna — and any miss meant he simply did not answer. So the name is
 * matched by sound: each word is turned into a rough Latin pronunciation
 * (τζ→j, μπ→b, η/ι/υ→i …), spelling variants of the same sound are folded
 * together, and what is left is compared with "yonna", allowing a letter or
 * two of difference.
 *
 * Fuzzy matching is only trusted near the start of what was said (the first
 * few words), which is where people put his name, so ordinary words later in
 * a sentence cannot set him off. An exact spelling still counts anywhere.
 */

const EXACT =
  /(?<![\p{L}\p{N}])(?:yonna|yona|yonah|yonnah|yanna|jonna|jona|jonah|johna|joanna|johanna|iona|ionna|rianna|riana|rihanna|fionna|fiona|deanna|dionna|γιόνα|γιονα|γιόννα|γιοννα|γιώνα|τζόνα|τζονα)(?![\p{L}\p{N}])(?!'s)/iu

/** Words that may come before his name and are not part of the request. */
const GREETING = /^(?:hey|hi|ok|okay|yo|ει|γεια|σου|ρε|λοιπον)$/

const GREEK: [RegExp, string][] = [
  [/μπ/g, 'b'], [/ντ/g, 'd'], [/γκ/g, 'g'], [/τζ/g, 'j'], [/τσ/g, 'ts'],
  [/ου/g, 'u'], [/αι/g, 'e'], [/ει|οι|υι/g, 'i'],
  [/α/g, 'a'], [/β/g, 'v'], [/γ/g, 'g'], [/δ/g, 'd'], [/ε/g, 'e'], [/ζ/g, 'z'],
  [/[ηιυ]/g, 'i'], [/θ/g, 'th'], [/κ/g, 'k'], [/λ/g, 'l'], [/μ/g, 'm'], [/ν/g, 'n'],
  [/ξ/g, 'x'], [/[οω]/g, 'o'], [/π/g, 'p'], [/ρ/g, 'r'], [/[σς]/g, 's'], [/τ/g, 't'],
  [/φ/g, 'f'], [/χ/g, 'h'], [/ψ/g, 'ps'],
]

/** A rough pronunciation key: "Yonna" → "jona", "Γιόνα" → "jiona". */
export function soundKey(word: string): string {
  let w = word.toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '')
  for (const [re, to] of GREEK) w = w.replace(re, to)
  return w
    .replace(/[^a-z]/g, '')
    .replace(/^(?:dz|tz|ts|dj|ch|sh|zh|z|y|g(?=[ei]))/, 'j')
    .replace(/b/g, 'v')
    .replace(/w/g, 'v')
    .replace(/ee|ea|ie/g, 'i')
    .replace(/(.)\1+/g, '$1')
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = cur
    }
  }
  return row[b.length]
}

/** Does this sound like "Yonna"? Her name folds to "jona" (y → j, doubled
 *  letters as one). Short names are easy to collide with, so the match must
 *  start with her J/Y sound: that keeps "gonna", "Donna" and "wanna" from
 *  waking her, while "Yona", "Jonah", "Joanna" and "Γιόνα" still do. */
export function soundsLikeName(word: string): boolean {
  const k = soundKey(word)
  if (k.length < 3 || k.length > 7) return false
  if (k[0] !== 'j') return false
  const d = distance(k, 'jona')
  return d <= 1 || (d <= 2 && k.length >= 5)
}

type Span = { start: number; end: number }

/** Lower-case, accents off — "Γειά" and "γεια" are the same greeting. */
const plain = (w: string) => w.toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '')
const isGreeting = (w: string) => GREETING.test(plain(w))

/** Where his name is in the text, or null. */
export function findName(text: string): Span | null {
  const exact = EXACT.exec(text)
  if (exact) return { start: exact.index, end: exact.index + exact[0].length }

  // Fuzzy: only among the first few words, alone or as two words run together
  // ("τζαρ βις"), skipping a leading greeting.
  const words = [...text.matchAll(/[\p{L}\p{N}']+/gu)].map((m) => ({
    w: m[0],
    start: m.index!,
    end: m.index! + m[0].length,
  }))
  let i = 0
  while (i < words.length && i < 2 && isGreeting(words[i].w)) i++
  for (let n = i; n < Math.min(words.length, i + 3); n++) {
    if (soundsLikeName(words[n].w)) return { start: words[n].start, end: words[n].end }
    const next = words[n + 1]
    if (next && soundsLikeName(words[n].w + next.w)) return { start: words[n].start, end: next.end }
  }
  return null
}

export const hasName = (text: string): boolean => findName(text) !== null

/** Everything after his name — usually the actual request. */
export function afterName(text: string): string {
  const s = findName(text)
  if (!s) return ''
  return text.slice(s.end).replace(/^[\s,.:;!?-]+/, '').trim()
}

/** The request with a leading "Yonna," (and greeting) taken off. */
export function stripLeadingName(text: string): string {
  const s = findName(text)
  if (!s) return text.trim()
  // Only when the name is at the front: a name mid-sentence is part of it.
  const before = text.slice(0, s.start).trim()
  const greeting = before.split(/[\s,.!?]+/).filter(Boolean).every(isGreeting)
  if (before && !greeting) return text.trim()
  return text.slice(s.end).replace(/^[\s,.:;!?-]+/, '').trim()
}

/** Just his name, nothing asked. */
export const isBareName = (text: string): boolean => hasName(text) && stripLeadingName(text) === ''

/**
 * Her name as written: the recogniser often hears "Yonna" as Rianna, Fionna,
 * Johna, Jonah… Every such spelling is shown and sent as "Yonna", so the
 * caption reads right and the question reaches her addressed to her.
 */
export function fixName(text: string): string {
  const s = findName(text)
  if (!s) return text
  return text.slice(0, s.start) + 'Yonna' + fixName(text.slice(s.end))
}
