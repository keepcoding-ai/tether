/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The side bars and their pads (F10), as pure rules: no DOM, unit-tested. app/renderer/sidebars.ts draws them.
//
// Vocabulary: a side bar (`SideBar`, left and right) is a strip of icons plus the area of the pad open on it; a pad
// (`Pad`, "prancheta") is what one icon opens. One pad open per side bar; the icon is a toggle.
//
// The shape is VS Code's view containers, adapted. Origin: https://github.com/microsoft/vscode, commit
// 7faf984945fefaceb533ca1d851697a2e72e4e68:
//   src/vs/workbench/common/views.ts                               ViewContainerLocation, IViewContainerDescriptor,
//                                                                  ViewContainersRegistry (register → the container's
//                                                                  DEFAULT location; deregister; get; getViewContainers)
//   src/vs/workbench/services/views/browser/viewDescriptorService.ts  the CURRENT location is a custom-location map over the
//                                                                  default (`getViewContainerLocation`: custom ?? default);
//                                                                  only non-default locations are saved
//                                                                  (`saveViewCustomizations`); "Reset Location" moves a
//                                                                  container back to its default
//   src/vs/workbench/browser/parts/paneCompositeBar.ts            the icon click: the active container's icon hides the side
//                                                                  bar (`iconClickBehavior: 'toggle'`), any other opens it
//   src/vs/workbench/browser/actions/layoutActions.ts             ToggleSidebarVisibilityAction (Ctrl+B): the side bar
//                                                                  hides and shows again with the container it had
// Adapted: two locations (left, right) instead of three; the registry takes our pad descriptor; the side bar's "hidden"
// part state and its active container are one record per side (`open`, `last`), saved in layout.json (v3) instead of the
// storage service. Left out: views inside containers, generated containers, drag and drop, badges, context keys.
import { toDisposable, type IDisposable } from '../shared/vscode-lifecycle.ts'

export type PadScope = 'global' | 'desk' | 'panel'
export type Side = 'left' | 'right'
export const SIDES: readonly Side[] = ['left', 'right']
export const otherSide = (s: Side): Side => s === 'left' ? 'right' : 'left'
export const SIDE_LABEL: Record<Side, string> = { left: 'esquerda', right: 'direita' }

/** A pad as the core knows it before (and without) its extension's activation: the manifest's `contributes.pads` entry. */
export interface PadDescriptor {
  /** Stable, lowercase, dotted ('frame-pads.desk'): names the pad in layout.json and in its toggle command. */
  id: string
  title: string
  /** An icon name of app/renderer/icons.ts. */
  icon: string
  /** The side bar it lives on until the person moves it (VS Code's default ViewContainerLocation). */
  defaultSide: Side
  /**
   * 'global': one view and one state for the window; 'desk': one per desk, swapped with the desk; 'panel': one per
   * focusable panel (the pane the Foco de Mesa is on), swapped with the focus.
   */
  scope: PadScope
  /** Its state is a frames layout (frames → panes): the core prunes it and lists its panes. */
  frames?: boolean
  /** The view draws the pad's header itself (extensions/types.ts PadContribution.absorbsHeader). */
  absorbsHeader?: boolean
  /** Order on its strip (lower first); ties keep the registration order. */
  order?: number
  /** The extension that declared it. */
  extension?: string
}

const PAD_ID = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/

/** VS Code's ViewContainersRegistry, for pads: registering returns the disposable that takes the pad back. */
export class PadRegistry {
  private readonly pads: PadDescriptor[] = []
  private readonly listeners = new Set<() => void>()

  register(pad: PadDescriptor): IDisposable {
    if (!PAD_ID.test(pad.id)) throw new Error(`id de prancheta malformado: ${pad.id}`)
    if (this.pads.some(p => p.id === pad.id)) throw new Error(`prancheta registrada duas vezes: ${pad.id}`)
    this.pads.push(pad)
    this.fire()
    return toDisposable(() => { const i = this.pads.indexOf(pad); if (i !== -1) { this.pads.splice(i, 1); this.fire() } })
  }

  get(id: string): PadDescriptor | undefined { return this.pads.find(p => p.id === id) }

  /** Every pad, in registration order. */
  all(): readonly PadDescriptor[] { return this.pads }

  onDidChange(listener: () => void): IDisposable {
    this.listeners.add(listener)
    return toDisposable(() => { this.listeners.delete(listener) })
  }

  private fire(): void { for (const l of this.listeners) l() }
}

