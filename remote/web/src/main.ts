// The remote web client (RR1 step 1.5, RR3 step 3.4c): pair this device with a tether, keep its keys, and show the
// house's Regency, reading only, live. Once the session is unlocked (and the offer to protect the device is over), the
// screen is the Regency (regency.ts) over the session's source (source.ts); while the house is out of reach, the same
// casing shows only "offline", with the last contact and "Tentar agora". Nothing of the house is written to the device:
// the keys and the record of the pairing are, and nothing else. The relay of this origin comes from `<meta name="tether-relay">`, written by the build; a QR
// link (`#pair=`) must name the same relay. Order of a visit: self-test of the crypto, then the stored house (reconnect
// without pairing) or the pairing screen. Reconnection after a cut retries with backoff; nothing polls the house.
import { CLOSE, evtByCode, opByName, RES_STATUS, relayUrlAllowed, selfTest } from '../../../src/remote/index.ts'
import { parseWaiting, waitedFor, type WaitingList } from './attention.ts'
import { mount } from './dom.ts'
import { browserLocks, holdHouse, type HouseLock } from './house-lock.ts'
import { connect, type Ended, type Live } from './live.ts'
import { pair, type PairInput } from './pair.ts'
import { createPush } from './push.ts'
import { createManager, type Manager } from './manage.ts'
import { biometricsAvailable, elevate, proveAct, registerPresence, registrationOf, withPresence } from './presence.ts'
import { mountRegency, type RemoteRegency } from './regency.ts'
import { sessionSource, type SessionSource } from './source.ts'
import { createTalker, type Talker } from './talk.ts'
import {
  connectingScreen, elsewhereScreen, hardScreen, idleScreen, isPairNotice, listScreen, offlineScreen, pairFailedScreen, pairScreen,
  pairWaitScreen, retryText, unsupportedScreen, type Guard, type Lock, type PairNotice,
} from './screens.ts'
import { deleteHouse, loadHouse, saveHouse, type HouseRecord } from './store.ts'
import { paramsOfUrlState, parseUrlState, urlStateOf, writeUrlState } from './url-state.ts'

const root = document.getElementById('app') as HTMLElement
const relayUrl = document.querySelector<HTMLMetaElement>('meta[name="tether-relay"]')?.content ?? ''

const WATCH = opByName('attention.watch')!.code
/** A pending record whose first handshake fails this soon after pairing may be dropped (spec 3.4 step 14, E-15). */
const PENDING_GRACE_MS = 10 * 60_000
/** The pairing session accepts `uv.register` for 5 min (spec 7.4 point 1); the offer closes a little before. */
const REGISTER_WINDOW_MS = 5 * 60_000 - 15_000
const RETRY_MAX_MS = 30_000
const SINCE_REFRESH_MS = 30_000

type View =
  | { s: 'pair'; notice?: PairNotice; value?: string }
  | { s: 'pair-wait'; sas?: string }
  | { s: 'pair-failed'; kind: 'refused' | 'expired' | 'not-confirmed' | 'cut' }
  | { s: 'connecting' }
  | { s: 'list'; notice?: string; problem?: string }
  | { s: 'regency' }
  | { s: 'offline' | 'hard' }
  | { s: 'idle' }
  | { s: 'elsewhere' }
  | { s: 'unsupported' }

let view: View = { s: 'connecting' }
let record: HouseRecord | undefined
let live: Live | undefined
let list: WaitingList = { items: [], more: 0 }
/** House clock minus this clock, from the last HS_DONE: "há quanto tempo" is measured on the house's clock. */
let skewMs = 0
let busy = false
/** The session that concluded the pairing, kept only while it may still register the presence credential. */
let pairing: Live | undefined
let pairingTimer: ReturnType<typeof setTimeout> | 0 = 0
let regChallenge: Uint8Array = new Uint8Array(0)
/** Presence of this device when nothing is registered; a stored credential always reads as protected. */
let guard: Guard = { s: 'read-only' }
let lock: Lock | undefined
const retry = { attempt: 0, timer: 0 as ReturnType<typeof setTimeout> | 0, atMs: 0 }
/** The Regency's casing, while the screen is the Regency or its "offline" notice. */
let regency: RemoteRegency | undefined
/** The source over the session the Regency reads now; one per session. */
let source: { live: Live; src: SessionSource } | undefined
/** When the house last answered, on this device's clock (memory only: the offline notice says it). */
let lastContactMs: number | undefined
/** One session per device and house across tabs: this tab talks to the house only while it holds the lock. */
let houseLock: HouseLock | undefined
let holdsHouse = true

