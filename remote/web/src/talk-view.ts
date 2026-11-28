// What a device that converses adds to the channel's view on the web (RR4 step 4.2b), around the app's own speaking box:
//   - the speeches on their way, just above the box: "enviando" from the tap on, "enviada" once the house gave its seq
//     (until the conversation shows it), "não enviada" with why, "Tentar de novo" and "Editar" (the text back in the box);
//     a polite live region says "Fala enviada." or "Fala não enviada" once, never the conversation again;
//   - the box's draft per channel, kept as it is typed and put back when the view comes (a reload, another session);
//   - the counter near the ceiling of a speech (SAY_TEXT_MAX), and its warning past it;
//   - on a touch screen, Enter breaks the line (the button sends); with a keyboard, Enter sends and Shift+Enter breaks.
// The box itself is the app's (extensions/channels/renderer/composer.ts): this file finds it by its classes and only adds.
import { icon, type IconName } from '../../../app/renderer/icons.ts'
import type { Talker } from './talk.ts'
import { counterOf, SAY_TEXT_MAX, whyText, type OutItem } from './talk-rules.ts'
import { el } from './ui-lite.ts'

const glyph = (name: IconName): SVGSVGElement => { const g = icon(name); g.setAttribute('aria-hidden', 'true'); return g }

/** What a state of a speech on its way says, on screen. */
export const OUT_TEXT = { sending: 'enviando…', sent: 'enviada', failed: 'não enviada', retry: 'Tentar de novo', edit: 'Editar' } as const

/** A touch screen with no keyboard to speak of: Enter breaks the line there. */
const touchOnly = (): boolean => { try { return matchMedia('(hover: none) and (pointer: coarse)').matches } catch { return false } }

export interface TalkViewOptions {
  /** The channel's view (channel-pane.ts `.ch-pane`). */
  element: HTMLElement
  channelId: string
  talker: Talker
  /** The phone's tier: Enter breaks the line there too. */
  phone(): boolean
}

