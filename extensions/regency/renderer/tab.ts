// The Regency's tab in the app's dockview: fixed (no close), the pin says so. The pane (pane.ts) does not know it.
import type { ITabRenderer, TabPartInitParameters } from 'dockview-core'
import { icon } from '../../../app/renderer/icons.ts'
import { REGENCY_TITLE } from '../manifest.ts'
import { el } from './columns.ts'

export class RegencyTab implements ITabRenderer {
  readonly element: HTMLElement

  constructor() {
    this.element = el('div', 'tether-tab regency')
    const kind = el('span', 'kind')
    kind.append(icon('columns'))
    kind.title = REGENCY_TITLE
    const pin = el('span', 'kind rg-pin')
    pin.append(icon('push-pin'))
    pin.title = 'Guia fixa da Regência'
    this.element.append(kind, el('span', 'text', REGENCY_TITLE), pin)
    this.element.title = `${REGENCY_TITLE}\nQuem espera você, os canais e todas as mesas`
  }

  init(_p: TabPartInitParameters): void {}

  dispose(): void {}
}
