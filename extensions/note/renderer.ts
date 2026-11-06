// The note extension's renderer side (F9 slice 1): the three pane types (note editor, markdown preview, HTML
// preview), their commands, the ways a note is born (new, opened from the disk, a file from Ctrl+P or a terminal link),
// its file operations through the tab, the preview family, and the test hooks. This is the code that lived in
// app/renderer/main.ts; it now reaches the core only through TetherUi (app/renderer/ext-api.ts). The panes'
// implementations stay in app/renderer (note-panel.ts, preview-panel.ts, html-preview-panel.ts, monaco.ts); they get
// their files through the bus `ext:note:*` (extensions/note/ipc.ts) injected in their hosts.
import type { IDockviewPanel } from 'dockview-core'
import type { ContextMenuEntry, TetherUi, PaneType } from '../../app/renderer/ext-api.ts'
import type { Target } from '../../app/renderer/create.ts'
import { NotePanel, NoteTab, type NoteHost, type NoteIo } from '../../app/renderer/note-panel.ts'
import { paneCwdOfNote } from '../../app/renderer/note-rules.ts'
import { PreviewPanel, PreviewTab, type PreviewHost } from '../../app/renderer/preview-panel.ts'
import { HtmlPreviewPanel, type HtmlPreviewHost } from '../../app/renderer/html-preview-panel.ts'
import type { PreviewPane } from '../../app/renderer/preview-pane.ts'
import { defineTheme, mirrorThemeVars, monaco, remeasureEditorFonts } from '../../app/renderer/monaco.ts'
import { editorChordCommand, editorKeybindings, runEditorChord } from '../../app/renderer/monaco-chords.ts'
import type { FixedBinding } from '../../app/renderer/keybindings-panel.ts'
import { fileOpenFailedSituation, type OpenFileOptions } from '../../app/renderer/file-open.ts'
import { isHtmlPath, isPreviewablePath, newPreviewPanelId, withPreview } from '../../app/shared/preview.ts'
import { cleanNoteName, newNotePanelId, NOTE_COMPONENT, NOTE_TAB, noteDirOf, noteTitle, rebasePath, withNote } from '../../app/shared/notes.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { noteConflictSituation, noteGitignoreSituation } from './situations.ts'
import { htmlPreviewLayout, mdPreviewLayout, noteLayout, previewPaneOptions } from './layouts.ts'
import type { NoteChannels } from './ipc.ts'

export { manifest } from './manifest.ts'

