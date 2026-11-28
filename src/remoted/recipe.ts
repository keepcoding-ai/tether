// "Novo processo" from afar (RR5 5.5, fio-spec 18): the checks of a recipe of the person's that need the repo's rules, for
// the two sides that read them. The portal builds the act from the strict body (`procNewArgs`); tetherd admits a `remote`
// client's `proc-start` only with a recipe in that very form (`remoteRecipeOk`, through ./reach.ts REMOTE_ACT_ARGS). The
// command is split as the Regency's form splits it (app/renderer/args.ts), and what looks like a secret is the repo's one
// rule (src/core/redact-args.ts), the same the form asks about; from afar it is refused, never asked. The shape and the
// ceilings are src/remote/procs-new.ts. Pure (no node:*): tetherd loads this file through ./reach.ts.
import { parseArgs } from '../../app/renderer/args.ts'
import { looksSecretName, looksSecretValue, redactArgs } from '../core/redact-args.ts'
import { sanitizeDeclaredName } from '../remote/content.ts'
import { FOLDER_ID_RE } from '../remote/create.ts'
import {
  ENV_MAX, ENV_NAME_RE, ENV_VALUE_MAX, PORTS_MAX, PROC_ARGS_MAX, PROC_COMMAND_MAX, PROC_DESCRIPTION_MAX, PROC_NAME_RE, type RemoteRecipe,
} from '../remote/procs-new.ts'

/** The checked act: the name, the folder's id (the portal resolves it), and the recipe without its folder yet. */
export interface ProcNewArgs { name: string; folder: string; recipe: Omit<RemoteRecipe, 'cwd'> }

/** Why the body is refused before anything is sent. `secret-env` carries the variables' names (never a value). */
export type ProcNewRefusal =
  | { why: 'bad-request' | 'too-long' | 'secret-command' }
  | { why: 'secret-env'; names: string[] }

/** Control characters: a command is one line, and a value has no NUL nor line break from afar. */
const CONTROL = /[\u0000-\u001f\u007f]/

/** Whether the command line carries something the argument mask would hide (a token, a password…): the form's rule. */
export const commandLooksSecret = (argv: readonly string[]): boolean => redactArgs(argv).some((a, i) => a !== argv[i])

/** The names of the variables that look like a secret: by the name, or by the shape of the value. */
export const secretEnvNames = (env: Readonly<Record<string, string>>): string[] =>
  Object.entries(env).filter(([n, v]) => looksSecretName(n) || looksSecretValue(v)).map(([n]) => n)

/** The portal's half: the strict body checked field by field (its keys already checked by the table). */
export function procNewArgs(b: Record<string, unknown>): ProcNewArgs | ProcNewRefusal {
  const bad = { why: 'bad-request' } as const
  if (typeof b.name !== 'string' || !PROC_NAME_RE.test(b.name)) return bad
  if (typeof b.folder !== 'string' || !FOLDER_ID_RE.test(b.folder)) return bad
  if (typeof b.command !== 'string') return bad
  if (b.command.length > PROC_COMMAND_MAX) return { why: 'too-long' }
  if (CONTROL.test(b.command)) return bad
  const argv = parseArgs(b.command)
  if (argv.length === 0 || argv[0]!.trim() === '' || argv.length > PROC_ARGS_MAX) return bad
  const env: Record<string, string> = {}
  if (b.env !== undefined) {
    if (!Array.isArray(b.env) || b.env.length > ENV_MAX) return bad
    const seen = new Set<string>()
    for (const row of b.env as unknown[]) {
      const r = (row && typeof row === 'object' && !Array.isArray(row) ? row : {}) as Record<string, unknown>
      if (Object.keys(r).some((k) => k !== 'name' && k !== 'value')) return bad
      if (typeof r.name !== 'string' || !ENV_NAME_RE.test(r.name) || typeof r.value !== 'string') return bad
      if (r.value.length > ENV_VALUE_MAX) return { why: 'too-long' }
      if (CONTROL.test(r.value)) return bad
      // Windows reads a name in any case: the same name twice is one variable written twice.
      if (seen.has(r.name.toUpperCase())) return bad
      seen.add(r.name.toUpperCase())
      env[r.name] = r.value
    }
  }
  const ports: number[] = []
  if (b.ports !== undefined) {
    if (!Array.isArray(b.ports) || b.ports.length > PORTS_MAX) return bad
    for (const p of b.ports as unknown[]) {
      if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 65_535) return bad
      if (!ports.includes(p)) ports.push(p)
    }
  }
  let description: string | undefined
  if (b.description !== undefined && b.description !== '') {
    if (typeof b.description !== 'string') return bad
    if (b.description.length > PROC_DESCRIPTION_MAX) return { why: 'too-long' }
    description = sanitizeDeclaredName(b.description) || undefined
  }
  // The secret rules last, once the shape is right: no "anyway" from afar.
  const names = secretEnvNames(env)
  if (names.length > 0) return { why: 'secret-env', names }
  if (commandLooksSecret(argv)) return { why: 'secret-command' }
  return { name: b.name, folder: b.folder, recipe: { command: argv[0]!, args: argv.slice(1), env, ports, ...(description !== undefined ? { description } : {}) } }
}

/** An absolute folder (C:\…, \\server\…, or /…), as tetherd takes a recipe's. */
const isAbsoluteFolder = (path: string): boolean => /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\/.test(path) || path.startsWith('/')

/**
 * tetherd's half (./reach.ts REMOTE_ACT_ARGS, the admission of `proc-start` from a `remote` client): the recipe exactly in
 * the form the portal builds it, within the same ceilings, by the same secret rules. Nothing a `remote` client sends gets a
 * recipe past this: no `info`, no `stopGraceMs`, no secret-looking variable or command.
 */
export function remoteRecipeOk(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const r = v as Record<string, unknown>
  if (Object.keys(r).some((k) => !['command', 'args', 'cwd', 'env', 'ports', 'description'].includes(k))) return false
  if (typeof r.command !== 'string' || r.command === '' || r.command.length > PROC_COMMAND_MAX || CONTROL.test(r.command)) return false
  if (!Array.isArray(r.args) || r.args.length > PROC_ARGS_MAX || r.args.some((a) => typeof a !== 'string' || a.length > PROC_COMMAND_MAX || CONTROL.test(a))) return false
  if (typeof r.cwd !== 'string' || !isAbsoluteFolder(r.cwd) || CONTROL.test(r.cwd)) return false
  const env = r.env
  if (!env || typeof env !== 'object' || Array.isArray(env)) return false
  const entries = Object.entries(env as Record<string, unknown>)
  if (entries.length > ENV_MAX || entries.some(([n, val]) => !ENV_NAME_RE.test(n) || typeof val !== 'string' || val.length > ENV_VALUE_MAX || CONTROL.test(val))) return false
  if (!Array.isArray(r.ports) || r.ports.length > PORTS_MAX || r.ports.some((p) => typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 65_535)) return false
  if (r.description !== undefined && (typeof r.description !== 'string' || r.description.length > PROC_DESCRIPTION_MAX || sanitizeDeclaredName(r.description) !== r.description)) return false
  if (secretEnvNames(env as Record<string, string>).length > 0) return false
  return !commandLooksSecret([r.command, ...(r.args as string[])])
}
