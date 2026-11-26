// The Regency's columns drawn from the model: "Esperam você" and "Conversas" on the left, the faces of "Neste canal" and the
// tree "Tether" on the right, with the reserved places "Fechadas" and "Sistema". Each paint replaces its host's children;
// rows carry `data-target` (`<kind>:<id>`) and the pane handles the clicks and keys in one place (pane.ts).
import { ICON_NAMES, icon, type IconName } from '../../../app/renderer/icons.ts'
import { identityMark, identityOf, identityView, type IdentityInput } from '../../../app/renderer/agent-identity.ts'
import type { MemberRow } from '../../channels/renderer/view-model.ts'
import type { AgentGroupRow, AgentPaneRow, ConvRow, RegencyModel, Target, TreeDeskRow, TreePaneRow, WaitingItem } from '../model.ts'
import { deskRowKey, groupRowKey, paneRowKey } from './tree-keys.ts'

export interface ColumnsContext {
  /** The agent behind a pane, as the identity draws it; undefined for a pane that is not an agent's. */
  identity(paneId: string): IdentityInput | undefined
  /** What a pane's seal says (the terminal's line and the extensions' messages). */
  lines(paneId: string): readonly string[] | undefined
  /** The channel in the centre. */
  selected?: string | undefined
  /** "Encerrados" open. */
  closedOpen: boolean
  /** The channels' list has not come yet. */
  loading: boolean
}

/** What the tree is drawn by: the view, and whether a filter or a search narrows it (for the empty state). */
export interface TreeContext extends ColumnsContext {
  view: 'desk' | 'agent'
  narrowed: boolean
}

export const targetKey = (t: Target): string => `${t.kind}:${t.id}`

