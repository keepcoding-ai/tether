// A pane suspended to save resources: the app stops the process of an idle agent the person is not using, keeps the pane
// in place with its last screen, and resumes it (the slot's `start`, which resumes the session) as soon as anything uses
// it. It is not hibernation: a hibernated pane was put away on purpose and waits for an explicit wake; a suspended pane
// still counts as working and comes back on its own. Pure rules here; main.ts runs ONE sweep for every pane.
import type { SlotState } from '../../src/daemon/protocol.ts'

/** settings.json keys (core settings, "Desempenho"). */
export const SUSPEND_ENABLED_KEY = 'performance.suspend.enabled'
export const SUSPEND_IDLE_KEY = 'performance.suspend.idleMinutes'

export interface SuspendSettings {
  enabled: boolean
  /** Minutes of idleness (no turn, no use by the person) before a pane is suspended. */
  idleMinutes: number
}

export const DEFAULT_SUSPEND: SuspendSettings = { enabled: true, idleMinutes: 60 }
export const SUSPEND_IDLE_MIN = 5
export const SUSPEND_IDLE_MAX = 24 * 60

/** How often the single sweep looks at every pane. */
export const SUSPEND_SWEEP_MS = 60_000

/** The person's keys typed while the pane resumes wait at most this much (they go once the agent is up). */
export const RESUME_INPUT_MAX = 64 * 1024

/** What the pane shows and says. */
export const SUSPENDED_LABEL = 'Suspensa'
export const SUSPENDED_TIP = 'Suspensa para economizar recursos — retoma ao usar'
export const RESUMING_LABEL = 'Retomando…'

/** The settings from settings.json's entries; anything missing or out of range falls back to the default. */
export function normalizeSuspend(get: (key: string) => unknown): SuspendSettings {
  const enabled = get(SUSPEND_ENABLED_KEY)
  const idle = get(SUSPEND_IDLE_KEY)
  return {
    enabled: typeof enabled === 'boolean' ? enabled : DEFAULT_SUSPEND.enabled,
    idleMinutes: typeof idle === 'number' && Number.isFinite(idle) ? Math.min(SUSPEND_IDLE_MAX, Math.max(SUSPEND_IDLE_MIN, idle)) : DEFAULT_SUSPEND.idleMinutes,
  }
}

/** One pane as the sweep sees it. */
export interface SuspendCandidate {
  slot: SlotState
  /** When the person last used the pane (key, paste, click, scroll, focus), ms epoch; undefined = not since the app opened. */
  lastUse: number | undefined
  /** The pane has the focus (the active desk's active pane, or the keyboard). */
  focused: boolean
  /** Hibernated (layout `asleepPanes`). */
  asleep: boolean
  /** Already suspended. */
  suspended: boolean
}

/**
 * Whether the sweep suspends this pane now. Only an agent that is up, can resume its session in place (`canRestart`:
 * an engine that resumes, a session reported in this run, not restarting or stopping) and has been idle — no turn, no
 * background subagents, no permission card — for the whole limit, in a pane the person has not used for the same time and
 * that does not have the focus. `appStart` stands in for an unknown last use (the app just opened).
 */
export function shouldSuspend(c: SuspendCandidate, settings: SuspendSettings, now: number, appStart: number): boolean {
  if (!settings.enabled || c.focused || c.asleep || c.suspended) return false
  const s = c.slot
  if (s.kind === 'shell' || s.status !== 'running' || s.restarting || s.stopping || s.canRestart !== true) return false
  if (s.turn === 'busy' || (s.background ?? 0) > 0) return false
  if ((s.attention ?? s.attentionFor?.value) === 'waiting') return false
  const limit = settings.idleMinutes * 60_000
  const idleSince = s.idleSince ? Date.parse(s.idleSince) : NaN
  if (!Number.isFinite(idleSince) || now - idleSince < limit) return false
  return now - (c.lastUse ?? appStart) >= limit
}

/** The panes to suspend in this sweep. */
export function sweepSuspend(candidates: Iterable<SuspendCandidate>, settings: SuspendSettings, now: number, appStart: number): string[] {
  if (!settings.enabled) return []
  const out: string[] = []
  for (const c of candidates) if (shouldSuspend(c, settings, now, appStart)) out.push(c.slot.slotId)
  return out
}

/** Whether the slot of a suspended pane is up again (the pane stops being suspended on this edge). */
export const isLiveStatus = (s: SlotState): boolean => s.status === 'running' || s.status === 'starting' || s.status === 'queued'

/**
 * The person's input to a suspended pane while it resumes: kept in order, per pane, up to RESUME_INPUT_MAX (what passes
 * the cap is dropped, never a reorder), and handed back once the agent is up.
 */
