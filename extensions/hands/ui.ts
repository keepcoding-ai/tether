// How the app names and draws the hands (AgentUi): data, registered by renderer.ts; unit tests register it directly.
import type { AgentUi } from '../../app/renderer/agent-ui.ts'

export const handsUi: AgentUi = {
  name: 'hands',
  label: 'hands',
  icon: 'hand',
  keywords: ['agente', 'cliente'],
  argsPlaceholder: '-H https://servidor -a agente',
}
