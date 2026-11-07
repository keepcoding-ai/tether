// The soul takes the composed share folder (src/daemon/share.ts) in two parts, because of two rules of soul-cli/soul-sdk
// that a plain `-S <share>` runs into:
//   - soul-cli drops every stdio MCP connection that comes from an `mcps/` folder (profile, agent or shared) unless the
//     person listed its name, command and exact args for the agent root in ~/.soul/allowed-stdio.json (the host policy,
//     soul-cli src/operator/port/profileMcp.ts); servers given with `--mcp-config` are the host's own and are not gated;
//   - soul-sdk refuses a skill whose link resolves outside its skills/ folder (readSkillsFolder `outside-scope`), so the
//     composed folder's junctions are not readable by the soul.
// So the soul gets:
//   -S <share>/soul           a view with only skills/: a REAL copy (syncCopy) of every skill of the folder, the loose
//                             ones and each MCP's own (the soul's "only while connected" rule for an MCP's skills, D9,
//                             does not apply to a copy: the same accepted loss as Claude's)
//   --mcp-config <share>/soul.mcp.json   every mcps/<slug>/mcp.json merged (disabled ones left out); absent when none
// Both go before a `--` (after it every word is the prompt); `--mcp-config` takes one value in soul-cli (repeatable).
import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { removeTree, shareMcpServers, shareSkills, SKILLS_DIR, syncCopy, writeIfChanged } from '../daemon/share.ts'
import { MCP_CONFIG_FLAG } from './mcp.ts'
import { withSharedFolder } from './soul.ts'
import type { LaunchPlan } from './types.ts'

export const SOUL_VIEW_DIR = 'soul'
export const SOUL_MCP_FILE = 'soul.mcp.json'

/** Writes (or brings up to date) <shareDir>/soul/ and <shareDir>/soul.mcp.json; returns them (mcpFile undefined: no server). */
export function ensureSoulView(shareDir: string): { viewDir: string; mcpFile: string | undefined } {
  const viewDir = join(shareDir, SOUL_VIEW_DIR)
  const skillsDir = join(viewDir, SKILLS_DIR)
  mkdirSync(skillsDir, { recursive: true })
  const skills = shareSkills(shareDir)
  for (const name of readdirSync(skillsDir)) if (!skills.has(name)) removeTree(join(skillsDir, name))
  for (const [name, src] of skills) syncCopy(src, join(skillsDir, name))
  const servers = shareMcpServers(shareDir)
  const mcpFile = join(shareDir, SOUL_MCP_FILE)
  if (Object.keys(servers).length === 0) { removeTree(mcpFile); return { viewDir, mcpFile: undefined } }
  writeIfChanged(mcpFile, JSON.stringify({ mcpServers: servers }, null, 2) + '\n')
  return { viewDir, mcpFile }
}

/** `plan` with `-S <share>/soul` and `--mcp-config <share>/soul.mcp.json` (a copy), the view written first. */
export function withSoulShare(plan: LaunchPlan, shareDir: string, platform: NodeJS.Platform = process.platform): LaunchPlan {
  const { viewDir, mcpFile } = ensureSoulView(shareDir)
  const out = withSharedFolder(plan, viewDir, platform)
  if (!mcpFile) return out
  const end = out.args.indexOf('--')
  const head = end < 0 ? out.args : out.args.slice(0, end)
  const tail = end < 0 ? [] : out.args.slice(end)
  return { ...out, args: [...head, MCP_CONFIG_FLAG, mcpFile, ...tail] }
}
