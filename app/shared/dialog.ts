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

export interface DialogSpec {
  /** Situation id: the key of a remembered answer and the test selector (`[data-dialog=…]`). */
  situation: string
  tone: SituationTone
  icon: string
  title: string
  /** One or two sentences stating the situation (optional when the title and context say it all). */
  message?: string
  context?: DialogContext
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
}

export interface DialogAnswer {
  /** The chosen choice id, or 'cancel'. */
  choice: string
  /** The remember box was ticked (only possible with `spec.remember`). */
  remember: boolean
}

/** Remembered answers per situation, in settings.json (`confirmations`). */
export type Confirmations = Record<string, string>

/** Situations the main process asks the renderer to put to the user. */
export type MainSituation = 'quit-all' | 'reload-all'

export interface AskRequest { askId: number; situation: MainSituation }
