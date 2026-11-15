// The browser process (bundled as app/dist/browser-child.cjs, started by extensions/browser/process-host.ts with the app's own Electron).
// It runs the browser extension's whole main side (extensions/browser/main.ts: tabs, gatekeeper, session, downloads...) away
// from the app, so a page, a debugger bug or a native crash here can only take this process: the app shows the tabs' crash
// state and offers "Reabrir". What the app owns (the window and its renderer, settings, agents, tray notices, the log) is
// reached over the line (app/main/browser-wire.ts) through a TetherMain built here; the tabs' surfaces are this process's own.
// Each surface gets a frameless window of its own, embedded as a child window of the app's window at the surface's rectangle
// (app/main/win32-embed.ts); the surface core (app/main/surfaces.ts) and the panel bridge (app/main/surface-bridge.ts) run
// here unchanged on top of it. In the E2E's hidden mode the windows are never shown nor embedded (the app's window is
// offscreen): the pages paint, answer CDP and are captured as views of a window never shown, as in the app's own process.
import { connect } from 'node:net'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import * as electron from 'electron'
import { app, BaseWindow, ipcMain, type BrowserWindow, type IpcMainEvent, type WebContentsView } from 'electron'
import { Wire } from '../../app/main/browser-wire.ts'
import { startCrashReports } from '../../app/main/crash-report.ts'
import { type SurfaceStage, SurfaceManager } from '../../app/main/surfaces.ts'
import { SurfaceBridge } from '../../app/main/surface-bridge.ts'
import type { Rect, Size } from '../../app/main/surface-rules.ts'
import type { AgentExit, AgentInfo, MainAgents, TetherMain } from '../../app/main/ext-api.ts'
import { canEmbed, embed, hwndOf, place, raise } from '../../app/main/win32-embed.ts'
import { toDisposable, type IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { SettingValue } from '../../app/shared/vscode-configuration-registry.ts'
import type { MainIpc } from '../../app/shared/ext-ipc.ts'
import type { Brand } from '../../app/shared/brand.ts'
import * as browser from './main.ts'

/** What the app tells the browser process when it connects. */
export interface BrowserHello {
  home: string
  userDir: string
  dist: string
  brand: Brand
  settings: Record<string, SettingValue | undefined>
  /** The settings the person set explicitly (the others read as their default). */
  setKeys: string[]
  agents: AgentInfo[]
  window: HostWindowState
}

export interface HostWindowState {
  hwnd: number
  content: Size
  minimized: boolean
  /** Physical px per DIP of the window's display. */
  scale: number
}

const pipe = process.env.TETHER_BROWSER_PIPE ?? ''
const token = process.env.TETHER_BROWSER_TOKEN ?? ''
const home = process.env.TETHER_BROWSER_HOME ?? ''
const hidden = process.env.TETHER_E2E_HIDDEN === '1'
delete process.env.TETHER_BROWSER_TOKEN

// Lines written before the line is up wait here.
const early: string[] = []
let wire: Wire | undefined
const log = (msg: string): void => { if (wire && !wire.closed) wire.post('log', msg); else early.push(msg) }

// A userData of its own (two Electron processes cannot share one profile's locks). The tabs' persistent partition moves over
// from the app's userData the first time (the app no longer opens it).
const userData = join(home, 'electron-browser')
app.setPath('userData', userData)
try {
  const from = join(home, 'electron', 'Partitions', 'tether-browser')
  const to = join(userData, 'Partitions', 'tether-browser')
  if (existsSync(from) && !existsSync(to)) { mkdirSync(join(userData, 'Partitions'), { recursive: true }); renameSync(from, to); log('partição do navegador movida para o processo do navegador') }
} catch (e) { log(`partição do navegador não foi movida (${(e as Error).message})`) }
startCrashReports(home, 'tether-browser', log)
// No window of this process is the app's: closing them all is not a reason to leave. The app ends this process.
app.on('window-all-closed', () => {})

class Listeners<A extends unknown[]> {
  private readonly set = new Set<(...args: A) => void>()
  add(l: (...args: A) => void): IDisposable { this.set.add(l); return toDisposable(() => { this.set.delete(l) }) }
  fire(...args: A): void { for (const l of [...this.set]) { try { l(...args) } catch { /* the listener's own */ } } }
}

/** The app's window as this process sees it: its size, state and scale (pushed by the app), and its renderer reached over the line. */
class HostWindow {
  state: HostWindowState
  private readonly events = new Map<string, Listeners<[]>>()
  readonly webContents = {
    id: -1,
    send: (channel: string, ...args: unknown[]): void => { wire?.post('winSend', channel, args) },
    focus: (): void => { wire?.post('focusInterface') },
  }
  constructor(state: HostWindowState) { this.state = state }
  getContentSize(): [number, number] { return [this.state.content.width, this.state.content.height] }
  isMinimized(): boolean { return this.state.minimized }
  isDestroyed(): boolean { return false }
  on(event: string, fn: () => void): this { let l = this.events.get(event); if (!l) this.events.set(event, l = new Listeners()); l.add(fn); return this }
  fire(event: string): void { this.events.get(event)?.fire() }
}

/**
 * One surface's stage: a frameless window of this process holding the page's view (and its shield over it), embedded in the
 * app's window and moved to the page's rectangle. Rectangles come in the app window's coordinates (DIP); the child window is
 * placed in physical px of the app window's client area, and the views fill it.
 */
class EmbeddedStage implements SurfaceStage {
  readonly key = this
  private readonly carrier: BaseWindow
  private readonly hwnd: number
  private readonly embedded: boolean
  private readonly rects = new Map<WebContentsView, Rect>()
  private page: WebContentsView | undefined
  private shown = false
  private gone = false

  private readonly host: HostWindow
  private readonly resize: Listeners<[]>
  private readonly closed: Listeners<[]>

  constructor(host: HostWindow, resize: Listeners<[]>, closed: Listeners<[]>) {
    this.host = host
    this.resize = resize
    this.closed = closed
    this.carrier = new BaseWindow({ show: false, frame: false, skipTaskbar: true, resizable: false, hasShadow: false, focusable: true, width: 1, height: 1 })
    this.hwnd = hwndOf(this.carrier.getNativeWindowHandle())
    // No app window (it closed to the tray): never shown on its own; the surfaces go with the window anyway.
    this.embedded = !hidden && host.state.hwnd !== 0 && canEmbed() && embed(this.hwnd, host.state.hwnd)
    if (!hidden && host.state.hwnd !== 0 && !this.embedded) log('superfície: janela do navegador não encaixou na janela do tether')
    this.carrier.on('closed', () => { this.gone = true })
  }

  destroyed(): boolean { return this.gone }
  contentSize(): Size { return { ...this.host.state.content } }
  add(view: WebContentsView): void {
    if (this.gone) return
    if (!this.page) this.page = view
    this.carrier.contentView.addChildView(view)
    if (this.embedded) raise(this.hwnd)
  }
  remove(view: WebContentsView): void { if (!this.gone) this.carrier.contentView.removeChildView(view) }
  getBounds(view: WebContentsView): Rect { return { ...(this.rects.get(view) ?? { x: 0, y: 0, width: 0, height: 0 }) } }
  setVisible(view: WebContentsView, on: boolean): void { view.setVisible(on) }
  setBounds(view: WebContentsView, rect: Rect): void {
    if (this.gone) return
    this.rects.set(view, { ...rect })
    view.setBounds({ x: 0, y: 0, width: rect.width, height: rect.height })
    if (view !== this.page) return
    if (this.embedded) {
      const s = this.host.state.scale
      place(this.hwnd, rect.x * s, rect.y * s, rect.width * s, rect.height * s)
      if (!this.shown) { this.shown = true; this.carrier.showInactive() }
    } else {
      this.carrier.setContentBounds({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) })
    }
  }
  focusInterface(): void { this.host.webContents.focus() }
  onResize(fn: () => void): void { this.resize.add(fn) }
  onClosed(fn: () => void): void { this.closed.add(fn) }
  /** The scale changed: the child window is placed again at the page's rectangle. */
  replace(): void { const r = this.page && this.rects.get(this.page); if (r && this.page) this.setBounds(this.page, r) }
  release(): void { if (!this.gone) { this.gone = true; this.carrier.destroy() } }
}

