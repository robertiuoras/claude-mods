import type { SessionMessage } from 'claude-code'

/** Every link the session has met so far, by normalized URL. */
export type Sources = {
  /** Fetched: a tool's `url` input (WebFetch, browser tools) or a URL in a shell command. */
  opened: Set<string>
  /** Listed in a web search's results. */
  searched: Set<string>
  /** In the person's own messages or another tool's output (a file read, `gh pr create`). */
  given: Set<string>
}

/** What the check found in one answer; each list holds URLs as the answer spelled them. */
export type Check = {
  links: number
  unopened: string[]
  searchOnly: string[]
}

export const MAX_LISTED = 5

const URL_PATTERN = /https?:\/\/[^\s<>"'`\\^{}|[\]]+/gi
const TRAILING_PUNCTUATION = /[.,;:!?*_~]$/
// This machine and the reserved example names: a link to them is never a citation.
const LOCAL_HOST =
  /^(localhost|127(\.\d+){3}|0\.0\.0\.0|\[::1\])$|\.(localhost|local|test|invalid|example)$|^(.+\.)?example\.(com|net|org)$/
// A heredoc's body is text the command writes (a file, a commit message), not a URL it fetches.
const HEREDOC = /<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g
const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n {0,3}\1[ \t]*$/gm

// A web search lists links it did not open.
const SEARCH_TOOLS = new Set(['WebSearch'])
// A sub-agent's answer is model writing, not a source; its own fetches count as they run.
const AGENT_TOOLS = new Set(['Agent', 'Task'])

export function emptySources(): Sources {
  return { opened: new Set(), searched: new Set(), given: new Set() }
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function countOf(text: string, char: string): number {
  return text.split(char).length - 1
}

/** Drops what prose wraps around a URL: a sentence's full stop, markdown's `)`, `**`. */
export function trimUrl(raw: string): string {
  let url = raw
  for (;;) {
    if (TRAILING_PUNCTUATION.test(url)) url = url.slice(0, -1)
    // A `)` closes the URL's own `(` (Wikipedia's `Foo_(bar)`) or the markdown around it.
    else if (url.endsWith(')') && countOf(url, '(') < countOf(url, ')')) url = url.slice(0, -1)
    else return url
  }
}

export function findUrls(text: string): string[] {
  return (text.match(URL_PATTERN) ?? []).map(trimUrl)
}

/** One spelling per page: lowercase host, http as https, no #fragment, trailing slash or punctuation. */
export function normalizeUrl(url: string): string | undefined {
  const match = /^https?:\/\/([^/?#]*)([^#]*)/i.exec(trimUrl(url))
  if (!match) return undefined
  const [, authority = '', after = ''] = match

  const host = authority
    .toLowerCase()
    .replace(/^[^@]*@/, '')
    .replace(/:(80|443)$/, '')
  if (host === '') return undefined

  const rest = trimUrl(after)
  const at = rest.indexOf('?')
  const path = (at < 0 ? rest : rest.slice(0, at)).replace(/\/+$/, '')
  const query = at < 0 ? '' : rest.slice(at)

  return `https://${host}${path}${query}`
}

export function isLocal(normalized: string): boolean {
  const host = normalized.slice('https://'.length).split(/[/?]/)[0] ?? ''

  return LOCAL_HOST.test(host.replace(/:\d+$/, ''))
}

function addAll(into: Set<string>, urls: readonly string[]) {
  for (const url of urls) {
    const key = normalizeUrl(url)
    if (key !== undefined) into.add(key)
  }
}

/** Files one tool call: its `url` and shell `command` inputs as opened, its output as searched or given. */
export function noteCall(
  sources: Sources,
  tool: string,
  input: Readonly<Record<string, unknown>>,
  output?: string,
) {
  const url = input.url
  // Browser tools take a bare `example.org`; WebFetch takes the full URL.
  if (typeof url === 'string') addAll(sources.opened, findUrls(/^https?:/i.test(url) ? url : `https://${url}`))

  const command = input.command
  if (typeof command === 'string') addAll(sources.opened, findUrls(command.replace(HEREDOC, '')))

  if (output === undefined || AGENT_TOOLS.has(tool)) return
  addAll(SEARCH_TOOLS.has(tool) ? sources.searched : sources.given, findUrls(output))
}

/** Files one transcript row: the person's text as given, each tool call as `noteCall` does. */
export function noteMessage(sources: Sources, message: SessionMessage) {
  if (message.role === 'user') addAll(sources.given, findUrls(message.text))
  for (const use of message.toolUses) noteCall(sources, use.tool, use.input, use.text)
}

/** Sorts the answer's links (code blocks and local hosts left out) by what the session did with each. */
export function checkAnswer(answer: string, sources: Sources): Check {
  const firstSpelling = new Map<string, string>()
  for (const url of findUrls(answer.replace(CODE_FENCE, ''))) {
    const key = normalizeUrl(url)
    if (key === undefined || isLocal(key) || firstSpelling.has(key)) continue
    firstSpelling.set(key, url)
  }

  const unopened: string[] = []
  const searchOnly: string[] = []
  for (const [key, url] of firstSpelling) {
    if (sources.opened.has(key) || sources.given.has(key)) continue
    if (sources.searched.has(key)) searchOnly.push(url)
    else unopened.push(url)
  }

  return { links: firstSpelling.size, unopened, searchOnly }
}

function listed(urls: readonly string[]): string {
  const more = urls.length - MAX_LISTED

  return [...urls.slice(0, MAX_LISTED), ...(more > 0 ? [`+${more} more`] : [])].join(', ')
}

/**
 * The line shown beneath the answer, or nothing when every link was opened.
 * One line: the engine shows a newline in it as a replacement character.
 */
export function noteText(check: Check): string | undefined {
  if (check.unopened.length === 0 && check.searchOnly.length === 0) return undefined

  const parts = [`${plural(check.links, 'link')} in this answer`]
  if (check.unopened.length > 0) parts.push(`${check.unopened.length} never opened: ${listed(check.unopened)}`)
  if (check.searchOnly.length > 0) {
    parts.push(`${check.searchOnly.length} only seen in search results: ${listed(check.searchOnly)}`)
  }

  return parts.join(' · ')
}
