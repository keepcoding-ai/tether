// The browser extension's renderer side (E1, skeleton): the pad "Guias" with its empty state (design §5.3), and the `web`
// pane type, a bare frame with its empty-state message. Nothing here knows tabs yet. With `browser.serveToAgents` off the
// pad adds the line that leads to the setting. The desk "Browser" is the core's (contributes.systemDesks).
import type { IContentRenderer, ITabRenderer } from 'dockview-core'
import type { PadView, TetherUi } from '../../app/renderer/ext-api.ts'
import { icon } from '../../app/renderer/icons.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { PAD_ID, WEB_COMPONENT, WEB_PANE_PREFIX, WEB_TAB, manifest } from './manifest.ts'
import { EMPTY_HELP, EMPTY_TITLE, OFF_ACTION, OFF_HELP, WEB_EMPTY } from './rules.ts'

export { manifest }

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

export function activate(ui: TetherUi): IDisposable[] {
  const served = (): boolean => ui.settings.get<boolean>('serveToAgents') === true

  /** The pad's empty state; the off line and its button only while the browser is off for the profile. */
  const drawPad = (root: HTMLElement): void => {
    const box = el('div', 'br-empty')
    const art = el('div', 'br-empty-art')
    art.append(icon('globe-simple'))
    box.dataset.state = 'empty'
    box.append(art, el('h3', 'br-empty-title', EMPTY_TITLE), el('p', 'br-empty-help', EMPTY_HELP))
    if (!served()) {
      const off = el('p', 'br-empty-off', OFF_HELP)
      off.dataset.role = 'off'
      const go = el('button', 'br-empty-go', OFF_ACTION)
      go.type = 'button'
      go.dataset.action = 'open-settings'
      go.addEventListener('click', () => { void ui.commands.run('settings.show') })
      box.append(off, go)
    }
    root.replaceChildren(box)
  }

  class Pad implements PadView {
    readonly element = el('div', 'br-pad')
    private readonly sub: IDisposable
    constructor() {
      this.element.dataset.pad = PAD_ID
      drawPad(this.element)
      this.sub = ui.settings.onChange('serveToAgents', () => drawPad(this.element))
    }
    focus(): void { this.element.querySelector<HTMLElement>('button')?.focus() }
    dispose(): void { this.sub.dispose() }
  }

  class Panel implements IContentRenderer {
    readonly element = el('div', 'br-web')
    constructor() { this.element.append(el('p', 'br-web-empty', WEB_EMPTY)) }
    init(): void {}
    dispose(): void {}
  }
  class Tab implements ITabRenderer {
    readonly element = el('div', 'br-web-tab')
    init(p: { api: { title?: string } }): void { this.element.textContent = p.api.title ?? 'Guia' }
    dispose(): void {}
  }
  const live = new Set<string>()

  return [
    ui.pads.register({ id: PAD_ID, create: () => new Pad() }),
    ui.panes.register({
      id: 'web', idPrefix: WEB_PANE_PREFIX, component: WEB_COMPONENT, tabComponent: WEB_TAB, hasSlot: false, icon: 'globe-simple',
      optionsOf: p => ({ id: p.id, component: WEB_COMPONENT, tabComponent: WEB_TAB, title: p.title ?? 'Guia', params: p.params ?? {} }),
      create: () => new Panel(), createTab: () => new Tab(), has: id => live.has(id),
    }),
  ]
}
