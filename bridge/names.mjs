/**
 * The closest real name to a misheard one — "Valant", "Valιrant" and
 * "Valorent" are all VALORANT. Speech recognition gets unusual names a little
 * wrong; this finds the name it was meant to be among the ones that exist
 * (installed apps, the PC's apps, websites), and only when one is clearly
 * nearest, so an unknown name is never turned into a wrong app.
 */

const GREEK = {
  α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm', ν: 'n',
  ξ: 'x', ο: 'o', π: 'p', ρ: 'r', σ: 's', ς: 's', τ: 't', υ: 'y', φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o',
}

/** Letters and digits only, lower case, Greek letters as Latin ones. */
export function flat(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[α-ως]/g, (c) => GREEK[c] ?? c)
    .replace(/[^a-z0-9]/g, '')
}

/** How many single-letter changes turn a into b. */
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = keep
    }
  }
  return row[b.length]
}

/** Vowels sound alike when misheard: compared without them too. */
const bones = (s) => s[0] + s.slice(1).replace(/[aeiouy]/g, '')

/**
 * The name in `names` that `said` most likely is, or null. Exact and
 * starts-with matches first; then the nearest by spelling, if it is close
 * (about one change in four letters) and clearly nearer than any other.
 */
export function closest(said, names) {
  const s = flat(said)
  if (s.length < 3) return null
  // One entry per name however it's written ("YouTube", "youtube").
  const seen = new Set()
  const list = [...names].map((n) => ({ n, f: flat(n) })).filter((x) => x.f.length >= 3 && !seen.has(x.f) && seen.add(x.f))
  const exact = list.find((x) => x.f === s)
  if (exact) return exact.n
  const starts = list.filter((x) => x.f.startsWith(s) || s.startsWith(x.f) && x.f.length >= 5)
  if (starts.length === 1) return starts[0].n
  const scored = list
    .map((x) => {
      const d = Math.min(distance(s, x.f), distance(bones(s), bones(x.f)) + 1)
      return { n: x.n, score: d / Math.max(s.length, x.f.length) }
    })
    .sort((a, b) => a.score - b.score)
  const [best, next] = scored
  if (!best || best.score > 0.3) return null
  if (next && next.score - best.score < 0.08) return null // two about as close: no guess
  return best.n
}
