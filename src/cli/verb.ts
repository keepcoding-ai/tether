// `tether <ns> <verb> [positionals] [--prop value]... [--json '{...}'] [--json] [--slot <id>]`: a verb an extension contributed
// to the agent door (src/daemon/door/verbs.ts). The handler runs inside tetherd; this side only builds the args from the verb's
// JSON Schema (`input`, `positional`), proves the slot with TETHER_SLOT_KEY and prints the result.
//   --json '{...}'   the args as a JSON object (the flags and positionals override its keys)
//   --json           print the verb's structured data as JSON instead of its text
//   --slot <id>      the slot the call is made for (default: this terminal's, TETHER_SLOT_ID)
import { DaemonError, type DaemonClient } from '../daemon/client.ts'
import { ENV_SLOT_KEY } from '../daemon/door/types.ts'
import { ENV_SLOT } from '../agents/types.ts'
import { parseArgs, UsageError } from './args.ts'

export interface VerbIo {
  out: (text: string) => void
  err: (text: string) => void
  env: NodeJS.ProcessEnv
  connect: () => Promise<DaemonClient | undefined>
  /** Why the last `connect` failed (pipe tried and cause), when known. */
  failure?: () => { pipe: string; cause: string } | undefined
}

interface VerbInfo { ns: string; name: string; help: string; input: Record<string, unknown>; positional?: string[] }
type Prop = { type?: string; items?: { type?: string } }

/** The identity a pipe request carries when the CLI runs inside an agent's pane: the pane's id and key; nothing for the person's shell. */
export function askerOf(env: NodeJS.ProcessEnv): { slotId?: string; key?: string } {
  const slotId = env[ENV_SLOT]?.trim()
  if (!slotId) return {}
  const key = env[ENV_SLOT_KEY]?.trim()
  return { slotId, ...(key ? { key } : {}) }
}

function props(v: VerbInfo): Record<string, Prop> {
  const p = v.input.properties
  return p && typeof p === 'object' ? (p as Record<string, Prop>) : {}
}

function coerce(name: string, raw: string, type: string | undefined): unknown {
  switch (type) {
    case 'number': case 'integer': {
      const n = Number(raw)
      if (raw.trim() === '' || !Number.isFinite(n) || (type === 'integer' && !Number.isInteger(n))) throw new UsageError(`${name}: esperava ${type === 'integer' ? 'um inteiro' : 'um número'}, veio ${JSON.stringify(raw)}`)
      return n
    }
    case 'boolean':
      if (raw === 'true') return true
      if (raw === 'false') return false
      throw new UsageError(`${name}: esperava true ou false`)
    case 'object': case 'array':
      try { return JSON.parse(raw) } catch { throw new UsageError(`${name}: esperava JSON`) }
    default: return raw
  }
}

/** Splits the `--json` occurrences: a value starting with `{` is the args object, a bare `--json` asks for JSON output. */
function splitJson(argv: string[]): { rest: string[]; input: Record<string, unknown>; asJson: boolean } {
  const rest: string[] = []
  let input: Record<string, unknown> = {}
  let asJson = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--') { rest.push(...argv.slice(i)); break }
    const value = a === '--json' ? (argv[i + 1]?.trimStart().startsWith('{') ? argv[++i] : undefined) : a.startsWith('--json=') ? a.slice(7) : null
    if (value === null) { rest.push(a); continue }
    if (value === undefined) { asJson = true; continue }
    let parsed: unknown
    try { parsed = JSON.parse(value) } catch { throw new UsageError('--json: o valor não é JSON válido') }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new UsageError('--json: esperava um objeto')
    input = { ...input, ...(parsed as Record<string, unknown>) }
  }
  return { rest, input, asJson }
}

function buildArgs(v: VerbInfo, argv: string[]): { args: Record<string, unknown>; slot: string | undefined; asJson: boolean } {
  const schema = props(v)
  const names = Object.keys(schema)
  const kindOf = (n: string): string | undefined => schema[n]?.type
  const { rest, input, asJson } = splitJson(argv)
  const a = parseArgs(rest, {
    valued: ['slot', ...names.filter((n) => n !== 'slot' && kindOf(n) !== 'boolean' && kindOf(n) !== 'array')],
    flags: names.filter((n) => kindOf(n) === 'boolean' && n !== 'slot'),
    multi: names.filter((n) => kindOf(n) === 'array' && n !== 'slot'),
  })
  const args: Record<string, unknown> = { ...input }
  const positional = v.positional ?? []
  if (!positional.length && a.positional.length) throw new UsageError(`${v.ns} ${v.name}: não leva argumentos posicionais`)
  positional.forEach((name, i) => {
    const last = i === positional.length - 1
    const words = last ? a.positional.slice(i) : a.positional.slice(i, i + 1)
    if (!words.length) return
    const type = kindOf(name)
    if (type === 'array') args[name] = words.map((w) => coerce(name, w, schema[name]?.items?.type))
    // The last positional takes the rest of the words when it is text, so a message needs no quotes.
    else if (last && words.length > 1 && (type === undefined || type === 'string')) args[name] = words.join(' ')
    else if (words.length > 1) throw new UsageError(`${v.ns} ${v.name}: argumentos demais`)
    else args[name] = coerce(name, words[0]!, type)
  })
  for (const [name, value] of Object.entries(a.options)) if (name !== 'slot') args[name] = coerce(name, value, kindOf(name))
  for (const name of a.flags) args[name] = true
  for (const [name, values] of Object.entries(a.multi)) args[name] = values.map((x) => coerce(name, x, schema[name]?.items?.type))
  const required = Array.isArray(v.input.required) ? (v.input.required as string[]) : []
  for (const name of required) {
    if (args[name] === undefined) throw new UsageError(`${v.ns} ${v.name}: falta ${positional.includes(name) ? `<${name}>` : `--${name}`}`)
  }
  return { args, slot: a.options.slot, asJson }
}

