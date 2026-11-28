// The Regency on the web, reading only: the app's own pane (extensions/regency/renderer/pane.ts) and the app's own channel
// view, mounted over the remote hosts (host.ts) inside the web's casing. The casing is what the app's window gives the
// local Regency and a browser does not: the strip of the house on top (its name, the state of the link, "Vendo de longe"),
// the reading card of a pane (the place of the app's quick view), the band of "the app is closed on the machine" and the
// notice that takes the whole screen while the house is out of reach.
//
// Nothing of the house is kept: the tree, the marks and the pages live in memory while the link does; when it falls they
// are let go, and a new session reads everything again. Every text of the house reaches the page as a text node.
import { icon, type IconName } from '../../../app/renderer/icons.ts'
import { identityView } from '../../../app/renderer/agent-identity.ts'
import { engineOf } from '../../../app/renderer/agent-ui.ts'
import { formatAgo } from '../../../app/renderer/sessions-rules.ts'
import { createChannelViews } from '../../../extensions/channels/renderer/channel-pane.ts'
import { regencyModelOf, type Target, type TreeDeskRow, type TreePaneRow } from '../../../extensions/regency/model.ts'
import { glyph as paneGlyph, paneStateOf } from '../../../extensions/regency/renderer/columns.ts'
import { layoutParams, tierOf, type RegencyLayout, type Tier } from '../../../extensions/regency/renderer/layout-rules.ts'
import { RegencyPane } from '../../../extensions/regency/renderer/pane.ts'
import { keysStrip, mountSpatialFocus } from './focus.ts'
import { RemoteHouse, emblemOf, remoteChannelHost, remoteRegencyHost, sealSays, type RemoteSource } from './host.ts'
import { remoteFiles } from './files.ts'
import type { Manager } from './manage.ts'
import { ManageUi } from './manage-view.ts'
import { createMenu } from './menu.ts'
import type { Talker } from './talk.ts'
import type { DevicePush } from './push.ts'
import { PUSH_TEXT } from './push-rules.ts'
import { mountTalkView } from './talk-view.ts'
import { el, registerEngines } from './ui-lite.ts'
import { channelOnOpen } from './url-state.ts'

/** The words of the casing (the vocabulary is the product's: Mesas, Canais, guia, hibernando). */
export const TEXT = {
  watching: 'Vendo de longe',
  watchingTip: 'Este aparelho acompanha de longe: vê, não fala nem gere',
  talking: 'Conversa de longe',
  talkingTip: 'Este aparelho conversa nos canais de longe; gerir as mesas e os canais fica na máquina',
  lock: 'Trancar',
  lockTip: 'Trancar este aparelho: para voltar, a biometria',
  live: 'ao vivo',
  appClosed: 'app fechado na máquina',
  offline: 'offline',
  loading: 'lendo a casa…',
  cardFoot: 'Para espiar o terminal ou responder, use o tether na máquina.',
  offTitle: 'Seu tether está offline',
  offLead: 'Não consegui falar com a máquina. Ela pode estar desligada, dormindo ou sem rede.',
  offKept: 'Nada da máquina fica guardado neste aparelho: a Regência volta quando ela voltar.',
  offApp: 'Se só o app do tether estiver fechado, a máquina ainda responde e as mesas aparecem aqui.',
  retry: 'Tentar agora',
  noDesks: 'As mesas não aparecem: este aparelho não tem permissão para ver a Regência.',
  bigDesks: 'As mesas não chegaram: são grandes demais para ver daqui agora.',
  noChannels: 'Os canais não aparecem: este aparelho não tem permissão para ler os canais.',
} as const

const two = (n: number): string => String(n).padStart(2, '0')
/** "14:32", on this device's clock. */
export const clockOf = (ms: number): string => { const d = new Date(ms); return `${two(d.getHours())}:${two(d.getMinutes())}` }

/** "hoje às 14:37", or the day when it was not today. */
export function whenOf(ms: number, nowMs: number): string {
  const d = new Date(ms)
  const n = new Date(nowMs)
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  return sameDay ? `hoje às ${clockOf(ms)}` : `em ${two(d.getDate())}/${two(d.getMonth() + 1)} às ${clockOf(ms)}`
}

export const retryWords = (s: number | undefined): string => (s === undefined || s <= 0 ? 'Tentando agora…' : `Tento de novo em ${s} s.`)

