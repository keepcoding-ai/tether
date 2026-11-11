import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { claudeSkills, loadSkills, parseFrontmatter, skillsVersion, soulSkills, systemPromptSkills, SOUL_SHARED_FOLDERS_ENV } from '../../src/agents/skills.ts'
import { createSkillsMiddleware, libraryDir } from '../../extensions/skills/daemon.ts'
import { withMcpConfigFlag } from '../../src/agents/mcp.ts'
import type { LaunchPlan } from '../../src/agents/types.ts'
import type { SlotMeta } from '../../src/core/event.ts'

const plan = (): LaunchPlan => ({ command: 'agent', args: ['--settings', 's.json', 'hello'], cwd: '.', env: {} })
const bundleOf = (home: string) => { const skills = loadSkills(libraryDir()); return { skills, home, version: skillsVersion(skills) } }

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

test('claude: a `tether` plugin under the home, first on the command line, never touching ~/.claude', () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  const out = claudeSkills.inject(plan(), bundleOf(home))
  assert.equal(out.args[0], '--plugin-dir')
  const dir = out.args[1]!
  assert.ok(dir.startsWith(home))
  assert.equal(JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).name, 'tether')
  assert.ok(existsSync(join(dir, 'skills', 'use-todo', 'SKILL.md')))
  assert.deepEqual(out.args.slice(2), plan().args)
  // A variadic --mcp-config appended later does not swallow it.
  assert.deepEqual(withMcpConfigFlag(out, 'm.json').args.slice(-2), ['--mcp-config', 'm.json'])
})

test('soul: a shared folder appended to SOUL_CLI_SHARED_FOLDERS, args untouched', () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  const out = soulSkills.inject(plan(), bundleOf(home))
  assert.deepEqual(out.args, plan().args)
  const dir = out.env[SOUL_SHARED_FOLDERS_ENV]!
  assert.ok(existsSync(join(dir, 'skills', 'use-todo', 'SKILL.md')))
  const again = soulSkills.inject({ ...plan(), env: { [SOUL_SHARED_FOLDERS_ENV]: 'mine' } }, bundleOf(home))
  assert.ok(again.env[SOUL_SHARED_FOLDERS_ENV]!.startsWith('mine'))
})

test('fallback: the skills text with the agent system prompt flag', () => {
  const out = systemPromptSkills('--append-system-prompt').inject(plan(), bundleOf(mkdtempSync(join(tmpdir(), 'h-'))))
  assert.equal(out.args.at(-2), '--append-system-prompt')
  assert.match(out.args.at(-1)!, /<skill name="use-todo">/)
})

test('middleware: shells and agents without skills are untouched', () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  const mw = createSkillsMiddleware({ agent: n => (n === 'claude' ? { skills: claudeSkills } as never : { } as never), home, library: libraryDir(), log: () => {} })
  const p = plan()
  assert.equal(mw(p, { agent: 'shell' } as SlotMeta), p)
  assert.equal(mw(p, { agent: 'other', slotId: 'x' } as SlotMeta), p)
  assert.equal(mw(p, { agent: 'claude', slotId: 'x' } as SlotMeta).args[0], '--plugin-dir')
})

test('the library ships processos (tether:processos for claude): when to use it, the CLI, exit 3, no domain words', () => {
  const skills = loadSkills(libraryDir())
  const proc = skills.find(s => s.name === 'processos')
  assert.ok(proc)
  assert.match(proc.description, /antes de subir/i)
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  const dir = claudeSkills.inject(plan(), bundleOf(home)).args[1]!
  const text = readFileSync(join(dir, 'skills', 'processos', 'SKILL.md'), 'utf8')
  for (const must of [/node "\$TETHER_CLI" proc/, /código 3/, /--wait/, /--force "motivo"/, /proc use <nome>/, /nunca reinicia nada sozinho/, /dotenvx run --/]) assert.match(text, must)
  for (const never of [/atrium/i, /supervisor/i, /\bcasa\b/i]) assert.doesNotMatch(text, never)
})
