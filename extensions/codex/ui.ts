// How the app names and draws Codex (AgentUi): data, registered by renderer.ts; unit tests register it directly.
import type { AgentUi } from '../../app/renderer/agent-ui.ts'

export const codexUi: AgentUi = {
  name: 'codex',
  label: 'Codex',
  icon: 'lightning',
  keywords: ['openai', 'gpt', 'agente'],
  argsPlaceholder: '--dangerously-bypass-approvals-and-sandbox',
}
