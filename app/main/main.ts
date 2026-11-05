// Electron main process: one window, one connection to tetherd (spawned detached when nothing answers on
// the pipe), a narrow IPC surface for the renderer (see app/shared/api.ts). Layout and recent folders live
// under TETHER_HOME. Closing the window hides the app to the system tray (the window is destroyed, so the
// renderer's memory is freed; the process stays, still connected to the daemon, to feed the tray). The daemon
// keeps every slot running whatever the app does.
// Built by app/build.mjs into app/dist/main.cjs (CommonJS: __dirname is available).
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { loadLayoutFile, saveLayoutFile } from './layout-file.ts'
import { createAppLog } from './app-log.ts'
import { ackFromLiveInstance, relaunchArgs, relaunchedFrom } from './relaunch.ts'
import { userInfo } from 'node:os'
import { delimiter, join } from 'node:path'
import { DaemonClient, DaemonError, NotTetherError, type SpawnOptions } from '../../src/daemon/client.ts'
import { pipePath, PROTOCOL_VERSION } from '../../src/daemon/protocol.ts'
import type { Notice, Reply, SlotState } from '../../src/daemon/protocol.ts'
import { canonicalDir, tetherHome } from '../../src/core/paths.ts'
import { ProfileError, readProfiles, removeProfile, upsertProfile, writeProfiles } from '../../src/core/profile.ts'
import type { ProfileInput } from '../../src/core/profile.ts'
import type { ConnectionState, NotePrepared, NoteRead, NoteRenamed, NoteWritten, ProfileDeleted, ProfileSaved, ProfilesList, RequestBody } from '../shared/api.ts'
import { addTetherToGitignore, NoteWatchers, notesDirFor, prepareNote, readNote, renameNote, writeNote } from './note-files.ts'
import { registerQuickOpen } from './quick-open-main.ts'
import { registerTerminalLinks } from './terminal-links-main.ts'
import { NOTE_EXTENSION } from '../shared/notes.ts'
import type { AskRequest, Confirmations, DialogAnswer, MainSituation } from '../shared/dialog.ts'
import { normalizeUi, type UiSettings } from '../shared/ui-settings.ts'
import { FONT_SIZE_LABEL, type FontSizeCommand } from '../shared/font.ts'
import { trayModel, trayWanted } from '../shared/tray.ts'
import type { TrayCommand } from '../shared/tray.ts'
import { createTray, type TrayController } from './tray.ts'
import { normalizeAppearance, type TerminalAppearance } from '../shared/terminal-theme.ts'
import { normalizeTheme, resolveScheme, THEME_LABEL, THEME_SETTINGS, WINDOW_BACKGROUND } from '../shared/theme.ts'
import type { ThemeSetting, ThemeState } from '../shared/theme.ts'

const home = tetherHome()
const pipe = pipePath(home, userInfo().username)
/** Taskbar grouping / pinning: the same id goes on the Start Menu shortcut (app/shortcut.ps1) and, on macOS, is the CFBundleIdentifier of Tether.app (app/install.mjs). */
const APP_USER_MODEL_ID = 'studio.codr.tether'
// Electron's own state (cache, GPU, the single-instance lock) lives under TETHER_HOME too: E2E runs with a
// private home never collide with the user's running app.
app.setPath('userData', join(home, 'electron'))
app.setAppUserModelId(APP_USER_MODEL_ID)
// The process runs from node_modules' Electron.app (Tether.app only wraps it: a launcher cannot change what
// the OS attributes the process to), so the name and the Dock icon are set here, not read from a bundle.
app.setName('Tether')
const layoutPath = join(home, 'layout.json')
const recentPath = join(home, 'recent-folders.json')
const RECENT_LIMIT = 12
/** Max wait for a freshly spawned tetherd to answer on the pipe. */
const DAEMON_START_TIMEOUT_MS = 15_000
/** E2E runs set this so the test windows never show up on the user's screen. */
const hidden = process.env.TETHER_E2E_HIDDEN === '1'
/** The daemon's entry point, relative to app/dist (this bundle) → repo root. */
const daemonMain = join(__dirname, '..', '..', 'src', 'daemon', 'main.ts')
/** The pid this process replaces when "Reiniciar o app" started it (app/main/relaunch.ts). */
const replacedPid = relaunchedFrom(process.argv)
/** What this launch decides, on disk (<home>/tether-app.log) and on stderr: a Start Menu launch has no console. */
const appLog = createAppLog(join(home, 'tether-app.log'))
appLog(`start: ppid ${process.ppid}, exec ${process.execPath}, cwd ${process.cwd()}, args ${JSON.stringify(process.argv.slice(1))}${replacedPid ? `, replaces pid ${replacedPid} (Reiniciar o app)` : ''}`)

let daemon: DaemonClient | undefined
let connecting: Promise<void> | undefined
let win: BrowserWindow | undefined
let quittingAll = false
/** Set when the daemon connection was lost: the next connection reloads the renderer so every panel restarts its slot. */
let reloadOnReconnect = false
/** The app is going away for real (menu, tray, OS): closing the window must not be turned into "hide". */
let quitting = false
/** The daemon is being restarted from the tray: its connection closing is expected, not a crash. */
let restartingDaemon = false
let tray: TrayController | undefined
/** What the tray shows: the daemon's slots, kept up to date from the list at connect time and the state events. */
const slotStates = new Map<string, SlotState>()

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return fallback }
}

