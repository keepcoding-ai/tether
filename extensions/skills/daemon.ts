// The skills extension in tetherd: a launch middleware hands the library's skills to every AI agent launch (never a plain
// shell) through the agent's own AgentContribution.skills; an agent without it is launched as before. The library is read
// at every launch (a few small files): an edited skill applies to the next agent started, and each adapter rewrites its
// copy under <TETHER_HOME>/skills/<agent>/ only when the library changed.
import { resolve } from 'node:path'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { AgentContribution } from '../../src/agents/registry.ts'
import { loadSkills, skillsVersion } from '../../src/agents/skills.ts'
import type { LaunchPlan } from '../../src/agents/types.ts'
import type { SlotMeta } from '../../src/core/event.ts'
import type { TetherDaemon } from '../../src/daemon/ext-api.ts'

export { manifest } from './manifest.ts'

/** extensions/skills/library. Read on use: a CommonJS bundle (Electron main) has no import.meta.dirname, and never launches. */
export function libraryDir(): string {
  return resolve(import.meta.dirname ?? '.', 'library')
}

export interface SkillsDeps {
  agent(name: string): AgentContribution | undefined
  home: string
  library: string
  log(msg: string): void
}

/** The launch middleware: the plan given (same object) when nothing applies; a failing adapter is logged, never fatal. */
export function createSkillsMiddleware(deps: SkillsDeps): (plan: LaunchPlan, slot: SlotMeta) => LaunchPlan {
  return (plan, slot) => {
    if (slot.agent === 'shell') return plan
    const agent = deps.agent(slot.agent)
    if (!agent?.skills) return plan
    try {
      const skills = loadSkills(deps.library, deps.log)
      if (!skills.length) return plan
      return agent.skills.inject(plan, { skills, home: deps.home, version: skillsVersion(skills) })
    } catch (e) {
      deps.log(`skills não entregues a ${slot.agent} (${slot.slotId}): ${e instanceof Error ? e.message : String(e)}`)
      return plan
    }
  }
}

export function activate(api: TetherDaemon): IDisposable[] {
  return [api.launch.use(createSkillsMiddleware({ agent: n => api.agents.get(n), home: api.home, library: libraryDir(), log: m => api.log(m) }))]
}
