// The app's half of the gestures asked from afar (RR5 5.1, fio-spec 17; tetherd's half is ActBridge in ../daemon.ts). tetherd
// emits `act { ask, act, until }`; this claims it (`act.take`: only an act tetherd still waits for may run, so an old one
// never fires), does it as the app's own gesture and answers `act.done`. The rules are the app's, through the same seams
// its menus use (TetherUi; the agents' ownership through for-agents' own commands, never a raw write), with three changes
// that make a gesture from afar: no dialog comes forward (what the app would ask was confirmed on the device, and the
// value a picker would give comes in the act), nothing is brought forward and the desk in view never changes (a gesture
// that would switch it answers `in-view`), and the person sees that it was done from afar (`notice`).
//
// Everything is checked again here against the app's own state, fresher than tetherd's map: the desk, the pane in that
// desk, the session that is closed, the agent that is alive. Refusals by the stable codes of src/remote/app-acts.ts.
import type { TetherUi } from '../../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import type { OwnerBoard } from '../../for-agents/renderer/owner-board.ts'
import type { Ownership } from '../../for-agents/rules.ts'
import {
  ACT_TAKE, APP_ACT_DONE, APP_ACT_EVENT, parseAppAct, seenMatches, type AppAct, type AppActCode, type AppActDoneArgs, type AppActEvent,
} from '../../../src/remote/app-acts.ts'
import { folderId } from '../../../src/remote/create.ts'

/** The seams of the app this half uses (a subset of TetherUi, so a test can hand a fake one). */
export interface RemoteActsUi {
  desks: Pick<TetherUi['desks'], 'list' | 'activeId' | 'tree' | 'hibernate' | 'wake' | 'create' | 'rename' | 'recolor' | 'close'>
  panes: Pick<TetherUi['panes'], 'find' | 'describe' | 'hibernate' | 'suspend' | 'moveToDesk' | 'closeGuide'>
  sessions: Pick<TetherUi['sessions'], 'closed' | 'reopen' | 'forget'>
  agents: Pick<TetherUi['agents'], 'get'>
  commands: Pick<TetherUi['commands'], 'run'>
  daemon: Pick<TetherUi['daemon'], 'request' | 'onEvent'>
}

export interface RemoteActsDeps {
  /** for-agents' board of owners (who owns each desk and pane); inactive with for-agents off. */
  owners: OwnerBoard
  /** "Feito de longe": the sentence the person sees on the machine. */
  notice: (text: string) => void
  now?: () => number
  /** How long a give or a take-back waits for the board to show it (the command writes to tetherd and returns). */
  ownerWaitMs?: number
  log?: (m: string) => void
  /**
   * "+ Novo" from afar (RR5 5.3): what only the app makes, by the seams of its own card (CreateSeams), never bringing
   * anything forward. `folders`: the app's known folders (its projects, then the recent ones), where a folder id of the
   * act is looked up (src/remote/create.ts folderId); one not there is `unknown-folder`.
   */
  create?: {
    note(spec: { deskId: string; cwd: string }): Promise<{ paneId: string } | { error: string } | undefined>
    tab(deskId: string): Promise<{ paneId: string } | { error: string }>
    folders(): Promise<readonly string[]>
    caseInsensitive: boolean
  }
}

type Done = { ok: true; state?: 'done' | 'already'; deskId?: string; paneId?: string; said?: string }
type Outcome = Done | { ok: false; code: AppActCode }
const done = (said: string, state: 'done' | 'already' = 'done'): Done => ({ ok: true, state, said })
const no = (code: AppActCode): Outcome => ({ ok: false, code })

const live = (o: Ownership | undefined): string | undefined => (o && !o.ended ? o.owner : undefined)