/** Atomic: temp + rename, so a crash mid-write never leaves a half file behind. */
function writeJson(path: string, value: unknown): void {
  mkdirSync(home, { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, path)
}

// ---------- daemon ----------

function connectionState(): ConnectionState {
  return daemon ? { connected: true, pipe, pid: daemon.hello.pid, version: daemon.hello.version } : { connected: false, pipe, error: 'sem conexão' }
}

function sendConnection(state: ConnectionState): void {
  win?.webContents.send('tether:connection', state)
}

/**
 * The Node that runs tetherd (`src/daemon/main.ts` needs Node ≥ 24 to load .ts; Electron's own Node
 * cannot be used: node-pty is built for the Node ABI). TETHER_NODE wins; `npm run app` leaves the npm
 * node in npm_node_execpath; else the first `node` on PATH (the Start Menu shortcut has only PATH).
 */
function findNode(): string | undefined {
  const env = process.env
  if (env.TETHER_NODE && existsSync(env.TETHER_NODE)) return env.TETHER_NODE
  if (env.npm_node_execpath && existsSync(env.npm_node_execpath)) return env.npm_node_execpath
  const name = process.platform === 'win32' ? 'node.exe' : 'node'
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir.replace(/^"|"$/g, ''), name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * How tetherd is started when nothing answers on the pipe: the shared helper (src/daemon/client.ts) puts it
 * outside this process' tree, sharing no handles with the window (so "End task" on the app never reaches
 * the agents), with the system node and the daemon's entry point resolved here.
 */
function daemonSpawnOptions(): SpawnOptions {
  const node = findNode()
  if (!node) {
    throw new Error('não encontrei o node (≥ 24) para subir o tetherd: ele precisa estar no PATH do usuário, '
      + 'ou defina a variável de ambiente TETHER_NODE com o caminho completo do node.exe')
  }
  if (!existsSync(daemonMain)) throw new Error(`tetherd não encontrado em ${daemonMain}`)
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_')) env[k] = v
  return { home, pipe, execPath: node, mainPath: daemonMain, env }
}

function checkVersion(client: DaemonClient): DaemonClient {
  if (client.hello.v === PROTOCOL_VERSION) return client
  client.close()
  throw new DaemonError('bad-request', `versão do protocolo incompatível: tetherd ${client.hello.v}, app ${PROTOCOL_VERSION}`)
}

/** Connects to tetherd, spawning it when the pipe does not answer. */
async function connectOnce(): Promise<DaemonClient> {
  try {
    return checkVersion(await DaemonClient.open(pipe, 'app'))
  } catch (e) {
    if (e instanceof DaemonError) throw e // it answered: spawning another one would not fix a wrong version
    if (e instanceof NotTetherError) throw new Error(`o canal ${pipe} está ocupado por um programa que não é o tetherd (${e.message})`)
  }
  return checkVersion(await DaemonClient.connect({ ...daemonSpawnOptions(), client: 'app', startTimeoutMs: DAEMON_START_TIMEOUT_MS }))
}

function connectDaemon(): Promise<void> {
  if (connecting) return connecting
  connecting = (async () => {
    try {
      const client = await connectOnce()
      daemon = client
      client.on('state', slot => { slotStates.set(slot.slotId, slot); updateTray(); win?.webContents.send('tether:event', { t: 'state', slot }) })
      client.on('data', (slotId, data) => win?.webContents.send('tether:event', { t: 'data', slotId, data }))
      client.on('removed', slotId => { slotStates.delete(slotId); updateTray(); win?.webContents.send('tether:event', { t: 'removed', slotId }) })
      client.on('profiles', profiles => win?.webContents.send('tether:event', { t: 'profiles', profiles }))
      client.on('close', () => {
        if (daemon !== client) return
        daemon = undefined
        slotStates.clear()
        updateTray()
        if (quittingAll || quitting) return
        // "Reiniciar serviço" (tray) brings its panels back through the renderer's reconnect path; any other
        // loss (a crash, "Reiniciar tudo…", `tether daemon restart`) reloads the page on the next connection.
        if (restartingDaemon) return
        reloadOnReconnect = true
        sendConnection({ connected: false, pipe, error: 'conexão com o tetherd fechada' })
        // The daemon died (or was shut down): bring one back (the tray keeps the app alive with no window)
        // and let the renderer restart its panels.
        setTimeout(() => { void connectDaemon() }, 500)
      })
      sendConnection(connectionState())
      void syncSlots(client)
      // A restarted daemon has no agents running: a fresh page restores the layout and resumes each slot's session.
      if (reloadOnReconnect) { reloadOnReconnect = false; win?.webContents.reloadIgnoringCache() }
    } catch (err) {
      sendConnection({ connected: false, pipe, error: err instanceof Error ? err.message : String(err) })
    } finally {
      connecting = undefined
    }
  })()
  return connecting
}

/** Loads the slot list for the tray (the renderer asks for its own copy). */
async function syncSlots(client: DaemonClient): Promise<void> {
  const list = await request({ t: 'list' })
  if (daemon !== client || list.t !== 'ok') return
  slotStates.clear()
  for (const s of list.slots ?? []) slotStates.set(s.slotId, s)
  updateTray()
}

function updateTray(): void { tray?.update(slotStates.values()) }

async function request(body: RequestBody): Promise<Reply> {
  if (!daemon) return { t: 'error', id: -1, code: 'bad-request', message: 'sem conexão com o tetherd' }
  try {
    return await daemon.request(body)
  } catch (err) {
    if (err instanceof DaemonError) return { t: 'error', id: -1, code: err.code, message: err.message }
    return { t: 'error', id: -1, code: 'bad-request', message: err instanceof Error ? err.message : String(err) }
  }
}

// ---------- asking the user ----------
// Every question goes through the in-app dialog (app/renderer/dialog.ts): main names the situation, the
// renderer shows it and answers. No OS message box anywhere.

let askSeq = 0
const pendingAsks = new Map<number, (answer: DialogAnswer) => void>()

/** Puts a situation to the user through the window; 'cancel' when there is no window to ask in. */
function ask(situation: MainSituation, message?: string): Promise<DialogAnswer> {
  if (!win || win.webContents.isDestroyed()) return Promise.resolve({ choice: 'cancel', remember: false })
  const askId = ++askSeq
  return new Promise(resolve => {
    pendingAsks.set(askId, resolve)
    const req: AskRequest = { askId, situation, slots: [...slotStates.values()], ...(message !== undefined ? { message } : {}) }
    win?.webContents.send('tether:ask', req)
  })
}
ipcMain.on('dialog:answer', (_e, askId: number, answer: DialogAnswer) => {
  pendingAsks.get(askId)?.(answer)
  pendingAsks.delete(askId)
})
ipcMain.on('window:close', () => win?.close())
/** The in-app menu (the native menu bar is hidden and Alt does not reach it from a terminal). */
ipcMain.on('tether:command', (_e, cmd: unknown) => {
  if (cmd === 'quit-all') void quitAll()
  else if (cmd === 'restore-confirmations') restoreConfirmations()
  else if (cmd === 'restart-daemon') void restartDaemon()
  else if (cmd === 'reload-all') void reloadAll()
  else if (cmd === 'relaunch-app') void relaunchApp()
  else if (cmd === 'toggle-devtools') win?.webContents.toggleDevTools()
  else if (cmd === 'toggle-fullscreen') win?.setFullScreen(!win.isFullScreen())
})

/**
 * "Reiniciar tudo": the daemon restarts with the code on disk; the app reconnects (close handler) and reloads the
 * renderer. It ends every agent first, so the person confirms it in the in-app dialog (which says how many run).
 */
async function reloadAll(): Promise<void> {
  if (!daemon) { void connectDaemon(); return }
  const { choice } = await ask('reload-all')
  if (choice !== 'reload') return
  if (!daemon) { void connectDaemon(); return }
  await request({ t: 'shutdown' })
}

let relaunching = false

/**
 * "Reiniciar o app": a fresh main process (new main.cjs) with the same executable, arguments and cwd; the daemon
 * and its agents are left alone. The next process is started from here, detached, after the single-instance
 * lock is released and before this one leaves, and it is told which pid it replaces (app/main/relaunch.ts says
 * why app.relaunch() is not used). A spawn failure keeps this instance up and says so in the in-app dialog.
 */
async function relaunchApp(): Promise<void> {
  if (relaunching) return
  relaunching = true
  const args = relaunchArgs(process.argv, process.pid)
  const cwd = process.cwd()
  appLog(`relaunch: starting ${process.execPath} ${args.map(a => JSON.stringify(a)).join(' ')} (cwd ${cwd})`)
  // From here on this process answers no second launch: an ack written now would make the next instance leave.
  app.removeListener('second-instance', bringToFront)
  app.releaseSingleInstanceLock()
  const failure = await new Promise<string | undefined>(resolve => {
    try {
      const child = spawn(process.execPath, args, { cwd, env: process.env, detached: true, stdio: 'ignore', windowsHide: true })
      child.once('spawn', () => { appLog(`relaunch: next instance is pid ${child.pid}; leaving`); child.unref(); resolve(undefined) })
      child.once('error', err => resolve(err.message))
    } catch (err) {
      resolve(err instanceof Error ? err.message : String(err))
    }
  })
  if (failure !== undefined) {
    appLog(`relaunch: failed to start the next instance: ${failure}`)
    if (!app.requestSingleInstanceLock()) appLog('relaunch: could not take the single-instance lock back')
    app.on('second-instance', bringToFront)
    relaunching = false
    void ask('relaunch-failed', `Não consegui iniciar o próximo processo do app (${failure}).`)
    return
  }
  // Going down for real: no reconnect attempt, and closing the window must not turn into "hide to the tray".
  quittingAll = true
  quitting = true
  tray?.destroy() // app.exit skips before-quit, where the tray is normally removed
  tray = undefined
  app.exit(0)
}

/** "Sair e encerrar tudo": stops every slot, shuts the daemon down and quits (after the in-app dialog). */
/**
 * "Sair" must end the process: app.quit() waits for windows and handlers, and the daemon round trips of "quit all"
 * can stall (many agents stopping one by one, a daemon that dies without answering). After `ms` the app leaves
 * regardless, taking its tray icon with it (app.exit skips before-quit, so the icon is destroyed here).
 */
function leaveWithin(ms: number): void {
  setTimeout(() => { tray?.destroy(); tray = undefined; app.exit(0) }, ms).unref()
}

async function quitAll(): Promise<void> {
  await openWindow() // from the tray there may be no window to ask in
  if (!win) return
  const { choice } = await ask('quit-all')
  if (choice === 'close-window') { win?.close(); return }
  if (choice !== 'quit') return
  quittingAll = true
  quitting = true
  leaveWithin(20_000)
  if (daemon) {
    const list = await request({ t: 'list' })
    if (list.t === 'ok') for (const s of list.slots ?? []) await request({ t: 'stop', slotId: s.slotId })
    await request({ t: 'shutdown' })
    daemon.close()
    daemon = undefined
  }
  app.quit()
}

// ---------- theme ----------

/** User settings (theme, terminal appearance, remembered dialog answers) in <TETHER_HOME>/settings.json; a missing or corrupt file means defaults. */
const settingsPath = join(home, 'settings.json')
type Settings = { theme?: unknown; terminal?: unknown; confirmations?: unknown; trayNoticeShown?: unknown; ui?: unknown; notes?: unknown }

// ---------- terminal appearance ----------
// The renderer owns the dialog and applies the change to every xterm; main keeps the file and echoes the
// normalized value so every window (and a relaunch) paints the same thing.

function readTerminalAppearance(): TerminalAppearance {
  return normalizeAppearance(readJson<Settings>(settingsPath, {}).terminal)
}

function setTerminalAppearance(value: unknown): void {
  const appearance = normalizeAppearance(value)
  const settings = readJson<Settings>(settingsPath, {})
  writeJson(settingsPath, { ...settings, terminal: appearance })
  win?.webContents.send('tether:terminal', appearance)
}

ipcMain.handle('terminal:get', (): TerminalAppearance => readTerminalAppearance())
ipcMain.on('terminal:set', (_e, value: unknown) => setTerminalAppearance(value))

/** Chrome preferences (`ui`): the renderer applies them, main keeps the file and echoes the normalized value. */
ipcMain.handle('ui:get', (): UiSettings => normalizeUi(readJson<Settings>(settingsPath, {}).ui))
ipcMain.on('ui:set', (_e, value: unknown) => {
  const ui = normalizeUi(value)
  writeJson(settingsPath, { ...readJson<Settings>(settingsPath, {}), ui })
  win?.webContents.send('tether:ui', ui)
})

/** Remembered answers per situation ("não perguntar de novo"); anything malformed reads as none. */
function readConfirmations(): Confirmations {
  const raw = readJson<Settings>(settingsPath, {}).confirmations
  if (!raw || typeof raw !== 'object') return {}
  const out: Confirmations = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'string') out[k] = v
  return out
}

