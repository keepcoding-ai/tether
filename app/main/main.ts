// Electron main process: one window, one connection to tetherd (spawned detached when nothing answers on
// the pipe), a narrow IPC surface for the renderer (see app/shared/api.ts). Layout and recent folders live
// under TETHER_HOME. Closing the window hides the app to the system tray (the window is destroyed, so the
// renderer's memory is freed; the process stays, still connected to the daemon, to feed the tray). The daemon
// keeps every slot running whatever the app does.
// Built by app/build.mjs into app/dist/main.cjs (CommonJS: __dirname is available).
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, Notification, screen, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { Executor } from '../../src/exec/executor.ts'
import type { OpTable } from '../../src/exec/table.ts'
import { setMainExecutor } from './main-executor.ts'
import { setAgentExecutor } from '../../src/agents/agent-exec.ts'
import { loadLayoutFile, saveLayoutFile } from './layout-file.ts'
import { createAppLog } from './app-log.ts'
import { startCrashReports } from './crash-report.ts'
import { handOffToCookieRuntime } from './cookie-runtime-main.ts'
import { ackFromLiveInstance, relaunchArgs, relaunchedFrom } from './relaunch.ts'
import { userInfo } from 'node:os'
import { delimiter, join } from 'node:path'
import { DaemonClient, DaemonError, NotTetherError, type SpawnOptions } from '../../src/daemon/client.ts'
import { pipePath, PROTOCOL_VERSION } from '../../src/daemon/protocol.ts'
import type { Notice, Reply, SlotState } from '../../src/daemon/protocol.ts'
import { tetherHome, userDir } from '../../src/core/paths.ts'
import { canonicalDir } from '../../src/core/paths-sync.ts'
import { ProfileError, removeProfile, upsertProfile } from '../../src/core/profile.ts'
import { readProfiles, writeProfiles } from '../../src/core/profile-sync.ts'
import '../../src/agents/load-sync.ts'
import type { ProfileInput } from '../../src/core/profile.ts'
import type { ConnectionState, ProfileDeleted, ProfileSaved, ProfilesList, RequestBody, SettingsFileState, SettingsList, SettingWriteResult } from '../shared/api.ts'
import { NoteWatchers, writeTextAtomic } from './note-files.ts'
import { applyThrottleSwitches, throttlingWanted } from './throttle.ts'
import { migrateUserFiles, SettingsStore } from './settings-store.ts'
import { registerFileOpen } from './file-open-main.ts'
import { registerTerminalLinks } from './terminal-links-main.ts'
import { KEYBINDINGS_FILE, type KeybindingsFileState } from '../shared/keybindings.ts'
import type { AskRequest, Confirmations, DialogAnswer, MainSituation } from '../shared/dialog.ts'
import { normalizeWindowState, resolveWindowState, type WindowState } from '../shared/window-state.ts'
import { startPriorityKeeper } from './priority.ts'
import { normalizeUi, type UiSettings } from '../shared/ui-settings.ts'
import { isValidSetting, readExtensionsSettings, settingPath, valueAt, writeExtensionsSettings } from '../shared/vscode-configuration-registry.ts'
import { EXTENSION_STATE_KEY } from '../shared/ext-migrations.ts'
import { CORE_SETTINGS } from '../shared/core-settings.ts'
import { extensions as mainExtensions } from '../../extensions/index.main.ts'
import { DoorObjects } from './door-objects.ts'
import { MainExtensionHost, type MainHostDeps } from './ext-host.ts'
import { SurfaceManager } from './surfaces.ts'
import { SurfaceBridge } from './surface-bridge.ts'
import { AgentTracker } from './agents.ts'
import { FONT_SIZE_LABEL, type FontSizeCommand } from '../shared/font.ts'
import { slotLabel, trayModel, trayWanted } from '../shared/tray.ts'
import { AttentionHistory, isMuted, isMuteChoice, muteUntil, normalizeOsNotify, OS_NOTIFY_COALESCE_MS, OsNotifyRules, toastFor, type AttentionState, type PendingToast } from '../shared/os-notify.ts'
import type { TrayCommand } from '../shared/tray.ts'
import { createTray, type TrayController } from './tray.ts'
import { TrayNotices } from './tray-notices.ts'
import { normalizeAppearance, type TerminalAppearance } from '../shared/terminal-theme.ts'
import { normalizeTheme, resolveScheme, THEME_LABEL, THEME_SETTINGS, WINDOW_BACKGROUND } from '../shared/theme.ts'
import type { ThemeSetting, ThemeState } from '../shared/theme.ts'
import { BRAND } from '../shared/brand.ts'
import { perfEchoData, perfEchoKey, recordProbe, registerPerf, stopPerf } from './perf-main.ts'
import { PanelLink } from './panel-link.ts'
import { PanelRouter } from './panel-route.ts'
import { ptydPipePath } from '../../src/ptyd/paths.ts'
import { extendProbe, parseProbe } from '../../src/core/perf-probe.ts'
import { isProbeResultNotice, probeEnabled } from '../shared/probe-app.ts'

// Key->echo probe (TETHER_PROBE=1): off by default; every use below sits behind this flag.
const probe = probeEnabled(process.env)
import { TETHER_SCHEME, tetherUrlInArgv } from '../shared/tether-url.ts'
import type { LinkAssociation } from '../shared/api.ts'
import { type Association, commandLineFor, describeCommand, readAssociatedCommand, removeAssociation, sameCommand } from './protocol-association.ts'

