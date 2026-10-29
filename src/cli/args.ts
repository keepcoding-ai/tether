// Tiny argv parser for the CLI: positionals, `--opt value` / `--opt=value`, boolean flags, and everything
// after `--` kept verbatim (agent args). Unknown options are an error (usage, exit 2).

export interface ParsedArgs {
  positional: string[]
  options: Record<string, string>
  flags: Set<string>
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
}

export function parseArgs(argv: string[], spec: ArgSpec = {}): ParsedArgs {
  const valued = new Set(spec.valued ?? [])
  const flags = new Set(spec.flags ?? [])
  const out: ParsedArgs = { positional: [], options: {}, flags: new Set(), rest: [] }
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
    if (valued.has(name)) {
      let value: string | undefined
      if (eq >= 0) value = a.slice(eq + 1)
      else {
        value = argv[i + 1]
        i++
      }
      if (value === undefined) throw new UsageError(`--${name} precisa de um valor`)
      out.options[name] = value
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