function writeConfirmations(confirmations: Confirmations): void {
  const settings = readJson<Settings>(settingsPath, {})
  writeJson(settingsPath, { ...settings, confirmations })
  win?.webContents.send('tether:confirmations', confirmations)
}

ipcMain.handle('confirmations:get', (): Confirmations => readConfirmations())
ipcMain.on('confirmations:remember', (_e, situation: unknown, choice: unknown) => {
  if (typeof situation !== 'string' || typeof choice !== 'string') return
  writeConfirmations({ ...readConfirmations(), [situation]: choice })
})
/** Menu "Exibir → Voltar a perguntar": every dialog asks again. */
function restoreConfirmations(): void { writeConfirmations({}) }

function readThemeSetting(): ThemeSetting {
  return normalizeTheme(readJson<Settings>(settingsPath, {}).theme)
}

function themeState(): ThemeState {
  const setting: ThemeSetting = nativeTheme.themeSource === 'system' ? 'auto' : nativeTheme.themeSource
  return { setting, scheme: resolveScheme(setting, nativeTheme.shouldUseDarkColors) }
}

/** Pushes the painted scheme to the window (chrome background + renderer) and keeps the menu radios in sync. */
function applyTheme(): void {
  const state = themeState()
  win?.setBackgroundColor(WINDOW_BACKGROUND[state.scheme])
  win?.webContents.send('tether:theme', state)
  // Radio items do not follow a later `checked = …`; the menu is rebuilt with the current setting instead.
  if (app.isReady()) createMenu()
}

