// The explorer's disk watching (F8 slice 3): the pure rules (VS Code's event coalescer, watcherExclude, the folders a burst touches)
// and the main-side registry with a fake `fs.watch` (one handle per root, per expanded folder on Linux, one message per burst,
// handles released when a root leaves, failures reported).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { ExplorerWatchers, type WatchFn, type WatchHandle, type WatchSink } from '../../extensions/explorer/watchers.ts'
import { affectedDirs, coalesceEvents, isIgnoredChange, matchesExclude, type FileChange } from '../../extensions/explorer/watch-rules.ts'

const add = (path: string): FileChange => ({ type: 'added', path })
const del = (path: string): FileChange => ({ type: 'deleted', path })
const upd = (path: string): FileChange => ({ type: 'updated', path })
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

describe('event coalescing (VS Code EventCoalescer)', () => {
  test('create followed by delete leaves nothing', () => {
    assert.deepEqual(coalesceEvents([add('C:\\p\\tmp.txt'), del('C:\\p\\tmp.txt')], true), [])
    assert.deepEqual(affectedDirs(coalesceEvents([add('/p/tmp'), del('/p/tmp')], false), false), [])
  })

  test('delete followed by create is an update (an atomic save) and touches no listing', () => {
    const out = coalesceEvents([del('/p/a.txt'), add('/p/a.txt')], false)
    assert.deepEqual(out, [upd('/p/a.txt')])
    assert.deepEqual(affectedDirs(out, false), [])
  })

  test('create then update stays a create; update then delete is a delete', () => {
    assert.deepEqual(coalesceEvents([add('/p/a'), upd('/p/a')], false), [add('/p/a')])
    assert.deepEqual(coalesceEvents([upd('/p/a'), del('/p/a')], false), [del('/p/a')])
  })

  test('many changes in one folder are one affected folder', () => {
    const burst: FileChange[] = []
    for (let i = 0; i < 500; i++) burst.push(add(`/p/src/f${i}.ts`))
    assert.equal(coalesceEvents(burst, false).length, 500)
    assert.deepEqual(affectedDirs(coalesceEvents(burst, false), false), ['/p/src'])
  })

  test('a rename is a delete and an add: the folder once; moved between folders: both', () => {
    assert.deepEqual(affectedDirs(coalesceEvents([del('C:\\p\\old.txt'), add('C:\\p\\new.txt')], true), true), ['C:\\p'])
    assert.deepEqual(affectedDirs(coalesceEvents([del('/p/a/x'), add('/p/b/x')], false), false).sort(), ['/p/a', '/p/b'])
  })

  test('a deleted folder drops the deletes of everything below it', () => {
    const out = coalesceEvents([del('/p/d/a'), del('/p/d/sub/b'), del('/p/d'), add('/p/e')], false)
    assert.deepEqual(out.map(e => `${e.type}:${e.path}`), ['deleted:/p/d', 'added:/p/e'])
    assert.deepEqual(affectedDirs(out, false).sort(), ['/p'])
  })

  test('case: a rename to another case keeps both events where the system ignores case; the key is the lowercase path', () => {
    const out = coalesceEvents([del('C:\\p\\Readme.md'), add('C:\\p\\README.md')], true)
    assert.deepEqual(out.map(e => e.type).sort(), ['added', 'deleted'])
    assert.equal(coalesceEvents([add('/p/A'), del('/p/a')], false).length, 2, 'two different files on a case-sensitive system')
  })

  test('the caller\'s events are not mutated', () => {
    const input = [del('/p/a'), add('/p/a')]
    coalesceEvents(input, false)
    assert.deepEqual(input, [del('/p/a'), add('/p/a')])
  })
})

