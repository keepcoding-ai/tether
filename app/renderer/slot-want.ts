// The slot's lifecycle intent (SlotState.want, kept by tetherd) is the source of "hibernated" and "suspended": the layout's
// `asleepPanes`/`suspendedPanes` only follow it. A slot without `want` predates the field (legacy): there the layout still
// decides, and the app migrates the layout's marks to the slot once (`set-want`). Pure: no DOM, no daemon.
import type { SlotState } from '../../src/daemon/protocol.ts'
import { isLiveStatus } from './suspend.ts'

/** What a slot's state says of its pane: hibernated, suspended, or awake (neither); undefined = nothing to change. */
export type WantMark = 'asleep' | 'suspended' | 'awake'

/**
 * The mark a state of the slot sets (`before`: the state the app had). A live slot changes nothing here: its stop may still be
 * on its way (the hibernation marked the pane first) and a waking slot is handled by the stopped -> live edge. A stopped slot
 * follows its intent: asleep, suspended, or awake when the intent turned to run/ended (a slot whose intent did not change keeps
 * the pane's mark, so a mark set just before its `stop` is not undone by a state already in flight).
 */
export function wantMark(before: SlotState | undefined, now: SlotState): WantMark | undefined {
  if (now.want === undefined || isLiveStatus(now)) return undefined
  if (now.want === 'asleep' || now.want === 'suspended') return now.want
  return before?.want !== undefined && before.want !== now.want ? 'awake' : undefined
}

/** A `set-want` the app owes the daemon: a layout mark the slot does not have yet. */
export interface WantMigration { slotId: string; want: 'asleep' | 'suspended' }

export interface LayoutWants {
  asleep: Set<string>
  suspended: Set<string>
  /** One `set-want` per slot whose intent differs from the layout's mark (or is absent). */
  migrate: WantMigration[]
}

/**
 * The layout's marks reconciled with the daemon's slots at load. A layout mark of a stopped slot whose intent differs (or is
 * absent) stays and is migrated to the slot (hibernated wins over suspended, as the layout always read it). A stopped slot whose
 * intent is asleep/suspended gets that mark even when the layout lacks it. A live slot is left as the layout has it (never told
 * to sleep while it runs). Ids without a slot are left out.
 */
export function reconcileLayoutWants(slots: ReadonlyMap<string, SlotState>, asleep: Iterable<string>, suspended: Iterable<string>): LayoutWants {
  const out: LayoutWants = { asleep: new Set(), suspended: new Set(), migrate: [] }
  for (const id of asleep) if (slots.has(id)) out.asleep.add(id)
  for (const id of suspended) if (slots.has(id) && !out.asleep.has(id)) out.suspended.add(id)
  for (const s of slots.values()) {
    if (isLiveStatus(s)) continue
    const id = s.slotId
    const mark = out.asleep.has(id) ? 'asleep' : out.suspended.has(id) ? 'suspended' : undefined
    if (mark) {
      if (s.want !== mark) out.migrate.push({ slotId: id, want: mark })
    } else if (s.want === 'asleep') out.asleep.add(id)
    else if (s.want === 'suspended') out.suspended.add(id)
  }
  return out
}

/**
 * The app starts a pane on its own only for a legacy slot (no `want`): a slot with an intent is the daemon's to relaunch at
 * boot, so starting it here would race that. Hibernated and suspended panes, and live ones, are never started.
 */
export function appStartsPane(slot: SlotState | undefined, asleep: boolean, suspended: boolean, exited: boolean): boolean {
  return slot !== undefined && slot.want === undefined && !asleep && !suspended && exited
}
