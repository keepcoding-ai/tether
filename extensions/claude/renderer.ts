// The claude extension in the renderer: how the app names and draws the agent (label, icon, chooser group and keywords,
// profile form option). Turned off, its panes stay in place as "Agente indisponível".
import type { Disposable, TetherUi } from '../../app/renderer/ext-api.ts'
import { claudeUi } from './ui.ts'
export { manifest } from './manifest.ts'

export function activate(api: TetherUi): Disposable[] {
  return [api.agents.register(claudeUi)]
}
