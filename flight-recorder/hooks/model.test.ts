import { describe, expect, test } from 'claude-code/testing'

import type { FlightSegment, FlightSummary } from '../types'
import {
  LANES,
  LANE_COLORS,
  EMPTY_COLOR,
  MAX_SEGMENTS,
  abandonTurn,
  addSegment,
  analyze,
  axisLine,
  buildCells,
  cleanHistory,
  closeTurn,
  emptyTotals,
  encodeRaster,
  endSegment,
  formatAxis,
  formatClock,
  formatDuration,
  freshTurn,
  groupRuns,
  historyTop,
  hostOf,
  labelOf,
  laneOf,
  laneTotals,
  lighten,
  pushHistory,
  slowestCall,
  statsText,
  summarize,
  toBase64,
  toastText,
  topLanes,
  unionMs,
} from './model'

const seg = (lane: FlightSegment['lane'], start: number, end?: number, label: string = lane): FlightSegment =>
  end === undefined ? { id: `${lane}${start}`, lane, label, start } : { id: `${lane}${start}`, lane, label, start, end }

describe('laneOf', () => {
  test('maps the named tools to their lanes', () => {
    for (const tool of ['Bash', 'BashOutput', 'KillShell', 'Monitor']) expect(laneOf(tool)).toBe('Shell')
    for (const tool of ['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']) expect(laneOf(tool)).toBe('Read')
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) expect(laneOf(tool)).toBe('Edit')
    for (const tool of ['Agent', 'Task', 'Workflow', 'SendMessage']) expect(laneOf(tool)).toBe('Agents')
    for (const tool of ['WebFetch', 'WebSearch']) expect(laneOf(tool)).toBe('Web')
  })

  test('web hints match inside any tool name, other mcp tools are Other', () => {
    expect(laneOf('mcp__claude_ai_Exa__web_search_exa')).toBe('Web')
    expect(laneOf('mcp__claude-in-chrome__navigate')).toBe('Web')
    expect(laneOf('mcp__x__browser_click')).toBe('Web')
    expect(laneOf('mcp__x__fetch_page')).toBe('Web')
    expect(laneOf('mcp__claude_ai_Composio__COMPOSIO_SEARCH_TOOLS')).toBe('Other')
    expect(laneOf('TodoWrite')).toBe('Other')
    expect(laneOf('')).toBe('Other')
  })
})

describe('labelOf', () => {
  test('Bash keeps the first 40 characters of one line', () => {
    expect(labelOf('Bash', { command: 'npm test' })).toBe('npm test')
    expect(labelOf('Bash', { command: 'echo   a\n  && echo b' })).toBe('echo a && echo b')
    const long = labelOf('Bash', { command: 'x'.repeat(60) })
    expect(long).toBe(`${'x'.repeat(40)}…`)
  })

  test('file tools show the basename, WebFetch the host, Agent its description', () => {
    expect(labelOf('Read', { file_path: '/a/b/register.tsx' })).toBe('register.tsx')
    expect(labelOf('Edit', { file_path: 'C:\\proj\\x.ts' })).toBe('x.ts')
    expect(labelOf('Write', { file_path: '/a/b/' })).toBe('b')
    expect(labelOf('NotebookEdit', { notebook_path: '/n/lab.ipynb' })).toBe('lab.ipynb')
    expect(labelOf('WebFetch', { url: 'https://docs.example.com:8080/a?b=1' })).toBe('docs.example.com')
    expect(labelOf('Agent', { description: 'Find the bug' })).toBe('Find the bug')
  })

  test('anything else, or a missing field, is the tool name', () => {
    expect(labelOf('Grep', { pattern: 'x' })).toBe('Grep')
    expect(labelOf('Bash', {})).toBe('Bash')
    expect(labelOf('Read', { file_path: 3 })).toBe('Read')
    expect(hostOf('not a url')).toBe('not a url')
  })
})

describe('unionMs and laneTotals', () => {
  test('overlapping and touching intervals count once', () => {
    expect(unionMs([[0, 10], [5, 20], [30, 40]])).toBe(30)
    expect(unionMs([[0, 10], [10, 20]])).toBe(20)
    expect(unionMs([[5, 8], [0, 100], [20, 30]])).toBe(100)
    expect(unionMs([[4, 4], [9, 3]])).toBe(0)
    expect(unionMs([])).toBe(0)
  })

  test('parallel calls in one lane do not double count; running ones last until now', () => {
    const totals = laneTotals(
      [seg('Shell', 0, 60), seg('Shell', 20, 80), seg('Read', 90), seg('Edit', -50, 10)],
      0,
      100,
      95,
    )
    expect(totals.Shell).toBe(80)
    expect(totals.Read).toBe(5)
    expect(totals.Edit).toBe(10)
    expect(totals.Model).toBe(0)
  })
})

