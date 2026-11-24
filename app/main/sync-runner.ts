// The app's side of `tether sync` (src/cli/sync.ts): main never runs the engine (test/unit/arch.sync-ratchet.test.ts keeps
// synchronous fs out of its graph, and nothing here imports src/core/sync or src/cli/sync.ts); it starts the CLI as a child,
// `tether sync now --from-app --json`, and keeps the renderer from overwriting the arrangement while the child runs.
// One cycle at a time (a request during a cycle schedules ONE more after it):
//   a. the renderer writes its arrangement now (`tether:flush-layout`, bounded: the cycle goes on without an answer);
//   b. the renderer's `layout:save` calls are HELD while the child runs (only the last one is kept);
//   c. the child runs (bounded; its process tree is killed by pid when it overruns);
//   d. released: the child applied the arrangement -> the held save is dropped and the window reloads; else the held save is written;
//   e. the result stays in memory (getSyncState) and one line goes to the app log (never a URL).
// When: at open (the window waits at most OPEN_WAIT_MS), CHANGE_DEBOUNCE_MS after the last change, every PERIODIC_MS, on
// `tether://sync/now`, and at exit (a detached child, only when something changed since the last good cycle). Nothing runs without
// <home>/sync.json: with sync off the cost is one asynchronous existence check per trigger.
// What the child itself writes (settings through the watcher, keybindings through theirs, the reload) is an echo, never a change.
// Pure of Electron: every effect is injected (unit-tested in test/unit/app.sync-runner.test.ts).

/** The machine-local settings the engine never sends (DEFAULT_LOCAL_SETTINGS of src/core/sync/codecs/settings.ts, copied: main must not import the engine). */
const LOCAL_SETTING_ROOTS = new Set(['window', 'trayNoticeShown', 'extensionState'])

export const OPEN_WAIT_MS = 8_000
export const CHANGE_DEBOUNCE_MS = 30_000
export const PERIODIC_MS = 15 * 60_000
export const FLUSH_WAIT_MS = 3_000
export const CHILD_TIMEOUT_MS = 120_000
/** After a cycle that applied something, what its own writes stir up (watchers, the reloaded page) still arrives: ignored this long. */
export const ECHO_MS = 5_000

export const SYNC_ARGS: readonly string[] = ['sync', 'now', '--from-app', '--json']
export const SYNC_EXIT_ARGS: readonly string[] = ['sync', 'now', '--from-app']

export type ChangeKind = 'layout' | 'settings' | 'profiles' | 'keybindings'

export interface SyncResult {
  at: string
  ok: boolean
  error?: { code: string; message: string }
  /** The engine's report as the CLI printed it (src/core/sync/engine.ts SyncReport); null when there is none. */
  report: { applied?: Partial<Record<string, boolean>> } & Record<string, unknown> | null
  /** What started the cycle (abertura, mudança, periódico, link). */
  reason: string
  ms: number
}

export interface SyncState {
  /** <home>/sync.json existed at the last check. */
  connected: boolean
  running: boolean
  last: SyncResult | null
}

/** What the runner needs of a child process (node's ChildProcess fits). */
export interface ChildLike {
  pid?: number | undefined
  stdout?: { on(ev: 'data', fn: (chunk: Buffer | string) => void): unknown } | null
  stderr?: { on(ev: 'data', fn: (chunk: Buffer | string) => void): unknown } | null
  once(ev: 'close', fn: (code: number | null) => void): unknown
  once(ev: 'error', fn: (err: Error) => void): unknown
  unref(): void
}

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface SyncRunnerDeps {
  /** Does <home>/sync.json exist? Asynchronous; a rejection counts as no. */
  configExists(): Promise<boolean>
  /** Starts `node <cli> ...args` with the app's home env. detached: stdio ignored, outside the app's tree. May throw (no node). */
  spawnChild(args: readonly string[], detached: boolean): ChildLike
  /** Kills a process tree by pid. Never rejects. */
  kill(pid: number): Promise<unknown>
  /** Asks the renderer to write its arrangement now; resolves when it did (or at once without a window). Bounded by the runner. */
  flushLayout(): Promise<unknown>
  /** Writes an arrangement the renderer sent (layout-file.ts saveLayoutFile). */
  writeLayout(layout: unknown): Promise<void>
  /** Reloads the window, if there is one. */
  reload(): void
  /** Leaves a failure the child could not record in <home>/sync-last.json (a terminal waiting on `tether://sync/now` reads it). */
  writeLast?(last: { at: string; ok: false; error: { code: string; message: string }; report: null }): Promise<void>
  log(line: string): void
  clock?: Clock
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t },
  clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>),
}

