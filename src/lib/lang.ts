/**
 * Which language Yonna listens and speaks in: English or Greek.
 *
 * The browser's speech recogniser hears one language at a time, so this is a
 * switch the user flips (the EN/ΕΛ button, or L) rather than something guessed.
 * It decides the recogniser's language, the voice he speaks with and the
 * stock phrases he uses; the brain simply answers in whatever language it is
 * spoken to. Remembered between sessions.
 */

export type Lang = 'en' | 'el'

const KEY = 'yonna.lang'

/**
 * Always English now. Spoken Greek did not work well enough, so Greek is
 * typed into the box at the bottom instead and answered in English. The
 * switch is kept (unused) rather than torn out of every module that reads it;
 * a stored "el" from before is cleared.
 */
let current: Lang = 'en'
try {
  localStorage.removeItem(KEY)
} catch {
  /* nothing stored */
}

const listeners = new Set<(l: Lang) => void>()

export const lang = (): Lang => current
export const isGreek = (): boolean => current === 'el'

/** BCP-47 tag for the speech recogniser and voice selection. */
export const speechLang = (): string => (current === 'el' ? 'el-GR' : 'en-GB')

export function setLang(next: Lang): void {
  if (next === current) return
  current = next
  try {
    localStorage.setItem(KEY, next)
  } catch {
    /* private window — still switches for this session */
  }
  for (const f of listeners) f(next)
}

export function onLang(f: (l: Lang) => void): () => void {
  listeners.add(f)
  return () => listeners.delete(f)
}
