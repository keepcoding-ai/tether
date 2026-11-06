// The "Mover…" dialog: one place to send a pane (or its whole frame) anywhere — another frame of any desk, a new frame
// at a desk's edge, or the drawer. Left: the destination tree (the drawer, then the desks in their colours, each frame
// as a mini-map of its real layout) with a search. Right: the selected frame drawn large with drop zones per group
// ("Como aba", the four sides), or, for a desk/the drawer, its frames with "Novo quadro" at the four edges. Footer:
// "Este painel | O quadro inteiro", the summary, Cancelar / Mover. It is a `dialog.ask` (the app's dialog: same
// header, backdrop, and `dialogOpen()` keeps the app's shortcuts quiet). The rules live in move-rules.ts; this file
// only draws and resolves with the op to run (undefined = cancelled). main.ts runs it.
import { icon, type IconName } from './icons.ts'
import { deskTokens } from './desks.ts'
import {
  findFrame, findScope, groupsOf, matchRange, moveOpOf, plural, summaryOf, visibleRows, zoneAllowed, zoneLabel,
  type Edge, type FrameModel, type MiniNode, type MoveMode, type MoveOp, type MoveSource, type Placement, type ScopeModel, type Zone,
} from './move-rules.ts'

export interface MoveDialogInput {
  scopes: ScopeModel[]
  source: MoveSource
  /** The icon of a pane (by its agent kind). */
  paneIcon(slotId: string): IconName
  /** Start in "O quadro inteiro". */
  mode?: MoveMode
}

const EDGE_ICON: Record<Edge, IconName> = { left: 'arrow-left', right: 'arrow-right', top: 'arrow-up', bottom: 'arrow-down' }
const ZONE_ICON: Record<Zone, IconName> = { ...EDGE_ICON, tab: 'tabs' }
/** Up to this many frames in all, the tree opens fully. */
const OPEN_ALL_FRAMES = 12

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

/** The scope's mark: the drawer's lightning, a pad's own icon, a desk's colour dot. */
function scopeMark(s: ScopeModel): HTMLElement | SVGElement {
  return s.kind === 'drawer' ? icon('lightning') : s.kind === 'pad' ? icon((s.icon ?? 'square') as IconName) : el('span', 'dot')
}

/** The scope's colour: the desk's `-text` token, the neutral drawer line for the drawer, the accent for the pads. */
function scopeColor(s: ScopeModel | undefined): string {
  return s?.kind === 'desk' && s.color ? deskTokens(s.color).text : s?.kind === 'drawer' ? 'var(--drawer-line)' : 'var(--accent)'
}

/** Text with the query's hit wrapped in <mark>. */
function highlighted(text: string, query: string): HTMLElement {
  const span = el('span', 'nm')
  const r = matchRange(text, query)
  if (!r) { span.textContent = text; return span }
  span.append(text.slice(0, r[0]), el('mark', undefined, text.slice(r[0], r[1])), text.slice(r[1]))
  return span
}

