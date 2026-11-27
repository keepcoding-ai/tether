// "Aparelhos" (RR2.2), the view the Regency's "Sistema" embeds: the remote's state with "Ligar"/"Desligar a remota", the
// paired devices (declared name, last use, connected now and doing what) with "Encerrar sessão" and "Revogar aparelho", and
// the pairing card: QR and the 12-digit code with the 2-minute clock, then, when a device arrives, its declared name, what it
// will be able to do and the field where the person TYPES the six digits the device shows (never a "they match" button).
// Every destructive act asks first, under its row, in the house's panel. The words and states are rules.ts; what the
// daemon and the portal decide (origin, tries, burning, the SAS) is never decided here.
import { ICON_NAMES, icon, type IconName } from '../../../app/renderer/icons.ts'
import {
  codeGroups, confirmOf, devicesModel, pairScreen, qrPayload, sasDigits, type DeviceRow, type DevicesModel, type PairScreen,
  type PairViewInput, type RemoteStatusInput,
} from '../rules.ts'
import { encodeQr, qrPath } from './qr.ts'

export interface DevicesHost {
  status(): RemoteStatusInput | undefined
  /** Asks the daemon half; rejects with an error whose `message` is the daemon's sentence (pt-BR) and `code` its code. */
  request<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>
  /** Status asked again now (after an act). */
  refresh(): Promise<void>
  /** The PWA's address for the QR, when one is known. */
  webUrl(): string | undefined
  now(): number
  /** How often the open pairing is asked about (ms). */
  pairTickMs: number
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/** An icon that says what it is (its tooltip), or a decorative one inside a button that says it. */
function glyph(name: string, tip?: string): HTMLElement {
  const cell = el('span', 'rg-ic')
  cell.append(icon((ICON_NAMES as readonly string[]).includes(name) ? name as IconName : 'circle'))
  if (tip) { cell.title = tip; cell.setAttribute('role', 'img'); cell.setAttribute('aria-label', tip) } else cell.setAttribute('aria-hidden', 'true')
  return cell
}

function button(id: string, iconName: string, tip: string, label?: string, danger = false): HTMLButtonElement {
  const b = el('button', label ? 'rg-sys-btn' : 'rg-sys-ib')
  b.type = 'button'
  b.dataset.rr = id
  b.title = tip
  b.setAttribute('aria-label', label && label !== tip ? `${label}: ${tip}` : tip)
  if (danger) b.classList.add('danger')
  b.append(glyph(iconName))
  if (label) b.append(el('span', '', label))
  return b
}

function chip(text: string, cls = '', tip?: string): HTMLElement {
  const c = el('span', `rg-sr-c${cls ? ` ${cls}` : ''}`, text)
  c.title = tip ?? text
  return c
}

const errText = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e)
  return m.trim() !== '' ? m : 'Não deu certo.'
}

interface Pairing {
  view: PairViewInput
  /** When this screen first saw `waiting-sas` (the 2-minute window of the digits starts there). */
  sasSince?: number
  error?: string
  busy: boolean
  /** The card is closed by the person once the pairing is over. */
}

export class DevicesView {
  readonly element: HTMLElement
  private readonly host: DevicesHost
  private readonly head = el('div', 'rr-head')
  private readonly ask = el('div', 'rr-ask')
  private readonly card = el('section', 'rr-pair')
  private readonly list = el('div', 'rr-list')
  private readonly foot = el('div', 'rg-sys-foot rr-foot')
  private model: DevicesModel | undefined
  private signature = ''
  private pairing: Pairing | undefined
  /** The confirmation open under the head ('off') or under a device's row. */
  private asking: { act: 'off' | 'revoke' | 'end'; device?: string } | undefined
  private busy = new Set<string>()
  private headError = ''
  private clock: ReturnType<typeof setInterval> | undefined
  private poll: ReturnType<typeof setTimeout> | undefined
  private cardSig = ''
  private sasInput: HTMLInputElement | undefined
  paints = 0

