// Pairing from the device (fio-spec 3.4): the person types on the device the 12 digits the machine shows (or opens the
// QR link), the device shows the six digits (SAS) the person types ON THE MACHINE, and only a PAIR_DONE that proves the
// machine knew S is kept. K_D and K_A are born here, non-extractable, and reach the IndexedDB only at step 13.
// Rule of step 9: once P1 is sent, any failure kills the code on this device. It never retries by itself and never
// takes the same code again; the person asks the machine for a new one.
import {
  accessFromCode, accessFromQr, DevicePairing, generateRoleKey, parseQrFragment, toHex, WireError,
  type DevicePairFailure, type PairAccess,
} from '../../../src/remote/index.ts'
import { audOf, LinkClosed, RelayLink } from './link.ts'
import { Live } from './live.ts'
import { saveHouse, type HouseRecord } from './store.ts'

export type PairOutcome =
  | { ok: true; record: HouseRecord; live: Live; houseNowS: number }
  | { ok: false; kind: PairFailKind }

export type PairFailKind =
  /** The code is not 12 digits (nothing was sent). */
  | 'bad-code'
  /** This code already went to the machine from this page: it is dead (step 9). */
  | 'used-code'
  /** The relay could not be reached (nothing was sent). */
  | 'unreachable'
  /** The relay knows no pairing for this code: wrong, expired, or the machine is not listening. Nothing was revealed. */
  | 'not-accepted'
  /** The machine refused or ended the ceremony after the SAS was shown (wrong digits, time out, cancelled). */
  | 'refused'
  /** The time of the ceremony ran out. */
  | 'expired'
  /** The machine did not prove itself (P4) or did not confirm (houseConfirm, spec 3.4 step 13). */
  | 'not-confirmed'
  /** The link fell before the SAS was shown. */
  | 'cut'

/** Meeting points this page already used: a code is good for one attempt (spec 3.1 hole 2). In memory only. */
const usedRv = new Set<string>()

export function normalizeCode(input: string): string {
  return input.replace(/[\s -]/g, '')
}

/** A device name for the house's screen: generic, short, and only a declaration (spec 3.4 step 10, B-3). */
export function deviceName(ua: string = navigator.userAgent): string {
  const os = /Android/.test(ua) ? 'Android' : /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : ''
  return os ? `Navegador (${os})` : 'Navegador'
}

function failKind(reason: DevicePairFailure, sasShown: boolean): PairFailKind {
  switch (reason) {
    case 'timeout': return 'expired'
    case 'house-not-proven': case 'house-not-confirmed': case 'house-id-mismatch': case 'version-downgrade': return 'not-confirmed'
    case 'hs-fail': return 'refused'
    case 'route-closed': case 'closed': return sasShown ? 'refused' : 'cut'
    case 'protocol': return 'not-confirmed'
  }
}

export interface PairInput {
  /** The typed code (12 digits, spaces and hyphens allowed), or a `#pair=` fragment from the QR. */
  code?: string
  qrFragment?: string
  /** The relay of this origin; a QR must name the same host (spec 3.2). */
  relayUrl: string
  onSas: (sas: string) => void
}

/** The QR blob's relay is accepted only when it is this origin's relay. Returns the access, or why not. */
async function accessOf(p: PairInput): Promise<PairAccess | PairFailKind> {
  try {
    if (p.qrFragment !== undefined) {
      const blob = parseQrFragment(p.qrFragment)
      if (blob.relayHost !== audOf(p.relayUrl)) return 'not-accepted'
      return await accessFromQr(blob)
    }
    return await accessFromCode(normalizeCode(p.code ?? ''))
  } catch (e) {
    if (e instanceof WireError) return 'bad-code'
    throw e
  }
}

export async function pair(p: PairInput): Promise<PairOutcome> {
  const access = await accessOf(p)
  if (typeof access === 'string') return { ok: false, kind: access }
  const rvHex = toHex(access.rv)
  if (usedRv.has(rvHex)) return { ok: false, kind: 'used-code' }

  let link: RelayLink
  try { link = await RelayLink.open(p.relayUrl) } catch { return { ok: false, kind: 'unreachable' } }
  let sasShown = false
  try {
    const hello = await link.next(5_000)
    if (!hello || hello.type !== 'R_HELLO') { link.close(); return { ok: false, kind: 'unreachable' } }
    link.sendFrame({ type: 'D_PAIR', rv: access.rv })
    const ok = await link.next(5_000)
    if (!ok || ok.type !== 'R_OK') { link.close(); return { ok: false, kind: 'not-accepted' } }

    const kD = await generateRoleKey('device')
    const kA = await generateRoleKey('admission')
    const { pairing, effects } = await DevicePairing.start({ access, kD: kD.key, kA: kA.key, name: deviceName(), caps: 0, nowMs: Date.now() })
    usedRv.add(rvHex) // P1 goes out with the effects below: from here the code is spent
    let fx = effects
    for (;;) {
      for (const e of fx) {
        if (e.t === 'send') link.sendFrame({ type: 'DATA', inner: e.frame })
        else if (e.t === 'show-sas') { sasShown = true; p.onSas(e.sas) }
        else if (e.t === 'failed') { link.close(); return { ok: false, kind: failKind(e.reason, sasShown) } }
        else {
          // Step 13: persist first (as pending), then the PAIR_ACK that follows in the same list goes out.
          const r = e.result
          const record: HouseRecord = {
            id: toHex(r.houseId), houseId: r.houseId, pubH: r.pubH, deviceId: r.deviceId,
            kD: { privateKey: kD.privateKey, pub: kD.pub }, kA: { privateKey: kA.privateKey, pub: kA.pub },
            relayUrl: p.relayUrl, aud: audOf(p.relayUrl), admitTicket: r.admitTicket, pinnedVer: r.pinnedVer,
            houseName: r.houseName, state: 'pending', pairedAtMs: Date.now(),
          }
          await saveHouse(record)
          const rest = fx.slice(fx.indexOf(e) + 1)
          for (const s of rest) if (s.t === 'send') link.sendFrame({ type: 'DATA', inner: s.frame })
          return { ok: true, record, live: new Live(e.session, link), houseNowS: r.houseNow }
        }
      }
      let f
      try { f = await link.next(1_000) } catch (err) {
        if (!(err instanceof LinkClosed)) throw err
        fx = await pairing.routeClosed()
        if (!fx.some((x) => x.t === 'failed')) return { ok: false, kind: sasShown ? 'refused' : 'cut' }
        continue
      }
      if (!f) { fx = await pairing.tick(Date.now()); continue }
      if (f.type !== 'DATA') continue
      fx = await pairing.onFrame(f.inner, Date.now())
    }
  } catch (e) {
    link.close()
    if (e instanceof LinkClosed) return { ok: false, kind: sasShown ? 'refused' : 'cut' }
    throw e
  }
}
