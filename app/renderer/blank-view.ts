// The blank view: what a place that exists but holds nothing yet shows — a calm line and, when there is something to do,
// one action ("Abrir algo aqui"). It is the starting point of the places the person is still laying out (the pads, a new
// desk, a new frame): choosing what goes there comes later, with the action, which hands over to the chooser
// ("O que abrir aqui?", app/renderer/chooser.ts). Without an action it is only the line (a per-panel pad with no panel
// in focus has nothing to act on). Pure DOM, no host: the empty pane (empty-panel.ts) and the side bars (sidebars.ts) use it.
import { icon } from './icons.ts'

export const BLANK_MESSAGE = 'Nada aberto aqui ainda.'
export const BLANK_ACTION = 'Abrir algo aqui'

export interface BlankViewOptions {
  message?: string
  /** The action's click; without it the view has no button. */
  onAction?: () => void
}

export function createBlankView(options: BlankViewOptions = {}): HTMLElement {
  const root = document.createElement('div')
  root.className = 'blank-view'
  root.dataset.blank = options.onAction ? 'target' : 'no-target'
  const text = document.createElement('p')
  text.className = 'blank-message'
  text.textContent = options.message ?? BLANK_MESSAGE
  root.append(text)
  if (options.onAction) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'blank-action'
    button.append(icon('plus'), document.createTextNode(BLANK_ACTION))
    button.addEventListener('click', options.onAction)
    root.append(button)
  }
  return root
}
