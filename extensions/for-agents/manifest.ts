// The for-agents extension (tether for agents): the person gives a pane or a desk to an agent, and the agent has over its
// content the power the person has. Ownership is data in the door's objects (rules.ts), the daemon reconciles it with the
// door (held, rerouted attention), the conductors (conductor-*) teach it each kind of content. The verbs' namespace is
// `agents` (the agent sees mcp__tether__agents_send, runs `tether agents send`). Ids never change.
import type { ExtensionManifest } from '../types.ts'

const CATEGORY = 'Agentes'
export const EXT_ID = 'for-agents'
/** The namespace of the verbs (VerbContribution.ns), distinct from the id. */
export const VERB_NS = 'agents'

export const manifest: ExtensionManifest = {
  id: EXT_ID,
  version: '0.1.0',
  displayName: 'Tether for agents',
  description: 'Dar uma guia ou uma mesa a um agente: ele passa a comandar o que está nela, como você comandaria.',
  hosts: ['renderer', 'daemon'],
  optional: true,
  contributes: {
    // The gestures of ownership as commands; `arg` is `{ kind: 'pane' | 'desk', id }` (with `to` to give, `scope: 'all'` to pause an
    // owner everywhere), and with none they act on the active pane. `for-agents.inventory` opens the inventory pad.
    commands: [
      { command: 'for-agents.give', title: 'Dar a guia ativa a um agente…', category: CATEGORY, icon: 'robot' },
      { command: 'for-agents.take', title: 'Tomar a guia ativa do agente', category: CATEGORY, icon: 'hand-grabbing' },
      { command: 'for-agents.return', title: 'Devolver a guia ativa ao agente', category: CATEGORY, icon: 'arrow-u-up-left' },
      { command: 'for-agents.revoke', title: 'Revogar o dono da guia ativa', category: CATEGORY, icon: 'link-break' },
      { command: 'for-agents.pause', title: 'Pausar o agente na guia ativa', category: CATEGORY, icon: 'pause' },
      { command: 'for-agents.resume', title: 'Retomar o agente na guia ativa', category: CATEGORY, icon: 'play' },
      { command: 'for-agents.go-to-owner', title: 'Ir para o dono da guia ativa', category: CATEGORY, icon: 'arrow-square-out' },
      { command: 'for-agents.inventory', title: 'Abrir o que o agente pode (inventário)', category: CATEGORY, icon: 'sliders-horizontal' },
    ],
    // The inventory: a pad of the right bar that draws its own header ("O que Atrium pode · kai-aware"); one view, which follows
    // the desk on screen or the desk or pane a command pointed it at.
    pads: [{ id: 'for-agents.inventory', title: 'O que o agente pode', icon: 'sliders-horizontal', defaultSide: 'right', scope: 'global', absorbsHeader: true, order: 50 }],
  },
}
