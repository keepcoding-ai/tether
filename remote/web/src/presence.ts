// Presence from the device (fio-spec 7.4, step 2.4): the one registration of a platform credential, right after pairing,
// and the one way to prove the person is in front of this device before something that needs it (unlock, elevate, an
// act). The challenges come from the wire module, never from the house's bytes: the house sends only `uvCtr`, and the
// device derives the challenge from the session it is in, so a challenge of another session or act cannot be signed.
//
// Profile (spec 7.4 point 7): ES256 only, attestation "none", a platform authenticator, user verification required.
// What the device keeps of the credential is its id, in the house record, for `allowCredentials`.
//
// The JSON bodies of `uv.challenge` and `uv.assert` live here and nowhere else (CHALLENGE_BODY, ASSERT_BODY); their
// strict keys are the op table's (src/remote/scopes.ts).
import {
  assertionChallenge, b64url, opByName, randomBytes, registrationChallenge, RES_STATUS,
  type Bytes, type PresenceContext, type UvProof,
} from '../../../src/remote/index.ts'
import type { Live, Reply } from './live.ts'

const REGISTER = opByName('uv.register')!.code
const CHALLENGE = opByName('uv.challenge')!.code
const ASSERT = opByName('uv.assert')!.code
const CEREMONY_MS = 120_000

export type PresenceFail =
  /** The person closed the prompt, or it timed out (NotAllowedError). */
  | 'cancelled'
  /** No platform authenticator with user verification here, or no ES256 on it. */
  | 'no-biometrics'
  /** The browser refused the ceremony for another reason (security, state). */
  | 'browser-refused'
  /** The machine did not accept the registration or the proof. */
  | 'house-refused'
  /** The registration window of the pairing session is over: protecting now means pairing again (spec 7.4 point 1). */
  | 'too-late'
  /** The session ended or did not answer. */
  | 'cut'
  /** Nothing is registered on this device: it only reads. */
  | 'no-credential'

export type PresenceOutcome<T = object> = ({ ok: true } & T) | { ok: false; fail: PresenceFail }

