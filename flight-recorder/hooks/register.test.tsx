import type { On, UiPane } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

const PLUGIN = 'flight-recorder'
const SURFACES = ['terminal', 'desktop'] as const
const BASE = 1_000_000
// Each recorder tick is a round trip through the engine, so a minute of mocked time takes seconds.
const LONG = { timeoutMs: 60_000 }

const PANE_PROPS = {
  title: 'Flight Recorder',
  isFocused: false,
  bodyColumns: 100,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}
const VIEWPORT = { columns: 120, rows: 40 }

type Rig = {
  clock: MockClock
  /** How long the next tool call or model step stays asleep on the mocked clock. */
  delay: { ms: number }
  toasts: string[]
  panes: UiPane[]
  registered: string[]
  store: Map<string, unknown>
  /** How many times the recorder's tick value was written. */
  ticks: number
}

/** The engine beneath the plugin: a mocked clock and store, panes and toasts kept in memory. */
function stand(on: On): Rig {
  const clock = mock.clock(on, { now: BASE })
  const rig: Rig = { clock, delay: { ms: 0 }, toasts: [], panes: [], registered: [], store: new Map(), ticks: 0 }

  // A store in memory the test can read back (mock.store keeps it out of reach).
  on('store.get', (_$, e) => ({ value: rig.store.get(e.key) }))
  on('store.set', (_$, e) => {
    rig.store.set(e.key, e.value)

    return { value: undefined }
  })

  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', async () => {
    if (rig.delay.ms > 0) await clock.sleep(rig.delay.ms)

    return { result: { stdout: '', stderr: '' }, text: 'ok' }
  })
  on('turn.step', async function* (_$, e) {
    if (rig.delay.ms > 0) await clock.sleep(rig.delay.ms)

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('command.register', (_$, e) => {
    rig.registered.push(e.name)

    return { value: { command: e.name } }
  })
  on('ui.toast', (_$, e) => {
    rig.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    rig.panes.push({ id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: true })

    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_$, e) => {
    rig.panes = rig.panes.filter(pane => pane.id !== e.id)

    return { value: undefined }
  })
  on('ui.panes', () => ({ value: rig.panes }))
  // Each tick of the recorder's clock is one write of its tick value.
  on('state.set', { plugin: PLUGIN, key: 'tick' }, (_$, e, next) => {
    rig.ticks += 1

    return next(e)
  })

  return rig
}

async function drain(stream: AsyncGenerator<unknown, unknown>) {
  let step = await stream.next()
  while (!step.done) step = await stream.next()
}

/** Starts the work, lets it fall asleep on the mocked clock, then moves the clock `ms` on. */
async function within<T>(rig: Rig, ms: number, start: () => Promise<T>): Promise<T> {
  rig.delay.ms = ms
  const work = start()
  await rig.clock.settle()
  await rig.clock.advance(ms)
  rig.delay.ms = 0

  return work
}

const prompt = ($: Engine, text = 'go') => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

function bash($: Engine, id: string, command: string) {
  return $.tool.call({ tool: 'Bash', command, tool_use_id: id })
}

function read($: Engine, id: string, filePath: string) {
  return $.tool.call({ tool: 'Read', file_path: filePath, tool_use_id: id })
}

function complete($: Engine, rig: Rig, startedAt: number, turnId: string) {
  return $.turn.complete({
    answer: 'done',
    durationMs: rig.clock.now() - startedAt,
    isAborted: false,
    turnId,
    reason: 'answer',
  })
}

/** One finished turn: 2s of model, `npm test` for `testMs`, a 1s read, then `idleMs` of nothing. */
async function runTurn($: Engine, rig: Rig, turnId: string, testMs: number, idleMs = 0) {
  const startedAt = rig.clock.now()
  await prompt($)
  await $.turn.start({ text: 'go', turnId })
  await within(rig, 2_000, () => drain($.turn.step({ turnId, index: 0, model: 'm', messageCount: 1 })))
  await within(rig, testMs, () => bash($, `${turnId}-bash`, 'npm test'))
  await within(rig, 1_000, () => read($, `${turnId}-read`, '/work/src/app.ts'))
  if (idleMs > 0) await rig.clock.advance(idleMs)
  await complete($, rig, startedAt, turnId)
}

/** The shortest turn: one `ls` of a second. */
async function quickTurn($: Engine, rig: Rig, turnId: string) {
  const startedAt = rig.clock.now()
  await prompt($)
  await within(rig, 1_000, () => bash($, `${turnId}-bash`, 'ls'))
  await complete($, rig, startedAt, turnId)
}

const MOUNT = { plugin: PLUGIN, component: 'Pane' as const, requestId: 'flight', props: PANE_PROPS, viewport: VIEWPORT }

test('draws the lane stats of a finished turn on terminal and desktop', LONG, async ($, on) => {
  const rig = stand(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await runTurn($, rig, 't1', 48_000)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...MOUNT, surface })

    // Lane labels and the stats column: 2s model, 48s shell, 1s read of 51s.
    expect(await ui.find({ type: 'Text', text: /Shell/ })).toBeDefined()
    const shares = await ui.findAll({ type: 'Text', text: /^\s*\d+%$/ })
    expect(shares).toHaveLength(7)
    expect(shares.map(share => share.text.trim())).toEqual(['4%', '94%', '2%', '0%', '0%', '0%', '0%'])

    // Header and verdict.
    expect(await ui.find({ type: 'Text', text: /■/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 calls/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 step/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /94% · slowest: npm test 48s/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Waiting for the next turn/ })).toBeUndefined()

    // Raster on the terminal, grouped Text runs everywhere else.
    const raster = await ui.find({ key: 'grid' })
    if (surface === 'terminal') {
      expect(raster?.type).toBe('Raster')
      expect(raster?.props).toMatchObject({ rows: 7, columns: 79 })
    } else {
      expect(raster).toBeUndefined()
      expect((await ui.findAll({ type: 'Text', text: /^[█·]+$/ })).length).toBeGreaterThan(7)
    }
    await ui.unmount()
  }
  // 51s is under a minute: no toast.
  expect(rig.toasts).toEqual([])
})

