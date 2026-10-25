import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * Creating files and folders on the user's Mac.
 *
 * A narrow tool on purpose, instead of opening up Write/Bash: it can make a
 * folder, make a file, and show either in Finder. It never deletes, and it
 * never replaces an existing file unless told to after the user has said yes.
 *
 * "Anywhere" means anywhere the user's own files live — their home folder and
 * external drives — minus the places where a planted file changes how the Mac
 * behaves: hidden dotfiles and ~/Library. Those are where a webpage or message
 * trying to trick Yonna would aim, and the user never needs Yonna there.
 */

const HOME = homedir()
const ok = (text) => ({ content: [{ type: 'text', text }] })

/** "~/Desktop/x", "Desktop/x" and "/Users/…/Desktop/x" all mean the same place. */
function resolvePath(raw) {
  let p = String(raw ?? '').trim().replace(/^["']|["']$/g, '')
  if (!p) return null
  if (p === '~') p = HOME
  else if (p.startsWith('~/')) p = join(HOME, p.slice(2))
  else if (!isAbsolute(p)) p = join(HOME, p)
  return normalize(resolve(p))
}

/** Why a path is off limits, or null if it is fine. */
function refuseReason(path) {
  const inHome = path === HOME || path.startsWith(HOME + '/')
  const onDrive = path.startsWith('/Volumes/')
  if (!inHome && !onDrive) return 'Only your home folder and external drives are allowed.'
  if (inHome) {
    const parts = relative(HOME, path).split('/').filter(Boolean)
    if (parts[0] === 'Library') return 'The Library folder holds settings and is left alone.'
    if (parts.some((s) => s.startsWith('.'))) return 'Hidden files and folders are left alone.'
  }
  return null
}

const pretty = (p) => (p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p)

function reveal(path) {
  execFile('/usr/bin/open', ['-R', path], () => {})
}

export function filesServer() {
  return createSdkMcpServer({
    name: 'yonna_files',
    version: '1.0.0',
    instructions:
      "Creates folders and files on the user's Mac (home folder and external " +
      'drives). Never deletes; never overwrites without the user saying yes.',
    alwaysLoad: true,
    tools: [
      tool(
        'create_folder',
        'Create a folder (and any missing folders above it). Paths may be ' +
          '"~/Desktop/School/Physics", "Documents/Notes", or absolute. Fine if it already exists.',
        {
          path: z.string().describe('Where the folder goes.'),
          reveal: z.boolean().optional().describe('Show it in Finder afterwards.'),
        },
        async ({ path, reveal: show }) => {
          const target = resolvePath(path)
          if (!target) return ok('Not created: no path given.')
          const why = refuseReason(target)
          if (why) return ok(`Not created: ${why}`)
          if (existsSync(target) && !statSync(target).isDirectory()) {
            return ok(`Not created: a file already has that name (${pretty(target)}).`)
          }
          try {
            const existed = existsSync(target)
            await mkdir(target, { recursive: true })
            if (show) reveal(target)
            return ok(existed ? `Already exists: ${pretty(target)}` : `Folder created: ${pretty(target)}`)
          } catch (err) {
            return ok(`Could not create it: ${err.message}`)
          }
        },
      ),
      tool(
        'create_file',
        'Create a file with the given text content, making any missing folders. ' +
          'Pick a sensible name and extension (.txt, .md, .py, .html, .csv…). If the ' +
          'file already exists this refuses — then ask the user, and only with their ' +
          'yes call again with overwrite: true.',
        {
          path: z.string().describe('Full path including the file name, e.g. "~/Desktop/shopping.txt".'),
          content: z.string().describe('The whole text of the file.'),
          overwrite: z.boolean().optional().describe('Replace an existing file. ONLY after the user said yes.'),
          reveal: z.boolean().optional().describe('Show it in Finder afterwards.'),
        },
        async ({ path, content, overwrite, reveal: show }) => {
          const target = resolvePath(path)
          if (!target) return ok('Not created: no path given.')
          const why = refuseReason(target)
          if (why) return ok(`Not created: ${why}`)
          if (existsSync(target)) {
            if (statSync(target).isDirectory()) return ok(`Not created: a folder already has that name (${pretty(target)}).`)
            if (!overwrite) {
              return ok(`Not created: ${pretty(target)} already exists. Ask the user whether to replace it.`)
            }
          }
          if (content.length > 5_000_000) return ok('Not created: that is too large for a text file.')
          try {
            await mkdir(dirname(target), { recursive: true })
            await writeFile(target, content, 'utf8')
            if (show) reveal(target)
            return ok(`${overwrite ? 'File replaced' : 'File created'}: ${pretty(target)}`)
          } catch (err) {
            return ok(`Could not create it: ${err.message}`)
          }
        },
      ),
      tool(
        'reveal_in_finder',
        'Show a file or folder in Finder, selected.',
        { path: z.string() },
        async ({ path }) => {
          const target = resolvePath(path)
          if (!target || !existsSync(target)) return ok('Nothing exists at that path.')
          reveal(target)
          return ok(`Shown in Finder: ${pretty(target)}`)
        },
      ),
    ],
  })
}
