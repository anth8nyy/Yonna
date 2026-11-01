import { execFile } from 'node:child_process'

/**
 * Calling someone — "call George", "call mum", "call Γιώργος" — from the
 * user's Contacts, by voice, with no AI.
 *
 * Names are matched however they're said or written: Greek or Latin letters,
 * with or without accents, and the usual English form of a Greek name —
 * "George" finds Γιώργος, "Nick" Νίκος, "Yorgos" Giorgos. Both sides are
 * reduced to a rough sound-key (Greek spelt out in Latin letters, then the
 * spellings that sound alike made the same) and compared.
 */

/* ---------------------------------------------------------- the contacts */

const READ = `
ObjC.import('Contacts')
function run() {
  const store = $.CNContactStore.alloc.init
  const keys = $(['givenName', 'familyName', 'nickname', 'phoneNumbers'].map((k) => $(k)))
  const req = $.CNContactFetchRequest.alloc.initWithKeysToFetch(keys)
  const out = []
  store.enumerateContactsWithFetchRequestErrorUsingBlock(req, Ref(), (c) => {
    const phones = []
    const n = c.phoneNumbers
    for (let i = 0; i < n.count; i++) {
      const p = n.objectAtIndex(i)
      phones.push({ label: ObjC.unwrap(p.label) || '', number: ObjC.unwrap(p.value.stringValue) })
    }
    if (phones.length) out.push({ given: ObjC.unwrap(c.givenName), family: ObjC.unwrap(c.familyName), nick: ObjC.unwrap(c.nickname), phones })
  })
  return JSON.stringify(out)
}`

let cache = null
let cachedAt = 0
/** Everyone in Contacts with a phone number; read again after ten minutes. */
function contacts() {
  if (cache && Date.now() - cachedAt < 600_000) return Promise.resolve(cache)
  return new Promise((resolve) =>
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', READ], { timeout: 20000, maxBuffer: 8 << 20 }, (err, out) => {
      if (err) return resolve(cache ?? null)
      try {
        cache = JSON.parse(out)
        cachedAt = Date.now()
      } catch {}
      resolve(cache)
    }),
  )
}

/* ------------------------------------------------------------ the names */

const GREEK = {
  α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm', ν: 'n',
  ξ: 'x', ο: 'o', π: 'p', ρ: 'r', σ: 's', ς: 's', τ: 't', υ: 'i', φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o',
}

/** Greek in Latin letters, the way names are usually spelt: Γιώργος → giorgos. */
function latin(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ου/g, 'ou').replace(/αι/g, 'e').replace(/ει|οι|υι/g, 'i')
    .replace(/αυ/g, 'av').replace(/ευ/g, 'ev')
    .replace(/[α-ως]/g, (c) => GREEK[c] ?? c)
}

/** A rough sound-key: Giorgos, Yiorgos, Yorgos and Γιώργος all → yorgos. */
function sound(s) {
  return latin(s)
    .replace(/[^a-z]/g, '')
    .replace(/^gi(?=[aeiou])/, 'y').replace(/^j/, 'y').replace(/^i(?=[aeo])/, 'y')
    .replace(/nt/g, 'd').replace(/mp/g, 'b').replace(/gk|ng|gg/g, 'g')
    .replace(/ph/g, 'f').replace(/th/g, 't').replace(/ch|kh/g, 'h').replace(/c(?=[eiy])/g, 's').replace(/c|q/g, 'k')
    .replace(/ou/g, 'u').replace(/ai|ae/g, 'e').replace(/ei|oi|ee|y(?![aeiou])/g, 'i').replace(/w/g, 'v')
    .replace(/(.)\1+/g, '$1')
}