const TITLE: Record<View['s'], string> = {
  pair: 'Parear', 'pair-wait': 'Parear', 'pair-failed': 'Parear', connecting: 'Conectando', list: 'Esperam você',
  regency: 'Regência', offline: 'Offline', hard: 'Atenção', idle: 'Sessão fechada', elsewhere: 'Outra janela', unsupported: 'Navegador sem suporte',
}

function dropSource(): void {
  source?.src.dispose()
  source = undefined
  talker?.detach()
  manager?.detach()
  devicePush.detach()
}

/**
 * Managing from afar (manage.ts), for the house this device knows: one per record, like the talker. Only a device with a
 * presence credential manages; the proofs are the platform authenticator's, over the session the act goes in.
 */
let manager: Manager | undefined
let managerOf = ''

function managerFor(rec: HouseRecord | undefined): Manager | undefined {
  if (!rec?.credentialId) return undefined
  if (manager && managerOf === rec.id) return manager
  manager?.dispose()
  managerOf = rec.id
  const cred = (): Uint8Array | undefined => record?.credentialId
  manager = createManager({
    credential: true,
    prover: {
      act: (s, op, actId, body) => proveAct({ live: s, credentialId: cred(), op, actId, body }),
      window: (s, deviceId) => elevate({ live: s, credentialId: cred(), deviceId }),
    },
  })
  manager.onLocked = () => { if (live) locked(live) }
  return manager
}

/** "Avisos neste aparelho" (push.ts): one per page; the session it reads is the Regency's. */
const devicePush = createPush()
const VISIBLE = opByName('session.visible')!.code

/** Tells the house whether this page is on the person's screen: it sends no notice to a device that is looking (step 4.4). */
function sayVisible(l: Live | undefined): void {
  if (l && !l.ended) void l.request(VISIBLE, { visible: document.visibilityState === 'visible' })
}

/**
 * The person's acts in the channels (talk.ts), for the house this device knows: one per record, kept across sessions (the
 * outbox waits for the next one). Only a device with a presence credential converses; one that only reads has none.
 */
let talker: Talker | undefined
let talkerOf = ''

function talkerFor(rec: HouseRecord | undefined): Talker | undefined {
  if (!rec?.credentialId) return undefined
  if (talker && talkerOf === rec.id) return talker
  talker?.dispose()
  talkerOf = rec.id
  talker = createTalker({ houseId: rec.id })
  talker.onLocked = () => { if (live) locked(live) }
  return talker
}

const LOCK = opByName('session.lock')!.code

/** "Trancar": the session locks at the device's asking, and the screen is the one of a locked session. */
async function lockHere(): Promise<void> {
  const l = live
  if (!l || lock) return
  talker?.detach()
  manager?.detach()
  const r = await l.request(LOCK, {}, { mutates: true })
  if (live !== l) return
  if (r.status === RES_STATUS.ok) { lock = { busy: false }; show({ s: 'list' }) } else if (!l.ended) { talker?.attach(l); manager?.attach(l) }
}

function show(v: View): void {
  // The casing lives through "Regência" and "offline"; any other screen lets it go, and what it read with it.
  if (v.s !== 'regency' && !(v.s === 'offline' && record)) {
    dropSource()
    regency?.dispose()
    regency = undefined
  }
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
      mount(root, listScreen({
        list, nowMs: Date.now() + skewMs, houseName: record?.houseName ?? '', ...(v.notice ? { notice: v.notice } : {}), ...(v.problem ? { problem: v.problem } : {}),
        guard: record?.credentialId ? { s: 'protected' } : guard, ...(lock ? { lock } : {}),
        onProtect: () => void protect(), onUnlock: () => void unlock(), onSkip: endPairingSession,
      }))
      return
    case 'regency': {
      const r = casing()
      const l = live
      if (l && source?.live !== l) {
        dropSource()
        const src = sessionSource(l, { onLocked: () => locked(l), onContact: () => { lastContactMs = Date.now() } })
        source = { live: l, src }
        r.online(src)
        // Unlocked and on screen: what waited to be said goes now, with its own actId.
        const t = talkerFor(record)
        t?.attach(l)
        managerFor(record)?.attach(l)
        if (t) devicePush.attach(l)
      }
      return
    }
    case 'offline': {
      if (!record) { mount(root, offlineScreen({ retryInS: retryInS(), onRetry: retryNow })); return }
      dropSource()
      casing().offline({ ...(lastContactMs !== undefined ? { lastContactMs } : {}), ...(retryInS() !== undefined ? { retryInS: retryInS() } : {}) })
      return
    }
    case 'hard': mount(root, hardScreen({ retryInS: retryInS(), onRetry: retryNow })); return
    case 'idle': mount(root, idleScreen(retryNow)); return
    case 'elsewhere':
      mount(root, elsewhereScreen(() => houseLock?.takeOver()))
      root.querySelector<HTMLButtonElement>('.btn')?.focus()
      return
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
  } catch {
    show({ s: 'unsupported' })
    return
  } finally {
    busy = false
  }
  // The session that concluded the pairing stays quiet: the portal of RR1.3 may lose a record that arrives right after
  // PAIR_ACK, before it adopts the session. A normal session follows at once (it also makes the record definitive,
  // E-15). The quiet one is the only session that may register the presence credential (spec 7.4 point 1), so it is
  // kept open for the registration window, while the screen offers it, and closed when the offer is over.
  const kept = fresh
  pairing = kept
  kept.onEnded = () => { if (pairing === kept) { pairing = undefined; offerOver() } }
  regChallenge = await registrationOf(kept, record.kD.pub)
  guard = (await biometricsAvailable()) ? { s: 'offer' } : { s: 'read-only', fail: 'no-biometrics' }
  pairingTimer = setTimeout(() => endPairingSession(), REGISTER_WINDOW_MS)
  await claimHouse({ afterPair: true })
  if (guard.s === 'read-only') endPairingSession()
}

