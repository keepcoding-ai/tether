// The caches on the launch path (E2.6): a hit costs a stat, a change on disk (mtime/size/PATH) is seen at once, and the answer
// is the one the uncached code gave.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { clearClaudeResolveCache, ensureSettingsFile, resolveClaudeCommand, userHasStatusLine } from '../../src/agents/claude.ts'
import { SkillsCache, materialize } from '../../src/agents/skills.ts'
import { readUserSettings } from '../../src/core/user-settings.ts'
import { ensureRenamedNode } from '../../src/core/exe.ts'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'launch-cache-'))
const bump = (file: string, ms: number): void => { const t = new Date(Date.now() + ms); utimesSync(file, t, t) }
const claudeName = process.platform === 'win32' ? 'claude.exe' : 'claude'
const makeClaude = (dir: string): string => {
  const bin = join(dir, claudeName)
  writeFileSync(bin, 'x')
  if (process.platform !== 'win32') chmodSync(bin, 0o755)
  return bin
}

test('resolveClaudeCommand: memoized per PATH, dropped when the binary goes, a changed PATH is another key', () => {
  clearClaudeResolveCache()
  const a = tmp(), b = tmp()
  const inB = makeClaude(b)
  const env = { PATH: [a, b].join(delimiter), SHELL: '' }
  const first = resolveClaudeCommand(env)
  assert.equal(first, inB)
  assert.equal(resolveClaudeCommand(env), first)
  // The binary vanishes: the stat no longer matches and the walk runs again (bare name when nothing is left).
  rmSync(inB)
  assert.equal(resolveClaudeCommand(env), 'claude')
  // A claude appears: the answer is the walk's, as before the cache.
  const inA = makeClaude(a)
  assert.equal(resolveClaudeCommand(env), inA)
  assert.equal(resolveClaudeCommand({ PATH: b, SHELL: '' }), 'claude')
})

test('resolveClaudeCommand: a touched binary is re-resolved; injected seams bypass the cache', () => {
  clearClaudeResolveCache()
  const a = tmp()
  const bin = makeClaude(a)
  const env = { PATH: a, SHELL: '' }
  assert.equal(resolveClaudeCommand(env), bin)
  bump(bin, 5000)
  assert.equal(resolveClaudeCommand(env), bin)
  let calls = 0
  const exists = (p: string): boolean => { calls++; return p === bin }
  resolveClaudeCommand(env, { exists }); resolveClaudeCommand(env, { exists })
  assert.ok(calls >= 2, 'a test double is asked every time')
})

test('ensureSettingsFile: one write, then stat-only; a changed or deleted file is rewritten', () => {
  const home = tmp()
  const file = ensureSettingsFile(home)
  const text = readFileSync(file, 'utf8')
  const m1 = statSync(file).mtimeMs
  assert.equal(ensureSettingsFile(home), file)
  assert.equal(statSync(file).mtimeMs, m1)
  writeFileSync(file, '{"tampered":true}\n')
  ensureSettingsFile(home)
  assert.equal(readFileSync(file, 'utf8'), text)
  rmSync(file)
  ensureSettingsFile(home)
  assert.equal(readFileSync(file, 'utf8'), text)
  const bare = ensureSettingsFile(home, false)
  assert.notEqual(bare, file)
  assert.ok(!('statusLine' in JSON.parse(readFileSync(bare, 'utf8'))))
})

test('userHasStatusLine: parsed once per file version; edits, deletion and the injected reader are honoured', () => {
  const cfg = tmp(), cwd = tmp()
  assert.equal(userHasStatusLine(cwd, cfg), false)
  writeFileSync(join(cfg, 'settings.json'), '{"statusLine":{"type":"command","command":"x"}}')
  assert.equal(userHasStatusLine(cwd, cfg), true)
  assert.equal(userHasStatusLine(cwd, cfg), true)
  writeFileSync(join(cfg, 'settings.json'), '{}')
  assert.equal(userHasStatusLine(cwd, cfg), false)
  mkdirSync(join(cwd, '.claude'))
  writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{"statusLine":{}}')
  assert.equal(userHasStatusLine(cwd, cfg), true)
  rmSync(join(cwd, '.claude', 'settings.local.json'))
  assert.equal(userHasStatusLine(cwd, cfg), false)
  assert.equal(userHasStatusLine(cwd, cfg, () => '{"statusLine":1}'), true)
})

test('readUserSettings: an unchanged file is served from memory, a rewrite or removal shows at once', () => {
  const home = tmp()
  assert.deepEqual(readUserSettings(home), {})
  const file = join(home, 'settings.json')
  writeFileSync(file, '{"a":{"b":1}}')
  const v1 = readUserSettings(home)
  assert.deepEqual(v1, { a: { b: 1 } })
  assert.equal(readUserSettings(home), v1)
  writeFileSync(file, '{"a":{"b":22}}')
  assert.deepEqual(readUserSettings(home), { a: { b: 22 } })
  writeFileSync(file, '{"a":{"b":33}}') // same size: only the mtime tells
  bump(file, 3000)
  assert.deepEqual(readUserSettings(home), { a: { b: 33 } })
  rmSync(file)
  assert.deepEqual(readUserSettings(home), {})
})

