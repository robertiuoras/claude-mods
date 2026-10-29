import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, Timer } from 'claude-code'

import type { TrailFile } from '../types'
import {
  ADD_COLOR,
  BAR_WIDTH,
  EMPTY_COLOR,
  NEW_COLOR,
  REMOVE_COLOR,
  addChange,
  ago,
  barCells,
  changeOf,
  displayPath,
  fitPath,
  plural,
  summaryText,
  totals,
} from './model'

const PANE = 'trail'
const COUNTS_WIDTH = 13
const META_WIDTH = 16
const NEW_WIDTH = 4
// "2m ago" moves on its own; one redraw a quarter-minute keeps it honest.
const TICK_MS = 15_000

// Change the tag when a file's fields change: it declines what an earlier version stored.
const filesAtom = atom({ plugin: 'paper-trail', key: 'files' } as const, [], { shape: 'files-1' })
const cwdAtom = atom({ plugin: 'paper-trail', key: 'cwd' } as const, '')
const tickAtom = atom({ plugin: 'paper-trail', key: 'tick' } as const, 0)

type Kit = Pick<Elements['terminal'], 'Box' | 'Text'>

let timer: Timer | undefined

async function isOpen($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await update($, cwdAtom, () => started.cwd ?? '')
    await $.command.register({
      name: 'trail',
      description: 'Show or hide Paper Trail (every file Claude changed this session)',
      immediate: true,
    })
    timer?.cancel()
    timer = $.clock.every(TICK_MS, async () => {
      if ((await read($, filesAtom)).length > 0) await update($, tickAtom, n => n + 1)
    })

    return started
  })

  on('command.run', { command: 'trail' }, async $ => {
    if (await isOpen($)) {
      await $.ui.close({ id: PANE })

      return { text: 'Paper Trail closed.' }
    }

    const files = await read($, filesAtom)
    const rows = Math.min(24, Math.max(6, files.length + 4))
    const opened = await $.ui.open({ id: PANE, title: 'Paper Trail', rows, columns: 88 })
    if (opened.isPlaced) return { text: 'Paper Trail opened.' }

    return { text: summaryText(files, await read($, cwdAtom)) }
  })

  // Work after `next`: the write happens first, and a failure here leaves its result as it was.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (result.deny !== undefined || result.isError === true) return result

    const change = changeOf(e.tool, e, result.result)
    if (change === undefined) return result

    const at = await $.clock.now()
    await update($, filesAtom, files => addChange(files, change, at))

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const files = await read($, filesAtom)
    const cwd = await read($, cwdAtom)
    await read($, tickAtom)
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)
    const kit: Kit = { Box, Text }

    if (files.length === 0) {
      return (
        <Box flexDirection="column">
          <Text bold>Paper Trail</Text>
          <Text dimColor>No files changed yet. Every file Claude edits or writes shows up here.</Text>
        </Box>
      )
    }

    const bodyColumns = e.props.bodyColumns > 0 ? e.props.bodyColumns : (e.viewport?.columns ?? 80)
    const room = Math.max(1, (e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 20) - 3)
    const shown = files.slice(0, room)
    const paths = shown.map(file => displayPath(file.path, cwd))
    // As wide as the longest path and its "new" needs, so the times sit beside the paths.
    const widest = Math.max(...paths.map(path => path.length)) + NEW_WIDTH + 2
    const pathWidth = Math.max(8, Math.min(widest, bodyColumns - COUNTS_WIDTH - BAR_WIDTH - 2 - META_WIDTH))

    return (
      <Box flexDirection="column">
        {headerRow(kit, files)}
        <Box flexDirection="column" marginTop={1}>
          {shown.map((file, i) => fileRow(kit, file, paths[i]!, pathWidth, now))}
          {files.length > shown.length && <Text dimColor>{`…and ${files.length - shown.length} more`}</Text>}
        </Box>
      </Box>
    )
  })
}

function headerRow(kit: Kit, files: readonly TrailFile[]) {
  const { Box, Text } = kit
  const t = totals(files)
  const created = files.filter(file => file.isNew).length

  return (
    <Box>
      <Text bold>{'Paper Trail   '}</Text>
      <Text bold>{plural(files.length, 'file')}</Text>
      <Text>{'   '}</Text>
      <Text color={ADD_COLOR} bold>{`+${t.added}`}</Text>
      <Text>{' '}</Text>
      <Text color={REMOVE_COLOR} bold>{`−${t.removed}`}</Text>
      <Text dimColor>{`   ${plural(t.edits, 'edit')}${created > 0 ? ` · ${created} new` : ''}`}</Text>
    </Box>
  )
}

function fileRow(kit: Kit, file: TrailFile, path: string, pathWidth: number, now: number) {
  const { Box, Text } = kit
  const bar = barCells(file.added, file.removed)
  const meta = `${file.edits > 1 ? `×${file.edits}  ` : ''}${ago(now - file.lastAt)}`

  return (
    <Box>
      <Box width={COUNTS_WIDTH} flexShrink={0}>
        <Text color={ADD_COLOR}>{`+${file.added}`.padStart(5)}</Text>
        <Text color={REMOVE_COLOR}>{` −${file.removed}`.padEnd(7)}</Text>
      </Box>
      <Box width={BAR_WIDTH + 2} flexShrink={0}>
        <Text color={ADD_COLOR}>{'■'.repeat(bar.green)}</Text>
        <Text color={REMOVE_COLOR}>{'■'.repeat(bar.red)}</Text>
        <Text color={EMPTY_COLOR}>{'■'.repeat(bar.grey)}</Text>
      </Box>
      <Box width={pathWidth} flexShrink={0}>
        <Text>{fitPath(path, pathWidth - NEW_WIDTH - 2)}</Text>
        {file.isNew && <Text color={NEW_COLOR}>{' new'}</Text>}
      </Box>
      <Box width={META_WIDTH} flexShrink={0}>
        <Text dimColor>{meta}</Text>
      </Box>
    </Box>
  )
}
