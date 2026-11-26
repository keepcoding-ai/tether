// The shell around every pane's content (the quick view's lending, V1). main.ts `createComponent` wraps what each pane type
// creates, at the one place dockview creates panes, so any pane of today or of the future can be lent alive to a host
// outside dockview (the quick view's card) with no code in its type. The rules are in pane-loan-rules.ts.
//
// Why a shell: dockview appends and removes the content's root element by itself (activating a tab appends it, hiding the
// tab removes it), so the root cannot leave. The shell is that root; the type's content lives inside it and is what leaves.
// While lent, the shell holds the "sendo espiada" notice in its place, and whatever dockview does to the shell (activate
// the tab, hide it, resize the group) never reaches into the host.
//
// What the shell forwards: `init`, `update`, `focus`, `toJSON` always; `layout`, `onShow`, `onHide` while the content is
// home. While lent, dockview's size and visibility are kept, the content is told it is shown and is sized by the host
// (`layout` follows the host's ResizeObserver, only for a content that has `layout`), and giving back tells it dockview's
// size and visibility again. A content that measures itself in the DOM (ResizeObserver, Monaco's automaticLayout, the
// terminal's fit) follows by itself. The shell is a plain block at 100% height (no position of its own), so the content's
// own `height: 100%` resolves as it did without it.
import type { GroupPanelPartInitParameters, IContentRenderer } from 'dockview-core'
import { icon } from './icons.ts'
import { loanStep, type LoanState } from './pane-loan-rules.ts'

type UpdateEvent = Parameters<NonNullable<IContentRenderer['update']>>[0]

/** A type's own lending (plan `custom`): it moves a part of itself and puts `notice` in its place; `lost` if it is disposed meanwhile. */
export interface PaneLendHooks {
  lend(notice: HTMLElement, lost: () => void): HTMLElement
  takeBack(): void
}

/** A loan in course: `part` is what sits in the host; `giveBack` puts it home (once; nothing after the pane is gone). */
export interface ShellLoan {
  readonly part: HTMLElement
  giveBack(): void
}

export interface LendRequest {
  /** Where the content goes (the borrower mounts it there and owns the host). */
  host: HTMLElement
  /** What stands in the content's place in the tab meanwhile. */
  notice: HTMLElement
  /** The pane went away while lent (closed, moved to another desk, the window going): the content left the host, nothing comes back. */
  lost(): void
  /** The type's own hooks (plan `custom`); without them the whole content moves. */
  hooks?: PaneLendHooks | undefined
}

interface Loan {
  host: HTMLElement
  part: HTMLElement
  lost: () => void
  hooks: PaneLendHooks | undefined
  observer: ResizeObserver | undefined
}

export class PaneShell implements IContentRenderer {
  readonly element: HTMLElement
  /** What the pane type created: the content dockview would have held without the shell. */
  readonly content: IContentRenderer
  private paneId = ''
  private state: LoanState = 'home'
  private loan: Loan | undefined
  /** dockview's last size for the pane (told to the content when it comes back). */
  private size: { width: number; height: number } | undefined
  /** dockview's last word on the pane's visibility (undefined = it never said: a pane not rendered yet, or an `always` one). */
  private shown: boolean | undefined
  /** What the content was last told (onShow / onHide), so it is never told twice the same. */
  private told: boolean | undefined

  constructor(content: IContentRenderer) {
    this.content = content
    this.element = document.createElement('div')
    this.element.className = 'pane-shell'
    this.element.append(content.element)
  }

  /** The pane's id (dockview gives it on `init`; '' before). */
  get id(): string { return this.paneId }
  get loanState(): LoanState { return this.state }

  init(params: GroupPanelPartInitParameters): void {
    this.paneId = params.api.id
    this.content.init(params)
  }

  update(event: UpdateEvent): void { this.content.update?.(event) }
  focus(): void { this.content.focus?.() }
  toJSON(): object { return this.content.toJSON?.() ?? {} }

