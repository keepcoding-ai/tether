// Preload: exposes the TetherApi (app/shared/api.ts) to the renderer through contextBridge.
// Built as CommonJS (app/dist/preload.cjs) because the renderer runs sandboxed.
import { contextBridge, ipcRenderer } from 'electron'
import type { Event as DaemonEvent, Notice } from '../../src/daemon/protocol.ts'
import type { ConnectionState, TetherApi } from '../shared/api.ts'

const api: TetherApi = {
  request: body => ipcRenderer.invoke('tether:request', body),
  notice: (notice: Notice) => ipcRenderer.send('tether:notice', notice),
  onEvent: listener => {
    const handler = (_e: unknown, ev: DaemonEvent): void => listener(ev)
    ipcRenderer.on('tether:event', handler)
    return () => ipcRenderer.removeListener('tether:event', handler)
  },
  onConnection: listener => {
    const handler = (_e: unknown, state: ConnectionState): void => listener(state)
    ipcRenderer.on('tether:connection', handler)
    return () => ipcRenderer.removeListener('tether:connection', handler)
  },
  reconnect: () => ipcRenderer.send('tether:reconnect'),
  loadLayout: () => ipcRenderer.invoke('layout:load'),
  saveLayout: layout => ipcRenderer.invoke('layout:save', layout),
  recentFolders: () => ipcRenderer.invoke('recent:list'),
  rememberFolder: folder => ipcRenderer.invoke('recent:remember', folder),
  pickFolder: initial => ipcRenderer.invoke('folder:pick', initial),
  confirmClose: label => ipcRenderer.invoke('panel:confirm-close', label),
  openExternal: url => ipcRenderer.send('shell:open-external', url),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: text => ipcRenderer.send('clipboard:write', text),
}

contextBridge.exposeInMainWorld('tether', api)
