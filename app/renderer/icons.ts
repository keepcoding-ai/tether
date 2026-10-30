// Phosphor icons (@phosphor-icons/core, MIT), inlined at build time: only the SVGs imported here end up in
// the bundle (esbuild `text` loader, app/build.mjs). Every file carries fill="currentColor", so an icon
// takes the colour of its text and follows the theme. One weight (regular); `fill` only for the status dot.
import appWindow from '@phosphor-icons/core/assets/regular/app-window.svg'
import arrowClockwise from '@phosphor-icons/core/assets/regular/arrow-clockwise.svg'
import arrowSquareOut from '@phosphor-icons/core/assets/regular/arrow-square-out.svg'
import caretDown from '@phosphor-icons/core/assets/regular/caret-down.svg'
import circleFill from '@phosphor-icons/core/assets/fill/circle-fill.svg'
import circleHalf from '@phosphor-icons/core/assets/regular/circle-half.svg'
import clockCounterClockwise from '@phosphor-icons/core/assets/regular/clock-counter-clockwise.svg'
import folderOpen from '@phosphor-icons/core/assets/regular/folder-open.svg'
import ghost from '@phosphor-icons/core/assets/regular/ghost.svg'
import hourglass from '@phosphor-icons/core/assets/regular/hourglass.svg'
import info from '@phosphor-icons/core/assets/regular/info.svg'
import play from '@phosphor-icons/core/assets/regular/play.svg'
import plugs from '@phosphor-icons/core/assets/regular/plugs.svg'
import plugsConnected from '@phosphor-icons/core/assets/regular/plugs-connected.svg'
import plus from '@phosphor-icons/core/assets/regular/plus.svg'
import power from '@phosphor-icons/core/assets/regular/power.svg'
import question from '@phosphor-icons/core/assets/regular/question.svg'
import sparkle from '@phosphor-icons/core/assets/regular/sparkle.svg'
import squareSplitHorizontal from '@phosphor-icons/core/assets/regular/square-split-horizontal.svg'
import squareSplitVertical from '@phosphor-icons/core/assets/regular/square-split-vertical.svg'
import stopCircle from '@phosphor-icons/core/assets/regular/stop-circle.svg'
import terminalWindow from '@phosphor-icons/core/assets/regular/terminal-window.svg'
import trash from '@phosphor-icons/core/assets/regular/trash.svg'
import tray from '@phosphor-icons/core/assets/regular/tray.svg'
import warning from '@phosphor-icons/core/assets/regular/warning.svg'
import x from '@phosphor-icons/core/assets/regular/x.svg'
import xCircle from '@phosphor-icons/core/assets/regular/x-circle.svg'
import check from '@phosphor-icons/core/assets/regular/check.svg'
import copy from '@phosphor-icons/core/assets/regular/copy.svg'
import pencilSimple from '@phosphor-icons/core/assets/regular/pencil-simple.svg'
import shieldWarning from '@phosphor-icons/core/assets/regular/shield-warning.svg'
import slidersHorizontal from '@phosphor-icons/core/assets/regular/sliders-horizontal.svg'
import star from '@phosphor-icons/core/assets/regular/star.svg'
import list from '@phosphor-icons/core/assets/regular/list.svg'
import minus from '@phosphor-icons/core/assets/regular/minus.svg'
import folder from '@phosphor-icons/core/assets/regular/folder.svg'
import minusCircle from '@phosphor-icons/core/assets/regular/minus-circle.svg'
import tabs from '@phosphor-icons/core/assets/regular/tabs.svg'
import arrowLineLeft from '@phosphor-icons/core/assets/regular/arrow-line-left.svg'
import squareHalf from '@phosphor-icons/core/assets/regular/square-half.svg'
import columns from '@phosphor-icons/core/assets/regular/columns.svg'
import arrowLineRight from '@phosphor-icons/core/assets/regular/arrow-line-right.svg'
import arrowLineUp from '@phosphor-icons/core/assets/regular/arrow-line-up.svg'
import arrowLineDown from '@phosphor-icons/core/assets/regular/arrow-line-down.svg'
import arrowCounterClockwise from '@phosphor-icons/core/assets/regular/arrow-counter-clockwise.svg'
import palette from '@phosphor-icons/core/assets/regular/palette.svg'
import cards from '@phosphor-icons/core/assets/regular/cards.svg'
import textAa from '@phosphor-icons/core/assets/regular/text-aa.svg'
import type { SlotKind } from '../../src/daemon/protocol.ts'

const SVG = {
  'app-window': appWindow,
  'arrow-clockwise': arrowClockwise,
  'arrow-square-out': arrowSquareOut,
  'caret-down': caretDown,
  'circle-fill': circleFill,
  'circle-half': circleHalf,
  'clock-counter-clockwise': clockCounterClockwise,
  'folder-open': folderOpen,
  ghost,
  hourglass,
  info,
  play,
  plugs,
  'plugs-connected': plugsConnected,
  plus,
  power,
  question,
  sparkle,
  'square-split-horizontal': squareSplitHorizontal,
  'square-split-vertical': squareSplitVertical,
  'stop-circle': stopCircle,
  'terminal-window': terminalWindow,
  trash,
  tray,
  warning,
  x,
  'x-circle': xCircle,
  check,
  copy,
  folder,
  list,
  minus,
  'minus-circle': minusCircle,
  'pencil-simple': pencilSimple,
  'shield-warning': shieldWarning,
  'sliders-horizontal': slidersHorizontal,
  star,
  tabs,
  'arrow-line-left': arrowLineLeft,
  'square-half': squareHalf,
  columns,
  'arrow-line-right': arrowLineRight,
  'arrow-line-up': arrowLineUp,
  'arrow-line-down': arrowLineDown,
  'arrow-counter-clockwise': arrowCounterClockwise,
  palette,
  'text-aa': textAa,
  cards,
} as const

export type IconName = keyof typeof SVG

export const ICON_NAMES = Object.keys(SVG) as IconName[]

/** The agent's icon: Claude → sparkle, soul → ghost, shell → terminal window. */
export const KIND_ICON: Record<SlotKind, IconName> = { claude: 'sparkle', soul: 'ghost', shell: 'terminal-window' }

const templates = new Map<IconName, SVGSVGElement>()

function template(name: IconName): SVGSVGElement {
  let el = templates.get(name)
  if (!el) {
    const tpl = document.createElement('template')
    tpl.innerHTML = SVG[name]
    el = tpl.content.firstElementChild as SVGSVGElement
    el.classList.add('ph')
    el.setAttribute('aria-hidden', 'true')
    el.setAttribute('focusable', 'false')
    el.dataset.icon = name
    templates.set(name, el)
  }
  return el
}

/** A fresh inline <svg> for the icon; size and colour come from CSS (`.ph`, 1em square, currentColor). */
export function icon(name: IconName, className?: string): SVGSVGElement {
  const el = template(name).cloneNode(true) as SVGSVGElement
  if (className) el.classList.add(className)
  return el
}

/** Replaces the children of `host` with the icon (headers and tabs re-render on every state change). */
export function setIcon(host: HTMLElement, name: IconName): void {
  if (host.dataset.icon === name) return
  host.dataset.icon = name
  host.replaceChildren(icon(name))
}
