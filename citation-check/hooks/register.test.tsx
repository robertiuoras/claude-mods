import type { On, SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

type Rig = {
  /** What `$.session.messages()` answers: the main conversation as the transcript holds it. */
  messages: SessionMessage[] | Error
  /** What each tool answers the model with, by tool name. */
  outputs: Record<string, string>
}

/** The engine beneath the plugin: tools answer from `outputs`, the transcript from `messages`. */
function stand(on: On): Rig {
  const rig: Rig = { messages: [], outputs: {} }

  on('session.start', () => ({ cwd: '/work' }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.call', (_$, e) => ({ result: {}, text: rig.outputs[e.tool] ?? 'ok' }) as never)
  on('session.messages', () => {
    if (rig.messages instanceof Error) throw rig.messages

    return { value: rig.messages }
  })

  return rig
}

function complete($: Engine, answer: string, more: { agentId?: string; reason?: 'answer' | 'aborted' } = {}) {
  const { reason = 'answer', agentId } = more

  return $.turn.complete({
    answer,
    durationMs: 1_000,
    isAborted: reason === 'aborted',
    turnId: 't1',
    reason,
    ...(agentId === undefined ? {} : { agentId }),
  })
}

function fetch($: Engine, url: string, agentId?: string) {
  // $.tool.call is typed without the loop's agentId, which the engine's own calls carry.
  const call = { tool: 'WebFetch', url, prompt: 'summarise', tool_use_id: `f-${url}`, agentId }

  return $.tool.call(call as never)
}

const ANSWER = 'Sources: [RFC 2606](https://www.rfc-editor.org/rfc/rfc2606) and https://www.rfc-editor.org/rfc/rfc2606-errata.'

test('names only the link that was never opened', async ($, on) => {
  stand(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await fetch($, 'https://www.rfc-editor.org/rfc/rfc2606')

  const result = await complete($, ANSWER)
  expect(result.text).toBe(
    '2 links in this answer · 1 never opened: https://www.rfc-editor.org/rfc/rfc2606-errata',
  )
})

test('stays silent when every link was opened, or there are none', async ($, on) => {
  stand(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await fetch($, 'https://www.rfc-editor.org/rfc/rfc2606')
  await $.tool.call({ tool: 'Bash', command: 'curl -sI https://www.rfc-editor.org/rfc/rfc2606-errata', tool_use_id: 'b1' })

  expect((await complete($, ANSWER)).text).toBe(ANSWER)
  expect((await complete($, 'No links, just ok.')).text).toBe('No links, just ok.')
})

test("counts a search hit apart, and a sub-agent's fetch as opened", async ($, on) => {
  const rig = stand(on)
  rig.outputs.WebSearch = 'Links: [{"title":"Errata","url":"https://www.rfc-editor.org/rfc/rfc2606-errata"}]'
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'WebSearch', query: 'rfc 2606 errata', tool_use_id: 's1' })
  await fetch($, 'https://www.rfc-editor.org/rfc/rfc2606', 'sub-1')

  expect((await complete($, ANSWER)).text).toBe(
    '2 links in this answer · 1 only seen in search results or fetched pages: https://www.rfc-editor.org/rfc/rfc2606-errata',
  )
})

test('files what the transcript holds from before this load', async ($, on) => {
  const rig = stand(on)
  rig.messages = [
    { role: 'user', text: 'Is https://www.rfc-editor.org/rfc/rfc2606-errata real?', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [
        {
          tool_use_id: 'old',
          tool: 'WebFetch',
          input: { url: 'https://www.rfc-editor.org/rfc/rfc2606', prompt: 'p' },
          text: 'RFC 2606',
        },
      ],
    },
  ]
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  expect((await complete($, ANSWER)).text).toBe(ANSWER)
})

test("leaves a sub-agent's answer and an interrupted turn alone", async ($, on) => {
  stand(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  expect((await complete($, ANSWER, { agentId: 'sub-1' })).text).toBe(ANSWER)
  expect((await complete($, ANSWER, { reason: 'aborted' })).text).toBe(ANSWER)
})

test('passes every tool result on unchanged', async ($, on) => {
  const rig = stand(on)
  rig.outputs.Bash = 'https://github.com/o/r/pull/7'
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const result = await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill', tool_use_id: 'b1' })
  expect(result).toEqual({ result: {}, text: 'https://github.com/o/r/pull/7' })
})

test('a failure inside the check leaves the result and the answer as they were', async ($, on) => {
  const rig = stand(on)
  // Output that is not text makes the filing throw after the call has answered.
  rig.outputs.Bash = 42 as never
  rig.messages = new Error('transcript unavailable')
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const call = await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'b1' })
  expect(call).toEqual({ result: {}, text: 42 })
  expect((await complete($, ANSWER)).text).toBe(ANSWER)
})