/** Anything that looks like a URL is cut from what goes to the log. */
export const withoutUrls = (text: string): string => text.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>').replace(/\b[\w.-]+@[\w.-]+:\S+/g, '<url>')

const lastLine = (text: string): string => text.trim().split(/\r?\n/).filter(Boolean).pop() ?? ''

type Phase = 'idle' | 'flush' | 'hold'

interface ChildOutcome { code: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError?: string }

export class SyncRunner {
  private readonly clock: Clock
  private connected = false
  private running = false
  private last: SyncResult | null = null
  private phase: Phase = 'idle'
  private held: { layout: unknown } | undefined
  private current: Promise<SyncResult | undefined> | undefined
  private next: { reason: string; promise: Promise<SyncResult | undefined>; resolve: (r: SyncResult | undefined) => void } | undefined
  private debounce: unknown
  private periodic: unknown
  private stopped = false
  private exited = false
  /** Real changes so far; the cycle that started at seq N covers every change up to N. */
  private changeSeq = 0
  private startSeq = 0
  private syncedSeq = 0
  private duringRun = new Set<ChangeKind>()
  private echo: { kinds: Set<string>; until: number } | undefined
  /** The child printed its own JSON (and so wrote sync-last.json itself). */
  private childWroteLast = false

  private readonly deps: SyncRunnerDeps

  constructor(deps: SyncRunnerDeps) {
    this.deps = deps
    this.clock = deps.clock ?? realClock
  }

  state(): SyncState {
    return { connected: this.connected, running: this.running, last: this.last }
  }

  /** One cycle; a request during a cycle gets the ONE cycle that follows it (requests merge). undefined: sync is off or the runner stopped. */
  run(reason: string): Promise<SyncResult | undefined> {
    if (!this.current) return this.start(reason)
    if (!this.next) {
      let resolve!: (r: SyncResult | undefined) => void
      const promise = new Promise<SyncResult | undefined>(r => { resolve = r })
      this.next = { reason, promise, resolve }
    }
    return this.next.promise
  }

  private start(reason: string): Promise<SyncResult | undefined> {
    const p = this.cycle(reason).catch((err: unknown) => {
      this.deps.log(`sync: ${reason}: erro interno: ${withoutUrls(err instanceof Error ? err.message : String(err))}`)
      return undefined
    }).finally(() => {
      this.current = undefined
      const n = this.next
      this.next = undefined
      if (n) void this.start(n.reason).then(n.resolve)
    })
    this.current = p
    return p
  }

  private async cycle(reason: string): Promise<SyncResult | undefined> {
    if (this.stopped) return undefined
    this.connected = await this.deps.configExists().catch(() => false)
    if (!this.connected || this.stopped) return undefined
    const started = this.clock.now()
    this.running = true
    this.startSeq = this.changeSeq
    this.clearDebounce() // the changes so far ride on this cycle
    this.duringRun.clear()
    let result: SyncResult | undefined
    try {
      this.phase = 'flush'
      await this.bounded(this.deps.flushLayout().catch(() => undefined), FLUSH_WAIT_MS)
      this.phase = 'hold'
      const out = await this.runChild()
      result = this.resultOf(out, reason, started)
    } finally {
      // d. release: always, even when something above threw.
      const applied = result?.report?.applied ?? {}
      const held = this.held
      this.held = undefined
      this.phase = 'idle'
      if (applied.layout) {
        if (held) this.deps.log('sync: o arranjo veio de outra máquina; a gravação feita durante a sincronização foi descartada')
        this.deps.reload()
      } else if (held) {
        try { await this.deps.writeLayout(held.layout) } catch (err) { this.deps.log(`sync: gravar o arranjo segurado falhou: ${err instanceof Error ? err.message : String(err)}`) }
      }
      this.running = false
      const appliedKinds = new Set(Object.entries(applied).filter(([, v]) => v).map(([k]) => k))
      if (appliedKinds.size) this.echo = { kinds: appliedKinds, until: this.clock.now() + ECHO_MS }
      for (const kind of this.duringRun) if (!appliedKinds.has(kind)) this.registerChange()
      // A held save that reached the disk is the person's own change: it goes in the next cycle.
      if (held && !applied.layout) this.registerChange()
      this.duringRun.clear()
    }
    this.last = result
    if (result.ok) this.syncedSeq = this.startSeq
    this.deps.log(this.logLine(result))
    if (!result.ok && result.report === null && result.error && this.deps.writeLast && !this.childWroteLast) {
      await this.deps.writeLast({ at: result.at, ok: false, error: result.error, report: null }).catch(() => undefined)
    }
    return result
  }