/** The app's agents, mirrored from what it pushes. */
class MirroredAgents implements MainAgents {
  private readonly agents = new Map<string, AgentInfo>()
  private readonly changed = new Listeners<[AgentInfo]>()
  private readonly exited = new Listeners<[AgentExit]>()
  constructor(list: AgentInfo[]) { for (const a of list) this.agents.set(a.slotId, a) }
  list(): AgentInfo[] { return [...this.agents.values()] }
  get(slotId: string): AgentInfo | undefined { return this.agents.get(slotId) }
  onDidChange(l: (a: AgentInfo) => void): IDisposable { return this.changed.add(l) }
  onDidExit(l: (e: AgentExit) => void): IDisposable { return this.exited.add(l) }
  change(a: AgentInfo, gone: boolean): void { if (gone) this.agents.delete(a.slotId); else this.agents.set(a.slotId, a); this.changed.fire(a) }
  exit(e: AgentExit): void { this.exited.fire(e) }
}

async function start(): Promise<void> {
  const socket = connect(pipe)
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  const w = new Wire(socket)
  wire = w
  // The app went away (or dropped the line): nothing here is useful without it.
  w.whenClosed(() => app.exit(0))
  const hello = await w.call('hello', token, process.pid) as BrowserHello
  for (const line of early.splice(0)) w.post('log', line)
  await app.whenReady()

  const hostWin = new HostWindow(hello.window)
  const resize = new Listeners<[]>()
  const closed = new Listeners<[]>()
  const stages = new Set<EmbeddedStage>()
  w.handle('window', (state: unknown, event: unknown) => {
    const before = hostWin.state
    hostWin.state = state as HostWindowState
    if (typeof event === 'string') hostWin.fire(event)
    if (before.scale !== hostWin.state.scale) for (const s of stages) s.replace()
    if (event === 'resize') resize.fire()
    if (event === 'closed') closed.fire()
  })

  const surfaces = new SurfaceManager({
    dist: hello.dist,
    stage: () => { const s = new EmbeddedStage(hostWin, resize, closed); stages.add(s); const release = s.release.bind(s); s.release = () => { stages.delete(s); release() }; return s },
    ipc: ipcMain,
    log,
  })
  // The panel bridge, fed with the window's messages the app hands over (they came from its renderer).
  const bridgeOn = new Map<string, (event: IpcMainEvent, ...args: unknown[]) => void>()
  const bridgeHandle = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  new SurfaceBridge({
    surfaces: owner => surfaces.forOwner(owner),
    window: () => hostWin as unknown as BrowserWindow,
    ipc: { on: (c, fn) => bridgeOn.set(c, fn), handle: (c, fn) => bridgeHandle.set(c, fn as never) },
    log,
  })
  const fromWindow = { sender: hostWin.webContents } as unknown as IpcMainEvent
  w.handle('surface', (channel: unknown, raw: unknown) => { bridgeOn.get(String(channel))?.(fromWindow, raw) })
  w.handle('surfaceInvoke', (channel: unknown, raw: unknown) => bridgeHandle.get(String(channel))?.(fromWindow, raw))

  // The extension's channels: the app serves them to its renderer and hands each call over.
  const invokes = new Map<string, (...args: unknown[]) => unknown>()
  const sends = new Map<string, (...args: unknown[]) => void>()
  w.handle('ipcInvoke', (channel: unknown, args: unknown) => {
    const fn = invokes.get(String(channel))
    if (!fn) throw new Error(`canal desconhecido: ${String(channel)}`)
    return fn(...(Array.isArray(args) ? args : []))
  })
  w.handle('ipcSend', (channel: unknown, args: unknown) => { sends.get(String(channel))?.(...(Array.isArray(args) ? args : [])) })
  const ipc = {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => { invokes.set(channel, fn); w.post('ipcHandle', channel); return toDisposable(() => { invokes.delete(channel) }) },
    on: (channel: string, fn: (...args: unknown[]) => void) => { sends.set(channel, fn); w.post('ipcOn', channel); return toDisposable(() => { sends.delete(channel) }) },
    send: (channel: string, ...args: unknown[]) => { w.post('ipcEvent', channel, args) },
  }

  const settings = { ...hello.settings }
  const settingListeners = new Map<string, Listeners<[SettingValue]>>()
  const explicit = new Set(hello.setKeys)
  w.handle('setting', (key: unknown, value: unknown, isSet: unknown) => {
    settings[String(key)] = value as SettingValue
    if (isSet === false) explicit.delete(String(key)); else explicit.add(String(key))
    settingListeners.get(String(key))?.fire(value as SettingValue)
  })
  const agents = new MirroredAgents(hello.agents)
  w.handle('agentChange', (a: unknown, gone: unknown) => agents.change(a as AgentInfo, gone === true))
  w.handle('agentExit', (e: unknown) => agents.exit(e as AgentExit))
  const state = new Map<string, unknown>()
  let noticeIds = 0

  const main: TetherMain = {
    id: browser.manifest.id,
    brand: hello.brand,
    home: hello.home,
    userDir: hello.userDir,
    dist: hello.dist,
    ipc: <C>() => ipc as unknown as MainIpc<C & object>,
    settings: {
      get: <T extends SettingValue>(key: string) => settings[key] as T | undefined,
      set: (key, value) => { settings[key] = value; explicit.add(key); w.post('settingSet', key, value) },
      isSet: key => explicit.has(key),
      onChange: (key, listener) => { let l = settingListeners.get(key); if (!l) settingListeners.set(key, l = new Listeners()); w.post('settingWatch', key); return l.add(listener) },
    },
    state: {
      get: <T>(key: string) => state.get(key) as T | undefined,
      update: (key, value) => { state.set(key, value); w.post('stateUpdate', key, value) },
    },
    webviews: { guard: () => toDisposable(() => {}) },
    window: { current: () => undefined },
    surfaces: surfaces.forOwner(browser.manifest.id),
    agents,
    notices: {
      raise: opts => {
        const id = ++noticeIds
        w.post('noticeRaise', id, opts)
        return { update: message => w.post('noticeUpdate', id, message), resolve: () => w.post('noticeResolve', id), dispose: () => w.post('noticeResolve', id) }
      },
    },
    shell: { trash: path => w.call('trash', path).then(() => undefined) },
    log: msg => log(`[${browser.manifest.id}] ${msg}`),
  }

  const subs = browser.activateLocal(main)
  w.handle('ping', () => true)
  // E2E builds: the test runs a function against the extension's test hooks here (the app relays it).
  w.handle('testRun', (src: unknown, arg: unknown) => {
    const hooks = (globalThis as Record<string, unknown>).__browserTabs
    return (new Function('t', 'a', `return (${String(src)})(t, a)`))(hooks, arg)
  })
  w.handle('testEval', (src: unknown, arg: unknown) => (new Function('electron', 'a', `return (${String(src)})(electron, a)`))(electron, arg))
  // The app is quitting: a real quit here, so the session clears the page storages before it lets go (session.ts), bounded.
  w.handle('quit', () => {
    setTimeout(() => app.exit(0), 5_000).unref()
    app.once('will-quit', () => { for (const s of subs) { try { s.dispose() } catch { /* leaving */ } } })
    app.quit()
  })
  w.post('ready')
}

start().catch(e => {
  log(`processo do navegador não iniciou (${(e as Error).message})`)
  setTimeout(() => app.exit(1), 100)
})
