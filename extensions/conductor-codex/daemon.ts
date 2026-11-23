// The codex conductor in tetherd: registers itself in conductorRegistry (../for-agents/conductor-api.ts); the acts live in conductor.ts.
// It also registers the Codex typist of the core's delivery (contract N5): a channel message typed through the terminal goes
// out by the conductor's own `send`, which looks at the composer after the Enter and presses it again while the text sits there.
import { toDisposable, type IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { TetherDaemon } from '../../src/daemon/ext-api.ts'
import type { Typist } from '../../src/daemon/door/types.ts'
import { ConductError, conductorRegistry, type ConductorContext, type ScreenText } from '../for-agents/conductor-api.ts'
import { createScreenReaders } from '../for-agents/screen/index.ts'
import { codexConductor } from './conductor.ts'

export { manifest } from './manifest.ts'

export interface CodexTypistDeps {
  api: Pick<TetherDaemon, 'slots' | 'agents' | 'io' | 'home'>
  /** The slot's screen as the person sees it. */
  screen(slotId: string): Promise<ScreenText>
}

/**
 * The delivery's typist for Codex: the conductor's `send` (the text, its Enter, then the composer read until Codex took it,
 * Enter again while the text stays in the box) on a context whose only write is the delivery's (its interlocks). A refusal of
 * the conductor (`unsent`, the Enter not taken; `with-user`, an interlock stopped it; `busy`, a card on the screen before any
 * byte) answers 'unsent'; the delivery keeps the item queued when nothing was written.
 */
export function codexTypist(deps: CodexTypistDeps): Typist {
  const { api } = deps
  return {
    async type(typing, text) {
      const slotId = typing.slotId
      const slot = api.slots.get(slotId)
      const ctx: ConductorContext = {
        target: { paneId: slotId, type: 'terminal', ...(slot ? { slot } : {}) },
        slot: () => api.slots.get(slotId),
        agent: api.agents.get('codex'),
        screen: () => deps.screen(slotId),
        write: async (chunks) => {
          if (!(await typing.write(chunks))) throw new ConductError('with-user', 'a entrega parou: a guia mudou de mãos, o processo saiu ou o usuário digitou')
        },
        keys: async () => { throw new ConductError('unsupported', 'o digitador da entrega só escreve texto') },
        io: api.io,
        home: api.home,
        log: typing.log,
      }
      try {
        await codexConductor.send!(ctx, text)
        return 'sent'
      } catch (e) {
        if (!(e instanceof ConductError)) throw e
        typing.log(`${e.code}: ${e.message}`)
        return 'unsent'
      }
    },
  }
}

export function activate(api: TetherDaemon): IDisposable[] {
  const readers = createScreenReaders()
  const screen = (slotId: string): Promise<ScreenText> => readers.read(slotId, (since) => api.slots.readScreen(slotId, since === undefined ? undefined : { since }))
  // The delivery is one per door host: each activation registers on its own.
  const own = [api.delivery.useTypist('codex', codexTypist({ api, screen })), toDisposable(() => readers.dispose())]
  // One registry per process, and a process may activate the daemon extensions twice (see conductor-terminal): the second finds it there.
  if (conductorRegistry.get(codexConductor.id) === codexConductor) return own
  return [...own, conductorRegistry.register(codexConductor)]
}
