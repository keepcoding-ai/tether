// The icons the channel's pane draws. The ones the core table has come from it; the rest are Phosphor's own files imported here,
// so the pane needs nothing new in app/renderer/icons.ts (its table is the core's, closed to extensions).
import chartBar from '@phosphor-icons/core/assets/regular/chart-bar.svg'
import chatsCircle from '@phosphor-icons/core/assets/regular/chats-circle.svg'
import lock from '@phosphor-icons/core/assets/regular/lock.svg'
import speakerHigh from '@phosphor-icons/core/assets/regular/speaker-high.svg'
import speakerSlash from '@phosphor-icons/core/assets/regular/speaker-slash.svg'
import user from '@phosphor-icons/core/assets/regular/user.svg'
import userMinus from '@phosphor-icons/core/assets/regular/user-minus.svg'
import userPlus from '@phosphor-icons/core/assets/regular/user-plus.svg'
import users from '@phosphor-icons/core/assets/regular/users.svg'
import arrowBendDownRight from '@phosphor-icons/core/assets/regular/arrow-bend-down-right.svg'
import paperPlaneTilt from '@phosphor-icons/core/assets/regular/paper-plane-tilt.svg'
import plus from '@phosphor-icons/core/assets/regular/plus.svg'
import smiley from '@phosphor-icons/core/assets/regular/smiley.svg'
import warning from '@phosphor-icons/core/assets/regular/warning.svg'
import paperclip from '@phosphor-icons/core/assets/regular/paperclip.svg'
import xMark from '@phosphor-icons/core/assets/regular/x.svg'
import key from '@phosphor-icons/core/assets/regular/key.svg'
import fileCode from '@phosphor-icons/core/assets/regular/file-code.svg'
import { icon, type IconName } from '../../../app/renderer/icons.ts'
import type { NoticeGlyph } from './view-model.ts'

const LOCAL = {
  'chart-bar': chartBar, 'chats-circle': chatsCircle, lock, 'speaker-high': speakerHigh, 'speaker-slash': speakerSlash, user, 'user-minus': userMinus,
  'user-plus': userPlus, users, 'arrow-bend-down-right': arrowBendDownRight, 'paper-plane-tilt': paperPlaneTilt, plus, smiley, warning,
  paperclip, x: xMark, key, 'file-code': fileCode,
} as const
export type LocalGlyph = keyof typeof LOCAL
export type GlyphName = LocalGlyph | IconName

const isLocal = (name: string): name is LocalGlyph => Object.hasOwn(LOCAL, name)
const templates = new Map<LocalGlyph, SVGSVGElement>()

/** A fresh inline <svg> (class `ph`, 1em, currentColor). */
export function glyph(name: GlyphName): SVGSVGElement {
  if (!isLocal(name)) return icon(name)
  let el = templates.get(name)
  if (!el) {
    const tpl = document.createElement('template')
    tpl.innerHTML = LOCAL[name]
    el = tpl.content.firstElementChild as SVGSVGElement
    el.classList.add('ph')
    el.setAttribute('aria-hidden', 'true')
    el.setAttribute('focusable', 'false')
    templates.set(name, el)
  }
  return el.cloneNode(true) as SVGSVGElement
}

/** The icon of a system line, by the gesture it records. */
export const NOTICE_ICON: Record<NoticeGlyph, GlyphName> = {
  join: 'user-plus', leave: 'user-minus', remove: 'user-minus', mute: 'speaker-slash', unmute: 'speaker-high', close: 'lock',
  reopen: 'arrow-counter-clockwise', owner: 'crown-simple', create: 'chats-circle', info: 'info',
}
