// The loading stage a pane shows between "the layout painted it" and "its terminal is attached and has
// output". Pure (unit-tested): the panel feeds what it knows, this says which stage — or none, when the pane
// should show its terminal or one of its situation overlays (error, unconfirmed, exited).
import type { SlotKind, SlotState } from '../../src/daemon/protocol.ts'
import type { IconName } from './icons.ts'

/** What the pane paints from the layout file before the daemon answers (kept in the pane's params). */
export interface PaneHint {
  kind: SlotKind
  cwd?: string
  profileName?: string
  unsafe?: boolean
}

export type LoadingStageId = 'connecting' | 'resuming' | 'starting-agent' | 'queued' | 'opening'

export interface LoadingStage {
  id: LoadingStageId
  icon: IconName
  text: string
}

export interface LoadingInput {
  /** The daemon answered and its slot list is known. */
  daemonReady: boolean
  slot: SlotState | undefined
  /** The layout's hint (kind) while the slot is not known yet. */
  hint?: PaneHint
  /** A `start` is in flight for this pane. */
  startPending: boolean
  /** The pane has a refused start the overlay explains. */
  startError: boolean
  /** 1-based place in the start queue, when known. */
  queuePosition?: number
  /** The terminal is attached and showed its first output (or there is nothing more to wait for). */
  ready: boolean
}

const AGENT_NAME: Record<SlotKind, string> = { claude: 'Claude', soul: 'soul', shell: 'shell' }

/** The pane's loading stage, or undefined when the terminal (or a situation overlay) should show. */
export function loadingStage(i: LoadingInput): LoadingStage | undefined {
  if (!i.daemonReady) return { id: 'connecting', icon: 'plugs', text: 'Conectando ao serviço…' }
  const s = i.slot
  if (!s) return undefined // the daemon does not know the pane: the "slot desconhecido" overlay
  if (i.startError) return undefined
  if (s.status === 'error' || s.restarting) return undefined
  if (s.status === 'exited' && s.binding && !s.binding.confirmed) return undefined // unconfirmed: the user chooses
  if (s.status === 'queued') {
    return { id: 'queued', icon: 'hourglass', text: i.queuePosition ? `Na fila (Nº ${i.queuePosition})` : 'Na fila' }
  }
  const coming = s.status === 'starting' || s.status === 'running' || (s.status === 'exited' && i.startPending)
  if (!coming) return undefined // exited with nothing in flight: the "terminou" overlay
  if (i.ready) return undefined
  if (s.kind === 'shell') return { id: 'opening', icon: 'terminal-window', text: 'Abrindo terminal…' }
  const name = AGENT_NAME[s.kind]
  if (s.binding?.sessionId) return { id: 'resuming', icon: 'clock-counter-clockwise', text: `Retomando sessão do ${name}…` }
  return { id: 'starting-agent', icon: s.kind === 'soul' ? 'ghost' : 'sparkle', text: `Iniciando o ${name}…` }
}

/** The hint to keep in the layout for a slot (only what the chrome paints). */
export function hintOf(s: SlotState): PaneHint {
  return {
    kind: s.kind,
    cwd: s.cwd,
    ...(s.profileName ? { profileName: s.profileName } : {}),
    ...(s.unsafe ? { unsafe: true } : {}),
  }
}

export function sameHint(a: PaneHint | undefined, b: PaneHint): boolean {
  return !!a && a.kind === b.kind && a.cwd === b.cwd && a.profileName === b.profileName && !!a.unsafe === !!b.unsafe
}

/**
 * Renderer-side queue order: the daemon queues FIFO and announces each queued slot with a `state` event, so
 * the order those events arrive is the queue's order. Slots already queued when the list arrives keep the
 * list order. (A start queued by another client still counts: the daemon broadcasts every state.)
 */
export class QueueOrder {
  private order: string[] = []

  update(slotId: string, queued: boolean): void {
    const i = this.order.indexOf(slotId)
    if (queued && i < 0) this.order.push(slotId)
    else if (!queued && i >= 0) this.order.splice(i, 1)
  }

  position(slotId: string): number | undefined {
    const i = this.order.indexOf(slotId)
    return i < 0 ? undefined : i + 1
  }

  clear(): void { this.order = [] }
}
