/** One file Claude changed in this session, with every change to it added up. */
export type TrailFile = {
  path: string
  added: number
  removed: number
  edits: number
  /** Claude created it in this session. */
  isNew: boolean
  firstAt: number
  lastAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'paper-trail': { files: Shaped<TrailFile[]>; cwd: string; tick: number }
  }
}