/** Whether this browser can offer a platform authenticator with user verification. Never throws. */
export async function biometricsAvailable(): Promise<boolean> {
  try {
    if (typeof PublicKeyCredential === 'undefined' || !navigator.credentials) return false
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch { return false }
}

const buf = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer
const bytesOf = (b: ArrayBuffer): Bytes => new Uint8Array(b.slice(0))

function browserFail(e: unknown): PresenceFail {
  const name = e instanceof DOMException ? e.name : ''
  if (name === 'NotAllowedError' || name === 'AbortError') return 'cancelled'
  if (name === 'NotSupportedError') return 'no-biometrics'
  return 'browser-refused'
}

function replyFail(r: Reply): PresenceFail {
  return r.status === -1 ? 'cut' : 'house-refused'
}

/** The challenge of the registration, `registrationChallenge(sessionId, pub_D)`, computed when the offer is shown. */
export function registrationOf(fresh: Live, pubD: Uint8Array): Promise<Bytes> {
  return registrationChallenge(fresh.sessionId, pubD)
}

/**
 * The registration (spec 7.4 point 1): only on the session that concluded the pairing, once, within its window. The
 * challenge comes ready (`registrationOf`), so the ceremony starts inside the person's tap with nothing awaited before
 * it (Safari asks for the user activation). Returns the credential id to keep in the house record.
 */
export async function registerPresence(o: { fresh: Live; challenge: Uint8Array; houseName: string }): Promise<PresenceOutcome<{ credentialId: Bytes }>> {
  if (o.fresh.ended) return { ok: false, fail: 'too-late' }
  const challenge = o.challenge
  let cred: PublicKeyCredential
  try {
    const c = await navigator.credentials.create({
      publicKey: {
        challenge: buf(challenge),
        rp: { name: 'Tether' },
        // A fresh handle: nothing of the house or of this device's keys goes to the authenticator.
        user: { id: buf(randomBytes(16)), name: o.houseName || 'Tether', displayName: o.houseName || 'Tether' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
        attestation: 'none',
        timeout: CEREMONY_MS,
      },
    })
    if (!(c instanceof PublicKeyCredential)) return { ok: false, fail: 'browser-refused' }
    cred = c
  } catch (e) { return { ok: false, fail: browserFail(e) } }
  const res = cred.response as AuthenticatorAttestationResponse
  if (o.fresh.ended) return { ok: false, fail: 'too-late' }
  const r = await o.fresh.request(REGISTER, {
    clientDataJSON: b64url(bytesOf(res.clientDataJSON)),
    attestationObject: b64url(bytesOf(res.attestationObject)),
  }, { mutates: true })
  if (r.status === RES_STATUS.ok) return { ok: true, credentialId: bytesOf(cred.rawId) }
  if (r.status === -1) return { ok: false, fail: o.fresh.ended ? 'too-late' : 'cut' }
  // The portal refuses a registration outside the pairing session or after its window with the same answer.
  return { ok: false, fail: r.status === RES_STATUS.badRequest ? 'house-refused' : 'too-late' }
}

/** What a proof is asked for. An act carries its op and its JSON body, sent exactly as hashed. */
export type PresenceAsk =
  | { purpose: 'unlock' }
  | { purpose: 'elevate'; deviceId: Uint8Array }
  | { purpose: 'act'; op: number; body: Record<string, unknown> }

/**
 * The body of `uv.challenge`: the purpose, and for an act its op. The actId and the body are not announced: the portal
 * recomputes the act's digest from the request that carries the proof (spec 7.4 point 4).
 */
function CHALLENGE_BODY(ask: PresenceAsk): Record<string, unknown> {
  return ask.purpose === 'act' ? { purpose: 'act', op: ask.op } : { purpose: ask.purpose }
}
/** The body of `uv.assert`: the proof travels in the request's own `uvProof` field; the portal holds the pending challenge. */
const ASSERT_BODY: Record<string, unknown> = {}

function uvCtrOf(r: Reply): number | undefined {
  const v = r.body.uvCtr
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff ? v : undefined
}

/**
 * The one way to prove presence before something that needs it. `uv.challenge` gives `uvCtr`; the device derives the
 * challenge (`assertionChallenge(sessionId, uvCtr, ctx)`), asks the platform authenticator for an assertion with user
 * verification, and builds the `UvProof`. Unlock and elevate send it in `uv.assert`; an act sends it with the act
 * itself, under the same actId and the same body bytes the challenge was bound to. Returns the answer to the request
 * that carried the proof.
 */
export async function withPresence(o: { live: Live; credentialId: Uint8Array | undefined; ask: PresenceAsk }): Promise<PresenceOutcome<{ reply: Reply }>> {
  const { live, ask } = o
  const act = ask.purpose === 'act' ? { actId: randomBytes(16), body: new TextEncoder().encode(JSON.stringify(ask.body)) } : undefined
  const proved = await proveFor(live, o.credentialId, ask, act)
  if (!proved.ok) return proved
  const uvProof = proved.uvProof
  const reply = act && ask.purpose === 'act'
    ? await live.request(ask.op, act.body, { actId: act.actId, uvProof })
    : await live.request(ASSERT, ASSERT_BODY, { mutates: true, uvProof })
  if (reply.status === RES_STATUS.ok || (act && reply.status !== -1 && reply.status !== RES_STATUS.presenceRequired)) return { ok: true, reply }
  return { ok: false, fail: replyFail(reply) }
}

/** What a proof is asked over: the session's challenge, and the request it travels with. */
export interface ProofSession {
  request(op: number, body?: Record<string, unknown> | Bytes, o?: { mutates?: boolean; actId?: Bytes; uvProof?: UvProof }): Promise<Reply>
  readonly ended: unknown
  readonly sessionId: Bytes
}

/**
 * The proof of ONE act, not sent: the caller sends the act itself with it (and sends it again, under the same actId and the
 * same body bytes, when the answer did not come: the portal answers the repeat with the real outcome). The challenge is bound
 * to this session, this op, this actId and these exact bytes (spec 7.4 point 4).
 */
export function proveAct(o: { live: ProofSession; credentialId: Uint8Array | undefined; op: number; actId: Bytes; body: Bytes }): Promise<PresenceOutcome<{ uvProof: UvProof }>> {
  return proveFor(o.live, o.credentialId, { purpose: 'act', op: o.op, body: {} }, { actId: o.actId, body: o.body })
}

/** The elevation window (spec 7.3 "janela"): the proof goes in `uv.assert`; the answer is the portal's. */
export async function elevate(o: { live: ProofSession; credentialId: Uint8Array | undefined; deviceId: Uint8Array }): Promise<PresenceOutcome> {
  const proved = await proveFor(o.live, o.credentialId, { purpose: 'elevate', deviceId: o.deviceId })
  if (!proved.ok) return proved
  const reply = await o.live.request(ASSERT, ASSERT_BODY, { mutates: true, uvProof: proved.uvProof })
  return reply.status === RES_STATUS.ok ? { ok: true } : { ok: false, fail: replyFail(reply) }
}

/** The challenge of `ask` from the portal, the assertion of the platform authenticator over it, as a `UvProof`. */
async function proveFor(live: ProofSession, credentialId: Uint8Array | undefined, ask: PresenceAsk, act?: { actId: Bytes; body: Bytes }): Promise<PresenceOutcome<{ uvProof: UvProof }>> {
  if (!credentialId) return { ok: false, fail: 'no-credential' }
  if (live.ended) return { ok: false, fail: 'cut' }
  const ch = await live.request(CHALLENGE, CHALLENGE_BODY(ask))
  if (ch.status !== RES_STATUS.ok) return { ok: false, fail: replyFail(ch) }
  const uvCtr = uvCtrOf(ch)
  if (uvCtr === undefined) return { ok: false, fail: 'house-refused' }
  const ctx: PresenceContext = ask.purpose === 'act' && act ? { purpose: 'act', op: ask.op, actId: act.actId, body: act.body } : ask.purpose === 'elevate' ? { purpose: 'elevate', deviceId: ask.deviceId } : { purpose: 'unlock' }
  const challenge = await assertionChallenge(live.sessionId, uvCtr, ctx)
  // The portal may echo the bytes it expects; this device signs only what it derived, and a mismatch is not signed.
  const echoed = ch.body.challenge
  if (echoed !== undefined && echoed !== b64url(challenge)) return { ok: false, fail: 'house-refused' }
  let res: AuthenticatorAssertionResponse
  try {
    const c = await navigator.credentials.get({
      publicKey: {
        challenge: buf(challenge),
        allowCredentials: [{ type: 'public-key', id: buf(credentialId), transports: ['internal'] }],
        userVerification: 'required',
        timeout: CEREMONY_MS,
      },
    })
    if (!(c instanceof PublicKeyCredential)) return { ok: false, fail: 'browser-refused' }
    res = c.response as AuthenticatorAssertionResponse
  } catch (e) { return { ok: false, fail: browserFail(e) } }
  return { ok: true, uvProof: { uvCtr, authenticatorData: bytesOf(res.authenticatorData), clientDataJSON: bytesOf(res.clientDataJSON), signature: bytesOf(res.signature) } }
}
