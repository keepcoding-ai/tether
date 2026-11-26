// The remote web client's skeleton (RR1 step 1.5): pair this device with a tether, keep its keys, and show who waits
// for the person, live. The relay of this origin comes from `<meta name="tether-relay">`, written by the build; a QR
// link (`#pair=`) must name the same relay. Order of a visit: self-test of the crypto, then the stored house (reconnect
// without pairing) or the pairing screen. Reconnection after a cut retries with backoff; nothing polls the house.
import { CLOSE, evtByCode, opByName, RES_STATUS, relayUrlAllowed, selfTest } from '../../../src/remote/index.ts'
import { parseWaiting, waitedFor, type WaitingList } from './attention.ts'
import { mount } from './dom.ts'
import { connect, type Ended, type Live } from './live.ts'
import { pair, type PairInput } from './pair.ts'
import {
  connectingScreen, hardScreen, idleScreen, isPairNotice, listScreen, offlineScreen, pairFailedScreen, pairScreen,
  pairWaitScreen, retryText, unsupportedScreen, type PairNotice,
} from './screens.ts'
import { deleteHouse, loadHouse, saveHouse, type HouseRecord } from './store.ts'

const root = document.getElementById('app') as HTMLElement
const relayUrl = document.querySelector<HTMLMetaElement>('meta[name="tether-relay"]')?.content ?? ''

const WATCH = opByName('attention.watch')!.code
/** A pending record whose first handshake fails this soon after pairing may be dropped (spec 3.4 step 14, E-15). */
const PENDING_GRACE_MS = 10 * 60_000
const RETRY_MAX_MS = 30_000
const SINCE_REFRESH_MS = 30_000

type View =
  | { s: 'pair'; notice?: PairNotice; value?: string }
  | { s: 'pair-wait'; sas?: string }
  | { s: 'pair-failed'; kind: 'refused' | 'expired' | 'not-confirmed' | 'cut' }
  | { s: 'connecting' }
  | { s: 'list'; notice?: string; problem?: string }
  | { s: 'offline' | 'hard' }
  | { s: 'idle' }
  | { s: 'unsupported' }

let view: View = { s: 'connecting' }
let record: HouseRecord | undefined
let live: Live | undefined
let list: WaitingList = { items: [], more: 0 }
/** House clock minus this clock, from the last HS_DONE: "há quanto tempo" is measured on the house's clock. */
let skewMs = 0
let busy = false
const retry = { attempt: 0, timer: 0 as ReturnType<typeof setTimeout> | 0, atMs: 0 }

const TITLE: Record<View['s'], string> = {
  pair: 'Parear', 'pair-wait': 'Parear', 'pair-failed': 'Parear', connecting: 'Conectando', list: 'Esperam você',
  offline: 'Offline', hard: 'Atenção', idle: 'Sessão fechada', unsupported: 'Navegador sem suporte',
}

function show(v: View): void {
  view = v
  root.dataset.view = v.s
  document.title = `${TITLE[v.s]} · Tether`
  render()
}

function retryInS(): number | undefined {
  return retry.timer ? Math.max(0, Math.ceil((retry.atMs - Date.now()) / 1000)) : undefined
}

function render(): void {
  const v = view
  switch (v.s) {
    case 'pair': {
      mount(root, pairScreen({ ...(v.notice ? { notice: v.notice } : {}), ...(v.value ? { value: v.value } : {}), onSubmit: (code) => void startPair({ code }) }))
      root.querySelector<HTMLInputElement>('#pair-code')?.focus()
      return
    }
    case 'pair-wait': mount(root, pairWaitScreen(v.sas !== undefined ? { sas: v.sas } : {})); return
    case 'pair-failed': mount(root, pairFailedScreen(v.kind, () => show({ s: 'pair' }))); return
    case 'connecting': mount(root, connectingScreen()); return
    case 'list':
      mount(root, listScreen({ list, nowMs: Date.now() + skewMs, houseName: record?.houseName ?? '', ...(v.notice ? { notice: v.notice } : {}), ...(v.problem ? { problem: v.problem } : {}) }))
      return
    case 'offline': mount(root, offlineScreen({ retryInS: retryInS(), onRetry: retryNow })); return
    case 'hard': mount(root, hardScreen({ retryInS: retryInS(), onRetry: retryNow })); return
    case 'idle': mount(root, idleScreen(retryNow)); return
    case 'unsupported': mount(root, unsupportedScreen()); return
  }
}

// ---- pairing ----------------------------------------------------------------------------------------------------

async function startPair(input: Omit<PairInput, 'relayUrl' | 'onSas'>): Promise<void> {
  if (busy) return
  busy = true
  show({ s: 'pair-wait' })
  let fresh: Live | undefined
  try {
    const out = await pair({ ...input, relayUrl, onSas: (sas) => show({ s: 'pair-wait', sas }) })
    if (!out.ok) {
      if (isPairNotice(out.kind)) show({ s: 'pair', notice: out.kind, ...(out.kind === 'bad-code' && input.code ? { value: input.code } : {}) })
      else show({ s: 'pair-failed', kind: out.kind as Exclude<typeof out.kind, PairNotice> })
      return
    }
    record = out.record
    fresh = out.live
    fresh.onEnded = () => {}
  } catch {
    show({ s: 'unsupported' })
    return
  } finally {
    busy = false
  }
  // The session that concluded the pairing stays quiet: the portal of RR1.3 may lose a record that arrives right after
  // PAIR_ACK, before it adopts the session. A normal session follows at once (it also makes the record definitive,
  // E-15); the quiet one is closed only after, when the house surely holds it as a session.
  await reconnect({ afterPair: true })
  void fresh.close(CLOSE.normal)
}