const home = tetherHome()
const pipe = pipePath(home, userInfo().username)
/** Taskbar grouping / pinning: the same id goes on the Start Menu shortcut (app/shortcut.ps1) and, on macOS, is the CFBundleIdentifier of Tether.app (app/install.mjs). */
const APP_USER_MODEL_ID = BRAND.appId
// Electron's own state (cache, GPU, the single-instance lock) lives under TETHER_HOME too: E2E runs with a
// private home never collide with the user's running app.
app.setPath('userData', join(home, 'electron'))
app.setAppUserModelId(APP_USER_MODEL_ID)
// The process runs from node_modules' Electron.app (Tether.app only wraps it: a launcher cannot change what
// the OS attributes the process to), so the name and the Dock icon are set here, not read from a bundle.
app.setName(BRAND.name)
const layoutPath = join(home, 'layout.json')
const recentPath = join(home, 'recent-folders.json')
const RECENT_LIMIT = 12
/** Max wait for a freshly spawned tetherd to answer on the pipe. */
const DAEMON_START_TIMEOUT_MS = 15_000
/** E2E runs set this so the test windows never show up on the user's screen. */
const hidden = process.env.TETHER_E2E_HIDDEN === '1'
/** E2E only: the device scale of the offscreen window (default 1), to render the app at a display's scale (e.g. 1.25 = 125 %). */
const hiddenScale = Number(process.env.TETHER_E2E_SCALE) > 0 ? Number(process.env.TETHER_E2E_SCALE) : 1
/** The daemon's entry point, relative to app/dist (this bundle) → repo root. */
const daemonMain = join(__dirname, '..', '..', 'src', 'daemon', 'main.ts')
/** The pid this process replaces when "Reiniciar o app" started it (app/main/relaunch.ts). */
const replacedPid = relaunchedFrom(process.argv)
/** What this launch decides, on disk (<home>/tether-app.log) and on stderr: a Start Menu launch has no console. */
/**
 * The executor of this process: log, layout, settings and notes reach the disk through its worker (app/dist/exec-worker.cjs, its own
 * bundle entry: the path is passed because import.meta.url is empty in this CJS bundle). TETHER_EXECUTOR=inline falls back to the
 * same table in this loop (app/dist/exec-table.cjs, loaded by file URL).
 */
const mainExec = new Executor({
  workerPath: join(__dirname, 'exec-worker.cjs'),
  tableUrl: pathToFileURL(join(__dirname, 'exec-table.cjs')).href,
  log: msg => console.error(`tether: ${msg}`),
})
setMainExecutor(mainExec)
// The adapters and spawnDetachedNode (tetherd, procd, ptyd) run their ops through agentExecutor(): without this they fall back to an
// inline executor with no tableUrl, which cannot load its table in this CJS bundle and never answers (the app hung on "reiniciando o tetherd…").
setAgentExecutor(mainExec)
const appLog = createAppLog(join(home, 'tether-app.log'), mainExec, {
  // The fatal-exit writer only: loaded when needed, synchronously (the table bundle is CJS).
  emergency: (path, text) => (require(join(__dirname, 'exec-table.cjs')) as { table: OpTable }).table.appendText(path, text),
})
process.on('exit', () => appLog.emergencySync())
appLog(`executor: ${mainExec.mode}`)
appLog(`start: ppid ${process.ppid}, exec ${process.execPath}, cwd ${process.cwd()}, args ${JSON.stringify(process.argv.slice(1))}${replacedPid ? `, replaces pid ${replacedPid} (Reiniciar o app)` : ''}`)
// The Start Menu launch prefers the runtime copy with the cookie fuse on (app/shared/cookie-runtime.ts): handed over, this
// process leaves before taking the single-instance lock or touching any state.
startCrashReports(home, 'tether', appLog)
if (handOffToCookieRuntime({ home, argv: process.argv, execPath: process.execPath, electronVersion: process.versions.electron, log: appLog })) process.exit(0) // the 'exit' hook above writes what the log still holds

let daemon: DaemonClient | undefined
let connecting: Promise<void> | undefined
let win: BrowserWindow | undefined
let quittingAll = false
/** Set when the daemon connection was lost: the next connection reloads the renderer so every panel restarts its slot. */
let reloadOnReconnect = false
/** After a lost connection: a failed reconnect schedules another attempt (growing delay, capped) until one connects. */
let recovering = false
let recoverDelay = 500
let recoverTimer: NodeJS.Timeout | undefined
const RECOVER_MAX_MS = 5000
/** The app is going away for real (menu, tray, OS): closing the window must not be turned into "hide". */
let quitting = false
/** The daemon is being restarted from the tray: its connection closing is expected, not a crash. */
let restartingDaemon = false
let tray: TrayController | undefined
/** What the tray shows: the daemon's slots, kept up to date from the list at connect time and the state events. */
const slotStates = new Map<string, SlotState>()
// System toasts for attention while tether is not in front (app/shared/os-notify.ts holds the rules).
const osNotifyRules = new OsNotifyRules()
let osNotifyBatch: PendingToast[] = []
let osNotifyTimer: ReturnType<typeof setTimeout> | undefined
/** Live toasts: a Notification collected by the GC loses its click handler. */
const liveToasts = new Set<Notification>()
/** The bell's recent notices (fed by the same transitions as the toasts) and its temporary mute (never written to settings). */
const attentionHistory = new AttentionHistory()
let mutedUntil: number | undefined
let muteTimer: ReturnType<typeof setTimeout> | undefined
/** The agents extensions see (TetherMain.agents), fed by the same daemon events. */
const agentTracker = new AgentTracker()
/** The extensions' notices the tray shows next to the terminals' attention (TetherMain.notices). */
const trayNotices = new TrayNotices(() => updateTray())
/**
 * Hosted panes (SlotState.ptyHost) talk to the panel host (tether-ptyd) straight: output, scrollback and keystrokes go
 * through this link, never launching the host (tetherd does). The router picks the way per slot (app/main/panel-route.ts).
 * With TETHER_PROBE=1 the direct way carries no daemon-* stamps: the keystroke never crosses tetherd.
 */
const panelLink: PanelLink = new PanelLink({
  pipe: ptydPipePath(pipe, home),
  onData: (slotId, data) => panelRouter.onLinkData(slotId, data),
  onReset: (slotId, scrollback) => { appLog(`panel host: ${slotId} repainted from the host ring`); panelRouter.onLinkReset(slotId, scrollback) },
  onLost: (slotId, reason) => appLog(`panel host: re-attach of ${slotId} refused (${reason}); retried on the next reconnect`),
  onState: connected => panelRouter.onLinkState(connected),
})
const panelRouter: PanelRouter = new PanelRouter({
  link: panelLink,
  daemon: () => daemon,
  request: body => request(body),
  emit: (slotId, data) => { perfEchoData(slotId); win?.webContents.send('tether:event', { t: 'data', slotId, data }) },
  log: msg => appLog(msg),
  hiddenPanes: () => (settings() as { performance?: { hiddenPanes?: unknown } }).performance?.hiddenPanes !== false,
})

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return fallback }
}

