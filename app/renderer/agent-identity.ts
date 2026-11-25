// The agent's identity drawn: [engine icon] [emblem OR letter] name (agent-identity-rules.ts has the facts). One piece for
// every list of the app and its extensions, so the same agent reads the same everywhere. A tight place takes the compact
// form: the emblem or letter at full size and the engine as a small seal on its corner.
import { ICON_NAMES, icon, type IconName } from './icons.ts'
import { emblemBadge } from './tab-emblems.ts'
import { identityLabel, identityOf, type Identity, type IdentityInput, type IdentityMark } from './agent-identity-rules.ts'

export { identityOf, letterOf, type Identity, type IdentityInput } from './agent-identity-rules.ts'

export interface MarkOptions {
  /** The engine as a seal on the mark's corner, for a place that cannot hold the pair side by side. */
  compact?: boolean
  /** A ring around the mark: the owner of a channel. */
  crown?: boolean
}

/** The letter square: the agent's initial in its own hue (`--aid-hue`), the size of an emblem chip. */
export function letterSquare(letter: string, hue: number): HTMLElement {
  const el = document.createElement('span')
  el.className = 'aid-letter'
  el.style.setProperty('--aid-hue', String(hue))
  el.textContent = letter
  el.setAttribute('aria-hidden', 'true')
  return el
}

function engineIcon(id: Identity): HTMLElement {
  const cell = document.createElement('span')
  cell.className = 'aid-eng'
  const name = (ICON_NAMES as readonly string[]).includes(id.engine.icon) ? id.engine.icon as IconName : 'terminal-window'
  cell.append(icon(name))
  cell.title = id.engine.label
  cell.setAttribute('role', 'img')
  cell.setAttribute('aria-label', id.engine.label)
  cell.dataset.engine = id.kind
  return cell
}

/** The emblem's chip or the letter's square itself, with no wrapper (a row that places and spaces it by its own rules). */
export function bareMark(m: IdentityMark): HTMLElement {
  if (m.type === 'letter') return letterSquare(m.letter, m.hue)
  const chip = emblemBadge(m.emblem)
  chip.classList.add('aid-emblem')
  return chip
}

/** The engine's icon as a small seal for the corner of a mark (the tight places); the parent must be `position: relative`. */
export function engineSeal(id: Identity): HTMLElement {
  const seal = engineIcon(id)
  seal.classList.add('aid-seal')
  return seal
}

/** Only the emblem-or-letter square (for a list that already draws the engine's icon itself). */
export function markOf(id: Identity | Pick<Identity, 'mark'>, opts: Pick<MarkOptions, 'crown'> = {}): HTMLElement {
  const m = id.mark
  const mark = document.createElement('span')
  mark.className = `aid-mark${opts.crown ? ' crown' : ''}`
  mark.dataset.mark = m.type
  if (m.type === 'emblem') {
    const chip = emblemBadge(m.emblem)
    chip.classList.add('aid-emblem')
    mark.append(chip)
  } else {
    mark.append(letterSquare(m.letter, m.hue))
    if (opts.crown) mark.style.setProperty('--aid-hue', String(m.hue))
  }
  return mark
}

/** The pair without the name: the engine's icon, then the emblem or the letter. */
export function identityMark(id: Identity, opts: MarkOptions = {}): HTMLElement {
  const box = document.createElement('span')
  box.className = `aid${opts.compact ? ' compact' : ''}`
  box.dataset.engine = id.kind
  box.dataset.mark = id.mark.type
  const mark = markOf(id, opts)
  const eng = engineIcon(id)
  box.append(...(opts.compact ? [mark, eng] : [eng, mark]))
  return box
}

/** The whole identity: the pair and the name, one inline unit (the name is plain text; a list that links it draws its own). */
export function identityView(input: IdentityInput, opts: MarkOptions = {}): HTMLElement {
  const id = identityOf(input)
  const root = document.createElement('span')
  root.className = 'aid-view'
  root.title = identityLabel(id)
  const name = document.createElement('span')
  name.className = 'aid-name'
  name.textContent = id.name
  root.append(identityMark(id, opts), name)
  return root
}