  private resultOf(out: ChildOutcome, reason: string, started: number): SyncResult {
    const at = new Date(this.clock.now()).toISOString()
    const ms = this.clock.now() - started
    this.childWroteLast = false
    if (out.spawnError !== undefined) return { at, ok: false, error: { code: 'spawn', message: out.spawnError }, report: null, reason, ms }
    if (out.timedOut) return { at, ok: false, error: { code: 'timeout', message: `a sincronização passou de ${CHILD_TIMEOUT_MS / 1000} s e foi interrompida` }, report: null, reason, ms }
    let doc: unknown
    try { doc = JSON.parse(out.stdout.trim()) } catch { doc = undefined }
    if (doc && typeof doc === 'object' && typeof (doc as { ok?: unknown }).ok === 'boolean') {
      const d = doc as { at?: unknown; ok: boolean; error?: { code?: unknown; message?: unknown }; report?: unknown }
      this.childWroteLast = true
      const error = d.error ? { code: String(d.error.code ?? 'error'), message: String(d.error.message ?? '') } : undefined
      const report = d.report && typeof d.report === 'object' ? d.report as SyncResult['report'] : null
      return { at: typeof d.at === 'string' ? d.at : at, ok: d.ok && out.code === 0, ...(error ? { error } : {}), report, reason, ms }
    }
    const message = lastLine(out.stderr) || `o tether sync saiu com o código ${String(out.code)} sem relatório`
    return { at, ok: false, error: { code: 'child', message: message.replace(/^tether:\s*/, '') }, report: null, reason, ms }
  }

  private logLine(r: SyncResult): string {
    const secs = `${(r.ms / 1000).toFixed(1)} s`
    if (r.ok) {
      const applied = Object.entries(r.report?.applied ?? {}).filter(([, v]) => v).map(([k]) => k)
      return `sync: ${r.reason}: ok em ${secs}${applied.length ? ` (aplicado: ${applied.join(', ')})` : ''}`
    }
    return `sync: ${r.reason}: falhou em ${secs}: ${r.error?.code ?? 'error'}: ${withoutUrls(r.error?.message ?? '')}`
  }

  private runChild(): Promise<ChildOutcome> {
    return new Promise(resolve => {
      let stdout = ''
      let stderr = ''
      let done = false
      let timer: unknown
      const finish = (o: Omit<ChildOutcome, 'stdout' | 'stderr'>): void => {
        if (done) return
        done = true
        this.clock.clearTimeout(timer)
        resolve({ ...o, stdout, stderr })
      }
      let child: ChildLike
      try { child = this.deps.spawnChild(SYNC_ARGS, false) } catch (err) {
        finish({ code: null, timedOut: false, spawnError: err instanceof Error ? err.message : String(err) })
        return
      }
      child.stdout?.on('data', c => { stdout += String(c) })
      child.stderr?.on('data', c => { stderr += String(c) })
      child.once('error', err => finish({ code: null, timedOut: false, spawnError: err.message }))
      child.once('close', code => finish({ code, timedOut: false }))
      timer = this.clock.setTimeout(() => {
        if (done) return
        if (child.pid !== undefined) void this.deps.kill(child.pid)
        finish({ code: null, timedOut: true })
      }, CHILD_TIMEOUT_MS)
    })
  }

  private bounded(p: Promise<unknown>, ms: number): Promise<unknown> {
    let timer: unknown
    return Promise.race([p, new Promise(r => { timer = this.clock.setTimeout(() => r(undefined), ms) })]).finally(() => this.clock.clearTimeout(timer))
  }

  // ---- the renderer's saves ----

  /** The `layout:save` handler: written now, or held while the child runs (only the last is kept). */
  saveLayout(layout: unknown): Promise<void> {
    if (this.phase === 'hold') {
      this.held = { layout }
      return Promise.resolve()
    }
    // The flush's own save is what this cycle sends: not a change.
    if (this.phase === 'idle') this.changed('layout')
    return this.deps.writeLayout(layout)
  }

  // ---- changes ----

  /** Something the person changed: a cycle CHANGE_DEBOUNCE_MS after the last one. Echoes of the sync's own writes are ignored. */
  changed(kind: ChangeKind): void {
    if (this.stopped) return
    if (this.running) { this.duringRun.add(kind); return }
    if (this.echo && this.clock.now() < this.echo.until && this.echo.kinds.has(kind)) return
    this.registerChange()
  }

