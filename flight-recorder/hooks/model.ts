import type {
  FlightLane,
  FlightSegment,
  FlightSlowest,
  FlightSummary,
  FlightTurn,
} from '../types'

export const LANES: readonly FlightLane[] = [
  'Model',
  'Shell',
  'Read',
  'Edit',
  'Agents',
  'Web',
  'Other',
]

export const LANE_COLORS: Record<FlightLane, string> = {
  Model: '#D97757',
  Shell: '#E5C07B',
  Read: '#61AFEF',
  Edit: '#98C379',
  Agents: '#C678DD',
  Web: '#56B6C2',
  Other: '#8B949E',
}

export const EMPTY_COLOR = '#30363D'
export const DONE_COLOR = '#6E7681'
export const REC_COLOR = '#FF5F57'

export const MAX_SEGMENTS = 400
export const HISTORY_LIMIT = 50
export const LABEL_WIDTH = 7
export const STATS_WIDTH = 13

// Raster cell colours: 0x01000000 (bit 24 alone) is the terminal's default.
export const DEFAULT_BG = 0x01000000

// ---------------------------------------------------------------- lanes

const SHELL = new Set(['Bash', 'BashOutput', 'KillShell', 'Monitor'])
const READ = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'])
const EDIT = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const AGENTS = new Set(['Agent', 'Task', 'Workflow', 'SendMessage'])
const WEB = new Set(['WebFetch', 'WebSearch'])
const WEB_HINTS = ['exa', 'chrome', 'browser', 'fetch']

export function laneOf(tool: string): FlightLane {
  if (SHELL.has(tool)) return 'Shell'
  if (READ.has(tool)) return 'Read'
  if (EDIT.has(tool)) return 'Edit'
  if (AGENTS.has(tool)) return 'Agents'
  if (WEB.has(tool)) return 'Web'
  const lower = tool.toLowerCase()
  if (WEB_HINTS.some(hint => lower.includes(hint))) return 'Web'
  return 'Other'
}

// ---------------------------------------------------------------- labels

export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed
}

export function hostOf(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/:?#]+)/i.exec(url)
  return match?.[1] ?? url
}

export function labelOf(tool: string, input: object): string {
  const fields = input as Record<string, unknown>
  const text = (key: string): string => {
    const value = fields[key]
    return typeof value === 'string' ? value : ''
  }

  let label = ''
  switch (tool) {
    case 'Bash': {
      const command = text('command').replace(/\s+/g, ' ').trim()
      label = command.length > 40 ? `${command.slice(0, 40)}…` : command
      break
    }
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      label = baseName(text('file_path'))
      break
    case 'NotebookEdit':
    case 'NotebookRead':
      label = baseName(text('notebook_path'))
      break
    case 'WebFetch':
      label = hostOf(text('url'))
      break
    case 'Agent':
    case 'Task':
      label = text('description').trim()
      break
  }

  return label === '' ? tool : label
}

// ---------------------------------------------------------------- time

export type Interval = readonly [number, number]

/** Total length covered by the intervals; overlaps count once. */
export function unionMs(intervals: readonly Interval[]): number {
  const sorted = intervals.filter(([from, to]) => to > from).sort((a, b) => a[0] - b[0])
  let total = 0
  let from = 0
  let to = 0
  let isOpen = false

  for (const [start, end] of sorted) {
    if (isOpen && start <= to) {
      to = Math.max(to, end)
      continue
    }
    if (isOpen) total += to - from
    from = start
    to = end
    isOpen = true
  }

  return isOpen ? total + (to - from) : total
}

export function emptyTotals(): Record<FlightLane, number> {
  return { Model: 0, Shell: 0, Read: 0, Edit: 0, Agents: 0, Web: 0, Other: 0 }
}

/** Per-lane active time inside [start, end]; a running segment lasts until `now`. */
export function laneTotals(
  segments: readonly FlightSegment[],
  start: number,
  end: number,
  now: number,
): Record<FlightLane, number> {
  const byLane: Record<FlightLane, Interval[]> = {
    Model: [],
    Shell: [],
    Read: [],
    Edit: [],
    Agents: [],
    Web: [],
    Other: [],
  }

  for (const segment of segments) {
    const from = Math.max(segment.start, start)
    const to = Math.min(segment.end ?? now, end)
    if (to > from) byLane[segment.lane].push([from, to])
  }

  const totals = emptyTotals()
  for (const lane of LANES) totals[lane] = unionMs(byLane[lane])

  return totals
}