  constructor(host: DevicesHost) {
    this.host = host
    this.element = el('div', 'rr-dev')
    this.element.setAttribute('aria-label', 'Aparelhos')
    this.card.hidden = true
    this.card.setAttribute('aria-label', 'Parear um aparelho')
    this.list.setAttribute('role', 'list')
    this.list.setAttribute('aria-label', 'Aparelhos pareados')
    this.element.append(this.head, this.ask, this.card, this.list, this.foot)
    this.element.addEventListener('click', ev => this.onClick(ev))
    this.element.addEventListener('keydown', ev => this.onKey(ev))
    this.element.addEventListener('input', ev => this.onInput(ev))
  }

  dispose(): void {
    clearInterval(this.clock)
    clearTimeout(this.poll)
  }

  /** Draws the head and the rows from the status; nothing changes on screen when the model did not. */
  paint(): void {
    const m = devicesModel(this.host.status(), this.host.now())
    this.model = m
    const sig = JSON.stringify([m, this.asking, [...this.busy], this.headError, this.pairing !== undefined])
    if (sig === this.signature) return
    this.signature = sig
    this.paints++
    const focusKey = document.activeElement instanceof HTMLElement && this.element.contains(document.activeElement) && !this.card.contains(document.activeElement)
      ? document.activeElement.dataset.key : undefined
    this.paintHead(m)
    this.paintAsk(m)
    this.paintRows(m)
    const notes: (HTMLElement | string)[] = []
    if (m.revoked > 0) notes.push(el('span', 'rg-sys-note', m.revoked === 1 ? '1 aparelho revogado (some da lista quando a admissão dele vencer).' : `${m.revoked} aparelhos revogados (somem da lista quando a admissão deles vencer).`))
    notes.push(el('span', 'rg-sys-note', 'Um aparelho só se pareia por esta tela, com os números dele digitados aqui.'))
    this.foot.replaceChildren(...notes)
    if (focusKey) [...this.element.querySelectorAll<HTMLElement>('[data-key]')].find(e => e.dataset.key === focusKey && !this.card.contains(e))?.focus({ preventScroll: true })
  }

  private paintHead(m: DevicesModel): void {
    const line = el('div', 'rr-state')
    const st = chip(m.headText, `st ${m.headIntent} wrap`)
    st.prepend(el('i', 'rg-sr-dot'))
    st.dataset.role = 'state'
    line.append(glyph('device-mobile', 'Acesso remoto'), st)
    const acts = el('div', 'rg-sr-btns rr-acts')
    const pair = button('pair', 'qr-code', m.can.pair ? 'Mostra um QR e um código para o aparelho; depois você digita aqui os números que ele mostrar' : m.pairWhy ?? 'Indisponível agora', 'Parear um aparelho')
    pair.dataset.key = 'head:pair'
    pair.disabled = !m.can.pair || this.pairing !== undefined || this.busy.has('pair')
    acts.append(pair)
    if (m.can.on) {
      const on = button('on', 'power', 'Liga o acesso pela internet com o relay configurado', 'Ligar a remota')
      on.dataset.key = 'head:on'
      on.disabled = this.busy.has('on')
      acts.append(on)
    }
    if (m.can.off) {
      const off = button('off', 'power', 'Derruba todos os aparelhos agora; os pareamentos continuam', 'Desligar a remota', true)
      off.dataset.key = 'head:off'
      off.disabled = this.busy.has('off')
      acts.append(off)
    }
    const parts: HTMLElement[] = [line]
    if (m.fingerprint) {
      const fp = el('p', 'rr-fp')
      fp.title = 'O aparelho mostra a mesma impressão ao parear: é assim que ele sabe que chegou a este tether'
      fp.append(el('span', '', 'Impressão deste tether: '), el('code', '', m.fingerprint))
      parts.push(fp)
    }
    parts.push(acts)
    if (this.headError) { const e = el('p', 'rg-sr-err', this.headError); e.setAttribute('role', 'alert'); parts.push(e) }
    this.head.replaceChildren(...parts)
  }

