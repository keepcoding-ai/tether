// The "Falhas" screen: a TAB of the active group, like the shortcuts and settings screens. List on the left (one row per
// fault, never per occurrence: id, kind, message, ×N, last time, status, tags, "voltou na vX, depois do fix …"), detail
// on the right (stack, context, occurrences, notes, fix) with the actions (resolvida, ignorada, reabrir, etiqueta, nota,
// copiar stack) and the primary one, "Mandar para o agente", which opens a chooser of the agent panes that can take the
// command now. Under ~520 px the list and the detail take turns (‹ and Esc go back). Everything it changes goes through
// the host to the registry in Electron main; it refreshes when main says the files changed. Words follow the design note.
import type { DockviewPanelApi, GroupPanelPartInitParameters, IContentRenderer, ITabRenderer, TabPartInitParameters } from 'dockview-core'
import { escapeHtml } from '../../app/renderer/chord-pill.ts'
import { icon } from '../../app/renderer/icons.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { localTime, relativeTime } from '../../src/cli/format.ts'
import { kindLabel, statusLabel } from '../../src/core/faults-labels.ts'
import type { FaultDetail, FaultRow } from '../../src/core/faults-ops.ts'
import { FAULTS_TITLE } from './layouts.ts'
import type { FaultsList, ScreenAction, UpdateOutcome } from './ipc.ts'
import { allTags, buildChooser, counts, isNew, returnedOf, sortRows, stackNote, STATUS_MARK, stillSent, TABS, visibleRows, type Chooser, type Choice, type Tab } from './rules.ts'
import type { FaultsStore } from './store.ts'

export type ShowReply = { ok: true; fault: FaultDetail; skipped: number } | { ok: false; message: string }
export type SendOutcome = { ok: true; label: string } | { ok: false; message: string }

export interface FaultsHost {
  store: FaultsStore
  show(id: string, all: boolean): Promise<ShowReply>
  update(id: string, action: ScreenAction): Promise<UpdateOutcome>
  markSeen(): void
  copy(text: string): void
  openFolder(path: string): void
  /** The agent panes that can take the command, as they are now. */
  chooser(): Chooser
  /** Any slot changed (the chooser is redrawn while it is open). */
  onSlotsChange(listener: () => void): IDisposable
  /** Types the investigate command into the choice's pane (or into a new one, once its agent is up). */
  send(choice: Choice, fault: { id: string; sig: string }): Promise<SendOutcome>
  openProfile(profileId: string): void
  /** The pane label a fault was sent to, until the fault is no longer open. */
  sentTo(sig: string): string | undefined
  onTabMenu(id: string, ev: MouseEvent): void
  onClose(id: string): void
}

/** What a test reads of the screen. */
export interface FaultsSnapshot {
  id: string
  tab: Tab
  query: string
  tag: string
  view: 'list' | 'detail'
  banner: string | undefined
  empty: string | undefined
  counts: Record<Tab, number>
  rows: { id: string; status: string; message: string; count: number; tags: string[]; isNew: boolean; returned?: string; sent?: string; selected: boolean }[]
  detail: { id: string; status: string; tags: string[]; notes: { author: string; text: string }[]; fix?: string; occurrences: number; stackNote?: string } | undefined
  chooser: { choices: { key: string; label: string; state: string; enabled: boolean; reason?: string; checked: boolean }[]; selected: string | undefined; sending: boolean } | undefined
  toast: string | undefined
}

const NARROW_PX = 520
/** "07/11 16:29": day/month and the time, local. */
const when = (iso: string): string => { const t = localTime(iso); return `${t.slice(8, 10)}/${t.slice(5, 7)} ${t.slice(11)}` }

export class FaultsPanel implements IContentRenderer {
  readonly element: HTMLElement
  id = ''
  private api: DockviewPanelApi | undefined
  private readonly host: FaultsHost
  private readonly disposers: IDisposable[] = []
  private disposed = false
  // state
  private tab: Tab = 'open'
  private query = ''
  private tag = ''
  private by: 'last' | 'count' = 'last'
  private selectedSig: string | undefined
  private view: 'list' | 'detail' = 'list'
  private detail: FaultDetail | undefined
  private detailError: string | undefined
  private showAll = false
  private visible: FaultRow[] = []
  private noteDraft = ''
  /** When the person last had the screen open, as it was when this one opened. */
  private seenAtOpen: string | null = null
  private resolving = false
  private chooser: { data: Chooser; selected: string | undefined; sending: boolean; message?: string } | undefined
  private toastTimer: ReturnType<typeof setTimeout> | undefined
  private toastText: string | undefined
  private detailKey = ''
  private readonly q: <T extends Element>(sel: string) => T

