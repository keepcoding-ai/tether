// The Regency's columns drawn from the model: "Esperam você" and "Conversas" on the left, the faces of "Neste canal" and the
// tree "Tether" on the right, with "Fechadas" at its foot ("Sistema" is the pane's own: system-view.ts). Each paint replaces its host's children;
// rows carry `data-target` (`<kind>:<id>`) and the pane handles the clicks and keys in one place (pane.ts).
import { ICON_NAMES, icon, type IconName } from '../../../app/renderer/icons.ts'
import { identityMark, identityOf, identityView, type IdentityInput } from '../../../app/renderer/agent-identity.ts'
import type { MemberRow } from '../../channels/renderer/view-model.ts'
import { formatAgo } from '../../../app/renderer/sessions-rules.ts'
import { PANE_MARK_TEXT, PANE_STATE_TEXT, stateShown } from '../../../app/shared/pane-state.ts'
import { CLOSED_ID, type AgentGroupRow, type AgentPaneRow, type ClosedRow, type ConvRow, type RegencyModel, type Target, type TreeDeskRow, type TreePaneRow, type WaitingItem } from '../model.ts'
import { CLOSED_HEAD_KEY, closedRowKey, deskRowKey, groupRowKey, paneRowKey } from './tree-keys.ts'

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
  /** On the phone the list sits over the conversation and folds: whether it is open (absent: it does not fold). */
  convsOpen?: boolean | undefined
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
  if (kind !== 'desk' && kind !== 'pane' && kind !== 'channel' && kind !== 'agent' && kind !== 'session') return undefined
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
    c.title = count === 1 ? '1 espera você' : `${count} esperam você`
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
function treeRow(cls: string, target: Target, label: string, key: string, kind: 'desk' | 'group' | 'agent' | 'pane' | 'closed-head' | 'closed', level: 1 | 2): HTMLElement {
  const r = row(cls, target, label)
  r.tabIndex = -1
  r.dataset.key = key
  r.dataset.row = kind
  r.setAttribute('role', 'treeitem')
  r.setAttribute('aria-level', String(level))
  return r
}

/** A button of a row's `.rg-acts` (the pane reads `data-action`; a click on it never folds nor goes to the row's target). */
export interface RowAct { action: 'row-menu' | 'row-talk' | 'row-sleep' | 'row-wake' | 'row-new'; icon: string; tip: string }

const MENU_ACT: RowAct = { action: 'row-menu', icon: 'dots-three', tip: 'Mais ações (menu da linha)' }

/**
 * The row's buttons, at its right end: shown on hover and while the row has the keyboard (always on the phone, as 44 px
 * targets). Out of the tab order: the tree keeps its one roving stop, and the keyboard has the Menu key and Shift+F10.
 */
function acts(list: readonly RowAct[] = []): HTMLElement {
  const a = el('span', 'rg-acts')
  for (const act of list) {
    const b = el('button', 'rg-act')
    b.type = 'button'
    b.tabIndex = -1
    b.dataset.action = act.action
    b.title = act.tip
    b.setAttribute('aria-label', act.tip)
    if (act.action === 'row-menu') b.setAttribute('aria-haspopup', 'menu')
    const g = glyph(act.icon, act.tip)
    g.removeAttribute('title')
    g.setAttribute('aria-hidden', 'true')
    g.removeAttribute('role')
    g.removeAttribute('aria-label')
    b.append(g)
    a.append(b)
  }
  return a
}

/** The seal's own word for the terminal's wait (seal-rules.ts attentionLines): the Regency says its state "espera você" instead. */
const CORE_WAITING_LINE = 'Esperando você'