/** One line per verb, for `tether help` and for `tether <ns>`. */
export function describeVerbs(verbs: readonly VerbInfo[]): string {
  const usage = (v: VerbInfo): string => {
    const pos = (v.positional ?? []).map((p) => `<${p}>`)
    const flags = Object.keys(props(v)).filter((n) => !(v.positional ?? []).includes(n)).map((n) => `[--${n}]`)
    return `${v.ns} ${v.name} ${[...pos, ...flags].join(' ')}`.trimEnd()
  }
  return verbs.map((v) => `  ${usage(v).padEnd(42)} ${v.help}\n`).join('')
}

/** The contributed verbs, formatted for `tether help`; '' when tetherd is not up or none is registered. */
export async function verbsHelp(connect: () => Promise<DaemonClient | undefined>): Promise<string> {
  const client = await connect()
  if (!client) return ''
  try {
    const verbs = (await client.request({ t: 'verb-list' })).verbs ?? []
    return verbs.length ? `\nverbos de extensões:\n${describeVerbs(verbs)}` : ''
  } catch { return '' } finally { client.close() }
}

/** `tether help`: the built-in usage, then the contributed verbs when tetherd answers within `waitMs`; the bare usage otherwise. */
export async function helpWithVerbs(usage: string, connect: () => Promise<DaemonClient | undefined>, waitMs = 1500): Promise<string> {
  let timer: NodeJS.Timeout | undefined
  const none = new Promise<string>((resolve) => { timer = setTimeout(() => resolve(''), waitMs); timer.unref() })
  try {
    return usage + await Promise.race([verbsHelp(connect).catch(() => ''), none])
  } finally { clearTimeout(timer) }
}

export async function cmdVerb(command: string, argv: string[], io: VerbIo): Promise<number> {
  const client = await io.connect()
  // Without tetherd nothing says whether `command` is a verb or a typo: it stays an unknown command (exit 2, as before verbs
  // existed) and the message says what a verb needs.
  if (!client) {
    const f = io.failure?.()
    if (f) throw new UsageError(`comando desconhecido: ${command}. Se é um comando de extensão, não consegui falar com o tether em ${f.pipe}: ${f.cause}.`)
    throw new UsageError(`comando desconhecido: ${command} (se for comando de uma extensão, o tether precisa estar rodando)`)
  }
  try {
    const verbs: VerbInfo[] = (await client.request({ t: 'verb-list' })).verbs ?? []
    const ofNs = verbs.filter((v) => v.ns === command)
    if (!ofNs.length) throw new UsageError(`comando desconhecido: ${command}`, true)
    const name = argv[0]
    if (name === undefined || name === 'help') { io.out(describeVerbs(ofNs)); return 0 }
    const verb = ofNs.find((v) => v.name === name)
    if (!verb) throw new UsageError(`verbo desconhecido: ${command} ${name}\n\n${describeVerbs(ofNs)}`)
    const { args, slot, asJson } = buildArgs(verb, argv.slice(1))
    const slotId = (slot ?? io.env[ENV_SLOT] ?? '').trim()
    if (!slotId) throw new UsageError('não sei qual é o painel: rode dentro de um painel do tether (TETHER_SLOT_ID) ou use --slot <id>')
    const key = io.env[ENV_SLOT_KEY]?.trim()
    let result
    try {
      result = (await client.request({ t: 'verb', ns: command, name, args, slotId, ...(key ? { key } : {}) })).verb
    } catch (e) {
      if (e instanceof DaemonError && e.code === 'unknown-verb') throw new UsageError(e.message)
      throw e
    }
    if (!result) { io.err('tether: o tetherd não respondeu o verbo\n'); return 1 }
    const text = asJson ? JSON.stringify(result.data ?? { text: result.text }, null, 2) : result.text
    const line = text.endsWith('\n') ? text : `${text}\n`
    if (result.isError) { io.err(line); return 1 }
    io.out(line)
    return 0
  } finally {
    client.close()
  }
}