export class ResumeInput {
  private readonly held = new Map<string, string>()

  hold(slotId: string, data: string): void {
    const now = this.held.get(slotId) ?? ''
    const room = RESUME_INPUT_MAX - now.length
    if (room <= 0) return
    this.held.set(slotId, now + data.slice(0, room))
  }

  has(slotId: string): boolean { return this.held.has(slotId) }

  /** The held input, removed. */
  take(slotId: string): string | undefined {
    const data = this.held.get(slotId)
    this.held.delete(slotId)
    return data
  }

  drop(slotId: string): void { this.held.delete(slotId) }
}

/** What the panes' suspension asks of main.ts after an event. */
export interface SuspendOutcome {
  /** The set of suspended panes changed: the layout (and the desk map) must be saved. */
  changed: boolean
  /** Start the slot now (the pane resumes). */
  resume?: boolean
  /** The person's input held during the resume: write it to the slot now, in order. */
  flush?: string
}

const NOTHING: SuspendOutcome = { changed: false }

/**
 * The suspended panes of the app (layout `suspendedPanes`) and their resume. Separate from hibernation (`asleepPanes`):
 * hibernating a suspended pane makes it hibernated, and a hibernated pane is never suspended. A pane leaves the set on the
 * stopped → live edge of its slot, whoever started it (the person's use here, or the daemon for a delivery, a verb or the
 * ronda), so the set survives a restart of the app and a pane only comes up when used.
 */
export class SuspendBook {
  private suspended = new Set<string>()
  /** Panes whose resume this app started and whose agent is not up yet: the person's input waits meanwhile. */
  private readonly resuming = new Set<string>()
  private readonly input = new ResumeInput()

  /** From the layout file: the ids that still have a pane. */
  load(ids: readonly string[] | undefined, keep: (id: string) => boolean): void {
    this.suspended = new Set((ids ?? []).filter(keep))
  }

  /** For the layout file; undefined when none is suspended (the key stays out). */
  toLayout(): string[] | undefined { return this.suspended.size ? [...this.suspended] : undefined }

  has(id: string): boolean { return this.suspended.has(id) }
  isResuming(id: string): boolean { return this.resuming.has(id) }
  get size(): number { return this.suspended.size }

  /** The sweep suspended the pane (its process stops next). */
  suspend(id: string): SuspendOutcome {
    if (this.suspended.has(id)) return NOTHING
    this.suspended.add(id)
    return { changed: true }
  }

  /** The pane was hibernated: it is asleep now, not suspended. */
  hibernated(id: string): SuspendOutcome {
    this.resuming.delete(id)
    this.input.drop(id)
    return { changed: this.suspended.delete(id) }
  }

  /** The person typed or pasted into the pane: held while it resumes; the first input of a suspended pane resumes it. */
  userInput(id: string, data: string): SuspendOutcome & { held: boolean } {
    if (this.resuming.has(id)) { this.input.hold(id, data); return { changed: false, held: true } }
    if (!this.suspended.has(id)) return { changed: false, held: false }
    this.resuming.add(id)
    this.input.hold(id, data)
    return { changed: false, held: true, resume: true }
  }

  /** The person clicked or scrolled in the pane's terminal: a suspended pane resumes. */
  use(id: string): SuspendOutcome {
    if (!this.suspended.has(id) || this.resuming.has(id)) return NOTHING
    this.resuming.add(id)
    return { changed: false, resume: true }
  }

  /** A state of the pane's slot arrived (`before`: the one the app had). */
  stateChanged(before: SlotState | undefined, now: SlotState): SuspendOutcome {
    const id = now.slotId
    let changed = false
    if (before && !isLiveStatus(before) && isLiveStatus(now)) changed = this.suspended.delete(id)
    if (!this.resuming.has(id)) return { changed }
    if (now.status === 'running' && !now.stopping) {
      this.resuming.delete(id)
      const flush = this.input.take(id)
      return flush ? { changed, flush } : { changed }
    }
    if (now.status === 'error' || now.status === 'unconfirmed') return { changed: this.startFailed(id).changed || changed }
    return { changed }
  }

  /** The resume's `start` was refused: the pane shows the error as any stopped pane would; the held input goes. */
  startFailed(id: string): SuspendOutcome {
    this.resuming.delete(id)
    this.input.drop(id)
    return { changed: this.suspended.delete(id) }
  }

  /** The pane is gone. */
  forget(id: string): SuspendOutcome {
    this.resuming.delete(id)
    this.input.drop(id)
    return { changed: this.suspended.delete(id) }
  }
}