/** Atomic (temp + rename, in the executor's worker), so a crash mid-write never leaves a half file behind. A failure is logged, never thrown. */
async function writeJson(path: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value, null, 2)
  try { await mainExec.run('mkdirp', [home]); await mainExec.run('writeTextAtomic', [path, text]) } catch (err) { appLog(`write of ${path} failed: ${err instanceof Error ? err.message : String(err)}`) }
}

/** The same, read through the executor: for the handlers that run with a window open. readJson stays for boot and the lock loop (sync on purpose). */
async function readJsonAsync<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await mainExec.run('readText', [path])) as T } catch { return fallback }
}

/** Waits (at most ms) for the log, the settings file and every executor request in flight: before the process leaves. */
async function drainDisk(ms = 2000): Promise<void> {
  const settled = Promise.allSettled([appLog.flush(), settingsStore.flush(), mainExec.drain()])
  await Promise.race([settled, sleep(ms)])
}
/** app.exit skips before-quit and will-quit: the disk work still in flight is drained first (bounded). */
function exitApp(): void { void drainDisk().finally(() => app.exit(0)) }

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
    return checkVersion(await DaemonClient.open(pipe, 'app', { direct: true }))
  } catch (e) {
    if (e instanceof DaemonError) throw e // it answered: spawning another one would not fix a wrong version
    if (e instanceof NotTetherError) throw new Error(`o canal ${pipe} está ocupado por um programa que não é o tetherd (${e.message})`)
  }
  return checkVersion(await DaemonClient.connect({ ...daemonSpawnOptions(), client: 'app', direct: true, startTimeoutMs: DAEMON_START_TIMEOUT_MS }))
}

function connectDaemon(): Promise<void> {
  if (connecting) return connecting
  connecting = (async () => {
    try {
      const client = await connectOnce()
      daemon = client
      client.on('state', slot => { slotStates.set(slot.slotId, slot); panelRouter.onState(slot); noteAttention(slot); if (attentionHistory.settle(slot.slotId, slot.attention)) sendAttention(); agentTracker.apply(slot); updateTray(); win?.webContents.send('tether:event', { t: 'state', slot }) })
      client.on('data', (slotId, data, p) => { perfEchoData(slotId); win?.webContents.send('tether:event', probe && p ? { t: 'data', slotId, data, probe: extendProbe(p) } : { t: 'data', slotId, data }) }) // probe: main-out stamp
      client.on('removed', slotId => { slotStates.delete(slotId); panelRouter.onRemoved(slotId); osNotifyRules.remove(slotId); attentionHistory.remove(slotId); sendAttention(); agentTracker.remove(slotId); updateTray(); win?.webContents.send('tether:event', { t: 'removed', slotId }) })
      client.on('pause', batch => win?.webContents.send('tether:event', { t: 'pause', batch }))
      client.on('profiles', profiles => win?.webContents.send('tether:event', { t: 'profiles', profiles }))
      client.on('proc', proc => win?.webContents.send('tether:event', { t: 'proc', proc }))
      client.on('proc-removed', name => win?.webContents.send('tether:event', { t: 'proc-removed', name }))
      client.on('proc-data', (name, data) => win?.webContents.send('tether:event', { t: 'proc-data', name, data }))
      // Agent door: the desk map and the extensions' object data reach the renderer as they come; main's own mirror of the
      // object data is the extension host's (TetherMain.objects).
      client.on('desks', map => win?.webContents.send('tether:event', { t: 'desks', map }))
      client.on('ext-event', e => win?.webContents.send('tether:event', { t: 'ext-event', ...e }))
      client.on('object', e => { extensionHost.objectEvent(e); win?.webContents.send('tether:event', { t: 'object', ...e }) })
      client.on('close', () => {
        if (daemon !== client) return
        daemon = undefined
        slotStates.clear()
        panelRouter.reset()
        osNotifyRules.clear()
        dropOsToasts()
        agentTracker.lost()
        updateTray()
        if (quittingAll || quitting) return
        // "Reiniciar serviço" (tray) brings its panels back through the renderer's reconnect path; any other
        // loss (a crash, "Reiniciar tudo…", `tether daemon restart`) reloads the page on the next connection.
        if (restartingDaemon) return
        reloadOnReconnect = true
        recovering = true
        recoverDelay = 500
        sendConnection({ connected: false, pipe, error: 'conexão com o tetherd fechada' })
        // The daemon died (or was shut down): bring one back (the tray keeps the app alive with no window)
        // and let the renderer restart its panels.
        scheduleRecover(500)
      })
      recovering = false
      if (recoverTimer) { clearTimeout(recoverTimer); recoverTimer = undefined }
      sendConnection(connectionState())
      void syncSlots(client)
      void syncPause(client)
      void doorObjects.reload()
      // A restarted daemon has no agents running: a fresh page restores the layout and resumes each slot's session.
      if (reloadOnReconnect) { reloadOnReconnect = false; win?.webContents.reloadIgnoringCache() }
    } catch (err) {
      sendConnection({ connected: false, pipe, error: err instanceof Error ? err.message : String(err) })
      // Only after a loss: the first connection of the app keeps its "Tentar de novo".
      if (recovering && !restartingDaemon && !quitting && !quittingAll) {
        scheduleRecover(recoverDelay)
        recoverDelay = Math.min(recoverDelay * 2, RECOVER_MAX_MS)
      }
    } finally {
      connecting = undefined
    }
  })()
  return connecting
}

function scheduleRecover(ms: number): void {
  if (recoverTimer) clearTimeout(recoverTimer)
  recoverTimer = setTimeout(() => {
    recoverTimer = undefined
    if (recovering && !restartingDaemon && !daemon) void connectDaemon()
  }, ms)
}

function windowInFront(): boolean {
  return !!win && !win.isDestroyed() && win.isFocused() && !win.isMinimized()
}

/** Feeds a slot state to the toast rules; a due toast waits a moment for others (one toast per burst). */
function noteAttention(slot: SlotState): void {
  const toast = osNotifyRules.apply(slot, slotLabel(slot), normalizeOsNotify(settings().notifications?.os), windowInFront())
  if (!toast) return
  attentionHistory.add(toast, Date.now())
  sendAttention()
  if (isMuted(mutedUntil, Date.now())) return
  osNotifyBatch.push(toast)
  osNotifyTimer ??= setTimeout(showOsToast, OS_NOTIFY_COALESCE_MS)
}