function reasonText(item: WaitingItem, ctx: ColumnsContext): string {
  const n = item.count ?? 1
  const said = (): string | undefined => ctx.lines(item.target.id)?.find(l => l !== CORE_WAITING_LINE)
  switch (item.reason) {
    case 'agent-waiting': return said() ?? PANE_STATE_TEXT.waiting
    case 'seal': return said() ?? PANE_STATE_TEXT.waiting
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
  if (ctx.convsOpen !== undefined && !ctx.convsOpen) { host.replaceChildren(convsToggle(model, ctx)); return }
  const out: HTMLElement[] = [ctx.convsOpen !== undefined ? convsToggle(model, ctx) : heading('Conversas')]
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

/** The phone's head of "Conversas": it folds the list over the conversation; folded, it names the conversation shown. */
function convsToggle(model: RegencyModel, ctx: ColumnsContext): HTMLElement {
  const { open, closed } = model.conversations
  const on = ctx.convsOpen === true
  const tg = el('button', 'rg-tg rg-convs-tg')
  tg.type = 'button'
  tg.dataset.action = 'convs'
  tg.setAttribute('aria-expanded', String(on))
  tg.append(glyph(on ? 'caret-down' : 'caret-right', on ? 'Recolher as conversas' : 'Mostrar as conversas'), el('span', '', `Conversas · ${open.length}`))
  const chosen = [...open, ...closed].find(c => c.target.id === ctx.selected)
  if (chosen && !on) tg.append(el('span', 'rg-convs-now', `#${chosen.name}`))
  return tg
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

interface StateText { text: string; cls: string }

const STATE_CLASS: Record<TreePaneRow['state'], string> = { waiting: 'wait', busy: 'work', idle: 'idle', asleep: 'zz' }

/**
 * The words of the pane's one state (the model's `state` and `mark`, app/shared/pane-state.ts): the same the filter reads and
 * the quick view's card says. A free pane that is not an agent's says nothing (a note is not "livre"), unless its process ended.
 */
export function paneStateOf(p: TreePaneRow): StateText | undefined {
  if (!stateShown(p, p.identity !== undefined)) return undefined
  const text = p.mark ? PANE_MARK_TEXT[p.mark] : PANE_STATE_TEXT[p.state]
  return { text, cls: p.mark === 'ended' ? 'off' : STATE_CLASS[p.state] }
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
  r.append(
    glyph(d.collapsed ? 'caret-right' : 'caret-down', d.collapsed ? 'Mostrar as guias' : 'Recolher as guias'),
    swatch(d.color),
    glyph(d.icon ?? kind.icon, kind.tip),
    el('span', 'rg-dn', d.name),
  )
  if (d.owner) r.append(ownerSeal(d.owner, 'da mesa'))
  const n = el('span', 'rg-n2', `${d.paneCount} guia${d.paneCount === 1 ? '' : 's'}${d.asleep ? ' · dormindo' : ''}`)
  // Only a desk of the queue sleeps; Browser and the drawer have the menu alone ("Ir até a mesa").
  const sleep: RowAct[] = d.kind !== 'queue' ? [] : d.asleep
    ? [{ action: 'row-wake', icon: 'sun', tip: `Acordar a mesa ${d.name}` }]
    : [{ action: 'row-sleep', icon: 'moon', tip: `Pôr a mesa ${d.name} para dormir` }]
  // "+": a new pane in this desk (the "+ Novo" card with the desk fixed); only an awake desk of the queue takes one.
  const add: RowAct[] = d.kind === 'queue' && !d.asleep ? [{ action: 'row-new', icon: 'plus', tip: `Nova guia na mesa ${d.name}` }] : []
  r.append(n, el('span', 'rg-sp'), acts([...add, ...sleep, MENU_ACT]))
  return r
}

/**
 * A desk's colour: a small square (the round dot is only ever a state). It reads the `--rg-desk` of the element it sits in.
 */
function swatch(color: string): HTMLElement {
  const s = el('span', 'rg-swatch')
  s.title = `Cor da mesa: ${color}`
  return s
}

/** The desk's badge on a pane of the by-agent view: its colour and its name. */
function deskBadge(name: string, color: string): HTMLElement {
  const b = el('span', 'rg-dsk')
  b.title = `Na mesa ${name}`
  b.style.setProperty('--rg-desk', `var(--x-${color}, var(--accent))`)
  const s = swatch(color)
  s.removeAttribute('title')
  b.append(s, el('span', '', name))
  return b
}

/**
 * A pane's line. With `group` it is an agent's group head: the same line (identity, desk badge, state) at level 1, with the
 * fold caret first and what the agent has counted at the end; its click goes to the pane, the caret folds.
 */
function paneRow(p: TreePaneRow | AgentPaneRow, ctx: ColumnsContext, group?: AgentGroupRow): HTMLElement {
  const r = group
    ? treeRow('rg-pane rg-agent', p.target, `${p.title}, ${group.paneCount} guias`, paneRowKey(p.target), 'agent', 1)
    : treeRow('rg-pane', p.target, p.title, paneRowKey(p.target), 'pane', 2)
  if (group) {
    r.dataset.fold = group.target.id
    if (group.paneCount > 0) r.setAttribute('aria-expanded', String(!group.collapsed))
    else r.classList.add('rg-nofold')
    const caret = glyph(group.collapsed ? 'caret-right' : 'caret-down', group.collapsed ? 'Mostrar as guias' : 'Recolher as guias')
    caret.classList.add('rg-caret')
    r.append(caret)
  }
  const state = paneStateOf(p)
  if (state) r.dataset.state = state.cls
  if (p.state === 'asleep' || p.mark === 'ended') r.classList.add('zz')
  if (p.identity) {
    const who = ctx.identity(p.target.id) ?? { kind: p.identity.kind, name: p.identity.name, seed: p.target.id, emblem: p.identity.emblem as IdentityInput['emblem'] }
    r.append(identityView(who))
    if (p.title && p.title !== p.identity.name) r.append(el('span', 'rg-sub', p.title))
  } else {
    r.append(glyph(p.icon, p.type), el('span', 'rg-gn', p.title))
  }
  if ('deskName' in p) r.append(deskBadge(p.deskName, p.deskColor))
  else if (p.ownerBadge) r.append(ownerSeal(p.ownerBadge, 'da guia'))
  if (group?.inDeskOf) {
    // Short on the line, as the desk row draws its owner (the crown says "owner"), whole in the tooltip.
    const seal = ownerSeal(group.inDeskOf, 'da mesa')
    seal.title = `Esta guia está numa mesa de ${group.inDeskOf}`
    seal.setAttribute('aria-label', seal.title)
    r.append(seal)
  }
  if (group && group.paneCount > 0) r.append(el('span', 'rg-n2', `${group.paneCount} guia${group.paneCount === 1 ? '' : 's'}`))
  r.append(el('span', 'rg-sp'))
  if (state) {
    const st = el('span', `rg-st ${state.cls}`, state.text)
    st.title = state.text
    r.append(st)
  }
  // "Falar com" only reaches a live agent: a sleeping or ended one would be brought forward instead of peeked.
  const name = p.identity?.name ?? p.title
  const talk: RowAct[] = p.target.kind === 'agent' && p.state !== 'asleep' && p.mark !== 'ended' ?[{ action: 'row-talk', icon: 'chats-circle', tip: `Falar com ${name}` }] : []
  r.append(acts([...talk, MENU_ACT]))
  return r
}

/** The head of "Você" in the by-agent view (an agent's group head is its own pane line: `paneRow` with `group`). */
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

/**
 * Under a desk with no pane: the quiet "mesa vazia" (not a line that looks like a pane) and, on an awake desk, "+ nova guia"
 * at its right (the "+ Novo" card with the desk fixed).
 */
function emptyDesk(d: TreeDeskRow): HTMLElement {
  const line = el('div', 'rg-vazia')
  line.setAttribute('role', 'none')
  line.append(el('span', 'rg-vazia-t', 'mesa vazia'))
  if (!d.asleep) {
    const add = el('button', 'rg-vazia-b')
    add.type = 'button'
    add.tabIndex = -1
    add.dataset.action = `new-in:${d.target.id}`
    add.title = `Nova guia na mesa ${d.name}`
    const plus = glyph('plus', 'Nova guia')
    plus.setAttribute('aria-hidden', 'true')
    add.append(plus, el('span', '', 'nova guia'))
    line.append(add)
  }
  return line
}

/** The empty Browser and drawer, folded into one quiet line at the tree's foot; each opens its desk's menu. */
function shelf(model: RegencyModel): HTMLElement {
  const box = el('div', 'rg-shelf')
  box.setAttribute('role', 'none')
  box.append(el('span', 'rg-shelf-t', 'Vazias:'))
  for (const s of model.shelf) {
    const b = el('button', 'rg-shelf-b')
    b.type = 'button'
    b.dataset.action = `shelf:${s.target.id}`
    b.dataset.target = targetKey(s.target)
    b.title = `${s.name}: vazia (menu da mesa)`
    b.style.setProperty('--rg-desk', `var(--x-${s.color}, var(--accent))`)
    const kind = DESK_KIND[s.kind]
    const g = glyph(s.icon ?? kind.icon, kind.tip)
    g.setAttribute('aria-hidden', 'true')
    b.append(g, el('span', '', s.name))
    box.append(b)
  }
  return box
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
      if (d.paneCount === 0 && d.kind === 'queue' && !ctx.narrowed) group.append(emptyDesk(d))
      out.push(group)
    }
    if (model.shelf.length > 0) out.push(shelf(model))
  } else {
    for (const g of model.byAgent) {
      const group = el('div', 'rg-group')
      group.setAttribute('role', 'none')
      group.dataset.agent = g.target.id
      group.append(g.self ? paneRow(g.self, ctx, g) : groupRow(g, ctx))
      // A dot on the head when a pane under it waits (the agent's own wait is its state text).
      const ids = new Set(g.panes.map(p => p.target.id))
      if (g.panes.some(p => p.attention === 'waiting') || (g.collapsed && model.waiting.some(w => w.target.id !== g.target.id && ids.has(w.target.id)))) group.querySelector('.rg-sp')?.after(attnDot())
      for (const p of g.panes) group.append(paneRow(p, ctx))
      out.push(group)
    }
  }
  if (ctx.narrowed && out.length === 0 && model.closed.count === 0) out.push(nothingShown())
  out.push(closedSection(model, ctx))
  host.replaceChildren(...out)
}

/** "Fechadas" at the tree's foot: the head (folds; its count is the sessions that pass the search) and, open, one line each. */
function closedSection(model: RegencyModel, ctx: TreeContext): HTMLElement {
  const { count, collapsed, rows } = model.closed
  const group = el('div', 'rg-group')
  group.setAttribute('role', 'none')
  group.dataset.closed = 'true'
  const label = `Fechadas, ${count} ${count === 1 ? 'sessão' : 'sessões'}`
  if (count === 0) {
    // Nothing to fold: a plain head (out of the keyboard's walk), and the sentence when nothing narrows the tree.
    const head = el('div', 'rg-cl-head rg-cl-off')
    head.setAttribute('aria-label', label)
    head.append(glyph('clock-counter-clockwise', 'Fechadas'), el('span', 'rg-dn', 'Fechadas'), el('span', 'rg-n2', '0'))
    group.append(head)
    if (!ctx.narrowed) group.append(el('p', 'rg-empty rg-cl-empty', 'Nenhuma sessão fechada'))
    return group
  }
  const head = treeRow('rg-cl-head', { kind: 'session', id: CLOSED_ID }, label, CLOSED_HEAD_KEY, 'closed-head', 1)
  head.dataset.fold = CLOSED_ID
  head.setAttribute('aria-expanded', String(!collapsed))
  head.append(
    glyph(collapsed ? 'caret-right' : 'caret-down', collapsed ? 'Mostrar as sessões fechadas' : 'Recolher as sessões fechadas'),
    glyph('clock-counter-clockwise', 'Fechadas'),
    el('span', 'rg-dn', 'Fechadas'),
    el('span', 'rg-n2', String(count)),
  )
  group.append(head)
  for (const c of rows) group.append(closedRow(c, ctx))
  return group
}

/** An ended session: the agent's identity (engine icon, letter, name), its title when it has one, and how long ago it ended. */
function closedRow(c: ClosedRow, ctx: TreeContext): HTMLElement {
  const r = treeRow('rg-cl', c.target, `${c.name}, encerrada`, closedRowKey(c.target.id), 'closed', 2)
  r.dataset.session = c.target.id
  r.append(identityView(ctx.identity(c.target.id) ?? { kind: c.kind, name: c.name, seed: c.target.id }))
  if (c.title && c.title !== c.name) r.append(el('span', 'rg-sub', c.title))
  r.append(el('span', 'rg-sp'))
  const at = c.endedAt ? Date.parse(c.endedAt) : NaN
  if (Number.isFinite(at)) {
    const ago = el('span', 'rg-ago', formatAgo(Date.now() - at))
    ago.title = `Encerrada em ${new Date(at).toLocaleString('pt-BR')}`
    r.append(ago)
  }
  r.append(acts([MENU_ACT]))
  return r
}

function attnDot(): HTMLElement {
  const d = el('span', 'rg-attn')
  d.title = 'Alguém nesta mesa espera você'
  return d
}
