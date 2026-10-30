// Electron main process: one window, one connection to tetherd (spawned detached when nothing answers on
// the pipe), a narrow IPC surface for the renderer (see app/shared/api.ts). Layout and recent folders live
// under TETHER_HOME. Closing the window only disconnects: the daemon keeps every slot running.
// Built by app/build.mjs into app/dist/main.cjs (CommonJS: __dirname is available).
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { delimiter, join } from 'node:path'
import { DaemonClient, DaemonError, NotTetherError, type SpawnOptions } from '../../src/daemon/client.ts'
import { pipePath, PROTOCOL_VERSION } from '../../src/daemon/protocol.ts'
import type { Notice, Reply } from '../../src/daemon/protocol.ts'
import { canonicalDir, tetherHome } from '../../src/core/paths.ts'
import { ProfileError, readProfiles, removeProfile, upsertProfile, writeProfiles } from '../../src/core/profile.ts'
import type { ProfileInput } from '../../src/core/profile.ts'
import type { ConnectionState, ProfileDeleted, ProfileSaved, ProfilesList, RequestBody } from '../shared/api.ts'
import type { AskRequest, Confirmations, DialogAnswer, MainSituation } from '../shared/dialog.ts'
import { FONT_SIZE_LABEL, normalizeFontSize, type FontSizeCommand } from '../shared/font.ts'
import { normalizeTheme, resolveScheme, THEME_LABEL, THEME_SETTINGS, WINDOW_BACKGROUND } from '../shared/theme.ts'
import type { ThemeSetting, ThemeState } from '../shared/theme.ts'

const home = tetherHome()
const pipe = pipePath(home, userInfo().username)
/** Taskbar grouping / pinning: the same id goes on the Start Menu shortcut (app/shortcut.ps1). */
const APP_USER_MODEL_ID = 'studio.codr.tether'
// Electron's own state (cache, GPU, the single-instance lock) lives under TETHER_HOME too: E2E runs with a
// private home never collide with the user's running app.
app.setPath('userData', join(home, 'electron'))
app.setAppUserModelId(APP_USER_MODEL_ID)
const layoutPath = join(home, 'layout.json')
const recentPath = join(home, 'recent-folders.json')
const RECENT_LIMIT = 12
/** Max wait for a freshly spawned tetherd to answer on the pipe. */
const DAEMON_START_TIMEOUT_MS = 15_000
/** E2E runs set this so the test windows never show up on the user's screen. */
const hidden = process.env.TETHER_E2E_HIDDEN === '1'
/** The daemon's entry point, relative to app/dist (this bundle) → repo root. */
const daemonMain = join(__dirname, '..', '..', 'src', 'daemon', 'main.ts')

let daemon: DaemonClient | undefined
let connecting: Promise<void> | undefined
let win: BrowserWindow | undefined
let quittingAll = false

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return fallback }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(home, { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
}

// ---------- daemon ----------

function connectionState(): ConnectionState {
  return daemon ? { connected: true, pipe, pid: daemon.hello.pid } : { connected: false, pipe, error: 'sem conexão' }
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
      client.on('state', slot => win?.webContents.send('tether:event', { t: 'state', slot }))
      client.on('data', (slotId, data) => win?.webContents.send('tether:event', { t: 'data', slotId, data }))
      client.on('removed', slotId => win?.webContents.send('tether:event', { t: 'removed', slotId }))
      client.on('profiles', profiles => win?.webContents.send('tether:event', { t: 'profiles', profiles }))
      client.on('close', () => {
        if (daemon !== client) return
        daemon = undefined
        if (quittingAll) return
        sendConnection({ connected: false, pipe, error: 'conexão com o tetherd fechada' })
        // The daemon died (or was shut down): bring one back and let the renderer restart its panels.
        if (win) setTimeout(() => { void connectDaemon() }, 500)
      })
      sendConnection(connectionState())
    } catch (err) {
      sendConnection({ connected: false, pipe, error: err instanceof Error ? err.message : String(err) })
    } finally {
      connecting = undefined
    }
  })()
  return connecting
}

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
function ask(situation: MainSituation): Promise<DialogAnswer> {
  if (!win || win.webContents.isDestroyed()) return Promise.resolve({ choice: 'cancel', remember: false })
  const askId = ++askSeq
  return new Promise(resolve => {
    pendingAsks.set(askId, resolve)
    const req: AskRequest = { askId, situation }
    win?.webContents.send('tether:ask', req)
  })
}
ipcMain.on('dialog:answer', (_e, askId: number, answer: DialogAnswer) => {
  pendingAsks.get(askId)?.(answer)
  pendingAsks.delete(askId)
})
ipcMain.on('window:close', () => win?.close())

