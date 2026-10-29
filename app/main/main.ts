// Electron main process: one window, one connection to tetherd (spawned detached when nothing answers on
// the pipe), a narrow IPC surface for the renderer (see app/shared/api.ts). Layout and recent folders live
// under TETHER_HOME. Closing the window only disconnects: the daemon keeps every slot running.
// Built by app/build.mjs into app/dist/main.cjs (CommonJS: __dirname is available).
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { delimiter, join } from 'node:path'
import { DaemonClient, DaemonError } from '../../src/daemon/client.ts'
import { pipePath, PROTOCOL_VERSION } from '../../src/daemon/protocol.ts'
import type { Notice, Reply } from '../../src/daemon/protocol.ts'
import { tetherHome } from '../../src/core/paths.ts'
import type { CloseChoice, ConnectionState, RequestBody } from '../shared/api.ts'

const home = tetherHome()
const pipe = pipePath(home, userInfo().username)
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
 * node in npm_node_execpath; else the first `node` on PATH.
 */
function findNode(): string | undefined {
  const env = process.env
  if (env.TETHER_NODE && existsSync(env.TETHER_NODE)) return env.TETHER_NODE
  if (env.npm_node_execpath && existsSync(env.npm_node_execpath)) return env.npm_node_execpath
  const name = process.platform === 'win32' ? 'node.exe' : 'node'
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** Starts tetherd detached (own process group, no stdio, no console): it outlives this window. */
function spawnDaemon(): number {
  const node = findNode()
  if (!node) throw new Error('não encontrei o node para subir o tetherd (defina TETHER_NODE)')
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

// ---------- window ----------

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'tether',
    backgroundColor: '#1b1b1f',
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
    { label: 'Exibir', submenu: [{ role: 'toggleDevTools', label: 'Ferramentas de desenvolvedor' }, { role: 'togglefullscreen', label: 'Tela cheia' }] },
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

app.whenReady().then(() => {
  createMenu()
  createWindow()
  win?.webContents.once('did-finish-load', () => { void connectDaemon() })
})

// Closing the window never stops a slot: only the connection goes; the daemon keeps the PTYs.
app.on('window-all-closed', () => {
  daemon?.close()
  daemon = undefined
  app.quit()
})
