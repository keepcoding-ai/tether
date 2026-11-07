// Claude Code takes the composed share folder (src/daemon/share.ts, the layout of a Soul shared folder) as a plugin,
// loaded for the session only with `--plugin-dir` (nothing is installed in ~/.claude). The plugin is generated next to
// the folder it translates, <share>/<signature>/claude-plugin/, and reconciled at every launch:
//   .claude-plugin/plugin.json   { name: "tether", version, description }: skills become `/tether:<name>`, servers
//                                `plugin:tether:<slug>` (tools `mcp__plugin_tether_<slug>__*`)
//   skills/<name>                a junction to each skill of the folder (`skills/<name>`), then to each MCP's own skills
//                                (`mcps/<slug>/skills/<name>`); the first one to take a name keeps it
//   .mcp.json                    `{ "mcpServers": {...} }`, every `mcps/<slug>/mcp.json` merged (a connection whose
//                                mcp.meta.json says `enabled: false` is left out)
// Accepted loss against the Soul: Claude lists an MCP's own skills even while that server is down (the Soul offers them
// only while it is connected).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BRAND } from '../../app/shared/brand.ts'
import { shareMcpServers, shareSkills, SKILLS_DIR, syncLinks, writeIfChanged } from '../daemon/share.ts'
import type { LaunchPlan } from './types.ts'

export const PLUGIN_DIR_FLAG = '--plugin-dir'
export const CLAUDE_PLUGIN_DIR = 'claude-plugin'
export const PLUGIN_VERSION = '1.0.0'

/** The servers of the plugin's .mcp.json (every connection of the folder but the disabled ones). */
export const mergedMcpServers = shareMcpServers

/** The skills the plugin offers, name → folder: the loose ones first, then each MCP's own. */
export const pluginSkills = shareSkills

/** Writes (or brings up to date) <shareDir>/claude-plugin/ and returns its path. */
export function ensureClaudePlugin(shareDir: string): string {
  const dir = join(shareDir, CLAUDE_PLUGIN_DIR)
  const features = shareDir.split(/[\\/]/).filter(Boolean).pop() ?? ''
  const manifest = {
    name: BRAND.slug,
    version: PLUGIN_VERSION,
    description: `O que o ${BRAND.name} oferece aos agentes dos painéis (features: ${features.replace(/\+/g, ', ')}).`,
  }
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  writeIfChanged(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n')
  syncLinks(join(dir, SKILLS_DIR), pluginSkills(shareDir), { linked: 0, copied: 0 })
  writeIfChanged(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: mergedMcpServers(shareDir) }, null, 2) + '\n')
  return dir
}

/** `plan` with `--plugin-dir <shareDir>/claude-plugin` appended (a copy), the plugin written first. */
export function withClaudePlugin(plan: LaunchPlan, shareDir: string): LaunchPlan {
  return { ...plan, args: [...plan.args, PLUGIN_DIR_FLAG, ensureClaudePlugin(shareDir)] }
}