  /** settingsStore.onChange: only keys that travel count. */
  settingsChanged(keys: readonly string[]): void {
    if (keys.some(k => !LOCAL_SETTING_ROOTS.has(k.split('.')[0] ?? ''))) this.changed('settings')
  }

  private registerChange(): void {
    this.changeSeq++
    this.clearDebounce()
    if (this.stopped) return
    this.debounce = this.clock.setTimeout(() => { this.debounce = undefined; void this.run('mudança') }, CHANGE_DEBOUNCE_MS)
  }

  private clearDebounce(): void {
    if (this.debounce !== undefined) { this.clock.clearTimeout(this.debounce); this.debounce = undefined }
  }

  // ---- lifecycle ----

  /** At open, before the window: waits for the cycle at most `maxMs` (it goes on afterwards, reloading if it applied the arrangement); starts the periodic cycle. */
  async atOpen(maxMs = OPEN_WAIT_MS): Promise<'done' | 'timeout'> {
    this.schedulePeriodic()
    let timer: unknown
    const outcome = await Promise.race([
      this.run('abertura').then(() => 'done' as const),
      new Promise<'timeout'>(r => { timer = this.clock.setTimeout(() => r('timeout'), maxMs) }),
    ])
    this.clock.clearTimeout(timer)
    if (outcome === 'timeout') this.deps.log(`sync: abertura passou de ${maxMs / 1000} s; a janela abre e a sincronização segue`)
    return outcome
  }

  private schedulePeriodic(): void {
    if (this.stopped) return
    if (this.periodic !== undefined) this.clock.clearTimeout(this.periodic)
    this.periodic = this.clock.setTimeout(() => { this.periodic = undefined; void this.run('periódico'); this.schedulePeriodic() }, PERIODIC_MS)
  }

  /** The app is leaving (before its disk is drained): no more cycles; a save held by a cycle still running is written now. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.clearDebounce()
    if (this.periodic !== undefined) { this.clock.clearTimeout(this.periodic); this.periodic = undefined }
    if (this.held) {
      const { layout } = this.held
      this.held = undefined
      void this.deps.writeLayout(layout).catch(() => undefined)
    }
  }

  /** After the disk was drained: something changed since the last good cycle -> a detached child sends it; never waited for. */
  pushOnExit(): boolean {
    this.stop()
    if (this.exited) return false
    this.exited = true
    const covered = this.running ? this.startSeq : this.syncedSeq
    if (!this.connected || this.changeSeq <= covered) return false
    try {
      const child = this.deps.spawnChild(SYNC_EXIT_ARGS, true)
      child.once('error', () => undefined)
      child.unref()
      this.deps.log(`sync: saída: mudanças pendentes, enviadas por um processo destacado${child.pid !== undefined ? ` (pid ${child.pid})` : ''}`)
      return true
    } catch (err) {
      this.deps.log(`sync: saída: não consegui iniciar o envio: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }
}

let registered: SyncRunner | undefined

export function createSyncRunner(deps: SyncRunnerDeps): SyncRunner {
  registered = new SyncRunner(deps)
  return registered
}

/** For the sync screen (another step): what the app's runner knows now. */
export function getSyncState(): SyncState {
  return registered?.state() ?? { connected: false, running: false, last: null }
}

// ---- the renderer's flush (main side) ----

export const FLUSH_CHANNEL = 'tether:flush-layout'
export const FLUSHED_CHANNEL = 'tether:layout-flushed'

/**
 * `tether:flush-layout` to the window, answered by `tether:layout-flushed` with the same id once the renderer saved
 * (app/preload/preload.ts onFlushLayout). Resolves at once without a window, and after `ms` without an answer.
 */
export function rendererLayoutFlusher(
  ipc: { on(channel: string, fn: (e: unknown, id: unknown) => void): unknown },
  target: () => { send(channel: string, id: number): void } | undefined,
  ms = FLUSH_WAIT_MS,
): () => Promise<boolean> {
  let seq = 0
  const waiting = new Map<number, (ok: boolean) => void>()
  ipc.on(FLUSHED_CHANNEL, (_e, id) => { if (typeof id === 'number') { waiting.get(id)?.(true); waiting.delete(id) } })
  return () => {
    const t = target()
    if (!t) return Promise.resolve(false)
    const id = ++seq
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => { waiting.delete(id); resolve(false) }, ms)
      timer.unref?.()
      waiting.set(id, ok => { clearTimeout(timer); resolve(ok) })
      try { t.send(FLUSH_CHANNEL, id) } catch { waiting.delete(id); clearTimeout(timer); resolve(false) }
    })
  }
}
