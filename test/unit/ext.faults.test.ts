// The faults extension without a window: its manifest (the feature, off by default and with an empty share folder that
// composes without a problem), the screen's rules (tabs, filters, what is "nova", the agent chooser and why each pane can
// or cannot take the command), the store's refresh discipline, and main's validation of what the renderer sends.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, describe, test } from 'node:test'
import type { Profile, SlotState } from '../../src/daemon/protocol.ts'
import type { FaultRow } from '../../src/core/faults-ops.ts'
import { declaredFeatures, enabledFeatures } from '../../src/core/features.ts'
import { composeShare } from '../../src/daemon/share.ts'
import { actionOf, investigateCwd, sourceRootOf } from '../../extensions/faults/main.ts'
import { manifest } from '../../extensions/faults/manifest.ts'
import { allTags, buildChooser, counts, featureOn, investigateCommand, isNew, newCount, returnedOf, shortFolder, sortRows, stackNote, statusSentence, turnState, visibleRows } from '../../extensions/faults/rules.ts'
import { FaultsStore } from '../../extensions/faults/store.ts'
import type { FaultsList } from '../../extensions/faults/ipc.ts'

const dirs: string[] = []
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'tether-extfaults-')); dirs.push(d); return d }
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const row = (over: Partial<FaultRow> = {}): FaultRow => ({
  id: 'a3f9', sig: 'a3f9'.padEnd(64, '0'), status: 'open', kind: 'load', proc: 'main', message: 'Cannot find module ./impl/format', count: 4,
  first: '2026-11-07T09:12:00.000Z', last: '2026-11-07T09:14:00.000Z', tags: [], version: '0.9.3', ...over,
})

describe('manifest', () => {
  test('declares the feature `faults` off by default, with a static share folder; the status icon, command and menu item', () => {
    const f = manifest.contributes!.features!.faults!
    assert.equal(f.default, false)
    assert.equal(f.title, 'Falhas do tether para o agente')
    assert.equal(f.share, 'share')
    assert.deepEqual(manifest.contributes!.commands!.map(c => c.command), ['faults.show'])
    assert.equal(manifest.contributes!.menus!.app![0]!.command, 'faults.show')
    assert.equal(manifest.contributes!.status![0]!.id, 'faults.status')
    assert.equal(declaredFeatures([manifest]).problems.length, 0)
  })

  test('the empty share folder exists, is enabled by a profile, and composes without a problem', () => {
    const share = resolve(import.meta.dirname, '../../extensions/faults/share')
    assert.ok(existsSync(share), 'git keeps the folder through a placeholder file')
    const { features } = declaredFeatures([manifest])
    assert.deepEqual(enabledFeatures(features, {}, undefined), [], 'off by default')
    assert.deepEqual(enabledFeatures(features, {}, { faults: true }), ['faults'])
    const home = tmp()
    const composed = composeShare(home, [{ id: 'faults', dir: share }])
    assert.deepEqual(composed.problems, [])
    assert.ok(existsSync(composed.dir))
    // Empty now: skills/ and mcps/ appear when the skills land; nothing here may throw or list a skill.
    assert.deepEqual(existsSync(join(composed.dir, 'skills')) ? readdirSync(join(composed.dir, 'skills')) : [], [])
  })
})

