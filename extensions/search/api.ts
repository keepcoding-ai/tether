// The contract between the search extension and the ones that offer it a folder (the explorer's "Pesquisar na pasta…").
// The app's commands carry no argument, so the folder travels in a window event: the offering side calls
// `requestFindInFolder(path)` and never imports the pad; the search extension listens with `onFindInFolder`.
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'

/** The window event that asks the search pad to search in a folder. */
export const FIND_IN_FOLDER_EVENT = 'tether:search:find-in-folder'

/** Asks the search pad (when that extension is active) to open with `path` as the only folder to search in. */
export function requestFindInFolder(path: string): void {
  window.dispatchEvent(new CustomEvent(FIND_IN_FOLDER_EVENT, { detail: { path } }))
}

/** Listens for `requestFindInFolder`; dispose to stop. */
export function onFindInFolder(listener: (path: string) => void): IDisposable {
  const handler = (ev: globalThis.Event): void => {
    const path = (ev as CustomEvent<{ path?: unknown }>).detail?.path
    if (typeof path === 'string' && path !== '') listener(path)
  }
  window.addEventListener(FIND_IN_FOLDER_EVENT, handler)
  return { dispose: () => window.removeEventListener(FIND_IN_FOLDER_EVENT, handler) }
}
