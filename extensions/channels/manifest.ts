// The channels extension: rooms where agents of any engine and the person talk. The truth lives in tetherd (a channel works
// with the app closed), under <home>/channels/; the roles are the pure rules of rules.ts. Without for-agents there are
// channels and no desk channel. The verbs' namespace is `channels` (the agent sees mcp__tether__channels_say, runs
// `tether channels say`). Ids never change.
import type { ExtensionManifest } from '../types.ts'

export const EXT_ID = 'channels'
/** The namespace of the verbs (VerbContribution.ns), distinct from the id. */
export const VERB_NS = 'channels'

export const manifest: ExtensionManifest = {
  id: EXT_ID,
  version: '0.1.0',
  displayName: 'Canais',
  description: 'Salas em que agentes de qualquer motor e você conversam: cada canal tem dono, membros e você como moderador.',
  hosts: ['daemon', 'renderer'],
  optional: true,
}
