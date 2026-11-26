// The wait behind `agents_command` with `return: true`: after the tether types a command, watch the pane until it
// stops and classify how it stopped. Pure logic: the clock and every source of the pane are injected.

export const RETURN_QUIET_MS = 3_000
export const RETURN_LIMIT_MS = 5 * 60_000
export const RETURN_POLL_MS = 500

export type ReturnOutcome = 'done' | 'waiting' | 'timeout' | 'interfered' | 'turn' | 'gone'

export type ReturnResult = {
  outcome: ReturnOutcome
  state?: string
  text?: string
  markLost?: boolean
  elapsedMs: number
}

/** What the watch reads of one pane. */
export type ReturnSources = {
  /** The turn of the slot; undefined when the slot is gone. */
  turn(): 'busy' | 'idle' | undefined
  /** ISO instant of the last busy to idle transition. */
  idleSince(): string | undefined
  /** Ms of the last paint; 0 when never; undefined when the slot is gone. */
  paintedAt(): number | undefined
  /** Ms of the last time the person typed in this pane. */
  userTypedAt(): number | undefined
  detect(): Promise<{ state: string; card?: unknown }>
  readSince(mark: number): Promise<{ text: string; reset: boolean }>
  readAll(): Promise<string>
}

/** The clock of the watch; the daemon passes the real one, tests a fake. */
export type ReturnClock = {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type ReturnContext = {
  /** Ms when the tether typed the command. */
  typedAt: number
  /** The `end` read before typing. */
  mark: number
  /** The pane is the one of who asked. */
  self: boolean
}

export const realClock: ReturnClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

const WAITING_STATES = new Set(['dialog', 'permission', 'question'])

export class ReturnWatch {
  private readonly sources: ReturnSources
  private readonly context: ReturnContext
  private readonly clock: ReturnClock
  private timer: unknown = undefined
  private disposed = false
  private settle: ((r: ReturnResult | undefined) => void) | undefined = undefined
  private started: Promise<ReturnResult | undefined> | undefined = undefined

  constructor(sources: ReturnSources, context: ReturnContext, clock: ReturnClock = realClock) {
    this.sources = sources
    this.context = context
    this.clock = clock
  }

  /** Starts watching; resolves with the outcome, or undefined when disposed first. */
  run(): Promise<ReturnResult | undefined> {
    if (this.started) return this.started
    this.started = new Promise((resolve) => {
      this.settle = resolve
      if (this.disposed) { this.finish(undefined); return }
      this.schedule()
    })
    return this.started
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.finish(undefined)
  }

  private schedule(): void {
    this.timer = this.clock.setTimeout(() => { this.timer = undefined; void this.step() }, RETURN_POLL_MS)
  }

  private finish(result: ReturnResult | undefined): void {
    this.disposed = true
    if (this.timer !== undefined) { this.clock.clearTimeout(this.timer); this.timer = undefined }
    const settle = this.settle
    this.settle = undefined
    settle?.(result)
  }

  private async step(): Promise<void> {
    if (this.disposed) return
    try {
      const result = await this.decide()
      if (this.disposed) return
      if (result) this.finish(result)
      else this.schedule()
    } catch {
      // A failed read is a pane that vanished mid-read; the next poll asks again.
      if (!this.disposed) this.schedule()
    }
  }

  private async decide(): Promise<ReturnResult | undefined> {
    const { sources, context } = this
    const now = this.clock.now()
    const elapsedMs = now - context.typedAt
    const turn = sources.turn()
    const painted = sources.paintedAt()
    if (turn === undefined || painted === undefined) return { outcome: 'gone', elapsedMs }
    const idleSince = sources.idleSince()
    const idleAt = idleSince ? Date.parse(idleSince) : NaN
    if (turn === 'busy' || (Number.isFinite(idleAt) && idleAt > context.typedAt)) return { outcome: 'turn', elapsedMs }
    const typed = sources.userTypedAt()
    if (typed !== undefined && typed > context.typedAt) return { outcome: 'interfered', ...(await this.screen()), elapsedMs }
    if (now - Math.max(painted, context.typedAt) >= RETURN_QUIET_MS) {
      const { state } = await sources.detect()
      if (WAITING_STATES.has(state)) return { outcome: 'waiting', state, ...(await this.screen()), elapsedMs }
      return { outcome: 'done', ...(await this.screen()), elapsedMs }
    }
    if (elapsedMs >= RETURN_LIMIT_MS) return { outcome: 'timeout', ...(await this.screen()), elapsedMs }
    return undefined
  }

  private async screen(): Promise<{ text: string; markLost?: boolean }> {
    const since = await this.sources.readSince(this.context.mark)
    if (!since.reset) return { text: since.text }
    return { text: await this.sources.readAll(), markLost: true }
  }
}

/** From the LAST echo line of the typed command (`❯ /name`, `> /name`) on; the text intact when there is none. */
export function trimToEcho(text: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const echo = new RegExp(`^\\s*[❯>]\\s*/${escaped}(\\s|$)`)
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) if (echo.test(lines[i]!)) return lines.slice(i).join('\n')
  return text
}

/** The body of the system message that hands the screen back; undefined when nothing is delivered. */
export function returnBody(command: string, result: ReturnResult): string | undefined {
  let outcome: string
  switch (result.outcome) {
    case 'done': outcome = 'terminou'; break
    case 'waiting': outcome = `parou esperando você: ${result.state ?? 'desconhecido'}`; break
    case 'timeout': outcome = `não terminou em ${Math.round(RETURN_LIMIT_MS / 60_000)} min`; break
    case 'interfered': outcome = 'a pessoa digitou na guia durante a espera; a vez é dela'; break
    default: return undefined
  }
  const lines = [`comando ${command}: ${outcome}`]
  if (result.markLost) lines.push('a marca se perdeu no redesenho; segue a tela inteira')
  const text = (result.text ?? '').trimEnd()
  lines.push(text ? `tela:\n${text}` : 'a tela não mostrou nada novo')
  return lines.join('\n')
}
