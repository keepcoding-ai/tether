// Electron main process: one window, one connection to tetherd (spawned detached when nothing answers on
// the pipe), a narrow IPC surface for the renderer (see app/shared/api.ts). Layout and recent folders live
// under TETHER_HOME. Closing the window only disconnects: the daemon keeps every slot running.
// Built by app/build.mjs into app/dist/main.cjs (CommonJS: __dirname is available).
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { delimiter, join } from 'node:path'
import { DaemonClient, DaemonError } from '../../src/daemon/client.ts'
import { pipePath, PROTOCOL_VERSION } from '../../src/daemon/protocol.ts'
import type { Notice, Reply } from '../../src/daemon/protocol.ts'
import { tetherHome } from '../../src/core/paths.ts'
import type { CloseChoice, ConnectionState, RequestBody } from '../shared/api.ts'
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

/** Starts tetherd detached (own process group, no stdio, no console): it outlives this window. */
function spawnDaemon(): number {
  const node = findNode()
  if (!node) {
    throw new Error('não encontrei o node (≥ 24) para subir o tetherd: ele precisa estar no PATH do usuário, '
      + 'ou defina a variável de ambiente TETHER_NODE com o caminho completo do node.exe')
  }
  if (!existsSync(daemonMain)) throw new Error(`tetherd não encontrado em ${daemonMain}`)
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_')) env[k] = v
  env.TETHER_HOME = home
  env.TETHER_PIPE = pipe
  const child = spawn(node, [daemonMain], { detached: true, stdio: 'ignore', windowsHide: true, env })
  child.unref()
  if (child.pid === undefined) throw new Error('não consegui iniciar o tetherd')
  return child.pid
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
  }
  spawnDaemon()
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS
  let lastError: Error | undefined
  while (Date.now() < deadline) {
    try {
      return checkVersion(await DaemonClient.open(pipe, 'app'))
    } catch (e) {
      if (e instanceof DaemonError) throw e
      lastError = e as Error
      await new Promise(r => setTimeout(r, 100))
    }
  }
  throw new Error(`tetherd não respondeu em ${pipe}: ${lastError?.message ?? 'tempo esgotado'}`)
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

/** "Sair e encerrar tudo": stops every slot, shuts the daemon down and quits (after confirmation). */
async function quitAll(): Promise<void> {
  if (!win) return
  const r = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Sair e encerrar tudo',
    message: 'Encerrar todos os terminais e fechar o tetherd?',
    detail: 'Cada agente é morto agora; ao abrir o tether de novo, os painéis voltam retomando as sessões. Para só fechar a janela e manter tudo rodando, feche-a normalmente.',
    buttons: ['Encerrar tudo e sair', 'Cancelar'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  })
  if (r.response !== 0) return
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

/** User settings (today only the theme) in <TETHER_HOME>/settings.json; a missing or corrupt file means defaults. */
const settingsPath = join(home, 'settings.json')
type Settings = { theme?: unknown }

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
ipcMain.on('theme:set', (_e, setting: unknown) => setTheme(normalizeTheme(setting)))

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
        { label: 'Sair e encerrar tudo…', accelerator: 'CmdOrCtrl+Shift+Q', click: () => { void quitAll() } },
      ],
    },
    {
      label: 'Exibir',
      submenu: [
        themeMenu(),
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

ipcMain.handle('recent:list', () => readJson<string[]>(recentPath, []))
ipcMain.handle('recent:remember', (_e, folder: string) => {
  const list = readJson<string[]>(recentPath, []).filter(f => f.toLowerCase() !== folder.toLowerCase())
  list.unshift(folder)
  writeJson(recentPath, list.slice(0, RECENT_LIMIT))
})

ipcMain.handle('folder:pick', async (_e, initial?: string) => {
  if (!win) return null
  const r = await dialog.showOpenDialog(win, {
    title: 'Escolher pasta',
    properties: ['openDirectory'],
    ...(initial ? { defaultPath: initial } : {}),
  })
  return r.canceled ? null : (r.filePaths[0] ?? null)
})

ipcMain.handle('panel:confirm-close', async (_e, label: string): Promise<CloseChoice> => {
  if (!win) return 'cancel'
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Fechar painel',
    message: `Fechar o painel "${label}"?`,
    detail: 'Encerrar o agente mata o processo. Só fechar o painel mantém o agente rodando no tetherd; ele fica em "Slots fechados".',
    buttons: ['Encerrar o agente', 'Só fechar o painel', 'Cancelar'],
    defaultId: 1,
    cancelId: 2,
    noLink: true,
  })
  return (['stop', 'detach', 'cancel'] as const)[r.response] ?? 'cancel'
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

async function start(): Promise<void> {
  const outcome = await acquireSingleInstance()
  if (outcome === 'focused-other') { app.quit(); return }
  if (outcome === 'stale') {
    const message = 'o tether ainda está fechando; tente de novo em alguns segundos'
    console.error(`tether: ${message} (lock de instância única ocupado por ${LOCK_RETRY_MS / 1000} s em ${app.getPath('userData')})`)
    await app.whenReady()
    if (!hidden) await dialog.showMessageBox({ type: 'info', title: 'tether', message, buttons: ['OK'], noLink: true })
    app.quit()
    return
  }
  app.on('second-instance', bringToFront)
  await app.whenReady()
  createMenu()
  createWindow()
  win?.webContents.once('did-finish-load', () => { void connectDaemon() })
}

void start()

// Closing the window never stops a slot: only the connection goes; the daemon keeps the PTYs.
app.on('window-all-closed', () => {
  daemon?.close()
  daemon = undefined
  app.quit()
})
