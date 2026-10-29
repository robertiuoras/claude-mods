import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

type Rig = {
  /** The label the person picks in the dialog, or an error for a dismissed one. */
  answer: string | Error
  questions: string[]
  ran: string[]
  toasts: string[]
  status: (string | undefined)[]
  /** Makes keeping a record fail: it starts by reading the clock. */
  isClockBroken: boolean
}

/** The engine beneath the mod: shell commands are noted as run, the dialog answers from `answer`. */
function stand(on: On): Rig {
  const rig: Rig = { answer: 'Run it', questions: [], ran: [], toasts: [], status: [], isClockBroken: false }

  on('session.start', () => ({ cwd: '/work' }))
  on('clock.now', () => {
    if (rig.isClockBroken) throw new Error('clock is gone')

    return { value: 1_000_000 }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.call', (_$, e) => {
    if (e.tool === 'AskUserQuestion') {
      const asked = (e as unknown as { questions: { question: string }[] }).questions[0]!.question
      rig.questions.push(asked)
      if (rig.answer instanceof Error) throw rig.answer

      return { result: { questions: [], answers: { [asked]: rig.answer } } } as never
    }
    if (e.tool === 'Bash') rig.ran.push((e as { command: string }).command)

    return { result: { stdout: '', stderr: '' }, text: 'ok' } as never
  })
  on('ui.toast', (_$, e) => {
    rig.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    rig.status.push(e.text)

    return { value: undefined }
  })

  return rig
}

function bash($: Engine, command: string) {
  return $.tool.call({ tool: 'Bash', command, tool_use_id: `b-${command}` } as never)
}

test('an ordinary command runs untouched and asks nothing', async ($, on) => {
  const rig = stand(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const result = await bash($, 'rm -rf node_modules')

  expect(result.deny).toBeUndefined()
  expect(rig.ran).toEqual(['rm -rf node_modules'])
  expect(rig.questions).toEqual([])
})

test('wiping the home folder is refused without asking, and the person is told', async ($, on) => {
  const rig = stand(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const result = await bash($, 'cd /tmp && rm -rf ~')

  expect(result.deny).toContain('Safety Net blocked this command: it deletes your home folder.')
  expect(rig.ran).toEqual([])
  expect(rig.questions).toEqual([])
  expect(rig.toasts).toEqual(['Blocked: rm -rf ~'])
  expect(rig.status.at(-1)).toBe('Safety Net: 1 command stopped')
})

test('a hard reset runs once the person says run it', async ($, on) => {
  const rig = stand(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const result = await bash($, 'git reset --hard origin/main')

  expect(result.deny).toBeUndefined()
  expect(rig.questions).toEqual([
    'Claude wants to run `git reset --hard origin/main`, and it throws away every uncommitted change. Run it?',
  ])
  expect(rig.ran).toEqual(['git reset --hard origin/main'])
})

test("a hard reset is refused when the person says don't", async ($, on) => {
  const rig = stand(on)
  rig.answer = "Don't run it"
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const result = await bash($, 'git reset --hard')

  expect(result.deny).toContain('the user chose not to run this command')
  expect(rig.ran).toEqual([])
})

test('a dismissed question, or nobody there to ask, counts as no', async ($, on) => {
  const rig = stand(on)
  rig.answer = new Error('dismissed')
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const result = await bash($, 'git push --force origin main')

  expect(result.deny).toContain("needs the user's yes and nobody gave it")
  expect(rig.ran).toEqual([])
})

test('a stop is still a stop when its record cannot be kept', async ($, on) => {
  const rig = stand(on)
  rig.isClockBroken = true
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const result = await bash($, 'rm -rf /')

  expect(result.deny).toContain('Safety Net blocked this command')
  expect(rig.ran).toEqual([])
})

test('/safety-net lists what was caught this session', async ($, on) => {
  const rig = stand(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ command: 'safety-net', args: '' } as never)).text).toBe(
    'Safety Net is on. Nothing has been stopped in this session.',
  )

  await bash($, 'rm -rf /')
  rig.answer = "Don't run it"
  await bash($, 'git clean -fdx')

  const { text } = await $.command.run({ command: 'safety-net', args: '' } as never)
  expect(text).toBe(
    [
      'Safety Net, this session: 2 commands caught',
      '  blocked    rm -rf /  (it deletes the whole disk)',
      '  not run    git clean -fdx  (it deletes every untracked file, ignored ones too (.env, builds))',
    ].join('\n'),
  )
})