export function percent(ms: number, wallMs: number): number {
  if (!(ms > 0)) return 0

  return Math.min(100, Math.max(1, Math.round((ms * 100) / Math.max(1, wallMs))))
}

/** `48s`, `4m 12s`, `1h 02m`; under half a second `<1s`. */
export function formatDuration(ms: number): string {
  if (!(ms > 0)) return '0s'

  const total = Math.round(ms / 1000)
  if (total === 0) return '<1s'
  if (total < 60) return `${total}s`

  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`

  return `${minutes}m ${total % 60}s`
}

/** The running clock: `01:42`, or `1:02:03` past an hour. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pair = (n: number) => String(n).padStart(2, '0')

  return hours > 0 ? `${hours}:${pair(minutes)}:${pair(seconds)}` : `${pair(minutes)}:${pair(seconds)}`
}

/** Axis ticks: one decimal under ten seconds, otherwise `formatDuration`. */
export function formatAxis(ms: number): string {
  if (!(ms > 0)) return '0s'
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`

  return formatDuration(ms)
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

// ---------------------------------------------------------------- the turn

export function freshTurn(
  now: number,
  previous: FlightTurn | null,
  turnId?: string,
  isEngaged = false,
): FlightTurn {
  const turn: FlightTurn = {
    id: now,
    startedAt: now,
    isRunning: true,
    isEngaged,
    steps: 0,
    calls: 0,
    subCalls: 0,
    segments: [],
  }
  if (turnId !== undefined) turn.turnId = turnId
  if (previous !== null && !previous.isRunning) {
    const { previous: _older, ...flat } = previous
    turn.previous = flat
  }

  return turn
}

/** The turn to show when a started turn never engaged: the one it replaced. */
export function abandonTurn(turn: FlightTurn): FlightTurn | null {
  return turn.previous ?? null
}

/** Adds a segment; past MAX_SEGMENTS the oldest finished ones go, the counters stay exact. */
export function addSegment(turn: FlightTurn, segment: FlightSegment): FlightTurn {
  let drop = turn.segments.length + 1 - MAX_SEGMENTS
  const kept = turn.segments.filter(old => {
    if (drop > 0 && old.end !== undefined) {
      drop -= 1

      return false
    }

    return true
  })
  const isModel = segment.lane === 'Model'

  return {
    ...turn,
    isEngaged: true,
    steps: turn.steps + (isModel ? 1 : 0),
    calls: turn.calls + (isModel ? 0 : 1),
    segments: [...kept, segment],
  }
}

export function endSegment(turn: FlightTurn, id: string, at: number): FlightTurn {
  return {
    ...turn,
    segments: turn.segments.map(segment =>
      segment.id === id && segment.end === undefined
        ? { ...segment, end: Math.max(at, segment.start) }
        : segment,
    ),
  }
}

/**
 * Ends the turn at `now`. When the engine reported the turn's length the window is
 * re-anchored to it, so the duration, the percentages and the axis all agree with it.
 */
export function closeTurn(turn: FlightTurn, now: number, durationMs?: number): FlightTurn {
  const hasLength = durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0
  const length = hasLength ? durationMs : Math.max(0, now - turn.startedAt)

  return {
    ...turn,
    isRunning: false,
    isEngaged: true,
    endedAt: now,
    startedAt: now - length,
    durationMs: length,
    segments: turn.segments.map(segment =>
      segment.end === undefined ? { ...segment, end: Math.max(now, segment.start) } : segment,
    ),
  }
}

export type NowCall = { lane: FlightLane; label: string; ms: number }

export type Analysis = {
  start: number
  end: number
  wallMs: number
  totals: Record<FlightLane, number>
  slowest?: FlightSlowest
  running?: NowCall
}

/** The slowest tool call (model steps are not calls); a running one counts to `now`. */
export function slowestCall(
  segments: readonly FlightSegment[],
  now: number,
): FlightSlowest | undefined {
  let best: FlightSlowest | undefined
  for (const segment of segments) {
    if (segment.lane === 'Model') continue
    const ms = (segment.end ?? now) - segment.start
    if (ms > 0 && (best === undefined || ms > best.ms)) {
      best = { label: segment.label, lane: segment.lane, ms }
    }
  }

  return best
}

/** The newest segment that has not ended. */
export function runningCall(segments: readonly FlightSegment[], now: number): NowCall | undefined {
  let newest: FlightSegment | undefined
  for (const segment of segments) {
    if (segment.end === undefined && (newest === undefined || segment.start >= newest.start)) {
      newest = segment
    }
  }

  return newest && { lane: newest.lane, label: newest.label, ms: Math.max(0, now - newest.start) }
}

export function analyze(turn: FlightTurn, now: number): Analysis {
  const start = turn.startedAt
  // A running turn shows at least a second so the first bar is not the whole axis.
  const end = turn.isRunning
    ? Math.max(now, start + 1000)
    : Math.max(turn.endedAt ?? now, start + 1)
  const analysis: Analysis = {
    start,
    end,
    wallMs: end - start,
    totals: laneTotals(turn.segments, start, end, now),
  }
  const slowest = slowestCall(turn.segments, now)
  if (slowest) analysis.slowest = slowest
  const running = turn.isRunning ? runningCall(turn.segments, now) : undefined
  if (running) analysis.running = running

  return analysis
}

export type LaneShare = { lane: FlightLane; ms: number; pct: number }

/** Lanes with any time, most first; equal time keeps the lane order. */
export function topLanes(
  totals: Record<FlightLane, number>,
  wallMs: number,
  count = LANES.length,
): LaneShare[] {
  return LANES.map(lane => ({ lane, ms: totals[lane], pct: percent(totals[lane], wallMs) }))
    .filter(share => share.ms > 0)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, count)
}

