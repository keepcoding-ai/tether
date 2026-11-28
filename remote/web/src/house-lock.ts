// One session per device and per house across tabs (RR4 debt B-4). The portal counts its request budget per device, all
// sessions together, so two tabs of the same origin would spend one budget and the portal would close both. The tab that
// holds the Web Lock `tether-house-<id>` is the one that talks to the house; any other waits and shows where the
// session is. Pure: the lock manager is injected, nothing here touches the page.

/** The part of `navigator.locks` this module uses. */
export interface LocksLike {
  request(
    name: string,
    options: { mode?: 'exclusive'; ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal },
    callback: (lock: object | null) => Promise<unknown> | unknown,
  ): Promise<unknown>
}

export interface HouseLockHandlers {
  /** This tab holds the lock: connect. Called again each time the lock comes back to this tab. May be async. */
  own(): Promise<void> | void
  /** Another tab holds the lock (at the start, or after this tab lost it): close the session and say so. */
  wait(): void
}

export interface HouseLock {
  /** Settles once the first decision (own or wait) is taken and, for `own`, its handler finished. */
  started: Promise<void>
  /** "Usar aqui": take the lock from the tab that holds it; that tab's `wait` runs. A no-op when this tab already holds it. */
  takeOver(): void
  /** Gives the lock up (or stops waiting for it), for good. */
  release(): void
}

export const houseLockName = (houseId: string): string => `tether-house-${houseId}`

/** The standard `navigator.locks`, if this browser has it (an old TV does not). */
export function browserLocks(nav: { locks?: unknown }): LocksLike | undefined {
  const l = nav.locks as Partial<LocksLike> | undefined
  return l && typeof l.request === 'function' ? (l as LocksLike) : undefined
}

export function holdHouse(locks: LocksLike | undefined, houseId: string, on: HouseLockHandlers): HouseLock {
  if (!locks) {
    // No Web Locks: as before, every tab connects.
    return { started: Promise.resolve(on.own()), takeOver: () => undefined, release: () => undefined }
  }
  const name = houseLockName(houseId)
  let done = false
  let owns = false
  let waiting: AbortController | undefined
  let giveUp: (() => void) | undefined
  let settleStart!: () => void
  const started = new Promise<void>(r => { settleStart = r })

  /** The callback of a granted lock: holds it until released (or until another tab steals it, which rejects the promise). */
  const granted = async (): Promise<void> => {
    if (done) return
    owns = true
    waiting = undefined
    const held = new Promise<void>(r => { giveUp = r })
    try { await on.own() } finally { settleStart() }
    await held
  }

  const lost = (): void => {
    owns = false
    giveUp = undefined
    if (done) return
    on.wait()
    queue()
  }

  /**
   * One request for the lock. Only a request that was granted may report the loss: a request dropped from the line (aborted)
   * also rejects, and by then another request of this tab may already own the lock.
   */
  const ask = (o: { ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal }, onNull?: () => void): void => {
    let mine = false
    void locks.request(name, { mode: 'exclusive', ...o }, async lock => {
      if (!lock) { onNull?.(); return }
      mine = true
      await granted()
    }).catch(() => { if (mine) lost() })
  }

  /** Asks for the lock, and waits in line when another tab has it. */
  const queue = (first = false): void => {
    const ac = new AbortController()
    waiting = ac
    if (!first) { ask({ signal: ac.signal }); return }
    ask({ ifAvailable: true }, () => {
      // Taken: say so, then wait in line.
      on.wait()
      settleStart()
      ask({ signal: ac.signal })
    })
  }

  queue(true)

  return {
    started,
    takeOver: () => {
      if (done || owns) return
      // The line is dropped first: the steal grants this tab, and the old place in line would grant it a second time.
      waiting?.abort()
      waiting = undefined
      ask({ steal: true })
    },
    release: () => {
      done = true
      waiting?.abort()
      waiting = undefined
      giveUp?.()
    },
  }
}
