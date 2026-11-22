// Tether skills: instructions written once, agent-agnostic (extensions/skills/library/<name>/SKILL.md, a folder per skill with
// YAML frontmatter `name` + `description`), handed to every AI agent tether launches. Each agent contribution says how its
// CLI takes them (AgentContribution.skills): the adapter materializes the skills in its own format under
// <TETHER_HOME>/skills/<agent>/ and adds the flag that loads them — never the user's home or global config.
//   - Claude Code: a plugin named `tether` (`.claude-plugin/plugin.json` + `skills/<name>/SKILL.md`) through `--plugin-dir`,
//     so the command is `/tether:<name>`;
//   - soul-cli: a shared folder (`<dir>/skills/<name>/SKILL.md`) through `-S <dir>`;
//   - an agent with no skills of its own but a system prompt flag: `systemPromptSkills(flag)`, the skills' text appended.
// A new agent writes its own AgentSkills; nothing else changes.
import { watch, type FSWatcher } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { Executor } from '../exec/executor.ts'
import type { LaunchPlan } from './types.ts'

export interface TetherSkill {
  /** The folder's name, equal to the frontmatter's `name`. */
  name: string
  description: string
  /** Frontmatter `agents:` (comma separated): the engines that receive this skill. Absent = every engine. */
  agents?: string[]
  /** The folder holding SKILL.md (and anything it ships with). */
  dir: string
  /** SKILL.md's full text. */
  text: string
}

export interface SkillBundle {
  skills: readonly TetherSkill[]
  /** <TETHER_HOME>: the adapter writes its format under <home>/skills/<agent>/. */
  home: string
  /** Changes whenever any skill changes: an adapter rewrites its copy only when this differs. */
  version: string
  /** Writes the adapter's copy (the executor's work lane). */
  exec: Executor
}

/** How an agent's CLI takes the tether's skills. Returns a copy of the plan (or the same plan when there is nothing to do). */
export interface AgentSkills {
  inject(plan: LaunchPlan, bundle: SkillBundle): LaunchPlan | Promise<LaunchPlan>
}

/** `name` and `description` from a SKILL.md's frontmatter (folded `>-` blocks joined); undefined without a frontmatter name. */
export function parseFrontmatter(text: string): { name: string; description: string; agents?: string[] } | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return undefined
  const lines = m[1]!.split(/\r?\n/)
  const fields: Record<string, string> = {}
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]!)
    if (!kv) continue
    let value = kv[2]!.trim()
    if (/^[>|][+-]?$/.test(value)) {
      const parts: string[] = []
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1]!)) parts.push(lines[++i]!.trim())
      value = parts.join(' ')
    }
    fields[kv[1]!] = value.replace(/^["']|["']$/g, '')
  }
  if (!fields.name) return undefined
  const agents = (fields.agents ?? '').split(',').map(a => a.trim()).filter(Boolean)
  return { name: fields.name, description: fields.description ?? '', ...(agents.length ? { agents } : {}) }
}

/** The skills meant for one engine: those with no `agents:` restriction, plus those that name it. */
export function skillsFor(agent: string, skills: readonly TetherSkill[]): TetherSkill[] {
  return skills.filter(s => !s.agents || s.agents.includes(agent))
}

export interface SkillsSnapshot {
  skills: TetherSkill[]
  version: string
}

/**
 * The library read once and kept until something under it changes (an `fs.watch` marks it dirty), so a launch costs no
 * directory walk. Without a working watcher (the folder is missing, the platform refuses) every `get` reads afresh, as before.
 * Starting a read clears the mark first: a change landing during the read leaves it dirty for the next `get`.
 */
export class SkillsCache {
  private snapshot: SkillsSnapshot | undefined
  private dirty = true
  private watcher: FSWatcher | undefined
  private watchTried = false
  private loading: Promise<SkillsSnapshot> | undefined

  private readonly library: string
  private readonly log: (msg: string) => void
  private readonly watchFn: typeof watch

  constructor(library: string, log: (msg: string) => void = () => {}, watchFn: typeof watch = watch) {
    this.library = library
    this.log = log
    this.watchFn = watchFn
  }

  /** The library as it is now: the kept snapshot while the watcher saw nothing, else read by the executor (one read at a time, shared). */
  async get(exec: Executor): Promise<SkillsSnapshot> {
    this.startWatch()
    if (this.snapshot && !this.dirty && this.watcher) return this.snapshot
    if (this.loading) return this.loading
    this.dirty = false
    const load = exec.run('loadSkills', [this.library]).then((r) => {
      for (const m of r.logs) this.log(m)
      this.snapshot = { skills: r.skills, version: r.version }
      return this.snapshot
    })
    this.loading = load
    const done = (): void => { if (this.loading === load) this.loading = undefined }
    load.then(done, done)
    return load
  }