function attentionState(): AttentionState {
  return { items: attentionHistory.list(), unseen: attentionHistory.unseen, ...(isMuted(mutedUntil, Date.now()) ? { mutedUntil } : {}) }
}

function sendAttention(): void { win?.webContents.send('tether:attention', attentionState()) }

/** Mutes the toasts until a deadline (null lifts it); one timer brings the bell back when the mute expires. */
function setMute(until: number | undefined): void {
  if (muteTimer) clearTimeout(muteTimer)
  muteTimer = undefined
  mutedUntil = until
  if (until !== undefined) muteTimer = setTimeout(() => setMute(undefined), Math.max(0, until - Date.now()))
  sendAttention()
}

ipcMain.handle('attention:get', () => attentionState())
ipcMain.on('attention:seen', (_e, slotId: unknown) => { if (attentionHistory.markSeen(typeof slotId === 'string' ? slotId : undefined)) sendAttention() })
ipcMain.on('attention:mute', (_e, choice: unknown) => setMute(isMuteChoice(choice) ? muteUntil(choice, Date.now()) : undefined))

function dropOsToasts(): void {
  if (osNotifyTimer) clearTimeout(osNotifyTimer)
  osNotifyTimer = undefined
  osNotifyBatch = []
}

function showOsToast(): void {
  const t = toastFor(osNotifyBatch)
  dropOsToasts()
  // E2E windows never reach the user's screen; focus may also have come back while coalescing (the tab seal is enough).
  if (!t || hidden || windowInFront() || isMuted(mutedUntil, Date.now()) || !Notification.isSupported()) return
  const n = new Notification({ title: t.title, body: t.body, icon: join(__dirname, 'tether.ico') })
  liveToasts.add(n)
  n.on('click', () => { liveToasts.delete(n); void openWindow(t.slotId) })
  n.on('close', () => liveToasts.delete(n))
  n.show()
  if (win && !win.isDestroyed()) win.flashFrame(true)
}

/** Loads the slot list for the tray (the renderer asks for its own copy). */
async function syncSlots(client: DaemonClient): Promise<void> {
  const list = await request({ t: 'list' })
  if (daemon !== client || list.t !== 'ok') return
  slotStates.clear()
  for (const s of list.slots ?? []) { slotStates.set(s.slotId, s); osNotifyRules.seed(s); panelRouter.onState(s) }
  agentTracker.reset(list.slots ?? [])
  updateTray()
}

/** The renderer opens with the batch the daemon already holds (a pause survives an app restart). */
async function syncPause(client: DaemonClient): Promise<void> {
  const r = await request({ t: 'pause-get' })
  if (daemon !== client || r.t !== 'ok' || !r.pause) return
  win?.webContents.send('tether:event', { t: 'pause', batch: r.pause })
}

function updateTray(): void { tray?.update(slotStates.values(), trayNotices.list()) }

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
  flushWindowState()
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
  exitApp()
}

/** "Sair e encerrar tudo": stops every slot, shuts the daemon down and quits (after the in-app dialog). */
/**
 * "Sair" must end the process: app.quit() waits for windows and handlers, and the daemon round trips of "quit all"
 * can stall (many agents stopping one by one, a daemon that dies without answering). After `ms` the app leaves
 * regardless, taking its tray icon with it (app.exit skips before-quit, so the icon is destroyed here).
 */
