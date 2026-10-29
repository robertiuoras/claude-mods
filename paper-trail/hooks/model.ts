import type { TrailFile } from '../types'

/** One successful write to one file, as the tool's own result reports it. */
export type Change = { path: string; added: number; removed: number; isNew: boolean }

type Hunk = { lines: readonly string[] }

export const BAR_WIDTH = 5
export const ADD_COLOR = '#3FB950'
export const REMOVE_COLOR = '#F85149'
export const EMPTY_COLOR = '#30363D'
export const NEW_COLOR = '#58A6FF'
export const MAX_FILES = 200

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** Lines added and removed in a unified-diff patch, as `git diff --stat` counts them. */
export function countPatch(hunks: readonly Hunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }

  return { added, removed }
}

function lineCount(text: string): number {
  if (text === '') return 0

  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * The change an Edit, Write or NotebookEdit made, read from its result; nothing for any other
 * tool, a failed call, or a write held for review (`staged`) that left the file as it was.
 */
export function changeOf(tool: string, input: unknown, result: unknown): Change | undefined {
  if (!isObject(result) || result.staged === true) return undefined

  if (tool === 'Edit' && typeof result.filePath === 'string' && Array.isArray(result.structuredPatch)) {
    return { path: result.filePath, ...countPatch(result.structuredPatch as Hunk[]), isNew: false }
  }

  if (tool === 'Write' && typeof result.filePath === 'string' && typeof result.content === 'string') {
    const isNew = result.type === 'create'
    const patch = Array.isArray(result.structuredPatch) ? (result.structuredPatch as Hunk[]) : []
    // A new file's patch is empty: every line of it is new.
    const isWhole = isNew || (patch.length === 0 && result.originalFile === null)
    const counts = isWhole ? { added: lineCount(result.content), removed: 0 } : countPatch(patch)

    return { path: result.filePath, ...counts, isNew }
  }

  if (tool === 'NotebookEdit' && isObject(input) && typeof input.notebook_path === 'string') {
    const source = typeof input.new_source === 'string' ? input.new_source : ''
    const mode = input.edit_mode
    const added = mode === 'delete' ? 0 : lineCount(source)

    return { path: input.notebook_path, added, removed: 0, isNew: false }
  }

  return undefined
}

/** Files newest-changed first, with `change` folded into its file's running totals. */
export function addChange(files: readonly TrailFile[], change: Change, at: number): TrailFile[] {
  const before = files.find(file => file.path === change.path)
  const file: TrailFile = before
    ? {
        ...before,
        added: before.added + change.added,
        removed: before.removed + change.removed,
        edits: before.edits + 1,
        lastAt: at,
      }
    : { path: change.path, added: change.added, removed: change.removed, edits: 1, isNew: change.isNew, firstAt: at, lastAt: at }

  return [file, ...files.filter(one => one.path !== change.path)].slice(0, MAX_FILES)
}

export function totals(files: readonly TrailFile[]) {
  return files.reduce(
    (sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed, edits: sum.edits + file.edits }),
    { added: 0, removed: 0, edits: 0 },
  )
}

/** `git diff --stat`'s little bar: green for added, red for removed, grey for a change of none. */
export function barCells(added: number, removed: number): { green: number; red: number; grey: number } {
  const total = added + removed
  if (total === 0) return { green: 0, red: 0, grey: BAR_WIDTH }

  // Small changes draw fewer blocks, as git's does; anything past 50 lines fills the bar.
  const filled = Math.min(BAR_WIDTH, Math.max(1, Math.ceil((total / 50) * BAR_WIDTH)))
  let green = Math.round((added / total) * filled)
  // With room for two blocks, a change with both kinds of line shows both colours.
  if (filled >= 2 && added > 0 && green === 0) green = 1
  if (filled >= 2 && removed > 0 && green === filled) green = filled - 1
  const red = filled - green

  return { green, red, grey: BAR_WIDTH - filled }
}

/** The path as the person thinks of it: under the working folder, or under home as `~`. */
export function displayPath(path: string, cwd: string | undefined): string {
  if (cwd && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1)

  return path.replace(/^\/(Users|home)\/[^/]+\//, '~/')
}

/** Keeps the end of a long path, where the file's own name is. */
export function fitPath(path: string, width: number): string {
  if (path.length <= width) return path
  if (width <= 1) return '…'

  return `…${path.slice(path.length - width + 1)}`
}

export function ago(ms: number): string {
  if (ms < 10_000) return 'just now'
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`

  return `${Math.floor(ms / 3_600_000)}h ago`
}

/** A plain-text table, for `/trail` where no pane can be drawn. */
export function summaryText(files: readonly TrailFile[], cwd: string | undefined): string {
  if (files.length === 0) return 'Paper Trail: no files changed in this session yet.'

  const t = totals(files)
  const rows = files.slice(0, 15).map(file => {
    const counts = `+${file.added} −${file.removed}`.padEnd(12)

    return `  ${counts}${displayPath(file.path, cwd)}${file.isNew ? '  (new)' : ''}`
  })
  const more = files.length > 15 ? [`  …and ${files.length - 15} more`] : []

  return [`Paper Trail: ${plural(files.length, 'file')}  +${t.added} −${t.removed}  ${plural(t.edits, 'edit')}`, ...rows, ...more].join('\n')
}