describe('watcherExclude', () => {
  const ign = (path: string): boolean => isIgnoredChange('/p', path, false)

  test('VS Code defaults: git objects, subtree cache, hg store', () => {
    assert.ok(ign('/p/.git/objects/ab/cdef'))
    assert.ok(ign('/p/sub/.git/objects/ab'))
    assert.ok(ign('/p/.git/subtree-cache/x'))
    assert.ok(ign('/p/.hg/store/data/x'))
    assert.ok(!ign('/p/src/objects/x.ts'))
  })

  test('inside a package of node_modules is ignored; the package folder itself and node_modules are not', () => {
    assert.ok(ign('/p/node_modules/pkg/index.js'))
    assert.ok(ign('/p/node_modules/@scope/pkg/lib/a.js'))
    assert.ok(ign('/p/web/node_modules/pkg/x'))
    assert.ok(!ign('/p/node_modules/pkg'), 'a new package shows in an expanded node_modules')
    assert.ok(!ign('/p/node_modules'))
  })

  test('names the tree never lists change no listing (.git, Thumbs.db)', () => {
    assert.ok(ign('/p/.git/HEAD'))
    assert.ok(ign('/p/.git'))
    assert.ok(ign('/p/src/Thumbs.db'))
    assert.ok(!ign('/p/src/a.ts'))
  })

  test('the project path itself is never matched: a project inside a node_modules folder still watches', () => {
    assert.equal(isIgnoredChange('/x/node_modules/pkg/proj', '/x/node_modules/pkg/proj/src/a.ts', false), false)
  })

  test('case-insensitive matching and the matcher alone', () => {
    assert.ok(isIgnoredChange('C:\\p', 'C:\\p\\Node_Modules\\pkg\\a.js', true))
    assert.ok(!isIgnoredChange('/p', '/p/Node_Modules/pkg/a.js', false))
    assert.ok(matchesExclude(['a', 'b', 'c'], ['**/b/*/**'], false) === false, 'c is the * and nothing is below it')
    assert.ok(matchesExclude(['a', 'b', 'c', 'd'], ['**/b/*/**'], false))
  })
})

// ---------- the registry, with a fake fs.watch ----------

interface FakeHandle extends WatchHandle { path: string; recursive: boolean; closed: boolean; fire(type: string, filename: string | null): void; fail(err: Error): void }

function harness(opts: { recursive: boolean; active?: boolean; present?: Set<string>; failOn?: (path: string) => Error | undefined; delay?: number; maxWait?: number; maxBuffered?: number; home?: string }) {
  const handles: FakeHandle[] = []
  const log = { changed: [] as string[][], missing: [] as [string, boolean][], failed: [] as [string, string][] }
  const present = opts.present ?? new Set<string>()
  const sink: WatchSink = {
    changed: dirs => log.changed.push(dirs),
    rootMissing: (root, missing) => log.missing.push([root, missing]),
    failed: (root, message) => log.failed.push([root, message]),
  }
  const watch: WatchFn = (path, options, listener) => {
    const err = opts.failOn?.(path)
    if (err) throw err
    let onError: ((e: Error) => void) | undefined
    const h: FakeHandle = {
      path, recursive: options.recursive, closed: false,
      close() { h.closed = true },
      on(_event, l) { onError = l },
      fire: (type, filename) => { if (!h.closed) listener(type, filename) },
      fail: e => onError?.(e),
    }
    handles.push(h)
    return h
  }
  const w = new ExplorerWatchers(sink, {
    watch, recursive: opts.recursive, caseInsensitive: false, delay: opts.delay ?? 20, maxWait: opts.maxWait ?? 120, maxBuffered: opts.maxBuffered, home: opts.home ?? '/home/u', active: opts.active ?? true,
    exists: async p => present.has(p),
  })
  const open = (): FakeHandle[] => handles.filter(h => !h.closed)
  return { w, handles, open, log, present }
}