/** Electron resolves `auto` against the OS (`system`) and raises `updated` on every OS switch: live, no restart. */
function setTheme(setting: ThemeSetting): void {
  nativeTheme.themeSource = setting === 'auto' ? 'system' : setting
  const settings = readJson<Settings>(settingsPath, {})
  writeJson(settingsPath, { ...settings, theme: setting })
  applyTheme()
}

const initialTheme = readThemeSetting()
nativeTheme.themeSource = initialTheme === 'auto' ? 'system' : initialTheme
nativeTheme.on('updated', applyTheme)
ipcMain.handle('theme:get', (): ThemeState => themeState())
// Settings may change before any window exists (the standalone dialog): nothing to push then.
ipcMain.on('theme:set', (_e, setting: unknown) => setTheme(normalizeTheme(setting)))

// ---------- font size ----------

/** The size itself is appearance.fontSize ("Tema do terminal"): the renderer steps it and saves it through terminal:set. */

/** Menu items without accelerators: the shortcuts (Cmd+=/-/0, Ctrl+Shift+=/-/0) are handled by the renderer itself. */
function fontSizeMenu(): Electron.MenuItemConstructorOptions[] {
  const commands: FontSizeCommand[] = ['increase', 'decrease', 'reset']
  return commands.map(command => ({
    id: `font-size-${command}`,
    label: FONT_SIZE_LABEL[command],
    click: () => win?.webContents.send('tether:font-size', command),
  }))
}

function themeMenu(): Electron.MenuItemConstructorOptions {
  const current = themeState().setting
  return {
    label: 'Tema',
    submenu: THEME_SETTINGS.map(t => ({
      id: `theme-${t}`,
      label: THEME_LABEL[t],
      type: 'radio' as const,
      checked: t === current,
      click: () => setTheme(t),
    })),
  }
}

// ---------- window ----------

/** Resolves once the current window's page has loaded (its script has registered the IPC listeners). */
let windowLoaded: Promise<void> = Promise.resolve()

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'tether',
    icon: join(__dirname, 'tether.ico'),
    backgroundColor: WINDOW_BACKGROUND[themeState().scheme],
    show: !hidden,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A window that is never shown does not paint, and Playwright's screenshot would wait forever;
      // offscreen rendering keeps producing frames without any window on the user's screen.
      ...(hidden ? { offscreen: true, backgroundThrottling: false } : {}),
    },
  })
  if (hidden) win.webContents.setFrameRate(30)
  const created = win
  created.on('close', e => {
    if (quitting || !tray) return
    e.preventDefault()
    void hideToTray()
  })
  created.on('closed', () => {
    if (win === created) win = undefined
    // Nobody will answer the dialogs asked of a window that is gone.
    for (const resolve of pendingAsks.values()) resolve({ choice: 'cancel', remember: false })
    pendingAsks.clear()
  })
  windowLoaded = new Promise(resolve => {
    created.webContents.once('did-finish-load', () => {
      // A window recreated from the tray finds the daemon already connected: it only needs to be told.
      if (daemon) sendConnection(connectionState())
      else void connectDaemon()
      resolve()
    })
  })
  void created.loadFile(join(__dirname, '..', 'renderer', 'index.html'))
}

