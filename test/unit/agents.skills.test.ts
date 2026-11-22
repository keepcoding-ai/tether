import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { claudeSkills, parseFrontmatter, soulSkills, systemPromptSkills, SOUL_SHARED_FOLDERS_ENV } from '../../src/agents/skills.ts'
import { createExecutor } from '../../src/exec/executor.ts'
import { loadSkills, skillsVersion } from '../../src/exec/ops-agents.ts'
import { createSkillsMiddleware, libraryDir } from '../../extensions/skills/daemon.ts'
import { withMcpConfigFlag } from '../../src/agents/mcp.ts'
import type { LaunchPlan } from '../../src/agents/types.ts'
import type { SlotMeta } from '../../src/core/event.ts'

const plan = (): LaunchPlan => ({ command: 'agent', args: ['--settings', 's.json', 'hello'], cwd: '.', env: {} })
const inline = createExecutor({ mode: 'inline' })
const bundleOf = (home: string) => { const skills = loadSkills(libraryDir()); return { skills, home, version: skillsVersion(skills), exec: inline } }

test('the library ships use-todo with a valid frontmatter', () => {
  const skills = loadSkills(libraryDir())
  const todo = skills.find(s => s.name === 'use-todo')
  assert.ok(todo)
  assert.match(todo.description, /todo/i)
  assert.equal(parseFrontmatter('---\nname: x\ndescription: >-\n  a\n  b\n---\n')?.description, 'a b')
})

test('a folder whose name differs from its frontmatter is skipped', () => {
  const lib = mkdtempSync(join(tmpdir(), 'skills-'))
  mkdirSync(join(lib, 'a')); writeFileSync(join(lib, 'a', 'SKILL.md'), '---\nname: b\n---\n')
  const logs: string[] = []
  assert.deepEqual(loadSkills(lib, m => logs.push(m)), [])
  assert.equal(logs.length, 1)
})

test('claude: a `tether` plugin under the home, first on the command line, never touching ~/.claude', async () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  const out = await claudeSkills.inject(plan(), bundleOf(home))
  assert.equal(out.args[0], '--plugin-dir')
  const dir = out.args[1]!
  assert.ok(dir.startsWith(home))
  assert.equal(JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).name, 'tether')
  assert.ok(existsSync(join(dir, 'skills', 'use-todo', 'SKILL.md')))
  assert.deepEqual(out.args.slice(2), plan().args)
  // A variadic --mcp-config appended later does not swallow it.
  assert.deepEqual(withMcpConfigFlag(out, 'm.json').args.slice(-2), ['--mcp-config', 'm.json'])
})

test('soul: a shared folder appended to SOUL_CLI_SHARED_FOLDERS, args untouched', async () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  const out = await soulSkills.inject(plan(), bundleOf(home))
  assert.deepEqual(out.args, plan().args)
  const dir = out.env[SOUL_SHARED_FOLDERS_ENV]!
  assert.ok(existsSync(join(dir, 'skills', 'use-todo', 'SKILL.md')))
  const again = await soulSkills.inject({ ...plan(), env: { [SOUL_SHARED_FOLDERS_ENV]: 'mine' } }, bundleOf(home))
  assert.ok(again.env[SOUL_SHARED_FOLDERS_ENV]!.startsWith('mine'))
})

test('fallback: the skills text with the agent system prompt flag', async () => {
  const out = await systemPromptSkills('--append-system-prompt').inject(plan(), bundleOf(mkdtempSync(join(tmpdir(), 'h-'))))
  assert.equal(out.args.at(-2), '--append-system-prompt')
  assert.match(out.args.at(-1)!, /<skill name="use-todo">/)
})

test('middleware: shells and agents without skills are untouched', async () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  const mw = createSkillsMiddleware({ agent: n => (n === 'claude' ? { skills: claudeSkills } as never : { } as never), home, library: libraryDir(), log: () => {}, exec: () => inline })
  const p = plan()
  assert.equal(await mw(p, { agent: 'shell' } as SlotMeta), p)
  assert.equal(await mw(p, { agent: 'other', slotId: 'x' } as SlotMeta), p)
  assert.equal((await mw(p, { agent: 'claude', slotId: 'x' } as SlotMeta)).args[0], '--plugin-dir')
})

test('for-agents: only the soul engine receives it; the others keep the rest', async () => {
  const skills = loadSkills(libraryDir())
  const fa = skills.find(s => s.name === 'for-agents')
  assert.ok(fa)
  assert.deepEqual(fa.agents, ['soul'])
  assert.match(fa.description, /\[tether · for-agents/)
  assert.equal(parseFrontmatter('---\nname: x\n---\n')?.agents, undefined)
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  const soulDir = (await soulSkills.inject(plan(), bundleOf(home))).env[SOUL_SHARED_FOLDERS_ENV]!
  assert.ok(existsSync(join(soulDir, 'skills', 'for-agents', 'SKILL.md')))
  const claudeDir = (await claudeSkills.inject(plan(), bundleOf(home))).args[1]!
  assert.ok(!existsSync(join(claudeDir, 'skills', 'for-agents')))
  for (const n of ['use-todo', 'ronda', 'processes', 'llm-usage']) {
    assert.ok(existsSync(join(soulDir, 'skills', n, 'SKILL.md')))
    assert.ok(existsSync(join(claudeDir, 'skills', n, 'SKILL.md')))
  }
  const text = readFileSync(join(soulDir, 'skills', 'for-agents', 'SKILL.md'), 'utf8')
  for (const verb of ['open', 'send', 'interrupt', 'read-screen', 'last-answer', 'answer', 'command', 'type', 'keys', 'close', 'restart', 'give', 'revoke']) assert.match(text, new RegExp('\\| `' + verb + '[ `]'))
  assert.match(text, /send <guia> <text> \[--raw\]/)
  assert.doesNotMatch(text, /raw: true|fresh: true|to: self/)
  assert.match(text, /node "\$TETHER_CLI" agents list/)
})

test('the library ships processes (tether:processes for claude): when to use it, the CLI, exit 3, no domain words', async () => {
  const skills = loadSkills(libraryDir())
  const proc = skills.find(s => s.name === 'processes')
  assert.ok(proc)
  assert.match(proc.description, /antes de subir/i)
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  const dir = (await claudeSkills.inject(plan(), bundleOf(home))).args[1]!
  const text = readFileSync(join(dir, 'skills', 'processes', 'SKILL.md'), 'utf8')
  for (const must of [/node "\$TETHER_CLI" proc/, /código 3/, /--wait/, /--force "motivo"/, /proc use <nome>/, /nunca reinicia nada sozinho/, /dotenvx run --/]) assert.match(text, must)
  for (const never of [/atrium/i, /supervisor/i, /\bcasa\b/i]) assert.doesNotMatch(text, never)
})