function leaveWithin(ms: number): void {
  setTimeout(() => { tray?.destroy(); tray = undefined; exitApp() }, ms).unref()
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

/**
 * User settings (theme, terminal appearance, remembered dialog answers) in <userDir>/settings.json (`~/.tether`; the test home
 * when TETHER_HOME is set). SettingsStore is the only writer (app/main/settings-store.ts); a missing or corrupt file means defaults.
 * The files that used to live in the home move over once, at start.
 */
const userHome = userDir()
migrateUserFiles(home, userHome, ['settings.json', KEYBINDINGS_FILE], msg => appLog(msg))
const settingsStore = new SettingsStore({
  path: join(userHome, 'settings.json'),
  executor: mainExec,
  log: msg => appLog(msg),
  onChange: (keys, source) => onSettingsChanged(keys, source),
  onErrors: errors => win?.webContents.send('tether:settings-errors', errors),
  keyOf: settingKeyLength,
})
/**
 * The settings written as one flat key whose value is an object or array (VS Code's `files.exclude`): the app's own state
 * objects, not in the registry. `extensionState` holds one such key per extension (`extensionState.<id>`).
 */
const WHOLE_SETTINGS = ['terminal', 'confirmations', 'window', 'notes', 'extensions.disabled']
/** How many segments of a settings path form its flat key: a registry key, a whole-object setting, else the whole path. */
function settingKeyLength(path: readonly string[]): number {
  if (path[0] === EXTENSION_STATE_KEY) return 2
  for (const w of WHOLE_SETTINGS) { const segs = w.split('.'); if (segs.every((s, i) => path[i] === s)) return segs.length }
  let props: Record<string, unknown> = {}
  try { props = extensionHost.configuration.getConfigurationProperties() } catch { /* not built yet */ }
  for (let n = path.length; n > 0; n--) if (path.slice(0, n).join('.') in props) return n
  return path.length
}
settingsStore.watch()
const settings = (): Settings => settingsStore.value as Settings
/** Saves one top-level setting (objects are edited key by key, so the person's comments stay); a refused write is logged. */
function saveSetting(key: string, value: unknown): boolean {
  const r = settingsStore.assign([key], value)
  if (!r.ok) appLog(`configurações: ${key} não foi gravado, o settings.json tem erros (${r.errors[0]?.message ?? 'inválido'})`)
  return r.ok
}

/** The settings file changed: tells the renderer which keys; an edit from outside also replays the specific broadcasts. */
function onSettingsChanged(keys: string[], source: 'self' | 'disk'): void {
  win?.webContents.send('tether:settings-changed', keys)
  if (source === 'disk') replaySettings(keys)
}

/** The specific broadcasts of changed keys (an edit on disk, or a write through settings:set / settings:reset): each part applies its own. */
function replaySettings(keys: readonly string[]): void {
  const roots = new Set(keys.map(k => k.split('.')[0]))
  if (roots.has('theme')) { const t = readThemeSetting(); nativeTheme.themeSource = t === 'auto' ? 'system' : t; applyTheme() }
  if (roots.has('terminal')) win?.webContents.send('tether:terminal', readTerminalAppearance())
  if (roots.has('ui')) win?.webContents.send('tether:ui', normalizeUi(settings().ui))
  if (roots.has('confirmations')) win?.webContents.send('tether:confirmations', readConfirmations())
  if (roots.has('extensions')) extensionHost.settingsChangedOnDisk(keys)
  if (roots.has('performance')) panelRouter.refresh()
}
type Settings = { theme?: unknown; terminal?: unknown; confirmations?: unknown; trayNoticeShown?: unknown; ui?: unknown; notes?: unknown; window?: unknown; extensions?: unknown; notifications?: { os?: unknown } }

// ---------- extensions (F9) ----------
// The main side of the extensions (extensions/index.main.ts) and the core channels of their settings and listing
// (app/main/ext-host.ts). The handlers exist from the start; activation runs when the app is ready, before the window.
// Native views over the interface, owned by the extension that creates them (app/main/surfaces.ts).
const surfaces = new SurfaceManager({ dist: __dirname, window: () => win, ipc: ipcMain, log: msg => appLog(msg) })
new SurfaceBridge({ surfaces: owner => surfaces.forOwner(owner), window: () => win, ipc: ipcMain, log: msg => appLog(msg), remote: owner => surfaces.remoteFor(owner) })
const doorObjects = new DoorObjects(body => request(body))
const extensionHost = new MainExtensionHost(mainExtensions, {
  home,
  userDir: userHome,
  dist: __dirname,
  ipc: ipcMain as unknown as MainHostDeps['ipc'],
  broadcast: (channel, ...args) => { if (win && !win.isDestroyed()) win.webContents.send(channel, ...args) },
  window: () => win,
  readSettings: () => readExtensionsSettings(settings().extensions),
  writeSettings: s => saveSetting('extensions', writeExtensionsSettings(s)),
  readFile: () => settingsStore.value,
  writeFile: file => { const r = settingsStore.assign([], file); if (!r.ok) appLog('configurações: o settings.json tem erros, nada foi gravado') },
  log: msg => appLog(msg),
  trash: path => shell.trashItem(path),
  surfaces: owner => surfaces.forOwner(owner),
  agents: agentTracker,
  notices: trayNotices,
  objects: doorObjects,
})

// ---------- settings registry (the settings page's channels) ----------
// Every editable setting is a property of the configuration registry, keyed by its storage path: the core's
// (app/shared/core-settings.ts) next to the extensions' (registered at activation). The specific readers (normalizeUi,
// normalizeTheme, the extensions' settings.get) stay as they are; these channels are the page's generic way in.
//   settings:list    every property in page order, its value in force and whether the file sets it; the parse errors
//   settings:set     one key to a value its schema allows (that key alone, as a text edit), then its specific broadcast
//   settings:reset   removes one key (back to its default), then its specific broadcast
//   settings:file    the file's path, text and errors
//   settings:open    creates an empty file when absent and answers its path (the renderer opens it in a note tab)
extensionHost.configuration.registerConfiguration(CORE_SETTINGS)
const settingsPath = join(userHome, 'settings.json')
ipcMain.handle('settings:list', (): SettingsList => {
  const reg = extensionHost.configuration
  const file = settingsStore.value
  const titles = new Map(reg.getConfigurationNodes().map(n => [n.id, n.title ?? n.id]))
  return {
    entries: reg.properties().map(p => ({ key: p.key, node: p.node, nodeTitle: titles.get(p.node) ?? p.node, schema: p.schema, value: reg.readAt(file, p.key)!, configured: reg.isConfigured(file, p.key) })),
    errors: [...settingsStore.errors],
  }
})
function writeSettingKey(key: unknown, value: unknown, reset: boolean): SettingWriteResult {
  const schema = typeof key === 'string' ? extensionHost.configuration.schemaAt(key) : undefined
  if (typeof key !== 'string' || !schema) return { ok: false, message: 'Configuração desconhecida.' }
  if (!reset && !isValidSetting(schema, value)) return { ok: false, message: 'Valor inválido para esta configuração.' }
  const before = JSON.stringify(valueAt(settingsStore.value, key))
  const r = settingsStore.set(settingPath(key), reset ? undefined : value)
  if (!r.ok) return { ok: false, message: `O settings.json tem erros: ${r.errors[0]?.message ?? 'inválido'}` }
  if (JSON.stringify(valueAt(settingsStore.value, key)) !== before) replaySettings([key])
  return { ok: true }
}
ipcMain.handle('settings:set', (_e, key: unknown, value: unknown): SettingWriteResult => writeSettingKey(key, value, false))
ipcMain.handle('settings:reset', (_e, key: unknown): SettingWriteResult => writeSettingKey(key, undefined, true))
ipcMain.handle('settings:file', (): SettingsFileState => ({ path: settingsPath, text: existsSync(settingsPath) ? settingsStore.fileText : null, errors: [...settingsStore.errors] }))
ipcMain.handle('settings:open', async (): Promise<{ ok: true; path: string } | { ok: false; message: string }> => {
  try {
    if (!existsSync(settingsPath)) { mkdirSync(userHome, { recursive: true }); await writeTextAtomic(settingsPath, '{\n}\n'); await settingsStore.reload() }
    return { ok: true, path: settingsPath }
  } catch (err) { return { ok: false, message: err instanceof Error ? err.message : String(err) } }
})

// ---------- terminal appearance ----------
// The renderer owns the dialog and applies the change to every xterm; main keeps the file and echoes the
// normalized value so every window (and a relaunch) paints the same thing.

function readTerminalAppearance(): TerminalAppearance {
  return normalizeAppearance(settings().terminal)
}

function setTerminalAppearance(value: unknown): void {
  const appearance = normalizeAppearance(value)
  saveSetting('terminal', appearance)
  win?.webContents.send('tether:terminal', appearance)
}

ipcMain.handle('terminal:get', (): TerminalAppearance => readTerminalAppearance())
ipcMain.on('terminal:set', (_e, value: unknown) => setTerminalAppearance(value))

/** Chrome preferences (`ui`): the renderer applies them, main keeps the file and echoes the normalized value. */
ipcMain.handle('ui:get', (): UiSettings => normalizeUi(settings().ui))
ipcMain.on('ui:set', (_e, value: unknown) => {
  const ui = normalizeUi(value)
  saveSetting('ui', ui)
  win?.webContents.send('tether:ui', ui)
})

/** Remembered answers per situation ("não perguntar de novo"); anything malformed reads as none. */
function readConfirmations(): Confirmations {
  const raw = settings().confirmations
  if (!raw || typeof raw !== 'object') return {}
  const out: Confirmations = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'string') out[k] = v
  return out
}

