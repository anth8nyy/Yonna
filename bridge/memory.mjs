import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * Long-term memory: things the user wants Yonna to know next time.
 *
 * A conversation lives only as long as its socket — close the window and it
 * is gone. This file is what survives: short facts, each one something the
 * user told him to remember (or plainly would want kept), loaded into the
 * system prompt at the start of every session.
 *
 * Plain JSON in Yonna's own support folder, so the user can read or clear it
 * by hand, and nothing about it leaves the machine.
 */

export const MEMORY_FILE = join(homedir(), 'Library/Application Support/Yonna/memory.json')
/** Enough to be useful, small enough to ride along on every turn. */
const MAX_FACTS = 200
const MAX_FACT_CHARS = 300

const ok = (text) => ({ content: [{ type: 'text', text }] })

export function loadMemories() {
  try {
    const list = JSON.parse(readFileSync(MEMORY_FILE, 'utf8'))
    return Array.isArray(list) ? list.filter((m) => m && typeof m.fact === 'string') : []
  } catch {
    return []
  }
}

function saveMemories(list) {
  mkdirSync(dirname(MEMORY_FILE), { recursive: true })
  const tmp = `${MEMORY_FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(list, null, 2))
  renameSync(tmp, MEMORY_FILE) // atomic: a crash mid-write cannot lose the file
}

/** Forgets one note by id — from the settings panel. */
export function forgetMemory(id) {
  const list = loadMemories()
  const left = list.filter((m) => m.id !== id)
  if (left.length !== list.length) saveMemories(left)
  return left.length !== list.length
}

const squash = (s) => s.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim()

/** The memory section of the system prompt, built fresh for each session. */
export function memoryPrompt() {
  const list = loadMemories()
  const body = list.length
    ? list.map((m) => `- ${m.fact}`).join('\n')
    : '- (nothing yet)'
  return `What you remember about them (from earlier sessions — true unless they say otherwise):
${body}

Remembering:
- When they tell you to remember something, or tell you a lasting fact about
  themselves — their name, family, preferences, routines, plans — save it with
  \`memory_save\` as one short sentence. Then just "Noted, sir."
- When they say to forget something, \`memory_forget\` it.
- Use what you remember naturally; never recite the list unless asked
  ("what do you remember about me?" — then \`memory_list\`, and show it).
- Never save passwords, card numbers or other secrets.`
}

export function memoryServer() {
  return createSdkMcpServer({
    name: 'yonna_memory',
    version: '1.0.0',
    instructions:
      'Long-term memory that survives restarts. Save lasting facts the user ' +
      'wants remembered; forget them on request.',
    alwaysLoad: true,
    tools: [
      tool(
        'memory_save',
        'Remember a fact for future sessions — one short sentence in the third ' +
          'person, e.g. "Their favourite team is Olympiacos." Updates an ' +
          'existing memory on the same subject rather than duplicating it when ' +
          'you pass its id as replaces.',
        {
          fact: z.string().min(2).describe('The fact, one short sentence.'),
          replaces: z.string().optional().describe('Id of an older memory this one supersedes.'),
        },
        async ({ fact, replaces }) => {
          const text = fact.trim().slice(0, MAX_FACT_CHARS)
          let list = loadMemories()
          if (replaces) list = list.filter((m) => m.id !== replaces)
          if (list.some((m) => squash(m.fact) === squash(text))) return ok('Already remembered.')
          list.push({ id: randomUUID().slice(0, 8), fact: text, at: new Date().toISOString() })
          if (list.length > MAX_FACTS) list = list.slice(-MAX_FACTS)
          saveMemories(list)
          return ok(`Remembered: ${text}`)
        },
      ),
      tool(
        'memory_forget',
        'Forget memories — by id, or every memory containing the given words. ' +
          'Use when the user says to forget something or that a fact is wrong.',
        { match: z.string().min(1).describe('A memory id, or words it contains.') },
        async ({ match }) => {
          const list = loadMemories()
          const q = squash(match)
          const keep = list.filter((m) => m.id !== match && !(q && squash(m.fact).includes(q)))
          const gone = list.length - keep.length
          if (!gone) return ok('No memory matched that.')
          saveMemories(keep)
          return ok(`Forgot ${gone} memor${gone === 1 ? 'y' : 'ies'}.`)
        },
      ),
      tool(
        'memory_list',
        'List everything remembered, with ids. Use when they ask what you ' +
          'remember, or before replacing or forgetting a specific memory.',
        {},
        async () => {
          const list = loadMemories()
          return ok(list.length ? list.map((m) => `${m.id}: ${m.fact}`).join('\n') : 'Nothing is remembered yet.')
        },
      ),
    ],
  })
}