export function openMoveDialog(input: MoveDialogInput): Promise<MoveOp | undefined> {
  const { scopes, source } = input
  return new Promise(resolve => {
    const state = {
      sel: { scope: source.scope, frameId: source.frameId as string | undefined },
      mode: (input.mode ?? 'pane') as MoveMode,
      zone: undefined as Zone | undefined,
      group: undefined as string | undefined,
      query: '',
      // Everything starts expanded while the tree is short; a long one opens only where the pane is and the current desk.
      open: new Set<string>(scopes.reduce((n, s) => n + s.frames.length, 0) <= OPEN_ALL_FRAMES ? scopes.map(s => s.id) : [source.scope, ...scopes.filter(s => s.current).map(s => s.id)]),
    }
    let hover: { zone: Zone; group?: string } | undefined

    const dlg = el('dialog', 'ask move info')
    dlg.dataset.dialog = 'move'
    dlg.setAttribute('aria-labelledby', 'mv-title')

    // ---- header ----
    const head = el('header')
    const badge = el('span', 'badge'); badge.append(icon('arrow-square-out'))
    const title = el('h2', undefined, 'Mover…'); title.id = 'mv-title'
    const chip = el('span', 'mv-chip')
    const srcScope = findScope(scopes, source.scope)
    const srcFrame = findFrame(scopes, source.scope, source.frameId)
    chip.append(icon(input.paneIcon(source.slotId)), el('b', undefined, source.title), el('span', undefined, `${srcScope?.name ?? ''} › ${srcFrame?.name ?? ''}`))
    const xBtn = el('button', 'mv-x'); xBtn.type = 'button'; xBtn.title = 'Fechar (Esc)'; xBtn.setAttribute('aria-label', 'Fechar'); xBtn.append(icon('x'))
    head.append(badge, title, chip, el('span', 'spacer'), xBtn)

    // ---- body ----
    const body = el('div', 'mv-body')
    const left = el('aside', 'mv-left')
    const search = el('label', 'mv-search')
    const q = el('input'); q.type = 'text'; q.id = 'mv-q'; q.placeholder = 'Buscar mesa, quadro ou painel'; q.autocomplete = 'off'; q.spellcheck = false
    q.setAttribute('aria-label', 'Buscar mesa, quadro ou painel')
    search.append(icon('magnifying-glass'), q)
    const tree = el('div', 'mv-tree'); tree.setAttribute('role', 'tree'); tree.setAttribute('aria-label', 'Destinos')
    left.append(search, tree)
    const right = el('section', 'mv-right')
    const rhead = el('div', 'mv-rhead')
    const stage = el('div', 'mv-stage')
    const dia = el('div', 'mv-dia')
    stage.append(dia)
    const cap = el('div', 'mv-cap')
    right.append(rhead, stage, cap)
    body.append(left, right)

    // ---- footer ----
    const foot = el('footer', 'mv-foot')
    const f1 = el('div', 'mv-f1')
    const seg = el('div', 'mv-seg'); seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', 'Mover')
    const modeBtn = (m: MoveMode, label: string): HTMLButtonElement => {
      const b = el('button', undefined, label); b.type = 'button'; b.dataset.mode = m; b.setAttribute('role', 'radio')
      b.addEventListener('click', () => setMode(m))
      return b
    }
    seg.append(modeBtn('pane', 'Este painel'), modeBtn('frame', 'O quadro inteiro'))
    const hints = el('div', 'mv-hints')
    const kbds = (...keys: string[]): HTMLElement[] => keys.map(k => el('kbd', undefined, k))
    const h1 = el('span'); h1.append(...kbds('↑', '↓', '←', '→'))
    const h2 = el('span'); h2.append(...kbds('Enter'), ' mover')
    const h3 = el('span'); h3.append(...kbds('Esc'), ' cancelar')
    hints.append(h1, h2, h3)
    f1.append(el('span', 'lbl', 'Mover'), seg, hints)
    const f2 = el('div', 'mv-f2')
    const sum = el('div', 'mv-sum'); sum.append(icon('arrow-right'))
    const sumText = el('div', 'sm'); sumText.id = 'mv-summary'
    sum.append(sumText)
    const cancel = el('button', 'cancel'); cancel.type = 'button'; cancel.dataset.choice = 'cancel'
    cancel.append('Cancelar ', el('kbd', undefined, 'Esc'))
    const go = el('button', 'primary'); go.type = 'button'; go.id = 'mv-go'
    go.append('Mover', el('kbd', undefined, 'Enter'))
    f2.append(sum, cancel, go)
    foot.append(f1, f2)

    dlg.append(head, body, foot)

    // ---- drawing ----
    const placement = (): Placement | undefined => state.zone ? { scope: state.sel.scope, frameId: state.sel.frameId, group: state.group, zone: state.zone } : undefined
    const opNow = (): MoveOp | undefined => { const p = placement(); return p ? moveOpOf(scopes, state.mode, source, p) : undefined }

    function drawTree(): void {
      const rows = visibleRows(scopes, state.query, state.open)
      tree.replaceChildren()
      if (rows.length === 0) { tree.append(el('div', 'mv-none', 'Nada encontrado')); return }
      rows.forEach((r, index) => {
        const row = el('div', 'mv-row')
        row.setAttribute('role', 'treeitem')
        row.style.setProperty('--rc', scopeColor(r.scope))
        row.dataset.scope = r.scope.id
        if (r.kind === 'scope') {
          const selected = state.sel.scope === r.scope.id && !state.sel.frameId
          row.classList.add(r.scope.kind === 'desk' ? 'd' : 'g')
          row.classList.toggle('open', r.open)
          row.classList.toggle('sel', selected)
          row.setAttribute('aria-expanded', String(r.open))
          row.setAttribute('aria-selected', String(selected))
          const chev = el('span', 'chev'); chev.dataset.chev = ''; chev.append(icon('caret-right'))
          row.append(chev, scopeMark(r.scope), highlighted(r.scope.name, state.query))
          if (r.scope.current) row.append(el('span', 'atual', 'atual'))
          row.append(el('span', 'n', plural(r.scope.frames.length, 'quadro', 'quadros')))
        } else {
          const selected = state.sel.scope === r.scope.id && state.sel.frameId === r.frame.id
          row.classList.add('f')
          row.classList.toggle('sel', selected)
          row.setAttribute('aria-selected', String(selected))
          row.dataset.frame = r.frame.id
          const ft = el('span', 'ft')
          ft.append(highlighted(r.frame.name, state.query))
          const pm = el('span', 'pm')
          if (r.matches.length) r.matches.forEach((m, i) => { if (i) pm.append(' · '); pm.append(highlighted(m.title, state.query)) })
          else pm.textContent = plural(r.frame.panes.length, 'painel', 'painéis')
          ft.append(pm)
          row.append(miniMap(r.frame.layout), ft)
        }
        tree.append(row)
        // A thin line closes the drawer's and the pads' rows (their frames come right after them), before the desks.
        const next = rows[index + 1]
        if (r.scope.kind !== 'desk' && next && next.scope.kind === 'desk') tree.append(el('div', 'mv-sep'))
      })
      tree.querySelector('.mv-row.sel')?.scrollIntoView({ block: 'nearest' })
    }

    function miniMap(layout: MiniNode): HTMLElement {
      const mm = el('span', 'mv-mm')
      const walk = (n: MiniNode): HTMLElement => {
        if (n.kind === 'group') {
          const i = el('i')
          i.style.flexGrow = String(n.size)
          i.title = n.panes.map(p => p.title).join(' · ')
          if (n.panes.some(p => p.id === source.slotId)) i.classList.add('src')
          return i
        }
        const s = el('span', `mc ${n.dir}`)
        s.style.flexGrow = String(n.size)
        s.append(...n.children.map(walk))
        return s
      }
      mm.append(walk(layout))
      return mm
    }

    /** A group drawn large: its tabs, a few lines, the preview highlight, and (pane mode) its five zones. */
    function groupBox(g: Extract<MiniNode, { kind: 'group' }>, frame: FrameModel | undefined, zones: boolean): HTMLElement {
      const pn = el('div', 'mv-pn')
      pn.dataset.group = g.id
      const hasSource = g.panes.some(p => p.id === source.slotId)
      if (hasSource) pn.classList.add('src')
      const ph = el('div', 'pt')
      const active = g.panes.find(p => p.id === g.active) ?? g.panes[0]
      for (const p of g.panes) {
        const t = el('span', p.id === active?.id ? 'on' : undefined)
        t.append(icon(input.paneIcon(p.id)), el('em', undefined, p.title))
        if (p.id === source.slotId) t.append(el('b', 'moving', 'movendo'))
        ph.append(t)
      }
      const ln = el('div', 'ln')
      for (let i = 0; i < 5; i++) ln.append(el('u'))
      pn.append(ph, ln, el('div', 'pv'))
      if (zones && frame) {
        const zs = el('div', 'zs')
        for (const z of ['top', 'left', 'tab', 'right', 'bottom'] as const) {
          const p: Placement = { scope: state.sel.scope, frameId: frame.id, group: g.id, zone: z }
          const ok = zoneAllowed(scopes, state.mode, source, p)
          const b = el('button', `z z-${z}`); b.type = 'button'
          b.dataset.zone = z; b.dataset.group = g.id
          const label = zoneLabel('pane', true, z)
          b.setAttribute('aria-label', `${label}: ${active?.title ?? ''}`)
          b.title = ok ? label : z === 'tab' ? 'Já está neste grupo' : 'Ficaria onde está'
          if (!ok) { b.classList.add('off'); b.setAttribute('aria-disabled', 'true') }
          b.append(icon(ZONE_ICON[z]), el('span', 'zl', label))
          zs.append(b)
        }
        pn.append(zs)
      }
      return pn
    }

    function frameDrawing(frame: FrameModel, zones: boolean): HTMLElement {
      const walk = (n: MiniNode): HTMLElement => {
        if (n.kind === 'group') { const b = groupBox(n, frame, zones); b.style.flexGrow = String(n.size); return b }
        const s = el('div', `col ${n.dir}`)
        s.style.flexGrow = String(n.size)
        s.append(...n.children.map(walk))
        return s
      }
      const fr = el('div', 'fr')
      fr.append(walk(frame.layout))
      return fr
    }

    function outerZones(onFrame: boolean): HTMLElement[] {
      // Tab order follows the picture: top, left, right, bottom.
      return (['top', 'left', 'right', 'bottom'] as const).map(z => {
        const p: Placement = { scope: state.sel.scope, frameId: onFrame ? state.sel.frameId : undefined, zone: z }
        const ok = zoneAllowed(scopes, state.mode, source, p)
        const b = el('button', `oz ${z}`); b.type = 'button'; b.dataset.zone = z
        const label = zoneLabel(state.mode, onFrame, z)
        b.append(icon(EDGE_ICON[z]), el('span', undefined, label))
        b.setAttribute('aria-label', label)
        if (!ok) { b.classList.add('off'); b.setAttribute('aria-disabled', 'true'); b.title = 'Ficaria onde está' }
        return b
      })
    }

    function drawRight(): void {
      const scope = findScope(scopes, state.sel.scope)
      const frame = findFrame(scopes, state.sel.scope, state.sel.frameId)
      right.style.setProperty('--c', scopeColor(scope))
      rhead.replaceChildren()
      const crumb = el('div', 'crumb')
      crumb.append(scope ? scopeMark(scope) : el('span', 'dot'), el('span', 'dn', scope?.name ?? ''))
      if (frame) crumb.append(el('span', 'sep', '›'), el('span', undefined, frame.name))
      rhead.append(crumb, el('span', 'spacer'), el('span', 'pill', frame ? plural(frame.panes.length, 'painel', 'painéis') : plural(scope?.frames.length ?? 0, 'quadro', 'quadros')))
      dia.replaceChildren()
      if (frame && state.mode === 'pane') {
        dia.className = 'mv-dia'
        const mid = el('div', 'mid'); mid.append(frameDrawing(frame, true)); dia.append(mid)
      } else if (frame) {
        dia.className = 'mv-dia out'
        const mid = el('div', 'mid dim')
        const fr = frameDrawing(frame, false); fr.classList.add('lock')
        const ghost = el('div', 'ghost'); const gs = el('span'); gs.append(icon('tabs'), 'Como aba'); ghost.append(gs)
        const off = el('button', 'z off whole'); off.type = 'button'; off.dataset.zone = 'tab'; off.setAttribute('aria-disabled', 'true'); off.title = 'Um quadro inteiro não vira aba'
        mid.append(fr, ghost, off)
        dia.append(...outerZones(true), mid)
      } else {
        dia.className = 'mv-dia out'
        const mid = el('div', 'mid')
        const tiles = el('div', 'tiles')
        if (scope && scope.frames.length === 0) tiles.append(el('div', 'mv-empty', scope.kind === 'drawer' ? 'Gaveta vazia' : scope.kind === 'pad' ? 'Prancheta vazia' : 'Mesa vazia'))
        for (const f of scope?.frames ?? []) {
          const tile = el('div', 'tile')
          const tl = el('div', 'tl'); tl.append(el('span', undefined, f.name), el('span', undefined, plural(f.panes.length, 'painel', 'painéis')))
          tile.append(tl, frameDrawing(f, false))
          tiles.append(tile)
        }
        mid.append(tiles)
        dia.append(...outerZones(false), mid)
      }
      paintZone()
    }

    function setPreview(zone: Zone | undefined, group: string | undefined): void {
      for (const p of dia.querySelectorAll<HTMLElement>('.mv-pn')) p.removeAttribute('data-pv')
      if (!zone || state.mode !== 'pane' || !state.sel.frameId || !group) return
      dia.querySelector<HTMLElement>(`.mv-pn[data-group="${CSS.escape(group)}"]`)?.setAttribute('data-pv', zone)
    }

    function paintZone(): void {
      for (const z of dia.querySelectorAll<HTMLElement>('[data-zone]')) {
        const on = !z.classList.contains('off') && z.dataset.zone === state.zone && (z.dataset.group === undefined || z.dataset.group === state.group)
        z.classList.toggle('on', on)
        z.setAttribute('aria-pressed', String(on))
      }
      setPreview(state.zone, state.group)
      drawCap()
      drawSummary()
    }

    function drawCap(): void {
      const z = hover?.zone ?? state.zone
      cap.replaceChildren()
      if (!z) { cap.append(el('span', undefined, 'Escolha uma zona')); return }
      const scope = findScope(scopes, state.sel.scope)
      const frame = findFrame(scopes, state.sel.scope, state.sel.frameId)
      const group = hover ? hover.group : state.group
      let where = frame ? `${scope?.name} › ${frame.name}` : scope?.name ?? ''
      if (frame && state.mode === 'pane' && group && frame.panes.length > 1) {
        const g = groupsOf(frame.layout).find(x => x.id === group)
        const name = g?.panes.find(p => p.id === g.active)?.title ?? g?.panes[0]?.title
        if (name) where += ` · ${name}`
      }
      cap.append(icon(ZONE_ICON[z]), el('b', undefined, zoneLabel(state.mode, !!frame, z)), el('span', undefined, where))
    }

    function drawSummary(): void {
      const s = summaryOf(scopes, state.mode, source, { scope: state.sel.scope, frameId: state.sel.frameId, group: state.group, zone: state.zone })
      sumText.replaceChildren()
      const dk = el('span', 'dk', s.scope); dk.style.color = scopeColor(findScope(scopes, state.sel.scope))
      sumText.append(el('b', undefined, s.subject), ' → ', dk, s.where, ', ')
      if (s.zone) sumText.append(el('span', 'z2', s.zone), s.tail)
      else sumText.append(el('span', 'pl', s.tail))
      go.disabled = opNow() === undefined
    }

    function select(scope: string, frameId: string | undefined): void {
      state.sel = { scope, frameId }
      state.zone = undefined
      state.group = undefined
      hover = undefined
      drawTree()
      drawRight()
    }

    function setMode(m: MoveMode): void {
      state.mode = m
      for (const b of seg.querySelectorAll<HTMLButtonElement>('button')) {
        const on = b.dataset.mode === m
        b.classList.toggle('on', on)
        b.setAttribute('aria-checked', String(on))
      }
      // The chosen zone may not exist in the other mode (a group's zone, "Como aba"): it is dropped.
      if (state.zone && !(placement() && zoneAllowed(scopes, m, source, { ...placement()!, group: m === 'frame' ? undefined : state.group }))) { state.zone = undefined; state.group = undefined }
      if (m === 'frame') state.group = undefined
      hover = undefined
      drawTree()
      drawRight()
    }

    function chooseZone(btn: HTMLElement): void {
      if (btn.classList.contains('off')) return
      state.zone = btn.dataset.zone as Zone
      state.group = btn.dataset.group
      paintZone()
    }

    // ---- events ----
    let done = false
    const finish = (op: MoveOp | undefined): void => {
      if (done) return
      done = true
      dlg.close()
      dlg.remove()
      resolve(op)
    }
    const confirm = (): void => { const op = opNow(); if (op) finish(op) }

    tree.addEventListener('click', ev => {
      const row = (ev.target as Element).closest<HTMLElement>('.mv-row')
      if (!row) return
      const scope = row.dataset.scope!
      if ((ev.target as Element).closest('[data-chev]')) {
        if (state.open.has(scope)) state.open.delete(scope); else state.open.add(scope)
        drawTree()
        return
      }
      if (row.dataset.frame) select(scope, row.dataset.frame)
      else { state.open.add(scope); select(scope, undefined) }
    })
    q.addEventListener('input', () => { state.query = q.value; drawTree() })
    dia.addEventListener('click', ev => {
      const z = (ev.target as Element).closest<HTMLElement>('[data-zone]')
      if (z) chooseZone(z)
    })
    dia.addEventListener('mouseover', ev => {
      const z = (ev.target as Element).closest<HTMLElement>('[data-zone]')
      if (!z || z.classList.contains('off')) return
      hover = { zone: z.dataset.zone as Zone, group: z.dataset.group }
      setPreview(hover.zone, hover.group)
      drawCap()
    })
    dia.addEventListener('mouseleave', () => { hover = undefined; setPreview(state.zone, state.group); drawCap() })
    dia.addEventListener('mouseout', ev => {
      if ((ev.relatedTarget as Element | null)?.closest?.('[data-zone]')) return
      hover = undefined; setPreview(state.zone, state.group); drawCap()
    })
    go.addEventListener('click', confirm)
    cancel.addEventListener('click', () => finish(undefined))
    xBtn.addEventListener('click', () => finish(undefined))
    // A press on the backdrop (the dialog element itself, outside its box) cancels.
    dlg.addEventListener('mousedown', ev => {
      if (ev.target !== dlg) return
      const r = dlg.getBoundingClientRect()
      if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) finish(undefined)
    })
    // Esc: the browser raises `cancel` on a modal dialog; Esc first clears the search, then cancels.
    dlg.addEventListener('cancel', ev => { ev.preventDefault(); escape() })
    const escape = (): void => {
      if (state.query) { state.query = ''; q.value = ''; drawTree(); q.focus(); return }
      finish(undefined)
    }

    const stepRow = (dir: number): void => {
      const rows = [...tree.querySelectorAll<HTMLElement>('.mv-row')]
      if (rows.length === 0) return
      const i = rows.findIndex(r => r.classList.contains('sel'))
      const next = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + dir))]!
      select(next.dataset.scope!, next.dataset.frame)
    }

    dlg.addEventListener('keydown', ev => {
      const target = ev.target as HTMLElement
      const inSearch = target === q
      switch (ev.key) {
        case 'Escape': ev.preventDefault(); escape(); return
        case 'Enter': {
          // The focused Cancelar / X / mode buttons take Enter themselves (native click).
          if (target instanceof HTMLButtonElement && !target.dataset.zone && target !== go) return
          ev.preventDefault()
          if (target instanceof HTMLButtonElement && target.dataset.zone) chooseZone(target)
          confirm()
          return
        }
        case 'ArrowDown': ev.preventDefault(); stepRow(1); return
        case 'ArrowUp': ev.preventDefault(); stepRow(-1); return
        case 'ArrowRight': case 'ArrowLeft': {
          if (inSearch && q.value) return // the caret moves in the search text
          ev.preventDefault()
          const { scope, frameId } = state.sel
          if (ev.key === 'ArrowRight') {
            if (!frameId && !state.open.has(scope) && !state.query) { state.open.add(scope); drawTree() } else stepRow(1)
          } else if (frameId) select(scope, undefined)
          else if (state.open.has(scope) && !state.query) { state.open.delete(scope); drawTree() }
        }
      }
    })

    document.body.append(dlg)
    setMode(state.mode)
    dlg.showModal()
    q.focus()
  })
}
