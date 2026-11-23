// The channels icon of the top bar (slice U3, `contributes.status`): the icon's state says there is something for the person
// (amber `warn`: a line addressed to her) and the popover lists the open channels, the unread of each and which ones have a
// line for her. A click on a row opens that channel's pane (`channels.open` with the channel as its argument). Quiet by rule:
// no number for lines to everyone, no colour either (they only show in the popover and as the ring on the pane's tab).
import type { Disposable, TetherUi } from '../../../app/renderer/ext-api.ts'
import type { ChannelSummary } from '../daemon/requests.ts'
import { CMD, STATUS_ID } from '../manifest.ts'
import { glyph } from './glyphs.ts'
import type { Marks } from './marks.ts'
import { popRows, stateOf, titleOf } from './view-model.ts'

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

const closePopover = (): void => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) }

export function createStatus(ui: TetherUi, marks: Marks, list: () => readonly ChannelSummary[]): Disposable[] {
  const render = (pop: HTMLElement): void => {
    pop.replaceChildren()
    pop.classList.add('ch-pop')
    pop.append(el('h5', 'ch-pop-head', 'Canais'))
    const rows = popRows(list(), marks.of)
    if (rows.length === 0) pop.append(el('p', 'ch-pop-empty', 'Nenhum canal aberto.'))
    for (const r of rows) {
      const b = el('button', `ch-pop-row${r.toMe > 0 ? ' to-me' : ''}`)
      b.type = 'button'
      b.dataset.channel = r.id
      b.append(glyph('chats-circle'), el('span', 'ch-pop-name', `#${r.name}`), el('span', 'ch-pop-meta', r.members))
      const tail = el('span', `ch-pop-tail${r.toMe > 0 ? ' me' : ''}`)
      if (r.unread > 0 && r.toMe === 0) tail.append(el('span', 'ch-ring'))
      if (r.text !== '') tail.append(r.text)
      b.append(tail)
      b.addEventListener('click', () => { closePopover(); void ui.commands.run(CMD.open, r.id) })
      pop.append(b)
    }
    const more = el('button', 'ch-pop-more', 'Abrir canal…')
    more.type = 'button'
    more.addEventListener('click', () => { closePopover(); void ui.commands.run(CMD.open) })
    pop.append(more)
  }

  const handle = ui.status.register({
    id: STATUS_ID,
    title: () => titleOf(marks.totals()),
    state: () => stateOf(marks.totals()),
    badge: () => { const n = marks.totals().toMe; return n > 0 ? n : undefined },
    render,
  })
  ui.test.expose('status', () => {
    const t = marks.totals()
    return { state: stateOf(t), title: titleOf(t), badge: t.toMe > 0 ? t.toMe : undefined, unread: t.unread, toMe: t.toMe, rows: popRows(list(), marks.of) }
  })
  return [handle, marks.onDidChange(() => handle.update())]
}
