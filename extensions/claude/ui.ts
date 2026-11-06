// How the app names and draws Claude (AgentUi): data, registered by renderer.ts; unit tests register it directly.
import type { AgentUi } from '../../app/renderer/agent-ui.ts'

export const claudeUi: AgentUi = {
  name: 'claude',
  label: 'Claude',
  icon: 'sparkle',
  keywords: ['cc', 'agente', 'code'],
  argsPlaceholder: '--dangerously-skip-permissions',
}
