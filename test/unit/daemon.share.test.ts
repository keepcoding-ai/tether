// The composed share folder (src/daemon/share.ts): <home>/share/<signature>/ links each enabled feature's skills and
// copies each MCP connection into a real folder (soul-sdk skips a junction under mcps/), the same set reuses the same
// folder and only brings it up to date, a failed link falls back to a copy, and the cleanup at tetherd start removes the
// folders. The safety rule above all: removing a junction (or a whole composed folder) never touches what it points at.
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { cleanShares, composeShare, linkDir, removeTree, shareRootOf, signatureOf, unlinkLink } from '../../src/daemon/share.ts'
import { removeHome, tempHome } from './daemon.helpers.ts'

let root: string
let home: string
let bridge: string
let faults: string

/** A feature folder: skills/<name>/SKILL.md and mcps/<slug>/{mcp.json, skills/<s>/SKILL.md}. */
function feature(dir: string, skills: string[], mcps: Record<string, string[]>): string {
  for (const s of skills) { mkdirSync(join(dir, 'skills', s), { recursive: true }); writeFileSync(join(dir, 'skills', s, 'SKILL.md'), `---\nname: ${s}\n---\n${s}\n`) }
  for (const [slug, own] of Object.entries(mcps)) {
    mkdirSync(join(dir, 'mcps', slug), { recursive: true })
    writeFileSync(join(dir, 'mcps', slug, 'mcp.json'), JSON.stringify({ mcpServers: { [slug]: { type: 'stdio', command: 'node', args: [slug] } } }))
    for (const s of own) { mkdirSync(join(dir, 'mcps', slug, 'skills', s), { recursive: true }); writeFileSync(join(dir, 'mcps', slug, 'skills', s, 'SKILL.md'), s) }
  }
  return dir
}

before(() => {
  root = tempHome()
  home = join(root, 'home')
  mkdirSync(home)
  bridge = feature(join(root, 'src-bridge'), [], { 'tether-bridge': ['browse'] })
  faults = feature(join(root, 'src-faults'), ['tether-faults', 'tether-fault'], {})
})
after(async () => { cleanShares(home); await removeHome(root) })

describe('removing never follows a link', () => {
  test('unlinkLink and removeTree on a junction leave the target and its files intact', () => {
    const target = join(root, 'precious')
    mkdirSync(join(target, 'deep'), { recursive: true })
    writeFileSync(join(target, 'deep', 'keep.txt'), 'keep')
    const link = join(root, 'link-a')
    linkDir(target, link)
    assert.ok(lstatSync(link).isSymbolicLink(), 'a junction/symlink')
    assert.ok(existsSync(join(link, 'deep', 'keep.txt')), 'reachable through the link')
    unlinkLink(link)
    assert.ok(!existsSync(link))
    assert.equal(readFileSync(join(target, 'deep', 'keep.txt'), 'utf8'), 'keep')

    // A real folder holding a junction: the folder goes, the junction's target stays whole.
    const holder = join(root, 'holder')
    mkdirSync(join(holder, 'inner'), { recursive: true })
    writeFileSync(join(holder, 'inner', 'own.txt'), 'mine')
    linkDir(target, join(holder, 'inner', 'to-precious'))
    removeTree(holder)
    assert.ok(!existsSync(holder))
    assert.deepEqual(readdirSync(join(target, 'deep')), ['keep.txt'])
  })
})

describe('signature', () => {
  test('sorted ids joined by +, the same set the same name; long sets hash', () => {
    assert.equal(signatureOf(['faults', 'bridge']), 'bridge+faults')
    assert.equal(signatureOf(['bridge', 'faults']), signatureOf(['faults', 'bridge', 'bridge']))
    const long = signatureOf(Array.from({ length: 10 }, (_, i) => `feature-${i}`))
    assert.match(long, /^set-[0-9a-f]{12}$/)
  })
})