/** The band over the tree while the app is closed on the machine. */
export const snapWords = (asOfMs: number | undefined): { line: string; small: string } => asOfMs === undefined
  ? { line: 'O tether está fechado na máquina. Daqui aparecem as sessões que ela mantém.', small: 'As mesas voltam quando o app abrir.' }
  : { line: `O tether está fechado na máquina. As mesas são como estavam às ${clockOf(asOfMs)}.`, small: 'O estado de quem roda na máquina e os canais seguem ao vivo.' }

function glyph(name: IconName): SVGSVGElement {
  const g = icon(name)
  g.setAttribute('aria-hidden', 'true')
  return g
}

export interface OfflineState {
  /** When the house last answered (epoch ms, this device's clock); absent when it never did in this visit. */
  lastContactMs?: number
  /** Seconds until the next try; absent or 0 while one is in course. */
  retryInS?: number
}

export interface RemoteRegency {
  readonly element: HTMLElement
  /** The session is up: the house is read through `source` (each session gives its own). */
  online(source: RemoteSource): void
  /** The link fell: the notice takes the screen and what was read of the house is let go. */
  offline(state: OfflineState): void
  /** The countdown of the notice moved. */
  retryIn(seconds: number | undefined): void
  /** What a capture or a test reads of the screen: text and flags, never elements. */
  snapshot(): {
    link: 'live' | 'closed' | 'offline' | 'loading'; tier: Tier; paneTier: Tier | undefined; card: string | undefined; channel: string | undefined
    /** Managing from afar: the last notice and the rows whose act is on its way. */
    manage?: { notice: string | undefined; doing: string[] }
  }
  dispose(): void
}

export interface RegencyOptions {
  /** The house's name, as the pairing kept it. */
  houseName: string
  /** "Tentar agora". */
  onRetry(): void
  now?: () => number
  /** The layout kept in the address: where a first session starts (the pane's parameters) and what to tell when it changes. */
  layout?: {
    initial: Record<string, unknown>
    changed(layout: RegencyLayout): void
    /**
     * The address names the phone's tab: a session starts on it (a reload comes back to the tab it was on). Without it the
     * pane chooses, as in the app: "Esperam você" when someone waits, and "Mesas" when the app is closed on the machine.
     */
    tabAsked?(): boolean
  }
  /** The device may converse (a presence credential is registered): the channels' gestures go through it. Absent: reading only. */
  talk?: Talker
  /** "Trancar": the device asks the session to lock (only a device that can unlock again gets the gesture). */
  onLock?(): void
  /** "Avisos neste aparelho" (step 4.4), beside "Trancar": only a device that can act subscribes. */
  push?: DevicePush
  /**
   * Managing from afar (step 5.4): the acts of a device with a presence credential. Its scopes (`session.info`) decide which
   * rows show; without any `manage:*` scope the pane stays as it reads. Absent: reading only.
   */
  manage?: Manager
}

/** How long a finger rests on a speech before it opens the speech's menu (a touch screen's right click). */
const LONG_PRESS_MS = 480
/** How far it may wander and still be resting. */
const LONG_PRESS_SLACK_PX = 10
/** The visual viewport this much shorter than the window: the virtual keyboard is up. */
const KEYBOARD_PX = 120

/** What is up while the link is: the house's data, the pane over it and the reading card. */
interface Session {
  house: RemoteHouse
  pane: RegencyPane
  card: QuickCard
  /** The acts from afar, for a device that may manage. */
  manage?: ManageUi
  dispose(): void
}

/** What the card asks of the casing: where it docks, whether it is the phone's sheet, and the row to mark. */
interface CardDeps { place(): HTMLElement; sheet(): boolean; shell: HTMLElement; changed(): void; now(): number }

/**
 * The reading card of a pane or an agent: the place of the app's quick view, with what a reading from afar may say (the
 * desk, the engine, the state and since when). Docked over the conversation and not modal; on the phone, a sheet from the
 * bottom. Esc, its button, a press outside it (the phone) or the same row again close it.
 */
class QuickCard {
  readonly element = el('section', 'rr-card')
  private readonly back = el('div', 'rr-card-back')
  private readonly head = el('div', 'rr-card-h')
  private readonly body = el('dl', 'rr-card-b')
  private shownId: string | undefined
  private opener: HTMLElement | undefined
  private readonly house: RemoteHouse
  private readonly deps: CardDeps

