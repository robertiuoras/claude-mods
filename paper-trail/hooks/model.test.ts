import { describe, expect, test } from 'claude-code/testing'

import { addChange, ago, barCells, changeOf, countPatch, displayPath, fitPath, summaryText, totals } from './model'

const EDIT_RESULT = {
  filePath: '/work/src/app.ts',
  oldString: 'a',
  newString: 'b',
  originalFile: 'a\n',
  structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [' keep', '-old', '+new', '+more', ' keep'] }],
  userModified: false,
  replaceAll: false,
}

describe('changeOf', () => {
  test("an Edit counts its patch's lines", () => {
    expect(changeOf('Edit', {}, EDIT_RESULT)).toEqual({ path: '/work/src/app.ts', added: 2, removed: 1, isNew: false })
  })

  test('a new file counts every line it was written with', () => {
    const result = { type: 'create', filePath: '/work/new.md', content: 'one\ntwo\nthree\n', structuredPatch: [], originalFile: null }
    expect(changeOf('Write', {}, result)).toEqual({ path: '/work/new.md', added: 3, removed: 0, isNew: true })
  })

  test('an overwrite counts its patch, not the whole file', () => {
    const result = {
      type: 'update',
      filePath: '/work/a.txt',
      content: 'x\ny\n',
      originalFile: 'x\nz\n',
      structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' x', '-z', '+y'] }],
    }
    expect(changeOf('Write', {}, result)).toEqual({ path: '/work/a.txt', added: 1, removed: 1, isNew: false })
  })

  test('a write held for review, another tool, or no result counts nothing', () => {
    expect(changeOf('Edit', {}, { ...EDIT_RESULT, staged: true })).toBeUndefined()
    expect(changeOf('Read', {}, { filePath: '/work/a' })).toBeUndefined()
    expect(changeOf('Edit', {}, undefined)).toBeUndefined()
    expect(changeOf('Edit', {}, 'error text')).toBeUndefined()
  })

  test('a notebook cell counts its new source', () => {
    expect(changeOf('NotebookEdit', { notebook_path: '/work/n.ipynb', new_source: 'a\nb', edit_mode: 'insert' }, {})).toEqual({
      path: '/work/n.ipynb',
      added: 2,
      removed: 0,
      isNew: false,
    })
  })
})

test('countPatch skips context lines', () => {
  expect(countPatch([{ lines: [' a', '+b', '-c', '-d'] }, { lines: ['+e'] }])).toEqual({ added: 2, removed: 2 })
})

describe('addChange', () => {
  test('adds up changes to one file and moves it to the top', () => {
    let files = addChange([], { path: '/w/a', added: 3, removed: 0, isNew: true }, 1)
    files = addChange(files, { path: '/w/b', added: 1, removed: 1, isNew: false }, 2)
    files = addChange(files, { path: '/w/a', added: 2, removed: 4, isNew: false }, 3)

    expect(files.map(f => f.path)).toEqual(['/w/a', '/w/b'])
    expect(files[0]).toEqual({ path: '/w/a', added: 5, removed: 4, edits: 2, isNew: true, firstAt: 1, lastAt: 3 })
    expect(totals(files)).toEqual({ added: 6, removed: 5, edits: 3 })
  })
})

describe('barCells', () => {
  test('always five cells, split by what was added and removed', () => {
    expect(barCells(0, 0)).toEqual({ green: 0, red: 0, grey: 5 })
    expect(barCells(100, 0)).toEqual({ green: 5, red: 0, grey: 0 })
    expect(barCells(60, 40)).toEqual({ green: 3, red: 2, grey: 0 })
    expect(barCells(1, 0)).toEqual({ green: 1, red: 0, grey: 4 })
    // One block takes the bigger side's colour; two or more show both.
    expect(barCells(2, 1)).toEqual({ green: 1, red: 0, grey: 4 })
    expect(barCells(19, 1)).toEqual({ green: 1, red: 1, grey: 3 })
  })
})

test('paths read from the working folder, or from home', () => {
  expect(displayPath('/work/src/a.ts', '/work')).toBe('src/a.ts')
  expect(displayPath('/Users/sam/notes/x.md', '/work')).toBe('~/notes/x.md')
  expect(displayPath('/etc/hosts', '/work')).toBe('/etc/hosts')
  expect(fitPath('src/components/very/deep/Button.tsx', 16)).toBe('…deep/Button.tsx')
})

test('ago', () => {
  expect(ago(3_000)).toBe('just now')
  expect(ago(42_000)).toBe('42s ago')
  expect(ago(5 * 60_000)).toBe('5m ago')
  expect(ago(2 * 3_600_000)).toBe('2h ago')
})

test('summaryText', () => {
  expect(summaryText([], '/w')).toBe('Paper Trail: no files changed in this session yet.')
  const files = addChange([], { path: '/w/a.ts', added: 12, removed: 3, isNew: true }, 1)
  expect(summaryText(files, '/w')).toBe('Paper Trail: 1 file  +12 −3  1 edit\n  +12 −3      a.ts  (new)')
})
