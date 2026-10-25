import { useEffect, useState } from 'react'
import { BRIDGE_HTTP_URL } from '../config'
import { useStore } from '../store'

/**
 * Today, bottom-left: a small "Today ›" that slides open today's calendar
 * events, straight from Apple Calendar (through the bridge's /agenda, which
 * uses the Yonna Calendar helper). Refreshes every few minutes and whenever
 * the window regains focus; past events dim and the next one is marked.
 * Whether it is open is remembered.
 */

type Agenda = {
  ok: boolean
  error?: string
  events: { title: string; start: string; end: string; allDay: boolean; location?: string }[]
}

const REFRESH_MS = 3 * 60_000
/** Open or closed, remembered. Closed to begin with, as in the design. */
const OPEN_KEY = 'yonna.today.open'

function loadOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1'
  } catch {
    return false
  }
}

const hhmm = (iso?: string) => (iso && iso.length >= 16 ? iso.slice(11, 16) : '')
const asDate = (iso: string) => new Date(iso.length === 16 ? `${iso}:00` : iso)

export function AgendaBox() {
  const phase = useStore((s) => s.phase)
  const [data, setData] = useState<Agenda | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [open, setOpen] = useState(loadOpen)
  const toggle = () =>
    setOpen((o) => {
      try {
        localStorage.setItem(OPEN_KEY, o ? '0' : '1')
      } catch {
        /* fine */
      }
      return !o
    })

  // Fetch now, every few minutes, and when the window comes back into focus.
  useEffect(() => {
    let alive = true
    const load = () =>
      fetch(`${BRIDGE_HTTP_URL}/agenda`)
        .then((r) => r.json())
        .then((d: Agenda) => alive && setData(d))
        .catch(() => alive && setData({ ok: false, error: 'bridge unreachable', events: [] }))
    void load()
    const t = setInterval(load, REFRESH_MS)
    window.addEventListener('focus', load)
    return () => {
      alive = false
      clearInterval(t)
      window.removeEventListener('focus', load)
    }
  }, [])

  // Re-evaluate "past" and "next" every minute.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  if (phase === 'offline' || phase === 'boot') return null

  // Today only, whatever the bridge sent.
  const today = new Date(now).toDateString()
  const events = (data?.events ?? []).filter((e) => asDate(e.start).toDateString() === today || e.allDay)
  const nextIdx = events.findIndex((e) => !e.allDay && asDate(e.end).getTime() > now)
  const date = new Date(now).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })

  return (
    <>
      <button type="button" className={`today-btn${open ? ' is-open' : ''}`} onClick={toggle} aria-expanded={open}>
        Today <span className="today-chev">›</span>
        {!open && events.length > 0 && <span className="today-count">{events.length}</span>}
      </button>
      <div className={`agenda${open ? ' is-open' : ''}`} aria-hidden={!open}>
        <div className="agenda-head">
          <span className="agenda-title-big">Today</span>
          <span className="agenda-date">{date}</span>
        </div>
        <div className="agenda-body">
          {!data && <div className="agenda-empty">Loading…</div>}
          {data && !data.ok && <div className="agenda-empty">Calendar unavailable</div>}
          {data?.ok && !events.length && <div className="agenda-empty">Nothing on today.</div>}
          {events.map((e, i) => {
            const past = !e.allDay && asDate(e.end).getTime() <= now
            return (
              <div key={`e${i}`} className={`agenda-row${past ? ' is-past' : ''}${i === nextIdx ? ' is-next' : ''}`}>
                <span className="agenda-time">{e.allDay ? 'all day' : hhmm(e.start)}</span>
                <span className="agenda-title">
                  {e.title}
                  {e.location ? <span className="agenda-sub">{e.location}</span> : null}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}