  private paintAsk(m: DevicesModel): void {
    const a = this.asking
    if (!a || a.act !== 'off' || !m.can.off) { this.ask.replaceChildren(); this.ask.hidden = true; return }
    this.ask.hidden = false
    this.ask.replaceChildren(this.confirmPanel('off'))
  }

  private confirmPanel(act: 'off' | 'revoke' | 'end', row?: DeviceRow): HTMLElement {
    const c = confirmOf(act, row?.name)
    const p = el('div', 'rg-sr-x ask')
    p.setAttribute('role', 'alertdialog')
    p.setAttribute('aria-label', c.sentence)
    p.dataset.act = act
    p.append(el('p', 'rg-sr-msg', c.sentence))
    const btns = el('div', 'rg-sr-btns')
    const go = button(`${act}-go`, act === 'off' ? 'power' : act === 'revoke' ? 'prohibit' : 'x-circle', c.hint, c.go, true)
    const no = button('cancel-ask', 'x', 'Cancelar: nada muda', 'Cancelar')
    no.dataset.key = `ask:${act}:cancel`
    go.dataset.key = `ask:${act}:go`
    btns.append(go, no)
    p.append(btns)
    return p
  }

  private paintRows(m: DevicesModel): void {
    const rows: HTMLElement[] = []
    for (const r of m.rows) {
      const row = el('div', `rg-sr device${r.live ? ' live' : ''}`)
      row.setAttribute('role', 'listitem')
      row.dataset.key = `device:${r.id}`
      row.dataset.device = r.id
      row.dataset.state = r.live ? 'ok' : r.state === 'pending' ? 'warn' : 'off'
      const h = el('div', 'rg-sr-h')
      const main = el('div', 'rg-sr-m')
      const name = el('span', 'rg-sr-n', r.name)
      name.title = r.nameTip
      const line = el('div', 'rg-sr-l')
      const st = chip(r.liveText, `st ${r.live ? 'ok' : 'off'} wrap`)
      st.prepend(el('i', 'rg-sr-dot'))
      st.dataset.role = 'live'
      line.append(st)
      if (r.state === 'pending') line.append(chip(r.stateText, 'warn'))
      line.append(chip(r.lastText, 'who', `Último uso: ${r.lastText}`), chip(r.pairedText, 'who'))
      main.append(name, line)
      const acts = el('span', 'rg-sr-a')
      const off = this.busy.has(r.id)
      if (r.can.end) { const b = button('end', 'x-circle', `Encerrar sessão de ${r.name}: ele cai agora e pode voltar`); b.dataset.key = `device:${r.id}:end`; b.disabled = off; acts.append(b) }
      if (r.can.revoke) { const b = button('revoke', 'prohibit', `Revogar ${r.name}: ele perde o acesso de vez`, undefined, true); b.dataset.key = `device:${r.id}:revoke`; b.disabled = off; acts.append(b) }
      h.append(glyph('device-mobile', r.live ? 'Aparelho conectado agora' : 'Aparelho pareado'), main, acts)
      row.append(h)
      const a = this.asking
      if (a && a.device === r.id && (a.act === 'revoke' || a.act === 'end')) row.append(this.confirmPanel(a.act, r))
      rows.push(row)
    }
    if (m.empty) rows.push(el('p', 'rg-empty rg-sys-empty', m.empty))
    this.list.replaceChildren(...rows)
  }

  // ---------------------------------------------------------------- the pairing card

  private async beginPair(): Promise<void> {
    this.headError = ''
    this.busy.add('pair')
    this.paint()
    try {
      const v = await this.host.request<PairViewInput>('pair.begin')
      this.pairing = { view: v, busy: false }
      this.startClock()
      this.schedulePoll()
    } catch (e) {
      this.headError = errText(e)
    } finally {
      this.busy.delete('pair')
      this.paint()
      this.paintCard()
    }
    this.card.querySelector<HTMLElement>('[data-rr="pair-cancel"]')?.focus({ preventScroll: true })
  }

  private startClock(): void {
    clearInterval(this.clock)
    this.clock = setInterval(() => this.paintCard(), 1000)
  }