  constructor(house: RemoteHouse, deps: CardDeps) {
    this.house = house
    this.deps = deps
    this.element.hidden = true
    this.element.setAttribute('role', 'dialog')
    this.back.hidden = true
    const foot = el('div', 'rr-card-f')
    foot.append(glyph('eye'), el('span', '', TEXT.cardFoot))
    this.element.append(el('div', 'rr-card-grab'), this.head, this.body, foot)
    this.back.addEventListener('click', () => this.close())
    this.element.addEventListener('keydown', ev => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); this.close(true) } })
  }

  shown(): string | undefined { return this.shownId }

  toggle(target: Target): void {
    if (this.shownId === target.id) this.close()
    else this.open(target)
  }

  open(target: Target): void {
    if (target.kind !== 'pane' && target.kind !== 'agent') return
    const found = this.find(target.id)
    if (!found) return
    const active = document.activeElement
    this.opener = active instanceof HTMLElement && active !== document.body ? active : undefined
    this.shownId = target.id
    this.paint(found.pane, found.desk)
    // The phone's sheet covers the whole casing (with its backdrop); elsewhere the card docks over the conversation.
    const sheet = this.deps.sheet()
    this.element.dataset.form = sheet ? 'sheet' : 'docked'
    const place = sheet ? this.deps.shell : this.deps.place()
    if (this.element.parentElement !== place) place.append(this.element)
    if (sheet && this.back.parentElement !== this.deps.shell) this.deps.shell.insertBefore(this.back, this.element)
    this.back.hidden = !sheet
    this.element.hidden = false
    this.deps.changed()
    // A gesture of the person opened it: the keyboard goes to its one button (Esc and Enter close it from there).
    this.head.querySelector<HTMLElement>('.rr-ib')?.focus({ preventScroll: true })
  }

  close(focus = false): void {
    if (this.shownId === undefined) return
    this.shownId = undefined
    this.element.hidden = true
    this.back.hidden = true
    this.deps.changed()
    if (focus && this.opener?.isConnected) this.opener.focus({ preventScroll: true })
    this.opener = undefined
  }

  /** The house changed: the card follows the pane it shows, and goes with it. */
  refresh(): void {
    if (this.shownId === undefined) return
    const found = this.find(this.shownId)
    if (!found) { this.close(); return }
    this.paint(found.pane, found.desk)
  }

  dispose(): void {
    this.element.remove()
    this.back.remove()
  }

  private find(paneId: string): { pane: TreePaneRow; desk: TreeDeskRow } | undefined {
    const model = regencyModelOf({ ...this.house.input(), collapsed: [], filter: 'all', query: '' })
    for (const desk of model.tree) for (const pane of desk.panes) if (pane.target.id === paneId) return { pane, desk }
    return undefined
  }

  private paint(pane: TreePaneRow, desk: TreeDeskRow): void {
    const input = this.house.input()
    const agent = input.agents.find(a => a.id === pane.target.id)
    const name = agent?.name ?? pane.title
    this.element.setAttribute('aria-label', `Guia ${name}`)
    const title = el('span', 'rr-card-t')
    if (agent) title.append(identityView({ kind: agent.kind, name: agent.name, seed: agent.id, emblem: emblemOf(agent) }))
    else title.append(paneGlyph(pane.icon, pane.type), el('span', 'rr-card-n', pane.title))
    const x = el('button', 'rr-ib')
    x.type = 'button'
    x.title = 'Fechar'
    x.setAttribute('aria-label', 'Fechar')
    x.append(glyph('x'))
    x.addEventListener('click', () => this.close(true))
    this.head.replaceChildren(title, el('span', 'rr-sp'), x)

    const rows: HTMLElement[] = []
    const row = (label: string, ...value: (Node | string)[]): void => {
      const dd = el('dd')
      dd.append(...value)
      rows.push(el('dt', '', label), dd)
    }
    const swatch = el('span', 'rr-swatch')
    swatch.style.setProperty('--rr-desk', `var(--x-${desk.color}, var(--accent))`)
    row('Mesa', swatch, `${desk.name}${desk.asleep ? ' · hibernando' : ''}`)
    if (agent) row('Motor', engineOf(agent.kind).label)
    const state = paneStateOf(pane)
    const since = input.since[`agent:${pane.target.id}`] ?? input.since[`pane:${pane.target.id}`]
    const st = el('span', `rr-st ${state?.cls ?? ''}`, state?.text ?? '—')
    if (since !== undefined && pane.state === 'waiting') row('Estado', st, el('span', 'rr-ago', `· ${formatAgo(this.deps.now() - since)}`))
    else row('Estado', st)
    if (agent && pane.title && pane.title !== agent.name) row('Guia', pane.title)
    // What the seal says it is doing (only while the app publishes), and the open channels it is in.
    const said = sealSays(this.house.lines(pane.target.id))
    if (said) row('Agora', said)
    const channels = this.house.channelsOf(pane.target.id)
    if (channels.length > 0) row('Canais', channels.map(c => `#${c.name || c.channel}`).join(', '))
    this.body.replaceChildren(...rows)
  }
}