/** `<kind>:<id>` back to a target (the id may hold colons: `channel:x`, `web:y`). */
export function targetOf(key: string | undefined): Target | undefined {
  if (!key) return undefined
  const at = key.indexOf(':')
  if (at <= 0) return undefined
  const kind = key.slice(0, at)
  if (kind !== 'desk' && kind !== 'pane' && kind !== 'channel' && kind !== 'agent') return undefined
  return { kind, id: key.slice(at + 1) }
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/** An icon with its tooltip (every icon of the Regency says what it is). */
export function glyph(name: string, tip: string, fallback: IconName = 'circle'): HTMLElement {
  const cell = el('span', 'rg-ic')
  cell.append(icon((ICON_NAMES as readonly string[]).includes(name) ? name as IconName : fallback))
  cell.title = tip
  cell.setAttribute('role', 'img')
  cell.setAttribute('aria-label', tip)
  return cell
}

function hash(): HTMLElement {
  const h = el('span', 'rg-hash', '#')
  h.title = 'Canal'
  h.setAttribute('aria-hidden', 'true')
  return h
}

function heading(text: string, count?: number): HTMLElement {
  const hd = el('div', 'rg-hd')
  hd.append(el('span', 'rg-hd-t', text))
  if (count !== undefined && count > 0) {
    const c = el('span', 'cnt', String(count))
    c.title = `${count} esperando você`
    hd.append(c)
  }
  return hd
}

function row(cls: string, target: Target, label: string): HTMLElement {
  const r = el('div', cls)
  r.tabIndex = 0
  r.dataset.target = targetKey(target)
  r.setAttribute('role', 'button')
  r.setAttribute('aria-label', label)
  return r
}

/**
 * A row of the tree: a treeitem with its focus key (`data-key`, unique even where a group and its agent's pane share a
 * target), its kind (`data-row`) and, when it folds, its fold id. Out of the tab order: the pane gives the one roving stop.
 */
function treeRow(cls: string, target: Target, label: string, key: string, kind: 'desk' | 'group' | 'pane', level: 1 | 2): HTMLElement {
  const r = row(cls, target, label)
  r.tabIndex = -1
  r.dataset.key = key
  r.dataset.row = kind
  r.setAttribute('role', 'treeitem')
  r.setAttribute('aria-level', String(level))
  return r
}

/** The empty `.rg-acts` place the next slice fills with the row's buttons (hover and the context key). */
function acts(): HTMLElement {
  const a = el('span', 'rg-acts')
  a.setAttribute('aria-hidden', 'true')
  return a
}

function reasonText(item: WaitingItem, ctx: ColumnsContext): string {
  const n = item.count ?? 1
  switch (item.reason) {
    case 'agent-waiting': return ctx.lines(item.target.id)?.[0] ?? 'espera sua resposta'
    case 'seal': return ctx.lines(item.target.id)?.[0] ?? 'pede sua atenção'
    case 'to-you': return n === 1 ? '1 fala para você' : `${n} falas para você`
    case 'reaction-asks': return n === 1 ? 'reação pede você' : `${n} reações pedem você`
    case 'poll-owed': return n === 1 ? 'enquete espera seu voto' : `${n} enquetes esperam seu voto`
  }
}

function waitingMark(item: WaitingItem, ctx: ColumnsContext, paneIcon: (id: string) => string | undefined): HTMLElement {
  if (item.target.kind === 'channel') return hash()
  const who = ctx.identity(item.target.id)
  if (who) return identityMark(identityOf(who), { compact: true })
  return glyph(paneIcon(item.target.id) ?? 'circle', 'Guia')
}

export function paintWaiting(host: HTMLElement, model: RegencyModel, ctx: ColumnsContext): void {
  const paneIcon = (id: string): string | undefined => {
    for (const d of model.tree) for (const p of d.panes) if (p.target.id === id) return p.icon
    return undefined
  }
  const items = model.waiting
  const out: HTMLElement[] = [heading('Esperam você', items.length)]
  if (items.length === 0) out.push(el('p', 'rg-empty', 'Ninguém espera você'))
  for (const item of items) {
    const reason = reasonText(item, ctx)
    const r = row('rg-wait', item.target, `${item.label}: ${reason}`)
    r.dataset.reason = item.reason
    const name = el('span', 'rg-w1', item.label)
    name.title = item.label
    const why = el('span', 'rg-w2', reason)
    why.title = reason
    r.append(waitingMark(item, ctx, paneIcon), name, why)
    out.push(r)
  }
  host.replaceChildren(...out)
}

function convRow(c: ConvRow, ctx: ColumnsContext): HTMLElement {
  const r = row('rg-conv', c.target, `#${c.name}`)
  if (c.target.id === ctx.selected) r.setAttribute('aria-current', 'true')
  if (c.closed) r.classList.add('closed')
  const name = el('span', 'rg-t', c.name)
  name.title = c.title && c.title !== c.name ? `#${c.name} · ${c.title}` : `#${c.name}`
  const mk = el('span', 'rg-mk')
  const toMe = c.marks.toMe + c.marks.asks + c.marks.owed
  if (toMe > 0) {
    const t = el('span', 'rg-tome', 'para você')
    t.title = reasonsOf(c)
    mk.append(t)
  }
  if (c.marks.unread > 0) {
    const n = el('span', 'cnt dim', String(c.marks.unread))
    n.title = c.marks.unread === 1 ? '1 fala não lida' : `${c.marks.unread} falas não lidas`
    mk.append(n)
  }
  r.append(hash(), name, mk)
  return r
}

function reasonsOf(c: ConvRow): string {
  const parts: string[] = []
  if (c.marks.toMe) parts.push(c.marks.toMe === 1 ? '1 fala para você' : `${c.marks.toMe} falas para você`)
  if (c.marks.asks) parts.push('reação pede você')
  if (c.marks.owed) parts.push('enquete espera seu voto')
  return parts.join(' · ')
}

export function paintConversations(host: HTMLElement, model: RegencyModel, ctx: ColumnsContext): void {
  const { open, closed } = model.conversations
  const out: HTMLElement[] = [heading('Conversas')]
  if (ctx.loading && open.length === 0 && closed.length === 0) out.push(el('p', 'rg-empty', 'Carregando…'))
  else if (open.length === 0) out.push(el('p', 'rg-empty', 'Nenhuma conversa aberta'))
  for (const c of open) out.push(convRow(c, ctx))
  if (closed.length > 0) {
    const tg = el('button', 'rg-tg')
    tg.type = 'button'
    tg.dataset.action = 'closed'
    tg.setAttribute('aria-expanded', String(ctx.closedOpen))
    tg.append(glyph(ctx.closedOpen ? 'caret-down' : 'caret-right', ctx.closedOpen ? 'Recolher' : 'Mostrar'), el('span', '', `Encerrados · ${closed.length}`))
    out.push(tg)
    if (ctx.closedOpen) for (const c of closed) out.push(convRow(c, ctx))
  }
  host.replaceChildren(...out)
}

/** The faces of "Neste canal" (folded): the agents' marks, each with its name as tooltip. */
export function paintFaces(host: HTMLElement, members: readonly MemberRow[], ctx: ColumnsContext): void {
  host.replaceChildren(...members.map(m => {
    const who = ctx.identity(m.id) ?? { kind: '', name: m.name, seed: m.id, emblem: m.emblem }
    const face = el('span', 'rg-face')
    face.dataset.member = m.id
    face.title = m.name
    face.append(identityMark(identityOf({ ...who, emblem: m.emblem ?? who.emblem }), { compact: true }))
    return face
  }))
}

interface PaneState { text: string; cls: string }

/** The pane's state in the tree: the ended, the asleep, who waits for the person, who works; an agent at rest "parado". */
export function paneStateOf(p: TreePaneRow): PaneState | undefined {
  if (p.exited) return { text: 'encerrado', cls: 'off' }
  if (p.asleep) return { text: 'dormindo', cls: 'zz' }
  if (p.attention === 'waiting') return { text: 'espera você', cls: 'wait' }
  if (p.busy) return { text: 'trabalhando', cls: 'work' }
  if (p.identity) return { text: p.attention === 'done' ? 'terminou' : 'parado', cls: 'idle' }
  return undefined
}

const DESK_KIND: Record<TreeDeskRow['kind'], { icon: string; tip: string }> = {
  queue: { icon: 'cards', tip: 'Mesa' },
  system: { icon: 'app-window', tip: 'Mesa de sistema' },
  drawer: { icon: 'tray', tip: 'Gaveta' },
}

function ownerSeal(name: string, what: string): HTMLElement {
  const s = el('span', 'rg-own')
  s.title = `Dono ${what}: ${name}`
  s.append(icon('crown-simple'), el('span', '', name))
  return s
}

function deskRow(d: TreeDeskRow): HTMLElement {
  const r = treeRow('rg-desk', d.target, `${d.name}, ${d.paneCount} guias`, deskRowKey(d.target.id), 'desk', 1)
  r.dataset.fold = d.target.id
  if (d.paneCount > 0) r.setAttribute('aria-expanded', String(!d.collapsed))
  else r.classList.add('rg-nofold')
  if (d.asleep) r.classList.add('zz')
  r.style.setProperty('--rg-desk', `var(--x-${d.color}, var(--accent))`)
  const kind = DESK_KIND[d.kind]
  const dot = el('span', 'rg-dot')
  dot.title = `Cor da mesa: ${d.color}`
  r.append(
    glyph(d.collapsed ? 'caret-right' : 'caret-down', d.collapsed ? 'Mostrar as guias' : 'Recolher as guias'),
    dot,
    glyph(d.icon ?? kind.icon, kind.tip),
    el('span', 'rg-dn', d.name),
  )
  if (d.owner) r.append(ownerSeal(d.owner, 'da mesa'))
  const n = el('span', 'rg-n2', `${d.paneCount} guia${d.paneCount === 1 ? '' : 's'}${d.asleep ? ' · dormindo' : ''}`)
  r.append(n, el('span', 'rg-sp'), acts())
  return r
}

/** The desk's badge on a pane of the by-agent view: its colour and its name. */
function deskBadge(name: string, color: string): HTMLElement {
  const b = el('span', 'rg-dsk')
  b.title = `Na mesa ${name}`
  b.style.setProperty('--rg-desk', `var(--x-${color}, var(--accent))`)
  b.append(el('span', 'rg-dot'), el('span', '', name))
  return b
}

function paneRow(p: TreePaneRow | AgentPaneRow, ctx: ColumnsContext): HTMLElement {
  const r = treeRow('rg-pane', p.target, p.title, paneRowKey(p.target), 'pane', 2)
  const state = paneStateOf(p)
  if (state) r.dataset.state = state.cls
  if (p.asleep || p.exited) r.classList.add('zz')
  if (p.identity) {
    const who = ctx.identity(p.target.id) ?? { kind: p.identity.kind, name: p.identity.name, seed: p.target.id, emblem: p.identity.emblem as IdentityInput['emblem'] }
    r.append(identityView(who))
    if (p.title && p.title !== p.identity.name) r.append(el('span', 'rg-sub', p.title))
  } else {
    r.append(glyph(p.icon, p.type), el('span', 'rg-gn', p.title))
  }
  if ('deskName' in p) r.append(deskBadge(p.deskName, p.deskColor))
  else if (p.ownerBadge) r.append(ownerSeal(p.ownerBadge, 'da guia'))
  r.append(el('span', 'rg-sp'))
  if (state) {
    const st = el('span', `rg-st ${state.cls}`, state.text)
    st.title = state.text
    r.append(st)
  }
  r.append(acts())
  return r
}

/** The head of an agent's group in the by-agent view: its identity (or "Você"), how many panes, the fold. */
function groupRow(g: AgentGroupRow, ctx: ColumnsContext): HTMLElement {
  const r = treeRow('rg-agent', g.target, `${g.name}, ${g.paneCount} guias`, groupRowKey(g.target.id), 'group', 1)
  r.dataset.fold = g.target.id
  if (g.paneCount > 0) r.setAttribute('aria-expanded', String(!g.collapsed))
  else r.classList.add('rg-nofold')
  r.append(glyph(g.collapsed ? 'caret-right' : 'caret-down', g.collapsed ? 'Mostrar as guias' : 'Recolher as guias'))
  if (g.you) {
    const me = el('span', 'aid-letter rg-me', 'V')
    me.title = 'Você: o que não é de nenhum agente'
    r.append(me, el('span', 'rg-dn', g.name))
  } else {
    r.append(identityView(ctx.identity(g.target.id) ?? { kind: '', name: g.name, seed: g.target.id }))
  }
  r.append(el('span', 'rg-n2', `${g.paneCount} guia${g.paneCount === 1 ? '' : 's'}`), el('span', 'rg-sp'), acts())
  return r
}

/** "Nada com esse filtro": the sentence and the way out. */
function nothingShown(): HTMLElement {
  const box = el('div', 'rg-none')
  const clear = el('button', 'rg-btn')
  clear.type = 'button'
  clear.dataset.action = 'clear-narrow'
  clear.title = 'Limpar o filtro e a busca'
  clear.textContent = 'Limpar filtro e busca'
  box.append(el('p', 'rg-empty', 'Nada com esse filtro'), clear)
  return box
}

export function paintTree(host: HTMLElement, model: RegencyModel, ctx: TreeContext): void {
  const out: HTMLElement[] = []
  if (ctx.view === 'desk') {
    for (const d of model.tree) {
      const group = el('div', 'rg-group')
      group.setAttribute('role', 'none')
      group.dataset.desk = d.target.id
      group.dataset.kind = d.kind
      group.append(deskRow(d))
      // Folded or not, the desk says when someone in it waits for the person.
      if (model.waiting.some(w => w.desk?.id === d.target.id)) group.querySelector('.rg-sp')?.after(attnDot())
      for (const p of d.panes) group.append(paneRow(p, ctx))
      out.push(group)
    }
  } else {
    for (const g of model.byAgent) {
      const group = el('div', 'rg-group')
      group.setAttribute('role', 'none')
      group.dataset.agent = g.target.id
      group.append(groupRow(g, ctx))
      const ids = new Set(g.panes.map(p => p.target.id))
      if (g.panes.some(p => p.attention === 'waiting') || (g.collapsed && model.waiting.some(w => ids.has(w.target.id)))) group.querySelector('.rg-sp')?.after(attnDot())
      for (const p of g.panes) group.append(paneRow(p, ctx))
      out.push(group)
    }
  }
  if (ctx.narrowed && out.length === 0 && model.closed.count === 0) out.push(nothingShown())
  host.replaceChildren(...out)
}

function attnDot(): HTMLElement {
  const d = el('span', 'rg-attn')
  d.title = 'Alguém nesta mesa espera você'
  return d
}

/** "Fechadas" and "Sistema": their places, shown and off (they come in a later slice). */
export function paintReserved(host: HTMLElement): void {
  const place = (iconName: string, label: string, place: string): HTMLElement => {
    const b = el('div', 'rg-reserved-row')
    b.dataset.place = place
    b.setAttribute('aria-disabled', 'true')
    b.title = `${label}: em breve`
    b.append(glyph(iconName, label), el('span', '', label))
    return b
  }
  host.replaceChildren(place('clock-counter-clockwise', 'Fechadas', 'closed'), place('gear-six', 'Sistema', 'system'))
}
