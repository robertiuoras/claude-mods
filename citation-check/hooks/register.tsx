import type { EngineInterface, Register } from 'claude-code'

import { checkAnswer, emptySources, noteCall, noteMessage, noteText } from './model'

// Every loop's calls, sub-agents' included, filed as they finish; a reload starts it over.
const sources = emptySources()
// How many rows of the main conversation are already filed into `sources`.
let filed = 0

/** Files the rows no `tool.call` hook of this load saw: a resumed session's, or before a reload. */
async function fileTranscript($: EngineInterface) {
  const messages = await $.session.messages()
  // A compaction or /clear shortened the list: file it from the top again.
  if (messages.length < filed) filed = 0
  for (const message of messages.slice(filed)) noteMessage(sources, message)
  filed = messages.length
}

export const register: Register = on => {
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    // The check only watches; nothing it hits may fail the call.
    try {
      noteCall(sources, e.tool, e, result.text)
    } catch {}

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer' || !/https?:\/\//i.test(e.answer)) return result

    try {
      await fileTranscript($)
      const text = noteText(checkAnswer(e.answer, sources))

      // A text other than the answer is shown beneath it; the transcript and the model never see it.
      return text === undefined ? result : { ...result, text }
    } catch {
      return result
    }
  })
}
