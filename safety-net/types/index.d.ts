/** One command Safety Net stopped or put to the person, newest last. */
export type SafetyEvent = {
  at: number
  level: 'block' | 'ask'
  rule: string
  why: string
  what: string
  /** For an ask: what the person chose. Absent for a block. */
  outcome?: 'ran' | 'declined' | 'unanswered'
}

declare module 'claude-code' {
  interface PluginState {
    'safety-net': { events: SafetyEvent[] }
  }
}
