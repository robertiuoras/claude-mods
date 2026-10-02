import { describe, expect, test } from 'claude-code/testing'

import {
  MAX_LISTED,
  checkAnswer,
  emptySources,
  findUrls,
  isLocal,
  normalizeUrl,
  noteCall,
  noteMessage,
  noteText,
  trimUrl,
} from './model'

describe('normalizeUrl', () => {
  test('one spelling per page', () => {
    const same = [
      'https://Docs.Example.org/guide',
      'http://docs.example.org/guide',
      'https://docs.example.org/guide/',
      'https://docs.example.org/guide#install',
      'https://docs.example.org/guide.',
      'https://docs.example.org:443/guide',
      'http://docs.example.org:80/guide/#top',
    ]
    for (const url of same) expect(normalizeUrl(url)).toBe('https://docs.example.org/guide')
  })

  test('keeps the query and the path case', () => {
    expect(normalizeUrl('https://a.dev/Search/?q=Claude#x')).toBe('https://a.dev/Search?q=Claude')
    expect(normalizeUrl('https://a.dev/')).toBe('https://a.dev')
    expect(normalizeUrl('https://a.dev:8443/x')).toBe('https://a.dev:8443/x')
  })

  test('drops www. and reads %xx escapes in any case', () => {
    expect(normalizeUrl('https://www.a.dev/x')).toBe('https://a.dev/x')
    expect(normalizeUrl('https://a.dev/caf%c3%a9')).toBe(normalizeUrl('https://a.dev/caf%C3%A9'))
  })

  test('refuses what is not a web URL', () => {
    expect(normalizeUrl('ftp://a.dev/x')).toBeUndefined()
    expect(normalizeUrl('https:///x')).toBeUndefined()
  })
})

describe('findUrls', () => {
  test('peels the prose and markdown around a URL', () => {
    const text =
      'See [the docs](https://a.dev/docs), **https://b.dev/x**, <https://c.dev/y> and https://d.dev/z.'
    expect(findUrls(text)).toEqual(['https://a.dev/docs', 'https://b.dev/x', 'https://c.dev/y', 'https://d.dev/z'])
  })

  test("keeps a URL's own parentheses", () => {
    expect(trimUrl('https://en.wikipedia.org/wiki/Rust_(language))')).toBe(
      'https://en.wikipedia.org/wiki/Rust_(language)',
    )
    expect(findUrls('(see https://en.wikipedia.org/wiki/Rust_(language))')).toEqual([
      'https://en.wikipedia.org/wiki/Rust_(language)',
    ])
  })

  test('finds nothing in plain text', () => {
    expect(findUrls('no links here, just www.and.text')).toEqual([])
  })
})

test('local hosts and reserved example names are never citations', () => {
  for (const url of [
    'http://localhost:3000/x',
    'http://127.0.0.1:8080',
    'http://[::1]:5173/',
    'https://example.com/a',
    'https://www.example.org',
    'https://printer.local/status',
  ]) {
    expect(isLocal(normalizeUrl(url)!)).toBe(true)
  }
  expect(isLocal(normalizeUrl('https://github.com/x/y')!)).toBe(false)
  expect(isLocal(normalizeUrl('https://notexample.com')!)).toBe(false)
})

