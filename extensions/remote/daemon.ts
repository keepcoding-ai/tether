// The remote extension's daemon entry: the person-facing requests (`ext-request`, ext `remote`) and the portal brought
// back on when tetherd starts. No verb of the agent door touches this extension (A-2): it registers none. The logic is
// daemon/service.ts; the rules of who may ask what are rules.ts.
import { toDisposable, type IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { agentExecutor } from '../../src/agents/agent-exec.ts'
import type { TetherDaemon } from '../../src/daemon/ext-api.ts'
import { ORIGIN, type RemoteRequest } from './rules.ts'
import { RemoteService, type RemoteDeps } from './daemon/service.ts'

export { manifest } from './manifest.ts'

export function activateWith(api: TetherDaemon, extra: Partial<RemoteDeps> = {}): { service: RemoteService; disposables: IDisposable[] } {
  const service = new RemoteService({ home: api.home, io: api.io, log: (m) => api.log(m), env: process.env, executor: agentExecutor(), ...extra })
  const disposables: IDisposable[] = (Object.keys(ORIGIN) as RemoteRequest[]).map((name) =>
    api.requests.handle(name, (args, ctx) => service.handle(name, args, ctx)))
  disposables.push(api.onStarted(() => { void service.started() }))
  disposables.push(toDisposable(() => { void service.dispose() }))
  return { service, disposables }
}

export function activate(api: TetherDaemon): IDisposable[] {
  return activateWith(api).disposables
}