  private schedulePoll(): void {
    clearTimeout(this.poll)
    const p = this.pairing
    if (!p || p.view.state === 'done' || p.view.state === 'burned') return
    this.poll = setTimeout(() => { void this.pollOnce() }, this.host.pairTickMs)
  }

  private async pollOnce(): Promise<void> {
    const p = this.pairing
    if (!p) return
    try {
      const v = await this.host.request<PairViewInput>('pair.state', { pairId: p.view.pairId })
      if (this.pairing !== p) return
      this.adopt(v)
    } catch (e) {
      if (this.pairing !== p) return
      // The portal forgot the ticket (it restarted, or another pairing replaced this one): the card says so and stops.
      p.view = { ...p.view, state: 'burned', burnReason: 'gone' }
      p.error = errText(e)
    }
    this.paintCard()
    this.schedulePoll()
  }

  /** A new view of the ticket from the portal; the code and the QR are kept (only `pair.begin` gives them). */
  private adopt(v: PairViewInput): void {
    const p = this.pairing!
    const prev = p.view
    p.view = { ...v, ...(prev.code ? { code: prev.code } : {}), ...(prev.qr ? { qr: prev.qr } : {}), ...(prev.fingerprint ? { fingerprint: prev.fingerprint } : {}) }
    if (v.state === 'waiting-sas' && p.sasSince === undefined) p.sasSince = this.host.now()
    if (v.state === 'done') void this.host.refresh().then(() => this.paint())
    if (v.state === 'done' || v.state === 'burned') clearTimeout(this.poll)
  }

  private async sendSas(): Promise<void> {
    const p = this.pairing
    const input = this.sasInput
    if (!p || !input || p.busy) return
    const { digits, complete } = sasDigits(input.value)
    if (!complete) { p.error = 'Digite os 6 números que o aparelho mostra.'; this.paintCard(true); input.focus(); return }
    p.busy = true
    p.error = undefined
    this.paintCard(true)
    try {
      const before = p.view.triesLeft
      const v = await this.host.request<PairViewInput>('pair.sas', { pairId: p.view.pairId, digits })
      if (this.pairing !== p) return
      this.adopt(v)
      if (v.state === 'waiting-sas' && (v.triesLeft ?? 0) < (before ?? 3)) {
        p.error = 'Esses não são os números do aparelho.'
        // The field may have been drawn again meanwhile (a poll): the one on screen is cleared.
        if (this.sasInput) this.sasInput.value = ''
      }
    } catch (e) {
      p.error = errText(e)
    } finally {
      p.busy = false
    }
    this.paintCard(true)
    this.schedulePoll()
    if (p.view.state === 'waiting-sas') this.sasInput?.focus({ preventScroll: true })
    else this.card.querySelector<HTMLElement>('[data-rr="pair-close"], [data-rr="pair-cancel"]')?.focus({ preventScroll: true })
  }

  private async cancelPair(): Promise<void> {
    const p = this.pairing
    if (!p) return
    p.busy = true
    this.paintCard(true)
    try {
      const v = await this.host.request<PairViewInput>('pair.cancel', { pairId: p.view.pairId })
      if (this.pairing === p) this.adopt(v)
    } catch { /* the ticket is gone: closing is all that is left */ }
    p.busy = false
    this.closePair()
  }

  private closePair(): void {
    this.pairing = undefined
    clearInterval(this.clock)
    clearTimeout(this.poll)
    this.clock = undefined
    this.sasInput = undefined
    this.paintCard(true)
    this.signature = ''
    this.paint()
    this.head.querySelector<HTMLElement>('[data-rr="pair"]')?.focus({ preventScroll: true })
  }

