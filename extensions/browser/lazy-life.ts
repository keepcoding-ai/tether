// When the browser process lives (pure; unit-tested). It is not started with the app: the first need starts it (a tab to show or
// restore, an agent's call), and once it serves nothing for IDLE_STOP_MS it is asked to leave cleanly, so an app without tabs
// does not carry a whole second Electron. The process leaving this way is NOT a crash: `ended` tells the two apart, and only a
// crash holds the agents back until the person acts (a page that crashes the browser must not be reopened by a retry loop).

/** How long the process may serve nothing (no live tab, no question waiting for the person) before it is asked to leave. */
export const IDLE_STOP_MS = 60_000
/** How long a clean quit gets before the process is killed; it is still an idle exit. */
export const QUIT_GRACE_MS = 8_000

export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realTimers: Timers = {
  set: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t },
  clear: handle => clearTimeout(handle as NodeJS.Timeout),
}

export interface LifeOptions<P> {
  idleMs?: number
  quitGraceMs?: number
  /** What the process is serving now: live tabs plus questions waiting for the person. Zero means idle. */
  busy(): number
  /** Asks the process to leave cleanly (it closes its line, clears what it must, exits). */
  quit(proc: P): void
  /** The clean quit did not end the process in time. */
  kill(proc: P): void
  log(msg: string): void
  timers?: Timers
}

/** Who wants the process: an agent's call may not start it after a crash; the person's own action always may. */
export type Need = 'agent' | 'person'
export type ExitKind = 'idle' | 'crash'

export class BrowserLife<P> {
  private readonly o: LifeOptions<P>
  private readonly timers: Timers
  private proc: P | undefined
  private idle: unknown
  private stopping: { proc: P; done: Promise<void>; finish: () => void; grace: unknown } | undefined
  private held = false

  constructor(o: LifeOptions<P>) {
    this.o = o
    this.timers = o.timers ?? realTimers
  }

  /** The process was spawned. */
  began(proc: P): void { this.proc = proc }

  /** Resolves once an idle quit in flight has ended (at once when none): a need that came meanwhile starts a new process after it. */
  settled(): Promise<void> { return this.stopping?.done ?? Promise.resolve() }

  /** Whether a need may start the process now. After a crash only the person may (and her need lifts the hold). */
  permits(by: Need): boolean {
    if (!this.held) return true
    if (by === 'person') { this.held = false; return true }
    return false
  }

  /** A need was served (the process is up): the idle clock starts from now when nothing keeps the process busy. */
  touch(): void { this.arm() }

  /** What the process serves changed (a tab came or went, a question opened or closed). */
  changed(): void { this.arm() }

  /** The process is over, whatever the reason; `idle` is the quit this class asked for, anything else a crash. */
  ended(proc: P): ExitKind {
    this.cancelIdle()
    if (this.proc === proc) this.proc = undefined
    const s = this.stopping
    if (s && s.proc === proc) {
      this.timers.clear(s.grace)
      this.stopping = undefined
      s.finish()
      return 'idle'
    }
    this.held = true
    return 'crash'
  }

  dispose(): void {
    this.cancelIdle()
    if (this.stopping) { this.timers.clear(this.stopping.grace); this.stopping.finish(); this.stopping = undefined }
  }

  private cancelIdle(): void {
    if (this.idle !== undefined) { this.timers.clear(this.idle); this.idle = undefined }
  }

  private arm(): void {
    this.cancelIdle()
    if (this.proc === undefined || this.stopping || this.o.busy() > 0) return
    this.idle = this.timers.set(() => { this.idle = undefined; this.stop() }, this.o.idleMs ?? IDLE_STOP_MS)
  }

  private stop(): void {
    const proc = this.proc
    if (proc === undefined || this.stopping || this.o.busy() > 0) return
    let finish!: () => void
    const done = new Promise<void>(r => { finish = r })
    this.stopping = { proc, done, finish, grace: this.timers.set(() => { if (this.stopping?.proc === proc) this.o.kill(proc) }, this.o.quitGraceMs ?? QUIT_GRACE_MS) }
    this.o.log('navegador sem guias: encerrado por ociosidade')
    this.o.quit(proc)
  }
}