/** "Sair e encerrar tudo": stops every slot, shuts the daemon down and quits (after the in-app dialog). */
async function quitAll(): Promise<void> {
  if (!win) return
  const { choice } = await ask('quit-all')
  if (choice === 'close-window') { win?.close(); return }
  if (choice !== 'quit') return
  quittingAll = true
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

/** User settings (theme, remembered dialog answers) in <TETHER_HOME>/settings.json; a missing or corrupt file means defaults. */
const settingsPath = join(home, 'settings.json')
type Settings = { theme?: unknown; confirmations?: unknown; fontSize?: unknown }

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

/** The renderer owns the terminals: it steps the size (keyboard or menu) and stores the result here. */
ipcMain.handle('font-size:get', (): number => normalizeFontSize(readJson<Settings>(settingsPath, {}).fontSize))
ipcMain.on('font-size:set', (_e, size: unknown) => {
  const settings = readJson<Settings>(settingsPath, {})
  writeJson(settingsPath, { ...settings, fontSize: normalizeFontSize(size) })
})

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
  win.on('closed', () => { win = undefined })
  void win.loadFile(join(__dirname, '..', 'renderer', 'index.html'))
}

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
        { id: 'restore-confirmations', label: 'Voltar a perguntar antes de fechar painéis', click: restoreConfirmations },
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

ipcMain.handle('layout:load', () => readJson<unknown | null>(layoutPath, null))
ipcMain.handle('layout:save', (_e, layout: unknown) => { writeJson(layoutPath, layout) })

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
ipcMain.handle('clipboard:read', () => clipboard.readText())
ipcMain.on('clipboard:write', (_e, text: string) => clipboard.writeText(text))

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

/** True when a live instance answered our launch (its ack is newer than this process). */
function ackedByLiveInstance(): boolean {
  const ack = readJson<{ at?: number }>(ackPath, {})
  return typeof ack.at === 'number' && ack.at >= startedAt
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
      if (attempt > 1) console.error(`tether: lock de instância única obtido após ${attempt} tentativas (${Date.now() - startedAt} ms)`)
      return 'acquired'
    }
    if (attempt === 1) console.error(`tether: lock de instância única ocupado (recusado após ${Date.now() - startedAt} ms); tentando de novo por alguns segundos`)
    await sleep(LOCK_RETRY_STEP_MS)
    if (ackedByLiveInstance()) return 'focused-other'
    if (Date.now() >= deadline) return 'stale'
  }
}

function bringToFront(): void {
  writeJson(ackPath, { at: Date.now(), pid: process.pid })
  if (!win || hidden) return
  if (win.isMinimized()) win.restore()
  win.show()
  app.focus({ steal: true }) // Windows refuses plain focus from a process that is not in front
  win.focus()
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
    console.error(`tether: ${message} (lock de instância única ocupado por ${LOCK_RETRY_MS / 1000} s em ${app.getPath('userData')})`)
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
  createMenu()
  createWindow()
  closeStandalone?.() // only now: with the main window up, closing it does not quit the app
  win?.webContents.once('did-finish-load', () => { void connectDaemon() })
}

void start()

// Closing the window never stops a slot: only the connection goes; the daemon keeps the PTYs.
app.on('window-all-closed', () => {
  daemon?.close()
  daemon = undefined
  app.quit()
})
