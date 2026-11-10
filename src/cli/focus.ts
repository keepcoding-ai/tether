// `tether link` and `tether focus`: the CLI side of tether:// links (app/shared/tether-url.ts). Both work from inside a
// pane, where the daemon set TETHER_TAB_URL (src/core/tab-env.ts); `focus` hands a link to the OS, which gives it to the
// app (opening it when closed) — the very path a click on the link takes, so there is one way in.
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { noteUrl, PAD_SCOPES, parseTetherUrl, type PadScopeName } from '../../app/shared/tether-url.ts'
import { ENV_SLOT } from '../agents/types.ts'
import { ENV_OPEN_CWD, ENV_TAB_URL } from '../core/tab-env.ts'
import { UsageError } from './args.ts'

export class FocusError extends Error {}

export interface FocusArgs {
  /** The file or link; none = this pane. */
  target?: string
  /** `--pad [panel|desk|global]`: open the file inside that pad (a bare `--pad` is the panel pad). */
  pad?: PadScopeName
  /** `--slot <id>`: the pane the pad belongs to (default: this terminal's, TETHER_SLOT_ID). */
  slot?: string
}

/**
 * The arguments of `tether focus`. `--pad` takes the scope that follows it when that is one of panel|desk|global, else it
 * stands alone (`focus --pad todo.md`); `--pad=desk` always names one.
 */
export function parseFocusArgs(argv: string[]): FocusArgs {
  const out: FocusArgs = {}
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--') || a.length < 3) { positional.push(a); continue }
    const eq = a.indexOf('=')
    const name = eq >= 0 ? a.slice(2, eq) : a.slice(2)
    if (name === 'pad') {
      let value: string | undefined = eq >= 0 ? a.slice(eq + 1) : undefined
      if (value === undefined && (PAD_SCOPES as readonly string[]).includes(argv[i + 1] ?? '')) value = argv[++i]
      if (value === undefined) { out.pad = 'panel'; continue }
      if (!(PAD_SCOPES as readonly string[]).includes(value)) throw new UsageError(`--pad aceita panel, desk ou global (recebi: ${value})`)
      out.pad = value as PadScopeName
    } else if (name === 'slot') {
      const value = eq >= 0 ? a.slice(eq + 1) : argv[++i]
      if (!value) throw new UsageError('--slot precisa de um valor')
      out.slot = value
    } else {
      throw new UsageError(`opção desconhecida: --${name}`)
    }
  }
  if (positional.length > 1) throw new UsageError('focus aceita um só arquivo ou link')
  if (positional[0] !== undefined) out.target = positional[0]
  if (out.slot !== undefined && out.pad === undefined) throw new UsageError('--slot só vale junto de --pad')
  return out
}

/** The link `tether focus` follows for these arguments: `focusTarget`, or with `--pad` the note opened inside that pad. */
export function focusLink(args: FocusArgs, env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  const link = focusTarget(args.target, env, cwd)
  if (!args.pad) return link
  const parsed = parseTetherUrl(link)
  if (!args.target || parsed?.kind !== 'note') throw new FocusError('--pad vale para um arquivo: tether focus <arquivo> --pad')
  const slot = args.slot?.trim() || env[ENV_SLOT]?.trim() || undefined
  if (args.pad === 'panel' && !slot) throw new FocusError('não sei de qual painel é a prancheta: rode dentro de um painel do tether (TETHER_SLOT_ID) ou use --slot <id>')
  const pad = { scope: args.pad, ...(slot ? { slot } : {}) }
  if (!parseTetherUrl(noteUrl(parsed.path, pad))) throw new FocusError(`id de painel inválido: ${slot}`)
  return noteUrl(parsed.path, pad)
}

/** This pane's link; an error outside a tether pane. */
export function ownTabUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env[ENV_TAB_URL]?.trim()
  if (!url || !parseTetherUrl(url)) throw new FocusError('este terminal não é um painel do tether (sem TETHER_TAB_URL)')
  return url
}

/**
 * The link `tether focus` follows: a tether:// link as is; a file as the note open on it (a relative path is read
 * against the pane's opening folder, then the current one); nothing: this pane.
 */
export function focusTarget(arg: string | undefined, env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  if (arg === undefined || arg === '') return ownTabUrl(env)
  if (/^tether:\/\//i.test(arg)) {
    if (!parseTetherUrl(arg)) throw new FocusError(`link inválido: ${arg}`)
    return arg
  }
  const base = env[ENV_OPEN_CWD]?.trim()
  const candidates = [...(base ? [resolve(base, arg)] : []), resolve(cwd, arg)]
  const file = candidates.find(p => existsSync(p) && statSync(p).isFile())
  if (!file) throw new FocusError(`arquivo não encontrado: ${arg}`)
  return noteUrl(file)
}

/** Hands the link to the OS (which starts the app or pokes the running one). Nothing is run with the link's text but the OS's opener. */
export function openTetherUrl(url: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const [cmd, args] = platform === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true })
    child.once('error', e => fail(new FocusError(`não consegui entregar o link ao sistema: ${e.message}`)))
    child.once('spawn', () => { child.unref(); ok() })
  })
}
