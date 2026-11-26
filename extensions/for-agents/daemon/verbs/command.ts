// `agents command`: a command of the agent's CLI (/compact, /clear...) on a pane. On a pane of the caller's, the command runs at
// once through the conductor. On the caller's OWN pane ("de si") it cannot: the agent is in the middle of a turn when it calls
// and a command typed then would hit its own turn. It is deferred to the end of that turn, and until the person is free
// there too (`{ deferred: true }`); the pending ones show in `list`. A command is always typed raw (decision F1).
import { toDisposable, type IDisposable } from '../../../../app/shared/vscode-lifecycle.ts'
import { slotIsLive } from '../../../../app/shared/agent-info.ts'
import type { ScreenRead } from '../../../../src/daemon/protocol.ts'
import { createScreenReaders, historyString, screenString } from '../../screen/index.ts'
import { conductorFor } from './common.ts'
import { buildContext, type ContextDeps } from '../context.ts'
import { SYSTEM_FROM } from '../notices.ts'
import { ReturnWatch, realClock, returnBody, trimToEcho, type ReturnClock, type ReturnResult } from './command-return.ts'
import { awakeTarget, ok, commanded, optString, refuse, touch, wantString, GUIA_PROP, targetOf, type VerbDef, type VerbDeps } from './common.ts'

const GIVE_UP_MS = 5 * 60_000
const POLL_MS = 500

interface Waiting {
  owner: string
  name: string
  args: string | undefined
  since: number
  ret: boolean
  /** What held it at the last look, in words (said to the owner if it is given up). */
  heldBy?: string
}