describe('list rules', () => {
  const rows = [
    row({ id: 'a3f9', sig: 'a'.repeat(64), tags: ['build'] }),
    row({ id: '1c07', sig: 'b'.repeat(64), status: 'investigating', proc: 'renderer', kind: 'uncaught', message: 'TypeError: reading cols', count: 37, last: '2026-11-07T08:00:00.000Z', tags: ['pty', 'windows'] }),
    row({ id: '7e2b', sig: 'c'.repeat(64), status: 'done', proc: 'ext:web-bridge', kind: 'gone', message: 'PTY exited 3221225477', count: 2, last: '2026-11-06T18:40:00.000Z' }),
    row({ id: '9d11', sig: 'd'.repeat(64), status: 'ignored', message: 'old noise', last: '2026-11-01T00:00:00.000Z' }),
  ]

  test('counts per status, and "all"', () => {
    assert.deepEqual(counts(rows), { open: 1, investigating: 1, done: 1, ignored: 1, all: 4 })
  })

  test('tab, search over id/message/tag/process (accents folded, every word), and tag filter', () => {
    const f = (over: object) => visibleRows(rows, { tab: 'all', query: '', tag: '', ...over }).map(r => r.id)
    assert.deepEqual(f({ tab: 'open' }), ['a3f9'])
    assert.deepEqual(f({}), ['a3f9', '1c07', '7e2b', '9d11'])
    assert.deepEqual(f({ query: 'RENDERER cols' }), ['1c07'])
    assert.deepEqual(f({ query: 'ext:web' }), ['7e2b'])
    assert.deepEqual(f({ query: '#pty' }), [])
    assert.deepEqual(f({ query: 'pty' }), ['1c07', '7e2b'])
    assert.deepEqual(f({ query: '7E2B' }), ['7e2b'])
    assert.deepEqual(f({ tag: 'windows' }), ['1c07'])
    assert.deepEqual(f({ tab: 'open', tag: 'windows' }), [])
    assert.deepEqual(allTags(rows), ['build', 'pty', 'windows'])
  })

  test('order: last occurrence first, or by count', () => {
    assert.deepEqual(sortRows(rows, 'last').map(r => r.id), ['a3f9', '1c07', '7e2b', '9d11'])
    assert.deepEqual(sortRows(rows, 'count').map(r => r.id), ['1c07', 'a3f9', '9d11', '7e2b'])
  })

  test('"nova": open and first seen (or back) after the last look; never looked = every open one', () => {
    const seen = '2026-11-07T09:00:00.000Z'
    assert.equal(isNew(row(), seen), true)
    assert.equal(isNew(row({ first: '2026-11-07T08:00:00.000Z' }), seen), false)
    assert.equal(isNew(row({ first: '2026-11-07T08:00:00.000Z', returned: { ts: '2026-11-07T09:30:00.000Z', version: '0.9.4' } }), seen), true)
    assert.equal(isNew(row({ status: 'investigating' }), seen), false)
    assert.equal(isNew(row(), null), true)
    assert.equal(newCount(rows, seen), 1)
    assert.equal(statusSentence(1), '1 falha nova no tether')
    assert.equal(statusSentence(3), '3 falhas novas no tether')
  })

  test('"voltou" always carries the version and the fix', () => {
    assert.equal(returnedOf(row()), undefined)
    assert.equal(returnedOf(row({ returned: { ts: 't', version: '0.9.4', fix: 'def4567890' } })), 'voltou na v0.9.4, depois do fix def4567')
    assert.equal(returnedOf(row({ returned: { ts: 't', version: '0.9.4' } })), 'voltou na v0.9.4')
  })

  test('the stack note appears for a bundle stack only, with the version', () => {
    assert.equal(stackNote('Error: x\n    at fn (D:\\x\\app\\dist\\main-app.cjs:10:5)', 'v0.9.3'), 'mostrando a stack do bundle: sem source map da v0.9.3')
    assert.equal(stackNote('Error: x\n    at fn (D:\\x\\app\\main\\settings.ts:41:5)', '0.9.3'), undefined)
    assert.equal(stackNote('', '0.9.3'), undefined)
  })
})

