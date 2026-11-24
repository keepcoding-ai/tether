// The keyboard dispatch as a state machine, pure (main.ts wires it to the document and to the pill): one key at a
// time, with the scope it was pressed in, and what to do about it. The only state is the prefix in progress (the
// first key of a two-key chord, VS Code's "chord mode"): there is no timeout, Esc / a click / losing the focus
// cancel it, and the second key is consumed even when it completes nothing (nothing leaks to the terminal or the
// editor). Two exceptions, both from docs/keybindings-preview.html section C:
//   - inside a terminal, the prefix key pressed twice (Ctrl+K Ctrl+K) sends the key to the program (^K) and leaves;
//   - inside a note, the second key goes to the editor first (Monaco's own Ctrl+K chords: comment, fold…) and the
//     app uses what the editor does not (`editorChord` says whether the editor has it; main.ts triggers it).
import { chordOfEvent, isModifierOnly, keyTable, matches, type Chord, type Keybinding, type KeyLike, type KeyTable, type Where } from './shortcuts.ts'

/** A chord as the key event it matches (the first key of a chord, replayed into the table). */
export const asKey = (c: Chord): KeyLike => ({ ctrlKey: !!c.ctrl, shiftKey: !!c.shift, altKey: !!c.alt, metaKey: !!c.meta, code: c.code })

export type DispatchAction =
  /** Not ours: the target keeps the key. */
  | { type: 'pass' }
  /** Swallow the key and keep waiting (a modifier going down while a prefix is pending). */
  | { type: 'wait' }
  /** The key opened a chord: swallow it, show the pill. */
  | { type: 'prefix'; first: Chord; next: Keybinding[] }
  /** Run a command (one key, or the chord completed). */
  | { type: 'run'; command: string; binding: Keybinding; keys: Chord[] }
  /** Inside a note: the editor's own chord; the host triggers it in the editor. */
  | { type: 'editor'; keys: Chord[] }
  /** The chord completed nothing: swallowed, the pill says so. */
  | { type: 'unknown'; keys: Chord[] }
  /** Esc while waiting. */
  | { type: 'cancel' }
  /** Terminal, the prefix key twice: the key passes to the program (^K) and the wait ends. */
  | { type: 'pass-prefix-key' }

export interface DispatchEvent extends KeyLike { key: string; repeat?: boolean }

export interface DispatcherHooks {
  /** Inside a note: the editor has its own binding for this chord (first, second). */
  editorChord?(first: Chord, second: KeyLike): boolean
  /** Something modal is up: keys are not ours (a pending prefix is dropped). */
  modalOpen?(): boolean
  table?(): KeyTable
  /**
   * A surface limits the app's chords (the peek card): returns which commands still fire; the rest pass to the target as
   * with a modal, and a two-key chord never opens. Undefined = no limit.
   */
  keeps?(): ((command: string) => boolean) | undefined
}

export class ChordDispatcher {
  /** The first key of a chord in progress. */
  waiting: Chord | undefined
  /** Where the prefix was pressed. */
  waitingWhere: Where | undefined
  /** The prefix opened under a `keeps` limit (toward a kept command): its second key completes it under the same limit. */
  private waitingKept = false
  private readonly hooks: DispatcherHooks

  constructor(hooks: DispatcherHooks = {}) {
    this.hooks = hooks
  }

  private get table(): KeyTable { return this.hooks.table ? this.hooks.table() : keyTable() }

  cancel(): void {
    this.waiting = undefined
    this.waitingWhere = undefined
    this.waitingKept = false
  }

  /** A keydown in a scope. */
  press(ev: DispatchEvent, where: Where): DispatchAction {
    if (this.hooks.modalOpen?.()) { this.cancel(); return { type: 'pass' } }
    const keeps = this.hooks.keeps?.()
    if (keeps && !(this.waiting && this.waitingKept)) {
      // A prefix pending from before the limit is dropped. Under the limit a two-key chord opens only outside a terminal
      // (there ^K stays the program's) and only toward a kept command (a screen's own chord in the card: Ctrl+K Ctrl+K).
      this.cancel()
      if (isModifierOnly(ev.code)) return { type: 'pass' }
      const r = this.table.resolve([ev], where)
      if (r.kind === 'prefix' && where !== 'terminal') {
        const next = r.next.filter(b => keeps(b.command))
        if (next.length) {
          this.waiting = chordOfEvent(ev)
          this.waitingWhere = where
          this.waitingKept = true
          return { type: 'prefix', first: this.waiting, next }
        }
      }
      return r.kind === 'command' && keeps(r.command) ? { type: 'run', command: r.command, binding: r.binding, keys: [chordOfEvent(ev)] } : { type: 'pass' }
    }
    if (this.waiting) {
      if (isModifierOnly(ev.code)) return { type: 'wait' }
      if (ev.key === 'Escape' && !ev.ctrlKey && !ev.altKey && !ev.shiftKey && !ev.metaKey) { this.cancel(); return { type: 'cancel' } }
      const first = this.waiting
      const keys = [first, chordOfEvent(ev)]
      this.cancel()
      if (where === 'terminal' && matches(first, ev)) return { type: 'pass-prefix-key' }
      if (where === 'note' && this.hooks.editorChord?.(first, ev)) return { type: 'editor', keys }
      const r = this.table.resolve([asKey(first), ev], where)
      if (r.kind === 'command' && (!keeps || keeps(r.command))) return { type: 'run', command: r.command, binding: r.binding, keys }
      return { type: 'unknown', keys }
    }
    if (isModifierOnly(ev.code)) return { type: 'pass' }
    const r = this.table.resolve([ev], where)
    if (r.kind === 'prefix') {
      this.waiting = chordOfEvent(ev)
      this.waitingWhere = where
      return { type: 'prefix', first: this.waiting, next: r.next }
    }
    if (r.kind === 'command') return { type: 'run', command: r.command, binding: r.binding, keys: [chordOfEvent(ev)] }
    return { type: 'pass' }
  }
}

/** The scope of a keydown by its target: a terminal (xterm), a note's editor (Monaco), or the window. */
export function scopeOf(target: unknown): Where {
  const el = target as { closest?: (sel: string) => unknown } | null | undefined
  if (!el || typeof el.closest !== 'function') return 'window'
  if (el.closest('.xterm')) return 'terminal'
  if (el.closest('[data-editor]')) return 'note'
  return 'window'
}