/** A raw read as text, through a throwaway terminal (the incremental reader of the context ignores `since`). */
async function renderRaw(raw: ScreenRead): Promise<string> {
  const readers = createScreenReaders({ joinWrapped: false })
  try {
    const t = await readers.read('return', async () => raw)
    return [historyString(t), screenString(t)].filter((s) => s !== '').join('\n')
  } finally { readers.dispose() }
}

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
  /** The return watches alive: they run outside the flush loop and end with the extension. */
  private readonly watches = new Set<ReturnWatch>()
  private readonly clock: ReturnClock

  constructor(clock: ReturnClock = realClock) { this.clock = clock }

  bind(deps: VerbDeps): void { this.deps = deps }

  count(paneId: string): number { return this.byPane.get(paneId)?.length ?? 0 }

  /** What waits on the pane and what held it at the last look (for `list`). */
  held(paneId: string): { name: string; since: string; heldBy?: string }[] {
    return (this.byPane.get(paneId) ?? []).map((w) => ({ name: w.name, since: new Date(w.since).toISOString(), ...(w.heldBy ? { heldBy: w.heldBy } : {}) }))
  }

  add(paneId: string, owner: string, name: string, args: string | undefined, ret = false): void {
    const list = this.byPane.get(paneId) ?? []
    // The same request again is the same wait: keep the one in the queue and renew its clock.
    const same = list.find((w) => w.owner === owner && w.name === name && w.args === args && w.ret === ret)
    if (same) { same.since = this.clock.now(); return }
    list.push({ owner, name, args, since: this.clock.now(), ret })
    this.byPane.set(paneId, list)
    this.timer ??= setInterval(() => { void this.flush() }, POLL_MS)
    this.timer.unref?.()
  }

  /**
   * Tries each waiting pane: a command goes when the turn is over, the gate lets the owner write and the delivery leaves the
   * box alone (no notice queued, being typed or settling, no unsent text of the tether's in it): two typists never share a box.
   */
  async flush(): Promise<void> {
    const deps = this.deps
    if (!deps || this.running) return
    this.running = true
    try {
      for (const [paneId, list] of [...this.byPane]) {
        const slot = deps.api.slots.get(paneId)
        const next = list[0]
        if (!next) { this.byPane.delete(paneId); continue }
        if (!slot || this.clock.now() - next.since > GIVE_UP_MS) {
          list.shift()
          deps.api.log(`comando ${next.name} de ${paneId} descartado`)
          // The owner is always told, with or without `return`: a command never goes away in silence.
          const why = !slot ? 'a guia sumiu' : next.heldBy
          await this.deliver(deps, next.owner, `comando /${next.name}: não rodou; a guia não ficou livre em 5 min${why ? ` (${why})` : ''}`)
          continue
        }
        next.heldBy = slot.turn === 'busy' ? 'turno busy'
          : deps.gate.check(paneId, next.owner) !== undefined ? 'pessoa na guia'
            : !deps.api.delivery.quiet(paneId) ? 'avisos do tether na caixa' : undefined
        if (next.heldBy !== undefined) continue
        list.shift()
        if (next.ret) { await this.fireWithReturn(deps, paneId, next); continue }
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

  /** Reads the mark, types the command and starts the watch that hands the screen back to the owner. */
  private async fireWithReturn(deps: VerbDeps, paneId: string, next: Waiting): Promise<void> {
    const label = `/${next.name}`
    const mark = deps.api.slots.readScreen(paneId).end
    const typedAt = this.clock.now()
    try {
      const r = await runCommand(deps, next.owner, paneId, next.name, next.args)
      touch(deps, paneId, next.owner, 'command')
      if (!r.proven) deps.api.log(`comando ${next.name} de ${paneId} rodou, não provado pela sonda`)
    } catch (e) {
      deps.api.log(`comando ${next.name} de ${paneId} falhou: ${(e as Error).message}`)
      await this.deliver(deps, next.owner, `comando ${label} falhou: ${(e as Error).message}`)
      return
    }
    const target = (): ReturnType<typeof targetOf> => targetOf(deps, paneId)
    const ctx = (): ReturnType<typeof buildContext> => buildContext(deps as ContextDeps, next.owner, target())
    const watch = new ReturnWatch({
      // The protocol marks only a busy pane (`turn: 'busy'`); an idle pane has no `turn`. Only a missing slot is undefined.
      turn: () => { const s = deps.api.slots.get(paneId); return s === undefined ? undefined : (s.turn ?? 'idle') },
      idleSince: () => deps.api.slots.get(paneId)?.idleSince,
      paintedAt: () => deps.api.slots.paintedAt(paneId),
      userTypedAt: () => deps.api.slots.userTypedAt(paneId),
      detect: () => conductorFor(target(), 'detect').detect!(ctx()),
      readSince: async (m) => { const raw = deps.api.slots.readScreen(paneId, { since: m }); return { text: trimToEcho(await renderRaw(raw), next.name), reset: raw.reset } },
      readAll: async () => trimToEcho(await renderRaw(deps.api.slots.readScreen(paneId)), next.name),
    }, { typedAt, mark, self: paneId === next.owner }, this.clock)
    this.watches.add(watch)
    void watch.run().then(async (result: ReturnResult | undefined) => {
      this.watches.delete(watch)
      if (!result) return
      if (result.outcome === 'gone') deps.api.log(`retorno de ${next.name} em ${paneId}: a guia sumiu, nada a entregar`)
      const body = returnBody(label, result)
      if (body !== undefined) await this.deliver(deps, next.owner, body)
    }).catch((e: unknown) => { this.watches.delete(watch); deps.api.log(`retorno de ${next.name} em ${paneId} falhou: ${(e as Error).message}`) })
  }

  /** A system message that opens a turn in the owner (the way the pause notice goes); nothing for an owner that is away. */
  private async deliver(deps: VerbDeps, owner: string, body: string): Promise<void> {
    const o = deps.api.slots.get(owner)
    if (!o || !slotIsLive(o)) return
    try { await deps.api.delivery.deliver(owner, { kind: 'notice', from: SYSTEM_FROM, body }) } catch (e) { deps.api.log(`retorno a ${owner} falhou: ${(e as Error).message}`) }
  }

  dispose(): IDisposable {
    return toDisposable(() => {
      if (this.timer) clearInterval(this.timer)
      this.timer = undefined
      this.byPane.clear()
      for (const w of [...this.watches]) w.dispose()
      this.watches.clear()
    })
  }
}

export const commandVerb: VerbDef = {
  name: 'command',
  description: "Run a command of the agent's CLI (for example `compact`, `clear`) on one of your panes. Without `guia`, or with your own pane, it needs your own pane to be given to you (\"de si\") and runs when your current turn ends and the person is not typing: it answers `deferred` now. Refuses with `busy` when the engine cannot take it mid-turn.",
  help: 'Roda um comando do CLI do agente (/compact, /clear) numa guia.',
  input: { type: 'object', properties: { guia: { ...GUIA_PROP, description: 'Absent: your own pane.' }, name: { type: 'string', description: "The command without the slash: 'compact', 'clear'." }, args: { type: 'string' }, return: { type: 'boolean', description: 'true: the command waits for the pane to be free, and when it stops the screen it left comes back to you as a system message.' } }, required: ['name'] },
  positional: ['guia', 'name'],
  async run(deps, caller, args) {
    const name = wantString(args, 'name').replace(/^\//, '')
    const extra = optString(args, 'args')
    const wantsReturn = args.return === true
    const guia = optString(args, 'guia') ?? caller.slotId
    const { paneId, eff, target } = commanded(deps, caller, guia, 'command')
    conductorFor(target, 'command')
    if (paneId === caller.slotId) {
      if (eff.via !== 'self') refuse('not-commanded', 'a sua própria guia não foi dada a você ("de si")')
      deps.pending.add(paneId, caller.slotId, name, extra, wantsReturn)
      touch(deps, paneId, caller.slotId, 'command')
      if (wantsReturn) return ok(`Comando ${name} adiado para o fim do seu turno; o resultado volta como aviso.`, { deferred: true, return: true })
      return ok(`Comando ${name} adiado para o fim do seu turno.`, { deferred: true })
    }
    await awakeTarget(deps, paneId, 'command')
    if (wantsReturn) {
      deps.pending.add(paneId, caller.slotId, name, extra, true)
      return ok(`Comando ${name} na fila da guia; vai quando o turno dela acabar e a pessoa estiver quieta, e o resultado volta como aviso.`, { deferred: true, return: true })
    }
    const r = await runCommand(deps, caller.slotId, paneId, name, extra)
    touch(deps, paneId, caller.slotId, 'command')
    return ok(`Comando ${name} enviado.`, { sent: true, proven: r.proven }, r.proven)
  },
}