export function summarize(turn: FlightTurn): FlightSummary {
  const durationMs = turn.durationMs ?? Math.max(0, (turn.endedAt ?? turn.startedAt) - turn.startedAt)
  const end = turn.startedAt + durationMs
  const summary: FlightSummary = {
    at: turn.endedAt ?? end,
    durationMs,
    calls: turn.calls,
    lanes: laneTotals(turn.segments, turn.startedAt, end, end),
  }
  const slowest = slowestCall(turn.segments, end)
  if (slowest) summary.slowest = slowest

  return summary
}

/** `Flight Recorder: 4m 12s · Shell 61% · slowest: npm test 48s` */
export function toastText(summary: FlightSummary): string {
  const parts = [formatDuration(summary.durationMs)]
  const top = topLanes(summary.lanes, summary.durationMs, 1)[0]
  if (top) parts.push(`${top.lane} ${top.pct}%`)
  if (summary.slowest) parts.push(`slowest: ${summary.slowest.label} ${formatDuration(summary.slowest.ms)}`)

  return `Flight Recorder: ${parts.join(' · ')}`
}

/** What `$.store` held under `history`, minus anything that is not a summary. */
export function cleanHistory(raw: unknown): FlightSummary[] {
  if (!Array.isArray(raw)) return []

  return raw.filter((item): item is FlightSummary => {
    const entry = item as Partial<FlightSummary> | null

    return (
      typeof entry === 'object' &&
      entry !== null &&
      typeof entry.durationMs === 'number' &&
      typeof entry.lanes === 'object' &&
      entry.lanes !== null
    )
  })
}

export function pushHistory(
  history: readonly FlightSummary[],
  summary: FlightSummary,
  limit = HISTORY_LIMIT,
): FlightSummary[] {
  return [...history, summary].slice(-limit)
}

/** Top lanes by summed active time over summed duration of the last `window` turns. */
export function historyTop(
  history: readonly FlightSummary[],
  window = 20,
  count = 3,
): { turns: number; shares: LaneShare[] } {
  const recent = history.slice(-window)
  const totals = emptyTotals()
  let wallMs = 0
  for (const entry of recent) {
    wallMs += entry.durationMs
    for (const lane of LANES) totals[lane] += entry.lanes[lane] ?? 0
  }

  return { turns: recent.length, shares: topLanes(totals, wallMs, count) }
}

// ---------------------------------------------------------------- the grid

export type Cell = { glyph: string; color: string }

