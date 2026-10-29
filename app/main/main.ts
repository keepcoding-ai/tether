// Electron main process: one window, one connection to tetherd, a narrow IPC surface for the renderer
// (see app/shared/api.ts). Layout and recent folders live under TETHER_HOME.
// Built by app/build.mjs into app/dist/main.cjs (CommonJS: __dirname is available).
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { pipePath } from '../../src/daemon/protocol.ts'
import type { Notice } from '../../src/daemon/protocol.ts'
import { tetherHome } from '../../src/core/paths.ts'
import type { CloseChoice, ConnectionState, RequestBody } from '../shared/api.ts'
import { DaemonClient } from './daemon-client.ts'

const home = tetherHome()
const pipe = pipePath(homedir(), userInfo().username)
const layoutPath = join(home, 'layout.json')
const recentPath = join(home, 'recent-folders.json')
const RECENT_LIMIT = 12

const daemon = new DaemonClient()
let win: BrowserWindow | undefined

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return fallback }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(home, { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
}

function sendConnection(state: ConnectionState): void {
  win?.webContents.send('tether:connection', state)
}

async function connectDaemon(): Promise<void> {
  try {
    await daemon.connect(pipe)
    sendConnection({ connected: true, pipe })
  } catch (err) {
    sendConnection({ connected: false, pipe, error: err instanceof Error ? err.message : String(err) })
  }
}

daemon.onEvent = ev => win?.webContents.send('tether:event', ev)
daemon.onClose = reason => sendConnection({ connected: false, pipe, error: reason })

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'tether',
    backgroundColor: '#1b1b1f',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.setMenuBarVisibility(false)
  win.on('closed', () => { win = undefined })
  void win.loadFile(join(__dirname, '..', 'renderer', 'index.html'))
}

ipcMain.handle('tether:request', async (_e, body: RequestBody) => {
  try {
    return await daemon.request(body)
  } catch (err) {
    return { t: 'error', id: -1, code: 'bad-request', message: err instanceof Error ? err.message : String(err) }
  }
})
ipcMain.on('tether:notice', (_e, notice: Notice) => daemon.notice(notice))
ipcMain.on('tether:reconnect', () => { void connectDaemon() })
ipcMain.handle('tether:connection', (): ConnectionState =>
  daemon.connected ? { connected: true, pipe } : { connected: false, pipe, error: 'sem conexão' })

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
  createWindow()
  win?.webContents.once('did-finish-load', () => { void connectDaemon() })
})

app.on('window-all-closed', () => {
  daemon.close()
  app.quit()
})
