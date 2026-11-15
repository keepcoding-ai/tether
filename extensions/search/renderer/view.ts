// The search pad's view. Skeleton: an empty `div.srch`; the fields, the widget and the results tree come in the next steps.
import type { PadHost, PadView, TetherUi } from '../../../app/renderer/ext-api.ts'

export class SearchView implements PadView {
  readonly element: HTMLElement

  constructor(_ui: TetherUi, _host: PadHost) {
    this.element = document.createElement('div')
    this.element.className = 'srch'
    this.element.tabIndex = -1
  }

  focus(): void {
    this.element.focus()
  }

  dispose(): void {
    this.element.remove()
  }
}
