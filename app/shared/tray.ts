// The tray menu as data: built from the daemon's slot states, turned into an Electron Menu by app/main/tray.ts.
// Kept free of Electron so the unit tests can build and read it.
import type { SlotState, SlotStatus } from '../../src/daemon/protocol.ts'

/** Menu commands that are not a pane. */
export type TrayCommand = 'open' | 'open-drawer' | 'restart-daemon' | 'quit-keep' | 'quit-all'

export type TrayItem =
  | { kind: 'command'; id: TrayCommand; label: string }
  /** A header or an "e mais N" line: shown disabled. */
  | { kind: 'info'; label: string }
  /** A pane: clicking it opens the window focused on it. */
  | { kind: 'pane'; slotId: string; label: string; status: SlotStatus }
  /** An extension's notice that wants the person (a help request): clicking it opens the window on the agent's pane, when it has one. */
  | { kind: 'notice'; slotId?: string; label: string }
  | { kind: 'separator' }

/** What an extension asks the tray to show (TetherMain.notices): the same attention the terminals' seal raises. */
export interface TrayNotice {
  id: string
  slotId?: string
  message: string
}

export interface TrayModel {
  items: TrayItem[]
  tooltip: string
  /** Agents with a process (running or starting): the number the tooltip and the icon badge report. */
  running: number
  /** Panes whose agent finished its turn or waits for the user (SlotState.attention). */
  attention: number
  /** 'attention' (amber dot: an agent finished or waits for you) wins over 'active' (green dot: an agent runs). */
  badge: 'none' | 'active' | 'attention'
}

/**
 * Whether this process creates a tray icon. Test runs (a private home or pipe, the hidden window) must never put an
 * icon in the user's real tray: they get none unless the test opts back in with TETHER_TRAY=1; TETHER_NO_TRAY=1
 * turns it off for anybody.
 */
export function trayWanted(env: Record<string, string | undefined>): boolean {
  if (env.TETHER_NO_TRAY === '1') return false
  if (env.TETHER_TRAY === '1') return true
  return !(env.TETHER_E2E_HIDDEN === '1' || env.TETHER_HOME || env.TETHER_PIPE)
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

export function trayModel(slots: Iterable<SlotState>, notices: readonly TrayNotice[] = []): TrayModel {
  const list = [...slots]
    .map((s, i) => ({ s, i }))
    .sort((a, b) => ORDER[a.s.status] - ORDER[b.s.status] || a.i - b.i)
    .map(x => x.s)
  const running = list.filter(s => s.status === 'running' || s.status === 'starting').length
  const items: TrayItem[] = [{ kind: 'command', id: 'open', label: 'Abrir tether' }, { kind: 'command', id: 'open-drawer', label: 'Abrir gaveta' }]
  if (notices.length > 0) {
    items.push({ kind: 'separator' })
    for (const n of notices.slice(0, TRAY_PANE_LIMIT)) items.push({ kind: 'notice', ...(n.slotId ? { slotId: n.slotId } : {}), label: n.message })
    if (notices.length > TRAY_PANE_LIMIT) items.push({ kind: 'info', label: `e mais ${notices.length - TRAY_PANE_LIMIT}` })
  }
  if (list.length > 0) {
    items.push({ kind: 'separator' })
    for (const s of list.slice(0, TRAY_PANE_LIMIT)) {
      const state = s.attention === 'waiting' ? 'espera você' : s.attention === 'done' ? 'terminou' : STATUS_LABEL[s.status]
      items.push({ kind: 'pane', slotId: s.slotId, label: `${slotLabel(s)} (${state})`, status: s.status })
    }
    if (list.length > TRAY_PANE_LIMIT) items.push({ kind: 'info', label: `e mais ${list.length - TRAY_PANE_LIMIT}` })
  }
  items.push(
    { kind: 'separator' },
    { kind: 'command', id: 'restart-daemon', label: 'Reiniciar o tetherd… (encerra os agentes e retoma as sessões)' },
    { kind: 'command', id: 'quit-keep', label: 'Sair (manter agentes)' },
    { kind: 'command', id: 'quit-all', label: 'Sair e encerrar tudo…' },
  )
  const attention = list.filter(s => s.attention !== undefined).length + notices.length
  let tooltip = running === 0 ? 'tether: nenhum agente rodando' : `tether: ${plural(running, 'agente rodando', 'agentes rodando')}`
  if (attention > 0) tooltip += ` · ${plural(attention, 'esperando você', 'esperando você')}`
  return { items, tooltip, running, attention, badge: attention > 0 ? 'attention' : running > 0 ? 'active' : 'none' }
}