describe('formatting', () => {
  test('formatDuration', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(300)).toBe('<1s')
    expect(formatDuration(48_000)).toBe('48s')
    expect(formatDuration(59_600)).toBe('1m 0s')
    expect(formatDuration(252_000)).toBe('4m 12s')
    expect(formatDuration(3_720_000)).toBe('1h 02m')
  })

  test('formatClock and formatAxis', () => {
    expect(formatClock(0)).toBe('00:00')
    expect(formatClock(102_900)).toBe('01:42')
    expect(formatClock(3_723_000)).toBe('1:02:03')
    expect(formatAxis(0)).toBe('0s')
    expect(formatAxis(2_500)).toBe('2.5s')
    expect(formatAxis(90_000)).toBe('1m 30s')
  })

  test('stats cells are 12 characters wide', () => {
    const a = statsText(154_000, 252_000)
    expect(a.pct + a.duration).toBe(' 61%  2m 34s')
    const b = statsText(0, 252_000)
    expect(b.isZero).toBe(true)
    expect(b.pct + b.duration).toBe('  0%      0s')
    expect(statsText(1, 1_000_000).pct).toBe('  1%')
    expect(statsText(5, 5).pct).toBe('100%')
  })
})

describe('buildCells', () => {
  const base = { start: 0, now: 100, isShimmer: false }

  test('is lanes x columns of glyph and colour', () => {
    const cells = buildCells({ ...base, segments: [seg('Shell', 0, 50)], end: 100, columns: 10 })
    expect(cells).toHaveLength(LANES.length)
    for (const row of cells) expect(row).toHaveLength(10)
    const shell = cells[LANES.indexOf('Shell')] ?? []
    expect(shell.slice(0, 5).every(c => c.glyph === '█' && c.color === LANE_COLORS.Shell)).toBe(true)
    expect(shell.slice(5).every(c => c.glyph === '·' && c.color === EMPTY_COLOR)).toBe(true)
    expect((cells[0] ?? []).every(c => c.glyph === '·')).toBe(true)
  })

  test('rescales as the turn grows: the same segment compresses', () => {
    const segments = [seg('Read', 0, 50)]
    const filled = (end: number) =>
      (buildCells({ ...base, segments, end, columns: 20 })[LANES.indexOf('Read')] ?? []).filter(c => c.glyph === '█').length
    expect(filled(100)).toBe(10)
    expect(filled(200)).toBe(5)
    expect(filled(1000)).toBe(1)
  })

  test('any segment gets at least one cell, even a zero-length one at the very end', () => {
    const cells = buildCells({
      ...base,
      segments: [seg('Edit', 40, 40), seg('Web', 100_000, 100_000), seg('Agents', 0, 0.001)],
      end: 100_000,
      columns: 30,
    })
    for (const lane of ['Edit', 'Web', 'Agents'] as const) {
      const row = cells[LANES.indexOf(lane)] ?? []
      expect(row.filter(c => c.glyph === '█')).toHaveLength(1)
    }
    const web = cells[LANES.indexOf('Web')] ?? []
    expect(web[29]?.glyph).toBe('█')
  })

  test('a segment ending on a slice boundary does not spill into the next cell', () => {
    const row = buildCells({ ...base, segments: [seg('Shell', 20, 40)], end: 100, columns: 10 })[LANES.indexOf('Shell')] ?? []
    expect(row.map(c => c.glyph).join('')).toBe('··██······')
  })

  test('a running segment shimmers on the bright tint, done ones do not', () => {
    const segments = [seg('Shell', 0, 30), seg('Shell', 60)]
    const row = (isShimmer: boolean) =>
      buildCells({ ...base, segments, end: 100, columns: 10, isShimmer })[LANES.indexOf('Shell')] ?? []
    expect(row(false)[9]?.color).toBe(LANE_COLORS.Shell)
    expect(row(true)[9]?.color).toBe(lighten(LANE_COLORS.Shell))
    expect(row(true)[9]?.color).not.toBe(LANE_COLORS.Shell)
    expect(row(true)[0]?.color).toBe(LANE_COLORS.Shell)
  })

  test('groupRuns folds consecutive equal colours into one run', () => {
    const row = buildCells({ ...base, segments: [seg('Read', 20, 50)], end: 100, columns: 10 })[LANES.indexOf('Read')] ?? []
    expect(groupRuns(row)).toEqual([
      { text: '··', color: EMPTY_COLOR },
      { text: '███', color: LANE_COLORS.Read },
      { text: '·····', color: EMPTY_COLOR },
    ])
    expect(groupRuns([])).toEqual([])
  })
})