describe('noteCall', () => {
  test('a url input and a shell command open their URLs', () => {
    const sources = emptySources()
    noteCall(sources, 'WebFetch', { url: 'https://a.dev/page', prompt: 'summarise' }, 'Page text')
    noteCall(sources, 'mcp__browser__navigate', { url: 'b.dev/home' })
    noteCall(sources, 'Bash', { command: 'curl -sL "https://c.dev/api?x=1" | jq .' }, '{}')
    expect([...sources.opened]).toEqual(['https://a.dev/page', 'https://b.dev/home', 'https://c.dev/api?x=1'])
  })

  test("a heredoc's body is written, not fetched", () => {
    const sources = emptySources()
    const command = [
      "git commit -F - <<'EOF'",
      'Cites https://written.dev/only',
      'EOF',
      'curl https://fetched.dev/after',
    ].join('\n')
    noteCall(sources, 'Bash', { command })
    expect([...sources.opened]).toEqual(['https://fetched.dev/after'])
  })

  test('search results and fetched pages are listed; other output is given; an agent answer is neither', () => {
    const sources = emptySources()
    noteCall(sources, 'WebSearch', { query: 'claude' }, 'Links: [{"title":"A","url":"https://hit.dev/a"}]')
    noteCall(sources, 'WebFetch', { url: 'https://index.dev', prompt: 'p' }, 'See https://index.dev/deeper')
    noteCall(sources, 'Bash', { command: 'gh pr create --fill' }, 'https://github.com/o/r/pull/7\n')
    noteCall(sources, 'Agent', { prompt: 'research it' }, 'Found https://agent-said.dev/x')
    expect([...sources.listed]).toEqual(['https://hit.dev/a', 'https://index.dev/deeper'])
    expect([...sources.given]).toEqual(['https://github.com/o/r/pull/7'])
    expect([...sources.opened]).toEqual(['https://index.dev'])
  })

  test('a transcript row files the person and the tool calls, never the assistant text', () => {
    const sources = emptySources()
    noteMessage(sources, { role: 'user', text: 'Review https://pasted.dev/repo', toolUses: [] })
    noteMessage(sources, {
      role: 'assistant',
      text: 'I made up https://invented.dev/x',
      toolUses: [{ tool_use_id: 't1', tool: 'WebFetch', input: { url: 'https://read.dev/a', prompt: 'p' }, text: 'ok' }],
    })
    expect([...sources.given]).toEqual(['https://pasted.dev/repo'])
    expect([...sources.opened]).toEqual(['https://read.dev/a'])
  })
})

describe('checkAnswer', () => {
  function sources() {
    const s = emptySources()
    noteCall(s, 'WebFetch', { url: 'https://opened.dev/a', prompt: 'p' })
    noteCall(s, 'WebSearch', { query: 'q' }, 'https://hit.dev/b https://opened.dev/a')
    noteCall(s, 'Read', { file_path: '/x/README.md' }, 'Docs: https://readme.dev/c')

    return s
  }

  test('sorts each link once by what the session did with it', () => {
    const answer = [
      'Per [the guide](http://Opened.dev/a/#setup) and https://hit.dev/b,',
      'also https://readme.dev/c, https://invented.dev/d and again https://invented.dev/d/.',
    ].join(' ')
    expect(checkAnswer(answer, sources())).toEqual({
      links: 4,
      unopened: ['https://invented.dev/d'],
      listedOnly: ['https://hit.dev/b'],
    })
  })

  test('leaves out code blocks and local hosts', () => {
    const answer = [
      'Run it, then open http://localhost:3000.',
      '```bash',
      'curl https://api.made-up.dev/v1/things',
      '```',
      'Source: https://opened.dev/a',
    ].join('\n')
    expect(checkAnswer(answer, sources())).toEqual({ links: 1, unopened: [], listedOnly: [] })
  })
})

describe('noteText', () => {
  test('silent when there is nothing to say', () => {
    expect(noteText({ links: 0, unopened: [], listedOnly: [] })).toBeUndefined()
    expect(noteText({ links: 3, unopened: [], listedOnly: [] })).toBeUndefined()
  })

  test('one line naming each URL to check', () => {
    expect(noteText({ links: 7, unopened: ['https://a.dev', 'https://b.dev'], listedOnly: ['https://c.dev'] })).toBe(
      '7 links in this answer · 2 never opened: https://a.dev, https://b.dev · ' +
        '1 only seen in search results or fetched pages: https://c.dev',
    )
    expect(noteText({ links: 1, unopened: ['https://a.dev'], listedOnly: [] })).toBe(
      '1 link in this answer · 1 never opened: https://a.dev',
    )
  })

  test(`names at most ${MAX_LISTED} of a kind`, () => {
    const unopened = Array.from({ length: MAX_LISTED + 3 }, (_, i) => `https://x${i}.dev`)
    const text = noteText({ links: unopened.length, unopened, listedOnly: [] })!
    expect(text).not.toContain('\n')
    expect(text).toContain('https://x4.dev, +3 more')
    expect(text).not.toContain('https://x5.dev')
  })
})
