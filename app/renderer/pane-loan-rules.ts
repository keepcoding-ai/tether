// The rules of lending a live pane out of its tab (pane-shell.ts), pure for the unit tests.
//
// Every pane's content sits in a shell the core puts around it at the one place dockview creates panes (main.ts
// `createComponent`). Lending takes the live content out of the shell into a host outside dockview (the quick view's card),
// leaves the "sendo espiada" notice in its place, and gives it back later. The default needs nothing from the pane type:
// the same instance moves (`'lend'`). A type declares only what departs from that:
//   - `peek: 'fresh'`  the quick view builds a COPY instead, through the type's own `create()` with a copy of the tab's
//                      params (pane-fresh.ts): the tab is never touched (a `<webview>` reloads when it changes parent);
//   - `peek: 'none'`   the pane is only revealed, never lent;
//   - `lend`/`takeBack` hooks: the type moves a part of itself (the terminal keeps its status bar in the tab).

/** How a pane type takes part in the quick view; absent = `'lend'`. */
export type PeekMode = 'lend' | 'fresh' | 'none'

/** What lending a pane of a type does: move the shell's content, call the type's hooks, or no lending at all. */
export type LendPlan = 'move' | 'custom' | 'fresh' | 'none'

/** The part of a pane type the plan reads. */
export interface LendDeclaration {
  peek?: PeekMode | undefined
  lend?: unknown
  takeBack?: unknown
}

/** The plan for a pane type; no type (an unknown pane) is never lent. Hooks count only in pairs: a lend that cannot be given back is not one. */
export function paneLendPlan(type: LendDeclaration | undefined): LendPlan {
  if (!type) return 'none'
  if (type.peek === 'fresh' || type.peek === 'none') return type.peek
  return typeof type.lend === 'function' && typeof type.takeBack === 'function' ? 'custom' : 'move'
}

/** Where a pane's content is: in its tab, lent out, or gone with the pane. */
export type LoanState = 'home' | 'lent' | 'gone'

/**
 * What happens to the content: `lend` (a borrower asks), `give-back` (the borrower lets go), `lost` (the content went away
 * from under the borrower: the type's own part disposed while lent), `dispose` (the pane closes, moves to another desk or
 * the window goes; dockview disposes it).
 */
export type LoanEvent = 'lend' | 'give-back' | 'lost' | 'dispose'

/**
 * What the shell does: `move-out` (content to the host, notice in the shell), `move-back` (content back in place of the
 * notice, with the pane's size and visibility told again), `drop` (the borrower hears its loan is over and nothing comes
 * back), `refuse` (nothing changes, the caller hears why), `none`.
 */
export type LoanAct = 'move-out' | 'move-back' | 'drop' | 'refuse' | 'none'

export interface LoanStep { state: LoanState; act: LoanAct }

/**
 * One transition. A pane is lent once at a time (a second borrower is refused, the first keeps it); giving back what is home
 * or gone does nothing; a pane disposed while lent drops the loan (the borrower closes, nothing to give back) and a gone
 * pane stays gone. A desk that hibernates is not an event: its panes stay mounted (only their processes stop), so a loan
 * from it goes on.
 */
export function loanStep(state: LoanState, event: LoanEvent): LoanStep {
  switch (event) {
    case 'lend': return state === 'home' ? { state: 'lent', act: 'move-out' } : { state, act: 'refuse' }
    case 'give-back': return state === 'lent' ? { state: 'home', act: 'move-back' } : { state, act: 'none' }
    case 'lost': return state === 'lent' ? { state: 'home', act: 'drop' } : { state, act: 'none' }
    case 'dispose': return { state: 'gone', act: state === 'lent' ? 'drop' : 'none' }
  }
}

/** Why a lend was refused: the pane is unknown or gone, already lent, or its type does not lend (`none`). */
export type LendRefusal = 'unknown' | 'lent' | 'none'

/**
 * The refusal of a lend in a state, by plan; undefined = it goes ahead. A `fresh` type is never refused for being lent: its
 * tab stays home (the card holds a copy), so a copy can always be made while the pane lives.
 */
export function lendRefusal(state: LoanState | undefined, plan: LendPlan): LendRefusal | undefined {
  if (state === undefined || state === 'gone') return 'unknown'
  if (plan === 'none') return plan
  if (plan === 'fresh') return undefined
  return state === 'lent' ? 'lent' : undefined
}

/** A pane as the copy starts from it: its id, title and params (a dockview panel has the same fields). */
export interface FreshSource {
  id: string
  title?: string | undefined
  params?: Record<string, unknown> | undefined
}

/**
 * What a `fresh` copy of a pane is born with: an id of its own (never the tab's: the type's maps are keyed by it, and the
 * copy must not take the tab's place in them), the tab's title, and a deep copy of its params (what the copy writes to its
 * own params never reaches the tab's, nor the layout). `n` tells copies apart.
 */
export function freshCopyOf(pane: FreshSource, n: number): { id: string; title: string; params: Record<string, unknown> } {
  const params = pane.params ? JSON.parse(JSON.stringify(pane.params)) as Record<string, unknown> : {}
  return { id: `${pane.id}${FRESH_SEPARATOR}${n.toString(36)}`, title: pane.title ?? pane.id, params }
}

/** What separates a copy's id from its tab's (`preview:ab12~peek-1`): no pane id of any type has it. */
export const FRESH_SEPARATOR = '~peek-'