  constructor(host: FaultsHost) {
    this.host = host
    this.element = document.createElement('div')
    this.element.className = 'fl-pane'
    this.element.dataset.faults = 'pane'
    this.element.dataset.view = 'list'
    this.element.innerHTML = `
      <div class="fl" tabindex="-1">
        <div class="fl-banner" hidden></div>
        <div class="fl-head">
          <div class="fl-tabs" role="tablist"></div>
          <label class="fl-sel fl-tabsel"><select class="fl-tabselect" aria-label="Filtro"></select><span class="caret"></span></label>
          <div class="fl-search"><span class="mag"></span><input class="fl-q" placeholder="Buscar por id, mensagem, etiqueta ou processo" autocomplete="off" spellcheck="false" aria-label="Buscar falha"></div>
          <label class="fl-sel"><select class="fl-tagfilter" aria-label="Etiqueta"></select><span class="caret"></span></label>
          <label class="fl-sel fl-order-wrap"><select class="fl-order" aria-label="Ordem"><option value="last">Mais recentes</option><option value="count">Mais frequentes</option></select><span class="caret"></span></label>
        </div>
        <div class="fl-body">
          <div class="fl-list" tabindex="0" role="listbox" aria-label="Falhas"></div>
          <div class="fl-detail" tabindex="-1"></div>
        </div>
        <div class="fl-toast" hidden></div>
      </div>`
    this.q = sel => this.element.querySelector(sel)!
    this.q('.mag').replaceWith(icon('magnifying-glass', 'mag'))
    this.element.querySelectorAll('.caret').forEach(c => c.replaceWith(icon('caret-down', 'caret')))
    this.wire()
  }

  init(params: GroupPanelPartInitParameters): void {
    this.api = params.api
    this.id = params.api.id
    this.element.dataset.faultsId = this.id
    this.disposers.push(this.host.store.onDidChange(() => this.onStore()))
    this.disposers.push(this.host.onSlotsChange(() => this.refreshChooser()))
    this.disposers.push(params.api.onDidActiveChange(({ isActive }) => { if (isActive) requestAnimationFrame(() => this.focus()) }))
    this.render()
    void this.start()
  }

  /** Reads the registry fresh, remembers when the person last looked (what is "nova" is judged against it), then marks it looked at now. */
  private async start(): Promise<void> {
    await this.host.store.refresh()
    if (this.disposed) return
    this.seenAtOpen = this.host.store.info?.seenAt ?? null
    this.host.markSeen()
    this.render()
  }

  focus(): void {
    if (this.disposed) return
    if (this.view === 'detail') this.q<HTMLElement>('.fl-detail').focus()
    else this.q<HTMLElement>('.fl-list').focus()
  }

  dispose(): void {
    this.disposed = true
    if (this.toastTimer) clearTimeout(this.toastTimer)
    for (const d of this.disposers) d.dispose()
  }

  snapshot(): FaultsSnapshot {
    const info = this.host.store.info
    const rows = info?.rows ?? []
    const d = this.detail
    return {
      id: this.id, tab: this.tab, query: this.query, tag: this.tag, view: this.view, banner: this.bannerText(), empty: this.emptyText(rows.length),
      counts: counts(rows),
      rows: this.visible.map(r => ({
        id: r.id, status: r.status, message: r.message, count: r.count, tags: r.tags, isNew: isNew(r, this.seenAtOpen), ...(returnedOf(r) ? { returned: returnedOf(r)! } : {}),
        ...(this.sentLabel(r) ? { sent: this.sentLabel(r)! } : {}), selected: r.sig === this.selectedSig,
      })),
      detail: d ? {
        id: d.id, status: d.status, tags: d.tags, notes: d.notes.map(n => ({ author: n.author, text: n.text })), ...(d.fix ? { fix: d.fix.commit ?? 'sem commit' } : {}),
        occurrences: d.occurrences.length, ...(stackNote(d.occurrences[0]?.stack ?? '', d.version) ? { stackNote: stackNote(d.occurrences[0]?.stack ?? '', d.version)! } : {}),
      } : undefined,
      chooser: this.chooser ? {
        choices: this.chooser.data.choices.map(c => ({ key: c.key, label: c.label, state: c.state, enabled: c.enabled, ...(c.reason ? { reason: c.reason } : {}), checked: c.key === this.chooser!.selected })),
        selected: this.chooser.selected, sending: this.chooser.sending,
      } : undefined,
      toast: this.toastText,
    }
  }

  // ---------- data ----------

  private get rows(): FaultRow[] { return this.host.store.rows as FaultRow[] }

  private selectedRow(): FaultRow | undefined { return this.rows.find(r => r.sig === this.selectedSig) }

  private onStore(): void {
    if (this.disposed) return
    if (this.api?.isVisible) this.host.markSeen()
    this.render()
    void this.loadDetail()
  }

