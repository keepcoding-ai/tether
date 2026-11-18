// A cold launch plan (empty caches) on a slow disk: claude, codex and soul plan through executor workers whose every
// operation takes 300 ms, and the loop never stops for 100 ms. The plan is the one the inline executor builds.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { claudeAdapter } from '../../src/agents/claude.ts'
import { codexAdapter } from '../../src/agents/codex.ts'
import { shellAdapter } from '../../src/agents/shell.ts'
import { ENV_SOUL_CMD, soulAdapter } from '../../src/agents/soul.ts'
import { claudeSkills, SkillsCache } from '../../src/agents/skills.ts'
import type { PlanInput } from '../../src/agents/types.ts'
import type { SlotMeta } from '../../src/core/event.ts'
import { createExecutor, type Executor } from '../../src/exec/executor.ts'

const root = mkdtempSync(join(tmpdir(), 'tether-plan-timing-'))
after(() => rmSync(root, { recursive: true, force: true }))

const DELAY = 300
const MAX_STALL_MS = 100

/** Runs `fn` while sampling the loop every 10 ms; returns the longest gap between two samples. */
async function withLoopGap<T>(fn: () => Promise<T>): Promise<{ value: T; gap: number }> {
  let last = performance.now()
  let gap = 0
  const t = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now }, 10)
  try {
    const value = await fn()
    return { value, gap }
  } finally { clearInterval(t) }
}

const slot = (agent: SlotMeta['agent'], cwd: string): SlotMeta => ({ slotId: `s-${agent}`, agent, cwd, args: [], createdAt: new Date().toISOString() }) as unknown as SlotMeta

/** The plan with what is random or per-home normalized away. */
function normalize<T extends { args: string[] }>(p: T): T {
  const args = [...p.args]
  const i = args.indexOf('--session-id')
  if (i >= 0) args[i + 1] = '<uuid>'
  return { ...p, args }
}

describe('cold plan on a slow disk', () => {
  const cwd = join(root, 'proj')
  mkdirSync(cwd, { recursive: true })
  const savedSoul = process.env[ENV_SOUL_CMD]
  const script = join(root, 'soul-cli.js')
  writeFileSync(script, '')
  process.env[ENV_SOUL_CMD] = `"${process.execPath}" "${script}"`
  after(() => { if (savedSoul === undefined) delete process.env[ENV_SOUL_CMD]; else process.env[ENV_SOUL_CMD] = savedSoul })

  const cases: Array<{ name: string; plan: (input: PlanInput) => Promise<unknown> | unknown; agent: SlotMeta['agent'] }> = [
    { name: 'claude', agent: 'claude', plan: (i) => claudeAdapter.plan(i) },
    { name: 'codex', agent: 'codex', plan: (i) => codexAdapter.plan(i) },
    { name: 'soul', agent: 'soul', plan: (i) => soulAdapter.plan(i) },
    { name: 'shell', agent: 'shell', plan: (i) => shellAdapter.plan({ slot: i.slot, profile: i.profile, exec: i.exec }) },
  ]

  for (const c of cases) {
    test(`${c.name}: the loop never stops for ${MAX_STALL_MS} ms and the plan equals the inline one`, async () => {
      const home = mkdtempSync(join(root, 'home-'))
      const inline = createExecutor({ mode: 'inline' })
      const slow: Executor = createExecutor({ mode: 'worker', ioDelayMs: DELAY })
      try {
        const input = (exec: Executor): PlanInput => ({ slot: slot(c.agent, cwd), home, extraArgs: [], exec })
        const expected = await c.plan(input(inline))
        const t0 = performance.now()
        const { value, gap } = await withLoopGap(() => Promise.resolve(c.plan(input(slow))))
        const took = performance.now() - t0
        assert.ok(gap < MAX_STALL_MS, `${c.name}: the loop stopped for ${Math.round(gap)} ms`)
        assert.ok(took >= DELAY, `${c.name}: the slow disk was felt (${Math.round(took)} ms)`)
        assert.deepEqual(normalize(value as { args: string[] }), normalize(expected as { args: string[] }))
      } finally {
        await slow.close()
        await inline.close()
      }
    })
  }

  test('skills: reading the library and writing the plugin on a slow disk leaves the loop free', async () => {
    const lib = join(root, 'lib')
    mkdirSync(join(lib, 'one'), { recursive: true })
    writeFileSync(join(lib, 'one', 'SKILL.md'), '---\nname: one\ndescription: d\n---\nbody')
    const slow = createExecutor({ mode: 'worker', ioDelayMs: DELAY })
    const cache = new SkillsCache(lib)
    try {
      const { value, gap } = await withLoopGap(async () => {
        const { skills, version } = await cache.get(slow)
        return claudeSkills.inject({ command: 'c', args: [], cwd, env: {} }, { skills, version, home: join(root, 'skills-home'), exec: slow })
      })
      assert.ok(gap < MAX_STALL_MS, `the loop stopped for ${Math.round(gap)} ms`)
      assert.equal(value.args[0], '--plugin-dir')
    } finally {
      cache.dispose()
      await slow.close()
    }
  })
})
