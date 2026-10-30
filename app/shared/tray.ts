// The tray menu as data: built from the daemon's slot states, turned into an Electron Menu by app/main/tray.ts.
// Kept free of Electron so the unit tests can build and read it.
import type { SlotState, SlotStatus } from '../../src/daemon/protocol.ts'

/** Menu commands that are not a pane. */
export type TrayCommand = 'open' | 'restart-daemon' | 'quit-keep' | 'quit-all'

export type TrayItem =
  | { kind: 'command'; id: TrayCommand; label: string }
  /** A header or an "e mais N" line: shown disabled. */
  | { kind: 'info'; label: string }
  /** A pane: clicking it opens the window focused on it. */
  | { kind: 'pane'; slotId: string; label: string; status: SlotStatus }
  | { kind: 'separator' }

export interface TrayModel {
  items: TrayItem[]
  tooltip: string
  /** Agents with a process (running or starting): the number the tooltip and the icon badge report. */
  running: number
  /** 'active' paints the dot on the tray icon. Phase C adds 'attention' (finished / waiting for input). */
  badge: 'none' | 'active'
}

/** Longest list of panes in the menu; the rest is summarized. */
export const TRAY_PANE_LIMIT = 12

const STATUS_LABEL: Record<SlotStatus, string> = {
  running: 'rodando',
  starting: 'iniciando',
  queued: 'na fila',
  exited: 'encerrado',
  unconfirmed: 'aguardando escolha',
  error: 'com erro',
}

/** Live first (a process exists), then the rest; ties keep the daemon's order. */
const ORDER: Record<SlotStatus, number> = { running: 0, starting: 1, queued: 2, unconfirmed: 3, error: 4, exited: 5 }

function folderName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || cwd
}

export function slotLabel(s: SlotState): string {
  return s.title ?? s.name ?? folderName(s.cwd)
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`
}

export function trayModel(slots: Iterable<SlotState>): TrayModel {
  const list = [...slots]
    .map((s, i) => ({ s, i }))
    .sort((a, b) => ORDER[a.s.status] - ORDER[b.s.status] || a.i - b.i)
    .map(x => x.s)
  const running = list.filter(s => s.status === 'running' || s.status === 'starting').length
  const items: TrayItem[] = [{ kind: 'command', id: 'open', label: 'Abrir tether' }]
  if (list.length > 0) {
    items.push({ kind: 'separator' })
    for (const s of list.slice(0, TRAY_PANE_LIMIT)) {
      items.push({ kind: 'pane', slotId: s.slotId, label: `${slotLabel(s)} (${STATUS_LABEL[s.status]})`, status: s.status })
    }
    if (list.length > TRAY_PANE_LIMIT) items.push({ kind: 'info', label: `e mais ${list.length - TRAY_PANE_LIMIT}` })
  }
  items.push(
    { kind: 'separator' },
    { kind: 'command', id: 'restart-daemon', label: 'Reiniciar serviço…' },
    { kind: 'command', id: 'quit-keep', label: 'Sair (manter agentes)' },
    { kind: 'command', id: 'quit-all', label: 'Sair e encerrar tudo…' },
  )
  const tooltip = running === 0 ? 'tether: nenhum agente rodando' : `tether: ${plural(running, 'agente rodando', 'agentes rodando')}`
  return { items, tooltip, running, badge: running > 0 ? 'active' : 'none' }
}