describe('raster encoding', () => {
  test('base64 matches the standard vectors', () => {
    const bytes = (text: string) => Uint8Array.from(text, ch => ch.charCodeAt(0))
    expect(toBase64(bytes(''))).toBe('')
    expect(toBase64(bytes('M'))).toBe('TQ==')
    expect(toBase64(bytes('Ma'))).toBe('TWE=')
    expect(toBase64(bytes('Man'))).toBe('TWFu')
    const sample = Uint8Array.from({ length: 256 }, (_, i) => i)
    expect(toBase64(sample)).toBe(btoa(String.fromCharCode(...sample)))
  })

  test('cells are little-endian u32 triplets of code point, colour and default background', () => {
    const encoded = encodeRaster([[{ glyph: '█', color: '#FF8800' }]], 1)
    expect(encoded).toBe(toBase64(Uint8Array.of(0x88, 0x25, 0, 0, 0x00, 0x88, 0xff, 0, 0, 0, 0, 1)))
    const raw = Uint8Array.from(atob(encoded), ch => ch.charCodeAt(0))
    const words = new Uint32Array(raw.buffer)
    expect([words[0], words[1], words[2]]).toEqual([0x2588, 0xff8800, 0x01000000])
  })

  test('the length is columns x rows x 12 bytes', () => {
    const cells = buildCells({ segments: [], start: 0, end: 10, now: 10, columns: 17, isShimmer: false })
    expect(atob(encodeRaster(cells, 17))).toHaveLength(17 * 7 * 12)
  })

  test('Uint8Array.toBase64, where the environment has it, agrees with ours', () => {
    const sample = Uint8Array.of(1, 2, 3, 250, 251)
    const native = (sample as unknown as { toBase64?: () => string }).toBase64
    if (typeof native === 'function') expect(native.call(sample)).toBe(toBase64(sample))
    else expect(toBase64(sample)).toBe('AQID+vs=')
  })
})

describe('axis', () => {
  test('0s at the left, the midpoint centred, the end flush right', () => {
    const line = axisLine(40, 80_000)
    expect(line).toHaveLength(40)
    expect(line.startsWith('0s')).toBe(true)
    expect(line.endsWith('1m 20s')).toBe(true)
    expect(line.slice(18, 22).trim()).toBe('40s')
  })

  test('drops the midpoint when it would collide', () => {
    const line = axisLine(12, 80_000)
    expect(line).toHaveLength(12)
    expect(line.includes('40s')).toBe(false)
  })
})

describe('turn bookkeeping', () => {
  test('addSegment counts steps and calls apart and caps the list', () => {
    let turn = freshTurn(0, null)
    turn = addSegment(turn, seg('Model', 0, 5))
    turn = addSegment(turn, seg('Shell', 5, 9))
    expect([turn.steps, turn.calls, turn.isEngaged]).toEqual([1, 1, true])

    for (let i = 0; i < MAX_SEGMENTS + 20; i++) {
      turn = addSegment(turn, { id: `r${i}`, lane: 'Read', label: 'f', start: 10 + i, end: 11 + i })
    }
    expect(turn.segments).toHaveLength(MAX_SEGMENTS)
    expect(turn.calls).toBe(1 + MAX_SEGMENTS + 20)
    expect(turn.segments[turn.segments.length - 1]?.id).toBe(`r${MAX_SEGMENTS + 19}`)
  })

  test('endSegment ends only the named running segment', () => {
    let turn = freshTurn(0, null)
    turn = addSegment(turn, { id: 'a', lane: 'Shell', label: 'a', start: 5 })
    turn = addSegment(turn, { id: 'b', lane: 'Shell', label: 'b', start: 6 })
    turn = endSegment(turn, 'a', 9)
    expect(turn.segments.map(s => s.end)).toEqual([9, undefined])
    expect(endSegment(turn, 'a', 99).segments[0]?.end).toBe(9)
  })

  test('closeTurn re-anchors to the reported duration and ends running segments', () => {
    let turn = freshTurn(1_000, null)
    turn = addSegment(turn, { id: 'a', lane: 'Shell', label: 'a', start: 1_500 })
    const closed = closeTurn(turn, 11_000, 9_000)
    expect([closed.isRunning, closed.startedAt, closed.endedAt, closed.durationMs]).toEqual([false, 2_000, 11_000, 9_000])
    expect(closed.segments[0]?.end).toBe(11_000)
    expect(closeTurn(turn, 11_000).durationMs).toBe(10_000)
  })

  test('a started turn that never engages gives back the one it replaced', () => {
    const finished = closeTurn(addSegment(freshTurn(0, null), seg('Shell', 1, 4)), 10, 10)
    const next = freshTurn(50, finished)
    expect(next.previous?.id).toBe(finished.id)
    expect(abandonTurn(next)?.segments).toHaveLength(1)
    expect(abandonTurn(freshTurn(60, null))).toBeNull()
    expect(freshTurn(70, next).previous?.previous).toBeUndefined()
    expect(freshTurn(80, freshTurn(0, null)).previous).toBeUndefined()
  })
})