/** The Greek name an English one stands for ("George" → Giorgos). */
const ENGLISH = {
  george: 'giorgos', georgie: 'giorgos', john: 'giannis', johnny: 'giannis', jack: 'giannis',
  nick: 'nikos', nicholas: 'nikolaos', nicolas: 'nikolaos', nikolas: 'nikolaos', mike: 'michalis', michael: 'michalis',
  peter: 'petros', pete: 'petros', constantine: 'konstantinos', costa: 'kostas', costas: 'kostas', gus: 'kostas',
  alex: 'alexandros', alexander: 'alexandros', chris: 'christos', christopher: 'christoforos', jim: 'dimitris',
  jimmy: 'dimitris', james: 'dimitris', demetris: 'dimitris', bill: 'vasilis', billy: 'vasilis', william: 'vasilis',
  basil: 'vasilis', steve: 'stefanos', steven: 'stefanos', stephen: 'stefanos', manny: 'manolis', tom: 'thomas',
  harry: 'charalampos', tony: 'antonis', anthony: 'antonis', paul: 'pavlos', mark: 'markos', andrew: 'andreas',
  philip: 'filippos', phil: 'filippos', theo: 'theodoros', ted: 'theodoros', luke: 'loukas', matthew: 'matthaios',
  greg: 'grigoris', gregory: 'grigoris', leo: 'leonidas', mary: 'maria', helen: 'eleni', ellen: 'eleni',
  kate: 'katerina', katherine: 'katerina', catherine: 'katerina', kathy: 'katerina', irene: 'eirini',
  sophie: 'sofia', sophia: 'sofia', joanna: 'ioanna', joan: 'ioanna', angela: 'angeliki', vicky: 'vasiliki',
  penny: 'pinelopi', penelope: 'pinelopi', margaret: 'margarita', christina: 'christina', dina: 'konstantina',
  tina: 'konstantina', georgia: 'georgia', anastasia: 'anastasia', natasha: 'anastasia', athena: 'athina',
  mom: 'mama', mum: 'mama', mother: 'mama', dad: 'babas', father: 'babas', daddy: 'babas', grandma: 'giagia',
  granny: 'giagia', grandpa: 'pappous', grandad: 'pappous',
}
/** The usual short forms of Greek names, both ways. */
const SHORT = [
  ['konstantinos', 'kostas', 'dinos'], ['nikolaos', 'nikos'], ['dimitrios', 'dimitris', 'mitsos', 'takis'],
  ['georgios', 'giorgos'], ['ioannis', 'giannis'], ['vasileios', 'vasilis'], ['emmanouil', 'manolis', 'manos'],
  ['athanasios', 'thanasis', 'thanos'], ['anastasios', 'tasos'], ['panagiotis', 'panos', 'takis'],
  ['charalampos', 'babis', 'charis'], ['spyridon', 'spiros'], ['stylianos', 'stelios'], ['eleftherios', 'lefteris'],
  ['aikaterini', 'katerina'], ['konstantina', 'dina', 'nantia'], ['vasiliki', 'vicky', 'vaso'],
  ['christoforos', 'christos'], ['michail', 'michalis'], ['alexandros', 'alexis'], ['evangelos', 'vangelis'],
  ['evangelia', 'litsa', 'evelina'], ['paraskevi', 'voula', 'vivi'], ['mama', 'mitera'], ['babas', 'pateras'],
]

/** Every sound-key a spoken name may mean. */
function meanings(said) {
  const words = latin(said).split(/\s+/).filter(Boolean)
  const first = words[0] ?? ''
  // "George" means Γιώργος, not someone saved as George (said with a surname
  // it's taken as written). Family words — mum, dad — keep both.
  const greekFor = ENGLISH[first]
  const onlyGreek = greekFor && !FAMILY.has(first) && words.length === 1
  const forms = new Set([onlyGreek ? null : first, greekFor].filter(Boolean))
  for (const group of SHORT) if (group.some((g) => forms.has(g))) group.forEach((g) => forms.add(g))
  return { first: [...forms].map(sound), rest: words.slice(1).map(sound), onlyGreek }
}
const FAMILY = new Set(['mom', 'mum', 'mother', 'dad', 'father', 'daddy', 'grandma', 'granny', 'grandpa', 'grandad'])