  /** The card from the ticket. Only the clock's text changes each second; the field is the same element while confirming. */
  private paintCard(force = false): void {
    const p = this.pairing
    if (!p) { this.card.hidden = true; this.card.replaceChildren(); this.cardSig = ''; return }
    const s = pairScreen(p.view, this.host.now(), p.sasSince)
    if (s.phase === 'done' || s.phase === 'over') clearInterval(this.clock)
    const sig = JSON.stringify([s.phase, s.code, s.deviceName, s.triesText, s.outcome, p.error, p.busy, s.canType, p.view.qr])
    if (!force && sig === this.cardSig) { this.tickClock(s); return }
    this.cardSig = sig
    this.card.hidden = false
    this.card.dataset.phase = s.phase
    const typed = this.sasInput?.value ?? ''
    const parts: HTMLElement[] = []
    const hd = el('div', 'rr-pair-hd')
    hd.append(glyph(s.phase === 'confirm' ? 'shield-warning' : 'qr-code'), el('h4', 'rr-pair-t', s.title))
    if (s.clockText) { const c = el('span', 'rr-clock', s.clock); c.title = s.clockText; c.setAttribute('aria-label', s.clockText); c.dataset.role = 'clock'; hd.append(c) }
    parts.push(hd)
    if (s.phase === 'code' || s.phase === 'arriving') parts.push(this.codeBlock(p, s))
    if (s.phase === 'confirm') parts.push(this.confirmBlock(s, typed))
    if (s.outcome) {
      const o = el('p', `rr-outcome ${s.outcomeIntent ?? ''}`, s.outcome)
      o.setAttribute('role', 'status')
      parts.push(o)
    }
    if (p.error && s.phase !== 'confirm') { const e = el('p', 'rg-sr-err', p.error); e.setAttribute('role', 'alert'); parts.push(e) }
    const btns = el('div', 'rg-sr-btns')
    if (s.canCancel) { const b = button('pair-cancel', 'x', 'Cancela o pareamento: o código deixa de valer', 'Cancelar'); b.disabled = p.busy; btns.append(b) }
    else if (s.phase === 'done' || s.phase === 'over') btns.append(button('pair-close', 'check', 'Fechar este cartão', s.phase === 'done' ? 'Pronto' : 'Fechar'))
    if (s.phase === 'over') btns.append(button('pair-again', 'qr-code', 'Gera um código novo', 'Gerar outro código'))
    parts.push(btns)
    const hadFocus = this.sasInput !== undefined && document.activeElement === this.sasInput
    this.card.replaceChildren(...parts)
    if (hadFocus) this.sasInput?.focus({ preventScroll: true })
  }

  private tickClock(s: PairScreen): void {
    const c = this.card.querySelector<HTMLElement>('[data-role="clock"]')
    if (c && s.clock && c.textContent !== s.clock) { c.textContent = s.clock; c.title = s.clockText ?? ''; c.setAttribute('aria-label', s.clockText ?? '') }
  }

  private codeBlock(p: Pairing, s: PairScreen): HTMLElement {
    const box = el('div', 'rr-code-box')
    const qrText = p.view.qr ? qrPayload(p.view.qr, this.host.webUrl()) : undefined
    if (qrText) {
      const m = encodeQr(qrText, { level: 'M' })
      const side = m.size + 8
      const ns = 'http://www.w3.org/2000/svg'
      const svg = document.createElementNS(ns, 'svg')
      svg.setAttribute('viewBox', `0 0 ${side} ${side}`)
      svg.setAttribute('class', 'rr-qr')
      svg.setAttribute('role', 'img')
      svg.setAttribute('aria-label', 'QR para parear: aponte a câmera do aparelho')
      svg.setAttribute('shape-rendering', 'crispEdges')
      const title = document.createElementNS(ns, 'title')
      title.textContent = 'QR para parear: aponte a câmera do aparelho'
      const bg = document.createElementNS(ns, 'rect')
      bg.setAttribute('width', String(side))
      bg.setAttribute('height', String(side))
      bg.setAttribute('class', 'rr-qr-bg')
      const path = document.createElementNS(ns, 'path')
      path.setAttribute('d', qrPath(m))
      path.setAttribute('class', 'rr-qr-fg')
      svg.append(title, bg, path)
      svg.dataset.version = String(m.version)
      box.append(svg)
    }
    const side = el('div', 'rr-code-side')
    side.append(el('p', 'rr-step', 'No aparelho, abra o tether remoto e aponte a câmera para o QR, ou digite o código:'))
    const code = el('p', 'rr-code')
    code.setAttribute('aria-label', `Código: ${(s.code ?? '').split('').join(' ')}`)
    code.dataset.role = 'code'
    for (const g of codeGroups(s.code ?? '')) code.append(el('span', '', g))
    side.append(code)
    if (p.view.fingerprint) {
      const fp = el('p', 'rr-fp')
      fp.title = 'O aparelho mostra esta mesma impressão: confira antes de seguir'
      fp.append(el('span', '', 'O aparelho vai mostrar a impressão '), el('code', '', p.view.fingerprint))
      side.append(fp)
    }
    side.append(el('p', 'rr-step dim', s.phase === 'arriving' ? 'O aparelho chegou e está provando quem é…' : 'Quando o aparelho chegar, ele mostra 6 números: você os digita aqui.'))
    box.append(side)
    return box
  }

