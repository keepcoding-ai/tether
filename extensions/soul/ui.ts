// How the app names and draws the soul (AgentUi): data, registered by renderer.ts; unit tests register it directly.
import type { AgentUi } from '../../app/renderer/agent-ui.ts'

export const soulUi: AgentUi = {
  name: 'soul',
  label: 'soul',
  icon: 'ghost',
  keywords: ['agente'],
  argsPlaceholder: '-g',
}
