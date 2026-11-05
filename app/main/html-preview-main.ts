// The HTML preview's isolation, main-process side (F5, "prévia de HTML"). A preview runs the author's page, scripts and all,
// so the page lives in a `<webview>`: a separate process (a guest WebContents), sandboxed, with
//   - no preload, no Node, context isolation on: no `window.tether`, no `require`, no `process`, no IPC channel to the app;
//   - a session of its own, in memory (partition `htmlprev-…`, no `persist:`), one per pane: no cookies, storage or cache shared
//     with the app or with another preview;
//   - every request filtered by app/main/html-preview-policy.ts (the page's folder and below for `file:`; https for the web;
//     nothing on this machine's network), every permission refused, every download cancelled;
//   - top-level navigation decided here: inside the folder it moves the preview, `http(s)` and `window.open` go to the system
//     browser, the rest is dropped.
// What the page loaded from its folder is reported to the renderer (it watches those files for the live reload), and so is what
// the policy refused (the strip says how many). Chords pressed inside the page are forwarded as data (the guest cannot reach the
// app's key handling on its own).
import { type IpcMain, type Session, session, shell, type WebContents, type WebPreferences } from 'electron'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { isHtmlPath } from '../shared/preview.ts'
import { decideNavigation, decideRequest, fileUrlPath, isPreviewPartition, previewablePageUrl, rootOf } from './html-preview-policy.ts'

import type { PreviewKey, PreviewReport } from '../shared/api.ts'
export type { PreviewKey, PreviewReport }

interface Guard {
  partition: string
  session: Session
  root: string
  files: Set<string>
  blocked: Map<string, string>
  timer: ReturnType<typeof setTimeout> | undefined
}

const REPORT_DEBOUNCE_MS = 120
const MAX_FILES = 200
const MAX_BLOCKED = 50

function realpath(path: string): string {
  return realpathSync.native(path)
}

/** Hooks one app window: its webviews become isolated previews (and nothing else may be a webview). */
export function guardHtmlPreviews(host: WebContents): void {
  const guards = new Map<string, Guard>()
  const installed = new WeakSet<Session>()

  const send = (channel: string, payload: unknown): void => { if (!host.isDestroyed()) host.send(channel, payload) }

  const report = (g: Guard): void => {
    if (g.timer) return
    g.timer = setTimeout(() => {
      g.timer = undefined
      send('tether:html-preview-report', { partition: g.partition, files: [...g.files], blocked: [...g.blocked].map(([url, reason]) => ({ url, reason })) } satisfies PreviewReport)
    }, REPORT_DEBOUNCE_MS)
  }

  const guardFor = (ses: Session): Guard | undefined => {
    for (const g of guards.values()) if (g.session === ses) return g
    return undefined
  }

  function lock(g: Guard): void {
    const ses = g.session
    if (installed.has(ses)) return
    installed.add(ses)
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
    ses.setDevicePermissionHandler(() => false)
    ses.setSpellCheckerEnabled(false)
    ses.on('will-download', event => { event.preventDefault() })
    ses.webRequest.onBeforeRequest((details, callback) => {
      const decision = decideRequest(details.url, g.root, { realpath })
      if (decision.allow) {
        if (details.url.startsWith('file:') && g.files.size < MAX_FILES) {
          const path = fileUrlPath(details.url)
          if (path && !g.files.has(path)) { g.files.add(path); report(g) }
        }
        callback({})
        return
      }
      if (g.blocked.size < MAX_BLOCKED) { g.blocked.set(details.url.slice(0, 300), decision.reason); report(g) }
      callback({ cancel: true })
    })
  }

  host.on('will-attach-webview', (event, webPreferences: WebPreferences & { preloadURL?: string }, params) => {
    const partition = params.partition
    const page = previewablePageUrl(params.src ?? '')
    if (!isPreviewPartition(partition) || !page) { event.preventDefault(); return }
    // Whatever the element asked for, the guest gets exactly this.
    delete webPreferences.preload
    delete webPreferences.preloadURL
    Object.assign(webPreferences, {
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      experimentalFeatures: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      enableWebSQL: false,
    })
    // The guest may ask for windows only to be answered by setWindowOpenHandler (below): always "deny", http(s) goes to the system browser.
    params.allowpopups = 'true'
    params.nodeintegration = 'false'
    delete params.disablewebsecurity
    delete params.preload
    const ses = session.fromPartition(partition)
    const previous = guards.get(partition)
    const g: Guard = previous ?? { partition, session: ses, root: rootOf(page), files: new Set(), blocked: new Map(), timer: undefined }
    g.root = rootOf(page)
    g.files.clear()
    g.blocked.clear()
    guards.set(partition, g)
    lock(g)
  })

  host.on('did-attach-webview', (_event, guest) => {
    const g = guardFor(guest.session)
    if (!g) { guest.close(); return } // not one of ours (cannot happen: will-attach refused it)
    const root = (): string => g.root
    const navigate = (event: { preventDefault(): void }, url: string): void => {
      const d = decideNavigation(url, root(), { realpath })
      if (d.kind === 'allow') return
      event.preventDefault()
      if (d.kind === 'external') openExternal(d.url)
      else if (g.blocked.size < MAX_BLOCKED) { g.blocked.set(url.slice(0, 300), d.reason); report(g) }
    }
    guest.setWindowOpenHandler(({ url }) => {
      const d = decideNavigation(url, root(), { realpath })
      if (d.kind === 'external') openExternal(d.url)
      return { action: 'deny' }
    })
    guest.on('will-navigate', (event, url) => navigate(event, url))
    guest.on('will-redirect', (event, url) => navigate(event, url))
    // A page that asks "leave site?" must not hold the preview (a reload for the live update, a closing tab).
    guest.on('will-prevent-unload', event => { event.preventDefault() })
    guest.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown') return
      if (!input.control && !input.meta && !input.alt && !/^F\d+$/.test(input.key)) return // typing stays in the page
      send('tether:html-preview-key', { partition: g.partition, key: input.key, code: input.code, control: input.control, shift: input.shift, alt: input.alt, meta: input.meta } satisfies PreviewKey)
    })
  })
}

/** The guests of this app (tests count and read them). */
export function isPreviewGuest(wc: WebContents): boolean {
  return wc.getType() === 'webview'
}

/** http(s) only (the policy already chose it): looked up on `shell` at call time. */
function openExternal(url: string): void {
  if (!/^https?:\/\//i.test(url)) return
  void Promise.resolve(shell.openExternal(url)).catch(() => { /* no browser to open: nothing to tell the page */ })
}

/**
 * "Abrir no navegador": the page's file with the system's program for it (the browser, normally). Only an existing web page
 * file: the path is never interpreted and nothing else is spawned.
 */
export function registerHtmlPreviewOpen(ipcMain: IpcMain): void {
  ipcMain.handle('htmlpreview:open-in-browser', async (_e, path: unknown): Promise<{ ok: true } | { ok: false; message: string }> => {
    if (typeof path !== 'string' || !isAbsolute(path) || !isHtmlPath(path)) return { ok: false, message: 'Só abro páginas .html.' }
    try { if (!statSync(path).isFile()) return { ok: false, message: 'Não é um arquivo.' } } catch { return { ok: false, message: 'O arquivo não existe mais.' } }
    const err = await shell.openPath(path)
    return err ? { ok: false, message: err } : { ok: true }
  })
}
