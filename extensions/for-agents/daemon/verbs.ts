// The verbs of the `agents` namespace (tether for agents, contract 3): what an owner does with its desks and panes. Each verb
// is a file of verbs/; this registers them with the door (`verbs.register`, both exits: MCP tool `mcp__tether__agents_<name>`
// and CLI `tether agents <name>`), wraps each in the shared handling and adds the paragraph of the server's instructions.
//
// The shared handling: an error thrown below a verb (a `ConductError`, an ownership refusal, a door error: anything with a
// `code`) is the verb's error result, the same on both exits; a call whose caller did not prove its identity
// (`caller.proven === false`, B4) runs the same and leaves marked `proven: false` in its data and text; nothing is refused
// for want of proof.
//
// Wiring in daemon.ts, one line after `wire` builds the pieces:   `disposables.push(...registerVerbs(api, { store, gate }))`
import { toDisposable, type IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import type { TetherDaemon, VerbCaller, VerbResult } from '../../../src/daemon/ext-api.ts'
import { VERB_NS } from '../manifest.ts'
import { createScreenReaders } from '../screen/index.ts'
import type { WriteGate } from './guard.ts'
import type { OwnershipStore } from './ownership.ts'
import { answerVerb } from './verbs/answer.ts'
import { closeVerb } from './verbs/close.ts'
import { commandVerb, PendingCommands } from './verbs/command.ts'
import { failOf, type VerbApi, type VerbDef, type VerbDeps } from './verbs/common.ts'
import { giveVerb } from './verbs/give.ts'
import { interruptVerb } from './verbs/interrupt.ts'
import { keysVerb } from './verbs/keys.ts'
import { lastAnswerVerb } from './verbs/last-answer.ts'
import { listVerb } from './verbs/list.ts'
import { openVerb } from './verbs/open.ts'
import { readScreenVerb } from './verbs/read-screen.ts'
import { restartVerb } from './verbs/restart.ts'
import { revokeVerb } from './verbs/revoke.ts'
import { sendVerb } from './verbs/send.ts'
import { typeVerb } from './verbs/type.ts'

/** What the verbs need of the extension's wiring (the `store` and `gate` of `wire`). */
export interface VerbsWiring { store: OwnershipStore; gate: WriteGate }

/** The contract's table 3.1, in order. */
export const AGENT_VERBS: readonly VerbDef[] = [
  listVerb, openVerb, sendVerb, interruptVerb, readScreenVerb, lastAnswerVerb, answerVerb, commandVerb,
  typeVerb, keysVerb, closeVerb, restartVerb, giveVerb, revokeVerb,
]

export const INSTRUCTIONS = [
  'You can own desks and panes of the tether: the person gives them to you, and over what is in them you have the power she has.',
  '`agents list` shows what is yours and what you may do with each pane; run it to find your way again after compacting.',
  'What happens in your panes reaches you as <channel source="tether" origin="for-agents" ...>. The person sees everything and may take any pane back at any time; an act on a pane she holds answers `with-user`.',
].join('\n')

const NOT_PROVEN_CALLER = 'chamador sem prova de identidade'

/** A call that came without the proof of identity runs and leaves marked, in the data, the text and the log. */
function mark(r: VerbResult, caller: VerbCaller, name: string, log: (m: string) => void): VerbResult {
  if (caller.proven) return r
  log(`agents ${name} chamado por ${caller.slotId} sem prova de identidade (${caller.via})`)
  const data = typeof r.data === 'object' && r.data !== null && !Array.isArray(r.data) ? r.data : {}
  return { ...r, text: `${r.text} (${NOT_PROVEN_CALLER})`, data: { ...data, proven: false } }
}

export function registerVerbs(api: VerbApi & Pick<TetherDaemon, 'verbs' | 'onSlot'>, wiring: VerbsWiring): IDisposable[] {
  const readers = createScreenReaders({ joinWrapped: false })
  const pending = new PendingCommands()
  const deps: VerbDeps = { api, store: wiring.store, gate: wiring.gate, readers, pending }
  pending.bind(deps)
  const out: IDisposable[] = [
    api.onSlot((ev) => { if (ev.kind === 'removed') readers.drop(ev.slot.slotId) }),
    api.slots.onState((s) => { if (s.turn !== 'busy' && pending.count(s.slotId) > 0) void pending.flush() }),
    pending.dispose(),
    toDisposable(() => readers.dispose()),
  ]
  for (const def of AGENT_VERBS) {
    out.push(api.verbs.register({
      ns: VERB_NS, name: def.name, description: def.description, help: def.help, input: def.input,
      ...(def.positional ? { positional: def.positional } : {}),
      run: async (caller, args) => {
        let r: VerbResult
        try { r = await def.run(deps, caller, args) } catch (e) { r = failOf(e); if (r.data && (r.data as { error?: string }).error === 'internal') api.log(`agents ${def.name}: ${(e as Error).stack ?? (e as Error).message}`) }
        return mark(r, caller, def.name, (m) => api.log(m))
      },
    }))
  }
  out.push(api.verbs.instructions(INSTRUCTIONS))
  return out
}