describe('ExplorerWatchers', () => {
  test('one recursive handle per root, however often the roots are announced; none left when the roots leave', () => {
    const { w, open } = harness({ recursive: true })
    w.setRoots(['/a', '/b'])
    w.setRoots(['/a', '/b', '/a'])
    w.setExpanded(['/a', '/a/x', '/b'])
    assert.equal(open().length, 2)
    assert.ok(open().every(h => h.recursive))
    w.setRoots(['/b'])
    assert.deepEqual(open().map(h => h.path), ['/b'])
    w.setRoots([])
    assert.equal(open().length, 0)
    assert.equal(w.stats().handles, 0)
    w.dispose()
  })

  test('dispose releases every handle and silences later events', async () => {
    const { w, open, handles, log } = harness({ recursive: true, present: new Set(['/a/x']) })
    w.setRoots(['/a'])
    w.setExpanded(['/a'])
    handles[0]!.fire('rename', 'x')
    w.dispose()
    assert.equal(open().length, 0)
    await sleep(80)
    assert.equal(log.changed.length, 0)
  })

  test('a burst of 500 creations is one message with the folder once', async () => {
    const present = new Set<string>()
    const { w, handles, log } = harness({ recursive: true, present })
    w.setRoots(['/p'])
    w.setExpanded(['/p', '/p/src'])
    for (let i = 0; i < 500; i++) { present.add(`/p/src/f${i}.ts`); handles[0]!.fire('rename', `src/f${i}.ts`) }
    await sleep(150)
    assert.deepEqual(log.changed, [['/p/src']])
    assert.equal(w.stats().sent, 1)
    w.dispose()
  })

  test('events spread over time still make one window until the quiet time or the maximum wait', async () => {
    const present = new Set<string>()
    const { w, handles, log } = harness({ recursive: true, present, delay: 40, maxWait: 100 })
    w.setRoots(['/p'])
    w.setExpanded(['/p'])
    for (let i = 0; i < 4; i++) { present.add(`/p/f${i}`); handles[0]!.fire('rename', `f${i}`); await sleep(25) } // 100 ms of steady events
    await sleep(120)
    assert.ok(log.changed.length >= 1 && log.changed.length <= 2, `windows: ${log.changed.length}`)
    assert.ok(log.changed.every(c => c.length === 1 && c[0] === '/p'))
    w.dispose()
  })

  test('events in excluded places, in folders that are not expanded and plain content changes are dropped', async () => {
    const { w, handles, log, present } = harness({ recursive: true })
    w.setRoots(['/p'])
    w.setExpanded(['/p'])
    present.add('/p/node_modules/pkg/a.js').add('/p/.git/index').add('/p/deep/x').add('/p/a.txt')
    handles[0]!.fire('rename', 'node_modules/pkg/a.js')
    handles[0]!.fire('rename', '.git/index')
    handles[0]!.fire('rename', 'deep/x') // /p/deep is not expanded
    handles[0]!.fire('change', 'a.txt') // content only
    await sleep(100)
    assert.equal(log.changed.length, 0)
    assert.equal(w.stats().windows, 0, 'no window was even opened')
    handles[0]!.fire('rename', 'a.txt')
    await sleep(100)
    assert.deepEqual(log.changed, [['/p']])
    w.dispose()
  })

  test('create and delete in one window vanish; a delete alone reports the folder; a rename reports it once', async () => {
    const { w, handles, log, present } = harness({ recursive: true })
    w.setRoots(['/p'])
    w.setExpanded(['/p'])
    handles[0]!.fire('rename', 'tmp') // never exists when looked at: a delete; its twin below is the same path
    handles[0]!.fire('rename', 'tmp')
    await sleep(80)
    assert.deepEqual(log.changed, [['/p']], 'a delete (even of a file that never lived) is reported')
    log.changed.length = 0
    present.add('/p/new.txt')
    handles[0]!.fire('rename', 'old.txt')
    handles[0]!.fire('rename', 'new.txt')
    await sleep(80)
    assert.deepEqual(log.changed, [['/p']])
    w.dispose()
  })

  test('a burst beyond the buffer is one message naming every expanded folder of the project', async () => {
    const { w, handles, log, present } = harness({ recursive: true, maxBuffered: 50 })
    w.setRoots(['/p', '/q'])
    w.setExpanded(['/p', '/p/a', '/p/a/b', '/q'])
    for (let i = 0; i < 200; i++) { present.add(`/p/f${i}`); handles[0]!.fire('rename', `f${i}`) }
    await sleep(120)
    assert.equal(log.changed.length, 1)
    assert.deepEqual([...log.changed[0]!].sort(), ['/p', '/p/a', '/p/a/b'])
    w.dispose()
  })

  test('Linux: one handle per expanded folder, opened and closed as folders open and close; events carry the folder', async () => {
    const { w, open, handles, log, present } = harness({ recursive: false })
    w.setRoots(['/p'])
    w.setExpanded(['/p', '/p/src'])
    assert.deepEqual(open().map(h => h.path).sort(), ['/p', '/p/src'])
    assert.ok(open().every(h => !h.recursive))
    present.add('/p/src/n.ts')
    handles.find(h => h.path === '/p/src')!.fire('rename', 'n.ts')
    await sleep(80)
    assert.deepEqual(log.changed, [['/p/src']])
    w.setExpanded(['/p'])
    assert.deepEqual(open().map(h => h.path), ['/p'])
    w.setRoots([])
    assert.equal(open().length, 0)
    w.dispose()
  })

  test('a watcher that cannot start is reported once and not retried until "Atualizar"', async () => {
    const present = new Set(['/p'])
    let denied = true
    const { w, open, log } = harness({ recursive: true, present, failOn: () => denied ? Object.assign(new Error('boom'), { code: 'EPERM' }) : undefined })
    w.setRoots(['/p'])
    w.setExpanded(['/p'])
    w.setExpanded(['/p', '/p/x'])
    await sleep(20)
    assert.equal(log.failed.length, 1)
    assert.match(log.failed[0]![1], /permissão/)
    denied = false
    w.rewatch()
    assert.equal(open().length, 1, 'rewatch starts it again')
    w.dispose()
  })

  test('a watcher that dies is closed and reported; a root that is gone is "missing" instead', async () => {
    const present = new Set(['/p', '/q'])
    const { w, open, handles, log } = harness({ recursive: true, present })
    w.setRoots(['/p', '/q'])
    w.setExpanded(['/p', '/q'])
    handles[0]!.fail(Object.assign(new Error('x'), { code: 'EPERM' }))
    await sleep(20)
    assert.equal(log.failed.length, 1)
    assert.equal(open().length, 1)
    present.delete('/q')
    handles[1]!.fail(Object.assign(new Error('gone'), { code: 'EPERM' }))
    await sleep(20)
    assert.deepEqual(log.missing, [['/q', true]])
    assert.equal(open().length, 0, 'no handle is kept for a root that is gone')
    w.dispose()
  })

  test('an event for the watched folder itself checks whether it is still there', async () => {
    const present = new Set<string>()
    const { w, handles, log, open } = harness({ recursive: true, present })
    w.setRoots(['/p'])
    w.setExpanded(['/p'])
    handles[0]!.fire('rename', null)
    await sleep(20)
    assert.deepEqual(log.missing, [['/p', true]])
    assert.equal(open().length, 0)
    present.add('/p')
    w.rewatch()
    assert.equal(open().length, 1, 'back again after Atualizar')
    w.dispose()
  })

  test('Windows: a deleted watched folder repeats its extended path without end; one answer, not a stat per event', async () => {
    const present = new Set(['/p'])
    let asked = 0
    const handles: FakeHandle[] = []
    const log: [string, boolean][] = []
    const w = new ExplorerWatchers({ changed: () => {}, rootMissing: (r, m) => log.push([r, m]), failed: () => {} }, {
      recursive: true, caseInsensitive: true, delay: 10, active: true,
      watch: (path, options, listener) => { const h = { path, recursive: options.recursive, closed: false, close() { h.closed = true }, on() {}, fire: listener, fail() {} } as unknown as FakeHandle; handles.push(h); return h },
      exists: async p => { asked++; return present.has(p) },
    })
    w.setRoots(['/p'])
    w.setExpanded(['/p'])
    present.delete('/p')
    for (let i = 0; i < 20_000; i++) handles[0]!.fire('rename', '\\\\?\\D:\\x\\p')
    await sleep(40)
    assert.deepEqual(log, [['/p', true]])
    assert.ok(asked <= 2, `asked ${asked} times`)
    assert.equal(handles[0]!.closed, true)
    w.dispose()
  })
})

