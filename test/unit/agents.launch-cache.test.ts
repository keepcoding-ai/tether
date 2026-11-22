// The caches on the launch path (E2.6): a hit costs a stat, a change on disk (mtime/size/PATH) is seen at once, and the answer
// is the one the uncached code gave.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureSettingsFile } from '../../src/agents/claude.ts'
import { SkillsCache } from '../../src/agents/skills.ts'
import { createExecutor } from '../../src/exec/executor.ts'
import { clearClaudeResolveCache, clearSoulResolveCache, materializeSkills, resolveClaudeCommand, resolveCodexCommand, resolveSoulCommand, userNotify } from '../../src/exec/ops-agents.ts'
import { ENV_SOUL_CMD } from '../../src/agents/soul.ts'

const inline = createExecutor({ mode: 'inline' })
import { readUserSettings } from '../../src/core/user-settings-sync.ts'
import { ensureRenamedNode } from '../../src/core/exe-sync.ts'

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

test('ensureSettingsFile: one write, then stat-only; a changed or deleted file is rewritten', async () => {
  const home = tmp()
  const file = await ensureSettingsFile(home, inline)
  const text = readFileSync(file, 'utf8')
  const m1 = statSync(file).mtimeMs
  assert.equal(await ensureSettingsFile(home, inline), file)
  assert.equal(statSync(file).mtimeMs, m1)
  writeFileSync(file, '{"tampered":true}\n')
  await ensureSettingsFile(home, inline)
  assert.equal(readFileSync(file, 'utf8'), text)
  rmSync(file)
  await ensureSettingsFile(home, inline)
  assert.equal(readFileSync(file, 'utf8'), text)
  assert.ok('statusLine' in JSON.parse(readFileSync(file, 'utf8')))
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
    const s1 = await cache.get(inline)
    assert.equal(s1.skills.length, 1)
    assert.equal(await cache.get(inline), s1, 'same snapshot object: nothing was read')
    writeFileSync(skill, '---\nname: one\ndescription: second, longer\n---\nbody')
    const deadline = Date.now() + 5000
    while ((await cache.get(inline)) === s1 && Date.now() < deadline) await new Promise(r => setTimeout(r, 25))
    const s2 = await cache.get(inline)
    assert.notEqual(s2, s1)
    assert.equal(s2.skills[0]!.description, 'second, longer')
    assert.notEqual(s2.version, s1.version)
  } finally { cache.dispose() }
  const noWatch = new SkillsCache(lib, () => {}, (() => { throw new Error('no watcher') }) as never)
  assert.notEqual(await noWatch.get(inline), await noWatch.get(inline), 'without a watcher every get reads')
})

test('materializeSkills: a verified stamp is trusted by stat; a changed stamp or a removed target is rebuilt', () => {
  const root = tmp()
  const lib = join(root, 'lib', 'a')
  mkdirSync(lib, { recursive: true })
  writeFileSync(join(lib, 'SKILL.md'), 'x')
  const target = join(root, 'skills', 'x')
  const spec = { target, version: 'v1', layout: 'shared' as const, skills: [{ name: 'a', dir: lib }] }
  const built = (): number => statSync(join(target, 'skills', 'a', 'SKILL.md')).ino
  materializeSkills(spec); const first = built()
  materializeSkills(spec); assert.equal(built(), first, 'a verified stamp is not rebuilt')
  writeFileSync(join(target, '.tether-version'), 'other-version')
  materializeSkills(spec); assert.equal(readFileSync(join(target, '.tether-version'), 'utf8'), 'v1')
  rmSync(target, { recursive: true })
  materializeSkills(spec); assert.ok(readFileSync(join(target, 'skills', 'a', 'SKILL.md'), 'utf8') === 'x')
  materializeSkills({ ...spec, version: 'v2' }); assert.equal(readFileSync(join(target, '.tether-version'), 'utf8'), 'v2')
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