  /** The detail of the selected fault from main; a stale answer (selection moved on) is dropped. */
  private async loadDetail(): Promise<void> {
    const row = this.selectedRow()
    if (!row) { this.detail = undefined; this.detailError = undefined; this.renderDetail(); return }
    const sig = row.sig
    const r = await this.host.show(row.id, this.showAll)
    if (this.disposed || this.selectedSig !== sig) return
    if (r.ok) { this.detail = r.fault; this.detailError = undefined } else { this.detail = undefined; this.detailError = r.message }
    this.renderDetail()
  }

  private sentLabel(r: FaultRow): string | undefined {
    return stillSent(r.status) ? this.host.sentTo(r.sig) : undefined
  }

  // ---------- rendering ----------

  private bannerText(): string | undefined {
    const info = this.host.store.info
    if (this.host.store.error && !info) return `Não consegui ler o registro de falhas (${this.host.store.error})`
    if (!info) return undefined
    if (info.readError) return `Não consegui ler o registro de falhas (${info.readError})`
    if (info.stateProblem) return 'O estado das falhas está ilegível; status, etiquetas e notas não carregaram'
    if (info.skipped) return `${info.skipped} ${info.skipped === 1 ? 'linha ilegível ignorada' : 'linhas ilegíveis ignoradas'}`
    return undefined
  }

  private emptyText(total: number): string | undefined {
    if (!this.host.store.loaded || this.visible.length) return undefined
    if (!total) return 'Nenhuma falha registrada. Quando algo quebrar no tether, aparece aqui.'
    if (this.query.trim()) return `Nada para «${this.query.trim()}»`
    const word = this.tab === 'all' ? '' : this.tab === 'open' ? ' aberta' : this.tab === 'investigating' ? ' sendo investigada' : this.tab === 'done' ? ' resolvida' : ' ignorada'
    return `Nenhuma falha${word}.`
  }

  render(): void {
    if (this.disposed) return
    const info = this.host.store.info
    const rows = this.rows
    const c = counts(rows)
    // tabs
    this.q('.fl-tabs').innerHTML = TABS.map(t => `<button type="button" role="tab" class="fl-tab${t.id === this.tab ? ' on' : ''}" data-tab="${t.id}" aria-selected="${t.id === this.tab}">${t.label}${t.id === 'open' || t.id === 'investigating' ? ` <b>${c[t.id]}</b>` : ''}</button>`).join('')
    this.q<HTMLSelectElement>('.fl-tabselect').innerHTML = TABS.map(t => `<option value="${t.id}"${t.id === this.tab ? ' selected' : ''}>${t.label} (${c[t.id]})</option>`).join('')
    const tags = allTags(rows)
    const tagSel = this.q<HTMLSelectElement>('.fl-tagfilter')
    tagSel.innerHTML = `<option value="">Todas as etiquetas</option>${tags.map(t => `<option value="${escapeHtml(t)}"${t === this.tag ? ' selected' : ''}>#${escapeHtml(t)}</option>`).join('')}`
    tagSel.hidden = !tags.length
    // banner
    const banner = this.bannerText()
    const bn = this.q<HTMLElement>('.fl-banner')
    bn.hidden = !banner
    if (banner) {
      const state = !!(info?.stateProblem || info?.readError || (this.host.store.error && !info))
      bn.className = `fl-banner ${state ? 'err' : 'warn'}`
      bn.replaceChildren(icon('warning'))
      const s = document.createElement('span'); s.textContent = banner
      bn.append(s)
      if (state) {
        const sp = document.createElement('span'); sp.className = 'sp'
        const open = document.createElement('button'); open.type = 'button'; open.className = 'lnk'; open.dataset.act = 'open-folder'; open.textContent = 'Abrir pasta'
        const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'lnk'; retry.dataset.act = 'retry'; retry.textContent = 'Tentar de novo'
        bn.append(sp, open, retry)
      }
    }
    // list
    this.visible = sortRows(visibleRows(rows, { tab: this.tab, query: this.query, tag: this.tag }), this.by)
    if (!this.visible.some(r => r.sig === this.selectedSig)) {
      this.selectedSig = this.visible[0]?.sig
      this.detail = undefined
      this.detailKey = ''
      if (!this.selectedSig) this.view = 'list'
    }
    this.element.dataset.view = this.view
    const list = this.q<HTMLElement>('.fl-list')
    const empty = this.emptyText(rows.length)
    if (!this.host.store.loaded) list.innerHTML = '<div class="fl-empty fl-loading">Lendo as falhas…</div>'
    else if (empty) {
      const more = !this.query.trim() && rows.length && this.tab !== 'all' ? `<br><button type="button" class="lnk" data-act="all">ver todas (${rows.length})</button>` : this.query.trim() ? '<br><button type="button" class="lnk" data-act="clear-search">limpar busca</button>' : ''
      list.innerHTML = `<div class="fl-empty">${escapeHtml(empty)}${more}</div>`
    } else {
      const seen = this.seenAtOpen
      list.innerHTML = this.visible.map(r => {
        const back = returnedOf(r)
        const sent = this.sentLabel(r)
        const fresh = isNew(r, seen)
        return `<div class="fl-row st-${r.status}${r.sig === this.selectedSig ? ' sel' : ''}" role="option" aria-selected="${r.sig === this.selectedSig}" data-id="${escapeHtml(r.id)}" data-sig="${r.sig}">`
          + `<span class="fl-mark" title="${statusLabel(r.status)}">${STATUS_MARK[r.status]}</span>`
          + `<div class="fl-rbody"><div class="fl-r1"><span class="fl-id">${escapeHtml(r.id)}</span><span class="fl-rmsg">${escapeHtml(r.message.split('\n')[0]!)}</span></div>`
          + `<div class="fl-r2"><span>${escapeHtml(r.proc)} · ${kindLabel(r.kind)} · ×${r.count} · ${relativeTime(r.last)}</span><span class="fl-st">${statusLabel(r.status)}</span>`
          + `${fresh ? '<span class="fl-pill new">nova</span>' : ''}${back ? `<span class="fl-pill back">${escapeHtml(back)}</span>` : ''}${sent ? `<span class="fl-pill sent">enviada para ${escapeHtml(sent)}</span>` : ''}</div>`
          + `${r.tags.length ? `<div class="fl-r3">${r.tags.map(t => `<span class="fl-tag">#${escapeHtml(t)}</span>`).join('')}</div>` : ''}</div></div>`
      }).join('')
      this.q('.fl-list .sel')?.scrollIntoView({ block: 'nearest' })
    }
    this.renderDetail()
  }

