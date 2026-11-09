// What every terminal of tether knows about its own pane, through its environment (all agents and the shell):
//   TETHER_SLOT_ID    the pane's slot id
//   TETHER_TAB_URL    the pane's tether:// link (app/shared/tether-url.ts): following it brings this pane to the front
//   TETHER_OPEN_CWD   the folder the pane was OPENED in — fixed, it never follows a `cd` (an agent keeps its notes there)
//   TETHER_CLI        this tether's CLI script (`node "$TETHER_CLI" focus <file>`), for an agent with no `tether` on its PATH
// Set on top of the launch plan's env, after the profile's: a profile cannot make a pane lie about itself.
import { tabUrl } from '../../app/shared/tether-url.ts'
import { ENV_SLOT } from '../agents/types.ts'
import type { LaunchPlan } from '../agents/types.ts'
import { join } from 'node:path'

export const ENV_TAB_URL = 'TETHER_TAB_URL'
export const ENV_OPEN_CWD = 'TETHER_OPEN_CWD'
export const ENV_CLI = 'TETHER_CLI'

/** bin/tether.mjs of the checkout this daemon runs from. Read on use: a CommonJS bundle has no import.meta.dirname (see src/doctor.ts). */
export function cliScript(): string {
  return join(import.meta.dirname, '..', '..', 'bin', 'tether.mjs')
}

export function withTabEnv(plan: LaunchPlan, slot: { slotId: string; cwd: string }): LaunchPlan {
  return { ...plan, env: { ...plan.env, [ENV_SLOT]: slot.slotId, [ENV_TAB_URL]: tabUrl(slot.slotId), [ENV_OPEN_CWD]: slot.cwd, [ENV_CLI]: cliScript() } }
}
