// The context a verb hands a conductor (conductor-api.ts `ConductorContext`), built anew for each call and for one owner: the
// target is read fresh, `slot()` rereads it after a wait, every write goes through the gate (guard.ts) as that owner and a
// refusal reaches the conductor as a `ConductError` (`with-user`, `not-commanded`), the screen is read as the person sees it.
import { ConductError, type ConductorContext, type ConductorTarget } from '../conductor-api.ts'
import type { OwnerId } from '../rules.ts'
import type { ScreenReaders } from '../screen/index.ts'
import type { WriteChunk, WriteGate } from './guard.ts'
import type { VerbApi } from './verbs/common.ts'

export interface ContextDeps {
  api: Pick<VerbApi, 'slots' | 'agents' | 'io' | 'home' | 'log'>
  gate: WriteGate
  readers: ScreenReaders
}

/** The conductor's `{ data, waitMs }` list as the gate's chunks: a `waitMs` waits BEFORE its data. */
export function chunksOf(list: readonly { data: string; waitMs?: number }[]): WriteChunk[] {
  const out: WriteChunk[] = []
  for (const c of list) {
    if (c.waitMs && c.waitMs > 0) out.push({ waitMs: c.waitMs })
    out.push({ text: c.data })
  }
  return out
}

export function buildContext(deps: ContextDeps, owner: OwnerId, target: ConductorTarget): ConductorContext {
  const { api, gate, readers } = deps
  const paneId = target.paneId
  const through = async (chunks: readonly WriteChunk[]): Promise<void> => {
    const r = await gate.write(paneId, owner, chunks)
    if (!r.ok) throw new ConductError(r.why, r.why === 'with-user' ? 'a guia está com a pessoa agora; nada foi digitado' : 'esta guia não é sua para comandar')
  }
  const kind = target.slot?.kind
  return {
    target,
    slot: () => api.slots.get(paneId),
    agent: kind && kind !== 'shell' ? api.agents.get(kind) : undefined,
    // The reader keeps its own `since` per slot (screen/readers.ts), so the caller's `opts.since` has nothing to add.
    screen: () => readers.read(paneId, (since) => api.slots.readScreen(paneId, since === undefined ? undefined : { since })),
    write: (list) => through(chunksOf(list)),
    keys: (keys, opts) => through([{ keys, ...(opts?.gapMs !== undefined ? { gapMs: opts.gapMs } : {}) }]),
    io: api.io,
    home: api.home,
    log: (m) => api.log(`condutor ${paneId}: ${m}`),
  }
}