// ---------- tray ----------

/** Bumped by every open: a hide waiting to destroy the window gives up when the user opened it again meanwhile. */
let openEpoch = 0
let hiding = false
/** Longest renderer debounce (layout save) plus the IPC hop: the window is destroyed only after it. */
const LAYOUT_FLUSH_MS = 500

/**
 * Closing the window = hiding the app to the tray. The BrowserWindow is destroyed (not just hidden) so the
 * renderer's memory (xterm buffers, WebGL contexts) is freed; opening creates a new one, which restores from
 * layout.json and re-attaches to the daemon exactly like a fresh launch. The first time, an in-app notice says
 * where the app went.
 */
async function hideToTray(): Promise<void> {
  if (hiding || !win) return
  hiding = true
  try {
    const settings = readJson<Settings>(settingsPath, {})
    if (settings.trayNoticeShown !== true) {
      writeJson(settingsPath, { ...settings, trayNoticeShown: true })
      await ask('tray-first-close')
    }
    const closing = win
    if (!closing || closing.isDestroyed()) return
    const epoch = ++openEpoch
    closing.hide()
    // The renderer saves the layout 300 ms after the last change; destroying now would lose it.
    await sleep(LAYOUT_FLUSH_MS)
    if (epoch !== openEpoch || closing.isDestroyed()) return
    // Stop the daemon streaming terminal output to a renderer that is gone (a new window attaches again).
    for (const slotId of slotStates.keys()) void request({ t: 'detach', slotId })
    closing.destroy()
  } finally {
    hiding = false
  }
}

/**
 * Shows the window, creating it when the app is in the tray; `focusSlot` asks the renderer to focus that pane,
 * `drawer` to open the drawer (the renderer waits for its layout to be restored first).
 */
async function openWindow(focusSlot?: string, drawer = false): Promise<void> {
  openEpoch++
  if (!win) createWindow()
  else showWindow()
  await windowLoaded
  if (focusSlot) win?.webContents.send('tether:focus-slot', focusSlot)
  if (drawer) win?.webContents.send('tether:open-drawer')
}

function showWindow(): void {
  if (!win || hidden) return // E2E windows are offscreen: they exist, they are never put on the user's screen
  if (win.isMinimized()) win.restore()
  win.show()
  app.focus({ steal: true }) // Windows refuses plain focus from a process that is not in front
  win.focus()
}

/** Tray left click. */
function toggleWindow(): void {
  if (win && (hidden || win.isVisible()) && !win.isMinimized()) void hideToTray()
  else void openWindow()
}

/** "Reiniciar serviço": graceful `shutdown` through the pipe, then a new tetherd; panels come back through the renderer's reconnect path. */
async function restartDaemon(): Promise<void> {
  if (restartingDaemon) return
  await openWindow()
  const { choice } = await ask('restart-daemon')
  if (choice !== 'restart') return
  restartingDaemon = true
  try {
    const old = daemon
    if (old) {
      await request({ t: 'shutdown' })
      daemon = undefined
      old.close()
    }
    slotStates.clear()
    updateTray()
    sendConnection({ connected: false, pipe, error: 'reiniciando o tetherd…' })
    // The old daemon answers until its server is closed: wait for the pipe to go quiet before spawning.
    const deadline = Date.now() + DAEMON_START_TIMEOUT_MS
    while (Date.now() < deadline) {
      try { (await DaemonClient.open(pipe, 'app')).close() } catch { break }
      await sleep(200)
    }
    await connectDaemon()
  } finally {
    restartingDaemon = false
  }
}

/** "Sair (manter agentes)": only the app goes; tetherd and every slot keep running. */
function quitKeepingAgents(): void {
  quitting = true
  leaveWithin(5_000)
  daemon?.close()
  daemon = undefined
  app.quit()
}

function trayCommand(id: TrayCommand): void {
  switch (id) {
    case 'open': void openWindow(); break
    case 'open-drawer': void openWindow(undefined, true); break
    case 'restart-daemon': void restartDaemon(); break
    case 'quit-keep': quitKeepingAgents(); break
    case 'quit-all': void quitAll(); break
  }
}

function setupTray(): void {
  if (!trayWanted(process.env)) return // tests: no icon in the user's tray (closing the window quits the app)
  try {
    tray = createTray(__dirname, { toggle: toggleWindow, command: trayCommand, pane: slotId => { void openWindow(slotId) } })
    updateTray()
  } catch (err) {
    tray = undefined // no tray: closing the window quits the app, as before
    console.error(`tether: sem ícone de bandeja (${err instanceof Error ? err.message : String(err)})`)
  }
}

/** E2E hooks (the menu itself is native and cannot be clicked by Playwright): the same functions the menu items call. */
Object.defineProperty(globalThis, '__tetherTray', {
  value: {
    windowOpen: () => !!win && !win.isDestroyed(),
    model: () => (tray ? tray.model() : trayModel([])),
    hasTray: () => !!tray,
    open: (slotId?: string) => openWindow(slotId),
    toggle: () => toggleWindow(),
    command: (id: TrayCommand) => trayCommand(id),
  },
})

function createMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Arquivo',
      submenu: [
        { label: 'Fechar a janela (os terminais continuam no tetherd)', accelerator: 'CmdOrCtrl+Shift+W', click: () => win?.close() },
        { id: 'quit-all', label: 'Sair e encerrar tudo…', accelerator: 'CmdOrCtrl+Shift+Q', click: () => { void quitAll() } },
      ],
    },
    {
      label: 'Exibir',
      submenu: [
        themeMenu(),
        ...fontSizeMenu(),
        { type: 'separator' },
        { id: 'terminal-theme', label: 'Tema do terminal…', click: () => win?.webContents.send('tether:open-terminal-theme') },
        { id: 'profiles', label: 'Perfis de lançamento…', click: () => win?.webContents.send('tether:open-profiles') },
        { id: 'restore-confirmations', label: 'Voltar a perguntar antes de fechar painéis', click: restoreConfirmations },
        { type: 'separator' },
        // No accelerator on purpose: it ends every agent, and a key chord next to "reload page" invites accidents.
        { id: 'reload-all', label: 'Reiniciar tudo… (app e tetherd; encerra os agentes e retoma as sessões)', click: () => { void reloadAll() } },
        { id: 'relaunch-app', label: 'Reiniciar o app (os agentes continuam rodando)', click: relaunchApp },
        { type: 'separator' },
        { role: 'toggleDevTools', label: 'Ferramentas de desenvolvedor' },
        { role: 'togglefullscreen', label: 'Tela cheia' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------- IPC ----------

ipcMain.handle('tether:request', (_e, body: RequestBody) => request(body))
ipcMain.on('tether:notice', (_e, notice: Notice) => daemon?.input(notice.slotId, notice.data))
ipcMain.on('tether:reconnect', () => { void connectDaemon() })
ipcMain.handle('tether:connection', (): ConnectionState => connectionState())

// layout.json keeps its previous content in layout.json.bak on every save and falls back to it (layout-file.ts).
ipcMain.handle('layout:load', () => loadLayoutFile(layoutPath))
ipcMain.handle('layout:save', (_e, layout: unknown) => { saveLayoutFile(layoutPath, layout) })
// The renderer asks for this when it reads a v1 file: layout.json.bak rotates on every save, layout.v1.bak keeps the
// last v1 content for good (a copy: layout.json itself is not touched until the person changes something).
ipcMain.handle('layout:backup', () => { if (existsSync(layoutPath)) copyFileSync(layoutPath, join(home, 'layout.v1.bak')) })

/** Recent folders in canonical form, deduped case-insensitively (entries saved before the fix may differ only in casing). */
function recentFolders(): string[] {
  const out: string[] = []
  for (const f of readJson<string[]>(recentPath, [])) {
    const dir = canonicalDir(f)
    if (!out.some(o => o.toLowerCase() === dir.toLowerCase())) out.push(dir)
  }
  return out
}
ipcMain.handle('recent:list', () => recentFolders())
ipcMain.handle('recent:remember', (_e, folder: string) => {
  const dir = canonicalDir(folder)
  const list = recentFolders().filter(f => f.toLowerCase() !== dir.toLowerCase())
  list.unshift(dir)
  writeJson(recentPath, list.slice(0, RECENT_LIMIT))
})

ipcMain.handle('folder:pick', async (_e, initial?: string) => {
  if (!win) return null
  const r = await dialog.showOpenDialog(win, {
    title: 'Escolher pasta',
    properties: ['openDirectory'],
    ...(initial ? { defaultPath: initial } : {}),
  })
  const picked = r.filePaths[0]
  return r.canceled || !picked ? null : canonicalDir(picked)
})

// ---------- profiles ----------
// Through the daemon when connected (one validator, every client told); straight from <home>/profiles.json otherwise.

ipcMain.handle('profiles:list', async (): Promise<ProfilesList> => {
  if (daemon) {
    const r = await request({ t: 'profiles-list' })
    if (r.t === 'ok') return { profiles: r.profiles ?? [], ...(r.problem ? { problem: r.problem } : {}) }
  }
  const read = readProfiles(home)
  return { profiles: read.profiles, ...(read.problem ? { problem: read.problem } : {}) }
})

ipcMain.handle('profiles:save', async (_e, profile: ProfileInput): Promise<ProfileSaved> => {
  if (daemon) {
    const r = await request({ t: 'profile-save', profile })
    return r.t === 'ok' ? { ok: true, profile: r.profile!, warnings: r.warnings ?? [] } : { ok: false, message: r.message }
  }
  try {
    const r = upsertProfile(readProfiles(home).profiles, profile)
    writeProfiles(home, r.profiles)
    return { ok: true, profile: r.profile, warnings: r.warnings }
  } catch (e) {
    return { ok: false, message: e instanceof ProfileError || e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('profiles:delete', async (_e, profileId: string): Promise<ProfileDeleted> => {
  if (daemon) {
    const r = await request({ t: 'profile-delete', profileId })
    return r.t === 'ok' ? { ok: true } : { ok: false, message: r.message }
  }
  try {
    writeProfiles(home, removeProfile(readProfiles(home).profiles, profileId))
    return { ok: true }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.on('shell:open-external', (_e, url: string) => {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
})
// Opens a folder in Explorer: only an existing directory (a file would be launched by its handler, which is
// running something). The path is never interpreted: shell.openPath gets it as is and nothing else is spawned.
ipcMain.handle('shell:open-path', async (_e, path: unknown): Promise<{ ok: true } | { ok: false; message: string }> => {
  if (typeof path !== 'string' || path.trim() === '') return { ok: false, message: 'Caminho inválido.' }
  let isDir = false
  try { isDir = statSync(path).isDirectory() } catch { return { ok: false, message: 'A pasta não existe.' } }
  if (!isDir) return { ok: false, message: 'O caminho não é uma pasta.' }
  const err = await shell.openPath(path)
  return err ? { ok: false, message: err } : { ok: true }
})
ipcMain.handle('clipboard:read', () => clipboard.readText())
ipcMain.on('clipboard:write', (_e, text: string) => clipboard.writeText(text))

// ---------- notes ----------
// The files of the note tabs (app/main/note-files.ts). The renderer owns the editor and the debounce; main owns
// the disk: atomic writes, the folder watcher, the two OS file dialogs, and the repositories whose
// ".gitignore" question was declined (settings.json `notes.gitignoreDeclined`).

const noteWatchers = new NoteWatchers(path => win?.webContents.send('tether:note-changed', path))

function gitignoreDeclined(): string[] {
  const raw = readJson<Settings>(settingsPath, {}).notes
  const list = raw && typeof raw === 'object' ? (raw as { gitignoreDeclined?: unknown }).gitignoreDeclined : undefined
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
}

const isPath = (p: unknown): p is string => typeof p === 'string' && p.trim() !== ''

ipcMain.handle('note:prepare', (_e, paneCwd: unknown): NotePrepared => {
  const cwd = isPath(paneCwd) ? canonicalDir(paneCwd) : undefined
  return prepareNote(cwd, { declined: gitignoreDeclined() })
})
ipcMain.handle('note:read', (_e, path: unknown): NoteRead => isPath(path) ? readNote(path) : { ok: false, missing: false, message: 'Caminho inválido.' })
ipcMain.handle('note:write', (_e, path: unknown, text: unknown): NoteWritten => isPath(path) && typeof text === 'string' ? writeNote(path, text) : { ok: false, message: 'Caminho inválido.' })
ipcMain.on('note:flush', (_e, path: unknown, text: unknown) => { if (isPath(path) && typeof text === 'string') writeNote(path, text) })
ipcMain.handle('note:rename', (_e, from: unknown, to: unknown): NoteRenamed => {
  if (!isPath(from) || !isPath(to)) return { ok: false, message: 'Caminho inválido.' }
  // The watches follow in the renderer (the note's `setPath`, a preview's retarget): each holder moves its own.
  return renameNote(from, to)
})
ipcMain.on('note:watch', (_e, path: unknown) => { if (isPath(path)) noteWatchers.watch(path) })
ipcMain.on('note:unwatch', (_e, path: unknown) => { if (isPath(path)) noteWatchers.unwatch(path) })
ipcMain.handle('note:pick-open', async (_e, initialDir: unknown): Promise<string | null> => {
  if (!win) return null
  const r = await dialog.showOpenDialog(win, {
    title: 'Abrir nota',
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }, { name: 'Todos os arquivos', extensions: ['*'] }],
    ...(isPath(initialDir) ? { defaultPath: initialDir } : {}),
  })
  const picked = r.filePaths[0]
  return r.canceled || !picked ? null : picked
})
ipcMain.handle('note:pick-save-as', async (_e, currentPath: unknown): Promise<string | null> => {
  if (!win) return null
  const r = await dialog.showSaveDialog(win, {
    title: 'Salvar nota como',
    filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Todos os arquivos', extensions: ['*'] }],
    ...(isPath(currentPath) ? { defaultPath: currentPath } : { defaultPath: join(notesDirFor(undefined), `nota${NOTE_EXTENSION}`) }),
  })
  return r.canceled || !r.filePath ? null : r.filePath
})
ipcMain.handle('note:gitignore', (_e, repoRoot: unknown, add: unknown) => {
  if (!isPath(repoRoot)) return
  if (add === true) { addTetherToGitignore(repoRoot); return }
  const settings = readJson<Settings>(settingsPath, {})
  const declined = gitignoreDeclined()
  if (!declined.includes(repoRoot)) writeJson(settingsPath, { ...settings, notes: { gitignoreDeclined: [...declined, repoRoot] } })
})

// ---------- quick open ----------
// Ctrl+P's file list and search (app/main/quick-open-main.ts), in a worker thread next to main.cjs.
const quickOpen = registerQuickOpen(ipcMain, shell, __dirname)
app.on('will-quit', () => quickOpen.dispose())
// Ctrl+click on a path in a terminal: is the candidate a file or folder? (app/main/terminal-links-main.ts)
registerTerminalLinks(ipcMain)

// ---------- single instance ----------

/** Written by the running instance whenever a second launch pokes it: proof that a live window took over. */
const ackPath = join(app.getPath('userData'), 'second-instance.json')
/**
 * How long to keep asking for the lock. A dying instance's helpers (GPU, renderer, network) keep Chromium's
 * lockfile open for up to ~9 s after the main process died; each refused request already blocks ~5 s inside
 * Chromium (process_singleton_win.cc), so this gives three requests, ~15 s in all.
 */
const LOCK_RETRY_MS = 12_000
const LOCK_RETRY_STEP_MS = 250
const startedAt = Date.now()
/** How many tries the lock took (E2E reads it: it tells a retried launch from a lucky one). */
let lockAttempts = 0
Object.defineProperty(globalThis, '__tetherLockAttempts', { get: () => lockAttempts })

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** True when a live instance answered our launch: an ack newer than this process, not from the one it replaces. */
function ackedByLiveInstance(): boolean {
  return ackFromLiveInstance(readJson<{ at?: unknown; pid?: unknown }>(ackPath, {}), startedAt, replacedPid)
}

/**
 * One window per TETHER_HOME. Chromium's lock is a file in userData that the helpers of a dying instance
 * (window crashed or killed) keep open for several seconds after the main process is gone: a launch in
 * that window gets the lock refused with nobody alive to focus, so it would quit silently. The lock is
 * retried for a while; a refusal with a live window on the other side is told apart by that window's ack.
 */
async function acquireSingleInstance(): Promise<'acquired' | 'focused-other' | 'stale'> {
  const deadline = Date.now() + LOCK_RETRY_MS
  for (let attempt = 1; ; attempt++) {
    if (app.requestSingleInstanceLock()) {
      lockAttempts = attempt
      appLog(`lock: acquired at attempt ${attempt} (${Date.now() - startedAt} ms)`)
      return 'acquired'
    }
    if (attempt === 1) appLog(`lock: busy (refused after ${Date.now() - startedAt} ms); retrying for ${LOCK_RETRY_MS / 1000} s`)
    await sleep(LOCK_RETRY_STEP_MS)
    if (ackedByLiveInstance()) {
      const ack = readJson<{ pid?: unknown }>(ackPath, {})
      appLog(`lock: a live instance (pid ${String(ack.pid)}) answered this launch; leaving it the window`)
      return 'focused-other'
    }
    if (Date.now() >= deadline) { appLog(`lock: still busy after ${LOCK_RETRY_MS / 1000} s and nobody answered`); return 'stale' }
  }
}

function bringToFront(): void {
  appLog('second launch poked this instance; bringing the window up')
  writeJson(ackPath, { at: Date.now(), pid: process.pid })
  if (!app.isReady()) return
  void openWindow() // creates the window when the app is hidden in the tray
}

// ---------- standalone dialog window ----------
// For a situation that happens before the main window exists: a small frameless window with the same
// dialog component (app/renderer/dialog.html + dialog-window.ts). The renderer asks which situation to
// show and sends the answer back.

let standaloneSituation: string | null = null
ipcMain.handle('dialog:standalone', () => standaloneSituation)

/**
 * Resolves with the answer and a `close` for the window: it stays open until the caller has another window
 * (closing the only window raises `window-all-closed`, which quits the app).
 */
function showStandaloneDialog(situation: string): Promise<{ answer: DialogAnswer; close(): void }> {
  standaloneSituation = situation
  const dlg = new BrowserWindow({
    width: 520,
    height: 360,
    useContentSize: true,
    title: 'tether',
    icon: join(__dirname, 'tether.ico'),
    backgroundColor: WINDOW_BACKGROUND[themeState().scheme],
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...(hidden ? { offscreen: true, backgroundThrottling: false } : {}),
    },
  })
  if (hidden) dlg.webContents.setFrameRate(30)
  dlg.setMenuBarVisibility(false)
  const onTheme = (): void => { if (!dlg.isDestroyed()) dlg.webContents.send('tether:theme', themeState()) }
  nativeTheme.on('updated', onTheme)
  return new Promise(resolve => {
    let done = false
    const close = (): void => { if (!dlg.isDestroyed()) dlg.close() }
    const finish = (answer: DialogAnswer): void => {
      if (done) return
      done = true
      nativeTheme.removeListener('updated', onTheme)
      ipcMain.removeListener('dialog:standalone-answer', onAnswer)
      resolve({ answer, close })
    }
    const onAnswer = (_e: Electron.IpcMainEvent, answer: DialogAnswer): void => finish(answer)
    ipcMain.on('dialog:standalone-answer', onAnswer)
    // The page reports the height its dialog needs once it is laid out; the window takes it and shows up.
    const onSize = (_e: Electron.IpcMainEvent, height: unknown): void => {
      if (dlg.isDestroyed()) return
      if (typeof height === 'number' && height > 0) dlg.setContentSize(520, Math.min(Math.ceil(height), 700))
      if (!hidden) { dlg.center(); dlg.show() }
    }
    ipcMain.once('dialog:standalone-size', onSize)
    dlg.on('closed', () => { ipcMain.removeListener('dialog:standalone-size', onSize); finish({ choice: 'cancel', remember: false }) })
    void dlg.loadFile(join(__dirname, '..', 'renderer', 'dialog.html'))
  })
}

async function start(): Promise<void> {
  let outcome = await acquireSingleInstance()
  let closeStandalone: (() => void) | undefined
  while (outcome === 'stale') {
    // The previous instance is still releasing the lock and nobody is alive to focus: say so in the app's
    // own dialog (stderr too, for a launch from a terminal) and let the user retry or leave.
    const message = 'o tether ainda está fechando; tente de novo em alguns segundos'
    appLog(`${message} (lock de instância única ocupado por ${LOCK_RETRY_MS / 1000} s em ${app.getPath('userData')})`)
    await app.whenReady()
    closeStandalone?.()
    const { answer, close } = await showStandaloneDialog('still-closing')
    closeStandalone = close
    if (answer.choice !== 'retry') { app.quit(); return }
    outcome = await acquireSingleInstance()
  }
  if (outcome === 'focused-other') { app.quit(); return }
  app.on('second-instance', bringToFront)
  await app.whenReady()
  if (process.platform === 'darwin') app.dock?.setIcon(join(__dirname, 'tether.png'))
  createMenu()
  createWindow()
  setupTray()
  closeStandalone?.() // only now: with the main window up, closing it does not quit the app
  // The window of a relaunch must be the one in front, as the one it replaces was: a process started by another
  // process does not always get the foreground on Windows, so it is asked for explicitly once the page is up.
  if (replacedPid !== undefined) {
    await windowLoaded
    showWindow()
    const w = win
    appLog(`window: ${w ? `visible=${w.isVisible()} focused=${w.isFocused()} minimized=${w.isMinimized()}` : 'none'}${hidden ? ' (hidden mode: never shown)' : ''}`)
  }
}

void start()

app.on('before-quit', () => { quitting = true; tray?.destroy(); tray = undefined })

// With the tray the app outlives its window (the daemon keeps the PTYs either way); without one, closing the
// window ends the app as it always did.
app.on('window-all-closed', () => {
  if (tray) return
  daemon?.close()
  daemon = undefined
  app.quit()
})
