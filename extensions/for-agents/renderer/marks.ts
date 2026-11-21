// The marks of ownership in the app: reads `objects` (this extension's space), the desks and the agents, asks the view model
// (view-model.ts) what each pill and tab should show, and puts it through the seams of the app (setSeal, setEmblems,
// setTabLine, setHeadItem). The extension draws what the data says; who decides is the daemon. Redraw is by event, coalesced
// into one pass, and only what changed reaches the app. Nothing here activates a pane, switches a desk or raises attention.
import type { TetherUi } from '../../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import { OBJECT_KEYS, type Hand, type LastAct, type Ownership } from '../rules.ts'
import { computeView, type PaneMarks, type SealMark, type ViewInput } from './view-model.ts'

/** The mirror of `objects` as the view model reads it. */
function readInput(ui: TetherUi): ViewInput {
  const deskOf = new Map<string, string>()
  const desks = ui.desks.list()
  for (const d of desks) for (const id of d.panes) deskOf.set(id, d.id)
  const map = <T>(kind: 'desk' | 'pane', key: string): Map<string, T> => new Map(ui.objects.entries<T>(kind, key))
  return {
    panes: ui.panes.all().map(p => ({ id: p.id, type: p.type, deskId: deskOf.get(p.id) })),
    desks,
    paneOwner: map<Ownership>('pane', OBJECT_KEYS.owner),
    paneHand: map<Hand>('pane', OBJECT_KEYS.hand),
    paneLast: map<LastAct>('pane', OBJECT_KEYS.last),
    frozen: new Set(ui.objects.entries('pane', OBJECT_KEYS.frozen).map(([id]) => id)),
    deskOwner: map<Ownership>('desk', OBJECT_KEYS.owner),
    deskHand: map<Hand>('desk', OBJECT_KEYS.hand),
    nameOf: id => ui.agents.get(id)?.name,
  }
}

export function marks(ui: TetherUi): IDisposable[] {
  // What is on the app now, as JSON, so a pass touches only what differs.
  const seals = new Map<string, string>()
  const paneEmblems = new Map<string, string>()
  const paneLines = new Map<string, string>()
  const paneHeads = new Map<string, string>()
  let disposed = false
  let queued = false

  const putSeal = (deskId: string, m: SealMark): void => {
    const { focus, ...rest } = m
    ui.desks.setSeal(deskId, { ...rest, ...(focus !== undefined ? { onActivate: () => { ui.agents.focus(focus) } } : {}) })
  }

  const apply = (): void => {
    if (disposed) return
    const view = computeView(readInput(ui))

    for (const [id, m] of view.seals) {
      const key = JSON.stringify(m)
      if (seals.get(id) === key) continue
      seals.set(id, key)
      putSeal(id, m)
    }
    for (const id of [...seals.keys()]) if (!view.seals.has(id)) { seals.delete(id); ui.desks.setSeal(id, undefined) }

    const empty: PaneMarks = { emblems: [] }
    const ids = new Set([...view.panes.keys(), ...paneEmblems.keys(), ...paneLines.keys(), ...paneHeads.keys()])
    for (const id of ids) {
      const m = view.panes.get(id) ?? empty
      const emblems = m.emblems.length > 0 ? JSON.stringify(m.emblems) : ''
      if ((paneEmblems.get(id) ?? '') !== emblems) {
        if (emblems) { paneEmblems.set(id, emblems); ui.panes.setEmblems(id, m.emblems) } else { paneEmblems.delete(id); ui.panes.setEmblems(id, undefined) }
      }
      const line = m.line === undefined ? '' : String(m.line)
      if ((paneLines.get(id) ?? '') !== line) {
        if (line) { paneLines.set(id, line); ui.panes.setTabLine(id, m.line) } else { paneLines.delete(id); ui.panes.setTabLine(id, undefined) }
      }
      const head = m.head ? JSON.stringify(m.head) : ''
      if ((paneHeads.get(id) ?? '') !== head) {
        if (m.head) {
          paneHeads.set(id, head)
          ui.panes.setHeadItem(id, { ...m.head, onActivate: anchor => { const r = anchor.getBoundingClientRect(); ui.panes.showTabMenu(id, r.left, r.bottom, anchor) } })
        } else { paneHeads.delete(id); ui.panes.setHeadItem(id, undefined) }
      }
    }
  }

  const schedule = (): void => {
    if (queued || disposed) return
    queued = true
    queueMicrotask(() => { queued = false; apply() })
  }

  apply()
  return [
    ui.objects.onDidChange(schedule),
    ui.desks.onDidChange(schedule),
    ui.agents.onDidChange(schedule),
    ui.panes.onDidChangeActive(schedule),
    { dispose() {
      disposed = true
      for (const id of seals.keys()) ui.desks.setSeal(id, undefined)
      for (const id of paneEmblems.keys()) ui.panes.setEmblems(id, undefined)
      for (const id of paneLines.keys()) ui.panes.setTabLine(id, undefined)
      for (const id of paneHeads.keys()) ui.panes.setHeadItem(id, undefined)
      seals.clear(); paneEmblems.clear(); paneLines.clear(); paneHeads.clear()
    } },
  ]
}