describe('the agent chooser', () => {
  const slot = (over: Partial<SlotState> & { slotId: string }): SlotState => ({ kind: 'claude', cwd: 'D:\\w', status: 'running', turn: 'idle', ...over })
  const profiles: Profile[] = [
    { id: 'claude', name: 'Claude', agent: 'claude', args: [], default: true },
    { id: 'claude-dev', name: 'Claude modo dev', agent: 'claude', args: [], features: { faults: true } },
    { id: 'soul', name: 'soul', agent: 'soul', args: ['-g'], default: true, features: { faults: true } },
  ]
  const base = { openPanes: new Set(['s1', 's2', 's3', 's4', 's5', 's6']), labelOf: (id: string) => `pane ${id}`, profiles, general: false, cwd: 'D:\\atrium\\workspace\\tether', agentLabel: (k: string) => k === 'claude' ? 'Claude' : 'soul' }

  test('idle with the feature on is selectable and first; busy, blocked, unknown say why in the row', () => {
    const slots = [
      slot({ slotId: 's1', turn: 'busy', profileId: 'claude-dev' }),
      slot({ slotId: 's2', turn: undefined, profileId: 'claude-dev' }),
      slot({ slotId: 's3', turn: 'idle', profileId: 'claude-dev' }),
      slot({ slotId: 's4', turn: 'blocked', profileId: 'claude-dev' }),
    ]
    const c = buildChooser({ ...base, slots })
    assert.equal(c.selected, 'pane:s3')
    assert.deepEqual(c.choices.slice(0, 4).map(x => [x.slotId, x.enabled, x.state]), [['s3', true, 'livre'], ['s1', false, 'trabalhando'], ['s2', false, 'não sei se está livre'], ['s4', false, 'esperando uma resposta sua']])
    assert.equal(c.choices[1]!.reason, 'trabalhando')
    assert.equal(c.choices[2]!.reason, 'não sei se está livre')
  })

  test('a pane whose profile has the feature off is disabled with the reason and a "Ligar" link; the general switch is the default', () => {
    const slots = [slot({ slotId: 's1', turn: 'idle', profileId: 'claude' }), slot({ slotId: 's2', turn: 'idle' })]
    const off = buildChooser({ ...base, slots })
    assert.deepEqual(off.choices.slice(0, 2).map(x => [x.slotId, x.enabled, x.reason]), [['s1', false, 'feature faults desligada neste perfil'], ['s2', false, 'feature faults desligada neste perfil']])
    assert.deepEqual(off.choices[0]!.link, { text: 'Ligar', profileId: 'claude' })
    assert.equal(off.choices[1]!.link, undefined, 'no profile, nothing to open')
    const on = buildChooser({ ...base, slots, general: true })
    assert.deepEqual(on.choices.slice(0, 2).map(x => x.enabled), [true, true])
    assert.equal(on.selected, 'pane:s1')
  })

  test('shells, closed panes and stopped agents never take the command', () => {
    const slots = [slot({ slotId: 's1', kind: 'shell' }), slot({ slotId: 'zz', profileId: 'claude-dev' }), slot({ slotId: 's2', status: 'exited', turn: undefined, profileId: 'claude-dev' }), slot({ slotId: 's3', status: 'starting', turn: undefined, profileId: 'claude-dev' })]
    const c = buildChooser({ ...base, slots })
    assert.deepEqual(c.choices.filter(x => x.kind === 'pane').map(x => [x.slotId, x.state, x.enabled]), [['s2', 'parado', false], ['s3', 'iniciando', false]])
  })

  test('"Novo painel" rows: one per agent default profile, preselected when no pane is idle, disabled when the default profile has the feature off', () => {
    const none = buildChooser({ ...base, slots: [slot({ slotId: 's1', turn: 'busy', profileId: 'claude-dev' })] })
    const news = none.choices.filter(x => x.kind === 'new')
    assert.deepEqual(news.map(x => [x.profileId, x.enabled, x.label]), [['claude', false, 'Novo painel Claude em workspace/tether'], ['soul', true, 'Novo painel soul em workspace/tether']])
    assert.deepEqual(news[0]!.link, { text: 'Ligar', profileId: 'claude' })
    assert.equal(none.selected, 'new:soul')
    const allOn = buildChooser({ ...base, general: true, slots: [] })
    assert.equal(allOn.selected, 'new:claude')
  })

  test('turnState and featureOn', () => {
    assert.deepEqual(turnState(slot({ slotId: 'x', turn: 'idle' })), { state: 'livre', enabled: true })
    assert.deepEqual(turnState(slot({ slotId: 'x', status: 'queued', turn: undefined })), { state: 'iniciando', enabled: false })
    assert.equal(featureOn(undefined, true), true)
    assert.equal(featureOn({ features: { faults: false } }, true), false)
    assert.equal(featureOn({ features: { bridge: true } }, false), false)
    assert.equal(shortFolder('D:\\atrium\\workspace\\tether'), 'workspace/tether')
    assert.equal(investigateCommand('a3f9'), '/tether-fault-investigate a3f9')
  })
})

