// Subject: extension requests and events (`ui.daemon`, slice N1r). The hooks are in `window.__tether.ext['door-probe']`:
// `extAsk(name, args)` sends a request to the probe's daemon half and resolves with `{ ok, result }` or `{ ok: false, code }`;
// `extHeard()` lists the payloads of every `tick` event heard. The daemon half is the test's own: it registers `ping` and
// emits `tick` through `DoorHost.apiFor('door-probe', ...)`.
import type { TetherUi } from '../../../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../../../app/shared/vscode-lifecycle.ts'

export function extRequests(ui: TetherUi): IDisposable[] {
  const heard: unknown[] = []
  ui.test.expose('extAsk', async (name: string, args?: unknown) => {
    try { return { ok: true, result: await ui.daemon.request(name, args) } }
    catch (e) { return { ok: false, code: (e as { code?: string }).code, message: (e as Error).message } }
  })
  ui.test.expose('extHeard', () => heard)
  return [ui.daemon.onEvent('tick', payload => { heard.push(payload) })]
}
