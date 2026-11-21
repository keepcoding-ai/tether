// A test daemon extension for the agent door (D8): the verbs a real Claude calls (`doortest ping`, over MCP and the CLI) and the
// ones the test drives through the pipe (`push` delivers a message, `route` reroutes attention). The delivery is on from the start,
// so the `tether` MCP server is offered with its channel. Every call is appended as one JSON line to the file named by
// DOORTEST_LOG, which is how the test sees what the handler received (the daemon is another process). No key ever reaches it.
import { appendFile } from 'node:fs/promises'
import type { TetherDaemon } from '../../../src/daemon/ext-api.ts'
import type { IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import type { ExtensionManifest } from '../../../extensions/types.ts'

export const ID = 'doortest'
export const ENV_LOG = 'DOORTEST_LOG'

export const manifest: ExtensionManifest = {
  id: ID,
  version: '0.0.1',
  displayName: 'Door test',
  description: 'Test-only extension: verbs and delivery for the agent door E2E.',
  hosts: ['daemon'],
  optional: true,
}

async function note(entry: Record<string, unknown>): Promise<void> {
  const file = process.env[ENV_LOG]
  if (file) await appendFile(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
}

export function activate(api: TetherDaemon): IDisposable[] {
  const out: IDisposable[] = []
  out.push(api.delivery.enable())
  out.push(api.delivery.onDidDeliver((r) => { void note({ event: 'delivered', id: r.id, slotId: r.slotId, state: r.state }) }))
  out.push(api.verbs.register({
    ns: ID, name: 'ping',
    description: 'Test tool: records the call and answers pong. Pass a short `mark` to tell calls apart.',
    help: 'Verbo de teste da porta: registra a chamada.',
    input: { type: 'object', properties: { mark: { type: 'string', description: 'A short label.' } } },
    run: async (caller, args) => {
      await note({ event: 'verb', name: 'ping', slotId: caller.slotId, via: caller.via, proven: caller.proven, mark: args.mark })
      return { text: 'pong', data: { slotId: caller.slotId } }
    },
  }))
  out.push(api.verbs.register({
    ns: ID, name: 'push', exits: ['cli'],
    description: 'Test: delivers a message to a slot.',
    help: 'Entrega uma mensagem de teste a um slot.',
    input: { type: 'object', properties: { slot: { type: 'string' }, body: { type: 'string' }, room: { type: 'string' } }, required: ['slot', 'body'] },
    run: async (_caller, args) => {
      const receipt = await api.delivery.deliver(String(args.slot), {
        kind: 'message',
        ...(args.room ? { room: String(args.room) } : {}),
        from: { name: 'Atrium', id: 'a1b2c3', role: 'member' },
        body: String(args.body),
      })
      await note({ event: 'push', receipt })
      return { text: receipt.state, data: receipt }
    },
  }))
  out.push(api.verbs.register({
    ns: ID, name: 'route', exits: ['cli'],
    description: 'Test: reroutes the attention of a slot to another.',
    help: 'Desvia a atenção de um slot para outro.',
    input: { type: 'object', properties: { slot: { type: 'string' }, to: { type: 'string' } }, required: ['slot', 'to'] },
    run: async (_caller, args) => {
      await api.attention.route(String(args.slot), String(args.to))
      await note({ event: 'route', slot: args.slot, to: args.to })
      return { text: 'ok' }
    },
  }))
  return out
}
