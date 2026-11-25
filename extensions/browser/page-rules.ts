// The page in the person's hands, as pure rules (navegador da pessoa, F3). A tab she holds (her own, owner PERSON_OWNER, or an
// agent's she took: control `user`) works whole: its JavaScript dialogs are answered by the tether's own band in the pane (no
// native box, E6), its file chooser opens the tether's chooser, Ctrl+T and Ctrl+L typed in the page reach the tether. A tab with
// the agent (`agent`, or paused) is left exactly as before: dialogs and the chooser wait for the agent's CDP.
// Her dialogs live in the pane, a queue of their own: they never enter the agents' question queue (local network, uploads),
// so they never go in front of an agent's question nor hold it.
import type { Control } from './control-rules.ts'
import { isPersonOwned } from './tab-rules.ts'

export type PageDialogKind = 'alert' | 'confirm' | 'prompt'

/** How much of the page's message and of a prompt's text the band shows and sends back. */
export const PAGE_DIALOG_TEXT_MAX = 2000

/** A dialog of a tab she holds, as the renderer gets it: never the full address, only the page's origin. */
export interface PageDialogAsk {
  id: string
  tabId: string
  kind: PageDialogKind
  message: string
  /** The origin of the page that opened it ('' when it has none). */
  origin: string
  /** A prompt's default text. */
  defaultText?: string
}

/** The tether answers the page itself only while the person holds the tab. */
export const servesPerson = (control: Control | undefined): boolean => control === 'user'

const clip = (s: string): string => (s.length > PAGE_DIALOG_TEXT_MAX ? s.slice(0, PAGE_DIALOG_TEXT_MAX) : s)

const originOf = (url: unknown): string => {
  if (typeof url !== 'string') return ''
  try { const u = new URL(url); return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : '' } catch { return '' }
}

/**
 * CDP's `Page.javascriptDialogOpening` as a dialog the band can show; undefined for anything else (`beforeunload` is accepted by
 * the registry, E6, and never reaches her).
 */
export function pageDialogOf(params: unknown): { kind: PageDialogKind; message: string; origin: string; defaultText?: string } | undefined {
  if (!params || typeof params !== 'object') return undefined
  const p = params as { type?: unknown; message?: unknown; url?: unknown; defaultPrompt?: unknown }
  if (p.type !== 'alert' && p.type !== 'confirm' && p.type !== 'prompt') return undefined
  const message = clip(typeof p.message === 'string' ? p.message : '')
  const defaultText = p.type === 'prompt' && typeof p.defaultPrompt === 'string' && p.defaultPrompt !== '' ? clip(p.defaultPrompt) : undefined
  return { kind: p.type, message, origin: originOf(p.url), ...(defaultText !== undefined ? { defaultText } : {}) }
}

/**
 * The page's answer (`Page.handleJavaScriptDialog`): an alert has only OK; a prompt accepted sends her text (clipped), cancelled
 * sends none (the page gets null).
 */
export function dialogReply(kind: PageDialogKind, accept: unknown, text?: unknown): { accept: boolean; promptText?: string } {
  if (kind === 'alert') return { accept: true }
  const yes = accept === true
  if (kind === 'prompt' && yes) return { accept: true, promptText: clip(typeof text === 'string' ? text : '') }
  return { accept: yes }
}

/**
 * Background throttling of a tab's page: on for her own tabs (out of view they may slow down like any browser's), off for an
 * agent's (the agent works on it while nobody looks).
 */
export const throttlesInBackground = (ownerSlotId: string): boolean => isPersonOwned(ownerSlotId)

/** A shortcut typed with the keyboard in the page that the tether answers: a new tab of hers, or the address field. */
export type PageKey = 'new-tab' | 'address'

/** What `before-input-event` gives (Electron's `Input`). */
export interface PageInput { type?: string; key?: string; control?: boolean; shift?: boolean; alt?: boolean; meta?: boolean; isAutoRepeat?: boolean }

/** Ctrl+T and Ctrl+L, only on a tab she holds: an agent's tab keeps every key for its page. */
export function pageKeyOf(input: PageInput, control: Control | undefined): PageKey | undefined {
  if (!servesPerson(control) || input.type !== 'keyDown' || !input.control || input.shift || input.alt || input.meta || input.isAutoRepeat) return undefined
  const key = (input.key ?? '').toLowerCase()
  return key === 't' ? 'new-tab' : key === 'l' ? 'address' : undefined
}

/** The chooser's options from CDP's `Page.fileChooserOpened` mode: several files only when the input asks for them. */
export function chooserProperties(mode: unknown): ('openFile' | 'multiSelections')[] {
  return mode === 'selectMultiple' ? ['openFile', 'multiSelections'] : ['openFile']
}

/** At most this many files go to one input in one choice. */
export const CHOSEN_FILES_MAX = 100

/**
 * The files she chose still go to the page only if the tab never left her while the chooser was open (the same tab, no control
 * change in between, and she holds it now). Anything else: refused, nothing reaches the page.
 */
export function choiceStands(at: { tab: object; epoch: number }, now: { tab: object | undefined; epoch: number; control: Control | undefined }): boolean {
  return now.tab === at.tab && now.epoch === at.epoch && servesPerson(now.control)
}

/** The chooser's answer as paths: strings only, at most CHOSEN_FILES_MAX; one when the input takes one. */
export function chosenFiles(paths: unknown, multiple: boolean): string[] {
  if (!Array.isArray(paths)) return []
  const out = paths.filter((p): p is string => typeof p === 'string' && p !== '')
  return out.slice(0, multiple ? CHOSEN_FILES_MAX : 1)
}

// ---- texts of the band ----

/** The band's head: who speaks (the page's origin), or a plain word when it has none. */
export const pageDialogHead = (origin: string): string => (origin ? `${origin} diz` : 'A página diz')
export const PAGE_DIALOG_OK = 'OK'
export const PAGE_DIALOG_CANCEL = 'Cancelar'
export const PAGE_DIALOG_FIELD = 'Resposta para a página'
