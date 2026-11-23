// The names both halves of `agents hibernate` and `agents wake` share (daemon/verbs/hibernate.ts asks, renderer/sleep.ts
// answers). Pure: it imports nothing, so the renderer bundle never pulls the daemon's code.

/** The events the daemon emits to every client (ext `for-agents`): hibernate a pane, hibernate a desk, wake a desk. */
export const HIBERNATE_EVENT = 'hibernate'
export const HIBERNATE_DESK_EVENT = 'hibernate-desk'
export const WAKE_DESK_EVENT = 'wake-desk'
/** The request the app answers every one of them with. */
export const HIBERNATED_REQUEST = 'hibernated'

/** A pane: put to sleep, asleep already, or no pane of that slot in the window. */
export type SleepAnswer = 'asleep' | 'already' | 'no-pane'
/**
 * A desk: `asleep` (the desk and its panes sleep), `partial` (the panes slept, the desk stays awake because some were
 * spared), `already`, `last-desk` (the last awake desk never sleeps), `in-view` (the person is looking at it), `no-desk`.
 */
export type DeskSleepAnswer = 'asleep' | 'partial' | 'already' | 'last-desk' | 'in-view' | 'no-desk'
/** Waking a desk: `woke` (the panes its sleep put down start again), `already` (none to wake), `no-desk`. */
export type DeskWakeAnswer = 'woke' | 'already' | 'no-desk'

export const SLEEP_STATES: readonly string[] = ['asleep', 'already', 'no-pane', 'partial', 'last-desk', 'in-view', 'no-desk', 'woke']

export interface HibernateEvent { ask: string; pane: string }
/** `spare`: panes of the desk the app leaves as they are (the owner's own, the ones with the person, the ones not the owner's). */
export interface DeskSleepEvent { ask: string; desk: string; spare: string[] }
export interface HibernatedArgs { ask: string; state: string; panes?: string[] }
