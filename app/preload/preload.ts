// Preload: exposes the TetherApi (app/shared/api.ts) to the renderer through contextBridge.
// Built as CommonJS (app/dist/preload.cjs) because the renderer runs sandboxed.
import { contextBridge, ipcRenderer } from 'electron'
import type { Event as DaemonEvent, Notice } from '../../src/daemon/protocol.ts'
import type { ConnectionState, TetherApi } from '../shared/api.ts'
import type { AskRequest, Confirmations } from '../shared/dialog.ts'
import type { ThemeState } from '../shared/theme.ts'

function on<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_e: unknown, value: T): void => listener(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: TetherApi = {
  request: body => ipcRenderer.invoke('tether:request', body),
  notice: (notice: Notice) => ipcRenderer.send('tether:notice', notice),
  onEvent: listener => on<DaemonEvent>('tether:event', listener),
  onConnection: listener => on<ConnectionState>('tether:connection', listener),
  reconnect: () => ipcRenderer.send('tether:reconnect'),
  loadLayout: () => ipcRenderer.invoke('layout:load'),
  saveLayout: layout => ipcRenderer.invoke('layout:save', layout),
  recentFolders: () => ipcRenderer.invoke('recent:list'),
  rememberFolder: folder => ipcRenderer.invoke('recent:remember', folder),
  pickFolder: initial => ipcRenderer.invoke('folder:pick', initial),
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  saveProfile: profile => ipcRenderer.invoke('profiles:save', profile),
  deleteProfile: profileId => ipcRenderer.invoke('profiles:delete', profileId),
  openExternal: url => ipcRenderer.send('shell:open-external', url),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: text => ipcRenderer.send('clipboard:write', text),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: setting => ipcRenderer.send('theme:set', setting),
  onTheme: listener => on<ThemeState>('tether:theme', listener),
  getConfirmations: () => ipcRenderer.invoke('confirmations:get'),
  rememberConfirmation: (situation, choice) => ipcRenderer.send('confirmations:remember', situation, choice),
  onConfirmations: listener => on<Confirmations>('tether:confirmations', listener),
  onAsk: listener => on<AskRequest>('tether:ask', listener),
  answer: (askId, answer) => ipcRenderer.send('dialog:answer', askId, answer),
  standaloneDialog: () => ipcRenderer.invoke('dialog:standalone'),
  answerStandalone: answer => ipcRenderer.send('dialog:standalone-answer', answer),
  standaloneSize: height => ipcRenderer.send('dialog:standalone-size', height),
  closeWindow: () => ipcRenderer.send('window:close'),
}

contextBridge.exposeInMainWorld('tether', api)
