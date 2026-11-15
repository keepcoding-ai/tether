// Shared bits of the browser E2E tests (Tether Browser E5-E6): the app launched hidden with a private home and pipe, and a raw
// CDP client over the gatekeeper's WebSocket. The harness's own Playwright is attached to every page of the app and dismisses a
// JavaScript dialog nobody listens to: `launchHidden` listens (and does nothing), so a tab's dialog waits for the agent's CDP.
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { killElectron } from './electron.ts'

const require = createRequire(import.meta.url)
export const root = resolve(import.meta.dirname, '..', '..')
export const electronPath = require('electron') as string
export const mainPath = join(root, 'app', 'dist', 'main.cjs')
export const daemonMain = join(root, 'src', 'daemon', 'main.ts')
export const serverMjs = join(root, 'extensions', 'browser', 'vendor', 'tether-browser', 'server.mjs')
export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
export const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }

/** The environment without ELECTRON_* and CLAUDE*. */
export function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  return env
}

export async function launchHidden(home: string, pipe: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env = cleanEnv()
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  if (process.env.TETHER_GATE_TRACE) env.TETHER_GATE_TRACE = process.env.TETHER_GATE_TRACE
  delete env.TETHER_CLAUDE_ARGS
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  // Without a listener the harness's Playwright answers every page's dialog itself (cancel), before the gate's agent can.
  app.context().on('dialog', () => {})
  const win = await app.firstWindow()
  win.setDefaultTimeout(10_000)
  try { await win.waitForSelector('#conn.on', { timeout: 30_000 }) } catch (e) { await killElectron(app, root).catch(() => {}); throw e }
  return { app, page: win }
}

export interface RawCdp {
  call(method: string, params?: object, sessionId?: string, timeoutMs?: number): Promise<any>
  events: any[]
  closed: Promise<void>
  close(): void
}

/** A raw CDP client over the gate's WebSocket (Node's own WebSocket, with the key header). Every message is kept in `events`. */
export async function rawCdp(port: number, key: string, headers: Record<string, string> = {}): Promise<RawCdp> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser/tether`, { headers: { 'x-tether-key': key, ...headers } } as never)
  const pending = new Map<number, (m: any) => void>()
  const events: any[] = []
  let next = 0
  const closed = new Promise<void>(r => ws.addEventListener('close', () => r()))
  ws.addEventListener('message', ev => {
    const m = JSON.parse(String(ev.data))
    if (m.id !== undefined) pending.get(m.id)?.(m)
    else events.push(m)
  })
  await new Promise<void>((r, j) => { ws.addEventListener('open', () => r()); ws.addEventListener('error', () => j(new Error('ws refused'))) })
  return {
    call: (method, params = {}, sessionId, timeoutMs = 20_000) => Promise.race([
      new Promise(r => {
        const id = ++next
        pending.set(id, r)
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      }),
      sleep(timeoutMs).then(() => ({ error: { message: `${method}: no answer in ${timeoutMs} ms`, timeout: true } })),
    ]),
    events, closed, close: () => ws.close(),
  }
}

/**
 * `app.evaluate` where the browser lives: the function (with the same `(electron, arg)` signature) runs in the browser process
 * when there is one (Windows), else in the app's main process. What it returns must be serializable.
 */
export function inBrowser<R>(app: ElectronApplication, fn: ((electron: any, a: any) => R) | Function, arg?: unknown): Promise<Awaited<R>> {
  return app.evaluate((_e, x) => ((globalThis as Record<string, unknown>).__browserEval as (src: string, a: unknown) => Promise<unknown>)(x.src, x.a), { src: fn.toString(), a: arg ?? null }) as Promise<Awaited<R>>
}
