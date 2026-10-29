// Tiny argv parser for the CLI: positionals, `--opt value` / `--opt=value`, boolean flags, and everything
// after `--` kept verbatim (agent args). Unknown options are an error (usage, exit 2).

export interface ParsedArgs {
  positional: string[]
  options: Record<string, string>
  flags: Set<string>
  /** Options that may repeat (`--env A=1 --env B=2`), every value in order. */
  multi: Record<string, string[]>
  /** Everything after `--`, untouched. */
  rest: string[]
}

export class UsageError extends Error {
  /** Print the full usage after the message (unknown command), not just a pointer to `tether help`. */
  readonly showUsage: boolean
  constructor(message: string, showUsage = false) {
    super(message)
    this.name = 'UsageError'
    this.showUsage = showUsage
  }
}

export interface ArgSpec {
  /** Options that take a value (`--name n`). */
  valued?: string[]
  /** Boolean flags (`--json`). */
  flags?: string[]
  /** Options that take a value and may repeat (`--env K=V`). */
  multi?: string[]
}

export function parseArgs(argv: string[], spec: ArgSpec = {}): ParsedArgs {
  const valued = new Set(spec.valued ?? [])
  const flags = new Set(spec.flags ?? [])
  const multi = new Set(spec.multi ?? [])
  const out: ParsedArgs = { positional: [], options: {}, flags: new Set(), multi: {}, rest: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--') {
      out.rest = argv.slice(i + 1)
      break
    }
    if (!a.startsWith('--') || a.length < 3) {
      out.positional.push(a)
      continue
    }
    const eq = a.indexOf('=')
    const name = eq >= 0 ? a.slice(2, eq) : a.slice(2)
    if (valued.has(name) || multi.has(name)) {
      let value: string | undefined
      if (eq >= 0) value = a.slice(eq + 1)
      else {
        value = argv[i + 1]
        i++
      }
      if (value === undefined) throw new UsageError(`--${name} precisa de um valor`)
      if (multi.has(name)) (out.multi[name] ??= []).push(value)
      else out.options[name] = value
      continue
    }
    if (flags.has(name)) {
      if (eq >= 0) throw new UsageError(`--${name} não aceita valor`)
      out.flags.add(name)
      continue
    }
    throw new UsageError(`opção desconhecida: --${name}`)
  }
  return out
}