test('shows what is running now, and the clock stops ticking when the turn ends', LONG, async ($, on) => {
  const rig = stand(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const startedAt = rig.clock.now()
  await prompt($)
  await $.turn.start({ text: 'go', turnId: 't1' })

  rig.delay.ms = 48_000
  const call = bash($, 'b1', 'npm test')
  await rig.clock.settle()
  await rig.clock.advance(5_000)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...MOUNT, surface })
    expect(await ui.find({ type: 'Text', text: /REC/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /00:05/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /· npm test \(5s\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Shell$/ })).toBeDefined()
    await ui.unmount()
  }

  // About five redraws a second while it runs.
  expect(rig.ticks).toBeGreaterThanOrEqual(24)
  expect(rig.ticks).toBeLessThanOrEqual(26)

  // The red dot blinks: it dims on every other tick.
  const ui = await $.ui.mount({ ...MOUNT, surface: 'terminal' })
  const dot = async () => (await ui.find({ type: 'Text', text: /●/ }))?.props.dimColor
  const before = await dot()
  await rig.clock.advance(200)
  expect(await dot()).toBe(!before)
  await rig.clock.advance(200)
  expect(await dot()).toBe(before)

  await rig.clock.advance(42_600)
  await call
  rig.delay.ms = 0
  await complete($, rig, startedAt, 't1')
  expect(await ui.find({ type: 'Text', text: /■/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /●/ })).toBeUndefined()

  // Ended: no more redraws, however long the clock moves.
  const written = rig.ticks
  await rig.clock.advance(30_000)
  expect(rig.ticks).toBe(written)
  await ui.unmount()
})

