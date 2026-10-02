import type { EngineInterface, Register } from 'claude-code'

import { checkAnswer, emptySources, noteCall, noteMessage, noteText } from './model'

// Every loop's calls, sub-agents' included, filed as they finish; a reload starts it over.
const sources = emptySources()

/**
 * Files the rows no `tool.call` hook of this load saw: a resumed session's, or before a reload.
 * The whole list each time: it is the newest 4096 rows, so a count of rows already filed drifts.
 */
async function fileTranscript($: EngineInterface) {
  for (const message of await $.session.messages()) noteMessage(sources, message)
}

// Both hooks work after `next`: if one fails, the call's result or the answer stands and the
// engine logs the failure.
export const register: Register = on => {
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    noteCall(sources, e.tool, e, result.text)

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer' || !/https?:\/\//i.test(e.answer)) return result

    await fileTranscript($)
    const text = noteText(checkAnswer(e.answer, sources))

    // A text other than the answer is shown beneath it; the transcript and the model never see it.
    return text === undefined ? result : { ...result, text }
  })
}
