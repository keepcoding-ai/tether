// `tether link` and `tether focus`: the CLI side of tether:// links (app/shared/tether-url.ts). Both work from inside a
// pane, where the daemon set TETHER_TAB_URL (src/core/tab-env.ts); `focus` hands a link to the OS, which gives it to the
// app (opening it when closed) — the very path a click on the link takes, so there is one way in.
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { noteUrl, parseTetherUrl } from '../../app/shared/tether-url.ts'
import { ENV_OPEN_CWD, ENV_TAB_URL } from '../core/tab-env.ts'

export class FocusError extends Error {}

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
