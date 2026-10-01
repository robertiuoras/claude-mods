import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, Timer } from 'claude-code'

import type { FlightSegment, FlightSummary, FlightTurn } from '../types'
import {
  DONE_COLOR,
  LABEL_WIDTH,
  LANES,
  LANE_COLORS,
  REC_COLOR,
  STATS_WIDTH,
  abandonTurn,
  addSegment,
  analyze,
  axisLine,
  buildCells,
  cleanHistory,
  closeTurn,
  encodeRaster,
  endSegment,
  formatClock,
  formatDuration,
  freshTurn,
  groupRuns,
  historyTop,
  labelOf,
  laneOf,
  plural,
  pushHistory,
  statsText,
  summarize,
  toastText,
  topLanes,
} from './model'
import type { Analysis } from './model'

const PANE = 'flight'
const TICK_MS = 200
// A started turn that no model step, call or turn.start confirms within this long is dropped.
const UNENGAGED_MS = 10_000

const turnAtom = atom({ plugin: 'flight-recorder', key: 'turn' } as const, null)
const tickAtom = atom({ plugin: 'flight-recorder', key: 'tick' } as const, 0)

type Kit = Pick<Elements['terminal'], 'Box' | 'Text'>

/** The recorder watches; whatever it hits must never fail the call or step it watches. */
async function quietly<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work()
  } catch {
    return undefined
  }
}

let timer: Timer | undefined
let history: FlightSummary[] | undefined

function stopTicker() {
  timer?.cancel()
  timer = undefined
}

async function getHistory($: EngineInterface): Promise<FlightSummary[]> {
  if (history === undefined) {
    try {
      history = cleanHistory(await $.store.get('history'))
    } catch {
      return []
    }
  }

  return history
}

async function abandonIfUnengaged($: EngineInterface) {
  const turn = await read($, turnAtom)
  if (turn?.isRunning && !turn.isEngaged) {
    await update($, turnAtom, t => (t && t.id === turn.id && t.isRunning ? abandonTurn(t) : t))
    stopTicker()
  }
}

async function onTick($: EngineInterface) {
  const turn = await read($, turnAtom)
  if (!turn?.isRunning) {
    stopTicker()

    return
  }
  if (!turn.isEngaged && (await $.clock.now()) - turn.startedAt > UNENGAGED_MS) {
    await abandonIfUnengaged($)

    return
  }
  await update($, tickAtom, n => n + 1)
}

function startTicker($: EngineInterface) {
  stopTicker()
  timer = $.clock.every(TICK_MS, () => void quietly(() => onTick($)))
}

/** prompt.submit and turn.start both come here: the first one to fire starts the turn. */
async function begin($: EngineInterface, turnId?: string) {
  const now = await $.clock.now()
  const before = await read($, turnAtom)
  // A prompt never restarts a running turn; a turn.start with another turn's id does.
  const isSame =
    before?.isRunning === true &&
    (turnId === undefined || before.turnId === undefined || before.turnId === turnId)

  if (isSame) {
    await update($, turnAtom, t =>
      t && t.id === before.id ? { ...t, ...(turnId === undefined ? {} : { turnId, isEngaged: true }) } : t,
    )
    if (timer === undefined) startTicker($)

    return
  }

  await update($, turnAtom, t => freshTurn(now, t, turnId, turnId !== undefined))
  await update($, tickAtom, () => 0)
  startTicker($)
}

async function finish($: EngineInterface, durationMs: number) {
  const now = await $.clock.now()
  const before = await read($, turnAtom)
  if (!before?.isRunning) return

  const closed = await update($, turnAtom, t =>
    t && t.id === before.id && t.isRunning ? closeTurn(t, now, durationMs) : t,
  )
  stopTicker()
  if (closed === null || closed.isRunning || closed.id !== before.id) return

  const summary = summarize(closed)
  // Read the store again rather than the cache: other sessions append to the same history.
  history = pushHistory(cleanHistory(await $.store.get('history')), summary)
  await $.store.set('history', history)
  // The pane drew the closed turn already; this draw picks up the new history line.
  await update($, tickAtom, n => n + 1)

  if (summary.durationMs > 60_000) $.ui.toast(toastText(summary))
}

