// tetherd for the door E2E: the real daemon (src/daemon/main.ts) with the `doortest` extension added to the static index before it
// activates. Nothing in the product is edited: the index is a plain array, and this process is the only one that sees the push.
// DOORTEST_NO_RONDA_FLAG (a file path): while that file exists, the ronda's channel is not offered to a launch (the way a daemon
// whose ronda server failed to listen behaves), so the door's channel goes alone.
import { existsSync } from 'node:fs'
import { extensions } from '../../../extensions/index.daemon.ts'
import type { ExtensionEntry } from '../../../extensions/types.ts'
import type { TetherDaemon } from '../../../src/daemon/ext-api.ts'
import { RondaChannel } from '../../../src/daemon/ronda-channel.ts'
import * as doortest from './extension.ts'

;(extensions as ExtensionEntry<TetherDaemon>[]).push({ manifest: doortest.manifest, activate: doortest.activate })

const flag = process.env.DOORTEST_NO_RONDA_FLAG
if (flag) {
  const proto = RondaChannel.prototype as unknown as { prepare(plan: unknown, slotId: string, agent: unknown): Promise<unknown>; revoke(slotId: string): void }
  const real = proto.prepare
  proto.prepare = async function (this: typeof proto, plan, slotId, agent) {
    if (!existsSync(flag)) return real.call(this, plan, slotId, agent)
    this.revoke(slotId)
    return { plan, offered: false }
  }
}

await import('../../../src/daemon/main.ts')