describe('composeShare', () => {
  test('skills are junctions to the sources, each MCP a real folder with its files copied and its skills linked', () => {
    const r = composeShare(home, [{ id: 'faults', dir: faults }, { id: 'bridge', dir: bridge }])
    assert.equal(r.dir, join(shareRootOf(home), 'bridge+faults'))
    assert.deepEqual(r.problems, [])
    assert.deepEqual(readdirSync(join(r.dir, 'skills')).sort(), ['tether-fault', 'tether-faults'])
    for (const s of ['tether-fault', 'tether-faults']) {
      const p = join(r.dir, 'skills', s)
      assert.ok(lstatSync(p).isSymbolicLink(), `${s} is a link`)
      assert.equal(realpathSync(p).toLowerCase(), realpathSync(join(faults, 'skills', s)).toLowerCase())
    }
    const mcp = join(r.dir, 'mcps', 'tether-bridge')
    assert.ok(lstatSync(mcp).isDirectory() && !lstatSync(mcp).isSymbolicLink(), 'mcps/<slug> is a real folder (soul-sdk lists them by Dirent.isDirectory)')
    const dirent = readdirSync(join(r.dir, 'mcps'), { withFileTypes: true })[0]!
    assert.ok(dirent.isDirectory(), 'what soul-sdk sees')
    assert.equal(readFileSync(join(mcp, 'mcp.json'), 'utf8'), readFileSync(join(bridge, 'mcps', 'tether-bridge', 'mcp.json'), 'utf8'))
    assert.ok(lstatSync(join(mcp, 'skills')).isSymbolicLink(), "the MCP's own skills are linked")
    assert.ok(existsSync(join(mcp, 'skills', 'browse', 'SKILL.md')))
    assert.ok(r.linked >= 3 && r.copied === 1, `linked ${r.linked}, copied ${r.copied}`)
  })

  test('the same set reuses the folder: nothing redone when nothing changed; a changed mcp.json is copied again', () => {
    const again = composeShare(home, [{ id: 'bridge', dir: bridge }, { id: 'faults', dir: faults }])
    assert.equal(again.dir, join(shareRootOf(home), 'bridge+faults'))
    assert.equal(again.linked, 0); assert.equal(again.copied, 0)
    const spec = join(bridge, 'mcps', 'tether-bridge', 'mcp.json')
    writeFileSync(spec, JSON.stringify({ mcpServers: { 'tether-bridge': { type: 'stdio', command: 'node', args: ['v2'] } } }))
    const third = composeShare(home, [{ id: 'bridge', dir: bridge }, { id: 'faults', dir: faults }])
    assert.equal(third.copied, 1); assert.equal(third.linked, 0)
    assert.match(readFileSync(join(third.dir, 'mcps', 'tether-bridge', 'mcp.json'), 'utf8'), /v2/)
  })

  test('another set gets its own folder; entries a source no longer has are removed (sources untouched)', () => {
    const only = composeShare(home, [{ id: 'bridge', dir: bridge }])
    assert.equal(only.dir, join(shareRootOf(home), 'bridge'))
    assert.deepEqual(readdirSync(join(only.dir, 'skills')), [])
    // A skill vanishes from the source and a stray entry appears: both reconciled away.
    const extra = feature(join(root, 'src-extra'), ['one', 'two'], {})
    composeShare(home, [{ id: 'extra', dir: extra }])
    removeTree(join(extra, 'skills', 'two'))
    writeFileSync(join(shareRootOf(home), 'extra', 'skills', 'stray.txt'), 'x')
    const r = composeShare(home, [{ id: 'extra', dir: extra }])
    assert.deepEqual(readdirSync(join(r.dir, 'skills')), ['one'])
    assert.ok(existsSync(join(extra, 'skills', 'one', 'SKILL.md')))
  })

  test('a name offered twice: the first feature (id order) keeps it, the clash is said', () => {
    const a = feature(join(root, 'src-a'), ['same'], {})
    const b = feature(join(root, 'src-b'), ['same'], {})
    const r = composeShare(home, [{ id: 'bbb', dir: b }, { id: 'aaa', dir: a }])
    assert.equal(realpathSync(join(r.dir, 'skills', 'same')).toLowerCase(), realpathSync(join(a, 'skills', 'same')).toLowerCase())
    assert.equal(r.problems.length, 1); assert.match(r.problems[0]!, /same.*bbb.*aaa/)
  })

  test('a link that fails becomes a copy', () => {
    const r = composeShare(home, [{ id: 'copyme', dir: faults }], { link: () => { throw new Error('EPERM') } })
    const p = join(r.dir, 'skills', 'tether-faults')
    assert.ok(!lstatSync(p).isSymbolicLink() && lstatSync(p).isDirectory())
    assert.ok(existsSync(join(p, 'SKILL.md')))
    assert.ok(r.copied >= 2)
  })

  test('a link pointing elsewhere is replaced', () => {
    const dir = composeShare(home, [{ id: 'faults', dir: faults }]).dir
    const p = join(dir, 'skills', 'tether-fault')
    unlinkLink(p)
    linkDir(join(faults, 'skills', 'tether-faults'), p)
    const r = composeShare(home, [{ id: 'faults', dir: faults }])
    assert.equal(r.linked, 1)
    assert.equal(realpathSync(p).toLowerCase(), realpathSync(join(faults, 'skills', 'tether-fault')).toLowerCase())
    assert.ok(readlinkSync(p))
  })
})

describe('cleanShares (tetherd start)', () => {
  test('every composed folder goes; every source keeps its files', () => {
    composeShare(home, [{ id: 'bridge', dir: bridge }, { id: 'faults', dir: faults }])
    const removed = cleanShares(home)
    assert.ok(removed.includes('bridge+faults') && removed.includes('bridge'))
    assert.deepEqual(readdirSync(shareRootOf(home)), [])
    assert.ok(existsSync(join(faults, 'skills', 'tether-faults', 'SKILL.md')))
    assert.ok(existsSync(join(faults, 'skills', 'tether-fault', 'SKILL.md')))
    assert.ok(existsSync(join(bridge, 'mcps', 'tether-bridge', 'mcp.json')))
    assert.ok(existsSync(join(bridge, 'mcps', 'tether-bridge', 'skills', 'browse', 'SKILL.md')))
    assert.deepEqual(cleanShares(join(root, 'no-such-home')), [])
  })
})
