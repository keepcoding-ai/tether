// The desk map the app tells the daemon (`desk-map`): which panes sit in which desk, read off the layout the app is about to
// save. Pure: no DOM, no daemon. The sender decides when the map goes (changed since the last one, or forced by a reconnection).
import type { DeskMap, DeskMapDesk } from '../../../src/daemon/protocol.ts'
import type { DeskLayout, DrawerLayout, Layout } from '../layout.ts'

/** The type a pane reports: 'terminal' for a slot's pane, else the id of its pane type. */
export type PaneTypeOf = (component: string) => string

interface FramePanels { panels?: Record<string, { contentComponent?: string } | undefined> }

/** Every pane of a desk's (or the drawer's) frames, in a stable order (by id), so the same panes always make the same text. */
function panesOf(frames: DeskLayout['frames'] | DrawerLayout['frames'], typeOf: PaneTypeOf): { id: string; type: string }[] {
  const out: { id: string; type: string }[] = []
  for (const view of Object.values(frames?.views ?? {})) {
    const panels = (view as FramePanels | undefined)?.panels ?? {}
    for (const [id, p] of Object.entries(panels)) out.push({ id, type: typeOf(p?.contentComponent ?? 'terminal') })
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * The map of a layout: the queue desks, then the system desks, then the drawer. `nameOf` names a system desk (the layout
 * keeps no name for it); a desk with no name falls back to its id.
 */
export function deskMapOf(layout: Layout, typeOf: PaneTypeOf, nameOf: (systemDeskId: string) => string | undefined = () => undefined): DeskMap {
  const desks: DeskMapDesk[] = layout.desks.map(d => ({
    id: d.id,
    name: d.name || d.id,
    kind: 'queue' as const,
    ...(d.asleep === true ? { asleep: true as const } : {}),
    panes: panesOf(d.frames, typeOf),
  }))
  for (const [id, sd] of Object.entries(layout.systemDesks ?? {})) {
    desks.push({ id, name: nameOf(id) || id, kind: 'system', panes: panesOf(sd.frames, typeOf) })
  }
  return { desks, drawer: layout.drawer ? panesOf(layout.drawer.frames, typeOf) : [] }
}

/** The text two maps are compared by. */
export const mapSignature = (map: DeskMap): string => JSON.stringify(map)

/** Whether the map goes to the daemon: it changed since the last one that went, or the connection was renewed (`force`). */
export function shouldSendMap(lastSent: string | undefined, map: DeskMap, force = false): boolean {
  return force || lastSent === undefined || mapSignature(map) !== lastSent
}

/** Remembers the last map that went and says whether the next one must. */
export class DeskMapSender {
  private last: string | undefined

  private readonly send: (map: DeskMap) => void

  constructor(send: (map: DeskMap) => void) { this.send = send }

  /** The layout was saved (or the app has just restored it): sends `map` when it changed, or always when `force`. */
  offer(map: DeskMap, force = false): boolean {
    if (!shouldSendMap(this.last, map, force)) return false
    this.last = mapSignature(map)
    this.send(map)
    return true
  }

  /** A reconnection: the daemon may have lost the map (a new tetherd), so the next offer goes whatever it holds. */
  reconnected(): void { this.last = undefined }
}
