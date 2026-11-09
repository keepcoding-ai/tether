// The probe's renderer entry: a pane type whose content is an empty box tied to a surface of the probe's main side
// (`ui.surfaces.attach`). The E2E reaches it as `window.__tether.ext['surface-probe']`. Never shipped.
import type { IContentRenderer, GroupPanelPartInitParameters, ITabRenderer } from 'dockview-core'
import type { TetherUi, SurfaceBinding, SurfaceHostState, SurfaceShieldEvent } from '../../../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../../../app/shared/vscode-lifecycle.ts'
import type { SurfaceProbeChannels } from './ipc.ts'
import { manifest, PANEL_COMPONENT, PANEL_PREFIX, PANEL_TAB } from './manifest.ts'

export { manifest }

interface Mounted { surface: string; element: HTMLElement; binding: SurfaceBinding; states: SurfaceHostState[]; shield: SurfaceShieldEvent[] }

export function activate(ui: TetherUi): IDisposable[] {
  const ipc = ui.ipc<SurfaceProbeChannels>()
  const mounted = new Map<string, Mounted>()
  let n = 0

  class Panel implements IContentRenderer {
    readonly element = document.createElement('div')
    private id = ''
    constructor() {
      this.element.style.cssText = 'position:absolute;inset:0;background:#123;outline:1px dashed #6af'
    }
    init(p: GroupPanelPartInitParameters): void {
      this.id = p.api.id
      const surface = (p.params as { surface?: string }).surface
      if (!surface) return
      const binding = ui.surfaces.attach(surface, this.element)
      const m: Mounted = { surface, element: this.element, binding, states: [], shield: [] }
      binding.onState(s => { m.states.push(s) })
      binding.onShieldInput(i => { m.shield.push(i) })
      mounted.set(this.id, m)
    }
    dispose(): void {
      const m = mounted.get(this.id)
      if (m?.element === this.element) { m.binding.dispose(); mounted.delete(this.id) }
    }
  }
  class Tab implements ITabRenderer {
    readonly element = document.createElement('div')
    init(p: { api: { title?: string } }): void { this.element.textContent = p.api.title ?? 'Superfície' }
  }

  ui.test.expose('open', async (surface?: string, target?: { level: 'pane' | 'frame' | 'desk'; placement: string }) => {
    const sid = surface ?? await ipc.invoke('create')
    ui.panes.open({ id: `${PANEL_PREFIX}${++n}-${Date.now()}`, component: PANEL_COMPONENT, tabComponent: PANEL_TAB, title: 'Superfície', params: { surface: sid } }, target ? { target: target as never } : {})
    return sid
  })
  /** Per pane id: the surface, the element's rectangle in CSS px, and what main reported. */
  ui.test.expose('panes', () => [...mounted].map(([id, m]) => {
    const r = m.element.getBoundingClientRect()
    return { id, surface: m.surface, rect: { x: r.left, y: r.top, width: r.width, height: r.height }, state: m.binding.state(), states: m.states.length, shield: m.shield }
  }))
  ui.test.expose('activate', (id: string) => { ui.panes.find(id)?.api.setActive() })
  ui.test.expose('close', (id: string) => { ui.panes.close(id) })
  ui.test.expose('refresh', () => { for (const m of mounted.values()) m.binding.refresh() })

  return [ui.panes.register({
    id: 'surface-probe', idPrefix: PANEL_PREFIX, component: PANEL_COMPONENT, tabComponent: PANEL_TAB, hasSlot: false, icon: 'question',
    optionsOf: p => ({ id: p.id, component: PANEL_COMPONENT, tabComponent: PANEL_TAB, title: p.title ?? 'Superfície', params: p.params ?? {} }),
    create: () => new Panel(), createTab: () => new Tab(), has: id => mounted.has(id),
  })]
}
