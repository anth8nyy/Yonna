/**
 * Trimming old words off the front of a new question.
 *
 * Even with a fresh recogniser after every answer, a few words can still ride
 * in: the end of his own reply arriving late from the microphone, or the
 * user's previous question repeated by the recogniser. Glued to the front of
 * the new question, they turn "what about tomorrow" into a garbled re-ask of
 * the last exchange. This removes such a lead-in — and only a lead-in: at
 * least three words in a row that match what was just said, with the real
 * question still left after it.
 */

const norm = (w: string) =>
  w.toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '').replace(/[^\p{L}\p{N}]+/gu, '')

// Hyphens split words too: he writes "twenty-six", the recogniser hears "twenty six".
const words = (s: string) => s.split(/[\s\-–—]+/).filter(Boolean)

/** How many leading words of `text` appear, in order and unbroken, in `source`. */
function sharedLead(text: string[], source: string[]): number {
  let best = 0
  for (let start = 0; start < source.length; start++) {
    let k = 0
    while (k < text.length && start + k < source.length && text[k] === source[start + k]) k++
    if (k > best) best = k
  }
  return best
}

/**
 * @param text      what the recogniser handed over as the new question
 * @param spoken    what Yonna has just been saying (his echo)
 * @param previous  the user's previous question
 * @returns the question with any carried-over lead-in removed; '' when the
 *          whole thing was only his own words coming back
 */
export function trimCarryOver(text: string, spoken: string, previous: string): string {
  const raw = words(text)
  const keys = raw.map(norm)
  let cut = 0

  const echo = sharedLead(keys, words(spoken).map(norm).filter(Boolean))
  // Entirely his own words: nothing was asked.
  if (echo >= 3 && echo === keys.length) return ''
  if (echo >= 3 && keys.length - echo >= 2) cut = echo

  // The previous question repeated in front of a new one. A question asked
  // again on its own is a real question, so it is never removed outright.
  const rest = keys.slice(cut)
  const again = sharedLead(rest, words(previous).map(norm).filter(Boolean))
  if (again >= 3 && rest.length - again >= 2) cut += again

  return cut ? raw.slice(cut).join(' ').replace(/^[\s,.;:!?-]+/, '') : text.trim()
}
