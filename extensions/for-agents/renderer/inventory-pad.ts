// The inventory pad (tether for agents): "O que <dono> pode · <mesa>". A pad of the side bar (scope global, absorbing its header:
// the title carries the owner's name, which the manifest cannot) with a top bar (title; "Ligar tudo" pinned with text; "Ir para"
// pinned as icon) and a free content area planned from the inventory itself: the desk's lines, the panes that differ with
// "herdar", the panes of another owner. It reads `objects` and writes `inventory` on a desk or a pane; the daemon's verbs
// answer `off` from that same data. The command `for-agents.inventory` (`{ kind, id }`) opens it on a desk or on a pane's
// line; opening only draws the pad: it activates no pane and switches no desk. With no target it follows the desk on screen.
import { createActionBar, type ActionBar } from '../../../app/renderer/action-bar.ts'
import type { ContextMenuEntry, PadHost, PadView, TetherUi } from '../../../app/renderer/ext-api.ts'
import { icon } from '../../../app/renderer/icons.ts'
import { identityMark } from '../../../app/renderer/agent-identity.ts'
import { identityOf } from '../../../app/renderer/agent-identity-rules.ts'
import type { IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import { OBJECT_KEYS, type Inventory } from '../rules.ts'
import {
  T, allOnWrites, asInventory, inventoryModel, nextPaneState, ownerLetter, withDeskItem, withPaneItem,
  type InventoryFacts, type InventoryModel, type PadTarget,
} from './inventory-rules.ts'
import { readFacts, type Target } from './menus.ts'
import { agentHue } from '../../../app/shared/agent-color.ts'

export const INVENTORY_PAD = 'for-agents.inventory'
export const INVENTORY_COMMAND = 'for-agents.inventory'

type Ui = TetherUi

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function readInventoryFacts(ui: Ui): InventoryFacts {
  const inv = (kind: 'desk' | 'pane'): Map<string, Inventory> => {
    const out = new Map<string, Inventory>()
    for (const [id, v] of ui.objects.entries<unknown>(kind, OBJECT_KEYS.inventory)) { const i = asInventory(v); if (i) out.set(id, i) }
    return out
  }
  return { ...readFacts(ui), deskInv: inv('desk'), paneInv: inv('pane') }
}

/** The pad and its command; returns what to dispose. */
export function inventoryPad(ui: Ui): IDisposable[] {
  // What a command asked for, and the desk on screen then: asking is for the moment, so changing desk lets it go.
  let pin: { target: PadTarget; activeDesk: string } | undefined
  const views = new Set<View>()
  const warn = (what: string) => (e: unknown): void => { console.error(`for-agents: inventário: ${what}: ${(e as Error).message}`) }

  /** The target the pad draws now. */
  const targetNow = (): PadTarget => {
    if (pin && pin.activeDesk === ui.desks.activeId()) return pin.target
    pin = undefined
    return { deskId: ui.desks.activeId() }
  }
  const write = (kind: 'desk' | 'pane', id: string, value: Inventory | undefined): void => {
    ui.objects.set(kind, id, OBJECT_KEYS.inventory, value).catch(warn(`gravar ${kind} ${id}`))
  }

  class View implements PadView {
    readonly element = el('div', 'fa-inv')
    /** The owner of the desk: [engine icon] [emblem or letter], before the title that names it. */
    private readonly lead = el('span', 'fa-inv-lead')
    private readonly title = el('span', 'fa-inv-title')
    private readonly bar: ActionBar
    private readonly body = el('div', 'fa-inv-body')
    private model: InventoryModel | undefined
    private queued = false
    private disposed = false
    private readonly subs: IDisposable[]
    private readonly host: PadHost

    constructor(host: PadHost) {
      this.host = host
      this.bar = createActionBar({
        entries: () => this.menu(),
        label: 'Ações do inventário',
        align: 'end',
        openMenu: (x, y) => ui.menus.context(x, y, [...host.menuItems(), 'sep', ...this.menu()]),
      })
      const top = el('div', 'fa-inv-top')
      top.append(this.lead, this.title, this.bar.element)
      this.element.append(top, this.body)
      host.setMenuHosted(true)
      this.subs = [
        ui.objects.onDidChange(() => this.schedule()),
        ui.desks.onDidChange(() => this.schedule()),
        ui.agents.onDidChange(() => this.schedule()),
      ]
      views.add(this)
      this.render()
    }

    /** One pass per burst of events. */
    schedule(): void {
      if (this.queued || this.disposed) return
      this.queued = true
      queueMicrotask(() => { this.queued = false; if (!this.disposed) this.render() })
    }

    focus(): void { this.body.querySelector<HTMLElement>('button:not(:disabled)')?.focus() }

    menu(): ContextMenuEntry[] {
      const m = this.model
      if (!m) return []
      const out: ContextMenuEntry[] = []
      if (m.owner) { const id = m.owner.id; out.push({ icon: 'arrow-square-out', label: T.goTo(m.owner.name), pin: 'icon', run: () => { ui.agents.focus(id) } }) }
      out.push({ icon: 'arrow-counter-clockwise', label: T.allOn, pin: 'primary', disabled: m.writes.length === 0, run: () => this.allOn() })
      return out
    }

    private allOn(): void {
      if (!this.model) return
      for (const w of this.model.writes) write(w.kind, w.id, w.value)
    }

    private render(): void {
      const facts = readInventoryFacts(ui)
      const m = inventoryModel(facts, targetNow())
      this.model = m
      const keep = this.body.scrollTop
      const focused = this.body.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.key : undefined
      this.title.textContent = m.title
      this.title.title = m.title
      this.paintLead(m.owner)
      this.body.replaceChildren(...this.sections(m, facts))
      this.body.scrollTop = keep
      if (focused) this.body.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus()
      this.bar.refresh()
      this.host.menuChanged()
    }

    /** The pair of an agent the app knows (undefined for an owner with no pane). */
    private pairOf(id: string, name: string): HTMLElement | undefined {
      const pane = ui.agents.get(id)
      return pane ? identityMark(identityOf({ kind: pane.kind, name, seed: id, emblem: ui.panes.personEmblem(id) })) : undefined
    }

    private paintLead(owner: { id: string; name: string } | undefined): void {
      const pair = owner ? this.pairOf(owner.id, owner.name) : undefined
      if (pair) this.lead.replaceChildren(pair); else this.lead.replaceChildren()
    }

    private sections(m: InventoryModel, facts: InventoryFacts): HTMLElement[] {
      const out: HTMLElement[] = []
      if (m.free && m.free.text) {
        const box = el('div', 'fa-inv-free')
        box.append(el('p', undefined, m.free.text))
        if (m.free.canGive && m.deskId !== undefined) {
          const b = el('button', 'fa-link')
          b.type = 'button'
          b.dataset.key = 'give-desk'
          b.append(icon('robot'), document.createTextNode(T.giveDesk))
          const target: Target = { kind: 'desk', id: m.deskId }
          b.addEventListener('click', () => { void ui.commands.run('for-agents.give', target) })
          box.append(b)
        }
        out.push(box)
      }
      if (m.deskLines.length > 0 && (!m.free || m.deskStored)) {
        out.push(el('h4', 'fa-sec', m.deskStored ? T.storedWhileFree : m.deskHeading))
        for (const l of m.deskLines) {
          const row = el('div', 'fa-row')
          row.dataset.line = `desk:${l.cap}`
          const tg = this.switchEl(`desk:${l.cap}`, l.on, false, l.on ? T.on : T.off)
          tg.addEventListener('click', () => {
            if (m.deskId === undefined) return
            write('desk', m.deskId, withDeskItem(facts.deskInv.get(m.deskId), l.cap, !l.on))
          })
          row.append(el('span', 'fa-grow', l.label), tg)
          out.push(row)
        }
      }
      if (m.focus) {
        const f = m.focus
        const head = el('h4', 'fa-sec', T.paneHeading(f.title))
        out.push(head, el('div', 'fa-row fa-note', f.outside ? `${f.note} · ${T.paneOutside}` : f.note))
        for (const it of f.items) {
          const row = el('div', 'fa-row')
          row.dataset.line = `pane:${it.cap}`
          const label = it.state === 'desk' ? T.state.desk(it.deskOn) : it.state === 'on' ? T.state.on : T.state.off
          const tg = this.switchEl(`pane:${it.cap}`, it.on, it.state === 'desk', label)
          tg.addEventListener('click', () => write('pane', f.paneId, withPaneItem(facts.paneInv.get(f.paneId), it.cap, nextPaneState(it))))
          row.append(el('span', 'fa-grow', it.label), tg)
          if (it.state !== 'desk') row.append(this.inheritButton(`pane:${it.cap}:inherit`, () => write('pane', f.paneId, withPaneItem(facts.paneInv.get(f.paneId), it.cap, 'desk'))))
          out.push(row)
        }
      }
      if (m.exceptions.length > 0 || m.follow.count > 0) {
        if (m.exceptions.length > 0) out.push(el('h4', 'fa-sec', T.exceptions))
        for (const ex of m.exceptions) {
          const row = el('div', 'fa-row')
          row.dataset.line = `exc:${ex.paneId}:${ex.cap}`
          const grow = el('span', 'fa-grow')
          grow.append(el('b', undefined, ex.title), document.createTextNode(` · ${ex.label}`))
          const tg = this.switchEl(`exc:${ex.paneId}:${ex.cap}`, ex.state === 'on', false, ex.state === 'on' ? T.state.on : T.state.off)
          tg.addEventListener('click', () => write('pane', ex.paneId, withPaneItem(facts.paneInv.get(ex.paneId), ex.cap, ex.state === 'on' ? 'off' : 'on')))
          row.append(grow, tg, this.inheritButton(`exc:${ex.paneId}:${ex.cap}:inherit`, () => write('pane', ex.paneId, withPaneItem(facts.paneInv.get(ex.paneId), ex.cap, 'desk'))))
          out.push(row)
        }
        if (m.follow.count > 0 && m.owner) {
          const row = el('div', 'fa-row')
          row.append(el('span', 'fa-grow fa-mut', (m.follow.all ? T.followsAll : T.follows)(m.owner.name, m.follow.count)))
          out.push(row)
        }
      }
      if (m.others.length > 0) {
        out.push(el('h4', 'fa-sec', m.othersHeading))
        for (const o of m.others) {
          const row = el('div', 'fa-row fa-other')
          row.dataset.line = `other:${o.paneId}`
          row.style.setProperty('--hue', String(agentHue(o.ownerId)))
          const grow = el('span', 'fa-grow')
          grow.append(el('b', undefined, o.title), document.createTextNode(` · ${T.ofOwner(o.ownerName, o.self)} · ${o.summary}`))
          const open = el('button', 'fa-btn', T.openOf(o.ownerName))
          open.type = 'button'
          open.dataset.key = `other:${o.paneId}:open`
          // Opens that pane's own line here; it brings no pane or desk forward.
          open.addEventListener('click', () => { pin = { target: { paneId: o.paneId }, activeDesk: ui.desks.activeId() }; this.render() })
          row.append(this.pairOf(o.ownerId, o.ownerName) ?? el('span', 'fa-em', ownerLetter(o.ownerName)), grow, open)
          out.push(row)
        }
      }
      return out
    }

    private switchEl(key: string, on: boolean, inherited: boolean, text: string): HTMLButtonElement {
      const b = el('button', `fa-tg${on ? ' on' : ''}${inherited ? ' inh' : ''}`)
      b.type = 'button'
      b.dataset.key = key
      b.dataset.state = inherited ? 'desk' : on ? 'on' : 'off'
      b.setAttribute('role', 'switch')
      b.setAttribute('aria-checked', String(on))
      b.append(el('i'), document.createTextNode(text))
      return b
    }

    private inheritButton(key: string, run: () => void): HTMLButtonElement {
      const b = el('button', 'fa-btn', T.inherit)
      b.type = 'button'
      b.title = T.inheritTip
      b.dataset.key = key
      b.addEventListener('click', run)
      return b
    }

    /** The target changed by a command: draw it now. */
    refresh(): void { this.render() }

    dispose(): void {
      this.disposed = true
      views.delete(this)
      for (const s of this.subs) s.dispose()
      this.bar.dispose()
    }
  }

  const isTarget = (v: unknown): v is Target => {
    const o = v as Partial<Target> | null
    return typeof o === 'object' && o !== null && (o.kind === 'pane' || o.kind === 'desk') && typeof o.id === 'string' && o.id.length > 0
  }

  return [
    ui.pads.register({ id: INVENTORY_PAD, create: host => new View(host) }),
    ui.commands.registerCommand(INVENTORY_COMMAND, (_source, arg) => {
      const active = ui.desks.activeId()
      if (isTarget(arg)) pin = { target: arg.kind === 'desk' ? { deskId: arg.id } : { paneId: arg.id }, activeDesk: active }
      else pin = undefined
      ui.pads.open(INVENTORY_PAD)
      for (const v of views) v.refresh()
    }),
    { dispose() { pin = undefined } },
  ]
}