  private confirmBlock(s: PairScreen, typed: string): HTMLElement {
    const p = this.pairing!
    const box = el('div', 'rr-confirm')
    const who = el('p', 'rr-who')
    who.append(el('span', '', 'Aparelho que se declara '), el('b', 'rr-who-n', `«${s.deviceName ?? ''}»`))
    who.title = 'O nome vem do próprio aparelho: não prova quem ele é. A prova são os números.'
    box.append(who)
    const can = el('div', 'rr-scopes')
    can.append(el('p', 'rr-step', 'Ele poderá:'))
    const ul = el('ul', 'rg-sr-uses')
    for (const w of s.scopes ?? []) ul.append(el('li', '', w))
    can.append(ul)
    box.append(can)
    const label = el('label', 'rr-sas')
    label.append(el('span', '', 'Digite os 6 números que o aparelho mostra'))
    const input = el('input', 'rr-sas-in')
    input.type = 'text'
    input.inputMode = 'numeric'
    input.autocomplete = 'off'
    input.spellcheck = false
    input.maxLength = 7
    input.placeholder = '000000'
    input.setAttribute('aria-describedby', 'rr-sas-warn')
    input.dataset.field = 'sas'
    input.value = typed
    input.disabled = !s.canType || p.busy
    if (p.error) input.setAttribute('aria-invalid', 'true')
    label.append(input)
    box.append(label)
    this.sasInput = input
    const warn = el('p', 'rr-warn', s.warning ?? '')
    warn.id = 'rr-sas-warn'
    box.append(warn)
    if (s.triesText) box.append(el('p', 'rr-tries', s.triesText))
    if (p.error) { const e = el('p', 'rg-sr-err', p.error); e.setAttribute('role', 'alert'); box.append(e) }
    const go = button('sas-go', 'check', 'Envia os números digitados; errados, o tether recusa', 'Confirmar números')
    go.disabled = !s.canType || p.busy || !sasDigits(typed).complete
    box.append(go)
    if (!s.canType) box.append(el('p', 'rg-sr-err', 'O tempo para digitar acabou: gere outro código.'))
    return box
  }

  // ---------------------------------------------------------------- acts

  private async act(key: string, run: () => Promise<unknown>): Promise<void> {
    this.busy.add(key)
    this.headError = ''
    this.paint()
    try { await run() } catch (e) { this.headError = errText(e) } finally {
      this.busy.delete(key)
      await this.host.refresh().catch(() => undefined)
      this.paint()
    }
  }

