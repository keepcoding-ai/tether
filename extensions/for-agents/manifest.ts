// The for-agents extension (tether for agents): the person gives a pane or a desk to an agent, and the agent has over its
// content the power the person has. Ownership is data in the door's objects (rules.ts), the daemon reconciles it with the
// door (held, rerouted attention), the conductors (conductor-*) teach it each kind of content. The verbs' namespace is
// `agents` (the agent sees mcp__tether__agents_send, runs `tether agents send`). Ids never change.
import type { ExtensionManifest } from '../types.ts'

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
}