export type GridInput = {
  segments: readonly FlightSegment[]
  start: number
  end: number
  now: number
  columns: number
  /** Running segments draw in a brighter tint while this is true. */
  isShimmer: boolean
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

/** `#RRGGBB` mixed toward white. */
export function lighten(hex: string, amount = 0.4): string {
  const value = parseInt(hex.slice(1), 16)
  const mix = (channel: number) => Math.round(channel + (255 - channel) * amount)
  const out = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map(channel =>
    mix(channel).toString(16).padStart(2, '0'),
  )

  return `#${out.join('').toUpperCase()}`
}

/**
 * Lanes x columns. The x axis maps [start, end] onto the columns; a cell is filled when
 * a segment of its lane overlaps its slice, and every segment gets at least one cell.
 */
export function buildCells(input: GridInput): Cell[][] {
  const { segments, start, end, now, columns, isShimmer } = input
  const span = Math.max(1, end - start)
  const marks = LANES.map(() => new Array<number>(columns).fill(0))

  for (const segment of segments) {
    const row = marks[LANES.indexOf(segment.lane)]
    const from = segment.start
    const to = segment.end ?? now
    if (!row || to < start || from > end) continue

    const first = clamp(Math.floor(((from - start) * columns) / span), 0, columns - 1)
    const last = clamp(Math.ceil(((to - start) * columns) / span) - 1, first, columns - 1)
    const mark = segment.end === undefined ? 2 : 1
    for (let column = first; column <= last; column++) {
      row[column] = Math.max(row[column] ?? 0, mark)
    }
  }

  return LANES.map((lane, index) => {
    const color = LANE_COLORS[lane]

    return (marks[index] ?? []).map((mark): Cell => {
      if (mark === 0) return { glyph: '·', color: EMPTY_COLOR }

      return { glyph: '█', color: mark === 2 && isShimmer ? lighten(color) : color }
    })
  })
}

/** Consecutive cells of one colour become one run (one `Text`). */
export function groupRuns(row: readonly Cell[]): { text: string; color: string }[] {
  const runs: { text: string; color: string }[] = []
  for (const cell of row) {
    const last = runs[runs.length - 1]
    if (last && last.color === cell.color) last.text += cell.glyph
    else runs.push({ text: cell.glyph, color: cell.color })
  }

  return runs
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard padded base64 (the module environment declares `btoa` but no byte encoder). */
export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const left = bytes.length - i
    const word = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += BASE64.charAt((word >> 18) & 63) + BASE64.charAt((word >> 12) & 63)
    out += left > 1 ? BASE64.charAt((word >> 6) & 63) : '='
    out += left > 2 ? BASE64.charAt(word & 63) : '='
  }

  return out
}

/** `RasterProps.cells`: base64 of little-endian u32 triplets [codePoint, 0x00RRGGBB, bg]. */
export function encodeRaster(cells: readonly (readonly Cell[])[], columns: number): string {
  const bytes = new Uint8Array(cells.length * columns * 12)
  let at = 0
  const put = (word: number) => {
    bytes[at++] = word & 255
    bytes[at++] = (word >>> 8) & 255
    bytes[at++] = (word >>> 16) & 255
    bytes[at++] = (word >>> 24) & 255
  }

  for (const row of cells) {
    for (let column = 0; column < columns; column++) {
      const cell = row[column] ?? { glyph: ' ', color: EMPTY_COLOR }
      put(cell.glyph.codePointAt(0) ?? 32)
      put(parseInt(cell.color.slice(1), 16))
      put(DEFAULT_BG)
    }
  }

  return toBase64(bytes)
}

/** `0s`, the midpoint and the end time, placed under the grid's columns. */
export function axisLine(columns: number, spanMs: number): string {
  const line = new Array<string>(columns).fill(' ')
  const put = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      if (at + i >= 0 && at + i < columns) line[at + i] = text.charAt(i)
    }
  }
  const left = '0s'
  const right = formatAxis(spanMs)
  const middle = formatAxis(spanMs / 2)
  const middleAt = Math.round((columns - middle.length) / 2)

  put(0, left)
  put(columns - right.length, right)
  if (middleAt > left.length && middleAt + middle.length < columns - right.length) {
    put(middleAt, middle)
  }

  return line.join('')
}

/** One lane's stats cell pair: ` 61%` and `  2m 34s`, 12 characters in all. */
export function statsText(ms: number, wallMs: number): { pct: string; duration: string; isZero: boolean } {
  const share = percent(ms, wallMs)

  return {
    pct: `${share}%`.padStart(4),
    duration: ` ${formatDuration(ms)}`.padStart(8),
    isZero: share === 0,
  }
}