function writeConfirmations(confirmations: Confirmations): void {
  saveSetting('confirmations', confirmations)
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
  return normalizeTheme(settings().theme)
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
  if (!saveSetting('theme', setting)) return // a settings.json with errors keeps the values in force
  nativeTheme.themeSource = setting === 'auto' ? 'system' : setting
  applyTheme()
}

const initialTheme = readThemeSetting()
nativeTheme.themeSource = initialTheme === 'auto' ? 'system' : initialTheme
nativeTheme.on('updated', applyTheme)
ipcMain.handle('theme:get', (): ThemeState => themeState())
// Settings may change before any window exists (the standalone dialog): nothing to push then.
ipcMain.on('theme:set', (_e, setting: unknown) => setTheme(normalizeTheme(setting)))

// ---------- font size ----------

/** The size itself is appearance.fontSize ("Tema do tether"): the renderer steps it and saves it through terminal:set. */

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

/** Writes the window's maximized / fullscreen flags and last normal bounds to settings.json. */
function saveWindowState(w: BrowserWindow): void {
  if (w.isDestroyed()) return
  const state: WindowState = { ...w.getNormalBounds(), maximized: w.isMaximized(), fullscreen: w.isFullScreen() }
  saveSetting('window', state)
}

/** Saves the current window now (the process may leave without a `close`: relaunch, quit). */
function flushWindowState(): void {
  if (win) saveWindowState(win)
}

/** Remembers the window across launches: debounced on move/resize/state changes, immediately on close. */
function trackWindowState(w: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined
  const later = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => saveWindowState(w), 400)
  }
  w.on('move', later)
  w.on('resize', later)
  w.on('maximize', later)
  w.on('unmaximize', later)
  w.on('enter-full-screen', later)
  w.on('leave-full-screen', later)
  w.on('close', () => { clearTimeout(timer); saveWindowState(w) })
  w.on('closed', () => clearTimeout(timer))
}

/**
 * The main window's session grants every permission (Electron's default) except `local-fonts`: the terminal draws
 * the bundled fonts (app/renderer/fonts), so the ligatures addon must not read the copies installed in Windows
 * (a missing family would resolve to an installed font without ligatures). Refused, it joins its fallback list.
 */
function denyLocalFonts(win: BrowserWindow): void {
  const ses = win.webContents.session
  // queryLocalFonts() reads the permission status (the check handler) and, denied, resolves to an empty list without
  // ever reaching a request handler; a request handler alone leaves the API answering.
  ses.setPermissionCheckHandler((_wc, permission) => permission !== 'local-fonts')
}

