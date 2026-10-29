/** `block` refuses the command outright; `ask` puts it to the person first. */
export type Level = 'block' | 'ask'

/** Why one shell command was stopped; `what` is the piece of the command that tripped it. */
export type Verdict = { level: Level; rule: string; why: string; what: string }

// The places no command Claude runs should ever wipe: the disk's root, the home folder, the system.
const ROOT_TARGETS = new Set(['/', '/*', '~', '~/', '~/*', '$HOME', '$HOME/', '$HOME/*', '${HOME}', '${HOME}/', '${HOME}/*'])
const SYSTEM_DIRS = [
  'Applications',
  'Library',
  'System',
  'Users',
  'Volumes',
  'bin',
  'boot',
  'dev',
  'etc',
  'home',
  'lib',
  'opt',
  'private',
  'proc',
  'root',
  'sbin',
  'srv',
  'sys',
  'usr',
  'var',
]
const SYSTEM_TARGET = new RegExp(`^/(${SYSTEM_DIRS.join('|')})/?\\*?$`)
// The working folder or its parent as a whole: sometimes meant (a build folder), often not.
const HERE_TARGETS = new Set(['.', './', './*', '*', '..', '../', '../*'])

// Words that run the rest of the line as a command of their own.
const PREFIXES = new Set(['sudo', 'doas', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'caffeinate'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])
const SQL_CLIENTS = new Set(['psql', 'mysql', 'mariadb', 'sqlite3', 'sqlcmd', 'duckdb', 'clickhouse-client', 'cockroach'])
const PROTECTED_BRANCHES = new Set(['main', 'master', 'trunk', 'production', 'prod'])

const HEREDOC = /<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g
const FORK_BOMB = /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/
const DESTRUCTIVE_SQL = /\b(drop\s+(table|database|schema)|truncate(\s+table)?\s+\w)/i
const DISK_DEVICE = /^\/dev\/(r?disk\d|sd[a-z]|nvme\d|hd[a-z]|mmcblk\d|xvd[a-z])/

/** The heredoc bodies of a command, which are text it writes, not commands it runs. */
export function heredocBodies(command: string): string {
  return (command.match(HEREDOC) ?? []).join('\n')
}

/**
 * Splits a shell line into simple commands, each a list of words with quotes taken off.
 * Heredoc bodies are dropped, `$( … )` and backticks are read as commands of their own, and
 * `sh -c '…'` / `eval '…'` are read again as the line they run.
 */
export function commandsOf(line: string, depth = 0): string[][] {
  const text = line.replace(HEREDOC, match => match.slice(0, match.indexOf('\n')))
  const commands: string[][] = []
  const nested: string[] = []
  let words: string[] = []
  let word = ''
  let hasWord = false

  const endWord = () => {
    if (hasWord) words.push(word)
    word = ''
    hasWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0) commands.push(words)
    words = []
  }

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === '\\' && i + 1 < text.length) {
      word += text[++i]
      hasWord = true
    } else if (c === "'") {
      const close = text.indexOf("'", i + 1)
      const end = close === -1 ? text.length : close
      word += text.slice(i + 1, end)
      hasWord = true
      i = end
    } else if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') j++
        j++
      }
      const inner = text.slice(i + 1, j)
      for (const sub of substitutions(inner)) nested.push(sub)
      word += inner.replace(/\\(.)/g, '$1')
      hasWord = true
      i = j
    } else if (c === '$' && text[i + 1] === '(') {
      const end = closingParen(text, i + 1)
      nested.push(text.slice(i + 2, end))
      word += text.slice(i, end + 1)
      hasWord = true
      i = end
    } else if (c === '`') {
      const close = text.indexOf('`', i + 1)
      const end = close === -1 ? text.length : close
      nested.push(text.slice(i + 1, end))
      i = end
    } else if (c === '#' && !hasWord) {
      while (i < text.length && text[i] !== '\n') i++
      endCommand()
    } else if (c === ';' || c === '\n' || c === '|' || c === '&' || c === '(' || c === ')' || c === '{' || c === '}') {
      // `{`/`}` only group when they stand alone; inside a word (`${HOME}`) they are the word's.
      if ((c === '{' || c === '}') && hasWord) {
        word += c
        continue
      }
      if (c === '&' && text[i - 1] === '>') {
        word += c
        continue
      }
      endCommand()
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
    } else {
      word += c
      hasWord = true
    }
  }
  endCommand()

  if (depth >= 4) return commands

  const all: string[][] = []
  for (const command of commands) {
    const words = stripPrefixes(command)
    if (words.length === 0) continue
    all.push(words)
    const [name, ...args] = words
    if (SHELLS.has(name!)) {
      const flag = args.findIndex(arg => /^-[a-z]*c[a-z]*$/.test(arg))
      if (flag !== -1 && args[flag + 1] !== undefined) all.push(...commandsOf(args[flag + 1]!, depth + 1))
    } else if (name === 'eval') {
      all.push(...commandsOf(args.join(' '), depth + 1))
    } else if (name === 'xargs') {
      const rest = args.filter(arg => !arg.startsWith('-'))
      if (rest.length > 0) all.push(stripPrefixes(rest))
    }
  }
  for (const sub of nested) all.push(...commandsOf(sub, depth + 1))

  return all
}