// ---------- the state of the two side bars (layout.json v3 `sidebars`) ----------

export interface SideBarState {
  /** The pad shown now; absent = the side bar is closed. */
  open?: string
  /** The pad the side bar shows again when it is reopened without naming one (Ctrl+B). */
  last?: string
  /** The pad area's width in CSS px (the strip not included), kept while closed. */
  width: number
}

export interface SideBarsLayout {
  left: SideBarState
  right: SideBarState
  /** Pad → side, only for pads moved away from their default side ("Restaurar posição padrão" drops the entry). */
  placement: Record<string, Side>
  /**
   * The saved state of each global pad (what its view serialized), keyed by pad id; per-desk pads keep theirs in the desk.
   * A per-panel pad's state is here too, keyed `<pad id>@<panel id>` (see `panelPadKey`).
   */
  pads: Record<string, unknown>
  /**
   * A small record per frames pad note (`<pad id>@<owner>`, or the pad id for a global pad), written while its owner lives:
   * the owner's label and desk and when its content last changed (app/renderer/panel-frames.ts PanelFrameMeta). Absent = none.
   */
  meta?: Record<string, unknown>
}

export const DEFAULT_SIDEBAR_WIDTH = 380
export const MIN_SIDEBAR_WIDTH = 200
export const MAX_SIDEBAR_WIDTH = 2400
/** The room the desks keep when a side bar is dragged wide. */
export const MIN_DOCK_WIDTH = 320

export function emptySideBars(): SideBarsLayout {
  return { left: { width: DEFAULT_SIDEBAR_WIDTH }, right: { width: DEFAULT_SIDEBAR_WIDTH }, placement: {}, pads: {} }
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const isSide = (x: unknown): x is Side => x === 'left' || x === 'right'

function readSide(raw: unknown): SideBarState {
  const r = isObject(raw) ? raw : {}
  const width = typeof r.width === 'number' && Number.isFinite(r.width) ? clampWidth(r.width) : DEFAULT_SIDEBAR_WIDTH
  return { ...(typeof r.open === 'string' && r.open ? { open: r.open } : {}), ...(typeof r.last === 'string' && r.last ? { last: r.last } : {}), width }
}

/**
 * The side bars of a file, read tolerantly: anything missing or malformed takes its default. Ids of pads nobody declares
 * now (an extension turned off) are kept as they are: the pad comes back where it was when the extension is on again.
 */
export function readSideBars(raw: unknown): SideBarsLayout {
  if (!isObject(raw)) return emptySideBars()
  const placement: Record<string, Side> = {}
  if (isObject(raw.placement)) for (const [id, side] of Object.entries(raw.placement)) if (isSide(side)) placement[id] = side
  const meta = isObject(raw.meta) && Object.keys(raw.meta).length ? { meta: { ...raw.meta } } : {}
  return { left: readSide(raw.left), right: readSide(raw.right), placement, pads: isObject(raw.pads) ? { ...raw.pads } : {}, ...meta }
}

/** A width the side bar can take on its own; the window's room is applied on screen (`fitWidth`). */
export function clampWidth(w: number): number {
  return Math.round(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, w)))
}

/** The width shown in a workbench `room` px wide, leaving the desks MIN_DOCK_WIDTH and the other side what it takes. */
export function fitWidth(width: number, room: number, other = 0): number {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(clampWidth(width), room - MIN_DOCK_WIDTH - other))
}

/** Where a pad is now: its custom side, else its default (VS Code's getViewContainerLocation). */
export function sideOf(layout: Pick<SideBarsLayout, 'placement'>, pad: PadDescriptor): Side {
  return layout.placement[pad.id] ?? pad.defaultSide
}

/** The pads of one side, in strip order. */
export function padsOn(pads: readonly PadDescriptor[], layout: Pick<SideBarsLayout, 'placement'>, side: Side): PadDescriptor[] {
  return pads.map((p, i) => ({ p, i })).filter(x => sideOf(layout, x.p) === side)
    .sort((a, b) => (a.p.order ?? 0) - (b.p.order ?? 0) || a.i - b.i).map(x => x.p)
}

/** The pad shown on a side: its `open` id when that pad is declared and lives on this side; else none (closed). */
export function openPadOn(pads: readonly PadDescriptor[], layout: SideBarsLayout, side: Side): PadDescriptor | undefined {
  const id = layout[side].open
  const pad = id ? pads.find(p => p.id === id) : undefined
  return pad && sideOf(layout, pad) === side ? pad : undefined
}

