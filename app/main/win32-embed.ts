// Windows only: a top-level window of one process becomes a child window (WS_CHILD) of a window of another process, through
// user32 (koffi). The browser process (app/main/browser-child.ts) embeds each tab's frameless window into the tether's window
// this way, so a crash or hang of the browser never takes the tether: the child window simply goes away with its process.
// Rule: nothing here waits on the other process's window thread. Every move is SWP_ASYNCWINDOWPOS (posted to the window's own
// thread) with SWP_NOACTIVATE, so a hung browser cannot block the caller and the tether keeps its activation.
import { createRequire } from 'node:module'

type Fn = (...args: unknown[]) => unknown
interface User32 {
  SetParent: Fn; SetWindowPos: Fn; GetWindowLongPtrW: Fn; SetWindowLongPtrW: Fn; IsWindow: Fn; GetParent: Fn; SetFocus: Fn; GetFocus: Fn
}

const GWL_STYLE = -16
const GWL_EXSTYLE = -20
const WS_CHILD = 0x40000000, WS_POPUP = 0x80000000, WS_CAPTION = 0x00C00000, WS_THICKFRAME = 0x00040000, WS_CLIPSIBLINGS = 0x04000000
const WS_EX_APPWINDOW = 0x00040000, WS_EX_TOOLWINDOW = 0x00000080
const SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010, SWP_SHOWWINDOW = 0x0040, SWP_ASYNCWINDOWPOS = 0x4000
const HWND_TOP = 0

let user32: User32 | undefined | null

function load(): User32 | undefined {
  if (user32 !== undefined) return user32 ?? undefined
  if (process.platform !== 'win32') { user32 = null; return undefined }
  try {
    const koffi = createRequire(__filename)('koffi') as { load(name: string): { func(sig: string): Fn } }
    const u = koffi.load('user32.dll')
    user32 = {
      SetParent: u.func('intptr_t __stdcall SetParent(intptr_t, intptr_t)'),
      SetWindowPos: u.func('int __stdcall SetWindowPos(intptr_t, intptr_t, int, int, int, int, uint32_t)'),
      GetWindowLongPtrW: u.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t, int)'),
      SetWindowLongPtrW: u.func('intptr_t __stdcall SetWindowLongPtrW(intptr_t, int, intptr_t)'),
      IsWindow: u.func('int __stdcall IsWindow(intptr_t)'),
      GetParent: u.func('intptr_t __stdcall GetParent(intptr_t)'),
      SetFocus: u.func('intptr_t __stdcall SetFocus(intptr_t)'),
      GetFocus: u.func('intptr_t __stdcall GetFocus()'),
    }
  } catch {
    user32 = null
  }
  return user32 ?? undefined
}

/** True when windows can be embedded across processes here (Windows with koffi loaded). */
export function canEmbed(): boolean { return load() !== undefined }

/** A window handle from Electron's getNativeWindowHandle() buffer. */
export function hwndOf(buf: Buffer): number { return Number(buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0))) }

/** Makes `child` a child window of `parent` (no caption, frame or taskbar button). True when it took. */
export function embed(child: number, parent: number): boolean {
  const u = load()
  if (!u) return false
  const style = Number(u.GetWindowLongPtrW(child, GWL_STYLE))
  u.SetWindowLongPtrW(child, GWL_STYLE, ((style | WS_CHILD | WS_CLIPSIBLINGS) & ~WS_POPUP & ~WS_CAPTION & ~WS_THICKFRAME) >>> 0)
  const ex = Number(u.GetWindowLongPtrW(child, GWL_EXSTYLE))
  u.SetWindowLongPtrW(child, GWL_EXSTYLE, ((ex | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW) >>> 0)
  u.SetParent(child, parent)
  return Number(u.GetParent(child)) === parent
}

/** Moves and sizes `child` in its parent's client area (physical px), shown; `top` also raises it over its siblings. Never waits. */
export function place(child: number, x: number, y: number, width: number, height: number, top = false): void {
  const u = load()
  if (!u) return
  u.SetWindowPos(child, HWND_TOP, Math.round(x), Math.round(y), Math.max(1, Math.round(width)), Math.max(1, Math.round(height)),
    (top ? 0 : SWP_NOZORDER) | SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_ASYNCWINDOWPOS)
}

/** Raises `child` over its siblings without moving it. Never waits. */
export function raise(child: number): void {
  const u = load()
  if (!u) return
  u.SetWindowPos(child, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS)
}

/**
 * Gives `child` the keyboard. An embedded child window is never activated, so neither Windows nor Chromium focuses it on a
 * click; its own thread calls this (the parent's and the child's input queues are joined by SetParent, so it is allowed).
 */
export function focus(child: number): void {
  const u = load()
  if (!u || Number(u.GetFocus()) === child) return
  u.SetFocus(child)
}

export function isWindow(hwnd: number): boolean { const u = load(); return !!u && Number(u.IsWindow(hwnd)) !== 0 }
export function parentOf(hwnd: number): number { const u = load(); return u ? Number(u.GetParent(hwnd)) : 0 }
