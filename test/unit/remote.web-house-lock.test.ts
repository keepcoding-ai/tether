// One session per device and house across tabs (remote/web/src/house-lock.ts): the decision, over a fake Web Locks manager
// shared by the "tabs" of a test (the same manager is what the browser shares across tabs of one origin).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { browserLocks, holdHouse, type LocksLike } from '../../remote/web/src/house-lock.ts'

interface Held { release: () => void; broken: (e: Error) => void }
interface Waiter { cb: (l: object | null) => Promise<unknown> | unknown; resolve: (v: unknown) => void; reject: (e: Error) => void; signal?: AbortSignal }

/** The semantics of `navigator.locks` that matter here: exclusive, ifAvailable, FIFO queue, abortable queue, steal. */
function fakeLocks(): LocksLike {
  const held = new Map<string, Held>()
  const queue = new Map<string, Waiter[]>()
  const grant = (name: string, w: Waiter): void => {
    let release!: () => void
    let broken!: (e: Error) => void
    const gone = new Promise<void>((res, rej) => { release = res; broken = rej })
    held.set(name, { release, broken })
    Promise.resolve(w.cb({})).then(
      v => { gone.catch(() => undefined); finish(name, held.get(name)); w.resolve(v) },
      e => { finish(name, held.get(name)); w.reject(e as Error) },
    )
    void gone.catch(e => w.reject(e as Error))
  }
  const finish = (name: string, h: Held | undefined): void => {
    if (held.get(name) !== h) return
    held.delete(name)
    const next = queue.get(name)?.shift()
    if (next) grant(name, next)
  }
  return {
    request(name, o, cb) {
      return new Promise((resolve, reject) => {
        const w: Waiter = { cb, resolve, reject, ...(o.signal ? { signal: o.signal } : {}) }
        if (o.steal) {
          const h = held.get(name)
          held.delete(name)
          h?.broken(new Error('AbortError: lock broken'))
          grant(name, w)
          return
        }
        if (!held.has(name)) { grant(name, w); return }
        if (o.ifAvailable) { Promise.resolve(cb(null)).then(resolve, reject); return }
        const q = queue.get(name) ?? []
        queue.set(name, q)
        q.push(w)
        o.signal?.addEventListener('abort', () => {
          const i = q.indexOf(w)
          if (i >= 0) { q.splice(i, 1); reject(new Error('AbortError')) }
        })
      })
    },
  }
}

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 5))

function tab(locks: LocksLike | undefined, id = 'h1') {
  const log: string[] = []
  const lock = holdHouse(locks, id, { own: () => { log.push('own') }, wait: () => { log.push('wait') } })
  return { log, lock }
}

describe('one session per device across tabs', () => {
  test('the first tab connects', async () => {
    const a = tab(fakeLocks())
    await a.lock.started
    assert.deepEqual(a.log, ['own'])
  })

  test('the second tab waits and does not connect', async () => {
    const locks = fakeLocks()
    const a = tab(locks)
    await a.lock.started
    const b = tab(locks)
    await b.lock.started
    assert.deepEqual(a.log, ['own'])
    assert.deepEqual(b.log, ['wait'])
  })

  test('another house is another lock', async () => {
    const locks = fakeLocks()
    await tab(locks, 'h1').lock.started
    const b = tab(locks, 'h2')
    await b.lock.started
    assert.deepEqual(b.log, ['own'])
  })

  test('when the owner leaves, the waiting tab takes over by itself', async () => {
    const locks = fakeLocks()
    const a = tab(locks)
    await a.lock.started
    const b = tab(locks)
    await b.lock.started
    a.lock.release()
    await tick()
    assert.deepEqual(b.log, ['wait', 'own'])
    assert.deepEqual(a.log, ['own'])
  })

  test('"Usar aqui" takes the lock and the other tab lets go, then waits', async () => {
    const locks = fakeLocks()
    const a = tab(locks)
    await a.lock.started
    const b = tab(locks)
    await b.lock.started
    b.lock.takeOver()
    await tick()
    assert.deepEqual(b.log, ['wait', 'own'], 'the taker owns once, not twice')
    assert.deepEqual(a.log, ['own', 'wait'])
    // The loser is back in line: when the new owner leaves, it connects again.
    b.lock.release()
    await tick()
    assert.deepEqual(a.log, ['own', 'wait', 'own'])
  })

  test('"Usar aqui" on the tab that already owns does nothing', async () => {
    const a = tab(fakeLocks())
    await a.lock.started
    a.lock.takeOver()
    await tick()
    assert.deepEqual(a.log, ['own'])
  })

  test('a released tab no longer reacts', async () => {
    const locks = fakeLocks()
    const a = tab(locks)
    await a.lock.started
    const b = tab(locks)
    await b.lock.started
    b.lock.release()
    a.lock.release()
    await tick()
    assert.deepEqual(b.log, ['wait'])
  })

  test('without Web Locks every tab connects straight away', async () => {
    const a = tab(undefined)
    const b = tab(undefined)
    await Promise.all([a.lock.started, b.lock.started])
    assert.deepEqual(a.log, ['own'])
    assert.deepEqual(b.log, ['own'])
    a.lock.takeOver()
    a.lock.release()
  })

  test('browserLocks reads only a usable manager', () => {
    assert.equal(browserLocks({}), undefined)
    assert.equal(browserLocks({ locks: {} }), undefined)
    const l = fakeLocks()
    assert.equal(browserLocks({ locks: l }), l)
  })
})
