// Managing from afar (RR5 5.4): the acts of a device that may manage, over the session it holds now. Every act has one actId,
// kept until its answer; when the session falls or the house says `timeout`, the same id goes again (the portal answers a
// repeat with the real outcome, never by doing it twice). An act that destroys travels with the proof of that very act
// (`uv.challenge` purpose act, bound to the op, the actId and the body's bytes): the proof is asked once, before the first
// send, and goes again with every resend; a new session makes it stale (0x05) and it is asked again. Giving power to an agent
// needs the elevation window: tried as it is, and on 0x05 the window is opened and the same act goes again. Cancelling the
// biometrics sends nothing. Nothing here is optimistic: the screen changes by `regency.changed` and by reading again.
//
// Also the readings of "Sistema" from afar: the processes (`procs.list`, read again after each act on one: there is no event
// of processes) and the ronda of each agent (`ronda.get`).
import { fromHex, opByName, randomBytes, type Bytes, type UvProof } from '../../../src/remote/index.ts'
import type { RemoteProc, RemoteRonda } from '../../../src/remote/projection.ts'
import type { OpName } from '../../../src/remote/scopes.ts'
import { ACT_DEADLINE_MS, actStepOf, capsOf, NO_CAPS, PROOF_TRIES, type Caps, type Reply } from './manage-rules.ts'
import type { PresenceOutcome } from './presence.ts'

/** What the manager needs of a session: requests with an actId and a proof, whether it ended, and its id (proofs bind it). */
export interface ManageSession {
  request(op: number, body?: Record<string, unknown> | Bytes, o?: { mutates?: boolean; actId?: Bytes; uvProof?: UvProof }): Promise<Reply>
  readonly ended: unknown
  readonly sessionId: Bytes
}

/** The biometrics, for one act or for the window (presence.ts in the page; a fake in a test). */
export interface Prover {
  act(s: ManageSession, op: number, actId: Bytes, body: Bytes): Promise<PresenceOutcome<{ uvProof: UvProof }>>
  window(s: ManageSession, deviceId: Bytes): Promise<PresenceOutcome>
}

export type ActOutcome = { ok: true; body: Record<string, unknown> } | { ok: false; code: string; body?: Record<string, unknown> }

export interface ActOptions {
  /** The proof the act travels with: this very act's, or the window's. */
  proof?: 'act' | 'window'
  /** Right before the system asks for the biometrics (the screen says what is going to be done first). */
  proving?(): void
}

export interface Manager {
  /** What this device may do (from `session.info`); no session yet, or no credential: nothing. */
  readonly caps: Caps
  attach(s: ManageSession): void
  detach(): void
  /** One act of the table, by its name. */
  act(name: OpName, body: Record<string, unknown>, o?: ActOptions): Promise<ActOutcome>
  /** A reading (not an act): no actId, no resend beyond the session's. */
  read(name: OpName, body: Record<string, unknown>): Promise<ActOutcome>
  /** The processes as last read (undefined: not read yet); `readProcs` reads them again. */
  procs(): readonly RemoteProc[] | undefined
  readProcs(): Promise<void>
  /** An agent's ronda as last read (null: off; undefined: not read). */
  ronda(slotId: string): RemoteRonda | null | undefined
  readRonda(slotIds: readonly string[]): Promise<void>
  /** Something the screen shows changed (the caps, the processes, a ronda). */
  onChange: () => void
  /** An act was answered "trancado". */
  onLocked: () => void
  dispose(): void
}

export interface ManagerDeps {
  /** The device holds a presence credential (without one it acts on nothing). */
  credential: boolean
  prover: Prover
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
}

const SESSION_INFO = opByName('session.info')!.code
const READ_PARALLEL = 3

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

