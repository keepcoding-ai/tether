// Which program the OS opens tether:// links with, and making it this tether ("Associar links tether:// a este tether…").
// On Windows the association is HKCU\Software\Classes\tether (per user, no admin): reading it says which executable —
// maybe another checkout or an old build — answers today; associating removes that key and writes this app's own, so
// there is never more than one. Elsewhere Electron's own check is the answer. Pure parts unit-tested
// (test/unit/app.protocol-association.test.ts); the registry is touched only through `reg.exe` with fixed arguments.
import { execFile } from 'node:child_process'

export const PROTOCOL_KEY = String.raw`HKCU\Software\Classes\tether`
const COMMAND_KEY = String.raw`HKCU\Software\Classes\tether\shell\open\command`

export interface Association {
  /** The command line the OS runs for a link today; undefined when nothing is associated. */
  current: string | undefined
  /** The command line that means "this tether". */
  mine: string
  isMine: boolean
}

/** The command line Electron writes for this app: `"exe" "arg"… "%1"`. */
export function commandLineFor(exe: string, args: readonly string[]): string {
  return [exe, ...args, '%1'].map(a => `"${a}"`).join(' ')
}

/** The default value of the command key out of `reg query … /ve`; undefined when there is none. */
export function parseRegDefault(output: string): string | undefined {
  const m = /\((?:Default|Padr[ãa]o)\)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(output)
  const value = m?.[1]?.trim()
  return value ? value : undefined
}

/** Whether two command lines run the same thing (Windows paths: case and separators do not matter). */
export function sameCommand(a: string | undefined, b: string): boolean {
  if (!a) return false
  const norm = (s: string): string => s.replaceAll('/', '\\').replace(/\s+/g, ' ').trim().toLowerCase()
  return norm(a) === norm(b)
}

/**
 * What a command line is, for the person: a tether run from its sources (`electron.exe …\app\dist\main.cjs`) is its folder
 * (`…\workspace\tether`, what tells one checkout from another); a packaged one is its executable.
 */
export function describeCommand(command: string): string {
  const quoted = command.match(/"([^"]*)"/g)?.map(q => q.slice(1, -1)).filter(p => p !== '%1')
  if (!quoted || quoted.length === 0) return command
  const bundle = quoted.find(p => /[\\/]app[\\/]dist[\\/]main\.cjs$/i.test(p))
  return bundle ? bundle.replace(/[\\/]app[\\/]dist[\\/]main\.cjs$/i, '') : quoted[0]!
}

function reg(args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise(resolve => {
    execFile('reg.exe', args, { windowsHide: true }, (err, stdout) => resolve({ ok: !err, out: String(stdout) }))
  })
}

/** The command line associated today (Windows); undefined elsewhere or when none. */
export async function readAssociatedCommand(): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined
  const r = await reg(['query', COMMAND_KEY, '/ve'])
  return r.ok ? parseRegDefault(r.out) : undefined
}

/** Removes whatever tether:// association exists for this user (Windows), before writing this app's. */
export async function removeAssociation(): Promise<void> {
  if (process.platform !== 'win32') return
  await reg(['delete', PROTOCOL_KEY, '/f'])
}
