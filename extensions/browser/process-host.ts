// The browser extension's app side when the browser runs in a process of its own (Windows): the app starts that process
// (process-child.ts, bundled as app/dist/browser-child.cjs, with the app's own Electron) and serves it what only the app has:
// the window (its handle, size, scale and renderer), settings, agents, tray notices, the trash and the log. The extension's
// channels are registered here at once and handed over; the window's panel messages about the tabs' surfaces too.
// The supervisor: the process exiting, crashing or hanging (no answer to HEARTBEAT_MISSES pings: killed) leaves the app alone.
// Every tab the app knew shows the crash state ("O navegador parou" · Reabrir); the gatekeeper's endpoint file is removed so the
// agents' tool fails at once instead of knocking on a dead port. "Reabrir" starts the process again (its gatekeeper writes a new
// endpoint, the agents' tool reconnects by itself) and brings every crashed tab back, except one that was on screen or loading
// in two crashes in a row within CRASH_REPEAT_MS (crash-rules.ts): that one stays paused, explained, until its own Reabrir.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { app, type BrowserWindow, screen } from 'electron'
import type { TetherMain } from '../../app/main/ext-api.ts'
import { BROWSER_CRASHED, Wire } from '../../app/main/browser-wire.ts'
import { focus, hwndOf } from '../../app/main/win32-embed.ts'
import { toDisposable, type IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { NoticeHandle } from '../../app/main/tray-notices.ts'
import type { SettingValue } from '../../app/shared/vscode-configuration-registry.ts'
import { type BrowserCrash, CHILD_START_MS, HEARTBEAT_MISSES, HEARTBEAT_MS, pausedAfter } from './crash-rules.ts'
import { serveChildReady } from './agent-resync.ts'
import { BROWSER_INVOKES } from './ipc.ts'
import { manifest } from './manifest.ts'
import { scrubLogLine } from './log-scrub.ts'
import { isId, savedOf, type TabInfo } from './tab-rules.ts'
import type { BrowserHello, HostWindowState } from './process-child.ts'

export const CHILD_BUNDLE = 'browser-child.cjs'

/** The browser runs in its own process here: Windows (the tabs' windows are embedded through user32) with the bundle built. */
export function wantsBrowserProcess(main: TetherMain): boolean {
  if (process.platform !== 'win32' || process.env.TETHER_BROWSER_INPROCESS === '1') return false
  if (!main.surfaces.forwardTo) return false
  return existsSync(join(main.dist, CHILD_BUNDLE))
}

type Fallback = (...args: unknown[]) => unknown

export function activateRemote(main: TetherMain): IDisposable[] {
  const log = (msg: string): void => main.log(scrubLogLine(msg))
  const ipc = main.ipc() as unknown as {
    handle(channel: string, fn: (...args: unknown[]) => unknown): IDisposable
    on(channel: string, fn: (...args: unknown[]) => void): IDisposable
    send(channel: string, ...args: unknown[]): void
  }
  const subs: IDisposable[] = []
  let disposed = false
  let child: ChildProcess | undefined
  let wire: Wire | undefined
  let server: Server | undefined
  /** Resolves with the line once the process said it is ready; replaced at every start. */
  let ready: Promise<Wire | undefined> = Promise.resolve(undefined)
  let starting: Promise<Wire | undefined> | undefined
  /** What the app knows of every tab (the process's 'tab' events), to show them crashed when it goes. */
  const tabs = new Map<string, TabInfo>()
  /** The surfaces on screen (the window's place messages), to know which tabs were in view when it went. */
  const onScreen = new Set<string>()
  let lastCrash: BrowserCrash | undefined
  let persistentLogins = false
  const notices = new Map<number, NoticeHandle>()
  const watched = new Set<string>()
  let win: BrowserWindow | undefined

  // ---- the window, as the process needs it ----
  const windowState = (w: BrowserWindow): HostWindowState => {
    const [width, height] = w.getContentSize() as [number, number]
    let scale = 1
    try { scale = screen.getDisplayMatching(w.getBounds()).scaleFactor } catch { /* no display yet */ }
    return { hwnd: hwndOf(w.getNativeWindowHandle()), content: { width, height }, minimized: w.isMinimized(), scale }
  }
  const pushWindow = (event?: string): void => {
    const w = main.window.current()
    if (w && !w.isDestroyed()) wire?.post('window', windowState(w), event)
  }
  const follow = (w: BrowserWindow): void => {
    if (win === w) return
    win = w
    for (const ev of ['resize', 'minimize', 'restore', 'move', 'maximize', 'unmaximize'] as const) w.on(ev as 'resize', () => pushWindow(ev === 'move' || ev === 'maximize' || ev === 'unmaximize' ? 'resize' : ev))
    // A tab's page is a child window of another process: once it has the keyboard, a press on the app's own interface does not
    // take it back (the window is active already, so Windows does not refocus it, and Chromium does not on mouse down).
    const hwnd = hwndOf(w.getNativeWindowHandle())
    w.webContents.on('input-event', (_e, input) => { if (input.type === 'mouseDown') focus(hwnd) })
    w.on('closed', () => {
      if (win === w) win = undefined
      wire?.post('window', { hwnd: 0, content: { width: 0, height: 0 }, minimized: true, scale: 1 }, 'closed')
    })
    pushWindow('resize')
  }
  const onWindowCreated = (): void => { setImmediate(() => { const w = main.window.current(); if (w && !w.isDestroyed()) follow(w) }) }
  app.on('browser-window-created', onWindowCreated)
  subs.push(toDisposable(() => app.off('browser-window-created', onWindowCreated)))
  const displayChanged = (): void => pushWindow()
  screen.on('display-metrics-changed', displayChanged)
  subs.push(toDisposable(() => screen.off('display-metrics-changed', displayChanged)))

  // ---- the extension's channels: registered now, handed over once the process is up ----
  const crashedInfo = (t: TabInfo, crashed: TabInfo['crashed']): TabInfo => ({ ...t, loading: false, ...(crashed ? { crashed } : {}) })
  const fallback: Record<string, Fallback> = {
    list: () => [...tabs.values()],
    get: tabId => (typeof tabId === 'string' ? tabs.get(tabId) ?? null : null),
    restore: raw => { const id = (raw as { tabId?: unknown } | null)?.tabId; return typeof id === 'string' ? tabs.get(id) ?? null : null },
    close: tabId => { if (typeof tabId === 'string') tabs.delete(tabId) },
    status: () => ({ persistentLogins }),
    localNetworkOpen: () => [],
    controls: () => [],
    agents: () => main.agents.list().map(a => ({ slotId: a.slotId, name: a.name, alive: a.alive })),
    downloads: () => [],
    uploadOpen: () => [],
  }
  for (const channel of BROWSER_INVOKES) {
    if (channel === 'reopen') continue
    subs.push(ipc.handle(channel, async (...args: unknown[]) => {
      const w = await ready
      if (!w || w.closed) return fallback[channel]?.(...args)
      try {
        const r = await w.call('ipcInvoke', channel, args)
        if (channel === 'status') persistentLogins = (r as { persistentLogins?: boolean } | null)?.persistentLogins === true
        if (channel === 'close' && typeof args[0] === 'string') tabs.delete(args[0])
        return r
      } catch (e) {
        if ((e as Error).message === BROWSER_CRASHED) return fallback[channel]?.(...args)
        throw e
      }
    }))
  }
  subs.push(ipc.handle('reopen', async (tabId: unknown) => {
    if (!isId(tabId)) return null
    const w = await ready
    const known = tabs.get(tabId)
    if (w && !w.closed && known?.crashed !== 'browser' && known?.crashed !== 'suspect') return w.call('ipcInvoke', 'reopen', [tabId]).catch(() => null)
    return reopenAfterCrash(tabId)
  }))

  // ---- the process ----
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\tether-browser-${process.pid}-${randomBytes(6).toString('hex')}` : join(main.home, `browser-${process.pid}.sock`)
  let token = ''
  let accept: ((w: Wire) => void) | undefined

  const serve = (): Promise<void> => new Promise((resolve, reject) => {
    server = createServer(socket => {
      const w = new Wire(socket)
      let greeted = false
      w.handle('hello', (t: unknown, pid: unknown) => {
        if (greeted || t !== token || !token || pid !== child?.pid) { w.close(); throw new Error('recusado') }
        greeted = true
        token = ''
        const current = main.window.current()
        const settings: Record<string, SettingValue | undefined> = {}
        for (const key of Object.keys(manifest.contributes?.settings ?? {})) settings[key] = main.settings.get(key)
        const hello: BrowserHello = {
          home: main.home, userDir: main.userDir, dist: main.dist, brand: main.brand, settings, setKeys: Object.keys(settings).filter(k => main.settings.isSet(k)), agents: main.agents.list(),
          window: current && !current.isDestroyed() ? windowState(current) : { hwnd: 0, content: { width: 0, height: 0 }, minimized: true, scale: 1 },
        }
        serveLine(w)
        accept?.(w)
        return hello
      })
      setTimeout(() => { if (!greeted) w.close() }, CHILD_START_MS)
    })
    server.once('error', reject)
    server.listen(pipe, () => resolve())
  })

  /** What the process asks of the app over its line. */
  const serveLine = (w: Wire): void => {
    w.handle('log', (msg: unknown) => main.log(scrubLogLine(String(msg))))
    w.handle('winSend', (channel: unknown, args: unknown) => {
      const cur = main.window.current()
      if (cur && !cur.isDestroyed() && typeof channel === 'string') cur.webContents.send(channel, ...(Array.isArray(args) ? args : []))
    })
    w.handle('focusInterface', () => { const cur = main.window.current(); if (cur && !cur.isDestroyed()) { focus(hwndOf(cur.getNativeWindowHandle())); cur.webContents.focus() } })
    w.handle('ipcHandle', () => { /* every invoke channel is registered by the app already */ })
    w.handle('ipcOn', () => { /* the extension's renderer sends nothing on its own channels */ })
    w.handle('ipcEvent', (channel: unknown, args: unknown) => {
      if (typeof channel !== 'string') return
      const a = Array.isArray(args) ? args : []
      if (channel === 'tab' && a[0] && typeof a[0] === 'object') { const t = a[0] as TabInfo; tabs.set(t.tabId, t) }
      if (channel === 'closed' && typeof a[0] === 'string') tabs.delete(a[0])
      ipc.send(channel, ...a)
    })
    w.handle('settingSet', (key: unknown, value: unknown) => { if (typeof key === 'string') main.settings.set(key, value as SettingValue) })
    w.handle('settingWatch', (key: unknown) => {
      if (typeof key !== 'string' || watched.has(key)) return
      watched.add(key)
      subs.push(main.settings.onChange(key, v => wire?.post('setting', key, v, main.settings.isSet(key))))
    })
    w.handle('stateUpdate', (key: unknown, value: unknown) => { if (typeof key === 'string') main.state.update(key, value) })
    w.handle('noticeRaise', (id: unknown, opts: unknown) => {
      const o = opts as { slotId?: string; message?: string } | null
      if (typeof id === 'number' && o && typeof o.message === 'string') notices.set(id, main.notices.raise({ ...(o.slotId ? { slotId: o.slotId } : {}), message: o.message }))
    })
    w.handle('noticeUpdate', (id: unknown, message: unknown) => { if (typeof message === 'string') notices.get(id as number)?.update(message) })
    w.handle('noticeResolve', (id: unknown) => { notices.get(id as number)?.resolve(); notices.delete(id as number) })
    w.handle('trash', (path: unknown) => (typeof path === 'string' ? main.shell.trash(path) : Promise.reject(new Error('caminho inválido'))))
  }

  subs.push(main.agents.onDidChange(a => wire?.post('agentChange', a, false)))
  subs.push(main.agents.onDidExit(e => wire?.post('agentExit', e)))

  const resolveNotices = (): void => { for (const n of notices.values()) n.resolve(); notices.clear() }

  /** Starts the process and waits for its line (undefined: it did not come up). */
  const launch = (): Promise<Wire | undefined> => {
    if (starting) return starting
    starting = (async () => {
      if (!server) await serve()
      token = randomBytes(24).toString('hex')
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
      env.TETHER_BROWSER_PIPE = pipe
      env.TETHER_BROWSER_TOKEN = token
      env.TETHER_BROWSER_HOME = main.home
      const started = Date.now()
      const proc = spawn(process.execPath, [join(main.dist, CHILD_BUNDLE)], { env, stdio: 'ignore', windowsHide: true })
      child = proc
      log(`processo do navegador iniciado (pid ${proc.pid})`)
      const connected = new Promise<Wire | undefined>(resolve => {
        accept = w => { accept = undefined; resolve(w) }
        proc.once('exit', () => resolve(undefined))
        setTimeout(() => resolve(undefined), CHILD_START_MS)
      })
      proc.once('exit', (code, signal) => onExit(proc, code, signal))
      const w = await connected
      if (!w) {
        log(`processo do navegador não conectou em ${Math.round((Date.now() - started) / 1000)} s`)
        if (child === proc && proc.exitCode === null) proc.kill()
        return undefined
      }
      const isReady = new Promise<void>(resolve => { serveChildReady(w, () => main.agents.list(), resolve); w.whenClosed(() => resolve()) })
      wire = w
      w.whenClosed(() => { if (wire === w) wire = undefined })
      const cur = main.window.current()
      if (cur && !cur.isDestroyed()) { win = undefined; follow(cur) }
      await isReady
      if (w.closed) return undefined
      heartbeat(w, proc)
      log(`processo do navegador pronto em ${Date.now() - started} ms`)
      return w
    })().finally(() => { starting = undefined })
    ready = starting
    return starting
  }

  /** A process that stops answering is hung: it is killed, and its exit is a crash like any other. */
  const heartbeat = (w: Wire, proc: ChildProcess): void => {
    let misses = 0
    let waiting = false
    const timer = setInterval(() => {
      if (w.closed) { clearInterval(timer); return }
      if (waiting) {
        if (++misses >= HEARTBEAT_MISSES) {
          clearInterval(timer)
          log(`processo do navegador não responde há ${(misses * HEARTBEAT_MS) / 1000} s: encerrado`)
          try { proc.kill('SIGKILL') } catch { /* gone */ }
        }
        return
      }
      waiting = true
      void w.call('ping').catch(() => {}).finally(() => { waiting = false; misses = 0 })
    }, HEARTBEAT_MS)
    w.whenClosed(() => clearInterval(timer))
  }

  const onExit = (proc: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void => {
    if (child !== proc) return
    child = undefined
    wire?.close()
    wire = undefined
    ready = Promise.resolve(undefined)
    resolveNotices()
    if (disposed) return
    log(`processo do navegador parou (código ${code ?? '—'}${signal ? `, sinal ${signal}` : ''})`)
    // The agents' tool reads the endpoint at every connection: without it they fail at once, and the next process writes a new one.
    try { rmSync(join(main.home, 'browser', 'endpoint.json'), { force: true }) } catch { /* the next start rewrites it */ }
    const now: BrowserCrash = {
      at: Date.now(),
      suspects: [...tabs.values()].filter(t => t.loading || onScreen.has(t.surfaceId)).map(t => t.tabId),
    }
    const paused = pausedAfter(lastCrash, now)
    lastCrash = now
    onScreen.clear()
    for (const t of [...tabs.values()]) {
      const info = crashedInfo(t, paused.has(t.tabId) ? 'suspect' : 'browser')
      tabs.set(t.tabId, info)
      ipc.send('tab', info)
    }
    if (paused.size) log(`${paused.size === 1 ? 'uma guia volta pausada' : `${paused.size} guias voltam pausadas`}: o navegador caiu duas vezes com ela aberta`)
  }

  /** "Reabrir" after the process went: started again, and the crashed tabs come back (a paused one only when it is the one asked). */
  let reopening: Promise<void> | undefined
  const reopenAfterCrash = async (tabId: string): Promise<TabInfo | null> => {
    const asked = tabs.get(tabId)
    if (!asked) return null
    if (!reopening) {
      reopening = (async () => {
        const w = await (wire && !wire.closed ? ready : launch())
        if (!w) return
        // The rest come back in order; one that fails stays crashed.
        for (const t of [...tabs.values()]) {
          if (t.crashed !== 'browser') continue
          await restoreTab(w, t)
        }
      })().finally(() => { reopening = undefined })
    }
    await reopening
    const now = tabs.get(tabId)
    if (now?.crashed === 'suspect') {
      const w = await ready
      if (w && !w.closed) await restoreTab(w, now)
    }
    return tabs.get(tabId) ?? null
  }

  const restoreTab = async (w: Wire, t: TabInfo): Promise<void> => {
    const saved = savedOf(t)
    if (!saved.url) return
    try {
      const info = await w.call('ipcInvoke', 'restore', [saved]) as TabInfo | null
      if (info) { tabs.set(info.tabId, info); ipc.send('tab', info) }
    } catch (e) { log(`guia ${t.tabId}: não reabriu (${(e as Error).message})`) }
  }

  // ---- the window's panel messages about the tabs' surfaces ----
  subs.push(main.surfaces.forwardTo!({
    send: (channel, raw) => {
      const m = raw as { surface?: unknown; visible?: unknown } | null
      if (typeof m?.surface === 'string') {
        if (channel === 'surface:place' && m.visible === true) onScreen.add(m.surface)
        else onScreen.delete(m.surface)
      }
      wire?.post('surface', channel, raw)
    },
    invoke: async (channel, raw) => {
      const w = wire
      if (!w || w.closed) return null
      return w.call('surfaceInvoke', channel, raw)
    },
  }))

  // E2E builds: the test's function runs against the extension's hooks in the browser process.
  const g = globalThis as Record<string, unknown>
  g.__browserRun = async (src: string, arg: unknown) => { const w = await ready; if (!w) throw new Error(BROWSER_CRASHED); return w.call('testRun', src, arg) }
  g.__browserEval = async (src: string, arg: unknown) => { const w = await ready; if (!w) throw new Error(BROWSER_CRASHED); return w.call('testEval', src, arg) }
  g.__browserProcess = { pid: () => child?.pid, alive: () => !!wire && !wire.closed, ready: () => ready.then(w => !!w) }
  subs.push(toDisposable(() => { delete g.__browserRun; delete g.__browserEval; delete g.__browserProcess }))

  subs.push(toDisposable(() => {
    disposed = true
    resolveNotices()
    const proc = child
    const w = wire
    if (w && !w.closed) w.post('quit')
    if (proc) setTimeout(() => { if (proc.exitCode === null) { try { proc.kill() } catch { /* gone */ } } }, 1500).unref()
    server?.close()
  }))
  // A real quit of the app waits (bounded) for the browser process's own quit, which clears the pages' storages first.
  let quitAsked = false
  const onBeforeQuit = (e: Electron.Event): void => {
    const proc = child
    const w = wire
    if (quitAsked || !proc || proc.exitCode !== null || !w || w.closed) return
    quitAsked = true
    e.preventDefault()
    disposed = true
    const gone = new Promise<void>(r => { proc.once('exit', () => r()); setTimeout(r, 6_000) })
    w.post('quit')
    void gone.finally(() => app.quit())
  }
  app.on('before-quit', onBeforeQuit)
  subs.push(toDisposable(() => app.off('before-quit', onBeforeQuit)))
  // The app leaving takes the process with it even when the extension is not disposed first.
  const onQuit = (): void => { const proc = child; if (proc && proc.exitCode === null) { try { proc.kill() } catch { /* gone */ } } }
  process.on('exit', onQuit)
  subs.push(toDisposable(() => process.off('exit', onQuit)))

  void launch()
  return subs
}
