// Preload: exposes the TetherApi (app/shared/api.ts) to the renderer through contextBridge.
// Built as CommonJS (app/dist/preload.cjs) because the renderer runs sandboxed.
import { contextBridge, ipcRenderer } from 'electron'
import type { Event as DaemonEvent, Notice } from '../../src/daemon/protocol.ts'
import type { ConnectionState, TetherApi } from '../shared/api.ts'
import type { AskRequest, Confirmations } from '../shared/dialog.ts'
import type { FontSizeCommand } from '../shared/font.ts'
import type { TerminalAppearance } from '../shared/terminal-theme.ts'
import type { ThemeState } from '../shared/theme.ts'
import type { UiSettings } from '../shared/ui-settings.ts'
import type { KeybindingsFileState } from '../shared/keybindings.ts'
import type { ExtSettingChange } from '../shared/api.ts'
import type { SettingsError } from '../shared/settings-file.ts'
import type { AttentionState } from '../shared/os-notify.ts'
import { extChannel } from '../shared/ext-ipc.ts'
import type { SurfaceEvent } from '../shared/surface-panel-rules.ts'

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
  backupLayout: (version?: 1 | 2 | 3) => ipcRenderer.invoke('layout:backup', version ?? 1),
  recentFolders: () => ipcRenderer.invoke('recent:list'),
  rememberFolder: folder => ipcRenderer.invoke('recent:remember', folder),
  pickFolder: initial => ipcRenderer.invoke('folder:pick', initial),
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  saveProfile: profile => ipcRenderer.invoke('profiles:save', profile),
  deleteProfile: profileId => ipcRenderer.invoke('profiles:delete', profileId),
  onOpenProfiles: listener => on<void>('tether:open-profiles', () => listener()),
  command: cmd => ipcRenderer.send('tether:command', cmd),
  openExternal: url => ipcRenderer.send('shell:open-external', url),
  pendingTetherLink: () => ipcRenderer.invoke('tether-link:pending'),
  linkAssociation: () => ipcRenderer.invoke('tether-link:association'),
  associateLinks: () => ipcRenderer.invoke('tether-link:associate'),
  onTetherLink: listener => on<string>('tether:link', listener),
  openPath: path => ipcRenderer.invoke('shell:open-path', path),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: text => ipcRenderer.send('clipboard:write', text),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: setting => ipcRenderer.send('theme:set', setting),
  onTheme: listener => on<ThemeState>('tether:theme', listener),
  onFontSizeCommand: listener => on<FontSizeCommand>('tether:font-size', listener),
  getTerminalAppearance: () => ipcRenderer.invoke('terminal:get'),
  setTerminalAppearance: appearance => ipcRenderer.send('terminal:set', appearance),
  onTerminalAppearance: listener => on<TerminalAppearance>('tether:terminal', listener),
  onOpenTerminalTheme: listener => on<void>('tether:open-terminal-theme', () => listener()),
  getUi: () => ipcRenderer.invoke('ui:get'),
  setUi: ui => ipcRenderer.send('ui:set', ui),
  onUi: listener => on<UiSettings>('tether:ui', listener),
  getConfirmations: () => ipcRenderer.invoke('confirmations:get'),
  rememberConfirmation: (situation, choice) => ipcRenderer.send('confirmations:remember', situation, choice),
  onConfirmations: listener => on<Confirmations>('tether:confirmations', listener),
  onAsk: listener => on<AskRequest>('tether:ask', listener),
  answer: (askId, answer) => ipcRenderer.send('dialog:answer', askId, answer),
  standaloneDialog: () => ipcRenderer.invoke('dialog:standalone'),
  answerStandalone: answer => ipcRenderer.send('dialog:standalone-answer', answer),
  standaloneSize: height => ipcRenderer.send('dialog:standalone-size', height),
  onFocusSlot: listener => on<string>('tether:focus-slot', listener),
  onOpenDrawer: listener => on<void>('tether:open-drawer', () => listener()),
  closeWindow: () => ipcRenderer.send('window:close'),
  inspectFile: path => ipcRenderer.invoke('file:inspect', path),
  openFileExternal: path => ipcRenderer.invoke('file:open-external', path),
  resolveTerminalLink: (cwd, candidates) => ipcRenderer.invoke('terminallinks:resolve', cwd, candidates),
  keybindingsRead: () => ipcRenderer.invoke('keybindings:read'),
  onKeybindingsChanged: listener => on<KeybindingsFileState>('tether:keybindings-changed', listener),
  // The bus names every channel through extChannel: an extension reaches only `ext:<its id>:…`, never a core channel.
  ext: {
    invoke: (id, channel, ...args) => ipcRenderer.invoke(extChannel(id, channel), ...args),
    send: (id, channel, ...args) => ipcRenderer.send(extChannel(id, channel), ...args),
    on: (id, channel, listener) => {
      const handler = (_e: unknown, ...args: unknown[]): void => listener(...args)
      const name = extChannel(id, channel)
      ipcRenderer.on(name, handler)
      return () => ipcRenderer.removeListener(name, handler)
    },
  },
  surfacePlace: msg => ipcRenderer.send('surface:place', msg),
  surfaceRelease: msg => ipcRenderer.send('surface:release', msg),
  onSurfaceEvent: listener => on<SurfaceEvent>('tether:surface-event', listener),
  surfaceCapture: msg => ipcRenderer.invoke('surface:capture', msg),
  surfaceFreeze: msg => ipcRenderer.invoke('surface:freeze', msg),
  extSettingsSync: () => ipcRenderer.sendSync('extsettings:get-sync'),
  setExtSetting: (id, key, value) => ipcRenderer.send('extsettings:set', id, key, value),
  onExtSetting: listener => on<ExtSettingChange>('tether:ext-setting', listener),
  listMainExtensions: () => ipcRenderer.invoke('extensions:list'),
  setExtensionEnabled: (id, on) => ipcRenderer.invoke('extensions:set-enabled', id, on),
  settingsList: () => ipcRenderer.invoke('settings:list'),
  settingsSet: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  settingsReset: key => ipcRenderer.invoke('settings:reset', key),
  settingsFile: () => ipcRenderer.invoke('settings:file'),
  settingsOpen: () => ipcRenderer.invoke('settings:open'),
  attentionGet: () => ipcRenderer.invoke('attention:get'),
  perfGet: since => ipcRenderer.invoke('perf:get', since),
  attentionSeen: (slotId?: string) => ipcRenderer.send('attention:seen', slotId),
  attentionMute: choice => ipcRenderer.send('attention:mute', choice),
  onAttention: listener => on<AttentionState>('tether:attention', listener),
  onSettingsChanged: listener => on<string[]>('tether:settings-changed', listener),
  onSettingsErrors: listener => on<SettingsError[]>('tether:settings-errors', listener),
}

contextBridge.exposeInMainWorld('tether', api)