test('toasts the verdict when a turn takes over a minute', LONG, async ($, on) => {
  const rig = stand(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const startedAt = rig.clock.now()
  await prompt($)
  await within(rig, 48_000, () => bash($, 'b1', 'npm test'))
  await rig.clock.advance(24_000)
  await complete($, rig, startedAt, 't1')

  expect(rig.toasts).toEqual(['Flight Recorder: 1m 12s · Shell 67% · slowest: npm test 48s'])
})

test('keeps the last 50 turns in the store and shows the shares after three', LONG, async ($, on) => {
  const rig = stand(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  for (let n = 1; n <= 2; n++) await runTurn($, rig, `t${n}`, 10_000)
  const few = await $.ui.mount({ ...MOUNT, surface: 'terminal' })
  expect(await few.find({ type: 'Text', text: /^Last \d+ turns/ })).toBeUndefined()
  await few.unmount()

  await runTurn($, rig, 't3', 10_000)
  const three = await $.ui.mount({ ...MOUNT, surface: 'desktop' })
  expect(await three.find({ type: 'Text', text: /^Last 3 turns: Shell \d+%/ })).toBeDefined()
  await three.unmount()

  for (let n = 4; n <= 52; n++) await quickTurn($, rig, `t${n}`)
  const history = rig.store.get('history') as { at: number; durationMs: number; calls: number }[]
  expect(history).toHaveLength(50)
  expect(history[49]).toMatchObject({ durationMs: 1_000, calls: 1 })
  expect(history[0]?.at).toBeLessThan(history[49]?.at ?? 0)
  expect(history[0]).toHaveProperty('lanes')
  expect(history[0]).toHaveProperty('slowest')
})

test('keeps turns another session saved to the shared history', async ($, on) => {
  const rig = stand(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await quickTurn($, rig, 't1')

  // Another session running the mod saves a turn in between.
  const other = { at: 1, durationMs: 9_000, calls: 3, lanes: { Model: 9_000, Shell: 0, Read: 0, Edit: 0, Agents: 0, Web: 0, Other: 0 } }
  rig.store.set('history', [...(rig.store.get('history') as unknown[]), other])

  await quickTurn($, rig, 't2')
  const history = rig.store.get('history') as { durationMs: number }[]
  expect(history.map(entry => entry.durationMs)).toEqual([1_000, 9_000, 1_000])
})

test('counts sub-agent calls apart and keeps their steps off the timeline', async ($, on) => {
  const rig = stand(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const startedAt = rig.clock.now()
  await prompt($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await within(rig, 3_000, () => drain($.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1, agentId: 'sub-1' })))
  // $.tool.call is typed without the loop's agentId, which the engine's own calls carry.
  const subCall = { tool: 'Read', file_path: '/work/a.ts', tool_use_id: 'sub-r', agentId: 'sub-1' } as never
  await within(rig, 3_000, () => $.tool.call(subCall))
  await within(rig, 6_000, () => bash($, 'b1', 'ls'))
  await complete($, rig, startedAt, 't1')

  const ui = await $.ui.mount({ ...MOUNT, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1 call/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 sub-agent call/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /0 steps/ })).toBeDefined()
  await ui.unmount()
})

test('/flight opens the pane when closed and closes it when open, and nothing opens on its own', async ($, on) => {
  const rig = stand(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect(rig.registered).toEqual(['flight'])
  expect(rig.panes).toEqual([])

  const run = () =>
    $.command.run({
      command: 'flight',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })

  expect(await run()).toMatchObject({ text: 'Flight Recorder opened.' })
  expect(rig.panes.map(pane => [pane.id, pane.title])).toEqual([['flight', 'Flight Recorder']])
  expect(await run()).toMatchObject({ text: 'Flight Recorder closed.' })
  expect(rig.panes).toEqual([])
})

test('waits quietly before the first turn', async ($, on) => {
  stand(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...MOUNT, surface })
    expect(await ui.find({ type: 'Text', text: /Waiting for the next turn… \(ask Claude anything\)/ })).toBeDefined()
    expect(await ui.find({ key: 'grid' })).toBeUndefined()
    await ui.unmount()
  }
})

test('one turn however it starts, and a prompt nothing follows is dropped', LONG, async ($, on) => {
  const rig = stand(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...MOUNT, surface: 'terminal' })

  // prompt.submit then turn.start: one turn, still on its first second when the id arrives.
  const startedAt = rig.clock.now()
  await prompt($)
  await rig.clock.advance(1_000)
  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(await ui.find({ type: 'Text', text: /00:01/ }), 'clock reads 00:01').toBeDefined()

  // Once turn.start has confirmed it, a quiet turn is not dropped.
  await rig.clock.advance(11_000)
  expect(await ui.find({ type: 'Text', text: /REC/ }), 'quiet engaged turn still REC').toBeDefined()
  expect(await ui.find({ type: 'Text', text: /00:12/ }), 'clock reads 00:12').toBeDefined()
  await complete($, rig, startedAt, 't1')
  expect(await ui.find({ type: 'Text', text: /■/ }), 'ended turn shows ■').toBeDefined()

  // A prompt with no step, call or turn.start behind it (a slash command) is dropped
  // after ten seconds, and the pane goes back to the turn it showed before.
  await prompt($, '/flight')
  expect(await ui.find({ type: 'Text', text: /REC/ }), 'slash prompt records').toBeDefined()
  await rig.clock.advance(11_000)
  expect(await ui.find({ type: 'Text', text: /REC/ }), 'slash prompt dropped').toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^12s$/ }), 'previous turn restored').toBeDefined()
  await ui.unmount()
})