describe('ExplorerWatchers: broad and nested roots', () => {
  test('a disk root is watched per expanded folder, never recursively', () => {
    const { w, open } = harness({ recursive: true })
    w.setRoots(['D:\\'])
    assert.equal(open().length, 0, 'nothing expanded, nothing watched')
    w.setExpanded(['D:\\', 'D:\\src'])
    assert.deepEqual(open().map(h => h.path).sort(), ['D:\\', 'D:\\src'])
    assert.ok(open().every(h => !h.recursive))
    assert.equal(w.stats().broadRoots, 1)
    w.setExpanded(['D:\\'])
    assert.deepEqual(open().map(h => h.path), ['D:\\'])
    w.dispose()
  })

  test('/, X:/ and a UNC share root are broad too', () => {
    const { w, open } = harness({ recursive: true })
    w.setRoots(['/', 'E:/', '\\\\srv\\share\\'])
    w.setExpanded(['/', 'E:/', '\\\\srv\\share\\'])
    assert.equal(w.stats().broadRoots, 3)
    assert.ok(open().every(h => !h.recursive))
    w.dispose()
  })

  test('the home folder is watched per expanded folder', () => {
    const { w, open } = harness({ recursive: true, home: '/home/u' })
    w.setRoots(['/home/u/'])
    w.setExpanded(['/home/u', '/home/u/docs'])
    assert.deepEqual(open().map(h => [h.path, h.recursive]), [['/home/u', false], ['/home/u/docs', false]])
    assert.equal(w.stats().broadRoots, 1)
    w.dispose()
  })

  test('a root inside a recursive root opens no handle; its events are its own', async () => {
    const present = new Set(['/p/q/new.txt'])
    const { w, open, handles, log } = harness({ recursive: true, present, maxBuffered: 1 })
    w.setRoots(['/p', '/p/q'])
    w.setExpanded(['/p', '/p/q', '/p/x'])
    assert.deepEqual(open().map(h => [h.path, h.recursive]), [['/p', true]])
    // Overflow is per root: the burst in /p/q dirties only /p/q's folders, which shows the event went to the inner root.
    handles[0]!.fire('rename', 'q/new.txt')
    handles[0]!.fire('rename', 'q/b.txt')
    await sleep(80)
    assert.deepEqual(log.changed, [['/p/q']])
    w.dispose()
  })

  test('a root inside a broad root keeps its own recursive handle', () => {
    const { w, open } = harness({ recursive: true })
    w.setRoots(['D:\\', 'D:\\atrium'])
    w.setExpanded(['D:\\', 'D:\\atrium', 'D:\\atrium\\src'])
    assert.deepEqual(open().map(h => [h.path, h.recursive]).sort(), [['D:\\', false], ['D:\\atrium', true]])
    w.dispose()
  })

  test('adding and removing roots opens and closes the right handles', () => {
    const { w, open } = harness({ recursive: true })
    w.setRoots(['/p/q'])
    w.setExpanded(['/p', '/p/q'])
    assert.deepEqual(open().map(h => h.path), ['/p/q'])
    w.setRoots(['/p', '/p/q'])
    assert.deepEqual(open().map(h => h.path), ['/p'], 'the inner handle is let go once the outer covers it')
    w.setRoots(['/', '/p/q'])
    w.setExpanded(['/', '/p', '/p/q'])
    assert.deepEqual(open().map(h => [h.path, h.recursive]).sort(), [['/', false], ['/p', false], ['/p/q', true]])
    w.setRoots(['/p/q'])
    assert.deepEqual(open().map(h => [h.path, h.recursive]), [['/p/q', true]])
    w.setRoots([])
    assert.equal(open().length, 0)
    w.dispose()
  })
})