  private renderDetail(): void {
    const el = this.q<HTMLElement>('.fl-detail')
    const row = this.selectedRow()
    if (!row) {
      this.detailKey = ''
      el.innerHTML = '<div class="fl-empty fl-nodetail">Escolha uma falha na lista.</div>'
      return
    }
    const d = this.detail
    if (!d) {
      this.detailKey = ''
      el.innerHTML = this.detailError ? `<div class="fl-empty">Não consegui abrir a falha ${escapeHtml(row.id)}: ${escapeHtml(this.detailError)}</div>` : '<div class="fl-empty fl-loading">Abrindo…</div>'
      return
    }
    const info = this.host.store.info
    const key = JSON.stringify([d, this.resolving, this.showAll, this.sentLabel(row), info?.build.commit])
    if (key === this.detailKey) return
    this.detailKey = key
    const back = returnedOf(d)
    const sent = this.sentLabel(d)
    const wide = this.element.clientWidth === 0 || this.element.clientWidth > NARROW_PX
    const latest = d.occurrences[0]
    const stack = latest?.stack ?? ''
    const note = stackNote(stack, latest?.version ?? d.version)
    const ctx = latest ? Object.entries(latest.context) : []
    const versions = [...new Set(d.occurrences.map(o => o.version))]
    const done = d.status === 'done' || d.status === 'ignored'
    el.innerHTML = `
      <div class="fl-dhead">
        <button type="button" class="fl-back" data-act="back"></button>
        <div class="fl-dtitle"><span class="fl-id">${escapeHtml(d.id)}</span><span class="fl-dmsg">${escapeHtml(d.message.split('\n')[0]!)}</span></div>
        <div class="fl-dmeta"><b class="st-${d.status}">${statusLabel(d.status)}</b>${d.investigating ? ` por ${escapeHtml(d.investigating.by)}` : ''} · ${escapeHtml(d.proc)} · ${kindLabel(d.kind)} · ×${d.count}</div>
        <div class="fl-dmeta">1ª ${when(d.first)} · última ${relativeTime(d.last)} · v${escapeHtml(d.version.replace(/^v/, ''))}${versions.length > 1 ? ` (também ${escapeHtml(versions.filter(v => v !== d.version).map(v => `v${v.replace(/^v/, '')}`).join(', '))})` : ''}</div>
        ${back ? `<div class="fl-dmeta"><span class="fl-pill back">${escapeHtml(back)}</span></div>` : ''}
        ${sent ? `<div class="fl-dmeta"><span class="fl-pill sent">enviada para ${escapeHtml(sent)}</span></div>` : ''}
        <div class="fl-tags">${d.tags.map(t => `<span class="fl-tag">#${escapeHtml(t)}<button type="button" class="fl-x" data-act="untag" data-tag="${escapeHtml(t)}" aria-label="Tirar a etiqueta ${escapeHtml(t)}">×</button></span>`).join('')}<input class="fl-tag-in" list="fl-taglist" placeholder="+ etiqueta" aria-label="Nova etiqueta" autocomplete="off" spellcheck="false"><datalist id="fl-taglist">${allTags(this.rows).map(t => `<option value="${escapeHtml(t)}"></option>`).join('')}</datalist></div>
        <div class="fl-actions">
          <button type="button" class="fl-primary" data-act="send">Mandar para o agente</button>
          ${done ? '<button type="button" class="fl-btn" data-act="reopen">Reabrir</button>' : '<button type="button" class="fl-btn" data-act="resolve">Marcar como resolvida</button><button type="button" class="fl-btn" data-act="ignore">Ignorar</button>'}
          <button type="button" class="fl-btn" data-act="copy">Copiar stack</button>
        </div>
        ${this.resolving ? `<form class="fl-resolve" data-form="resolve"><label>Commit do fix (opcional)<input class="fl-fix" value="${escapeHtml(info?.build.commit?.slice(0, 7) ?? '')}" placeholder="def4567" autocomplete="off" spellcheck="false"></label><button type="submit" class="fl-btn on">Resolver</button><button type="button" class="fl-btn" data-act="cancel-resolve">Cancelar</button></form>` : ''}
        <div class="fl-chooser-slot"></div>
      </div>
      <details class="fl-sec" data-sec="stack" open><summary>Stack</summary>${note ? `<div class="fl-note">${escapeHtml(note)}</div>` : ''}<pre class="fl-stack">${stack ? escapeHtml(stack) : '(sem stack)'}</pre></details>
      <details class="fl-sec" data-sec="context"${wide ? ' open' : ''}><summary>Contexto</summary>${ctx.length ? `<dl class="fl-ctx">${ctx.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(typeof v === 'string' ? v : JSON.stringify(v))}</dd>`).join('')}</dl>` : '<div class="dim">sem contexto</div>'}</details>
      <details class="fl-sec" data-sec="occ"${wide ? ' open' : ''}><summary>Ocorrências (${d.occurrenceTotal})</summary><ul class="fl-occ">${d.occurrences.map(o => `<li>${when(o.ts)} · v${escapeHtml(o.version.replace(/^v/, ''))}${o.commit ? ` · ${escapeHtml(o.commit.slice(0, 7))}` : ''} · ${escapeHtml(o.proc)}</li>`).join('')}</ul>${d.occurrenceTotal > d.occurrences.length ? `<button type="button" class="lnk" data-act="more">ver mais (${d.occurrenceTotal - d.occurrences.length})</button>` : ''}</details>
      <details class="fl-sec" data-sec="notes" open><summary>Notas (${d.notes.length})</summary>${d.notes.map(n => `<div class="fl-n"><span class="fl-nwho">${escapeHtml(n.author)} · ${when(n.ts)}</span><div>${escapeHtml(n.text)}</div></div>`).join('')}<textarea class="fl-note-in" rows="2" placeholder="escrever nota… (Ctrl+Enter salva)" aria-label="Nova nota">${escapeHtml(this.noteDraft)}</textarea><button type="button" class="fl-btn" data-act="save-note">Salvar nota</button></details>
      <details class="fl-sec" data-sec="fix" open><summary>Resolução</summary><div>${d.fix ? `fix: <code>${escapeHtml(d.fix.commit ?? 'sem commit')}</code>${d.fix.by ? ` · ${escapeHtml(d.fix.by)}` : ''} · ${when(d.fix.ts)}` : 'fix: —'}</div></details>`
    this.q<HTMLElement>('.fl-back').append(icon('caret-left'), document.createTextNode('Falhas'))
    if (this.chooser) this.drawChooser()
  }

  // ---------- the chooser ----------

  private openChooser(): void {
    if (this.chooser || !this.detail) return
    const data = this.host.chooser()
    this.chooser = { data, selected: data.selected, sending: false }
    this.drawChooser()
    this.q<HTMLElement>('.fl-chooser')?.focus()
  }

  private refreshChooser(): void {
    if (this.disposed || !this.chooser || this.chooser.sending) return
    const data = this.host.chooser()
    const keep = data.choices.find(c => c.key === this.chooser!.selected && c.enabled)
    this.chooser = { ...this.chooser, data, selected: keep ? keep.key : data.selected }
    this.drawChooser()
  }

  private drawChooser(): void {
    const slot = this.element.querySelector<HTMLElement>('.fl-chooser-slot')
    if (!slot) return
    const c = this.chooser
    if (!c) { slot.replaceChildren(); return }
    const cwd = this.host.store.info?.cwd ?? ''
    slot.innerHTML = `<div class="fl-chooser" tabindex="-1" role="radiogroup" aria-label="Mandar para qual agente?">
      <div class="fl-ch-h">Mandar para qual agente?</div>
      ${c.data.choices.length ? c.data.choices.map(ch => `<label class="fl-choice${ch.enabled ? '' : ' off'}" data-key="${escapeHtml(ch.key)}"><input type="radio" name="fl-agent" value="${escapeHtml(ch.key)}"${ch.key === c.selected ? ' checked' : ''}${ch.enabled && !c.sending ? '' : ' disabled'}><span class="fl-ch-l">${escapeHtml(ch.label)}</span><span class="fl-ch-s">${escapeHtml(ch.enabled ? ch.state : ch.reason ?? ch.state)}</span>${ch.link ? `<button type="button" class="lnk" data-act="link" data-profile="${escapeHtml(ch.link.profileId)}">${escapeHtml(ch.link.text)}</button>` : ''}</label>`).join('') : '<div class="dim">Nenhum agente disponível.</div>'}
      ${cwd ? `<div class="fl-ch-cwd dim">Um painel novo abre em ${escapeHtml(cwd)}</div>` : ''}
      ${c.message ? `<div class="fl-ch-msg">${escapeHtml(c.message)}</div>` : ''}
      <div class="fl-ch-act"><button type="button" class="fl-primary" data-act="confirm-send"${c.selected && !c.sending ? '' : ' disabled'}>${c.sending ? 'Enviando…' : 'Enviar'}</button><button type="button" class="fl-btn" data-act="cancel-send"${c.sending ? ' disabled' : ''}>Cancelar</button></div>
    </div>`
  }

  private closeChooser(): void {
    this.chooser = undefined
    this.drawChooser()
  }

  private async confirmSend(): Promise<void> {
    const c = this.chooser
    const d = this.detail
    if (!c || !d || c.sending) return
    const choice = c.data.choices.find(x => x.key === c.selected && x.enabled)
    if (!choice) return
    c.sending = true
    c.message = choice.kind === 'new' ? 'Abrindo o painel e esperando o agente ficar pronto…' : undefined
    this.drawChooser()
    const r = await this.host.send(choice, { id: d.id, sig: d.sig })
    if (this.disposed) return
    if (r.ok) {
      this.chooser = undefined
      this.drawChooser()
      this.toast(`Enviada para ${escapeHtml(r.label)}`)
      this.detailKey = ''
      this.render()
    } else if (this.chooser) {
      this.chooser.sending = false
      this.chooser.message = r.message
      this.refreshChooser()
      this.drawChooser()
    }
  }

  // ---------- actions ----------

  private toast(html: string, undo?: () => void): void {
    const el = this.q<HTMLElement>('.fl-toast')
    el.innerHTML = `<span>${html}</span>${undo ? '<button type="button" class="lnk" data-act="undo">Desfazer</button>' : ''}`
    this.toastText = el.textContent ?? ''
    el.hidden = false
    this.undo = undo
    if (this.toastTimer) clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(() => { el.hidden = true; this.toastText = undefined; this.undo = undefined }, undo ? 6000 : 3400)
  }
  private undo: (() => void) | undefined

  private async change(action: ScreenAction, then?: () => void): Promise<boolean> {
    const row = this.selectedRow()
    if (!row) return false
    const r = await this.host.update(row.id, action)
    if (!r.ok) {
      this.toast(`Não salvei: ${escapeHtml(r.message)}`)
      return false
    }
    then?.()
    await this.host.store.refresh()
    return true
  }

  private async markIgnored(): Promise<void> {
    const row = this.selectedRow()
    if (!row) return
    await this.change({ type: 'ignore' }, () => this.toast(`${escapeHtml(row.id)} ignorada`, () => { void this.host.update(row.id, { type: 'reopen' }).then(() => this.host.store.refresh()) }))
  }

  private async addTags(text: string): Promise<void> {
    const tags = text.split(/[\s,]+/).filter(Boolean)
    if (!tags.length) return
    await this.change({ type: 'tag', tags })
  }

  private async saveNote(): Promise<void> {
    const ta = this.element.querySelector<HTMLTextAreaElement>('.fl-note-in')
    const text = (ta?.value ?? this.noteDraft).trim()
    if (!text) return
    if (await this.change({ type: 'note', text })) this.noteDraft = ''
    else this.noteDraft = text
  }

  private select(sig: string, open: boolean): void {
    if (sig !== this.selectedSig) {
      this.selectedSig = sig
      this.detail = undefined
      this.detailKey = ''
      this.showAll = false
      this.resolving = false
      this.noteDraft = ''
      this.chooser = undefined
      void this.loadDetail()
    }
    if (open) this.view = 'detail'
    this.render()
  }

  private move(delta: number): void {
    if (!this.visible.length) return
    const i = Math.max(0, this.visible.findIndex(r => r.sig === this.selectedSig))
    const next = this.visible[Math.min(this.visible.length - 1, Math.max(0, i + delta))]!
    this.select(next.sig, false)
  }

  // ---------- wiring ----------

  private wire(): void {
    const el = this.element
    el.addEventListener('click', ev => {
      const t = ev.target as HTMLElement
      const tab = t.closest<HTMLElement>('[data-tab]')
      if (tab) { this.tab = tab.dataset.tab as Tab; this.render(); void this.loadDetail(); return }
      const row = t.closest<HTMLElement>('.fl-row')
      if (row) { this.select(row.dataset.sig!, true); return }
      const act = t.closest<HTMLElement>('[data-act]')
      if (!act) return
      this.act(act.dataset.act!, act)
    })
    el.addEventListener('change', ev => {
      const t = ev.target as HTMLElement
      if (t.matches('.fl-tabselect')) { this.tab = (t as HTMLSelectElement).value as Tab; this.render(); void this.loadDetail() }
      else if (t.matches('.fl-tagfilter')) { this.tag = (t as HTMLSelectElement).value; this.render(); void this.loadDetail() }
      else if (t.matches('.fl-order')) { this.by = (t as HTMLSelectElement).value as 'last' | 'count'; this.render() }
      else if (t.matches('input[name="fl-agent"]') && this.chooser) { this.chooser.selected = (t as HTMLInputElement).value; this.drawChooser() }
    })
    el.addEventListener('input', ev => {
      const t = ev.target as HTMLElement
      if (t.matches('.fl-q')) { this.query = (t as HTMLInputElement).value; this.render(); void this.loadDetail() }
      else if (t.matches('.fl-note-in')) this.noteDraft = (t as HTMLTextAreaElement).value
    })
    el.addEventListener('submit', ev => {
      ev.preventDefault()
      const form = ev.target as HTMLElement
      if (form.matches('[data-form="resolve"]')) {
        const fix = form.querySelector<HTMLInputElement>('.fl-fix')!.value.trim()
        void this.change({ type: 'done', ...(fix ? { fix } : {}) }, () => { this.resolving = false; this.toast(`${escapeHtml(this.detail?.id ?? '')} resolvida${fix ? ` (fix ${escapeHtml(fix)})` : ' (sem commit)'}`) })
      }
    })
    el.addEventListener('keydown', ev => this.onKey(ev))
    el.addEventListener('contextmenu', ev => {
      const row = (ev.target as HTMLElement).closest<HTMLElement>('.fl-row')
      if (row) { ev.preventDefault(); this.select(row.dataset.sig!, false); this.host.copy(row.dataset.id!) }
    })
  }

  private act(name: string, node: HTMLElement): void {
    switch (name) {
      case 'back': this.view = 'list'; this.render(); this.focus(); break
      case 'retry': void this.host.store.refresh(); break
      case 'open-folder': { const dir = this.host.store.info?.dir; if (dir) this.host.openFolder(dir); break }
      case 'all': this.tab = 'all'; this.render(); void this.loadDetail(); break
      case 'clear-search': this.query = ''; this.q<HTMLInputElement>('.fl-q').value = ''; this.render(); void this.loadDetail(); break
      case 'send': this.openChooser(); break
      case 'cancel-send': this.closeChooser(); break
      case 'confirm-send': void this.confirmSend(); break
      case 'link': if (node.dataset.profile) this.host.openProfile(node.dataset.profile); break
      case 'resolve': this.resolving = true; this.detailKey = ''; this.renderDetail(); this.element.querySelector<HTMLInputElement>('.fl-fix')?.focus(); break
      case 'cancel-resolve': this.resolving = false; this.detailKey = ''; this.renderDetail(); break
      case 'ignore': void this.markIgnored(); break
      case 'reopen': void this.change({ type: 'reopen' }, () => this.toast(`${escapeHtml(this.detail?.id ?? '')} aberta`)); break
      case 'copy': {
        const d = this.detail
        if (d) { this.host.copy(`${d.id} ${d.message}\n${d.occurrences[0]?.stack ?? ''}`.trimEnd()); this.toast('Stack copiada') }
        break
      }
      case 'untag': if (node.dataset.tag) void this.change({ type: 'tag', tags: [node.dataset.tag], remove: true }); break
      case 'save-note': void this.saveNote(); break
      case 'more': this.showAll = true; this.detailKey = ''; void this.loadDetail(); break
      case 'undo': { const u = this.undo; this.undo = undefined; this.q<HTMLElement>('.fl-toast').hidden = true; u?.(); break }
    }
  }

  private onKey(ev: KeyboardEvent): void {
    const t = ev.target as HTMLElement
    if (t.matches('.fl-tag-in')) {
      if (ev.key === 'Enter') { ev.preventDefault(); const v = (t as HTMLInputElement).value; (t as HTMLInputElement).value = ''; void this.addTags(v) }
      else if (ev.key === 'Escape') { ev.stopPropagation(); (t as HTMLInputElement).value = ''; this.q<HTMLElement>('.fl-detail').focus() }
      return
    }
    if (t.matches('.fl-note-in')) {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); void this.saveNote() }
      else if (ev.key === 'Escape') { ev.stopPropagation(); this.q<HTMLElement>('.fl-detail').focus() }
      return
    }
    if (t.matches('.fl-fix')) {
      if (ev.key === 'Escape') { ev.stopPropagation(); this.resolving = false; this.detailKey = ''; this.renderDetail(); this.q<HTMLElement>('.fl-detail').focus() }
      return
    }
    if (t.matches('.fl-q')) {
      if (ev.key === 'Escape' && this.query) { ev.stopPropagation(); this.query = ''; (t as HTMLInputElement).value = ''; this.render(); void this.loadDetail() }
      else if (ev.key === 'ArrowDown') { ev.preventDefault(); this.q<HTMLElement>('.fl-list').focus() }
      return
    }
    if (t.matches('select')) return
    if (this.chooser && t.closest('.fl-chooser')) {
      if (ev.key === 'Escape') { ev.stopPropagation(); if (!this.chooser.sending) { this.closeChooser(); this.q<HTMLElement>('.fl-detail').focus() } }
      else if (ev.key === 'Enter' && !(t as HTMLElement).matches('button')) { ev.preventDefault(); void this.confirmSend() }
      else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault()
        const enabled = this.chooser.data.choices.filter(c => c.enabled)
        const i = enabled.findIndex(c => c.key === this.chooser!.selected)
        const next = enabled[Math.min(enabled.length - 1, Math.max(0, i + (ev.key === 'ArrowDown' ? 1 : -1)))]
        if (next) { this.chooser.selected = next.key; this.drawChooser(); this.q<HTMLElement>('.fl-chooser').focus() }
      }
      return
    }
    if (t.matches('button, textarea, input, summary')) return
    switch (ev.key) {
      case 'ArrowDown': ev.preventDefault(); this.move(1); break
      case 'ArrowUp': ev.preventDefault(); this.move(-1); break
      case 'Enter': if (this.selectedSig && t.closest('.fl-list')) { ev.preventDefault(); this.view = 'detail'; this.render(); this.q<HTMLElement>('.fl-detail').focus() } break
      case 'Escape': if (this.view === 'detail') { ev.stopPropagation(); this.view = 'list'; this.render(); this.q<HTMLElement>('.fl-list').focus() } break
      case '/': ev.preventDefault(); this.q<HTMLInputElement>('.fl-q').focus(); break
      case 'i': if (this.selectedSig) { ev.preventDefault(); this.view = 'detail'; this.render(); this.openChooser() } break
      case 'e': if (this.selectedSig && this.detail && this.detail.status !== 'done') { ev.preventDefault(); this.view = 'detail'; this.render(); this.act('resolve', t) } break
      case 'x': if (this.selectedSig) { ev.preventDefault(); void this.markIgnored() } break
    }
  }
}

