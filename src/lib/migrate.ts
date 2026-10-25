/**
 * Settings saved before the rename lived under "jarvis.*" keys. Copied once to
 * their "yonna.*" names, so the chosen voice, brain and the rest carry over.
 * Imported first in main.tsx, before anything reads them.
 */
try {
  for (let i = 0; i < localStorage.length; i++) {
    const old = localStorage.key(i)
    if (!old?.startsWith('jarvis.')) continue
    const now = 'yonna.' + old.slice('jarvis.'.length)
    if (localStorage.getItem(now) === null) localStorage.setItem(now, localStorage.getItem(old)!)
  }
} catch {
  /* no storage: nothing to carry over */
}

export {}
