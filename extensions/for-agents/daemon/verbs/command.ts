// `agents command`: a command of the agent's CLI (/compact, /clear...) on a pane. On a pane of the caller's, the command runs at
// once through the conductor. On the caller's OWN pane ("de si") it cannot: the agent is in the middle of a turn when it calls
// and a command typed then would hit its own turn. It is deferred to the end of that turn, and until the person is free
// there too (`{ deferred: true }`); the pending ones show in `list`. A command is always typed raw (decision F1).
import { toDisposable, type IDisposable } from '../../../../app/shared/vscode-lifecycle.ts'
import { conductorFor } from './common.ts'
import { buildContext, type ContextDeps } from '../context.ts'
import { awakeTarget, ok, commanded, optString, refuse, touch, wantString, GUIA_PROP, targetOf, type VerbDef, type VerbDeps } from './common.ts'

const GIVE_UP_MS = 5 * 60_000
const POLL_MS = 500

interface Waiting { owner: string; name: string; args: string | undefined; since: number }

/** Runs the command through the conductor for `owner`. */
export async function runCommand(deps: VerbDeps, owner: string, paneId: string, name: string, args: string | undefined): Promise<{ proven: boolean }> {
  const target = targetOf(deps, paneId)
  const c = conductorFor(target, 'command')
  const r = await c.command!(buildContext(deps as ContextDeps, owner, target), name, args)
  return { proven: r.proven }
}

/**
 * The commands waiting for the end of a turn, by pane. No timer while nothing waits; while something does, one poll of the
 * waiting panes every POLL_MS (the person's quiet time has no event to wait for), and a command is dropped after GIVE_UP_MS.
 */
export class PendingCommands {
  private readonly byPane = new Map<string, Waiting[]>()
  private timer: ReturnType<typeof setInterval> | undefined
  private deps: VerbDeps | undefined
  private running = false

  bind(deps: VerbDeps): void { this.deps = deps }

  count(paneId: string): number { return this.byPane.get(paneId)?.length ?? 0 }

  add(paneId: string, owner: string, name: string, args: string | undefined): void {
    const list = this.byPane.get(paneId) ?? []
    list.push({ owner, name, args, since: Date.now() })
    this.byPane.set(paneId, list)
    this.timer ??= setInterval(() => { void this.flush() }, POLL_MS)
    this.timer.unref?.()
  }

  /** Tries each waiting pane: a command goes when the turn is over and the gate lets the owner write. */
  async flush(): Promise<void> {
    const deps = this.deps
    if (!deps || this.running) return
    this.running = true
    try {
      for (const [paneId, list] of [...this.byPane]) {
        const slot = deps.api.slots.get(paneId)
        const next = list[0]
        if (!next) { this.byPane.delete(paneId); continue }
        if (!slot || Date.now() - next.since > GIVE_UP_MS) { list.shift(); deps.api.log(`comando ${next.name} de ${paneId} descartado`); continue }
        if (slot.turn === 'busy' || deps.gate.check(paneId, next.owner) !== undefined) continue
        list.shift()
        try {
          const r = await runCommand(deps, next.owner, paneId, next.name, next.args)
          touch(deps, paneId, next.owner, 'command')
          if (!r.proven) deps.api.log(`comando ${next.name} de ${paneId} rodou, não provado pela sonda`)
        } catch (e) { deps.api.log(`comando ${next.name} de ${paneId} falhou: ${(e as Error).message}`) }
      }
      for (const [paneId, list] of [...this.byPane]) if (list.length === 0) this.byPane.delete(paneId)
    } finally {
      this.running = false
      if (this.byPane.size === 0 && this.timer) { clearInterval(this.timer); this.timer = undefined }
    }
  }

  dispose(): IDisposable {
    return toDisposable(() => { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.byPane.clear() })
  }
}

export const commandVerb: VerbDef = {
  name: 'command',
  description: "Run a command of the agent's CLI (for example `compact`, `clear`) on one of your panes. Without `guia`, or with your own pane, it needs your own pane to be given to you (\"de si\") and runs when your current turn ends and the person is not typing: it answers `deferred` now. Refuses with `busy` when the engine cannot take it mid-turn.",
  help: 'Roda um comando do CLI do agente (/compact, /clear) numa guia.',
  input: { type: 'object', properties: { guia: { ...GUIA_PROP, description: 'Absent: your own pane.' }, name: { type: 'string', description: "The command without the slash: 'compact', 'clear'." }, args: { type: 'string' } }, required: ['name'] },
  positional: ['guia', 'name'],
  async run(deps, caller, args) {
    const name = wantString(args, 'name').replace(/^\//, '')
    const extra = optString(args, 'args')
    const guia = optString(args, 'guia') ?? caller.slotId
    const { paneId, eff, target } = commanded(deps, caller, guia, 'command')
    conductorFor(target, 'command')
    if (paneId === caller.slotId) {
      if (eff.via !== 'self') refuse('not-commanded', 'a sua própria guia não foi dada a você ("de si")')
      deps.pending.add(paneId, caller.slotId, name, extra)
      touch(deps, paneId, caller.slotId, 'command')
      return ok(`Comando ${name} adiado para o fim do seu turno.`, { deferred: true, proven: true })
    }
    await awakeTarget(deps, paneId, 'command')
    const r = await runCommand(deps, caller.slotId, paneId, name, extra)
    touch(deps, paneId, caller.slotId, 'command')
    return ok(`Comando ${name} enviado.`, { sent: true, proven: r.proven }, r.proven)
  },
}
