// The channels extension in tetherd: delivery on (the `tether` server is offered to every agent), the record opened once
// tetherd owns its pipe, and the fan-out (daemon/fanout.ts) that every gesture goes through. The verbs (H3) and the
// moderator's requests (H4) register here over `channels.ready`.
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { TetherDaemon } from '../../src/daemon/ext-api.ts'
import { wireChannels } from './daemon/fanout.ts'
import { openStore } from './daemon/store.ts'

export { manifest } from './manifest.ts'

export function activate(api: TetherDaemon): IDisposable[] {
  const channels = wireChannels(api, (a) => openStore(a.io, a.home, { log: (m) => a.log(m) }))
  return [api.delivery.enable(), ...channels.disposables]
}
