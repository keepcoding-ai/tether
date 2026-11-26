// The TV's rail of "Sistema", its summary at a glance over the sections (system-rules.ts systemSummary): each process with
// its state, the notice of a process that fell (the dot's red, never the orange), the rondas that are on. Each heading opens
// its section below it; the rows are words, not targets.
import type { SystemSummary } from '../system-rules.ts'
import { el, glyph } from './columns.ts'

function heading(section: 'processes' | 'ronda', label: string, count: number, name: string): HTMLButtonElement {
  const b = el('button', 'rg-sum-h')
  b.type = 'button'
  b.dataset.action = `sys:${section}`
  b.title = `Abrir a seção ${label} abaixo`
  const g = glyph(name, label)
  g.setAttribute('aria-hidden', 'true')
  b.append(g, el('span', 'rg-sum-ht', label), el('span', 'cnt dim', String(count)))
  return b
}

/** Draws the summary in `host` (the whole of it: it is small and only drawn when it changed). */
export function paintSummary(host: HTMLElement, sum: SystemSummary): void {
  const parts: HTMLElement[] = []
  if (sum.fell !== undefined) {
    const fell = el('p', 'rg-sum-fell')
    fell.setAttribute('role', 'status')
    fell.append(el('span', 'rg-sys-dot'), el('span', '', sum.fell))
    parts.push(fell)
  }
  parts.push(heading('processes', 'Processos', sum.procs.length, 'pulse'))
  if (sum.procsEmpty !== undefined) parts.push(el('p', 'rg-sum-e', sum.procsEmpty))
  else {
    const list = el('ul', 'rg-sum-l')
    list.setAttribute('aria-label', 'Processos e o seu estado')
    for (const p of sum.procs) {
      const li = el('li', `rg-sum-r ${p.intent}`)
      li.dataset.proc = p.name
      li.append(el('span', 'rg-sr-dot'), el('span', 'rg-sum-n', p.name), el('span', 'rg-sum-s', p.state))
      li.title = `${p.name}: ${p.state}`
      list.append(li)
    }
    parts.push(list)
  }
  parts.push(heading('ronda', 'Rondas ligadas', sum.rondas.length, 'timer'))
  if (sum.rondasEmpty !== undefined) parts.push(el('p', 'rg-sum-e', sum.rondasEmpty))
  else {
    const list = el('ul', 'rg-sum-l')
    list.setAttribute('aria-label', 'Rondas ligadas')
    for (const r of sum.rondas) {
      const li = el('li', 'rg-sum-r ronda')
      li.append(el('span', 'rg-sum-n', r.name), el('span', 'rg-sum-s', r.text))
      li.title = `${r.name}: ${r.text}`
      list.append(li)
    }
    parts.push(list)
  }
  // A heading with the keyboard keeps it across the repaint.
  const active = document.activeElement
  const had = active instanceof HTMLElement && host.contains(active) ? active.dataset.action : undefined
  host.replaceChildren(...parts)
  if (had) host.querySelector<HTMLElement>(`[data-action="${had}"]`)?.focus({ preventScroll: true })
}
