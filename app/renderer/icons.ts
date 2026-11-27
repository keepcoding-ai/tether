// Phosphor icons (@phosphor-icons/core, MIT), inlined at build time: only the SVGs imported here end up in
// the bundle (esbuild `text` loader, app/build.mjs). Every file carries fill="currentColor", so an icon
// takes the colour of its text and follows the theme. One weight (regular); `fill` for the status dot, the pin and the side bars' open pads.
import { agentTable } from './agent-ui.ts'
import { BRAND } from '../shared/brand.ts'
import arrowsClockwise from '@phosphor-icons/core/assets/regular/arrows-clockwise.svg'
import squaresFour from '@phosphor-icons/core/assets/regular/squares-four.svg'
import arrowsInLineVertical from '@phosphor-icons/core/assets/regular/arrows-in-line-vertical.svg'
import arrowsOutSimple from '@phosphor-icons/core/assets/regular/arrows-out-simple.svg'
import arrowsInSimple from '@phosphor-icons/core/assets/regular/arrows-in-simple.svg'
import bug from '@phosphor-icons/core/assets/regular/bug.svg'
import appWindow from '@phosphor-icons/core/assets/regular/app-window.svg'
import listNumbers from '@phosphor-icons/core/assets/regular/list-numbers.svg'
import arrowElbowDownLeft from '@phosphor-icons/core/assets/regular/arrow-elbow-down-left.svg'
import mapTrifold from '@phosphor-icons/core/assets/regular/map-trifold.svg'
import arrowClockwise from '@phosphor-icons/core/assets/regular/arrow-clockwise.svg'
import arrowUUpLeft from '@phosphor-icons/core/assets/regular/arrow-u-up-left.svg'
import handGrabbing from '@phosphor-icons/core/assets/regular/hand-grabbing.svg'
import arrowSquareOut from '@phosphor-icons/core/assets/regular/arrow-square-out.svg'
import caretDown from '@phosphor-icons/core/assets/regular/caret-down.svg'
import caretUp from '@phosphor-icons/core/assets/regular/caret-up.svg'
import circleFill from '@phosphor-icons/core/assets/fill/circle-fill.svg'
import circle from '@phosphor-icons/core/assets/regular/circle.svg'
import radioButtonFill from '@phosphor-icons/core/assets/fill/radio-button-fill.svg'
import eyeClosed from '@phosphor-icons/core/assets/regular/eye-closed.svg'
import leaf from '@phosphor-icons/core/assets/regular/leaf.svg'
import circleHalf from '@phosphor-icons/core/assets/regular/circle-half.svg'
import timerIcon from '@phosphor-icons/core/assets/regular/timer.svg'
import clockCounterClockwise from '@phosphor-icons/core/assets/regular/clock-counter-clockwise.svg'
import eye from '@phosphor-icons/core/assets/regular/eye.svg'
import sidebarSimple from '@phosphor-icons/core/assets/regular/sidebar-simple.svg'
import arrowsLeftRight from '@phosphor-icons/core/assets/regular/arrows-left-right.svg'
import clipboardText from '@phosphor-icons/core/assets/regular/clipboard-text.svg'
import chatsCircle from '@phosphor-icons/core/assets/regular/chats-circle.svg'
import userPlus from '@phosphor-icons/core/assets/regular/user-plus.svg'
import userMinus from '@phosphor-icons/core/assets/regular/user-minus.svg'
import speakerSlash from '@phosphor-icons/core/assets/regular/speaker-slash.svg'
import speakerHigh from '@phosphor-icons/core/assets/regular/speaker-high.svg'
import lock from '@phosphor-icons/core/assets/regular/lock.svg'
import prohibit from '@phosphor-icons/core/assets/regular/prohibit.svg'
import globeSimple from '@phosphor-icons/core/assets/regular/globe-simple.svg'
import chalkboardSimple from '@phosphor-icons/core/assets/regular/chalkboard-simple.svg'
// The side bars' open pads wear the fill weight of their icon (sidebars.ts): `<name>-fill` next to each pad icon.
import clipboardTextFill from '@phosphor-icons/core/assets/fill/clipboard-text-fill.svg'
import appWindowFill from '@phosphor-icons/core/assets/fill/app-window-fill.svg'
import globeSimpleFill from '@phosphor-icons/core/assets/fill/globe-simple-fill.svg'
import chalkboardSimpleFill from '@phosphor-icons/core/assets/fill/chalkboard-simple-fill.svg'
import filesFill from '@phosphor-icons/core/assets/fill/files-fill.svg'
import folderOpen from '@phosphor-icons/core/assets/regular/folder-open.svg'
import target from '@phosphor-icons/core/assets/regular/target.svg'
import pushPin from '@phosphor-icons/core/assets/regular/push-pin.svg'
import pushPinFill from '@phosphor-icons/core/assets/fill/push-pin-fill.svg'
import filesIcon from '@phosphor-icons/core/assets/regular/files.svg'
import ghost from '@phosphor-icons/core/assets/regular/ghost.svg'
import hand from '@phosphor-icons/core/assets/regular/hand.svg'
import hourglass from '@phosphor-icons/core/assets/regular/hourglass.svg'
import info from '@phosphor-icons/core/assets/regular/info.svg'
import play from '@phosphor-icons/core/assets/regular/play.svg'
import plugs from '@phosphor-icons/core/assets/regular/plugs.svg'
import puzzlePiece from '@phosphor-icons/core/assets/regular/puzzle-piece.svg'
import tagIcon from '@phosphor-icons/core/assets/regular/tag.svg'
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
import pause from '@phosphor-icons/core/assets/regular/pause.svg'
import tray from '@phosphor-icons/core/assets/regular/tray.svg'
import warning from '@phosphor-icons/core/assets/regular/warning.svg'
import x from '@phosphor-icons/core/assets/regular/x.svg'
import xCircle from '@phosphor-icons/core/assets/regular/x-circle.svg'
import check from '@phosphor-icons/core/assets/regular/check.svg'
import bell from '@phosphor-icons/core/assets/regular/bell.svg'
import bellSlash from '@phosphor-icons/core/assets/regular/bell-slash.svg'
import clockIcon from '@phosphor-icons/core/assets/regular/clock.svg'
import swap from '@phosphor-icons/core/assets/regular/swap.svg'
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
import keyboard from '@phosphor-icons/core/assets/regular/keyboard.svg'
import arrowLineLeft from '@phosphor-icons/core/assets/regular/arrow-line-left.svg'
import squareHalf from '@phosphor-icons/core/assets/regular/square-half.svg'
import columns from '@phosphor-icons/core/assets/regular/columns.svg'
import arrowLineRight from '@phosphor-icons/core/assets/regular/arrow-line-right.svg'
import arrowLineUp from '@phosphor-icons/core/assets/regular/arrow-line-up.svg'
import arrowLineDown from '@phosphor-icons/core/assets/regular/arrow-line-down.svg'
import arrowCounterClockwise from '@phosphor-icons/core/assets/regular/arrow-counter-clockwise.svg'
import linkIcon from '@phosphor-icons/core/assets/regular/link.svg'
import linkBreak from '@phosphor-icons/core/assets/regular/link-break.svg'
import palette from '@phosphor-icons/core/assets/regular/palette.svg'
import cards from '@phosphor-icons/core/assets/regular/cards.svg'
import lightning from '@phosphor-icons/core/assets/regular/lightning.svg'
import sun from '@phosphor-icons/core/assets/regular/sun.svg'
import moon from '@phosphor-icons/core/assets/regular/moon.svg'
import trayArrowDown from '@phosphor-icons/core/assets/regular/tray-arrow-down.svg'
import trayArrowUp from '@phosphor-icons/core/assets/regular/tray-arrow-up.svg'
import rows from '@phosphor-icons/core/assets/regular/rows.svg'
import dotsThree from '@phosphor-icons/core/assets/regular/dots-three.svg'
import textAa from '@phosphor-icons/core/assets/regular/text-aa.svg'
import magnifyingGlass from '@phosphor-icons/core/assets/regular/magnifying-glass.svg'
import magnifyingGlassPlus from '@phosphor-icons/core/assets/regular/magnifying-glass-plus.svg'
import magnifyingGlassMinus from '@phosphor-icons/core/assets/regular/magnifying-glass-minus.svg'
import broom from '@phosphor-icons/core/assets/regular/broom.svg'
import fileMagnifyingGlass from '@phosphor-icons/core/assets/regular/file-magnifying-glass.svg'
import treeView from '@phosphor-icons/core/assets/regular/tree-view.svg'
import arrowsOutLineVertical from '@phosphor-icons/core/assets/regular/arrows-out-line-vertical.svg'
import stopIcon from '@phosphor-icons/core/assets/regular/stop.svg'
import checks from '@phosphor-icons/core/assets/regular/checks.svg'
import bookOpen from '@phosphor-icons/core/assets/regular/book-open.svg'
import gitDiff from '@phosphor-icons/core/assets/regular/git-diff.svg'
import funnel from '@phosphor-icons/core/assets/regular/funnel.svg'
import caretRight from '@phosphor-icons/core/assets/regular/caret-right.svg'
import arrowLeft from '@phosphor-icons/core/assets/regular/arrow-left.svg'
import arrowRight from '@phosphor-icons/core/assets/regular/arrow-right.svg'
import arrowUp from '@phosphor-icons/core/assets/regular/arrow-up.svg'
import arrowDown from '@phosphor-icons/core/assets/regular/arrow-down.svg'
import notePencil from '@phosphor-icons/core/assets/regular/note-pencil.svg'
import floppyDisk from '@phosphor-icons/core/assets/regular/floppy-disk.svg'
import fileText from '@phosphor-icons/core/assets/regular/file-text.svg'
// The file types of the file lists (app/shared/quick-open.ts fileIcon).
import fileIcon from '@phosphor-icons/core/assets/regular/file.svg'
import fileTsIcon from '@phosphor-icons/core/assets/regular/file-ts.svg'
import fileTsxIcon from '@phosphor-icons/core/assets/regular/file-tsx.svg'
import fileJsIcon from '@phosphor-icons/core/assets/regular/file-js.svg'
import fileJsxIcon from '@phosphor-icons/core/assets/regular/file-jsx.svg'
import fileMdIcon from '@phosphor-icons/core/assets/regular/file-md.svg'
import fileCssIcon from '@phosphor-icons/core/assets/regular/file-css.svg'
import fileHtmlIcon from '@phosphor-icons/core/assets/regular/file-html.svg'
import filePyIcon from '@phosphor-icons/core/assets/regular/file-py.svg'
import fileRsIcon from '@phosphor-icons/core/assets/regular/file-rs.svg'
import fileSqlIcon from '@phosphor-icons/core/assets/regular/file-sql.svg'
import fileVueIcon from '@phosphor-icons/core/assets/regular/file-vue.svg'
import fileSvgIcon from '@phosphor-icons/core/assets/regular/file-svg.svg'
import fileCsvIcon from '@phosphor-icons/core/assets/regular/file-csv.svg'
import fileCIcon from '@phosphor-icons/core/assets/regular/file-c.svg'
import fileCppIcon from '@phosphor-icons/core/assets/regular/file-cpp.svg'
import fileCSharpIcon from '@phosphor-icons/core/assets/regular/file-c-sharp.svg'
import fileImageIcon from '@phosphor-icons/core/assets/regular/file-image.svg'
import filePdfIcon from '@phosphor-icons/core/assets/regular/file-pdf.svg'
import fileZipIcon from '@phosphor-icons/core/assets/regular/file-zip.svg'
import fileLockIcon from '@phosphor-icons/core/assets/regular/file-lock.svg'
import bracketsCurlyIcon from '@phosphor-icons/core/assets/regular/brackets-curly.svg'
import gearSixIcon from '@phosphor-icons/core/assets/regular/gear-six.svg'
import terminalIcon from '@phosphor-icons/core/assets/regular/terminal.svg'
import filePlusIcon from '@phosphor-icons/core/assets/regular/file-plus.svg'
import folderPlusIcon from '@phosphor-icons/core/assets/regular/folder-plus.svg'
import pulse from '@phosphor-icons/core/assets/regular/pulse.svg'
import gauge from '@phosphor-icons/core/assets/regular/gauge.svg'
import robot from '@phosphor-icons/core/assets/regular/robot.svg'
import crownSimple from '@phosphor-icons/core/assets/regular/crown-simple.svg'
import arrowUDownLeft from '@phosphor-icons/core/assets/regular/arrow-u-down-left.svg'
import deviceMobile from '@phosphor-icons/core/assets/regular/device-mobile.svg'
import qrCode from '@phosphor-icons/core/assets/regular/qr-code.svg'
import type { SlotKind } from '../../src/daemon/protocol.ts'