  layout(width: number, height: number): void {
    this.size = { width, height }
    if (this.state !== 'lent') this.content.layout?.(width, height)
  }

  onShow(): void {
    this.shown = true
    if (this.state !== 'lent') this.tell(true)
  }

  onHide(): void {
    this.shown = false
    if (this.state !== 'lent') this.tell(false)
  }

  /**
   * Lends the content to `req.host`; undefined when it is lent already or the pane is gone (the caller checks the plan
   * first: pane-loan-rules.ts `lendRefusal`). The content is told it is shown and, when it takes `layout`, sized by the host.
   */
  lend(req: LendRequest): ShellLoan | undefined {
    const step = loanStep(this.state, 'lend')
    if (step.act !== 'move-out') return undefined
    let part: HTMLElement
    if (req.hooks) {
      part = req.hooks.lend(req.notice, () => this.lost())
    } else {
      part = this.content.element
      this.element.replaceChildren(req.notice)
    }
    this.state = step.state
    const loan: Loan = { host: req.host, part, lost: req.lost, hooks: req.hooks, observer: undefined }
    this.loan = loan
    req.host.append(part)
    if (!req.hooks) {
      this.tell(true)
      if (this.content.layout) {
        const fit = (): void => { if (this.loan === loan) this.content.layout?.(loan.host.clientWidth, loan.host.clientHeight) }
        loan.observer = new ResizeObserver(fit)
        loan.observer.observe(loan.host)
        fit()
      }
    }
    return { part, giveBack: () => { if (this.loan === loan) this.giveBack() } }
  }

  dispose(): void {
    const step = loanStep(this.state, 'dispose')
    this.state = step.state
    const loan = this.loan
    this.loan = undefined
    loan?.observer?.disconnect()
    try {
      this.content.dispose?.()
    } finally {
      // Disposed while lent: the content leaves the host with the pane (nothing is left behind there) and the borrower hears it.
      if (loan && step.act === 'drop') {
        loan.part.remove()
        loan.lost()
      }
    }
  }

  /** The content comes home in place of the notice, with dockview's size and visibility told again. */
  private giveBack(): void {
    const loan = this.loan
    const step = loanStep(this.state, 'give-back')
    if (!loan || step.act !== 'move-back') return
    this.state = step.state
    this.loan = undefined
    loan.observer?.disconnect()
    if (loan.hooks) { loan.hooks.takeBack(); return }
    this.element.replaceChildren(this.content.element)
    if (this.size) this.content.layout?.(this.size.width, this.size.height)
    this.tell(this.shown ?? false)
  }

  /** The type's own part went away while lent (its hooks said so): the borrower hears it, nothing comes back. */
  private lost(): void {
    const loan = this.loan
    const step = loanStep(this.state, 'lost')
    if (!loan || step.act !== 'drop') return
    this.state = step.state
    this.loan = undefined
    loan.observer?.disconnect()
    loan.part.remove()
    loan.lost()
  }

  private tell(shown: boolean): void {
    if (this.told === shown) return
    this.told = shown
    if (shown) this.content.onShow?.()
    else this.content.onHide?.()
  }
}

/** The notice a lent pane shows in its place (screen 6 of the peek preview): the eye, the title, the sentence. */
export function lentNoticeElement(n: { title: string; text: string }): HTMLElement {
  // (The card sits over it: a button here could not be reached, so the notice is the icon, the title and the sentence.)
  const root = document.createElement('div'); root.className = 'peek-lent'; root.setAttribute('role', 'status')
  const ill = document.createElement('span'); ill.className = 'ill'; ill.append(icon('eye'))
  const t = document.createElement('p'); t.className = 't'; t.textContent = n.title
  const p = document.createElement('p'); p.className = 'mut'; p.textContent = n.text
  root.append(ill, t, p)
  return root
}