/** Does one act with the app's rules; never throws for a refusal (the code says why). */
export function remoteActRunner(ui: RemoteActsUi, deps: RemoteActsDeps): (a: AppAct) => Promise<Outcome> {
  const deskName = (id: string): string => ui.desks.list().find(d => d.id === id)?.name ?? id
  const queueDesk = (id: string): boolean => ui.desks.list().some(d => d.id === id)
  /** The pane is in that desk now (the app's own tree; a pane that moved since the device saw it is unknown). */
  const inDesk = (deskId: string, paneId: string): boolean =>
    ui.desks.tree().desks.some(d => d.id === deskId && d.kind === 'queue' && d.panes.some(p => p.id === paneId))
  const title = (paneId: string): string => ui.desks.tree().desks.flatMap(d => d.panes).find(p => p.id === paneId)?.title ?? paneId
  const agentName = (slotId: string): string => ui.agents.get(slotId)?.name ?? slotId
  const waitBoard = (ok: () => boolean): Promise<boolean> => new Promise(resolve => {
    if (ok()) { resolve(true); return }
    const sub = deps.owners.onDidChange(() => { if (ok()) { clearTimeout(timer); sub.dispose(); resolve(true) } })
    const timer = setTimeout(() => { sub.dispose(); resolve(ok()) }, deps.ownerWaitMs ?? 5_000)
  })

  return async (a: AppAct): Promise<Outcome> => {
    // What destroys or changes who holds a desk or a pane names the desk as the device saw it (RR5 M-1): a desk of that id
    // under another name now is not the one the person confirmed, and nothing is done.
    if ('seen' in a) {
      const desk = ui.desks.list().find(d => d.id === a.deskId)
      if (!desk) return no('unknown-desk')
      if (!seenMatches(a, desk.name)) return no('stale')
    }
    switch (a.act) {
      case 'desks.hibernate': {
        const r = await ui.desks.hibernate(a.deskId)
        if (r.state === 'no-desk') return no('unknown-desk')
        if (r.state === 'in-view' || r.state === 'last-desk') return no(r.state)
        return done(`mesa ${deskName(a.deskId)} hibernada`, r.state === 'already' ? 'already' : 'done')
      }
      case 'desks.wake': {
        const r = await ui.desks.wake(a.deskId)
        if (r.state === 'no-desk') return no('unknown-desk')
        return done(`mesa ${deskName(a.deskId)} despertada`, r.state === 'already' ? 'already' : 'done')
      }
      case 'desks.create': {
        // At the end of the queue, never switched to (the visible desk stays the person's).
        const last = ui.desks.list().at(-1)?.id
        const deskId = ui.desks.create({ name: a.name, ...(a.color ? { color: a.color } : {}), ...(last ? { after: last } : {}), stay: true })
        return { ...done(`mesa ${a.name} criada`), deskId }
      }
      case 'desks.rename': {
        if (!queueDesk(a.deskId)) return no('unknown-desk')
        if (deskName(a.deskId) === a.name) return done('', 'already')
        return ui.desks.rename(a.deskId, a.name) ? done(`mesa renomeada para ${a.name}`) : no('refused')
      }
      case 'desks.color':
        if (!queueDesk(a.deskId)) return no('unknown-desk')
        if (ui.desks.list().find(d => d.id === a.deskId)?.color === a.color) return done('', 'already')
        return ui.desks.recolor(a.deskId, a.color) ? done(`cor da mesa ${deskName(a.deskId)} trocada`) : no('refused')
      case 'desks.close': {
        const name = deskName(a.deskId)
        const r = await ui.desks.close(a.deskId, { panes: a.panes })
        if (r === 'no-desk') return no('unknown-desk')
        if (r === 'closed') return done(`mesa ${name} fechada`)
        return no(r === 'in-view' || r === 'last-desk' ? r : 'refused')
      }
      case 'panes.hibernate': {
        if (!inDesk(a.deskId, a.paneId)) return no('unknown-pane')
        const name = title(a.paneId)
        const r = await ui.panes.hibernate(a.paneId)
        if (r === 'no-pane') return no('unknown-pane')
        return done(`guia ${name} hibernada`, r === 'already' ? 'already' : 'done')
      }
      case 'panes.suspend': {
        if (!inDesk(a.deskId, a.paneId)) return no('unknown-pane')
        const name = title(a.paneId)
        const r = await ui.panes.suspend(a.paneId)
        if (r === 'no-pane') return no('unknown-pane')
        if (r === 'cannot') return no('cannot')
        return done(`guia ${name} suspensa`, r === 'already' ? 'already' : 'done')
      }
      case 'panes.wake':
        // tetherd wakes a pane alone (the slot's start); an act that reaches the app is not one it does.
        return no('refused')
      case 'panes.move': {
        if (!inDesk(a.deskId, a.paneId)) return no('unknown-pane')
        if (!queueDesk(a.to)) return no('unknown-desk')
        if (a.to === a.deskId) return no('same-desk')
        const name = title(a.paneId)
        return ui.panes.moveToDesk(a.paneId, a.to) ? done(`guia ${name} movida para a mesa ${deskName(a.to)}`) : no('refused')
      }
      case 'panes.close': {
        if (!inDesk(a.deskId, a.paneId)) return no('unknown-pane')
        const name = title(a.paneId)
        await ui.panes.closeGuide(a.paneId, { process: a.process })
        return ui.panes.find(a.paneId) ? no('refused') : done(`guia ${name} fechada`)
      }
      case 'closed.reopen': {
        const s = ui.sessions.closed().find(c => c.slotId === a.slotId)
        if (!s) return no('not-closed')
        if (!queueDesk(a.deskId)) return no('unknown-desk')
        return ui.sessions.reopen(a.slotId, a.deskId) ? done(`sessão ${s.name} reaberta na mesa ${deskName(a.deskId)}`) : no('refused')
      }
      case 'closed.forget': {
        const s = ui.sessions.closed().find(c => c.slotId === a.slotId)
        if (!s) return no('not-closed')
        return (await ui.sessions.forget(a.slotId)) === undefined ? done(`sessão ${s.name} esquecida`) : no('refused')
      }
      case 'owners.give': case 'owners.revoke': case 'owners.take': case 'owners.return': {
        if (!deps.owners.active) return no('owners-off')
        if (!queueDesk(a.deskId)) return no('unknown-desk')
        if (a.paneId !== undefined) {
          if (!inDesk(a.deskId, a.paneId)) return no('unknown-pane')
          // Ownership is about a slot's pane (a terminal's), as the tab's menu offers it.
          if (ui.panes.describe(a.paneId)?.type !== 'terminal') return no('cannot')
        }
        const kind = a.paneId !== undefined ? 'pane' as const : 'desk' as const
        const id = a.paneId ?? a.deskId
        const what = kind === 'desk' ? `a mesa ${deskName(id)}` : `a guia ${title(id)}`
        const ownerNow = (): string | undefined => live(kind === 'desk' ? deps.owners.deskOwner(id) : deps.owners.paneOwner(id))
        const run = async (command: string, extra: Record<string, unknown> = {}): Promise<boolean> =>
          (await ui.commands.run(command, { kind, id, ...extra })) === 'ran'
        if (a.act === 'owners.give') {
          // Only a live agent, as the picker offers them.
          if (!ui.agents.get(a.to)?.alive) return no('unknown-agent')
          if (ownerNow() === a.to) return done('', 'already')
          if (!await run('for-agents.give', { to: a.to })) return no('owners-off')
          return (await waitBoard(() => ownerNow() === a.to)) ? done(`${what} dada a ${agentName(a.to)}`) : no('refused')
        }
        // Taking away, taking the command and giving it back: the target has a commander, its own or its desk's.
        const deskOwner = live(deps.owners.deskOwner(a.deskId))
        const commander = ownerNow() ?? (kind === 'pane' ? deskOwner : undefined)
        if (a.act === 'owners.revoke') {
          const owner = ownerNow()
          if (owner === undefined) return no('not-given')
          if (!await run('for-agents.revoke')) return no('owners-off')
          return (await waitBoard(() => ownerNow() === undefined)) ? done(`${what} tirada de ${agentName(owner)}`) : no('refused')
        }
        if (commander === undefined) return no('not-given')
        if (a.act === 'owners.take') return (await run('for-agents.take')) ? done(`comando de ${what} assumido`) : no('owners-off')
        return (await run('for-agents.return')) ? done(`comando de ${what} devolvido a ${agentName(commander)}`) : no('owners-off')
      }
      // "+ Novo" from afar (RR5 5.3): born in that desk, behind (never brought forward), as the card's seams make them.
      case 'create.note':
      case 'create.browser': {
        const make = deps.create
        if (!make) return no('cannot')
        if (!queueDesk(a.deskId)) return no('unknown-desk')
        if (ui.desks.list().find(d => d.id === a.deskId)?.asleep) return no('cannot')
        if (a.act === 'create.browser') {
          const r = await make.tab(a.deskId)
          return 'paneId' in r ? { ...done(`aba aberta na mesa ${deskName(a.deskId)}`), paneId: r.paneId } : no('refused')
        }
        const cwd = (await make.folders()).find(p => folderId(p, make.caseInsensitive) === a.folder)
        if (cwd === undefined) return no('unknown-folder')
        const r = await make.note({ deskId: a.deskId, cwd })
        return r && 'paneId' in r ? { ...done(`nota criada na mesa ${deskName(a.deskId)}`), paneId: r.paneId } : no('refused')
      }
    }
  }
}