function substitutions(text: string): string[] {
  const found: string[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '$' && text[i + 1] === '(') {
      const end = closingParen(text, i + 1)
      found.push(text.slice(i + 2, end))
      i = end
    }
  }

  return found
}

function closingParen(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return i
  }

  return text.length
}

/** Drops what only wraps the real command: `sudo`, `env A=1`, `FOO=bar`, `/bin/rm` → `rm`. */
function stripPrefixes(words: readonly string[]): string[] {
  let i = 0
  for (;;) {
    const w = words[i]
    if (w === undefined) return []
    if (/^[A-Za-z_]\w*=/.test(w)) i++
    else if (PREFIXES.has(w) || w === 'env') {
      i++
      while (words[i]?.startsWith('-')) i++
    } else break
  }
  const rest = words.slice(i)
  rest[0] = rest[0]!.replace(/^.*\//, '')

  return rest
}

/** Short and long flags as one set: `-rf --force` → r, f, force. */
function flagsOf(args: readonly string[]): Set<string> {
  const flags = new Set<string>()
  for (const arg of args) {
    if (arg === '--') break
    if (arg.startsWith('--')) flags.add(arg.slice(2).split('=')[0]!)
    else if (/^-[A-Za-z]+$/.test(arg)) for (const ch of arg.slice(1)) flags.add(ch)
  }

  return flags
}

function operands(args: readonly string[]): string[] {
  const dash = args.indexOf('--')
  const before = (dash === -1 ? args : args.slice(0, dash)).filter(arg => !arg.startsWith('-'))

  return dash === -1 ? before : [...before, ...args.slice(dash + 1)]
}

function normalizeTarget(path: string): string {
  return path.replace(/\/{2,}/g, '/').replace(/^"|"$/g, '')
}

function isRootish(path: string): boolean {
  const p = normalizeTarget(path)

  return ROOT_TARGETS.has(p) || SYSTEM_TARGET.test(p)
}

function verdict(level: Level, rule: string, why: string, words: readonly string[]): Verdict {
  return { level, rule, why, what: words.join(' ') }
}

function checkRm(words: readonly string[]): Verdict | undefined {
  const args = words.slice(1)
  const flags = flagsOf(args)
  if (flags.has('no-preserve-root')) return verdict('block', 'rm-root', 'it removes everything from the disk root down', words)

  const isRecursive = flags.has('r') || flags.has('R') || flags.has('recursive')
  // `-i` asks before each file, and Claude's shell has no one to answer: nothing goes.
  if (!isRecursive || flags.has('i') || flags.has('interactive')) return undefined

  for (const target of operands(args).map(normalizeTarget)) {
    if (isRootish(target)) {
      return verdict('block', 'rm-root', `it deletes ${target === '/' ? 'the whole disk' : target.startsWith('/') ? `the system folder ${target}` : 'your home folder'}`, words)
    }
    if (HERE_TARGETS.has(target)) {
      return verdict('ask', 'rm-here', `it deletes everything in ${target.startsWith('..') ? 'the parent folder' : 'the working folder'}`, words)
    }
    if (/(^|\/)\.git\/?$/.test(target)) return verdict('ask', 'rm-git', "it deletes the repository's whole history", words)
  }

  return undefined
}

function checkFind(words: readonly string[]): Verdict | undefined {
  const roots = []
  for (const arg of words.slice(1)) {
    if (arg.startsWith('-') || arg === '!' || arg === '(') break
    roots.push(arg)
  }
  const deletes = words.includes('-delete') || words.some((w, i) => w === '-exec' && words[i + 1]?.replace(/^.*\//, '') === 'rm')
  if (deletes && roots.some(isRootish)) return verdict('block', 'find-root', 'it deletes files across the whole disk or home folder', words)

  return undefined
}

function checkPermissions(words: readonly string[]): Verdict | undefined {
  const args = words.slice(1)
  const flags = flagsOf(args)
  if (!flags.has('R') && !flags.has('recursive')) return undefined
  if (operands(args).some(isRootish)) {
    return verdict('block', 'perm-root', `it changes ${words[0] === 'chmod' ? 'permissions' : 'ownership'} of every file under a system or home folder`, words)
  }

  return undefined
}

function checkDisk(words: readonly string[]): Verdict | undefined {
  const name = words[0]!
  if (/^mkfs(\.|$)/.test(name) || name === 'wipefs') return verdict('block', 'disk', 'it erases a disk', words)
  if (name === 'dd' && words.some(w => w.startsWith('of=') && DISK_DEVICE.test(w.slice(3)))) {
    return verdict('block', 'disk', 'it writes straight over a disk', words)
  }
  if (name === 'diskutil' && /^(erase|zero|secureErase|partitionDisk|reformat)/i.test(words[1] ?? '')) {
    return verdict('block', 'disk', 'it erases a disk', words)
  }

  return undefined
}

function checkGit(words: readonly string[]): Verdict | undefined {
  // `git -C dir push` and the like: skip git's own options to reach the subcommand.
  let i = 1
  while (words[i]?.startsWith('-')) i += /^-(C|c)$|^--(git-dir|work-tree|namespace)$/.test(words[i]!) ? 2 : 1
  const sub = words[i]
  const args = words.slice(i + 1)
  const flags = flagsOf(args)

  if (sub === 'push') {
    const refs = operands(args).slice(1)
    const branchOf = (ref: string) => ref.replace(/^\+/, '').split(':').pop()!.replace(/^refs\/heads\//, '')
    const isForce = flags.has('force') || flags.has('f') || refs.some(ref => ref.startsWith('+'))
    const hits = refs.filter(ref => PROTECTED_BRANCHES.has(branchOf(ref)))
    if (isForce && hits.length > 0) return verdict('ask', 'git-force-push', `it rewrites the history of ${branchOf(hits[0]!)} on the remote`, words)
    if ((flags.has('delete') || flags.has('d')) && hits.length > 0) return verdict('ask', 'git-delete-branch', `it deletes ${branchOf(hits[0]!)} on the remote`, words)
    if (refs.some(ref => ref.startsWith(':') && PROTECTED_BRANCHES.has(ref.slice(1)))) return verdict('ask', 'git-delete-branch', 'it deletes a main branch on the remote', words)
    if (flags.has('mirror')) return verdict('ask', 'git-mirror', 'it overwrites every branch on the remote', words)
  }
  if (sub === 'reset' && flags.has('hard')) return verdict('ask', 'git-reset-hard', 'it throws away every uncommitted change', words)
  if (sub === 'clean' && (flags.has('f') || flags.has('force'))) {
    return verdict('ask', 'git-clean', `it deletes every untracked file${flags.has('x') ? ', ignored ones too (.env, builds)' : ''}`, words)
  }
  if ((sub === 'checkout' || sub === 'restore') && operands(args).some(arg => arg === '.' || arg === '*' || arg === ':/')) {
    return verdict('ask', 'git-discard', 'it throws away every uncommitted change in the folder', words)
  }
  if (sub === 'stash' && (args[0] === 'clear' || args[0] === 'drop')) return verdict('ask', 'git-stash', 'it deletes saved work in the stash', words)

  return undefined
}

function checkOther(words: readonly string[]): Verdict | undefined {
  const [name, ...args] = words
  const sub = args.filter(arg => !arg.startsWith('-')).join(' ')
  if (name === 'terraform' && sub.startsWith('destroy')) return verdict('ask', 'infra', 'it tears down real infrastructure', words)
  if (name === 'kubectl' && /^delete (ns|namespace|namespaces)\b/.test(sub)) return verdict('ask', 'infra', 'it deletes a whole Kubernetes namespace', words)
  if (name === 'docker' && /^(system|volume) prune/.test(sub) && (sub.startsWith('volume') || args.includes('--volumes'))) {
    return verdict('ask', 'docker-volumes', "it deletes Docker volumes and the data in them", words)
  }
  if (name === 'dropdb') return verdict('ask', 'database', 'it deletes a database', words)
  if (name === 'supabase' && sub.startsWith('db reset')) return verdict('ask', 'database', 'it wipes the database', words)
  if ((name === 'prisma' || (name === 'npx' && args[0] === 'prisma')) && /migrate reset/.test(sub)) return verdict('ask', 'database', 'it wipes the database', words)
  if ((name === 'rails' || name === 'rake') && /\bdb:(drop|reset)\b/.test(sub)) return verdict('ask', 'database', 'it deletes the database', words)

  return undefined
}

/** The first rule a shell line trips, worst first, or nothing when it is fine to run. */
export function checkCommand(line: string): Verdict | undefined {
  const raw = line.replace(HEREDOC, match => match.slice(0, match.indexOf('\n')))
  if (FORK_BOMB.test(raw)) return { level: 'block', rule: 'fork-bomb', why: 'it is a fork bomb that freezes the machine', what: ':(){ :|:& };:' }
  if (/>\s*\/dev\/(r?disk\d|sd[a-z]|nvme\d)/.test(raw)) return { level: 'block', rule: 'disk', why: 'it writes straight over a disk', what: raw.trim() }

  const commands = commandsOf(line)
  const found: Verdict[] = []
  for (const words of commands) {
    const name = words[0]!
    const hit =
      name === 'rm'
        ? checkRm(words)
        : name === 'find'
          ? checkFind(words)
          : name === 'chmod' || name === 'chown' || name === 'chgrp'
            ? checkPermissions(words)
            : name === 'git'
              ? checkGit(words)
              : (checkDisk(words) ?? checkOther(words))
    if (hit) found.push(hit)
  }

  // A download piped straight into a shell runs code nobody has read.
  const segments = raw.split(/\n|;|&&|\|\|/)
  for (const segment of segments) {
    if (/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|python3?|node|perl|ruby)\b/.test(segment)) {
      found.push({ level: 'ask', rule: 'pipe-to-shell', why: 'it runs a script straight from the internet without saving or reading it first', what: segment.trim() })
    }
  }

  // SQL is checked on the whole line, heredoc bodies too, but only when a database client runs it.
  if (commands.some(words => SQL_CLIENTS.has(words[0]!))) {
    const sql = line.match(DESTRUCTIVE_SQL)
    if (sql) found.push({ level: 'ask', rule: 'database', why: `it runs ${sql[0].toUpperCase().replace(/\s+/g, ' ')} against a database`, what: sql[0] })
  }

  return found.find(v => v.level === 'block') ?? found[0]
}

/** What the model reads when a command is refused. */
export function denyText(v: Verdict, how: 'blocked' | 'declined' | 'unanswered'): string {
  const head =
    how === 'blocked'
      ? `Safety Net blocked this command: ${v.why}.`
      : how === 'declined'
        ? `Safety Net: the user chose not to run this command (${v.why}).`
        : `Safety Net: this command needs the user's yes and nobody gave it (${v.why}).`

  return `${head} Do not retry it or get around it with another command. If it is really needed, explain why to the user; they can run it themselves by typing "! ${v.what}".`
}

export function questionText(v: Verdict): string {
  return `Claude wants to run \`${clip(v.what, 120)}\`, and ${v.why}. Run it?`
}

export function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()

  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}
