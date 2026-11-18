// canonicalDir: the folder string an agent is launched in must match what the agent recorded for its
// sessions (Claude's /resume picker compares the cwd text exactly: `d:\atrium` finds nothing under
// `D:\atrium`). Existing folder → on-disk casing + upper-case drive; missing folder → kept, drive fixed.
// Every adapter runs its plan cwd through it, so slots/bindings saved with the wrong casing still spawn right.
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { claudeAdapter } from '../../src/agents/claude.ts'
import { shellAdapter } from '../../src/agents/shell.ts'
import { soulAdapter } from '../../src/agents/soul.ts'
import type { Binding, SlotMeta } from '../../src/core/event.ts'
import { canonicalDir } from '../../src/core/paths.ts'
import { tempDirs } from './tmp.helpers.ts'

const win = process.platform === 'win32'
const dirs = tempDirs('tether-paths-')
after(() => dirs.cleanup())

/** A real folder named `Projeto`, plus the same path typed with the wrong casing and a lower-case drive. */
function wrongCased(): { onDisk: string; typed: string } {
  const root = dirs.make()
  const onDisk = join(root, 'Projeto')
  mkdirSync(onDisk)
  const typed = join(root, 'projeto').replace(/^([A-Z]):/, (_m, d: string) => `${d.toLowerCase()}:`)
  return { onDisk: canonicalDir(onDisk), typed }
}

describe('canonicalDir', () => {
  test('existing folder typed with the wrong casing → the casing on disk', { skip: !win && 'case-sensitive filesystem' }, () => {
    const { onDisk, typed } = wrongCased()
    assert.notEqual(typed, onDisk, 'the fixture really differs in casing')
    const got = canonicalDir(typed)
    assert.equal(got, onDisk)
    assert.ok(got.endsWith('\\Projeto'), got)
    assert.equal(got, realpathSync.native(onDisk).replace(/^[a-z]:/, (m) => m.toUpperCase()))
  })

  test('drive letter is always upper-case', { skip: !win && 'windows drives' }, () => {
    assert.equal(canonicalDir('d:\\atrium'), 'D:\\atrium')
    assert.equal(canonicalDir('D:\\atrium'), 'D:\\atrium')
  })

  test('folder that does not exist: kept as given (absolute), only the drive letter fixed', () => {
    const missing = join(dirs.make(), 'nao-existe', 'sub')
    assert.equal(canonicalDir(missing), missing)
    if (win) {
      const lower = missing.replace(/^([A-Z]):/, (_m, d: string) => `${d.toLowerCase()}:`)
      assert.equal(canonicalDir(lower), missing)
    }
  })

  test('relative path becomes absolute', () => {
    assert.equal(canonicalDir('.'), canonicalDir(process.cwd()))
  })
})

describe('adapters launch in the canonical cwd', { skip: !win && 'case-sensitive filesystem' }, () => {
  const meta = (agent: SlotMeta['agent'], cwd: string): SlotMeta =>
    ({ v: 1, slotId: `${agent}-1`, agent, cwd, args: [], createdAt: '2026-10-29T00:00:00.000Z' })
  const bindingIn = (agent: Binding['agent'], cwd: string): Binding =>
    ({ slotId: `${agent}-1`, agent, sessionId: '0b6f1111-2222-4333-8444-555555555555', cwd, since: '2026-10-29T00:00:00.000Z', confirmed: true, ended: false })

  test('claude: new session in the slot cwd, resume in the binding cwd, both canonical', async () => {
    const home = dirs.make()
    const { onDisk, typed } = wrongCased()
    assert.equal((await claudeAdapter.plan({ slot: meta('claude', typed), home, extraArgs: [] })).cwd, onDisk)
    const other = wrongCased()
    const plan = await claudeAdapter.plan({ slot: meta('claude', typed), home, resume: bindingIn('claude', other.typed), extraArgs: [] })
    assert.equal(plan.cwd, other.onDisk)
  })

  test('soul: slot cwd, recipe cwd and bare-binding cwd are canonical', async () => {
    const home = dirs.make()
    const slot = wrongCased()
    assert.equal((await soulAdapter.plan({ slot: meta('soul', slot.typed), home, extraArgs: [] })).cwd, slot.onDisk)
    const recipe = wrongCased()
    const withRecipe: Binding = { ...bindingIn('soul', recipe.typed), resume: { cwd: recipe.typed, args: ['-r', 'sess-1'] } }
    assert.equal((await soulAdapter.plan({ slot: meta('soul', slot.typed), home, resume: withRecipe, extraArgs: [] })).cwd, recipe.onDisk)
    const bare = wrongCased()
    assert.equal((await soulAdapter.plan({ slot: meta('soul', slot.typed), home, resume: bindingIn('soul', bare.typed), extraArgs: [] })).cwd, bare.onDisk)
  })

  test('shell: slot cwd and the "resume here" cwd are canonical', async () => {
    const slot = wrongCased()
    assert.equal((await shellAdapter.plan({ slot: meta('shell', slot.typed) })).cwd, slot.onDisk)
    const here = wrongCased()
    assert.equal((await shellAdapter.plan({ slot: meta('shell', slot.typed), cwd: here.typed })).cwd, here.onDisk)
  })
})
