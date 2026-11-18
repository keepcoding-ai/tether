// The context extension's renderer side: the pad "Contexto" (right bar). It follows the focused panel and, while it is
// visible AND the window has the focus, pulls one snapshot every 2 s (and at once on a panel switch); hidden or blurred,
// it does nothing (no timer runs). Each of its four sections (header, composition, fixed weight, curve) carries a
// signature and is repainted only when that changes; the tables are rebuilt only when their data or sort changes.
import type { Disposable, PadView, TetherUi } from '../../app/renderer/ext-api.ts'
import { icon } from '../../app/renderer/icons.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { ContextCategory, ContextReport } from '../../src/context/context-report.ts'
import type { ContextChannels, InventoryView, LiveView, MeasuredView, MeasureReply, SnapshotReply, TranscriptView } from './ipc.ts'
import {
  agentLabel, baseName, compositionSegments, curveGeometry, diffSections, estimateNote, estimatedCategories, fmtPct, measuredInventory, fmtTokens, fmtUsd, mcpByServer, memoryTitle, nextSort,
  nextTarget, sameTarget, sectionSigs, skillSortValue, sortRows, topConsumers, turnLabel, usageLevel, type Section, type SortState, type Target,
} from './rules.ts'
import { manifest, OPEN_COMMAND, PAD_ID } from './manifest.ts'

export { manifest }

const POLL_MS = 2000
const ROW_LIMIT = 30
const SVG_NS = 'http://www.w3.org/2000/svg'
const CHART_W = 320
const CHART_H = 96

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  return e
}
const hhmm = (ms: number): string => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

type Measure =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'error'; message: string }
  | { state: 'done'; report: ContextReport; measuredAt: number; inventoryKey: string }

interface Col { key: string; label: string; num?: boolean }
type TableName = 'skills' | 'agents' | 'mcp' | 'tools' | 'memory'