  private onClick(ev: MouseEvent): void {
    const b = ev.target instanceof Element ? ev.target.closest<HTMLButtonElement>('button[data-rr]') : null
    if (!b || b.disabled || !this.element.contains(b)) return
    const id = b.dataset.rr!
    const device = b.closest<HTMLElement>('.rg-sr.device')?.dataset.device
    switch (id) {
      case 'pair': case 'pair-again': this.pairing = undefined; void this.beginPair(); return
      case 'pair-cancel': void this.cancelPair(); return
      case 'pair-close': this.closePair(); return
      case 'sas-go': void this.sendSas(); return
      case 'on': void this.act('on', () => this.host.request('remote.on')); return
      case 'off': this.asking = { act: 'off' }; this.paint(); this.focusAsk('off'); return
      case 'revoke': case 'end': this.asking = { act: id, device: device! }; this.paint(); this.focusAsk(id); return
      case 'cancel-ask': { const a = this.asking; this.asking = undefined; this.paint(); this.refocus(a); return }
      case 'off-go': this.asking = undefined; void this.act('off', () => this.host.request('remote.off')); return
      case 'revoke-go': { const d = this.asking?.device; this.asking = undefined; if (d) void this.act(d, () => this.host.request('device.revoke', { device: d })); return }
      case 'end-go': { const d = this.asking?.device; this.asking = undefined; if (d) void this.act(d, () => this.host.request('session.end', { device: d })); return }
    }
  }

  private focusAsk(act: string): void {
    this.element.querySelector<HTMLElement>(`[data-key="ask:${act}:cancel"]`)?.focus({ preventScroll: true })
  }

  private refocus(a: { act: string; device?: string } | undefined): void {
    if (!a) return
    const key = a.device ? `device:${a.device}:${a.act}` : `head:${a.act}`
    this.element.querySelector<HTMLElement>(`[data-key="${key}"]`)?.focus({ preventScroll: true })
  }

  private onInput(ev: Event): void {
    if (ev.target !== this.sasInput || !this.sasInput) return
    const { digits, complete } = sasDigits(this.sasInput.value)
    if (this.sasInput.value !== digits) this.sasInput.value = digits
    const go = this.card.querySelector<HTMLButtonElement>('[data-rr="sas-go"]')
    if (go) go.disabled = !complete || this.pairing?.busy === true
  }

  private onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Enter' && ev.target === this.sasInput) { ev.preventDefault(); void this.sendSas(); return }
    if (ev.key === 'Escape' && this.asking) {
      ev.preventDefault()
      ev.stopPropagation()
      const a = this.asking
      this.asking = undefined
      this.paint()
      this.refocus(a)
    }
  }

  /** What the E2E reads: the head, the rows as drawn, the open confirmation and the pairing card. */
  snapshot(): {
    head: string; acts: string[]; ask?: string; paints: number
    rows: { id: string; text: string; state?: string; acts: string[]; panel?: string }[]
    pair?: { phase: string; title: string; code: string; clock: string; qr: boolean; text: string; typing: boolean }
  } {
    const cardOn = !this.card.hidden
    return {
      head: this.head.querySelector('[data-role="state"]')?.textContent ?? '',
      acts: [...this.head.querySelectorAll<HTMLButtonElement>('button[data-rr]')].filter(b => !b.disabled).map(b => b.dataset.rr!),
      ...(!this.ask.hidden && this.ask.textContent ? { ask: this.ask.textContent } : {}),
      paints: this.paints,
      rows: [...this.list.querySelectorAll<HTMLElement>('.rg-sr.device')].map(r => {
        const panel = r.querySelector('.rg-sr-x')
        return {
          id: r.dataset.device ?? '', text: r.querySelector('.rg-sr-h')?.textContent ?? '', ...(r.dataset.state ? { state: r.dataset.state } : {}),
          acts: [...r.querySelectorAll<HTMLElement>('.rg-sr-h button[data-rr]')].map(b => b.dataset.rr!),
          ...(panel ? { panel: panel.textContent ?? '' } : {}),
        }
      }),
      ...(cardOn ? {
        pair: {
          phase: this.card.dataset.phase ?? '', title: this.card.querySelector('.rr-pair-t')?.textContent ?? '',
          code: this.card.querySelector('[data-role="code"]')?.textContent ?? '', clock: this.card.querySelector('[data-role="clock"]')?.textContent ?? '',
          qr: this.card.querySelector('svg.rr-qr') !== null, text: this.card.textContent ?? '', typing: this.sasInput !== undefined && !this.sasInput.disabled,
        },
      } : {}),
    }
  }
}
