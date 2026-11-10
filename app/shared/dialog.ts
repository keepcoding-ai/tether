import type { SlotState } from '../../src/daemon/protocol.ts'

// The in-app dialog: one component, one fixed structure (situation → context → choices with consequences).
// Every situation the app puts to the user is a DialogSpec (app/renderer/situations.ts); nothing goes
// through the OS message box. Shared by the renderer (renders it), the main process (names the situation
// it needs answered) and the standalone dialog window shown before the main window exists.

/** How a choice ends for the user: drives colour and order (safe first, destructive last, never the default). */
export type ChoiceTone = 'safe' | 'neutral' | 'destructive'

/** Tone of the situation itself: the icon badge and the title colour. */
export type SituationTone = 'info' | 'warn' | 'danger'

export interface DialogChoice {
  id: string
  icon: string
  /** The action, as a short verb phrase ("Só fechar o painel"). */
  label: string
  /** What happens, in one line, consequence first. */
  consequence: string
  tone: ChoiceTone
}

/** The "which panel / what state" block under the title. */
export interface DialogContext {
  icon: string
  name: string
  /** Secondary lines (folder, session id). */
  lines: string[]
  status?: { label: string; tone: 'ok' | 'warn' | 'dim' | 'err' }
}

/** One entry of a dialog's option list (a profile to switch to, say). */
export interface DialogOption {
  id: string
  icon: string
  label: string
  /** Secondary line in monospace (the args). */
  detail?: string
  /** A short amber mark next to the label ("sem restrições"). */
  mark?: string
  /** What the panel has now: tagged "atual"; choosing it changes nothing, so the cards are disabled on it. */
  current?: boolean
}

export interface DialogSpec {
  /** Situation id: the key of a remembered answer and the test selector (`[data-dialog=…]`). */
  situation: string
  tone: SituationTone
  icon: string
  title: string
  /** One or two sentences stating the situation (optional when the title and context say it all). */
  message?: string
  context?: DialogContext
  /** A picture under the context (the page a decision is about, as it is now): a `data:image/` address only. */
  image?: { src: string; alt: string }
  /**
   * A list to pick from before choosing (radio). `{option}` in a choice's consequence is replaced by the
   * picked option's label; the answer carries the picked id as `option`.
   */
  options?: { label: string; items: DialogOption[]; selected: string }
  /** Ordered by tone by the component; exactly one may be `default`. */
  choices: DialogChoice[]
  /** The choice Enter takes (must be safe or neutral); the first safe choice when omitted. */
  defaultChoice?: string
  /** Label of the cancel button (Esc). Omit it when the choices already include "do nothing". */
  cancelLabel?: string
  /** The "do nothing" choice Esc takes when it is a card (never destructive): it shows the Esc hint. */
  escChoice?: string
  /** "Não perguntar de novo": remembers `choice` for this situation (never a destructive one). */
  remember?: { choice: string; label: string }
  /** A second remember box, exclusive with the first ("sempre encerrar o agente"). */
  rememberAlso?: { choice: string; label: string }
}

export interface DialogAnswer {
  /** The chosen choice id, or 'cancel'. */
  choice: string
  /** The remember box was ticked (only possible with `spec.remember`). */
  remember: boolean
  /** The choice the ticked remember box stands for; absent when none is ticked. */
  rememberChoice?: string
  /** The picked option id (only with `spec.options`). */
  option?: string
}

/** Remembered answers per situation, in settings.json (`confirmations`). */
export type Confirmations = Record<string, string>

/** Situations the main process asks the renderer to put to the user. */
export type MainSituation = 'quit-all' | 'reload-all' | 'restart-daemon' | 'tray-first-close' | 'relaunch-failed'

/**
 * `slots`: the daemon's slots as main sees them, so the dialog does not depend on the renderer having restored yet
 * (the window may have just been recreated from the tray). `message`: the reason, for the situations that carry one.
 */
export interface AskRequest { askId: number; situation: MainSituation; slots?: SlotState[]; message?: string }

/**
 * The remembered answer to apply when a tab with a live agent closes: only the two the dialog offers to remember
 * (a stored 'forget' or anything unknown asks again). Undefined = ask.
 */
export function rememberedClose(spec: DialogSpec, stored: string | undefined): string | undefined {
  if (!stored) return undefined
  return stored === spec.remember?.choice || stored === spec.rememberAlso?.choice ? stored : undefined
}

/** What to persist after the answer: the ticked box counts only when it stands for the choice the person clicked. */
export function choiceToRemember(spec: DialogSpec, answer: { choice: string; remember: boolean; rememberChoice?: string }): string | undefined {
  if (!answer.remember) return undefined
  const ticked = answer.rememberChoice ?? spec.remember?.choice
  const offered = ticked === spec.remember?.choice || ticked === spec.rememberAlso?.choice
  return offered && ticked === answer.choice ? ticked : undefined
}