export function createManager(d: ManagerDeps): Manager {
  const now = d.now ?? Date.now
  const later = d.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  let session: ManageSession | undefined
  let caps: Caps = NO_CAPS
  let deviceId: Bytes | undefined
  let disposed = false
  let procList: RemoteProc[] | undefined
  const rondas = new Map<string, RemoteRonda | null>()
  const waiters = new Set<() => void>()

  const live = (): ManageSession | undefined => (session && !session.ended ? session : undefined)
  const sleep = (ms: number): Promise<void> => new Promise(done => { later(done, ms) })

  /** The session now, or the next one within the deadline. */
  const sessionWithin = (deadline: number): Promise<ManageSession | undefined> => {
    const s = live()
    if (s) return Promise.resolve(s)
    const left = deadline - now()
    if (left <= 0 || disposed) return Promise.resolve(undefined)
    return new Promise(done => {
      const wake = (): void => { waiters.delete(wake); done(live()) }
      waiters.add(wake)
      later(wake, left)
    })
  }

  const m: Manager = {
    get caps() { return caps },
    onChange: () => {},
    onLocked: () => {},

    attach(s) {
      session = s
      for (const w of [...waiters]) w()
      void s.request(SESSION_INFO, {}).then(r => {
        if (session !== s || r.status !== 0) return
        const scopes = Array.isArray(r.body.scopes) ? r.body.scopes : []
        caps = capsOf(scopes, d.credential)
        const hex = typeof r.body.deviceId === 'string' && /^[0-9a-f]{32}$/.test(r.body.deviceId) ? r.body.deviceId : undefined
        deviceId = hex ? fromHex(hex) : undefined
        m.onChange()
      })
    },

    detach() { session = undefined },

    async act(name, body, o = {}) {
      const line = opByName(name)
      if (!line) return { ok: false, code: 'bad-request' }
      const op = line.code
      const actId = randomBytes(16)
      // The bytes the proof binds are the bytes that go: the same on every resend.
      const bytes = new TextEncoder().encode(JSON.stringify(body))
      const deadline = now() + ACT_DEADLINE_MS
      let proof: UvProof | undefined
      let proofs = 0
      const prove = async (s: ManageSession): Promise<string | undefined> => {
        if (proofs >= PROOF_TRIES) return 'house-refused'
        proofs++
        o.proving?.()
        if (o.proof === 'act') {
          const p = await d.prover.act(s, op, actId, bytes)
          if (!p.ok) return p.fail
          proof = p.uvProof
          return undefined
        }
        if (!deviceId) return 'no-credential'
        const w = await d.prover.window(s, deviceId)
        return w.ok ? undefined : w.fail
      }
      for (;;) {
        const s = await sessionWithin(deadline)
        if (!s) return { ok: false, code: 'timeout' }
        // A proof of the act is made before its first send (the portal refuses the act without it).
        if (o.proof === 'act' && !proof) {
          const fail = await prove(s)
          if (fail) return { ok: false, code: fail }
        }
        const r = await s.request(op, bytes, { actId, ...(proof ? { uvProof: proof } : {}) })
        const step = actStepOf(r, o.proof ?? 'none')
        switch (step.do) {
          case 'done': return { ok: true, body: step.body }
          case 'fail': return { ok: false, code: step.code, body: r.body }
          case 'locked': session = undefined; m.onLocked(); return { ok: false, code: 'locked' }
          case 'prove': {
            proof = undefined
            const fail = await prove(s)
            if (fail) return { ok: false, code: fail }
            break
          }
          case 'resend':
            if (now() >= deadline) return { ok: false, code: 'timeout' }
            await sleep(step.afterMs)
        }
      }
    },

    async read(name, body) {
      const line = opByName(name)
      const s = live()
      if (!line || !s) return { ok: false, code: 'cut' }
      const r = await s.request(line.code, body)
      const step = actStepOf(r, 'none')
      if (step.do === 'done') return { ok: true, body: step.body }
      if (step.do === 'locked') { session = undefined; m.onLocked(); return { ok: false, code: 'locked' } }
      return { ok: false, code: step.do === 'fail' ? step.code : 'cut' }
    },

    procs: () => procList,

    async readProcs() {
      if (!caps.procs) return
      const r = await m.read('procs.list', {})
      if (!r.ok) return
      procList = (Array.isArray(r.body.procs) ? r.body.procs : []).map(asObject) as unknown as RemoteProc[]
      m.onChange()
    },

    ronda: id => rondas.get(id),

    async readRonda(ids) {
      if (!caps.agents) return
      const queue = [...ids]
      let changed = false
      const worker = async (): Promise<void> => {
        for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
          const r = await m.read('ronda.get', { slotId: id })
          if (!r.ok) continue
          const v = r.body.ronda
          const next = v && typeof v === 'object' ? (v as RemoteRonda) : null
          if (JSON.stringify(rondas.get(id)) !== JSON.stringify(next)) { rondas.set(id, next); changed = true }
        }
      }
      await Promise.all(Array.from({ length: Math.min(READ_PARALLEL, queue.length) }, worker))
      if (changed) m.onChange()
    },

    dispose() {
      disposed = true
      session = undefined
      for (const w of [...waiters]) w()
      waiters.clear()
    },
  }
  return m
}
