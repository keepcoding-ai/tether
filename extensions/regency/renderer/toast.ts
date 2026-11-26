// The Regency's brief notice ("Terminal criado em Mesa 2 · Espiar"): not modal, it never takes the keyboard, a screen reader
// reads it (a polite live region that exists before the text comes), and it goes by itself. Hovered or with the keyboard in it,
// it waits; one at a time (a newer notice takes the place of the older).
import { el } from './columns.ts'

/** How long a notice stays when nobody is on it. */
export const TOAST_MS = 6_000

export interface ToastAction { label: string; tip: string; run(): void }

export class RegencyToast {
  readonly element: HTMLElement
  private readonly text: HTMLElement
  private readonly actions: HTMLElement
  private timer: ReturnType<typeof setTimeout> | undefined
  private held = false

  constructor() {
    this.element = el('div', 'rg-toast')
    this.element.setAttribute('role', 'status')
    this.element.setAttribute('aria-live', 'polite')
    this.element.hidden = true
    this.text = el('span', 'rg-toast-t')
    this.actions = el('span', 'rg-toast-a')
    this.element.append(this.text, this.actions)
    const hold = (on: boolean): void => { this.held = on; if (!on) this.arm() }
    this.element.addEventListener('pointerenter', () => hold(true))
    this.element.addEventListener('pointerleave', () => hold(false))
    this.element.addEventListener('focusin', () => hold(true))
    this.element.addEventListener('focusout', ev => { if (!this.element.contains(ev.relatedTarget as Node | null)) hold(false) })
  }

  /** What is shown now (the E2E reads it): the text and the actions' labels; undefined when hidden. */
  get shown(): { text: string; actions: string[] } | undefined {
    if (this.element.hidden) return undefined
    return { text: this.text.textContent ?? '', actions: [...this.actions.querySelectorAll('button')].map(b => b.textContent ?? '') }
  }

  show(text: string, action?: ToastAction): void {
    this.text.textContent = text
    const buttons: HTMLElement[] = []
    if (action) {
      const b = el('button', 'rg-btn rg-toast-b', action.label)
      b.type = 'button'
      b.title = action.tip
      b.addEventListener('click', () => { this.hide(); action.run() })
      buttons.push(b)
    }
    const x = el('button', 'rg-toast-x', '×')
    x.type = 'button'
    x.title = 'Fechar o aviso'
    x.setAttribute('aria-label', 'Fechar o aviso')
    x.addEventListener('click', () => this.hide())
    this.actions.replaceChildren(...buttons, x)
    this.element.hidden = false
    this.held = false
    this.arm()
  }

  hide(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.element.hidden = true
    this.held = false
  }

  dispose(): void {
    this.hide()
    this.element.remove()
  }

  private arm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (this.held || this.element.hidden) return
    this.timer = setTimeout(() => this.hide(), TOAST_MS)
  }
}