// ---- presence (spec 7.4) ---------------------------------------------------------------------------------------------

function endPairingSession(): void {
  if (pairingTimer) clearTimeout(pairingTimer)
  pairingTimer = 0
  const p = pairing
  pairing = undefined
  if (p && !p.ended) void p.close(CLOSE.normal)
  offerOver()
}

/** The registration window closed (or the person said "Agora não"): an offer still open becomes "read only". */
function offerOver(): void {
  if (guard.s !== 'offer' && guard.s !== 'registering') return
  guard = { s: 'read-only' }
  if (view.s !== 'list') return
  if (live && !lock) enter()
  else render()
}

// ---- the Regency ------------------------------------------------------------------------------------------------------

function casing(): RemoteRegency {
  const talk = talkerFor(record)
  regency ??= mountRegency(root, {
    houseName: record?.houseName ?? '', onRetry: retryNow,
    ...(talk ? { talk, onLock: () => void lockHere(), push: devicePush } : {}),
    ...(talk && managerFor(record) ? { manage: managerFor(record)! } : {}),
    layout: {
      initial: paramsOfUrlState(parseUrlState(location.search)),
      changed: l => writeUrlState(location, history, urlStateOf(l)),
      tabAsked: () => parseUrlState(location.search).narrowTab !== undefined,
    },
  })
  return regency
}

/**
 * The session is open and unlocked: the screen is the Regency. While the offer to protect this device is open (right after
 * pairing, for the registration window), the list stays, with the offer: it is the one moment the device may take it.
 */
function enter(notice?: string): void {
  if (guard.s === 'offer' || guard.s === 'registering') show({ s: 'list', ...(notice ? { notice } : {}) })
  else show({ s: 'regency' })
}

/** A reading answered "trancado": the session asks for presence; the unlock panel takes the screen. */
function locked(l: Live): void {
  if (live !== l || lock) return
  lock = { busy: false }
  show({ s: 'list' })
}

async function protect(): Promise<void> {
  const rec = record
  const p = pairing
  if (!rec || guard.s !== 'offer') return
  if (!p) { guard = { s: 'read-only', fail: 'too-late' }; render(); return }
  guard = { s: 'registering' }
  render()
  const r = await registerPresence({ fresh: p, challenge: regChallenge, houseName: rec.houseName })
  if (!r.ok) {
    guard = r.fail === 'too-late' || r.fail === 'no-biometrics' ? { s: 'read-only', fail: r.fail } : { s: 'offer', fail: r.fail }
    if (guard.s === 'read-only') endPairingSession()
    render()
    return
  }
  record = { ...rec, credentialId: r.credentialId }
  await saveHouse(record)
  guard = { s: 'protected' }
  endPairingSession()
  render()
  // The pairing session is born locked (E-10); the first unlock follows the registration at once.
  if (live) void unlock()
}

/** Asks for presence ("destrancar") and, once the machine takes it, asks for the list again. */
async function unlock(): Promise<void> {
  const l = live
  if (!l || lock?.busy) return
  lock = { busy: true }
  render()
  const r = await withPresence({ live: l, credentialId: record?.credentialId, ask: { purpose: 'unlock' } })
  if (live !== l) return
  if (!r.ok) { lock = { busy: false, fail: r.fail }; render(); return }
  lock = undefined
  await watch(l)
}

// ---- the session --------------------------------------------------------------------------------------------------