describe('ExplorerWatchers: only while a view is visible', () => {
  test('inactive by default: roots and expanded folders open no handle', () => {
    const w = new ExplorerWatchers({ changed() {}, rootMissing() {}, failed() {} }, { watch: () => { throw new Error('no handle expected') }, recursive: true, caseInsensitive: false, home: '/home/u' })
    w.setRoots(['/a'])
    w.setExpanded(['/a', '/a/x'])
    assert.equal(w.stats().handles, 0)
    assert.equal(w.stats().active, false)
    w.dispose()
  })

  test('activating opens the handles and reports every expanded folder changed once', () => {
    const { w, open, log } = harness({ recursive: true, active: false })
    w.setRoots(['/a', '/b'])
    w.setExpanded(['/a', '/a/x', '/b'])
    assert.equal(open().length, 0)
    assert.deepEqual(log.changed, [])
    w.setActive(true)
    assert.deepEqual(open().map(h => h.path).sort(), ['/a', '/b'])
    assert.deepEqual(log.changed.map(d => [...d].sort()), [['/a', '/a/x', '/b']])
    w.setActive(true)
    assert.equal(log.changed.length, 1, 'already active: nothing new')
    w.dispose()
  })

  test('Linux: activating opens one handle per expanded folder', () => {
    const { w, open } = harness({ recursive: false, active: false })
    w.setRoots(['/a'])
    w.setExpanded(['/a', '/a/x'])
    w.setActive(true)
    assert.deepEqual(open().map(h => h.path).sort(), ['/a', '/a/x'])
    w.dispose()
  })

  test('deactivating closes every handle; roots announced meanwhile open none', () => {
    const { w, open } = harness({ recursive: true })
    w.setRoots(['/a'])
    w.setExpanded(['/a'])
    assert.equal(open().length, 1)
    w.setActive(false)
    assert.equal(open().length, 0)
    w.setRoots(['/a', '/b'])
    w.rewatch()
    assert.equal(open().length, 0)
    assert.equal(w.stats().handles, 0)
    w.dispose()
  })

  test('events of a handle that is still firing after deactivation are dropped, and a window being gathered is too', async () => {
    const { w, handles, log } = harness({ recursive: true, present: new Set(['/a/x', '/a/y']) })
    w.setRoots(['/a'])
    w.setExpanded(['/a'])
    const h = handles[0]!
    h.fire('rename', 'x')
    await sleep(5)
    w.setActive(false)
    h.closed = false // a late event from the native side after close
    h.fire('rename', 'y')
    await sleep(80)
    assert.deepEqual(log.changed, [])
    w.dispose()
  })
})