async function track($: EngineInterface, segment: FlightSegment): Promise<number | undefined> {
  const after = await update($, turnAtom, t => (t && t.isRunning ? addSegment(t, segment) : t))

  return after?.isRunning ? after.id : undefined
}

async function untrack($: EngineInterface, owner: number, id: string) {
  const at = await $.clock.now()
  await update($, turnAtom, t => (t && t.id === owner ? endSegment(t, id, at) : t))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'flight',
      description: "Show or hide the Flight Recorder (where each turn's time goes)",
      immediate: true,
    })
    // A reload drops the timer; a turn that was running keeps ticking.
    const turn = await read($, turnAtom)
    if (turn?.isRunning) startTicker($)

    return next(e)
  })

  on('command.run', { command: 'flight' }, async $ => {
    await quietly(() => abandonIfUnengaged($))
    const panes = await $.ui.panes()
    if (panes.some(pane => pane.id === PANE && pane.isPlaced)) {
      await $.ui.close({ id: PANE })

      return { text: 'Flight Recorder closed.' }
    }

    const opened = await $.ui.open({ id: PANE, title: 'Flight Recorder', rows: 14, columns: 96 })

    return {
      text: opened.isPlaced
        ? 'Flight Recorder opened.'
        : `Flight Recorder is open but not drawn yet: ${opened.reason}`,
    }
  })

  on('prompt.submit', async ($, e, next) => {
    // A prompt typed over a running turn is queued for it, not a new turn.
    if (e.turnId === undefined) await quietly(() => begin($))

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await quietly(() => begin($, e.turnId))

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)

    const start = await $.clock.now()
    const id = `step-${e.index}-${start}`
    const owner = await quietly(() =>
      track($, { id, lane: 'Model', label: `step ${e.index + 1}`, start }),
    )

    try {
      return yield* next(e)
    } finally {
      if (owner !== undefined) await quietly(() => untrack($, owner, id))
    }
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      await quietly(() =>
        update($, turnAtom, t => (t && t.isRunning ? { ...t, subCalls: t.subCalls + 1 } : t)),
      )

      return next(e)
    }

    const owner = await quietly(async () => {
      const segment: FlightSegment = {
        id: e.tool_use_id,
        lane: laneOf(e.tool),
        label: labelOf(e.tool, e),
        start: await $.clock.now(),
      }

      return track($, segment)
    })

    try {
      return await next(e)
    } finally {
      if (owner !== undefined) await quietly(() => untrack($, owner, e.tool_use_id))
    }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await quietly(() => finish($, e.durationMs))

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const turn = await read($, turnAtom)
    const tick = await read($, tickAtom)
    const now = await $.clock.now()
    const recent = await getHistory($)
    const { Box, Text } = $.ui.resolve(e)
    const kit: Kit = { Box, Text }

    const bodyColumns = e.props.bodyColumns > 0 ? e.props.bodyColumns : (e.viewport?.columns ?? 80)
    const columns = Math.min(512, Math.max(4, bodyColumns - LABEL_WIDTH - 1 - STATS_WIDTH))
    const historyLine = historyRow(kit, recent)

    if (turn === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Waiting for the next turn… (ask Claude anything)</Text>
          {historyLine}
        </Box>
      )
    }

    const a = analyze(turn, now)
    const cells = buildCells({
      segments: turn.segments,
      start: a.start,
      end: a.end,
      now,
      columns,
      isShimmer: tick % 2 === 0,
    })

    let grid: JSX.Element
    if (e.surface === 'terminal') {
      const { Raster } = $.ui.resolve(e)
      grid = <Raster key="grid" rows={LANES.length} columns={columns} cells={encodeRaster(cells, columns)} />
    } else {
      // No Raster here: the same cell model as one Text per run of a colour.
      grid = (
        <Box flexDirection="column">
          {cells.map(row => (
            <Box>
              {groupRuns(row).map(run => (
                <Text color={run.color}>{run.text}</Text>
              ))}
            </Box>
          ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {headerRow(kit, turn, now, tick)}
        <Box marginTop={1}>
          <Box flexDirection="column" width={LABEL_WIDTH} flexShrink={0}>
            {LANES.map(lane => (
              <Text color={LANE_COLORS[lane]} bold>
                {lane}
              </Text>
            ))}
          </Box>
          <Box marginLeft={1} width={columns} flexShrink={0}>
            {grid}
          </Box>
          <Box flexDirection="column" width={STATS_WIDTH} flexShrink={0}>
            {LANES.map(lane => {
              const stats = statsText(a.totals[lane], a.wallMs)

              return (
                <Box>
                  <Text color={LANE_COLORS[lane]} bold={!stats.isZero} dimColor={stats.isZero}>
                    {stats.pct}
                  </Text>
                  <Text dimColor={stats.isZero}>{stats.duration}</Text>
                </Box>
              )
            })}
          </Box>
        </Box>
        <Text dimColor>{`${' '.repeat(LABEL_WIDTH + 1)}${axisLine(columns, a.end - a.start)}`}</Text>
        {verdictRow(kit, turn, a)}
        {historyLine}
      </Box>
    )
  })
}

function headerRow(kit: Kit, turn: FlightTurn, now: number, tick: number) {
  const { Box, Text } = kit
  const subs = turn.subCalls > 0 ? `   ${plural(turn.subCalls, 'sub-agent call')}` : ''
  const counts = `   ${plural(turn.calls, 'call')}   ${plural(turn.steps, 'step')}${subs}`

  if (turn.isRunning) {
    return (
      <Box>
        <Text bold>{'Flight Recorder   '}</Text>
        <Text color={REC_COLOR} dimColor={tick % 2 === 1}>
          ●
        </Text>
        <Text>{' REC  '}</Text>
        <Text bold>{formatClock(now - turn.startedAt)}</Text>
        <Text>{counts}</Text>
      </Box>
    )
  }

  return (
    <Box>
      <Text bold>{'Flight Recorder   '}</Text>
      <Text color={DONE_COLOR}>■</Text>
      <Text>{' '}</Text>
      <Text bold>{formatDuration(turn.durationMs ?? 0)}</Text>
      <Text>{counts}</Text>
    </Box>
  )
}

function verdictRow(kit: Kit, turn: FlightTurn, a: Analysis) {
  const { Box, Text } = kit

  if (turn.isRunning) {
    const now = a.running
    if (!now) {
      return (
        <Box marginTop={1}>
          <Text dimColor>Now: between steps</Text>
        </Box>
      )
    }

    return (
      <Box marginTop={1}>
        <Text dimColor>{'Now: '}</Text>
        <Text color={LANE_COLORS[now.lane]} bold>
          {now.lane}
        </Text>
        <Text>{` · ${now.label} (${formatDuration(now.ms)})`}</Text>
      </Box>
    )
  }

  const top = topLanes(a.totals, a.wallMs, 1)[0]
  if (!top) {
    return (
      <Box marginTop={1}>
        <Text dimColor>Nothing was recorded for this turn.</Text>
      </Box>
    )
  }
  const slowest = a.slowest ? ` · slowest: ${a.slowest.label} ${formatDuration(a.slowest.ms)}` : ''

  return (
    <Box marginTop={1}>
      <Text>{'Most time: '}</Text>
      <Text color={LANE_COLORS[top.lane]} bold>
        {top.lane}
      </Text>
      <Text>{` ${top.pct}%${slowest}`}</Text>
    </Box>
  )
}

function historyRow(kit: Kit, history: readonly FlightSummary[]) {
  const { Text } = kit
  if (history.length < 3) return null

  const { turns, shares } = historyTop(history)
  if (shares.length === 0) return null

  return (
    <Text dimColor>{`Last ${turns} turns: ${shares.map(s => `${s.lane} ${s.pct}%`).join(' · ')}`}</Text>
  )
}