/** Hears tetherd's acts: claims each one while it may still be claimed, does it, answers, and tells the person. */
export function remoteActs(ui: RemoteActsUi, deps: RemoteActsDeps): IDisposable {
  const run = remoteActRunner(ui, deps)
  const now = deps.now ?? Date.now
  const log = deps.log ?? (m => console.warn(m))
  return ui.daemon.onEvent<AppActEvent>(APP_ACT_EVENT, (ev) => {
    const act = parseAppAct(ev?.act)
    if (!act || typeof ev.ask !== 'string' || typeof ev.until !== 'number' || ev.until < now()) return
    const ask = ev.ask
    void (async () => {
      // Only a claim tetherd accepts lets the act run: one it gave up on is refused here and nothing is done.
      try { await ui.daemon.request(ACT_TAKE, { ask }) } catch { return }
      let out: Outcome
      try { out = await run(act) } catch (e) {
        log(`regência: ato de longe ${act.act} falhou: ${(e as Error).message}`)
        out = no('refused')
      }
      const answer: AppActDoneArgs = out.ok
        ? { ask, ok: true, ...(out.state ? { state: out.state } : {}), ...(out.deskId ? { deskId: out.deskId } : {}), ...(out.paneId ? { paneId: out.paneId } : {}) }
        : { ask, ok: false, code: out.code }
      if (out.ok && out.state === 'done' && out.said) deps.notice(`Feito de longe: ${out.said}.`)
      await ui.daemon.request(APP_ACT_DONE, answer).catch((e: unknown) => log(`regência: responder o ato de longe falhou: ${(e as Error).message}`))
    })()
  })
}