  dispose(): void {
    this.watcher?.close()
    this.watcher = undefined
    this.snapshot = undefined
  }

  private startWatch(): void {
    if (this.watcher || this.watchTried) return
    this.watchTried = true
    try {
      const w = this.watchFn(this.library, { recursive: true, persistent: false }, () => { this.dirty = true })
      w.on('error', () => { this.dirty = true; w.close(); this.watcher = undefined })
      this.watcher = w
    } catch { /* no watcher: read every time */ }
  }
}

/** Flags go FIRST (right after the command's own leading args): a variadic option at the end (`--mcp-config`) would swallow them. */
export function withLeadingArgs(plan: LaunchPlan, args: readonly string[], at = 0): LaunchPlan {
  return { ...plan, args: [...plan.args.slice(0, at), ...args, ...plan.args.slice(at)] }
}

/** The plugin's name: the skills are `/tether:<name>` in Claude Code. */
export const CLAUDE_PLUGIN_NAME = 'tether'

/** Claude Code: a `tether` plugin under <home>/skills/claude/tether, loaded for this session only with `--plugin-dir`. */
export const claudeSkills: AgentSkills = {
  async inject(plan, bundle) {
    const skills = skillsFor('claude', bundle.skills)
    if (!skills.length) return plan
    const dir = await bundle.exec.run('materializeSkills', [{
      target: join(bundle.home, 'skills', 'claude', CLAUDE_PLUGIN_NAME),
      version: bundle.version,
      layout: 'claude-plugin',
      skills: skills.map(s => ({ name: s.name, dir: s.dir })),
      pluginJson: JSON.stringify({
        name: CLAUDE_PLUGIN_NAME,
        description: 'Skills do tether, entregues a todo agente aberto num painel.',
        version: '1.0.0',
      }, null, 2) + '\n',
    }])
    return withLeadingArgs(plan, ['--plugin-dir', dir])
  },
}

/**
 * soul-cli: a shared folder, searched for `<dir>/skills/<name>/SKILL.md`. Given through SOUL_CLI_SHARED_FOLDERS (one `-S`
 * per entry, PATH-delimited), appended to what the env already holds: an env var never collides with the command's own
 * leading args (soul may run as `node <cli>` or `bash <script>`). A `-S` on the command line wins over the variable.
 */
export const SOUL_SHARED_FOLDERS_ENV = 'SOUL_CLI_SHARED_FOLDERS'
export const soulSkills: AgentSkills = {
  async inject(plan, bundle) {
    const skills = skillsFor('soul', bundle.skills)
    if (!skills.length) return plan
    const dir = await bundle.exec.run('materializeSkills', [{ target: join(bundle.home, 'skills', 'soul'), version: bundle.version, layout: 'shared', skills: skills.map(s => ({ name: s.name, dir: s.dir })) }])
    const current = plan.env[SOUL_SHARED_FOLDERS_ENV]?.trim()
    const value = current ? `${current}${delimiter}${dir}` : dir
    return { ...plan, env: { ...plan.env, [SOUL_SHARED_FOLDERS_ENV]: value } }
  },
}

/** The skills as one block of system prompt text, for an agent with no skills of its own. */
export function skillsPromptText(skills: readonly TetherSkill[]): string {
  const body = skills.map(s => `<skill name="${s.name}">\n${s.text.replace(/^---[\s\S]*?---\r?\n/, '').trim()}\n</skill>`).join('\n\n')
  return `O tether oferece estas skills. Quando o usuário chamar uma pelo nome (ex.: "use-todo", "/use-todo", "/tether:use-todo"), ou o pedido dele bater com a descrição, siga as instruções dela; $ARGUMENTS é o texto que veio depois do nome.\n\n` +
    skills.map(s => `- ${s.name}: ${s.description}`).join('\n') + `\n\n${body}`
}

/**
 * The fallback adapter: the skills' text appended with the agent's system prompt flag (e.g. `--append-system-prompt`).
 * Appended at the end of the slot's args; the MCP middlewares run after this one and append theirs behind it.
 */
export function systemPromptSkills(flag: string): AgentSkills {
  return {
    inject(plan, bundle) {
      if (!bundle.skills.length) return plan
      return { ...plan, args: [...plan.args, flag, skillsPromptText(bundle.skills)] }
    },
  }
}