describe('analysis and summary', () => {
  const finished = () => {
    let turn = freshTurn(0, null)
    turn = addSegment(turn, seg('Model', 0, 10_000, 'step 1'))
    turn = addSegment(turn, seg('Shell', 10_000, 58_000, 'npm test'))
    turn = addSegment(turn, seg('Shell', 20_000, 30_000, 'ls'))
    turn = addSegment(turn, seg('Read', 58_000, 60_000, 'a.ts'))
    return closeTurn(turn, 80_000, 80_000)
  }

  test('lane time is the union, slowest ignores model steps', () => {
    const summary = summarize(finished())
    expect(summary.durationMs).toBe(80_000)
    expect(summary.calls).toBe(3)
    expect(summary.lanes.Shell).toBe(48_000)
    expect(summary.lanes.Model).toBe(10_000)
    expect(summary.slowest).toEqual({ label: 'npm test', lane: 'Shell', ms: 48_000 })
    expect(toastText(summary)).toBe('Flight Recorder: 1m 20s · Shell 60% · slowest: npm test 48s')
  })

  test('analyze reports the running call and floors a young turn at one second', () => {
    let turn = freshTurn(1_000, null)
    turn = addSegment(turn, { id: 'a', lane: 'Shell', label: 'npm test', start: 1_100 })
    turn = addSegment(turn, { id: 'b', lane: 'Read', label: 'x', start: 1_200 })
    const analysis = analyze(turn, 1_300)
    expect(analysis.end - analysis.start).toBe(1_000)
    expect(analysis.running).toEqual({ lane: 'Read', label: 'x', ms: 100 })
    expect(slowestCall(turn.segments, 1_300)?.label).toBe('npm test')
    expect(analyze(finished(), 99_999).end).toBe(80_000)
  })

  test('topLanes sorts by time, ties by lane order, zero lanes are left out', () => {
    const totals = { ...emptyTotals(), Read: 30, Shell: 30, Web: 5 }
    expect(topLanes(totals, 100).map(s => s.lane)).toEqual(['Shell', 'Read', 'Web'])
    expect(topLanes(totals, 100, 1)).toEqual([{ lane: 'Shell', ms: 30, pct: 30 }])
  })
})

describe('history', () => {
  const entry = (durationMs: number, lanes: Partial<FlightSummary['lanes']>): FlightSummary => ({
    at: 0,
    durationMs,
    calls: 1,
    lanes: { ...emptyTotals(), ...lanes },
  })

  test('keeps the newest 50 and discards what is not a summary', () => {
    let history: FlightSummary[] = []
    for (let i = 0; i < 60; i++) history = pushHistory(history, entry(i + 1, {}))
    expect(history).toHaveLength(50)
    expect(history[0]?.durationMs).toBe(11)
    expect(cleanHistory([entry(1, {}), null, 3, { durationMs: 'x' }, { durationMs: 1 }])).toHaveLength(1)
    expect(cleanHistory('nope')).toEqual([])
  })

  test('historyTop sums lanes over the last 20 turns', () => {
    const history = [
      entry(1_000_000, { Model: 1_000_000 }),
      ...Array.from({ length: 20 }, () => entry(100, { Shell: 50, Model: 30, Agents: 10, Web: 2 })),
    ]
    const top = historyTop(history)
    expect(top.turns).toBe(20)
    expect(top.shares.map(s => `${s.lane} ${s.pct}%`)).toEqual(['Shell 50%', 'Model 30%', 'Agents 10%'])
  })
})