const SVG = {
  'app-window': appWindow,
  'arrows-clockwise': arrowsClockwise,
  'squares-four': squaresFour,
  'arrows-in-line-vertical': arrowsInLineVertical,
  'arrows-out-simple': arrowsOutSimple,
  'arrows-in-simple': arrowsInSimple,
  bug,
  'arrow-clockwise': arrowClockwise,
  'arrow-u-up-left': arrowUUpLeft,
  'hand-grabbing': handGrabbing,
  'map-trifold': mapTrifold,
  'list-numbers': listNumbers,
  'arrow-elbow-down-left': arrowElbowDownLeft,
  'arrow-counter-clockwise': arrowCounterClockwise,
  link: linkIcon,
  'link-break': linkBreak,
  'arrow-square-out': arrowSquareOut,
  'caret-down': caretDown,
  'caret-up': caretUp,
  'circle-fill': circleFill,
  'circle': circle,
  'radio-button-fill': radioButtonFill,
  'eye-closed': eyeClosed,
  'circle-half': circleHalf,
  'clock-counter-clockwise': clockCounterClockwise,
  timer: timerIcon,
  'folder-open': folderOpen,
  'file-plus': filePlusIcon,
  'folder-plus': folderPlusIcon,
  target,
  'push-pin': pushPin,
  'push-pin-fill': pushPinFill,
  files: filesIcon,
  ghost,
  hand,
  hourglass,
  info,
  play,
  plugs,
  'puzzle-piece': puzzlePiece,
  tag: tagIcon,
  'plugs-connected': plugsConnected,
  pause,
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
  bell,
  'bell-slash': bellSlash,
  clock: clockIcon,
  swap,
  folder,
  list,
  minus,
  'minus-circle': minusCircle,
  'pencil-simple': pencilSimple,
  'shield-warning': shieldWarning,
  'sliders-horizontal': slidersHorizontal,
  star,
  tabs,
  keyboard,
  'arrow-line-left': arrowLineLeft,
  'square-half': squareHalf,
  columns,
  'arrow-line-right': arrowLineRight,
  'arrow-line-up': arrowLineUp,
  'arrow-line-down': arrowLineDown,
  palette,
  'text-aa': textAa,
  cards,
  lightning,
  sun,
  moon,
  'tray-arrow-down': trayArrowDown,
  'tray-arrow-up': trayArrowUp,
  rows,
  'dots-three': dotsThree,
  'magnifying-glass': magnifyingGlass,
  'magnifying-glass-plus': magnifyingGlassPlus,
  'magnifying-glass-minus': magnifyingGlassMinus,
  broom,
  'file-magnifying-glass': fileMagnifyingGlass,
  'tree-view': treeView,
  'arrows-out-line-vertical': arrowsOutLineVertical,
  stop: stopIcon,
  checks,
  'book-open': bookOpen,
  'git-diff': gitDiff,
  funnel,
  'caret-right': caretRight,
  'arrow-left': arrowLeft,
  'arrow-right': arrowRight,
  'arrow-up': arrowUp,
  'arrow-down': arrowDown,
  'note-pencil': notePencil,
  eye,
  'sidebar-simple': sidebarSimple,
  'arrows-left-right': arrowsLeftRight,
  'clipboard-text': clipboardText,
  'chats-circle': chatsCircle,
  'user-plus': userPlus,
  'user-minus': userMinus,
  'speaker-slash': speakerSlash,
  'speaker-high': speakerHigh,
  lock,
  prohibit,
  'globe-simple': globeSimple,
  'chalkboard-simple': chalkboardSimple,
  'clipboard-text-fill': clipboardTextFill,
  'app-window-fill': appWindowFill,
  'globe-simple-fill': globeSimpleFill,
  'chalkboard-simple-fill': chalkboardSimpleFill,
  'files-fill': filesFill,
  'floppy-disk': floppyDisk,
  'file-text': fileText,
  'file': fileIcon,
  'file-ts': fileTsIcon,
  'file-tsx': fileTsxIcon,
  'file-js': fileJsIcon,
  'file-jsx': fileJsxIcon,
  'file-md': fileMdIcon,
  'file-css': fileCssIcon,
  'file-html': fileHtmlIcon,
  'file-py': filePyIcon,
  'file-rs': fileRsIcon,
  'file-sql': fileSqlIcon,
  'file-vue': fileVueIcon,
  'file-svg': fileSvgIcon,
  'file-csv': fileCsvIcon,
  'file-c': fileCIcon,
  'file-cpp': fileCppIcon,
  'file-c-sharp': fileCSharpIcon,
  'file-image': fileImageIcon,
  'file-pdf': filePdfIcon,
  'file-zip': fileZipIcon,
  'file-lock': fileLockIcon,
  'brackets-curly': bracketsCurlyIcon,
  'gear-six': gearSixIcon,
  'terminal': terminalIcon,
  pulse,
  gauge,
  robot,
  'crown-simple': crownSimple,
  leaf,
  'arrow-u-down-left': arrowUDownLeft,
  'device-mobile': deviceMobile,
  'qr-code': qrCode,
  // The product's monogram (brand/assets/app/mask.json, 24x24 currentColor): the Bridge's status icon wears it.
  'brand': BRAND.icon,
} as const

export type IconName = keyof typeof SVG

export const ICON_NAMES = Object.keys(SVG) as IconName[]

/** The agent's icon, from its extension's AgentUi (agent-ui.ts); shell and an agent with no AgentUi → terminal window. */
export const KIND_ICON: Record<SlotKind, IconName> = agentTable<IconName>('terminal-window', ui => ui.icon as IconName, () => 'terminal-window')

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
