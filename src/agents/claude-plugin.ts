// Claude Code takes the composed share folder (src/daemon/share.ts, the layout of a Soul shared folder) in two parts,
// both for the session only (nothing is installed in ~/.claude), generated next to the folder they translate and
// reconciled at every launch:
//   <share>/claude.mcp.json      `{ "mcpServers": {...} }`, every `mcps/<slug>/mcp.json` merged (a connection whose
//                                mcp.meta.json says `enabled: false` is left out), handed with `--mcp-config`: the
//                                servers keep their own names, so the tools stay `mcp__<slug>__*` (`mcp__tether-bridge__*`,
//                                the names allowlists and skills refer to; a plugin's server would be `plugin:tether:<slug>`)
//   <share>/claude-plugin/       a plugin with skills only, handed with `--plugin-dir`, skills becoming `/tether:<name>`:
//     .claude-plugin/plugin.json { name: "tether", version, description }
//     skills/<name>              a junction to each skill of the folder (`skills/<name>`), then to each MCP's own skills
//                                (`mcps/<slug>/skills/<name>`); the first one to take a name keeps it
// Each flag is left out when its part is empty. `--mcp-config` goes LAST: Claude's option is variadic
// (`--mcp-config <configs...>`), so anything after it would be read as one more file (src/agents/mcp.ts).
// Accepted loss against the Soul: Claude lists an MCP's own skills even while that server is down (the Soul offers them
// only while it is connected).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BRAND } from '../../app/shared/brand.ts'
import { removeTree, shareMcpServers, shareSkills, SKILLS_DIR, syncLinks, writeIfChanged } from '../daemon/share.ts'
import { withCliShim } from './cli-shim.ts'
import { MCP_CONFIG_FLAG } from './mcp.ts'
import type { LaunchPlan } from './types.ts'

export const PLUGIN_DIR_FLAG = '--plugin-dir'
export const CLAUDE_PLUGIN_DIR = 'claude-plugin'
export const CLAUDE_MCP_FILE = 'claude.mcp.json'
export const PLUGIN_VERSION = '1.0.0'

/** Writes (or brings up to date) <shareDir>/claude-plugin/ with the folder's skills; undefined (and no folder) when it has none. */
export function ensureClaudePlugin(shareDir: string): string | undefined {
  const dir = join(shareDir, CLAUDE_PLUGIN_DIR)
  const skills = shareSkills(shareDir)
  if (skills.size === 0) { removeTree(dir); return undefined }
  const features = shareDir.split(/[\\/]/).filter(Boolean).pop() ?? ''
  const manifest = {
    name: BRAND.slug,
    version: PLUGIN_VERSION,
    description: `O que o ${BRAND.name} oferece aos agentes dos painéis (features: ${features.replace(/\+/g, ', ')}).`,
  }
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  writeIfChanged(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n')
  syncLinks(join(dir, SKILLS_DIR), skills, { linked: 0, copied: 0 })
  removeTree(join(dir, '.mcp.json')) // the servers go through --mcp-config (an older layout had them here)
  return dir
}

/** Writes (or brings up to date) <shareDir>/claude.mcp.json; undefined (and no file) when the folder has no server. */
export function ensureClaudeMcpConfig(shareDir: string): string | undefined {
  const file = join(shareDir, CLAUDE_MCP_FILE)
  const servers = shareMcpServers(shareDir)
  if (Object.keys(servers).length === 0) { removeTree(file); return undefined }
  writeIfChanged(file, JSON.stringify({ mcpServers: servers }, null, 2) + '\n')
  return file
}

/**
 * `plan` with `--plugin-dir <share>/claude-plugin` and, last, `--mcp-config <share>/claude.mcp.json` (a copy), and
 * <share>/bin (the `tether` shim the skills call, src/agents/cli-shim.ts) at the front of the PATH.
 */
export function withClaudePlugin(plan: LaunchPlan, shareDir: string): LaunchPlan {
  const pluginDir = ensureClaudePlugin(shareDir)
  const mcpFile = ensureClaudeMcpConfig(shareDir)
  return withCliShim({
    ...plan,
    args: [...plan.args, ...(pluginDir ? [PLUGIN_DIR_FLAG, pluginDir] : []), ...(mcpFile ? [MCP_CONFIG_FLAG, mcpFile] : [])],
  }, shareDir)
}