function createWindow(): void {
  const saved = normalizeWindowState(settings().window)
  const displays = screen.getAllDisplays()
  const start = resolveWindowState(saved, displays.map(d => d.workArea), screen.getPrimaryDisplay().workArea)
  win = new BrowserWindow({
    ...start.bounds,
    title: BRAND.slug,
    icon: join(__dirname, 'tether.ico'),
    backgroundColor: WINDOW_BACKGROUND[themeState().scheme],
    // Shown on ready-to-show, after maximize(): no flash of the small window.
    show: false,
    // Never auto-hide: auto-hide reveals the bar on Alt, which clashes with Monaco's Alt+click multi-cursor.
    // The bar stays hidden (setMenuBarVisibility below) while the application menu keeps its accelerators.
    autoHideMenuBar: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The HTML preview's page runs in a <webview> (an isolated guest: app/main/html-preview-main.ts locks it down).
      webviewTag: true,
      // A window that is never shown does not paint, and Playwright's screenshot would wait forever;
      // offscreen rendering keeps producing frames without any window on the user's screen.
      ...(hidden ? { offscreen: { deviceScaleFactor: hiddenScale }, backgroundThrottling: false } : {}),
    },
  })
  win.setMenuBarVisibility(false)
  denyLocalFonts(win)
  if (hidden) win.webContents.setFrameRate(30)
  const created = win
  if (start.maximized) created.maximize()
  if (start.fullscreen) created.setFullScreen(true)
  if (!hidden) created.once('ready-to-show', () => created.show())
  trackWindowState(created)
  created.on('focus', () => created.flashFrame(false))
  // A <webview> is only ever an extension's isolated page (the note's HTML preview): with no extension guarding, none attaches.
  extensionHost.guardWebviews(created.webContents, () => created.webContents.on('will-attach-webview', event => event.preventDefault()))
  // A minimized (or tray-hidden) window draws nothing: its hosted panes stop receiving output until it is back.
  const windowShown = (): boolean => !created.isMinimized() && created.isVisible()
  const windowMoved = (): void => { if (win === created) panelRouter.setWindowVisible(windowShown()) }
  created.on('minimize', windowMoved); created.on('restore', windowMoved); created.on('show', windowMoved); created.on('hide', windowMoved)
  created.on('close', e => {
    if (quitting || !tray) return
    e.preventDefault()
    void hideToTray()
  })
  created.webContents.on('did-start-loading', () => { if (win === created) tetherLinkListening = false }) // a reload asks again too
  // A reloaded page (main frame; a subframe never fires this) attaches its panes again, the old ones never detach: the link starts over.
  created.webContents.on('did-navigate', () => { if (win === created) panelRouter.reset() })
  created.on('closed', () => {
    if (win === created) { win = undefined; tetherLinkListening = false } // a new window asks for its pending link again
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
  void created.loadFile(join(__dirname, '..', 'renderer', 'index.html'), probe ? { query: { probe: '1' } } : undefined) // the renderer reads ?probe
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
    if (settings().trayNoticeShown !== true) {
      saveSetting('trayNoticeShown', true)
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
    agentTracker.lost()
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
    model: () => (tray ? tray.model() : trayModel([], trayNotices.list())),
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
    // macOS routes Cmd+C/V/X/A/Z to the Edit menu roles; without them the shortcuts do nothing in web tabs.
    {
      label: 'Editar',
      submenu: [
        { role: 'undo', label: 'Desfazer' },
        { role: 'redo', label: 'Refazer' },
        { type: 'separator' },
        { role: 'cut', label: 'Recortar' },
        { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Colar' },
        { role: 'pasteAndMatchStyle', label: 'Colar sem formatação' },
        { role: 'delete', label: 'Apagar' },
        { role: 'selectAll', label: 'Selecionar tudo' },
      ],
    },
    {
      label: 'Exibir',
      submenu: [
        themeMenu(),
        ...fontSizeMenu(),
        { type: 'separator' },
        { id: 'terminal-theme', label: 'Tema do Tether…', click: () => win?.webContents.send('tether:open-terminal-theme') },
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

ipcMain.handle('tether:request', (_e, body: RequestBody) => panelRouter.request(body))
registerPerf(ipcMain, request, probe, () => win?.webContents)
app.on('will-quit', stopPerf)
app.on('will-quit', () => panelLink.stop())
// Last chance for the disk work still in flight (the log, a settings or layout write queued while the windows closed): quit is held
// until it is drained (bounded), then the app exits (the other will-quit handlers have run by then).
app.on('will-quit', e => { e.preventDefault(); exitApp() })
ipcMain.on('tether:notice', (_e, notice: Notice | { t: 'probe-result' }) => {
  if (notice.t === 'input') perfEchoKey(notice.slotId, slotStates.get(notice.slotId)?.kind === 'shell' ? 'shell' : 'agent')
  if (probe) {
    if (isProbeResultNotice(notice)) { recordProbe(notice); return }
    if (notice.t === 'input' && panelRouter.input(notice.slotId, notice.data) !== 'daemon') return // hosted pane: no daemon-* stamps
    if (notice.t === 'input') {
      const p = parseProbe(notice.probe)
      if (p) { daemon?.input(notice.slotId, notice.data, extendProbe(p)); return } // main-in stamp
    }
  }
  if (notice.t === 'input' && panelRouter.input(notice.slotId, notice.data) === 'daemon') daemon?.input(notice.slotId, notice.data)
})
// The window says which terminals are on screen (app/renderer/panel.ts); hidden hosted panes stop receiving output.
ipcMain.on('panel:visible', (_e, slotId: unknown, visible: unknown) => { if (typeof slotId === 'string' && typeof visible === 'boolean') panelRouter.setVisible(slotId, visible) })
ipcMain.on('tether:reconnect', () => { void connectDaemon() })
ipcMain.handle('tether:connection', (): ConnectionState => connectionState())

// layout.json keeps its previous content in layout.json.bak on every save and falls back to it (layout-file.ts).
ipcMain.handle('layout:load', () => loadLayoutFile(mainExec, layoutPath))
ipcMain.handle('layout:save', (_e, layout: unknown) => saveLayoutFile(mainExec, layoutPath, layout))
// The renderer asks for this when it reads an older file (v1, v2, v3): layout.json.bak rotates on every save, layout.v<n>.bak
// keeps the last content of that version for good (a copy: layout.json itself is not touched until the person changes
// something), so an older build can be given its file back by hand.
ipcMain.handle('layout:backup', async (_e, version: unknown) => {
  const n = version === 2 || version === 3 ? version : 1
  let text: string
  try { text = await mainExec.run('readText', [layoutPath]) } catch { return } // no layout yet: nothing to keep
  await mainExec.run('writeTextAtomic', [join(home, `layout.v${n}.bak`), text])
})

/** Recent folders in canonical form, deduped case-insensitively (entries saved before the fix may differ only in casing). */
async function recentFolders(): Promise<string[]> {
  const out: string[] = []
  for (const f of await readJsonAsync<string[]>(recentPath, [])) {
    const dir = canonicalDir(f)
    if (!out.some(o => o.toLowerCase() === dir.toLowerCase())) out.push(dir)
  }
  return out
}
ipcMain.handle('recent:list', () => recentFolders())
ipcMain.handle('recent:remember', async (_e, folder: string) => {
  const dir = canonicalDir(folder)
  const list = (await recentFolders()).filter(f => f.toLowerCase() !== dir.toLowerCase())
  list.unshift(dir)
  await writeJson(recentPath, list.slice(0, RECENT_LIMIT))
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
  try { isDir = (await mainExec.run('stat', [path])).isDirectory } catch { return { ok: false, message: 'A pasta não existe.' } }
  if (!isDir) return { ok: false, message: 'O caminho não é uma pasta.' }
  const err = await shell.openPath(path)
  return err ? { ok: false, message: err } : { ok: true }
})
ipcMain.handle('clipboard:read', () => clipboard.readText())
ipcMain.on('clipboard:write', (_e, text: string) => clipboard.writeText(text))

// ---------- keyboard shortcuts (F5, delivery 5) ----------
// <userDir>/keybindings.json is the renderer's (format, defaults, merge: app/renderer/keybindings-rules.ts); main
// only hands the text over and reports every change on disk (a save from the screen, an edit by hand in a note tab or
// outside) so the renderer re-reads. Writing it is the keybindings-screen extension's (extensions/keybindings-screen/main.ts).
const keybindingsPath = join(userHome, KEYBINDINGS_FILE)
function keybindingsState(): KeybindingsFileState {
  try { return { path: keybindingsPath, text: readFileSync(keybindingsPath, 'utf8') } } catch { return { path: keybindingsPath, text: null } }
}
ipcMain.handle('keybindings:read', (): KeybindingsFileState => keybindingsState())
// The same watcher class the notes use (one per folder, debounced): the file's folder is the user folder.
const keybindingsWatchers = new NoteWatchers(() => win?.webContents.send('tether:keybindings-changed', keybindingsState()))
try { mkdirSync(userHome, { recursive: true }); keybindingsWatchers.watch(keybindingsPath) } catch { /* no watcher: the screen still reads on open */ }

// ---------- opening files ----------
// What a path is and the system's program for a binary (app/main/file-open-main.ts); Ctrl+P's index is an extension.
registerFileOpen(ipcMain, shell)
app.on('will-quit', () => extensionHost.store.dispose())
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

function bringToFront(_event?: unknown, argv?: string[]): void {
  appLog('second launch poked this instance; bringing the window up')
  void writeJson(ackPath, { at: Date.now(), pid: process.pid })
  const link = argv ? tetherUrlInArgv(argv) : undefined
  if (link) queueTetherLink(link)
  if (!app.isReady()) return
  void openWindow() // creates the window when the app is hidden in the tray
  if (link) deliverTetherLink()
}

// ---------- tether:// links (app/shared/tether-url.ts) ----------
// The OS hands a followed tether:// link to the app as an argument: to this process when it starts with one (the app was
// closed), or to the running instance through `second-instance` (bringToFront). Main only carries the text to the
// renderer, which parses it and reveals the place; nothing here acts on it. The renderer takes a link queued before it
// was ready (`tether-link:pending`) and from then on gets each one as it comes (`tether:link`).

let pendingTetherLink: string | undefined = tetherUrlInArgv(process.argv)
let tetherLinkListening = false

function queueTetherLink(url: string): void {
  pendingTetherLink = url
}

function deliverTetherLink(): void {
  if (!tetherLinkListening || !win || pendingTetherLink === undefined) return
  win.webContents.send('tether:link', pendingTetherLink)
  pendingTetherLink = undefined
}

ipcMain.handle('tether-link:pending', () => {
  tetherLinkListening = true
  const url = pendingTetherLink
  pendingTetherLink = undefined
  return url
})

/** What the OS runs to give this app a link: the electron binary plus this bundle while not packaged. */
const schemeArgs = (): string[] => (process.defaultApp ? [__filename] : [])

async function tetherAssociation(): Promise<Association> {
  const mine = commandLineFor(process.execPath, schemeArgs())
  if (process.platform !== 'win32') {
    const isMine = app.isDefaultProtocolClient(TETHER_SCHEME, process.execPath, schemeArgs())
    return { current: isMine ? mine : undefined, mine, isMine }
  }
  const current = await readAssociatedCommand()
  return { current, mine, isMine: sameCommand(current, mine) }
}

/** "Associar links tether:// a este tether": whatever answered before is removed, this app is written, and the result read back. */
async function associateTetherScheme(): Promise<Association> {
  await removeAssociation()
  const ok = app.setAsDefaultProtocolClient(TETHER_SCHEME, process.execPath, schemeArgs())
  const state = await tetherAssociation()
  appLog(`tether:// links: associated to this app ${ok && state.isMine ? 'ok' : `FAILED (now: ${state.current ?? 'nothing'})`}`)
  return state
}

/** The state for the renderer, with the command lines as the person reads them (the executable and its script). */
const shown = (s: Association): LinkAssociation => ({ isMine: s.isMine, current: s.current ? describeCommand(s.current) : undefined, mine: describeCommand(s.mine) })
ipcMain.handle('tether-link:association', async () => shown(await tetherAssociation()))
ipcMain.handle('tether-link:associate', async () => shown(await associateTetherScheme()))

/**
 * At start: this app takes tether:// links only when no program answers them yet (the first run). When another one does
 * (another checkout, an older build), it stays: moving the links is the person's call, "Associar links tether:// a este
 * tether…". Never from a test or second instance (its own TETHER_PIPE).
 */
async function registerTetherScheme(): Promise<void> {
  if (process.env.TETHER_PIPE || process.env.TETHER_E2E_HIDDEN) return
  const state = await tetherAssociation()
  if (state.isMine) return
  if (state.current) { appLog(`tether:// links answered by another program (${state.current}); left as is`); return }
  await associateTetherScheme()
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
    title: BRAND.slug,
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

/** Interactive processes above normal (E2.7). settings.json "performance.priorities": false turns it off; read once, at boot. */
function startPriorities(): void {
  const flat = (settingsStore.value as Record<string, unknown>)['performance.priorities']
  const nested = ((settingsStore.value as Record<string, unknown>).performance as { priorities?: unknown } | undefined)?.priorities
  const enabled = (flat ?? nested) !== false
  const keeper = startPriorityKeeper({
    enabled,
    getMetrics: () => app.getAppMetrics(),
    rendererPids: () => {
      const pid = win && !win.isDestroyed() && !win.webContents.isDestroyed() ? win.webContents.getOSProcessId() : 0
      return new Set(pid > 0 ? [pid] : [])
    },
    log: appLog,
  })
  if (!enabled) { appLog('priorities: off (performance.priorities = false)'); return }
  // Chromium resets a renderer's class when the window changes visibility or focus: reapply right then.
  const w = win
  if (w) { w.on('show', keeper.pass); w.on('focus', keeper.pass); w.on('blur', keeper.pass); w.on('restore', keeper.pass); w.on('hide', keeper.pass) }
  app.on('browser-window-focus', keeper.pass)
}

async function start(): Promise<void> {
  // Chromium switches must precede app.whenReady(); settings are already loaded (settingsStore is built at module load).
  const throttling = throttlingWanted(process.env.TETHER_THROTTLING, (settings() as { performance?: { throttling?: unknown } }).performance?.throttling)
  applyThrottleSwitches(app.commandLine, throttling)
  let outcome = await acquireSingleInstance()
  let closeStandalone: (() => void) | undefined
  while (outcome === 'stale') {
    // The previous instance is still releasing the lock and nobody is alive to focus: say so in the app's
    // own dialog (stderr too, for a launch from a terminal) and let the user retry or leave.
    const message = 'o Tether ainda está fechando; tente de novo em alguns segundos'
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
  void panelLink.start()
  void registerTetherScheme()
  if (process.platform === 'darwin') app.dock?.setIcon(join(__dirname, 'tether.png'))
  createMenu()
  extensionHost.activate()
  createWindow()
  startPriorities()
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

app.on('before-quit', () => { flushWindowState(); quitting = true; tray?.destroy(); tray = undefined })

// With the tray the app outlives its window (the daemon keeps the PTYs either way); without one, closing the
// window ends the app as it always did.
app.on('window-all-closed', () => {
  if (tray) return
  daemon?.close()
  daemon = undefined
  app.quit()
})