export function activate(ui: TetherUi): IDisposable[] {
  const ipc = ui.ipc<ContextChannels>()
  let target: Target
  const syncTarget = (info: Parameters<typeof nextTarget>[1]): void => {
    const next = nextTarget(target, info)
    if (sameTarget(next, target)) return
    target = next
    pad?.targetChanged()
  }
  let pad: Pad | undefined
  // Never at activation: the desks do not exist yet then and `activeId()` throws (that failed the whole extension).
  const syncFromActive = (): void => {
    const id = ui.panes.activeId()
    if (id) syncTarget(ui.panes.describe(id))
  }

  class Pad implements PadView {
    readonly element = el('div', 'cx-pad')
    private readonly msg = el('div', 'cx-msg')
    private readonly body = el('div', 'cx-body')
    private readonly sec: Record<Section, HTMLElement> = { head: el('section', 'cx-sec cx-head'), compose: el('section', 'cx-sec'), fixed: el('section', 'cx-sec'), curve: el('section', 'cx-sec') }
    private visible = false
    private focused = document.hasFocus()
    private timer: ReturnType<typeof setInterval> | undefined
    private busy = false
    private epoch = 0
    // What the last snapshots delivered (reset when the target changes).
    private live: LiveView | undefined
    private transcript: TranscriptView | undefined
    private inventory: InventoryView | undefined
    private measured: MeasuredView | undefined
    private canMeasure = true
    private sigs: Record<Section, string> | undefined
    private measures = new Map<string, Measure>()
    private sorts: Record<TableName, SortState> = {
      skills: { key: 'prompt', dir: 'desc' }, agents: { key: 'prompt', dir: 'desc' }, mcp: { key: 'tokens', dir: 'desc' },
      tools: { key: 'tokens', dir: 'desc' }, memory: { key: 'tokens', dir: 'desc' },
    }
    private expanded = new Set<TableName>()
    private cursor: number | undefined
    private readonly offs: (() => void)[] = []

    constructor() {
      this.element.dataset.pad = PAD_ID
      this.body.append(this.sec.head, this.sec.compose, this.sec.fixed, this.sec.curve)
      this.element.append(this.msg, this.body)
      const sync = (): void => { this.focused = document.hasFocus(); this.syncTimer() }
      window.addEventListener('focus', sync)
      window.addEventListener('blur', sync)
      document.addEventListener('visibilitychange', sync)
      this.offs.push(() => { window.removeEventListener('focus', sync); window.removeEventListener('blur', sync); document.removeEventListener('visibilitychange', sync) })
      syncFromActive()
      this.showTarget()
    }

    focus(): void { this.element.querySelector<HTMLElement>('button')?.focus() }
    setVisible(v: boolean): void { this.visible = v; this.syncTimer() }
    dispose(): void { this.stop(); for (const o of this.offs) o(); pad = undefined }

    targetChanged(): void {
      this.epoch++
      this.live = undefined; this.transcript = undefined; this.inventory = undefined; this.measured = undefined; this.sigs = undefined; this.cursor = undefined; this.canMeasure = true
      this.showTarget()
      this.syncTimer()
    }

    // ---------- polling ----------

    private get running(): boolean { return this.visible && this.focused && !document.hidden && target?.kind === 'agent' }

    private syncTimer(): void {
      if (this.running) {
        if (!this.timer) { this.timer = setInterval(() => { void this.tick() }, POLL_MS); void this.tick() }
      } else this.stop()
    }

    private stop(): void {
      if (this.timer) { clearInterval(this.timer); this.timer = undefined }
    }

    private async tick(): Promise<void> {
      const t = target
      if (this.busy || t?.kind !== 'agent') return
      this.busy = true
      const epoch = this.epoch
      try {
        const r = await ipc.invoke('snapshot', {
          slotId: t.slotId, cwd: t.cwd,
          ...(this.transcript ? { rev: this.transcript.rev } : {}), ...(this.inventory ? { invKey: this.inventory.key } : {}),
        })
        if (epoch === this.epoch) this.apply(r)
      } catch {
        if (epoch === this.epoch) this.say('Não consegui ler o contexto agora. Vou tentar de novo.')
      } finally {
        this.busy = false
      }
    }

    // ---------- painting ----------

    private say(text: string | undefined): void {
      this.msg.textContent = text ?? ''
      this.msg.hidden = !text
      this.body.hidden = !!text
    }

    private showTarget(): void {
      if (!target) { this.say('Foque o painel de um agente Claude, Codex ou Soul para ver o contexto dele.'); return }
      if (target.kind === 'unsupported') {
        this.say(target.why === 'shell' ? 'Este painel é um terminal comum: não há contexto de agente para mostrar.' : `O contexto só é inspecionado para agentes Claude, Codex e Soul (este painel é ${target.agent}).`)
        return
      }
      this.say(this.live || this.transcript ? undefined : 'Lendo o contexto do agente…')
    }

    private apply(r: SnapshotReply): void {
      if (!r.supported) {
        this.say(r.reason === 'not-claude' ? 'O contexto só é inspecionado para agentes Claude, Codex e Soul.' : 'Não encontrei este agente para ler o contexto.')
        return
      }
      const heldRev = this.transcript?.rev ?? ''
      const heldInv = this.inventory?.key ?? ''
      this.live = r.live
      this.canMeasure = r.canMeasure
      this.measured = r.measured
      if (r.transcript && r.transcript !== 'same') this.transcript = r.transcript
      else if (!r.transcript) this.transcript = undefined
      if (r.inventory && r.inventory !== 'same') this.inventory = r.inventory
      else if (!r.inventory) this.inventory = undefined
      const sigs = sectionSigs(r, { inventoryKey: heldInv, transcriptRev: heldRev })
      const changed = diffSections(this.sigs, sigs)
      this.sigs = sigs
      this.say(undefined)
      for (const s of changed) this.paint(s)
    }

    private paint(s: Section): void {
      switch (s) {
        case 'head': this.paintHead(); break
        case 'compose': this.paintCompose(); break
        case 'fixed': this.paintFixed(); break
        case 'curve': this.paintCurve(); break
      }
    }

    private paintHead(): void {
      const root = this.sec.head
      const l = this.live
      const tr = this.transcript
      const kids: Node[] = []
      if (!l) {
        kids.push(el('div', 'cx-dim', `Sem dados ao vivo ainda: o ${agentLabel(target?.kind === 'agent' ? target.agent : undefined)} grava o uso depois da primeira resposta.`))
      } else {
        const meta = el('div', 'cx-meta')
        meta.append(el('strong', '', l.model))
        if (l.effort) meta.append(el('span', 'cx-chip', `esforço ${l.effort}`))
        kids.push(meta)
        const level = usageLevel(l.usedPct)
        const bar = el('div', 'cx-bar')
        bar.setAttribute('role', 'progressbar')
        bar.setAttribute('aria-label', 'Uso da janela de contexto')
        bar.setAttribute('aria-valuemin', '0')
        bar.setAttribute('aria-valuemax', '100')
        if (l.usedPct !== undefined) bar.setAttribute('aria-valuenow', String(Math.round(l.usedPct)))
        const fill = el('div', 'cx-bar-fill')
        fill.dataset.level = level
        fill.style.width = `${Math.max(0, Math.min(100, l.usedPct ?? 0))}%`
        bar.append(fill)
        kids.push(bar)
        const used = l.usedTokens !== undefined ? fmtTokens(l.usedTokens) : '–'
        const win = l.windowSize !== undefined ? fmtTokens(l.windowSize) : '–'
        const line = el('div', 'cx-line')
        line.append(el('span', 'cx-num', `${used} / ${win} tokens${l.usedPct !== undefined ? ` (${fmtPct(l.usedPct)})` : ''}`))
        if (l.costUsd !== undefined) line.append(el('span', 'cx-dim', `sessão ${fmtUsd(l.costUsd)}`))
        else if (l.credits !== undefined) line.append(el('span', 'cx-dim', `créditos ${fmtTokens(l.credits)}`))
        kids.push(line)
        if (l.exceeds200k) kids.push(el('div', 'cx-warn', 'Passou de 200k tokens: a sessão está na faixa de contexto longo.'))
      }
      if (tr && tr.cacheHit !== undefined) {
        const row = el('div', 'cx-line')
        row.append(el('span', '', `Cache: ${fmtPct(tr.cacheHit * 100)} do último turno`))
        if (tr.cold) row.append(el('span', 'cx-chip cx-cold', 'frio'))
        kids.push(row)
        if (tr.cold) kids.push(el('div', 'cx-dim', 'O último turno não leu nada do cache: o prompt foi reprocessado por inteiro.'))
      }
      root.replaceChildren(...kids)
    }

    private measureOf(): Measure {
      const t = target
      return (t?.kind === 'agent' ? this.measures.get(t.slotId) : undefined) ?? { state: 'idle' }
    }

    private paintCompose(): void {
      const root = this.sec.compose
      const m = this.measureOf()
      const head = el('div', 'cx-sec-head')
      head.append(el('h3', '', 'Composição'))
      const btn = el('button', 'cx-btn', m.state === 'busy' ? 'Medindo…' : m.state === 'done' ? 'Medir de novo' : 'Medir')
      btn.type = 'button'
      btn.disabled = m.state === 'busy'
      btn.addEventListener('click', () => { void this.measure(m.state === 'done') })
      if (this.canMeasure) head.append(btn)
      const kids: Node[] = [head]

      let cats: readonly ContextCategory[] | undefined
      let note = ''
      let max = this.live?.windowSize
      if (this.measured) {
        cats = this.measured.categories
        max = this.measured.maxTokens ?? max
        note = `medido pelo soul no último turno${this.measured.at ? ` (${hhmm(this.measured.at)})` : ''}`
      } else if (m.state === 'done') {
        cats = m.report.categories
        max = m.report.maxTokens ?? max
        const stale = this.inventory && this.inventory.key !== m.inventoryKey
        note = `medido pelo /context (estimativa do Claude Code) às ${hhmm(m.measuredAt)}${stale ? ' · desatualizado: os arquivos mudaram desde então' : ''}`
      } else if (this.inventory) {
        cats = estimatedCategories(this.inventory)
        note = estimateNote(this.canMeasure, target?.kind === 'agent' ? target.agent : undefined)
      }
      if (m.state === 'error') kids.push(el('div', 'cx-err', m.message))
      if (m.state === 'busy') kids.push(el('div', 'cx-dim', 'Rodando o /context do Claude; leva alguns segundos.'))
      if (cats) {
        const segs = compositionSegments(cats, max)
        const stack = el('div', 'cx-stack')
        stack.setAttribute('role', 'img')
        stack.setAttribute('aria-label', segs.map(s => `${s.name} ${fmtPct(s.pct)}`).join(', '))
        const list = el('ul', 'cx-legend')
        segs.forEach((s, i) => {
          const seg = el('span', 'cx-seg')
          seg.dataset.kind = s.kind
          seg.dataset.i = String(i % 8)
          seg.style.flexGrow = String(Math.max(s.pct, 0.4))
          seg.title = `${s.name}: ${fmtTokens(s.tokens)} (${fmtPct(s.pct)})`
          stack.append(seg)
          const li = el('li', '')
          const dot = el('span', 'cx-dot')
          dot.dataset.kind = s.kind
          dot.dataset.i = String(i % 8)
          li.append(dot, el('span', 'cx-legend-name', s.name), el('span', 'cx-num', fmtTokens(s.tokens)), el('span', 'cx-dim cx-num', fmtPct(s.pct)))
          list.append(li)
        })
        kids.push(stack, list, el('div', 'cx-note', note))
      } else if (m.state === 'idle') kids.push(el('div', 'cx-dim', 'Sem dados de arquivos ainda.'))
      root.replaceChildren(...kids)
    }

    private async measure(force: boolean): Promise<void> {
      const t = target
      if (t?.kind !== 'agent') return
      this.measures.set(t.slotId, { state: 'busy' })
      while (this.measures.size > 8) this.measures.delete(this.measures.keys().next().value as string)
      this.paintCompose()
      let r: MeasureReply
      try { r = await ipc.invoke('measure', { slotId: t.slotId, cwd: t.cwd, force }) } catch { r = { supported: true, ok: false, message: 'A medição falhou antes de começar.' } }
      let next: Measure
      if (!r.supported) next = { state: 'error', message: 'Este agente não pode ser medido.' }
      else if (!r.ok) next = { state: 'error', message: r.message }
      else next = { state: 'done', report: r.report, measuredAt: r.measuredAt, inventoryKey: r.inventoryKey }
      this.measures.set(t.slotId, next)
      if (target?.kind === 'agent' && target.slotId === t.slotId) { this.paintCompose(); this.paintFixed() }
    }

    // ---------- fixed weight ----------

    private paintFixed(): void {
      const root = this.sec.fixed
      const mv = this.measured
      const inv = mv ? measuredInventory(mv) : this.inventory
      const head = el('h3', '', 'Peso fixo')
      if (!inv) { root.replaceChildren(head, el('div', 'cx-dim', 'Lendo os arquivos do agente…')); return }
      const m = this.measureOf()
      const tools = mv ? mv.mcpTools.map(t => ({ name: t.name, source: t.server, tokens: t.tokens })) : m.state === 'done' ? m.report.mcpTools : undefined
      const byServer = tools ? mcpByServer(tools) : undefined
      const kids: Node[] = [head]

      const top = topConsumers(inv, 5, byServer)
      if (top.length) {
        const box = el('div', 'cx-top')
        box.append(el('h4', '', 'Maiores consumidores'))
        const ol = el('ol', 'cx-toplist')
        for (const c of top) {
          const li = el('li', '')
          li.append(el('span', 'cx-chip', c.group), el('span', 'cx-legend-name', c.label), el('span', 'cx-num', fmtTokens(c.tokens)))
          ol.append(li)
        }
        box.append(ol)
        kids.push(box)
      }

      kids.push(this.group(memoryTitle(target?.kind === 'agent' ? target.agent : undefined), inv.memory.length, 'memory', [{ key: 'name', label: 'Arquivo' }, { key: 'kind', label: 'Tipo' }, { key: 'tokens', label: 'Tokens', num: true }],
        inv.memory.map(f => ({ name: baseName(f.path), kind: f.kind, tokens: f.tokens, title: f.path }))))
      kids.push(this.group('Skills', inv.skills.length, 'skills', [{ key: 'name', label: 'Nome' }, { key: 'prompt', label: 'No prompt', num: true }, { key: 'body', label: 'Ao invocar', num: true }],
        inv.skills.map(s => ({ name: s.name, prompt: s.promptTokens, body: s.bodyTokens, title: s.scope }))))
      kids.push(this.group('Agentes', inv.agents.length, 'agents', [{ key: 'name', label: 'Nome' }, { key: 'prompt', label: 'No prompt', num: true }, { key: 'body', label: 'Ao invocar', num: true }],
        inv.agents.map(s => ({ name: s.name, prompt: s.promptTokens, body: s.bodyTokens, title: s.scope }))))
      kids.push(this.group('MCP por servidor', inv.mcpServers.length, 'mcp', [{ key: 'name', label: 'Servidor' }, { key: 'transport', label: 'Transporte' }, { key: 'tokens', label: byServer ? 'Tokens' : this.canMeasure ? 'Tokens (meça)' : 'Tokens', num: true }],
        inv.mcpServers.map(s => ({ name: s.name, transport: s.transport, tokens: byServer?.get(s.name) ?? 0, title: '' }))))
      if (tools?.length) {
        kids.push(this.group('MCP por tool', tools.length, 'tools', [{ key: 'name', label: 'Tool' }, { key: 'tokens', label: 'Tokens', num: true }],
          tools.map(t => ({ name: t.name.replace(/^mcp__/, ''), tokens: t.tokens, title: t.source }))))
      }
      if (inv.hooks.length) {
        const det = el('details', 'cx-group')
        det.append(el('summary', '', `Hooks (${inv.hooks.reduce((a, h) => a + h.count, 0)})`))
        const ul = el('ul', 'cx-hooks')
        for (const h of inv.hooks) {
          const li = el('li', '')
          li.append(el('strong', '', `${h.event} ×${h.count}`))
          for (const c of h.commands) li.append(el('code', 'cx-code', c))
          ul.append(li)
        }
        det.append(ul)
        kids.push(det)
      }
      root.replaceChildren(...kids)
    }

    private group(title: string, count: number, name: TableName, cols: Col[], rows: Record<string, string | number>[]): HTMLElement {
      const det = el('details', 'cx-group')
      det.open = count > 0 && count <= 12
      det.append(el('summary', '', `${title} (${count})`))
      const holder = el('div', '')
      det.append(holder)
      const build = (): void => holder.replaceChildren(this.table(name, cols, rows, build))
      // Built when first opened: a collapsed group costs nothing.
      if (det.open) build()
      else det.addEventListener('toggle', () => { if (det.open && !holder.firstChild) build() })
      if (count === 0) holder.append(el('div', 'cx-dim', 'Nada aqui.'))
      return det
    }

    private table(name: TableName, cols: Col[], rows: Record<string, string | number>[], rebuild: () => void): HTMLElement {
      const sort = this.sorts[name]
      const sorted = sortRows(rows, sort, (r, k) => r[k] ?? '')
      const shown = this.expanded.has(name) ? sorted : sorted.slice(0, ROW_LIMIT)
      const t = el('table', 'cx-table')
      const tr = el('tr', '')
      for (const c of cols) {
        const th = el('th', c.num ? 'num' : '')
        th.scope = 'col'
        th.setAttribute('aria-sort', sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none')
        const b = el('button', 'cx-th', c.label)
        b.type = 'button'
        b.addEventListener('click', () => { this.sorts[name] = nextSort(this.sorts[name], c.key); rebuild() })
        th.append(b)
        tr.append(th)
      }
      const thead = el('thead', ''); thead.append(tr)
      const tbody = el('tbody', '')
      for (const r of shown) {
        const row = el('tr', '')
        for (const c of cols) {
          const v = r[c.key]
          const td = el('td', c.num ? 'num' : '', typeof v === 'number' ? fmtTokens(v) : String(v ?? ''))
          if (c.key === 'name' && r.title) td.title = String(r.title)
          row.append(td)
        }
        tbody.append(row)
      }
      t.append(thead, tbody)
      if (sorted.length <= ROW_LIMIT || this.expanded.has(name)) return t
      const wrap = el('div', '')
      const more = el('button', 'cx-btn cx-more', `Mostrar mais (${sorted.length - ROW_LIMIT})`)
      more.type = 'button'
      more.addEventListener('click', () => { this.expanded.add(name); rebuild() })
      wrap.append(t, more)
      return wrap
    }

    // ---------- curve ----------

    private paintCurve(): void {
      const root = this.sec.curve
      const tr = this.transcript
      const head = el('h3', '', 'Curva')
      if (!tr || tr.turns.length === 0) { root.replaceChildren(head, el('div', 'cx-dim', 'Ainda não há turnos no transcrito desta sessão.')); return }
      const geo = curveGeometry(tr.turns, tr.jumps, CHART_W, CHART_H)
      const chart = svg('svg', { viewBox: `0 0 ${CHART_W} ${CHART_H}`, class: 'cx-chart', role: 'img', tabindex: 0, 'aria-label': `Contexto por turno, ${tr.turns.length} turnos; setas escolhem o turno` })
      chart.append(svg('polyline', { points: geo.line, class: 'cx-line-path', fill: 'none' }))
      for (const mk of geo.marks) {
        const c = svg('circle', { cx: mk.x, cy: mk.y, r: 3.2, class: 'cx-mark' })
        const title = svg('title'); title.textContent = `${turnLabel(tr.turns, mk.index, tr.firstTurn)} — salto de +${fmtTokens(mk.delta)}`
        c.append(title)
        chart.append(c)
      }
      const cur = svg('line', { class: 'cx-cursor', y1: 0, y2: CHART_H, x1: -10, x2: -10 })
      const dot = svg('circle', { class: 'cx-cursor-dot', r: 3, cx: -10, cy: -10 })
      chart.append(cur, dot)
      const caption = el('div', 'cx-caption', `${tr.turns.length} turnos · pico ${fmtTokens(geo.max)}`)
      caption.setAttribute('aria-live', 'polite')
      const at = (i: number): void => {
        this.cursor = i
        const t = tr.turns[i]
        if (!t) return
        const n = tr.turns.length
        const x = n <= 1 ? CHART_W / 2 : 4 + (i * (CHART_W - 8)) / (n - 1)
        const y = CHART_H - 4 - (t[1] / geo.max) * (CHART_H - 8)
        cur.setAttribute('x1', String(x)); cur.setAttribute('x2', String(x))
        dot.setAttribute('cx', String(x)); dot.setAttribute('cy', String(y))
        caption.textContent = turnLabel(tr.turns, i, tr.firstTurn)
      }
      chart.addEventListener('pointermove', ev => {
        const r = chart.getBoundingClientRect()
        if (r.width > 0) at(geo.indexAt(((ev.clientX - r.left) * CHART_W) / r.width))
      })
      chart.addEventListener('keydown', ev => {
        const n = tr.turns.length
        const i = this.cursor ?? n - 1
        const next = ev.key === 'ArrowLeft' ? i - 1 : ev.key === 'ArrowRight' ? i + 1 : ev.key === 'Home' ? 0 : ev.key === 'End' ? n - 1 : undefined
        if (next === undefined) return
        ev.preventDefault()
        at(Math.max(0, Math.min(n - 1, next)))
      })
      const kids: Node[] = [head, chart, caption]
      if (tr.jumps.length) {
        kids.push(el('h4', '', 'Maiores saltos'))
        const ul = el('ul', 'cx-jumps')
        for (const j of tr.jumps) {
          const li = el('li', '')
          const b = el('button', 'cx-jump', `+${fmtTokens(j.delta)} · ${turnLabel(tr.turns, j.index, tr.firstTurn)}`)
          b.type = 'button'
          b.addEventListener('click', () => at(j.index))
          li.append(b)
          ul.append(li)
        }
        kids.push(ul)
      }
      root.replaceChildren(...kids)
      if (this.cursor !== undefined && this.cursor < tr.turns.length) at(this.cursor)
    }
  }

  const disposables: IDisposable[] = [
    ui.pads.register({ id: PAD_ID, create: () => (pad = new Pad()) }),
    ui.commands.registerCommand(OPEN_COMMAND, () => ui.pads.open(PAD_ID)),
    ui.panes.onDidChangeActive(info => syncTarget(info)),
    // The pane's folder can follow a rebind: re-read the target from the active pane.
    ui.agents.onDidChange(() => syncFromActive()),
  ]
  return disposables as Disposable[]
}
