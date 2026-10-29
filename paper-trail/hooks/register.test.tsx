import type { On, UiPane } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const PANE = {
  plugin: 'paper-trail',
  component: 'Pane',
  requestId: 'trail',
  props: {
    title: 'Paper Trail',
    isFocused: false,
    bodyColumns: 88,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

type Rig = { now: number; panes: UiPane[]; isError: boolean }

/** The engine beneath the mod: Edit and Write answer with a result shaped like core's own. */
function stand(on: On): Rig {
  const rig: Rig = { now: 1_000_000, panes: [], isError: false }

  on('session.start', () => ({ cwd: '/work' }))
  on('clock.now', () => ({ value: rig.now }))
  on('clock.every', () => ({ value: { cancel() {} } }) as never)
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', (_$, e) => {
    rig.panes.push({ id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: true })

    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_$, e) => {
    rig.panes = rig.panes.filter(pane => pane.id !== e.id)

    return { value: undefined }
  })
  on('ui.panes', () => ({ value: rig.panes }))
  on('tool.call', (_$, e) => {
    if (rig.isError) return { result: 'File has not been read yet.', isError: true, text: 'error' } as never
    if (e.tool === 'Edit') {
      const lines = ['-old', '+new', '+more']

      return { result: { filePath: (e as { file_path: string }).file_path, structuredPatch: [{ lines }] }, text: 'ok' } as never
    }
    if (e.tool === 'Write') {
      const content = (e as { content: string }).content

      return { result: { type: 'create', filePath: (e as { file_path: string }).file_path, content, structuredPatch: [], originalFile: null }, text: 'ok' } as never
    }

    return { result: {}, text: 'ok' } as never
  })

  return rig
}

function edit($: Engine, file_path: string) {
  return $.tool.call({ tool: 'Edit', file_path, old_string: 'old', new_string: 'new\nmore', tool_use_id: `e-${file_path}` } as never)
}

function write($: Engine, file_path: string, content: string) {
  return $.tool.call({ tool: 'Write', file_path, content, tool_use_id: `w-${file_path}` } as never)
}

test('the pane lists each changed file with its lines, on every surface', async ($, on) => {
  const rig = stand(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  await write($, '/work/src/new.ts', 'a\nb\nc\n')
  rig.now += 60_000
  await edit($, '/work/src/app.ts')
  await edit($, '/work/src/app.ts')
  rig.now += 30_000

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: '2 files' }))?.text).toBe('2 files')
    expect((await ui.find({ type: 'Text', text: '+7' }))?.text).toBe('+7')
    expect((await ui.find({ type: 'Text', text: '−2' }))?.text).toBe('−2')
    expect(await ui.find({ type: 'Text', text: 'src/app.ts' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '×2  30s ago' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'src/new.ts' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' new' })).toBeDefined()
    await ui.unmount()
  }
})

test('a failed edit is not counted', async ($, on) => {
  const rig = stand(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  rig.isError = true
  await edit($, '/work/a.ts')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /No files changed yet/ }))?.text).toContain('No files changed yet')
  await ui.unmount()
})

test('/trail opens the pane, and again closes it', async ($, on) => {
  const rig = stand(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  expect((await $.command.run({ command: 'trail', args: '' } as never)).text).toBe('Paper Trail opened.')
  expect(rig.panes.map(p => p.id)).toEqual(['trail'])
  expect((await $.command.run({ command: 'trail', args: '' } as never)).text).toBe('Paper Trail closed.')
  expect(rig.panes).toEqual([])
})

test('a list an earlier version stored is declined', async ($, on) => {
  stand(on)
  on('state.get', () => ({ value: { value: [{ path: '/old' }], version: 1 } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /No files changed yet/ }))?.text).toContain('No files changed yet')
  await ui.unmount()
})