test('SkillsCache: one read while nothing changes, a fresh one after a change under the library, uncached without a watcher', async () => {
  const lib = tmp()
  mkdirSync(join(lib, 'one'))
  const skill = join(lib, 'one', 'SKILL.md')
  writeFileSync(skill, '---\nname: one\ndescription: first\n---\nbody')
  const cache = new SkillsCache(lib)
  try {
    const s1 = cache.get()
    assert.equal(s1.skills.length, 1)
    assert.equal(cache.get(), s1, 'same snapshot object: nothing was read')
    writeFileSync(skill, '---\nname: one\ndescription: second, longer\n---\nbody')
    const deadline = Date.now() + 5000
    while (cache.get() === s1 && Date.now() < deadline) await new Promise(r => setTimeout(r, 25))
    const s2 = cache.get()
    assert.notEqual(s2, s1)
    assert.equal(s2.skills[0]!.description, 'second, longer')
    assert.notEqual(s2.version, s1.version)
  } finally { cache.dispose() }
  const noWatch = new SkillsCache(lib, () => {}, (() => { throw new Error('no watcher') }) as never)
  assert.notEqual(noWatch.get(), noWatch.get(), 'without a watcher every get reads')
})

test('materialize: a verified stamp is trusted by stat; a changed stamp or a removed target is rebuilt', () => {
  const root = tmp()
  const target = join(root, 'skills', 'x')
  let builds = 0
  const bundle = { skills: [], home: root, version: 'v1' }
  const build = (dir: string): void => { builds++; writeFileSync(join(dir, 'f'), 'x') }
  materialize(target, bundle, build); assert.equal(builds, 1)
  materialize(target, bundle, build); assert.equal(builds, 1)
  writeFileSync(join(target, '.tether-version'), 'other-version')
  materialize(target, bundle, build); assert.equal(builds, 2)
  materialize(target, bundle, build); assert.equal(builds, 2)
  rmSync(target, { recursive: true })
  materialize(target, bundle, build); assert.equal(builds, 3)
  materialize(target, { ...bundle, version: 'v2' }, build); assert.equal(builds, 4)
})

test('ensureRenamedNode: the second call is a hit that equals the first; a changed source or a deleted copy is remade', { skip: process.platform === 'darwin' }, () => {
  const home = tmp()
  const source = join(tmp(), process.platform === 'win32' ? 'node.exe' : 'node')
  writeFileSync(source, 'binary-1')
  const logs: string[] = []
  const log = (m: string): void => { logs.push(m) }
  const r1 = ensureRenamedNode(home, 'tether-soul', source, log)
  assert.equal(r1.state, 'fresh')
  const r2 = ensureRenamedNode(home, 'tether-soul', source, log)
  assert.equal(r2.state, 'current')
  assert.equal(r2.path, r1.path)
  assert.equal(r2.method, r1.method)
  const n = logs.length
  ensureRenamedNode(home, 'tether-soul', source, log)
  assert.equal(logs.length, n, 'a hit logs nothing')
  writeFileSync(source, 'binary-two-longer')
  const r3 = ensureRenamedNode(home, 'tether-soul', source, log)
  assert.equal(r3.state, 'fresh')
  assert.equal(readFileSync(r3.path, 'utf8'), 'binary-two-longer')
  rmSync(r3.path)
  const r4 = ensureRenamedNode(home, 'tether-soul', source, log)
  assert.equal(r4.state, 'fresh')
  assert.equal(readFileSync(r4.path, 'utf8'), 'binary-two-longer')
})

test('userNotify: parsed once per file version, edits and deletion are seen', async () => {
  const { userNotify } = await import('../../src/agents/codex.ts')
  const home = tmp()
  assert.equal(userNotify(home), undefined)
  const file = join(home, 'config.toml')
  writeFileSync(file, 'notify = ["a", "b"]\n')
  assert.deepEqual(userNotify(home), ['a', 'b'])
  assert.deepEqual(userNotify(home), ['a', 'b'])
  writeFileSync(file, 'notify = ["a", "bcd"]\n')
  assert.deepEqual(userNotify(home), ['a', 'bcd'])
  rmSync(file)
  assert.equal(userNotify(home), undefined)
})

test('resolveCodexCommand and resolveSoulCommand: the memoized answer follows the file system', async () => {
  const { resolveCodexCommand } = await import('../../src/agents/codex.ts')
  const { resolveSoulCommand, clearSoulResolveCache, ENV_SOUL_CMD } = await import('../../src/agents/soul.ts')
  const a = tmp()
  const exe = process.platform === 'win32' ? '.exe' : ''
  const codex = join(a, `codex${exe}`)
  writeFileSync(codex, 'x'); if (process.platform !== 'win32') chmodSync(codex, 0o755)
  const env = { PATH: a }
  if (process.platform !== 'win32') {
    assert.equal(resolveCodexCommand(env).command, codex)
    assert.equal(resolveCodexCommand(env).command, codex)
    rmSync(codex)
    assert.equal(resolveCodexCommand(env).command, 'codex')
  } else {
    assert.equal(resolveCodexCommand(env).command, codex)
    rmSync(codex)
    assert.equal(resolveCodexCommand(env).command, 'codex')
  }
  clearSoulResolveCache()
  const soul = join(a, `soul${exe}`)
  writeFileSync(soul, 'x'); if (process.platform !== 'win32') chmodSync(soul, 0o755)
  const senv = { PATH: a, [ENV_SOUL_CMD]: `${soul}` }
  assert.equal(resolveSoulCommand(senv).command, soul)
  assert.equal(resolveSoulCommand(senv).command, soul)
  rmSync(soul)
  assert.equal(resolveSoulCommand(senv).command, soul) // a named command is returned as written, as before
})