function withSide(layout: SideBarsLayout, side: Side, state: SideBarState): SideBarsLayout {
  return { ...layout, [side]: state }
}

function opened(state: SideBarState, id: string): SideBarState { return { ...state, open: id, last: id } }
function closed(state: SideBarState): SideBarState { const { open: _open, ...rest } = state; return rest }

/** The icon click (VS Code's 'toggle' behaviour): the open pad closes its side bar; any other pad opens there, in its place. */
export function togglePad(layout: SideBarsLayout, pads: readonly PadDescriptor[], padId: string): SideBarsLayout {
  const pad = pads.find(p => p.id === padId)
  if (!pad) return layout
  const side = sideOf(layout, pad)
  return openPadOn(pads, layout, side)?.id === padId ? withSide(layout, side, closed(layout[side])) : withSide(layout, side, opened(layout[side], padId))
}

/** Opens a pad (a no-op when it is already the one shown). */
export function openPad(layout: SideBarsLayout, pads: readonly PadDescriptor[], padId: string): SideBarsLayout {
  const pad = pads.find(p => p.id === padId)
  if (!pad) return layout
  const side = sideOf(layout, pad)
  return openPadOn(pads, layout, side)?.id === padId ? layout : withSide(layout, side, opened(layout[side], padId))
}

/**
 * Ctrl+B / Ctrl+Alt+B: an open side bar closes (it remembers its pad); a closed one opens with the pad it had last, or
 * the first pad on its strip. A side with no pads stays as it is.
 */
export function toggleSideBar(layout: SideBarsLayout, pads: readonly PadDescriptor[], side: Side): SideBarsLayout {
  if (openPadOn(pads, layout, side)) return withSide(layout, side, closed(layout[side]))
  const here = padsOn(pads, layout, side)
  const target = here.find(p => p.id === layout[side].last) ?? here[0]
  return target ? withSide(layout, side, opened(layout[side], target.id)) : layout
}

/**
 * Moves a pad to a side bar (the other one by default). It leaves its old side (closed there if it was the one shown,
 * and no longer its `last`), and opens on the new side, as VS Code shows a container where it was moved. Moving it to its
 * default side drops the custom placement (only non-default placements are kept, as VS Code saves them).
 */
export function movePad(layout: SideBarsLayout, pads: readonly PadDescriptor[], padId: string, to?: Side): SideBarsLayout {
  const pad = pads.find(p => p.id === padId)
  if (!pad) return layout
  const from = sideOf(layout, pad)
  const target = to ?? otherSide(from)
  if (target === from) return layout
  const placement = { ...layout.placement }
  if (target === pad.defaultSide) delete placement[pad.id]
  else placement[pad.id] = target
  let old = layout[from]
  if (old.open === padId) old = closed(old)
  if (old.last === padId) { const { last: _last, ...rest } = old; old = rest }
  return { ...layout, placement, [from]: old, [target]: opened(layout[target], padId) }
}

/** "Restaurar posição padrão": back to its default side (a no-op when it is there). */
export function restorePad(layout: SideBarsLayout, pads: readonly PadDescriptor[], padId: string): SideBarsLayout {
  const pad = pads.find(p => p.id === padId)
  return pad ? movePad(layout, pads, padId, pad.defaultSide) : layout
}

/** A pad lives away from its default side. */
export function isMoved(layout: Pick<SideBarsLayout, 'placement'>, pad: PadDescriptor): boolean {
  return sideOf(layout, pad) !== pad.defaultSide
}

export function setWidth(layout: SideBarsLayout, side: Side, width: number): SideBarsLayout {
  return withSide(layout, side, { ...layout[side], width: clampWidth(width) })
}

/** The command id of a pad's own toggle (VS Code registers an "open" command per container, `openCommandActionDescriptor`). */
export function padToggleCommand(padId: string): string {
  return `pad.toggle.${padId}`
}

/** Where a per-panel pad's state lives in `SideBarsLayout.pads`: `<pad id>@<panel id>`. */
export function panelPadKey(padId: string, panelId: string): string {
  return `${padId}@${panelId}`
}

/** The inverse of `panelPadKey` for one pad: the panel ids whose state is saved for it. */
export function panelIdsOfPad(pads: Record<string, unknown>, padId: string): string[] {
  const prefix = `${padId}@`
  return Object.keys(pads).filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length))
}
