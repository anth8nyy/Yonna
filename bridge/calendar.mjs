import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * Apple Calendar and Reminders.
 *
 * The work is done by "Yonna Calendar.app", a small native helper built by
 * scripts/desktop-app/build.sh: macOS grants calendar access only to a real app
 * that asks under its own name, which this Node process cannot. Each call
 * writes a request file, launches the helper through LaunchServices (so it is
 * its own app as far as privacy is concerned), and waits for its answer file.
 */

const HELPER = join(homedir(), 'Library/Application Support/Yonna/Yonna Calendar.app')
/** Long enough for a first-time permission prompt to be answered. */
const TIMEOUT_MS = 130_000

const ok = (text) => ({ content: [{ type: 'text', text }] })

export async function call(request) {
  if (!existsSync(HELPER)) {
    return { ok: false, error: 'The calendar helper is not installed. Rebuild the desktop app.' }
  }
  const id = randomUUID()
  const req = join(tmpdir(), `yonna-cal-${id}.req.json`)
  const res = join(tmpdir(), `yonna-cal-${id}.res.json`)
  await writeFile(req, JSON.stringify(request))
  try {
    await new Promise((resolve) =>
      execFile('/usr/bin/open', ['-n', '-g', '-a', HELPER, '--args', req, res], () => resolve()),
    )
    // Poll for the answer rather than trusting `open -W`, which sometimes
    // returns before a fast helper has written anything.
    const until = Date.now() + TIMEOUT_MS
    while (Date.now() < until) {
      try {
        return JSON.parse(await readFile(res, 'utf8'))
      } catch {
        await new Promise((r) => setTimeout(r, 120))
      }
    }
    return { ok: false, error: 'The calendar did not answer in time.' }
  } finally {
    await rm(req, { force: true })
    await rm(res, { force: true })
  }
}

const reply = (r) => ok(r.ok ? JSON.stringify(r) : `Failed: ${r.error}`)

const when = (note) => z.string().optional().describe(note)
const LOCAL =
  'Local time as YYYY-MM-DDTHH:MM (e.g. 2026-10-16T15:30), or YYYY-MM-DD for a whole day.'

/**
 * Today, for the agenda box on screen: today's calendar events only — no
 * other days and no reminders, at the user's request. Cached briefly; the
 * page asks every few minutes and each call launches the helper app.
 */
let agendaCache = null
export async function agenda() {
  if (agendaCache && Date.now() - agendaCache.at < 60_000) return agendaCache.data
  const pad = (n) => String(n).padStart(2, '0')
  const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const start = new Date()
  const end = new Date(start.getTime() + 86_400_000)
  const ev = await call({ op: 'events.list', from: day(start), to: day(end) })
  const data = {
    ok: Boolean(ev.ok),
    error: ev.ok ? undefined : ev.error,
    events: (ev.events ?? []).map((e) => ({
      title: e.title, start: e.start, end: e.end, allDay: e.allDay, location: e.location,
    })),
  }
  agendaCache = { at: Date.now(), data }
  return data
}

export function calendarServer() {
  return createSdkMcpServer({
    name: 'yonna_calendar',
    version: '1.0.0',
    instructions:
      "The user's Apple Calendar and Reminders: read the schedule, and create, " +
      'change or delete events and reminders. Times are local.',
    alwaysLoad: true,
    tools: [
      tool(
        'calendar_events',
        "List events on the user's calendars between two times — what is on " +
          'their schedule today, tomorrow, this week. Defaults to today.',
        { from: when(`Start. ${LOCAL} Default: start of today.`), to: when(`End. ${LOCAL} Default: a day after from.`) },
        async (a) => reply(await call({ op: 'events.list', ...a })),
      ),
      tool(
        'calendar_create_event',
        'Add an event to the calendar — a meeting, appointment, plan. Use for ' +
          'things that happen at a time and take time.',
        {
          title: z.string().describe('What it is.'),
          start: z.string().describe(`When it starts. ${LOCAL}`),
          end: when(`When it ends. ${LOCAL} Default: an hour after start.`),
          all_day: z.boolean().optional().describe('An all-day event.'),
          location: z.string().optional(),
          notes: z.string().optional(),
          alert_minutes_before: z.number().optional().describe('Alert this many minutes before. Omit for none.'),
          calendar: z.string().optional().describe('Calendar name, e.g. "Work". Default: the default calendar.'),
        },
        async (a) =>
          reply(
            await call({
              op: 'events.create', title: a.title, start: a.start, end: a.end, allDay: a.all_day,
              location: a.location, notes: a.notes, alertMinutesBefore: a.alert_minutes_before,
              calendar: a.calendar,
            }),
          ),
      ),
      tool(
        'calendar_update_event',
        'Change an existing event — move it, rename it, change its alert. Get ' +
          'its id from calendar_events first. Only the fields given change.',
        {
          id: z.string().describe('The id from calendar_events.'),
          title: z.string().optional(),
          start: when(LOCAL),
          end: when(LOCAL),
          all_day: z.boolean().optional(),
          location: z.string().optional(),
          notes: z.string().optional(),
          alert_minutes_before: z.number().optional().describe('New alert; -1 removes it.'),
        },
        async (a) =>
          reply(
            await call({
              op: 'events.update', id: a.id, title: a.title, start: a.start, end: a.end,
              allDay: a.all_day, location: a.location, notes: a.notes,
              alertMinutesBefore: a.alert_minutes_before,
            }),
          ),
      ),
      tool(
        'calendar_delete_event',
        'Delete one event (this occurrence only, for a repeating one). Get its ' +
          'id from calendar_events. Only after the user has confirmed.',
        { id: z.string().describe('The id from calendar_events.') },
        async (a) => reply(await call({ op: 'events.delete', id: a.id })),
      ),
      tool(
        'reminders_list',
        'List open reminders from the Reminders app, optionally only those due ' +
          'between two times.',
        { from: when(`Due from. ${LOCAL}`), to: when(`Due until. ${LOCAL}`) },
        async (a) => reply(await call({ op: 'reminders.list', ...a })),
      ),
      tool(
        'reminder_create',
        'Create a reminder in the Reminders app — "remind me to call mum at ' +
          'six". With a due time it alerts at that time.',
        {
          title: z.string().describe('What to be reminded of.'),
          due: when(`When it is due. ${LOCAL} Omit for no due date.`),
          notes: z.string().optional(),
          list: z.string().optional().describe('Reminders list name. Default: the default list.'),
        },
        async (a) => reply(await call({ op: 'reminders.create', ...a })),
      ),
      tool(
        'reminder_update',
        'Change a reminder — new title, new time, or mark it done. Get its id ' +
          'from reminders_list first. Only the fields given change.',
        {
          id: z.string().describe('The id from reminders_list.'),
          title: z.string().optional(),
          due: when(`${LOCAL} Use "none" to remove the due date.`),
          notes: z.string().optional(),
          completed: z.boolean().optional().describe('true marks it done.'),
        },
        async (a) => reply(await call({ op: 'reminders.update', ...a })),
      ),
      tool(
        'reminder_delete',
        'Delete a reminder. Get its id from reminders_list. Only after the user ' +
          'has confirmed.',
        { id: z.string().describe('The id from reminders_list.') },
        async (a) => reply(await call({ op: 'reminders.delete', id: a.id })),
      ),
    ],
  })
}
