import { execFile } from 'node:child_process'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * Safari, as a window the user can watch.
 *
 * Not how Yonna finds things out — WebSearch and WebFetch do that, and return
 * text he can actually read. This is the visible half: the search, or the page
 * he found, opened in Safari so the user sees him go and look.
 *
 * Deliberately tiny. It can open a web address in Safari and nothing else: no
 * reading the page back, no clicking, no typing, no other scheme. Opening a
 * page changes nothing in the world, so it needs no write access — and keeping
 * it this small is what makes that true.
 */

const ok = (text) => ({ content: [{ type: 'text', text }] })

function openInSafari(url) {
  return new Promise((resolve) => {
    execFile('/usr/bin/open', ['-a', 'Safari', url], (err) =>
      resolve(err ? String(err.message ?? err) : null),
    )
  })
}

/** Only real web addresses. A file:// or custom scheme could launch things. */
function webUrl(raw) {
  try {
    const u = new URL(String(raw ?? '').trim())
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
  } catch {
    return null
  }
}

export function safariServer() {
  return createSdkMcpServer({
    name: 'yonna_safari',
    version: '1.0.0',
    instructions:
      'Opens a web search or a web page in Safari — when the user asks for ' +
      'Safari, or wants to buy something. Ordinary lookups never use it.',
    alwaysLoad: true,
    tools: [
      tool(
        'safari_search',
        'Open a Google search for the query in Safari, in front of the user. ' +
          'Only when they ask to see a search in Safari, or want to buy something ' +
          'and no single shop page is clearly best — never for an ordinary ' +
          'lookup, which uses WebSearch and a blade. It returns no results itself.',
        { query: z.string().min(1).describe('What to search for, as the user would type it.') },
        async ({ query }) => {
          const url = `https://www.google.com/search?q=${encodeURIComponent(query.trim())}`
          const err = await openInSafari(url)
          return ok(err ? `Safari could not be opened: ${err}` : 'Search open in Safari.')
        },
      ),
      tool(
        'safari_open',
        'Open one web page in Safari, in front of the user — the page they ' +
          'asked to see, or the shop page to buy what they asked about. Only ' +
          'http or https addresses that came from a tool result.',
        { url: z.string().describe('The full http(s) address.') },
        async ({ url }) => {
          const target = webUrl(url)
          if (!target) return ok('Not opened: only http and https addresses are allowed.')
          const err = await openInSafari(target)
          return ok(err ? `Safari could not be opened: ${err}` : 'Page open in Safari.')
        },
      ),
    ],
  })
}
