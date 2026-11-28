// The app's half of `agents hibernate`, `agents suspend` and `agents wake` (daemon/verbs/hibernate.ts, wake.ts): the sleep of panes and desks
// lives in the app, so the daemon asks here with an event (`hibernate { ask, pane }`, `hibernate-desk { ask, desk, spare }`,
// `wake-desk { ask, desk, spare }`); this does it as "Hibernar guia" / "Hibernar mesa" / waking a desk do, with no dialog and
// nothing brought forward, and answers with the request `hibernated { ask, state, panes? }`. The daemon already checked the
// ownership and chose what to spare.
import type { TetherUi } from '../../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import { HIBERNATE_DESK_EVENT, HIBERNATE_EVENT, HIBERNATED_REQUEST, SUSPEND_EVENT, WAKE_DESK_EVENT, type DeskSleepEvent, type HibernatedArgs, type HibernateEvent, type SuspendEvent } from '../sleep-names.ts'

export function sleepBridge(ui: TetherUi): IDisposable[] {
  const answer = (ask: string, what: string, work: () => Promise<{ state: string; panes?: string[] }>): void => {
    void work()
      .then((r) => ui.daemon.request(HIBERNATED_REQUEST, { ask, state: r.state, ...(r.panes ? { panes: r.panes } : {}) } satisfies HibernatedArgs))
      .catch((e: unknown) => console.warn(`${what} a pedido do dono falhou: ${(e as Error).message}`))
  }
  const deskEvent = (ev: DeskSleepEvent | undefined): ev is DeskSleepEvent =>
    typeof ev?.ask === 'string' && typeof ev.desk === 'string' && Array.isArray(ev.spare) && ev.spare.every((p) => typeof p === 'string')
  return [
    ui.daemon.onEvent<HibernateEvent>(HIBERNATE_EVENT, (ev) => {
      if (typeof ev?.ask !== 'string' || typeof ev.pane !== 'string') return
      answer(ev.ask, `hibernar ${ev.pane}`, async () => ({ state: await ui.panes.hibernate(ev.pane) }))
    }),
    ui.daemon.onEvent<SuspendEvent>(SUSPEND_EVENT, (ev) => {
      if (typeof ev?.ask !== 'string' || typeof ev.pane !== 'string') return
      answer(ev.ask, `suspender ${ev.pane}`, async () => ({ state: await ui.panes.suspend(ev.pane) }))
    }),
    ui.daemon.onEvent<DeskSleepEvent>(HIBERNATE_DESK_EVENT, (ev) => {
      if (!deskEvent(ev)) return
      answer(ev.ask, `hibernar a mesa ${ev.desk}`, () => ui.desks.hibernate(ev.desk, { spare: ev.spare }))
    }),
    ui.daemon.onEvent<DeskSleepEvent>(WAKE_DESK_EVENT, (ev) => {
      if (!deskEvent(ev)) return
      answer(ev.ask, `acordar a mesa ${ev.desk}`, () => ui.desks.wake(ev.desk, { spare: ev.spare }))
    }),
  ]
}
