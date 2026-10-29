import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SafetyEvent } from '../types'
import { checkCommand, clip, denyText, plural, questionText } from './model'
import type { Verdict } from './model'

const RUN = 'Run it'
const STOP = "Don't run it"
const MAX_EVENTS = 50

const events = atom({ plugin: 'safety-net', key: 'events' } as const, [])

/** Records a stop for `/safety-net` and the status line; a failure here never lets a command through. */
async function note($: EngineInterface, v: Verdict, outcome?: SafetyEvent['outcome']) {
  try {
    await record($, v, outcome)
  } catch {
    // The verdict stands without its record.
  }
}

async function record($: EngineInterface, v: Verdict, outcome?: SafetyEvent['outcome']) {
  const event: SafetyEvent = { at: await $.clock.now(), level: v.level, rule: v.rule, why: v.why, what: v.what, ...(outcome ? { outcome } : {}) }
  const list = await update($, events, all => [...all, event].slice(-MAX_EVENTS))
  const stopped = list.filter(one => one.level === 'block' || one.outcome !== 'ran').length
  $.ui.status(stopped > 0 ? `Safety Net: ${plural(stopped, 'command')} stopped` : undefined)
}

/** The person's answer to an ask; a dismissed dialog or a run with no one to ask counts as no. */
async function askPerson($: EngineInterface, v: Verdict): Promise<SafetyEvent['outcome']> {
  try {
    const answer = await $.ui.ask(questionText(v), { header: 'Safety Net', options: [RUN, STOP] })

    return answer === RUN ? 'ran' : 'declined'
  } catch {
    return 'unanswered'
  }
}

function report(list: readonly SafetyEvent[]): string {
  if (list.length === 0) return 'Safety Net is on. Nothing has been stopped in this session.'

  const lines = list.slice(-10).map(one => {
    const how = one.level === 'block' ? 'blocked' : one.outcome === 'ran' ? 'you ran it' : 'not run'
    return `  ${how.padEnd(10)} ${clip(one.what, 70)}  (${one.why})`
  })

  return [`Safety Net, this session: ${plural(list.length, 'command')} caught`, ...lines].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'safety-net',
      description: 'Show which shell commands Safety Net stopped in this session',
      immediate: true,
    })

    return next(e)
  })

  on('command.run', { command: 'safety-net' }, async $ => ({ text: report(await read($, events)) }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    let v: Verdict | undefined
    try {
      v = checkCommand(e.command)
    } catch {
      // A check that fails must not stop every shell command: the command runs as if unchecked.
      return next(e)
    }
    if (v === undefined) return next(e)

    if (v.level === 'block') {
      await note($, v)
      try {
        $.ui.toast(`Blocked: ${clip(v.what, 60)}`)
      } catch {
        // The block stands without its toast.
      }

      return { deny: denyText(v, 'blocked') }
    }

    const outcome = await askPerson($, v)
    await note($, v, outcome)
    if (outcome === 'ran') return next(e)

    return { deny: denyText(v, outcome === 'declined' ? 'declined' : 'unanswered') }
  })
}