/** Mounts the Regency's casing in `root`. It starts on "reading the house" until `online` or `offline` is told. */
export function mountRegency(root: HTMLElement, o: RegencyOptions): RemoteRegency {
  registerEngines()
  const now = o.now ?? Date.now
  const shell = el('div', 'rr')
  shell.dataset.link = 'loading'

  // ---- the strip of the house
  const top = el('header', 'rr-top')
  /** Paints "Avisos" again (its state, or the tier changed). */
  let paintPush: (() => void) | undefined
  const brand = el('span', 'rr-brand')
  brand.append(glyph('columns'))
  // The phone's strip is short: there the house's name stands alone (the sheet hides the prefix).
  const houseName = el('b', 'rr-house-n')
  if (o.houseName) houseName.append(el('span', 'rr-house-p', 'Regência · '), o.houseName)
  else houseName.append('Regência')
  houseName.title = o.houseName
  const dot = el('i', 'rr-dot')
  const where = el('span', 'rr-where-t')
  const far = el('span', 'rr-far', `· ${(o.talk ? TEXT.talking : TEXT.watching).toLowerCase()}`)
  const whereBox = el('span', 'rr-where')
  whereBox.setAttribute('role', 'status')
  whereBox.append(dot, where, far)
  const house = el('div', 'rr-house')
  house.append(houseName, whereBox)
  const clock = el('span', 'rr-clock')
  const watch = el('span', 'rr-watch')
  watch.title = o.talk ? TEXT.talkingTip : TEXT.watchingTip
  watch.append(glyph(o.talk ? 'chats-circle' : 'eye'), el('span', '', o.talk ? TEXT.talking : TEXT.watching))
  top.append(brand, house, el('span', 'rr-sp'), keysStrip(), clock, watch)
  // "Trancar": the session's own gesture, in the strip of the house (the device that can unlock again has it).
  const lockBtn = o.onLock ? el('button', 'rr-lock') : undefined
  if (lockBtn) {
    lockBtn.type = 'button'
    lockBtn.title = TEXT.lockTip
    lockBtn.setAttribute('aria-label', TEXT.lock)
    lockBtn.append(glyph('lock'), el('span', 'rr-lock-t', TEXT.lock))
    lockBtn.addEventListener('click', () => o.onLock?.())
    top.append(lockBtn)
  }
  // "Avisos neste aparelho": with the session's things, before "Trancar". A tap opens its card (the web's menu: a sheet on the
  // phone, at the button elsewhere) with what the notices are, where they are now and the one gesture. The TV has nothing to
  // tap: there it only says it is not available.
  const pushBtn = o.push ? el('button', 'rr-push') : undefined
  if (pushBtn && o.push) {
    const push = o.push
    pushBtn.type = 'button'
    pushBtn.append(glyph('bell'), el('span', 'rr-push-t', PUSH_TEXT.button))
    const na = el('span', 'rr-push-na', `${PUSH_TEXT.button}: ${PUSH_TEXT.unavailable.replace(/\.$/, '').toLowerCase()}`)
    const paint = (): void => {
      const m = push.model(tier === 'wide')
      pushBtn.dataset.state = m.phase
      pushBtn.title = `${m.title}: ${m.state}`
      pushBtn.setAttribute('aria-label', `${m.title}: ${m.state}`)
      const g = pushBtn.querySelector('svg')
      g?.replaceWith(glyph(m.phase === 'on' ? 'bell' : 'bell-slash'))
    }
    pushBtn.addEventListener('click', () => {
      const m = push.model(tier === 'wide')
      const r = pushBtn.getBoundingClientRect()
      menu.open(r.left, r.bottom + 6, [
        { heading: m.title }, { heading: m.lead }, { heading: m.state },
        ...(m.action ? [{ icon: m.action.turn === 'on' ? 'bell' : 'bell-slash', label: m.action.label, run: () => void push.turn(m.action!.turn) }] : []),
      ])
    })
    push.onChange = paint
    paintPush = paint
    if (lockBtn) lockBtn.before(pushBtn, na)
    else top.append(pushBtn, na)
  }

  // ---- the stage (the pane) and the notice of "offline"
  const stage = el('div', 'rr-stage')
  const off = el('section', 'rr-off')
  off.hidden = true
  const offFine = el('span', 'rr-off-t')
  const offBtn = el('button', 'rr-btn')
  offBtn.type = 'button'
  offBtn.append(glyph('arrows-clockwise'), el('span', '', TEXT.retry))
  offBtn.addEventListener('click', () => o.onRetry())
  {
    const box = el('div', 'rr-off-in')
    box.setAttribute('role', 'status')
    const ic = el('span', 'rr-off-ic')
    ic.append(glyph('plugs'))
    const fine = el('p', 'rr-off-fine')
    fine.append(el('i', 'rr-dot err'), offFine)
    const list = el('ul', 'rr-off-list')
    list.append(el('li', '', TEXT.offKept), el('li', '', TEXT.offApp))
    box.append(ic, el('h1', '', TEXT.offTitle), el('p', '', TEXT.offLead), fine, offBtn, list)
    off.append(box)
  }
  // ---- the lines that say why a part of the house is not shown (a scope the device lacks, a tree too big)
  const why = el('div', 'rr-why')
  why.setAttribute('role', 'status')
  why.hidden = true
  shell.append(top, why, stage, off)
  root.replaceChildren(shell)

  // ---- the band of "the app is closed on the machine", put over the tree of the pane
  const snap = el('div', 'rr-snap')
  const snapLine = el('span', 'rr-snap-l')
  const snapSmall = el('small', 'rr-snap-s')
  {
    const text = el('div', 'rr-snap-t')
    text.append(snapLine, snapSmall)
    snap.append(glyph('clock'), text)
  }
  const asOfMark = el('span', 'rr-asof')

  let session: Session | undefined
  let link: 'loading' | 'live' | 'closed' | 'offline' = 'loading'
  let offlineState: OfflineState = {}
  let tier: Tier = tierOf(shell.clientWidth || window.innerWidth)
  let lastLayout: RegencyLayout | undefined
  let frame = 0
  let opened = false
  let channelChosen = false
  /** The address named the phone's tab when this session started: neither the pane nor the casing chooses another. */
  let tabAsked = false
  let disposed = false
  // The arrows of the TV's remote (and of a keyboard anywhere): src/focus.ts.
  const focus = mountSpatialFocus(shell, {
    tier: () => tier,
    cardShown: () => session?.card.shown() !== undefined,
    closeCard: () => session?.card.close(true),
    // A device that manages: the TV's OK on a row of the tree opens its menu (the rows' acts live there).
    manages: () => session?.manage?.active === true,
  })

  // The menu of a speech or a poll (the app's context menu): at the point, or a sheet on the phone.
  const menu = createMenu({ sheet: () => tier === 'mobile', tier: () => tier })
  paintPush?.()

  // A finger resting on a speech opens its menu, as a right click does (a touch screen has none; Android's own
  // `contextmenu` after a long press counts the same, and the second one is not opened).
  let press: { timer: ReturnType<typeof setTimeout>; x: number; y: number; target: HTMLElement } | undefined
  let pressFired = 0
  const endPress = (): void => { if (press) { clearTimeout(press.timer); press = undefined } }
  const onPressDown = (ev: PointerEvent): void => {
    endPress()
    if (ev.pointerType !== 'touch' || !o.talk) return
    const t = ev.target instanceof Element ? ev.target : null
    // A speech's menu, and (a device that manages) a row's of the tree: the pane opens it on the row's `contextmenu`.
    const rows = session?.manage?.active ? '.ch-msgs > .ch-msg, .ch-msgs > .ch-prow, .rg-tree [data-key]' : '.ch-msgs > .ch-msg, .ch-msgs > .ch-prow'
    const msg = t?.closest<HTMLElement>(rows)
    // A button, a link or a field of the speech keeps its own tap.
    if (!t || !msg || t.closest('button, a, input, textarea, select')) return
    const { clientX: x, clientY: y } = ev
    press = {
      x, y, target: msg,
      timer: setTimeout(() => {
        press = undefined
        if (menu.isOpen()) return
        pressFired = performance.now()
        msg.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }))
      }, LONG_PRESS_MS),
    }
  }
  const onPressMove = (ev: PointerEvent): void => {
    if (press && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > LONG_PRESS_SLACK_PX) endPress()
  }
  // The browser's own long press (Android) came first: the timer is not needed. The tap that ends a long press clicks nothing.
  const onNativeMenu = (ev: MouseEvent): void => { if (ev.isTrusted) endPress() }
  const onPressClick = (ev: MouseEvent): void => { if (performance.now() - pressFired < 600) { ev.preventDefault(); ev.stopPropagation() } }
  stage.addEventListener('pointerdown', onPressDown)
  stage.addEventListener('pointermove', onPressMove)
  for (const n of ['pointerup', 'pointercancel', 'scroll'] as const) stage.addEventListener(n, endPress, true)
  stage.addEventListener('contextmenu', onNativeMenu, true)
  stage.addEventListener('click', onPressClick, true)

  // The phone's virtual keyboard: the casing takes the height that is left, so the speaking box stays right above the keys
  // (and the bar of the three places steps aside while it is up).
  const vv = window.visualViewport
  const onViewport = (): void => {
    if (!vv) return
    const up = window.innerHeight - vv.height > KEYBOARD_PX
    if (up) { shell.style.setProperty('--rr-vvh', `${Math.round(vv.height)}px`); shell.dataset.kb = 'up' } else { shell.style.removeProperty('--rr-vvh'); delete shell.dataset.kb }
  }
  vv?.addEventListener('resize', onViewport)

  const paintTop = (): void => {
    shell.dataset.link = link
    shell.dataset.tier = tier
    const words = link === 'live' ? TEXT.live : link === 'closed' ? TEXT.appClosed : link === 'offline' ? TEXT.offline : TEXT.loading
    if (where.textContent !== words) where.textContent = words
    dot.className = `rr-dot ${link === 'live' ? 'ok' : link === 'closed' ? 'warn' : link === 'offline' ? 'err' : ''}`
    far.hidden = link === 'offline' || link === 'loading'
    watch.hidden = link === 'offline'
    if (lockBtn) lockBtn.hidden = link === 'offline'
    const t = clockOf(now())
    if (clock.textContent !== t) clock.textContent = t
  }

  const paintOffline = (): void => {
    const last = offlineState.lastContactMs
    const said = last === undefined ? '' : `Último contato ${whenOf(last, now())}. `
    const text = `${said}${retryWords(offlineState.retryInS)}`
    if (offFine.textContent !== text) offFine.textContent = text
  }

  /** The band and the "às 14:32" of the heading, while the app is closed (they sit in the pane's own tree column). */
  const paintSnap = (): void => {
    const s = session
    if (!s) return
    const closed = s.house.hasTree && !s.house.live
    const right = s.pane.element.querySelector<HTMLElement>(':scope > .rg-right')
    const tools = right?.querySelector<HTMLElement>(':scope > .rg-tools')
    const title = right?.querySelector<HTMLElement>(':scope > .rg-hd > .rg-hd-t')
    if (!closed || !right || !tools) { snap.remove(); asOfMark.remove(); return }
    const words = snapWords(s.house.asOf)
    if (snapLine.textContent !== words.line) snapLine.textContent = words.line
    if (snapSmall.textContent !== words.small) snapSmall.textContent = words.small
    if (snap.parentElement !== right || snap.nextElementSibling !== tools) right.insertBefore(snap, tools)
    const at = s.house.asOf === undefined ? '' : `às ${clockOf(s.house.asOf)}`
    if (asOfMark.textContent !== at) asOfMark.textContent = at
    if (title && at !== '' && asOfMark.previousElementSibling !== title) title.after(asOfMark)
    if (at === '') asOfMark.remove()
  }

  const paintWhy = (s: Session | undefined): void => {
    const lines: string[] = []
    if (s?.house.treeProblem === 'no-scope') lines.push(TEXT.noDesks)
    else if (s?.house.treeProblem === 'too-large') lines.push(TEXT.bigDesks)
    if (s?.house.channelsProblem === 'no-scope') lines.push(TEXT.noChannels)
    const said = lines.join('\n')
    if (why.dataset.said === said) return
    why.dataset.said = said
    why.replaceChildren(...lines.map(t => { const p = el('p', 'rr-why-l'); p.append(glyph('info'), el('span', '', t)); return p }))
    why.hidden = lines.length === 0
  }

  const paint = (): void => {
    frame = 0
    const s = session
    paintWhy(disposed ? undefined : s)
    if (disposed || !s) { paintTop(); return }
    // Without a tree (no scope for it, or too big) the session is up but whether the app is open is not known: "ao vivo".
    link = !s.house.loaded ? 'loading' : !s.house.hasTree || s.house.live ? 'live' : 'closed'
    paintTop()
    // Once the house's channels are known: the channel the address names, while the house has it; else (gone, or no
    // channel can be read) the one that calls the person, else the first open one. The pane writes the address back.
    if (!channelChosen && s.house.loaded && s.house.channelsKnown) {
      channelChosen = true
      const calls = (id: string): number => { const m = s.house.markOf(id); return m ? m.toMe + m.asks + m.owed : 0 }
      s.pane.select(channelOnOpen(s.pane.state.channelId, s.house.input().channels, calls))
    }
    // The first tree: the phone opens on "Mesas" when the app is closed (that is where the news is).
    if (!opened && s.house.loaded) {
      opened = true
      s.pane.paint()
      // (The casing's own tier: the pane learns its width a frame later.)
      if (link === 'closed' && tier === 'mobile' && !tabAsked) s.pane.setTab('tether')
    }
    paintManage(s)
    s.pane.paint()
    s.card.refresh()
    paintSnap()
    s.manage?.afterPaint(s.pane.element)
    focus.afterPaint()
  }

  /**
   * What the device may manage, on the pane: until its scopes are known (and without any `manage:*`) the pane reads as
   * before; "Sistema" shows when Processos or Ronda is the device's.
   */
  const paintManage = (s: Session): void => {
    const m = s.manage
    const on = m?.active === true
    const el2 = s.pane.element
    if (on && el2.dataset.readonly !== undefined) delete el2.dataset.readonly
    else if (!on && el2.dataset.readonly === undefined) el2.dataset.readonly = ''
    const caps = o.manage?.caps
    const flags = !on || !caps ? '' : [caps.desks ? 'desks' : '', caps.agents ? 'agents' : '', caps.procs ? 'procs' : '', caps.destructive ? 'destructive' : ''].filter(Boolean).join(' ')
    if ((shell.dataset.manage ?? '') !== flags) { if (flags) shell.dataset.manage = flags; else delete shell.dataset.manage }
  }
  const schedule = (): void => { if (!frame && !disposed) frame = requestAnimationFrame(paint) }
  // The caps came, a process or a ronda was read again: paint.
  if (o.manage) o.manage.onChange = schedule

  const endSession = (): void => {
    const s = session
    if (!s) return
    session = undefined
    lastLayout = s.pane.state
    s.dispose()
  }

  const online = (source: RemoteSource): void => {
    if (disposed) return
    endSession()
    opened = false
    channelChosen = false
    offlineState = {}
    off.hidden = true
    stage.hidden = false
    const house = new RemoteHouse(source)
    let pane: RegencyPane | undefined
    const card: QuickCard = new QuickCard(house, {
      place: () => pane?.element.querySelector<HTMLElement>(':scope > .rg-center') ?? stage,
      sheet: () => tier === 'mobile',
      shell,
      changed: () => pane?.markQuick(),
      now,
    })
    const talk = o.talk
    // Managing from afar (step 5.4): the rows' menus, the questions, "Sistema"; its pane is the one made below.
    const manage = o.manage ? new ManageUi({
      house, manager: o.manage, menu, tier: () => tier, pane: () => pane,
      quick: t => card.open(t), schedule, now,
    }) : undefined
    // The files of the speeches of this session (step 4.3): what they brought is let go of with the session.
    const files = remoteFiles(house)
    const views = createChannelViews(remoteChannelHost(house, {
      quick: id => card.open({ kind: 'pane', id }),
      menu: (x, y, entries) => menu.open(x, y, entries),
    }, talk, files))
    pane = new RegencyPane(remoteRegencyHost(house, {
      mount: (place, channelId, opts) => {
        const view = views.mountEmbed(place, channelId, opts)
        house.openViews.add(channelId)
        // The speeches on their way, the draft and the counter of the box, around the app's own box.
        const extra = talk ? mountTalkView({ element: view.element, channelId, talker: talk, phone: () => tier === 'mobile' }) : undefined
        return { ...view, dispose: () => { extra?.dispose(); menu.close(); house.openViews.delete(channelId); view.dispose() } }
      },
      quick: { open: t => card.open(t), toggle: t => card.toggle(t), shown: () => card.shown(), close: () => card.close() },
      visible: () => !stage.hidden,
      width: () => shell.clientWidth,
      ...(manage ? {
        manage: {
          rowMenu: (t, anchor, at) => manage.rowMenu(t, anchor, at),
          sleepDesk: (id, wake) => manage.sleepDesk(id, wake),
          renameRefused: () => manage.renameRefused(),
          create: restore => { void manage.create(restore) },
          system: manage.system,
        },
      } : {}),
    }))
    const p = pane
    // The layout is the page's while it lives: a new session starts from where the last one was.
    tabAsked = o.layout?.tabAsked?.() === true
    p.init({
      api: { id: 'regency:main', updateParameters: () => o.layout?.changed(p.state) },
      params: lastLayout ? layoutParams(lastLayout) : (o.layout?.initial ?? {}),
      keepTab: tabAsked,
    })
    stage.replaceChildren(p.element)
    p.setShown(true)
    // From afar the heading's "+" makes a desk (its name and colour), the one thing of "+ Novo" with a road here.
    const newBtn = p.element.querySelector<HTMLElement>('.rg-new')
    if (manage && newBtn) {
      newBtn.title = 'Nova mesa: o nome e a cor; ela entra no fim da fila'
      newBtn.setAttribute('aria-label', 'Nova mesa')
      const word = newBtn.querySelector(':scope > span:last-child')
      if (word) word.textContent = 'Nova mesa'
    }
    // The "⋯" of a process: the view's own menu is about its record (on the machine); from afar it is "Esquecer…".
    const onSysMore = (ev: MouseEvent): void => {
      const b = ev.target instanceof Element ? ev.target.closest<HTMLElement>('.rg-sr.proc [data-sys="more"]') : null
      const name = b?.closest<HTMLElement>('.rg-sr.proc')?.dataset.proc
      if (!b || !name || !manage) return
      ev.preventDefault()
      ev.stopPropagation()
      manage.procMenu(name, b)
    }
    p.element.addEventListener('click', onSysMore, true)
    const subs = [house.onDidChange(schedule), ...views.disposables]
    session = {
      house, pane: p, card, ...(manage ? { manage } : {}),
      dispose: () => {
        for (const s of subs) s.dispose()
        p.element.removeEventListener('click', onSysMore, true)
        manage?.dispose()
        card.dispose()
        p.dispose()
        p.element.remove()
        house.dispose()
        files.dispose()
      },
    }
    house.start()
    link = 'loading'
    paint()
  }

  const offline = (state: OfflineState): void => {
    if (disposed) return
    endSession()
    paintWhy(undefined)
    offlineState = state
    link = 'offline'
    stage.replaceChildren()
    stage.hidden = true
    off.hidden = false
    paintTop()
    paintOffline()
  }

  const ro = new ResizeObserver(() => {
    const next = tierOf(shell.clientWidth)
    if (next === tier) return
    tier = next
    paintTop()
    paintPush?.()
    // The card changes form with the tier (a sheet on the phone): it closes, the row is one tap away.
    session?.card.close()
    focus.tierChanged()
  })
  ro.observe(shell)
  // The clock of the strip and the ages ("há 6 min") move with the minute.
  const minute = setInterval(() => { if (session) schedule(); else paintTop() }, 30_000)
  // Esc closes the reading card from anywhere in the casing (the pane's own keys run first: this one only when they left it).
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape' || ev.defaultPrevented || !session || session.card.shown() === undefined) return
    session.card.close(true)
  }
  shell.addEventListener('keydown', onKey)
  paintTop()

  return {
    element: shell,
    online,
    offline,
    retryIn: seconds => { offlineState = { ...offlineState, retryInS: seconds }; if (link === 'offline') paintOffline() },
    snapshot: () => ({
      link, tier, paneTier: session?.pane.tier, card: session?.card.shown(), channel: session?.pane.state.channelId,
      ...(session?.manage ? { manage: session.manage.snapshot() } : {}),
    }),
    dispose: () => {
      disposed = true
      if (frame) cancelAnimationFrame(frame)
      clearInterval(minute)
      ro.disconnect()
      shell.removeEventListener('keydown', onKey)
      vv?.removeEventListener('resize', onViewport)
      endPress()
      menu.close()
      focus.dispose()
      endSession()
      if (o.push) o.push.onChange = () => {}
      if (o.manage) o.manage.onChange = () => {}
      shell.remove()
    },
  }
}