// ---- the session --------------------------------------------------------------------------------------------------

async function adopt(l: Live, notice?: string): Promise<void> {
  live = l
  retry.attempt = 0
  l.onEvent = (evt, body) => {
    if (evtByCode(evt)?.name !== 'attention.changed') return
    const w = parseWaiting(body)
    if (!w) return
    list = w
    if (view.s === 'list') show({ s: 'list' })
  }
  l.onEnded = (e) => { if (live === l) { live = undefined; void ended(e) } }
  const r = await l.request(WATCH)
  if (l.ended) return
  if (r.status === RES_STATUS.ok) {
    list = parseWaiting(r.body) ?? { items: [], more: 0 }
    show({ s: 'list', ...(notice ? { notice } : {}) })
  } else {
    show({ s: 'list', problem: r.status === RES_STATUS.noScope ? 'Este aparelho não tem permissão para ver quem espera você.' : 'A máquina não mandou a lista agora.' })
  }
}

async function reconnect(o: { afterPair?: boolean } = {}): Promise<void> {
  if (busy || !record) return
  busy = true
  clearRetry()
  if (view.s !== 'offline' && view.s !== 'hard') show({ s: 'connecting' })
  else render()
  const rec = record
  try {
    const r = await connect(rec)
    if (r.ok) {
      skewMs = r.info.houseNow * 1000 - Date.now()
      if (rec.state === 'pending' || r.info.pinnedVer !== rec.pinnedVer) {
        record = { ...rec, state: 'active', pinnedVer: Math.max(rec.pinnedVer, r.info.pinnedVer) }
        await saveHouse(record)
      }
      await adopt(r.live, o.afterPair ? 'Aparelho pareado.' : undefined)
      return
    }
    // Not on the connection right after pairing: the house may still be taking the PAIR_ACK in.
    if (!o.afterPair && r.why === 'hs-fail' && rec.state === 'pending' && Date.now() - rec.pairedAtMs < PENDING_GRACE_MS) {
      await deleteHouse(rec.id)
      record = undefined
      show({ s: 'pair', notice: 'pending-failed' })
      return
    }
    scheduleRetry(r.why === 'house-not-proven' ? 'hard' : 'offline')
  } catch {
    scheduleRetry('offline')
  } finally {
    busy = false
  }
}

async function ended(e: Ended): Promise<void> {
  const code = e.by === 'route' ? undefined : e.code
  if (e.by === 'peer' && code === CLOSE.revoked) {
    // Spec 4.7: CLOSE(0x04) erases this house from the device, keys included.
    if (record) await deleteHouse(record.id).catch(() => undefined)
    record = undefined
    list = { items: [], more: 0 }
    show({ s: 'pair', notice: 'revoked' })
    return
  }
  if (e.by === 'peer' && code === CLOSE.idle) { show({ s: 'idle' }); return }
  if (code === CLOSE.rekey) { void reconnect(); return }
  scheduleRetry('offline')
}

function clearRetry(): void {
  if (retry.timer) clearTimeout(retry.timer)
  retry.timer = 0
}

function scheduleRetry(kind: 'offline' | 'hard'): void {
  clearRetry()
  const base = Math.min(RETRY_MAX_MS, 1000 * 2 ** retry.attempt)
  const delay = Math.round(base * (1 + Math.random() * 0.2))
  retry.attempt++
  retry.atMs = Date.now() + delay
  retry.timer = setTimeout(() => { retry.timer = 0; void reconnect() }, delay)
  show({ s: kind })
}

function retryNow(): void {
  retry.attempt = 0
  void reconnect()
}

// ---- boot ----------------------------------------------------------------------------------------------------------

async function boot(): Promise<void> {
  try {
    await selfTest()
    if (typeof indexedDB === 'undefined' || !relayUrlAllowed(relayUrl)) throw new Error('unsupported')
  } catch {
    show({ s: 'unsupported' })
    return
  }
  // A QR link carries R and S in the fragment (spec 3.2): read it once, then take it out of the address and history.
  const fragment = location.hash
  if (fragment.startsWith('#pair=')) history.replaceState(null, '', location.pathname + location.search)
  try { record = await loadHouse() } catch { show({ s: 'unsupported' }); return }
  if (fragment.startsWith('#pair=') && !record) { void startPair({ qrFragment: fragment }); return }
  if (!record) { show({ s: 'pair' }); return }
  void reconnect()
}

// The countdown and "há quanto tempo" are rewritten in place from memory; no request leaves for them.
setInterval(() => {
  if (!retry.timer || (view.s !== 'offline' && view.s !== 'hard')) return
  const t = root.querySelector('.status-text')
  if (t) t.textContent = retryText(retryInS())
}, 1_000)
setInterval(() => {
  if (view.s !== 'list') return
  for (const li of root.querySelectorAll<HTMLElement>('.waiting-item')) {
    const t = li.querySelector('.wi-since')
    if (t) t.textContent = waitedFor(Number(li.dataset.since), Date.now() + skewMs)
  }
}, SINCE_REFRESH_MS)
addEventListener('online', () => { if (view.s === 'offline') retryNow() })
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && view.s === 'offline') retryNow() })

void boot()