describe('store', () => {
  const info = (n: number): FaultsList => ({ ok: true, rows: [row({ count: n })], skipped: 0, dir: 'x', build: { version: '1' }, seenAt: null, cwd: 'y' })

  test('refreshes never overlap: a request during a read runs one more read after it', async () => {
    let calls = 0, concurrent = 0, peak = 0
    const gates: Array<() => void> = []
    const store = new FaultsStore({
      list: async () => {
        calls++; concurrent++; peak = Math.max(peak, concurrent)
        await new Promise<void>(r => gates.push(r))
        concurrent--
        return info(calls)
      },
    })
    let notified = 0
    store.onDidChange(() => notified++)
    const first = store.refresh()
    const second = store.refresh()
    const third = store.refresh()
    assert.equal(calls, 1)
    gates.shift()!()
    await new Promise(r => setTimeout(r, 10))
    assert.equal(calls, 2, 'one more read, however many requests came in')
    gates.shift()!()
    await Promise.all([first, second, third])
    assert.equal(peak, 1)
    assert.equal(notified, 2)
    assert.equal(store.rows[0]!.count, 2)
    assert.equal(store.loaded, true)
  })

  test('a failed read keeps the last good rows and says why', async () => {
    let fail = false
    const store = new FaultsStore({ list: async () => (fail ? { ok: false as const, message: 'EPERM' } : info(1)) })
    await store.refresh()
    fail = true
    await store.refresh()
    assert.equal(store.error, 'EPERM')
    assert.equal(store.rows.length, 1)
    fail = false
    await store.refresh()
    assert.equal(store.error, undefined)
  })
})

describe('main', () => {
  test('actionOf validates what the renderer sends', () => {
    assert.deepEqual(actionOf({ type: 'ignore' }), { type: 'ignore' })
    assert.deepEqual(actionOf({ type: 'done', fix: ' def4567 ' }), { type: 'done', by: 'você', fix: 'def4567' })
    assert.deepEqual(actionOf({ type: 'done' }), { type: 'done', by: 'você' })
    assert.deepEqual(actionOf({ type: 'tag', tags: ['a', 'b'], remove: true }), { type: 'tag', tags: ['a', 'b'], remove: true })
    assert.deepEqual(actionOf({ type: 'note', text: 'oi' }), { type: 'note', author: 'você', text: 'oi' })
    for (const bad of [null, 'x', {}, { type: 'rm' }, { type: 'tag', tags: [] }, { type: 'tag', tags: [1] }, { type: 'note', text: '   ' }, { type: 'note', text: 'x'.repeat(9000) }]) {
      assert.equal(typeof actionOf(bad), 'string', JSON.stringify(bad))
    }
  })

  test('the new pane opens in the setting, else the tether source folder, else the user\'s folder', () => {
    const root = tmp()
    const dist = join(root, 'app', 'dist')
    mkdirSync(dist, { recursive: true })
    const home = tmp()
    assert.equal(sourceRootOf(dist), undefined, 'no package.json')
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'other' }))
    assert.equal(sourceRootOf(dist), undefined, 'not the tether checkout')
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'tether' }))
    assert.equal(sourceRootOf(dist), root)
    assert.equal(investigateCwd('', dist, home), root)
    assert.equal(investigateCwd(undefined, dist, home), root)
    const elsewhere = tmp()
    assert.equal(investigateCwd(elsewhere, dist, home), elsewhere)
    assert.equal(investigateCwd(join(elsewhere, 'missing'), dist, home), root, 'a setting that points nowhere falls back')
    rmSync(join(root, 'package.json'))
    assert.equal(investigateCwd('', dist, home), home)
  })
})
