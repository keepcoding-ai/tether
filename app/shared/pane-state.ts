// The one state of a pane, as every place that shows it says it: the Regency's tree, its state filter and the header of the
// quick view's card. Pure: the facts in, the state, its mark and its words out. A place that shows a pane's state reads it
// here, so the same pane says the same thing everywhere.

/** The four states, each one a filter of the Regency: they cover every pane, one each. */
export type PaneState = 'waiting' | 'busy' | 'idle' | 'asleep'

/** What a free pane carries on top of "livre": its turn ended ("terminou") or its process did ("encerrado"). */
export type PaneMark = 'done' | 'ended'

export interface PaneStateFacts {
  /** The terminal's attention merged with the extensions' seals. */
  attention?: 'done' | 'waiting' | undefined
  busy?: boolean | undefined
  /** The pane itself was hibernated. */
  asleep?: boolean | undefined
  /** Its desk sleeps. */
  deskAsleep?: boolean | undefined
  /** Its process ended (the tab stays). */
  exited?: boolean | undefined
}

export interface PaneStateView {
  state: PaneState
  mark?: PaneMark
  /** "espera você", "trabalhando", "dormindo", "livre", "terminou", "encerrado". */
  text: string
}

export const PANE_STATE_TEXT: Readonly<Record<PaneState, string>> = {
  waiting: 'espera você', busy: 'trabalhando', idle: 'livre', asleep: 'hibernando',
}
export const PANE_MARK_TEXT: Readonly<Record<PaneMark, string>> = { done: 'terminou', ended: 'encerrado' }

/**
 * Who waits for the person comes first (the orange means "needs the person", even in a sleeping desk); then sleep (the pane's
 * or its desk's); then work; everything else is free, with the mark of an ended process or of a turn just done.
 */
export function paneStateOf(f: PaneStateFacts): PaneStateView {
  if (f.attention === 'waiting') return { state: 'waiting', text: PANE_STATE_TEXT.waiting }
  if (f.asleep || f.deskAsleep) return { state: 'asleep', text: PANE_STATE_TEXT.asleep }
  if (f.exited) return { state: 'idle', mark: 'ended', text: PANE_MARK_TEXT.ended }
  if (f.busy) return { state: 'busy', text: PANE_STATE_TEXT.busy }
  if (f.attention === 'done') return { state: 'idle', mark: 'done', text: PANE_MARK_TEXT.done }
  return { state: 'idle', text: PANE_STATE_TEXT.idle }
}

/** Whether a place shows the state at all: a free pane that is not an agent's says nothing (a note is not "livre"), unless its process ended. */
export function stateShown(v: Pick<PaneStateView, 'state' | 'mark'>, agent: boolean): boolean {
  return v.state !== 'idle' || agent || v.mark === 'ended'
}