async function adopt(l: Live, notice?: string): Promise<void> {
  live = l
  retry.attempt = 0
  lastContactMs = Date.now()
  l.onEvent = (evt, body) => {
    if (live === l) lastContactMs = Date.now()
    if (source?.live === l && source.src.heard(evt, body)) return
    if (evtByCode(evt)?.name !== 'attention.changed') return
    const w = parseWaiting(body)
    if (!w) return
    list = w
    if (view.s === 'list') show({ s: 'list' })
  }
  l.onEnded = (e) => { if (live === l) { live = undefined; lock = undefined; void ended(e) } }
  lock = undefined
  sayVisible(l)
  await watch(l, notice)
}

/**
 * Subscribes to the list, which also tells whether the session is unlocked. A locked session (status 0x04) asks for
 * presence first: the unlock panel takes its place. Unlocked, the screen is the Regency (with or without the list: a
 * device without `attention` still reads what its other scopes let it).
 */
async function watch(l: Live, notice?: string): Promise<void> {
  const r = await l.request(WATCH)
  if (l.ended || live !== l) return
  if (r.status === RES_STATUS.locked) {
    lock = { busy: false }
    show({ s: 'list', ...(notice ? { notice } : {}) })
    return
  }
  if (r.status === RES_STATUS.ok) list = parseWaiting(r.body) ?? { items: [], more: 0 }
  enter(notice)
}

/**
 * Takes this house's lock (one session per device across tabs) and connects once this tab holds it. Before pairing there
 * is no house id and so no lock.
 */
function claimHouse(o: { afterPair?: boolean } = {}): Promise<void> {
  houseLock?.release()
  houseLock = undefined
  if (!record) return Promise.resolve()
  let first: { afterPair?: boolean } | undefined = o
  holdsHouse = false
  const lock = holdHouse(browserLocks(navigator), record.id, {
    own: () => { holdsHouse = true; const a = first ?? {}; first = undefined; return reconnect(a) },
    wait: yieldHouse,
  })
  houseLock = lock
  return lock.started
}

/** Another window holds the session: this one closes its own, cleanly, and says where the Regency is. */
function yieldHouse(): void {
  holdsHouse = false
  clearRetry()
  // The other window goes on with what waited to be said (the outbox is the origin's): this one sends nothing more.
  talker?.detach()
  manager?.detach()
  const l = live
  live = undefined
  lock = undefined
  if (l && !l.ended) void l.close(CLOSE.normal)
  show({ s: 'elsewhere' })
}

function dropHouseLock(): void {
  houseLock?.release()
  houseLock = undefined
  holdsHouse = true
}

async function reconnect(o: { afterPair?: boolean } = {}): Promise<void> {
  if (busy || !record || !holdsHouse) return
  busy = true
  clearRetry()
  if (view.s !== 'offline' && view.s !== 'hard') show({ s: 'connecting' })
  else render()
  const rec = record
  try {
    const r = await connect(rec)
    if (r.ok && !holdsHouse) {
      // The lock went to another window while this one was dialling.
      void r.live.close(CLOSE.normal)
      return
    }
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
      dropHouseLock()
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
    // Spec 4.7: CLOSE(0x04) erases this house from the device, keys included, and the person's text kept for it.
    if (record) await deleteHouse(record.id).catch(() => undefined)
    talker?.forget()
    talker?.dispose()
    talker = undefined
    talkerOf = ''
    manager?.dispose()
    manager = undefined
    managerOf = ''
    record = undefined
    dropHouseLock()
    list = { items: [], more: 0 }
    endPairingSession()
    guard = { s: 'read-only' }
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
  void claimHouse()
}

// The countdown and "há quanto tempo" are rewritten in place from memory; no request leaves for them.
setInterval(() => {
  if (!retry.timer || (view.s !== 'offline' && view.s !== 'hard')) return
  if (view.s === 'offline' && regency) { regency.retryIn(retryInS()); return }
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
document.addEventListener('visibilitychange', () => {
  sayVisible(live)
  if (document.visibilityState === 'visible' && view.s === 'offline') retryNow()
})

// The service worker holds the shell only (sw.ts): a new version takes over at the next visit, never under a screen in use.
if ('serviceWorker' in navigator) {
  // Trusted Types makes the worker's script URL a sink: the one policy the CSP names hands out only this file's name.
  const tt = (window as unknown as { trustedTypes?: { createPolicy(name: string, rules: { createScriptURL(u: string): string }): { createScriptURL(u: string): unknown } } }).trustedTypes
  const swPolicy = tt?.createPolicy('tether-sw', {
    createScriptURL: u => { if (u !== 'sw.js') throw new TypeError('sw.js only'); return u },
  })
  addEventListener('load', () => {
    const url = swPolicy ? (swPolicy.createScriptURL('sw.js') as string) : 'sw.js'
    navigator.serviceWorker.register(url, { scope: './' }).catch(() => undefined)
  })
}

void boot()