/** The screen's tab: a bug, the title, the ×; right-click opens the menu. */
export class FaultsTab implements ITabRenderer {
  readonly element: HTMLElement
  private api: DockviewPanelApi | undefined
  private readonly host: Pick<FaultsHost, 'onTabMenu' | 'onClose'>

  constructor(host: Pick<FaultsHost, 'onTabMenu' | 'onClose'>) {
    this.host = host
    this.element = document.createElement('div')
    this.element.className = 'tether-tab faults'
    const kind = document.createElement('span'); kind.className = 'kind'; kind.append(icon('bug'))
    const text = document.createElement('span'); text.className = 'text'; text.textContent = FAULTS_TITLE
    const close = document.createElement('button')
    close.className = 'close'; close.title = 'Fechar'; close.setAttribute('aria-label', 'Fechar falhas')
    close.append(icon('x'))
    close.addEventListener('pointerdown', ev => ev.stopPropagation())
    close.addEventListener('click', ev => { ev.stopPropagation(); if (this.api) this.host.onClose(this.api.id) })
    this.element.append(kind, text, close)
    this.element.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); if (this.api) this.host.onTabMenu(this.api.id, ev) })
    this.element.title = `${FAULTS_TITLE}\nO que quebrou no tether, e quem está investigando`
  }

  init(params: TabPartInitParameters): void {
    this.api = params.api
    this.element.dataset.slot = params.api.id
  }

  dispose(): void {}
}