export function activate(ui: TetherUi): IDisposable[] {
  const subs: IDisposable[] = []
  const ipc = ui.ipc<NoteChannels>()
  const io: NoteIo = {
    read: path => ipc.invoke('read', path),
    write: (path, text) => ipc.invoke('write', path, text),
    flush: (path, text) => ipc.send('flush', path, text),
    watch: path => ipc.send('watch', path),
    unwatch: path => ipc.send('unwatch', path),
  }

  /** The note panes: no slot behind them, a file each. */
  const notes = new Map<string, NotePanel>()
  const noteTabs = new Map<string, NoteTab>()
  /** The previews: a pane tied to a file, markdown drawn by the app or an HTML page in an isolated webview. */
  const previews = new Map<string, PreviewPane>()
  /** Removes the editor actions registered as commands by the last note that got the focus. */
  let editorCommandsOff: IDisposable | undefined
  let editorCommandsOwner: NotePanel | undefined

  const wordWrap = (): boolean => ui.settings.get<boolean>('wordWrap') ?? true
  const activeId = (): string | undefined => ui.panes.activeId()
  const setActive = (id: string): void => ui.panes.find(id)?.api.setActive()

  // ---------- notes ----------

  const notePanelOptions = (path: string) => ({ id: newNotePanelId(), component: NOTE_COMPONENT, tabComponent: NOTE_TAB, title: noteTitle(path), params: withNote(undefined, { path }) })

  const noteHost: NoteHost = {
    io,
    getScheme: () => ui.theme.scheme(),
    getAppearance: () => ui.theme.appearance(),
    getWordWrap: wordWrap,
    toggleWordWrap: () => ui.settings.set('wordWrap', !wordWrap()),
    onFocus: (panel, focused) => {
      // The actions stay registered while the focus is on a transient surface (the palette lists them); the next
      // focused note replaces them, and a disposed note removes its own.
      if (focused) { editorCommandsOff?.dispose(); editorCommandsOff = ui.commands.register(...panel.commands()); editorCommandsOwner = panel }
      else if (editorCommandsOwner === panel && !panel.editor) { editorCommandsOff?.dispose(); editorCommandsOff = undefined; editorCommandsOwner = undefined }
    },
    onViewChange: panel => {
      const p = ui.panes.find(panel.id)
      if (!p) return
      const view = panel.viewState()
      p.api.updateParameters(withNote(p.params, { path: panel.path, ...(view ? { view } : {}) }))
      ui.layout.scheduleSave()
    },
    onDirtyChange: panel => noteTabs.get(panel.id)?.render(),
    askConflict: panel => ui.dialogs.ask(noteConflictSituation(panel.path)).then(a => (a.choice === 'reload' ? 'reload' : 'keep')),
    onTabMenu: (id, ev) => ui.panes.showTabMenu(id, ev.clientX, ev.clientY),
    onRename: (id, name) => { void renameNote(id, name) },
    onClose: id => ui.panes.close(id),
    onSourceChange: panel => { for (const p of previewsOf(panel.path)) p.sourceChanged() },
    onScroll: panel => { for (const p of previewsOf(panel.path)) p.editorScrolled(panel) },
    onPathChange: (panel, from) => { for (const p of previewsOf(from)) p.setPath(panel.path) },
  }

  /** Adds the pane of a note (in the reference's group by default, or at `target` relative to it). */
  function addNotePanel(path: string, reference?: string, target?: Target): IDockviewPanel {
    const panel = ui.panes.open(notePanelOptions(path), { ...(target ? { target } : {}), ...(reference ? { reference } : {}) })
    ui.layout.scheduleSave()
    return panel
  }

  /** The folder a new note belongs to: the active pane's opening folder, or none. */
  const paneCwdForNote = (): string | undefined => ui.panes.cwdOf(activeId())

  /** Asks once per repository whether `.tether/` goes into its `.gitignore`. */
  async function askGitignore(repoRoot: string): Promise<void> {
    const answer = await ui.dialogs.ask(noteGitignoreSituation(repoRoot))
    await ipc.invoke('gitignore', repoRoot, answer.choice === 'add')
  }

  /** "Nova nota": a file under the active pane's folder (`.tether/notes/`), opened beside it; in a git repository, the `.gitignore` question once. */
  async function newNote(): Promise<void> {
    const reference = activeId()
    const prepared = await ipc.invoke('prepare', paneCwdForNote())
    const panel = addNotePanel(prepared.path, reference)
    requestAnimationFrame(() => ui.panes.focus(panel.id))
    if (prepared.askGitignore) {
      await askGitignore(prepared.askGitignore)
      ui.panes.focus(panel.id)
    }
  }

  /** The open note showing `path`, if any (paths compared case-insensitively: Windows). */
  function noteByPath(path: string): NotePanel | undefined {
    const key = path.toLowerCase()
    for (const n of notes.values()) if (n.path.toLowerCase() === key) return n
    return undefined
  }

  /** "Abrir nota…": the OS file dialog; a file already open is focused instead of opened twice. */
  async function openNote(path?: string): Promise<void> {
    const reference = activeId()
    const picked = path ?? await ipc.invoke('pickOpen', paneCwdForNote())
    if (!picked) return
    const existing = noteByPath(picked)
    if (existing) { setActive(existing.id); existing.focus(); return }
    const panel = addNotePanel(picked, reference)
    requestAnimationFrame(() => ui.panes.focus(panel.id))
  }

  /**
   * A text file (Ctrl+P, a terminal link, "abrir o arquivo-fonte"): in the focused pane's tab group (or beside it), as a
   * note tab that remembers the root it was opened from; a tab already showing the file is focused.
   */
  function openTextFile(path: string, opts: OpenFileOptions): void {
    const existing = noteByPath(path)
    if (existing) {
      setActive(existing.id)
      existing.focus()
      if (opts.position) existing.reveal(opts.position)
      return
    }
    const reference = opts.reference ?? activeId()
    const options = { ...notePanelOptions(path), params: withNote(undefined, { path, ...(opts.root ? { cwd: opts.root } : {}) }) }
    const panel = ui.panes.open(options, { ...(opts.side ? { target: { level: 'pane', placement: 'right' } as Target } : {}), ...(reference ? { reference } : {}) })
    ui.layout.scheduleSave()
    if (opts.position) notes.get(panel.id)?.reveal(opts.position)
    requestAnimationFrame(() => ui.panes.focus(panel.id))
  }

  /** "Salvar nota como…": the OS save dialog; the note moves to the chosen file (the old one stays as it was). */
  async function saveNoteAs(id = activeNoteId()): Promise<void> {
    const note = id ? notes.get(id) : undefined
    if (!note) return
    const picked = await ipc.invoke('pickSaveAs', note.path)
    if (!picked || picked === note.path) { note.focus(); return }
    await note.saveAs(picked)
    noteTabs.get(note.id)?.render()
    note.focus()
  }

  /** The active pane when it is a note (the keyboard's last owner when the active pane is not conclusive). */
  function activeNoteId(): string | undefined {
    const active = activeId()
    if (active && notes.has(active)) return active
    if (editorCommandsOwner && notes.has(editorCommandsOwner.id)) return editorCommandsOwner.id
    return undefined
  }

  /** The tab's rename: the file is renamed in its folder (`.md` added when missing); a refusal keeps the old name. */
  async function renameNote(id: string, typed: string): Promise<void> {
    const note = notes.get(id)
    const name = cleanNoteName(typed)
    if (!note || !name || name === noteTitle(note.path)) return
    const dir = noteDirOf(note.path)
    const sep = note.path.includes('\\') ? '\\' : '/'
    const to = dir ? `${dir}${sep}${name}` : name
    const r = await ipc.invoke('rename', note.path, to)
    if (!r.ok) { console.warn(`renomear nota: ${r.message}`); return }
    note.setPath(to)
    noteTabs.get(id)?.render()
  }

  /** Main's watcher saw the file change: the note that shows it decides (reload, keep, or ask). */
  function onNoteChanged(path: string): void {
    const note = noteByPath(path)
    if (note) void note.onExternalChange()
    for (const p of previews.values()) if (p.watches(path)) p.diskChanged()
  }

  // ---------- previews ----------

  const previewHost: PreviewHost = {
    io,
    getScheme: () => ui.theme.scheme(),
    getAppearance: () => ui.theme.appearance(),
    editorFor: path => { const n = noteByPath(path); return n && n.isReady ? n : undefined },
    openFile: (path, noteDir, line) => { void ui.openers.open(path, { side: false, root: noteDir, ...(line ? { position: { line } } : {}) }) },
    openExternal: url => ui.shell.openExternal(url),
    onParamsChange: panel => {
      const p = ui.panes.find(panel.id)
      if (!p) return
      p.api.updateParameters(withPreview(p.params, { path: panel.path, ...(panel.line !== undefined ? { line: panel.line } : {}) }))
      ui.layout.scheduleSave()
    },
    activate: panel => { const p = ui.panes.find(panel.id); if (p && !p.api.isGroupActive) p.api.setActive() },
    revealSource: (panel, line) => {
      const note = noteByPath(panel.path)
      if (note) { setActive(note.id); note.reveal({ line }); note.focus(); return }
      void ui.openers.open(panel.path, { side: false, root: noteDirOf(panel.path), reference: panel.id, position: { line } })
    },
    onTabMenu: (id, x, y) => ui.panes.showTabMenu(id, x, y),
    onClose: id => ui.panes.close(id),
  }

  /** The previews showing `path` as their file (paths compared case-insensitively: Windows): they follow the editor of that file. */
  function previewsOf(path: string): PreviewPane[] {
    const key = path.toLowerCase()
    return [...previews.values()].filter(p => p.path.toLowerCase() === key)
  }

  /**
   * VS Code's "Open Preview" (`side: false`: a tab in the note's group) and "Open Preview to the Side" (`side: true`:
   * a pane to its right, the keyboard staying in the editor). A file that already has a preview gets that one focused.
   */
  function openPreview(opts: { side: boolean; reference?: string }): IDockviewPanel | undefined {
    const reference = opts.reference ?? activeId()
    const path = reference ? notes.get(reference)?.path ?? previews.get(reference)?.path : undefined
    if (!reference || !path) return undefined
    return showPreview(path, { side: opts.side, reference })
  }

  /** The preview of `path`, in the group of `reference` or beside it; an existing one is brought forward instead. */
  function showPreview(path: string, opts: { side: boolean; reference: string }): IDockviewPanel | undefined {
    const kind = isHtmlPath(path) ? 'html' : 'md'
    const key = path.toLowerCase()
    const existing = [...previews.values()].find(p => p.kind === kind && p.path.toLowerCase() === key)
    if (existing) {
      const panel = ui.panes.find(existing.id)
      panel?.api.setActive()
      requestAnimationFrame(() => existing.focus())
      return panel
    }
    const panel = ui.panes.open(previewPaneOptions(newPreviewPanelId(), path, kind, undefined), { ...(opts.side ? { target: { level: 'pane', placement: 'right' } as Target } : {}), reference: opts.reference })
    ui.layout.scheduleSave()
    // In its own group the preview takes the keyboard; beside the editor the person keeps typing.
    if (opts.side) { setActive(opts.reference); requestAnimationFrame(() => ui.panes.focus(opts.reference)) }
    else requestAnimationFrame(() => ui.panes.focus(panel.id))
    return panel
  }

  /** Ctrl+P / Ctrl+click on an .html: its preview, in the group of the pane that asked (or beside it). */
  function openHtmlFile(path: string, opts: OpenFileOptions): void {
    const reference = opts.reference ?? activeId()
    if (!reference) { addNotePanel(path); return } // no pane at all: nothing to put a tab next to
    showPreview(path, { side: opts.side, reference })
  }

  /** From a preview back to its file: the open editor is brought forward (at the preview's line), else the file is opened in the preview's group. */
  function openPreviewSource(id: string, path?: string): void {
    const preview = previews.get(id)
    if (!preview) return
    const file = path ?? preview.path
    const note = noteByPath(file)
    if (note) {
      setActive(note.id)
      if (preview.kind === 'md') note.scrollToLine(preview.topLine())
      note.focus()
      return
    }
    void ui.openers.open(file, { side: false, root: noteDirOf(file), reference: id, source: true })
  }

  /** "Abrir no navegador": the file with the system's browser (the same refusals as any file opened with the system). */
  function openInBrowser(path: string): void {
    void ipc.invoke('openInBrowser', path).then(r => { if (!r.ok) void ui.dialogs.ask(fileOpenFailedSituation(r.message)) })
  }

  const htmlPreviewHost: HtmlPreviewHost = {
    io,
    onParamsChange: panel => {
      const p = ui.panes.find(panel.id)
      if (!p) return
      p.api.updateParameters(withPreview(p.params, { path: panel.path, kind: 'html', scroll: panel.scrollPosition }))
      ui.layout.scheduleSave()
    },
    viewSource: (panel, path) => openPreviewSource(panel.id, path),
    openInBrowser: path => openInBrowser(path),
    activate: panel => { const p = ui.panes.find(panel.id); if (p && !p.api.isGroupActive) p.api.setActive() },
    onTabMenu: (id, x, y) => ui.panes.showTabMenu(id, x, y),
  }

  const openFolder = (path: string): void => { void ui.shell.openPath(noteDirOf(path)).then(r => { if (!r.ok) console.warn(`open folder: ${r.message}`) }) }

  /** "Revelar no explorador" (the explorer extension's command, acting on the active pane's file); absent while that extension is off. */
  const revealEntry = (): ContextMenuEntry[] => ui.commands.ids().includes('explorer.reveal')
    ? [{ icon: 'target', label: 'Revelar no explorador', run: () => { void ui.commands.run('explorer.reveal') } }]
    : []

  /** The note's tab menu: new things next to it, the file (rename, save as, its folder), where it lives, close. */
  function showNoteMenu(id: string, x: number, y: number): void {
    const note = notes.get(id)
    if (!note) return
    ui.menus.context(x, y, [
      { icon: 'plus', label: ui.panes.newPanelLabel, run: () => ui.panes.newPanelDialog(id) },
      { icon: 'note-pencil', label: 'Nova nota', run: () => { void newNote() } },
      'sep',
      { icon: 'pencil-simple', label: 'Renomear…', run: () => noteTabs.get(id)?.startRename() },
      { icon: 'floppy-disk', label: 'Salvar nota como…', run: () => { void saveNoteAs(id) } },
      ...(isPreviewablePath(note.path) ? [{ icon: 'eye', label: 'Abrir prévia', run: () => { openPreview({ side: false, reference: id }) } }, { icon: 'square-split-horizontal', label: 'Abrir prévia ao lado', run: () => { openPreview({ side: true, reference: id }) } }] : []),
      { icon: 'copy', label: 'Copiar caminho da nota', run: () => ui.shell.writeClipboard(note.path) },
      { icon: 'folder-open', label: 'Abrir pasta da nota no Explorer', run: () => openFolder(note.path) },
      ...revealEntry(),
      'sep',
      { icon: 'arrow-square-out', label: 'Mover…', run: () => ui.panes.move(id) },
      'sep',
      { icon: 'x', label: 'Fechar nota', run: () => ui.panes.close(id) },
    ])
  }

  /** The preview's tab menu: its source, where it lives, close. */
  function showPreviewMenu(id: string, x: number, y: number): void {
    const preview = previews.get(id)
    if (!preview) return
    ui.menus.context(x, y, [
      { icon: 'note-pencil', label: preview.kind === 'html' ? 'Ver código' : 'Abrir o arquivo-fonte', run: () => openPreviewSource(id) },
      ...(preview instanceof HtmlPreviewPanel ? [{ icon: 'arrow-square-out', label: 'Abrir no navegador', run: () => openInBrowser(preview.path) }, { icon: 'arrow-clockwise', label: 'Recarregar a página', run: () => preview.reload() }] : []),
      { icon: 'copy', label: 'Copiar caminho do arquivo', run: () => ui.shell.writeClipboard(preview.path) },
      { icon: 'folder-open', label: 'Abrir pasta do arquivo no Explorer', run: () => openFolder(preview.path) },
      ...revealEntry(),
      'sep',
      { icon: 'arrow-square-out', label: 'Mover…', run: () => ui.panes.move(id) },
      'sep',
      { icon: 'x', label: 'Fechar prévia', run: () => ui.panes.close(id) },
    ])
  }

  // ---------- pane types ----------

  /** Keeps `map` in step with a pane's life: set on init (dockview gives the id there), removed on dispose. */
  function tracked<T extends M & { id: string; init(params: never): void; dispose(): void }, M>(pane: T, map: Map<string, M>): T {
    const init = pane.init.bind(pane) as (params: never) => void
    pane.init = ((params: never) => { init(params); map.set(pane.id, pane) }) as T['init']
    const dispose = pane.dispose.bind(pane)
    pane.dispose = () => { const k = pane.id; dispose(); if (map.get(k) === pane) map.delete(k) }
    return pane
  }

  const previewCwd = (id: string): string | undefined => { const p = previews.get(id); return p ? noteByPath(p.path)?.cwd ?? paneCwdOfNote(p.path) : undefined }
  const previewFile = (id: string): string | undefined => previews.get(id)?.path
  const previewFolder = (id: string): string | undefined => { const p = previews.get(id); return p ? noteDirOf(p.path) : undefined }
  const focusPreview = (id: string): void => previews.get(id)?.focus()

  const htmlType: PaneType = {
    ...htmlPreviewLayout, hasSlot: false, icon: 'eye',
    create: () => tracked(new HtmlPreviewPanel(htmlPreviewHost), previews),
    has: id => previews.get(id) instanceof HtmlPreviewPanel,
    cwdOf: previewCwd,
    fileOf: previewFile,
    folderOf: previewFolder,
    focus: focusPreview,
    contextFlags: () => ['markdown.preview'],
    tabMenu: showPreviewMenu,
  }
  const mdType: PaneType = {
    ...mdPreviewLayout, hasSlot: false, icon: 'eye',
    create: () => tracked(new PreviewPanel(previewHost), previews),
    createTab: () => new PreviewTab(previewHost),
    has: id => previews.has(id) && !(previews.get(id) instanceof HtmlPreviewPanel),
    cwdOf: previewCwd,
    fileOf: previewFile,
    folderOf: previewFolder,
    focus: focusPreview,
    contextFlags: () => ['markdown.preview'],
    tabMenu: showPreviewMenu,
  }
  const noteType: PaneType = {
    ...noteLayout, hasSlot: false, icon: 'note-pencil',
    create: () => tracked(new NotePanel(noteHost), notes),
    createTab: () => {
      const tab = new NoteTab(noteHost, id => notes.get(id)?.dirty ?? false)
      const init = tab.init.bind(tab)
      tab.init = params => { init(params); noteTabs.set(params.api.id, tab) }
      const dispose = tab.dispose.bind(tab)
      tab.dispose = () => { dispose(); for (const [id, t] of noteTabs) if (t === tab) noteTabs.delete(id) }
      return tab
    },
    has: id => notes.has(id),
    cwdOf: id => { const n = notes.get(id); return n ? n.cwd ?? paneCwdOfNote(n.path) : undefined },
    fileOf: id => notes.get(id)?.path,
    folderOf: id => { const n = notes.get(id); return n ? noteDirOf(n.path) : undefined },
    focus: id => notes.get(id)?.focus(),
    rename: id => noteTabs.get(id)?.startRename(),
    // The preview family's commands act on a note whose file can be previewed (markdown or HTML).
    contextFlags: id => isPreviewablePath(notes.get(id)?.path ?? '') ? ['markdown.note'] : [],
    closedEntry: id => {
      const path = notes.get(id)?.path
      if (path === undefined) return undefined
      return { key: `note:${path}`, reopen: () => { if (noteByPath(path)) return false; void openNote(path); return true } }
    },
    tabMenu: showNoteMenu,
    // The tab strip's "prévia ao lado" button.
    canPreviewSide: id => { const n = notes.get(id); return !!n && isPreviewablePath(n.path) },
    previewSide: id => { openPreview({ side: true, reference: id }) },
    // A two-key chord whose second key is the editor's (Ctrl+K Ctrl+C…): Monaco runs it.
    editorChord: (id, first, second) => { const ed = notes.get(id)?.editor; return !!ed && !!editorChordCommand(ed, first, second) },
    runEditorChord: (id, first, ev) => { const ed = notes.get(id)?.editor; if (ed) runEditorChord(ed, first, ev) },
  }
  subs.push(ui.panes.register(htmlType), ui.panes.register(mdType), ui.panes.register(noteType))
  // A file renamed by another extension (the explorer): the notes showing it, or a file under a renamed folder, follow it.
  subs.push(ui.files.onDidRename(({ from, to }) => {
    for (const n of notes.values()) {
      const next = rebasePath(n.path, from, to)
      if (next !== undefined && next !== n.path) n.setPath(next)
    }
  }))

  // ---------- commands ----------

  subs.push(
    ui.commands.registerCommand('note.new', () => { void newNote() }),
    ui.commands.registerCommand('note.open', () => { void openNote() }),
    ui.commands.registerCommand('markdown.preview', () => { openPreview({ side: false }) }),
    ui.commands.registerCommand('markdown.preview.side', () => { openPreview({ side: true }) }),
    ui.commands.registerCommand('markdown.source', () => { const a = activeId(); if (a && previews.has(a)) openPreviewSource(a) }),
    ui.commands.registerCommand('note.save', () => { const id = activeNoteId(); if (id) void notes.get(id)?.save() }),
    ui.commands.registerCommand('note.save-as', () => { void saveNoteAs() }),
    ui.commands.registerCommand('ui.word-wrap', () => noteHost.toggleWordWrap()),
  )

  // ---------- chooser items ----------

  subs.push(
    ui.chooser.resolve('note-new', async cwd => {
      const prepared = await ipc.invoke('prepare', cwd || undefined)
      const repo = prepared.askGitignore
      return { options: notePanelOptions(prepared.path), ...(repo ? { after: () => askGitignore(repo) } : {}) }
    }),
    ui.chooser.resolve('note-open', async cwd => {
      const picked = await ipc.invoke('pickOpen', cwd || undefined)
      if (!picked) return undefined
      const existing = noteByPath(picked)
      if (existing) { setActive(existing.id); existing.focus(); return undefined }
      return { options: notePanelOptions(picked) }
    }),
  )

  // ---------- files from Ctrl+P, terminal links, "abrir keybindings.json" ----------
  // An .html file opens as its running page (not for "ver código", nor at a line); every other text file as a note.

  subs.push(
    ui.openers.register({ id: 'note.html-preview', canOpen: (path, opts) => isHtmlPath(path) && !opts.source && !opts.position, open: openHtmlFile }),
    ui.openers.register({ id: 'note.editor', canOpen: () => true, open: openTextFile }),
  )

  // ---------- the shortcuts screen: Monaco's own keybindings, read once from an editor ----------

  let editorBindingsCache: FixedBinding[] | undefined
  subs.push(ui.keybindings.fixedBindings(() => {
    if (editorBindingsCache) return editorBindingsCache
    let editor = [...notes.values()].find(n => n.editor)?.editor
    let throwaway: ReturnType<typeof monaco.editor.create> | undefined
    if (!editor) {
      const el = document.createElement('div')
      el.style.cssText = 'position:absolute;left:-9999px;width:200px;height:100px'
      document.body.append(el)
      throwaway = monaco.editor.create(el, { value: '', language: 'markdown' })
      editor = throwaway
    }
    try {
      const seen = new Set<string>()
      editorBindingsCache = editorKeybindings(editor).filter(k => !seen.has(`${k.command}|${k.keys}`) && seen.add(`${k.command}|${k.keys}`))
        .map(k => ({ command: k.command, title: k.label, group: 'Editor', keys: null, label: k.keys, where: ['note'], source: 'editor' }))
    } finally {
      if (throwaway) { throwaway.dispose(); throwaway.getDomNode()?.parentElement?.remove() }
    }
    return editorBindingsCache
  }))

  // ---------- theme, terminal font, word wrap ----------

  const restyle = (): void => { for (const p of previews.values()) p.restyle() }
  // One Monaco theme for every editor, rebuilt from the tokens just painted.
  const applyScheme = (): void => { monaco.editor.setTheme(defineTheme(ui.theme.scheme())); mirrorThemeVars(); restyle() }
  subs.push(
    ui.theme.onChange(applyScheme),
    ui.theme.onAppearance(a => { for (const n of notes.values()) n.setAppearance(a); restyle(); remeasureEditorFonts() }),
    ui.settings.onChange('wordWrap', v => { for (const n of notes.values()) n.setWordWrap(v === true) }),
  )
  // Editors can be created (a restored layout) before the web font is in: Monaco then caches the fallback font's
  // character widths and draws the caret off the text. Whenever a face finishes loading, measure again.
  const onFontsLoaded = (): void => remeasureEditorFonts()
  document.fonts.addEventListener('loadingdone', onFontsLoaded)
  // The page goes (window closed, reload): every note's pending text is written.
  const flushAll = (): void => { for (const n of notes.values()) n.flush() }
  window.addEventListener('beforeunload', flushAll)
  subs.push({ dispose: () => { document.fonts.removeEventListener('loadingdone', onFontsLoaded); window.removeEventListener('beforeunload', flushAll) } })

  // ---------- main's events ----------

  subs.push(
    ipc.on('changed', onNoteChanged),
    // The isolated page of an HTML preview reports what it loaded, and forwards the chords pressed inside it.
    ipc.on('htmlReport', report => { for (const p of previews.values()) if (p instanceof HtmlPreviewPanel && p.hasPartition(report.partition)) p.onReport(report) }),
    ipc.on('htmlKey', key => { for (const p of previews.values()) if (p instanceof HtmlPreviewPanel && p.hasPartition(key.partition)) p.replayKey(key) }),
  )

  // ---------- test hooks (window.__tether.ext.note.*, also flat on window.__tether as before) ----------

  ui.test.expose('wordWrap', () => ({ setting: wordWrap(), editors: [...notes.values()].map(n => n.wordWrapOption()) }))
  ui.test.expose('scrollNote', (id: string, top: number) => { notes.get(id)?.editor?.setScrollTop(top, 1 /* ScrollType.Immediate */) })
  ui.test.expose('previews', () => [...previews.values()].flatMap(p => (p instanceof PreviewPanel ? [p.snapshot()] : [])))
  ui.test.expose('preview', (id: string) => { const p = previews.get(id); return p instanceof PreviewPanel ? p.snapshot() : undefined })
  ui.test.expose('previewRect', (id: string, selector: string) => { const p = previews.get(id); return p instanceof PreviewPanel ? p.rectOf(selector) : undefined })
  ui.test.expose('openPreview', (side: boolean) => openPreview({ side })?.id)
  ui.test.expose('htmlPreviews', () => [...previews.values()].flatMap(p => (p instanceof HtmlPreviewPanel ? [p.snapshot()] : [])))
  ui.test.expose('htmlPreview', (id: string) => { const p = previews.get(id); return p instanceof HtmlPreviewPanel ? p.snapshot() : undefined })
  ui.test.expose('htmlPreviewRect', (id: string) => { const p = previews.get(id); return p instanceof HtmlPreviewPanel ? p.viewRect() : undefined })
  ui.test.expose('htmlPreviewAction', (id: string, action: 'reload') => { const p = previews.get(id); if (!(p instanceof HtmlPreviewPanel)) return; if (action === 'reload') p.reload() })
  ui.test.expose('notes', () => [...notes.values()].map(n => n.snapshot()))
  ui.test.expose('note', (id: string) => notes.get(id)?.snapshot())
  ui.test.expose('newNote', newNote)
  ui.test.expose('openNote', (path: string) => openNote(path))
  ui.test.expose('editorCommandIds', () => ui.commands.ids().filter(id => id.startsWith('editor.')))

  subs.push({ dispose: () => editorCommandsOff?.dispose() })
  return subs
}
