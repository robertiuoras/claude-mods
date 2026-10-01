export type FlightLane = 'Model' | 'Shell' | 'Read' | 'Edit' | 'Agents' | 'Web' | 'Other'

/** One call (or model step) on the timeline; `end` is absent while it runs. */
export type FlightSegment = {
  id: string
  lane: FlightLane
  label: string
  start: number
  end?: number
}

/** The main-loop turn being recorded, or the last one that finished. */
export type FlightTurn = {
  /** Identity of the turn; unchanged when the finished turn is re-anchored. */
  id: number
  turnId?: string
  startedAt: number
  endedAt?: number
  durationMs?: number
  isRunning: boolean
  /** True once the engine confirmed a model turn (`turn.start`, a step or a call). */
  isEngaged: boolean
  steps: number
  calls: number
  subCalls: number
  segments: FlightSegment[]
  /** The finished turn this one replaced; comes back if this one never engages. */
  previous?: FlightTurn
}

export type FlightSlowest = { label: string; lane: FlightLane; ms: number }

/** The compact record of a finished turn kept in `$.store` key `history`. */
export type FlightSummary = {
  at: number
  durationMs: number
  calls: number
  lanes: Record<FlightLane, number>
  slowest?: FlightSlowest
}

declare module 'claude-code' {
  interface PluginState {
    'flight-recorder': { turn: FlightTurn | null; tick: number }
  }
}
