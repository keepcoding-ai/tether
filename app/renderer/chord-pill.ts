// The pill that shows a two-key chord in progress (docs/keybindings-preview.html, section C): bottom centre of
// the window, over everything. States: waiting for the second key (with the terminal's reminder when the focus is
// in one), the list of what can come after ~800 ms, the chord completed (fades by itself), the second key was not a
// shortcut (warns, offers the screen). There is no timeout on the wait itself: Esc, a click or losing the focus cancel.
import { icon } from './icons.ts'
import { chordLabel, keysLabel, type Chord, type Keybinding } from './shortcuts.ts'

/** How long the plain pill waits before it opens the list of continuations. */
export const PILL_LIST_DELAY_MS = 800
const DONE_MS = 1400
const UNKNOWN_MS = 2600

export interface PillHost {
  /** The title of a command id (what the list shows), undefined for an id the registry does not know. */
  titleOf(command: string): string | undefined
  groupOf(command: string): string | undefined
  /** "Ver atalhos de teclado" in the unknown state. */
  showKeybindings(): void
}

export type PillState = 'hidden' | 'wait' | 'list' | 'done' | 'unknown'

export class ChordPill {
  readonly element: HTMLElement
  state: PillState = 'hidden'
  private readonly host: PillHost
  private timer: ReturnType<typeof setTimeout> | undefined
  private first: Chord | undefined
  private next: Keybinding[] = []
  private terminal = false

  constructor(host: PillHost) {
    this.host = host
    this.element = document.createElement('div')
    this.element.id = 'chord-pill'
    this.element.className = 'chord-pill'
    this.element.hidden = true
    this.element.setAttribute('role', 'status')
    this.element.setAttribute('aria-live', 'polite')
    document.body.append(this.element)
    this.element.addEventListener('click', ev => {
      const go = (ev.target as HTMLElement).closest('[data-go]')
      if (go) { ev.preventDefault(); this.hide(); this.host.showKeybindings() }
    })
  }

  private clearTimer(): void { if (this.timer) { clearTimeout(this.timer); this.timer = undefined } }

  /** The first key went down: waiting for the second. */
  wait(first: Chord, next: Keybinding[], terminal: boolean): void {
    this.clearTimer()
    this.first = first; this.next = next; this.terminal = terminal
    this.render('wait')
    this.timer = setTimeout(() => { if (this.state === 'wait') this.render('list') }, PILL_LIST_DELAY_MS)
  }

  /** The chord completed a command. */
  done(keys: Chord[], command: string): void {
    this.clearTimer()
    this.render('done', { keys, command })
    this.timer = setTimeout(() => { if (this.state === 'done') this.hide() }, DONE_MS)
  }

  /** The second key completed nothing. */
  unknown(keys: Chord[]): void {
    this.clearTimer()
    this.render('unknown', { keys })
    this.timer = setTimeout(() => { if (this.state === 'unknown') this.hide() }, UNKNOWN_MS)
  }

  hide(): void {
    this.clearTimer()
    this.state = 'hidden'
    this.element.hidden = true
    this.element.className = 'chord-pill'
    this.element.replaceChildren()
  }

  private render(state: PillState, data: { keys?: Chord[]; command?: string } = {}): void {
    this.state = state
    this.element.hidden = false
    this.element.className = `chord-pill ${state}`
    const el = this.element
    el.replaceChildren()
    const main = document.createElement('div'); main.className = 'main'
    const esc = document.createElement('span'); esc.className = 'esc'; esc.innerHTML = '<kbd>Esc</kbd> cancela'
    if (state === 'wait' || state === 'list') {
      const kbd = document.createElement('kbd'); kbd.textContent = chordLabel(this.first!)
      const txt = document.createElement('span'); txt.className = 'txt'
      txt.innerHTML = state === 'wait' ? 'pressionado · aguardando a segunda tecla<span class="dots"><i></i><i></i><i></i></span>' : 'aguardando a segunda tecla · <b>o que pode vir:</b>'
      main.append(kbd, txt, esc)
      el.append(main)
      if (state === 'list') el.append(this.continuations())
      if (this.terminal) {
        const hint = document.createElement('div'); hint.className = 'term-hint'
        hint.append(icon('info'))
        const s = document.createElement('span'); s.innerHTML = `Foco no terminal: <kbd>${chordLabel(this.first!)}</kbd> de novo envia a tecla ao programa.`
        hint.append(s)
        el.append(hint)
      }
      return
    }
    if (state === 'done') {
      main.append(icon('check'))
      const chord = document.createElement('span'); chord.className = 'chord'; chord.innerHTML = chordHtml(data.keys!)
      const txt = document.createElement('span'); txt.className = 'txt'
      const b = document.createElement('b'); b.textContent = this.host.titleOf(data.command!) ?? data.command!
      txt.append(b)
      main.append(chord, txt)
      el.append(main)
      return
    }
    main.append(icon('warning'))
    const chord = document.createElement('span'); chord.className = 'chord'; chord.innerHTML = chordHtml(data.keys!)
    const txt = document.createElement('span'); txt.className = 'txt'; txt.textContent = 'não é um atalho'
    const link = document.createElement('span'); link.className = 'esc'
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'lnk'; btn.dataset.go = 'keybindings'; btn.textContent = 'Ver atalhos de teclado'
    link.append(btn)
    main.append(chord, txt, link)
    el.append(main)
  }

  /** The commands that can follow the first key, grouped as the palette groups them. */
  private continuations(): HTMLElement {
    const cont = document.createElement('div'); cont.className = 'cont'
    const groups = new Map<string, Keybinding[]>()
    for (const b of this.next) {
      const g = this.host.groupOf(b.command) ?? 'Outros'
      if (!groups.has(g)) groups.set(g, [])
      groups.get(g)!.push(b)
    }
    for (const [g, list] of groups) {
      const h = document.createElement('h6'); h.textContent = g; cont.append(h)
      for (const b of list) {
        const title = this.host.titleOf(b.command)
        if (!title) continue
        const row = document.createElement('div'); row.className = 'c'
        const kbd = document.createElement('kbd'); kbd.textContent = chordLabel(b.keys[1]!)
        const s = document.createElement('span'); s.textContent = title
        row.append(kbd, s)
        cont.append(row)
      }
    }
    if (this.terminal) {
      const h = document.createElement('h6'); h.textContent = 'Terminal'; cont.append(h)
      const row = document.createElement('div'); row.className = 'c'
      const kbd = document.createElement('kbd'); kbd.textContent = chordLabel(this.first!)
      const s = document.createElement('span'); s.textContent = 'Enviar a tecla ao programa'
      row.append(kbd, s); cont.append(row)
    }
    return cont
  }

  /** Tests: what the pill says. */
  snapshot(): { state: PillState; text: string; continuations: number } {
    return { state: this.state, text: this.element.textContent ?? '', continuations: this.element.querySelectorAll('.cont .c').length }
  }
}

/** Keys as <kbd>s with "depois" between them ("Ctrl+K depois Ctrl+S"). */
export function chordHtml(keys: readonly Chord[]): string {
  return keys.map(k => `<kbd>${escapeHtml(chordLabel(k))}</kbd>`).join('<span class="then">depois</span>')
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

export { keysLabel }