/** Contacts the spoken name fits, best first. */
async function find(said) {
  const all = await contacts()
  if (!all) return null
  const { first, rest, onlyGreek } = meanings(said)
  const whole = onlyGreek ? null : sound(said)
  const scored = []
  for (const c of all) {
    const given = (c.given ?? '').split(/\s+/).map(sound).filter(Boolean)
    // Every word of the name, whichever box it was saved in and in any order
    // ("Φλωρος Γιαννης" is John Floros too).
    const words = [...given, ...String(c.family ?? '').split(/\s+/).map(sound)].filter(Boolean)
    const nick = sound(c.nick)
    const full = sound(`${c.given} ${c.family}`)
    const others = (w) => words.filter((x) => x !== w)
    const restFits = (w) => rest.every((r) => others(w).some((x) => x.startsWith(r) || r.startsWith(x)))
    let score = 0
    if (nick && (nick === whole || first.includes(nick))) score = 5
    else if (full && full === whole) score = 5
    else if (given[0] && first.includes(given[0])) score = rest.length ? (restFits(given[0]) ? 4 : 0) : 3
    else {
      const w = words.find((x) => first.includes(x))
      if (w) score = rest.length ? (restFits(w) ? 4 : 0) : 3
      else if (!rest.length && given.some((g) => first.some((f) => f.length >= 4 && g.startsWith(f)))) score = 1
    }
    if (score) scored.push({ c, score })
  }
  scored.sort((a, b) => b.score - a.score)
  const top = scored.filter((s) => s.score === scored[0]?.score).map((s) => s.c)
  return top
}

/** A contact's name in Latin letters, so her English voice can say it: Γιώργος → Giorgos. */
const nameOf = (c) =>
  ([c.given, c.family].filter(Boolean).join(' ') || c.nick || 'them')
    .split(/\s+/)
    .map((w) => (/[α-ωΑ-Ω]/.test(w) ? latin(w).replace(/^./, (x) => x.toUpperCase()) : w))
    .join(' ')

/** The number to call: a mobile first. */
function numberOf(c) {
  const mobile = c.phones.find((p) => /mobile|iphone|κινητ/i.test(p.label)) ?? c.phones[0]
  return mobile.number.replace(/[^\d+]/g, '')
}

/**
 * Who "call <name>" means: { say, tel } — tel is the number to call, or
 * missing when it's unclear (nobody, or several people to choose between).
 */
export async function whoToCall(said) {
  const name = String(said ?? '').trim()
  if (!name) return { say: 'Who should I call?' }
  // A number said aloud: called as it is.
  if (/^[+\d][\d\s-]{5,}$/.test(name)) return { say: `Calling ${name}.`, tel: name.replace(/[^\d+]/g, '') }
  const found = await find(name)
  if (found === null) return { say: "I can't read your Contacts — Yonna needs to be allowed to in Privacy & Security, Contacts." }
  if (!found.length) return { say: `I couldn't find ${name} in your Contacts.` }
  // The same person saved twice (same number): just them.
  if (new Set(found.map(numberOf)).size === 1) found.length = 1
  if (found.length > 1) {
    const seen = new Set()
    const names = found.map(nameOf).filter((n) => !seen.has(sound(n)) && seen.add(sound(n))).slice(0, 4)
    return { say: `Which one — ${names.slice(0, -1).join(', ')} or ${names.at(-1)}? Say the full name.` }
  }
  return { say: `Calling ${nameOf(found[0])}.`, tel: numberOf(found[0]) }
}

/**
 * Calls from this Mac — through the iPhone ("Calls from iPhone" in FaceTime's
 * settings), so it is a real phone call from the user's own number.
 */
export async function callFromMac(said) {
  const who = await whoToCall(said)
  if (who.tel) {
    execFile('/usr/bin/open', [`tel://${who.tel}`], () => {})
    // macOS asks "Click to Call" first; the shortcut helper presses it.
    pressCall?.()
  }
  return who.say
}

/** Set by the bridge: asks the shortcut helper to press macOS's Call button. */
let pressCall = null
export function onCallPrompt(fn) {
  pressCall = fn
}

/** Contacts' names in Latin letters, for the recognizer to expect. */
export async function contactWords() {
  const all = (await contacts()) ?? []
  return [...new Set(all.flatMap((c) => nameOf(c).split(/\s+/)).filter((w) => w.length > 2))]
}

export { sound as _sound, find as _find }