export function mountTalkView(o: TalkViewOptions): { dispose(): void } {
  const { element, channelId, talker } = o
  const strip = el('div', 'rr-out')
  strip.setAttribute('role', 'list')
  strip.setAttribute('aria-label', 'Suas falas a caminho')
  strip.hidden = true
  // Polite, apart from the conversation's log: one short sentence per change of a speech of hers.
  const said = el('div', 'rr-sr')
  said.setAttribute('role', 'status')
  said.setAttribute('aria-live', 'polite')
  const foot = element.querySelector<HTMLElement>('.ch-foot')
  foot?.prepend(strip, said)

  let field: HTMLTextAreaElement | undefined
  let pick: HTMLSelectElement | undefined
  let counter: HTMLElement | undefined
  let overSaid = false
  let lastSaid = ''

  const announce = (text: string): void => {
    lastSaid = text
    said.textContent = ''
    setTimeout(() => { if (lastSaid === text) said.textContent = text }, 30)
  }

  const short = (t: string): string => (t.length > 80 ? `${t.slice(0, 80)}…` : t)

  const itemEl = (it: OutItem): HTMLElement => {
    const li = el('div', 'rr-out-i')
    li.setAttribute('role', 'listitem')
    li.dataset.state = it.state
    li.dataset.id = it.id
    const head = el('div', 'rr-out-h')
    const st = el('span', 'rr-out-st')
    st.append(glyph(it.state === 'sending' ? 'clock' : it.state === 'sent' ? 'check' : 'warning'), el('span', '', OUT_TEXT[it.state]))
    head.append(el('b', 'rr-out-me', 'Você'), el('span', 'rr-out-to', it.to.length ? `para ${it.to.join(', ')}` : 'para todos'), st)
    const body = el('p', 'rr-out-t', it.text)
    li.append(head, body)
    li.setAttribute('aria-label', `Sua fala, ${OUT_TEXT[it.state]}: ${short(it.text)}`)
    if (it.state === 'failed') {
      const why = el('p', 'rr-out-why', whyText(it.why))
      const acts = el('div', 'rr-out-acts')
      const again = el('button', 'rr-btn rr-out-b')
      again.type = 'button'
      again.dataset.act = 'retry'
      again.append(glyph('arrow-counter-clockwise'), el('span', '', OUT_TEXT.retry))
      again.addEventListener('click', () => talker.retry(it.id))
      const edit = el('button', 'rr-btn quiet rr-out-b')
      edit.type = 'button'
      edit.dataset.act = 'edit'
      edit.append(glyph('pencil-simple'), el('span', '', OUT_TEXT.edit))
      edit.addEventListener('click', () => backToBox(it.id))
      acts.append(again, edit)
      li.append(why, acts)
    }
    return li
  }

  const paint = (): void => {
    const items = talker.items(channelId)
    const held = document.activeElement instanceof HTMLElement && strip.contains(document.activeElement) ? document.activeElement : undefined
    const heldKey = held ? `${held.closest<HTMLElement>('.rr-out-i')?.dataset.id ?? ''}:${held.dataset.act ?? ''}` : undefined
    strip.replaceChildren(...items.map(itemEl))
    strip.hidden = items.length === 0
    // The newest speech is the one at the foot, next to the box: the strip shows it.
    strip.scrollTop = strip.scrollHeight
    if (heldKey) {
      const [id, act] = heldKey.split(':')
      const again = strip.querySelector<HTMLElement>(`.rr-out-i[data-id="${CSS.escape(id ?? '')}"] [data-act="${CSS.escape(act ?? '')}"]`)
      ;(again ?? field)?.focus({ preventScroll: true })
    }
  }

  const paintCounter = (): void => {
    if (!field || !counter) return
    const c = counterOf(field.value.length)
    counter.hidden = !c.show
    counter.textContent = c.text
    counter.classList.toggle('over', c.over)
    if (c.over && !overSaid) announce(`A fala passou de ${SAY_TEXT_MAX} caracteres: corte para enviar.`)
    overSaid = c.over
  }

  /** "Editar": the speech leaves the outbox and its text goes back to the box (after what is there, never over it). */
  const backToBox = (id: string): void => {
    const it = talker.take(id)
    if (!it || !field) return
    field.value = field.value.trim() === '' ? it.text : `${field.value}\n${it.text}`
    if (pick && it.to.length === 1 && [...pick.options].some(op => op.value === it.to[0])) pick.value = it.to[0]!
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.focus()
    field.setSelectionRange(field.value.length, field.value.length)
  }

  /** The box appeared in its slot (once the first answer came): its draft, its counter, its Enter. */
  const wire = (say: HTMLElement): void => {
    if (field) return
    const f = say.querySelector<HTMLTextAreaElement>('textarea.ch-field')
    if (!f) return
    field = f
    pick = say.querySelector<HTMLSelectElement>('select.ch-dsel') ?? undefined
    const draft = talker.draft(channelId)
    if (draft && f.value === '') f.value = draft
    counter = el('span', 'rr-count')
    counter.hidden = true
    const send = say.querySelector('.ch-send')
    send?.before(counter)
    f.setAttribute('enterkeyhint', o.phone() || touchOnly() ? 'enter' : 'send')
    f.addEventListener('input', () => { talker.setDraft(channelId, f.value); paintCounter() })
    // A touch screen's Enter is a new line (the composer would send): stopped on the way down, before the field's own key.
    say.addEventListener('keydown', ev => {
      if (ev.target !== f || ev.key !== 'Enter' || ev.shiftKey || ev.isComposing || !(o.phone() || touchOnly())) return
      if (say.querySelector<HTMLElement>('.ch-mention-list')?.hidden === false) return
      ev.stopPropagation()
    }, true)
    paintCounter()
  }

  const slot = element.querySelector<HTMLElement>('.ch-composer-slot')
  const watch = new MutationObserver(() => { const s = slot?.querySelector<HTMLElement>('.ch-say'); if (s) wire(s) })
  if (slot) {
    watch.observe(slot, { childList: true })
    const s = slot.querySelector<HTMLElement>('.ch-say')
    if (s) wire(s)
  }

  const sub = talker.onChange(n => {
    if (n.channel !== channelId) return
    paint()
    // The box empties itself after a speech goes (no input event): the counter follows.
    paintCounter()
    if (n.what === 'sent') announce('Fala enviada.')
    else if (n.what === 'failed') {
      const it = [...talker.items(channelId)].reverse().find(x => x.state === 'failed')
      announce(`Fala não enviada. ${whyText(it?.why)}`)
    }
  })
  paint()

  return {
    dispose: () => {
      sub.dispose()
      watch.disconnect()
      strip.remove()
      said.remove()
      counter?.remove()
    },
  }
}
