// Monaco's own keybindings, read from the editor's keybinding service (the one VS Code runs in the editor): two
// uses. (1) Inside a note, the app owns the prefix key (Ctrl+K) so the pill shows; the second key goes to the editor
// FIRST: if Monaco has a chord for the pair (Ctrl+K Ctrl+C comments, Ctrl+K Ctrl+0 folds…) its command runs through
// `editor.trigger`, else the app's table decides. (2) The "Atalhos de teclado" screen lists the editor's keys, shown
// only (recording them is for later). The service is a private field of the standalone editor (`_standaloneKeybindingService`)
// with VS Code's resolver behind it; everything here is guarded so a Monaco upgrade degrades to "no editor chords".
import type { editor as MonacoEditor } from 'monaco-editor/editor.js'
import { monaco } from './monaco.ts'
import { editorCommandId } from './note-rules.ts'
import type { Chord, KeyLike } from './shortcuts.ts'

interface ResolvedKeybinding { getDispatchChords(): (string | null)[]; getLabel(): string | null }
interface ResolveResult { kind: number; commandId?: string | null; commandArgs?: unknown }
interface KeybindingItem { command: string | null; chords: string[]; resolvedKeybinding?: ResolvedKeybinding; isDefault: boolean }
interface Resolver { resolve(context: unknown, currentChords: string[], keypress: string): ResolveResult; getKeybindings(): KeybindingItem[] }
interface KeybindingService {
  resolveKeyboardEvent(ev: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; keyCode: number; code?: string }): ResolvedKeybinding
  _getResolver(): Resolver
  _contextKeyService: { getContext(target: unknown): unknown }
}

function serviceOf(editor: MonacoEditor.IStandaloneCodeEditor): KeybindingService | undefined {
  const s = (editor as unknown as { _standaloneKeybindingService?: Partial<KeybindingService> })._standaloneKeybindingService
  if (!s || typeof s.resolveKeyboardEvent !== 'function' || typeof s._getResolver !== 'function') return undefined
  return s as KeybindingService
}

/** Monaco's KeyCode for a `KeyboardEvent.code` (the enum shares most names), undefined for a key it has no code for. */
export function monacoKeyCode(code: string): number | undefined {
  const KeyCode = monaco.KeyCode as unknown as Record<string, number | undefined>
  const norm = code === 'IntlBackslash' ? 'Backslash' : code
  const map: Record<string, string> = { ArrowUp: 'UpArrow', ArrowDown: 'DownArrow', ArrowLeft: 'LeftArrow', ArrowRight: 'RightArrow' }
  const name = map[norm] ?? norm
  const v = KeyCode[name]
  return typeof v === 'number' ? v : undefined
}

function dispatchString(service: KeybindingService, ev: KeyLike): string | undefined {
  const keyCode = monacoKeyCode(ev.code)
  if (keyCode === undefined) return undefined
  try {
    const chords = service.resolveKeyboardEvent({ ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey, altKey: ev.altKey, metaKey: ev.metaKey, keyCode, code: ev.code }).getDispatchChords()
    return chords[0] ?? undefined
  } catch { return undefined }
}

const chordAsEvent = (c: Chord): KeyLike => ({ ctrlKey: !!c.ctrl, shiftKey: !!c.shift, altKey: !!c.alt, metaKey: !!c.meta, code: c.code })

/** The editor's command for the chord (first, second) in this editor's context, or undefined when Monaco has none. */
export function editorChordCommand(editor: MonacoEditor.IStandaloneCodeEditor, first: Chord, second: KeyLike): { commandId: string; args?: unknown } | undefined {
  const service = serviceOf(editor)
  if (!service) return undefined
  const a = dispatchString(service, chordAsEvent(first))
  const b = dispatchString(service, second)
  if (!a || !b) return undefined
  try {
    const context = service._contextKeyService?.getContext(editor.getDomNode())
    const r = service._getResolver().resolve(context, [a], b)
    // 2 = KbFound (VS Code's ResultKind); an empty commandId is VS Code's "remove this keybinding".
    if (r.kind === 2 && r.commandId) return { commandId: r.commandId, args: r.commandArgs }
  } catch { /* a resolver of another shape: no editor chord */ }
  return undefined
}

/** Runs the editor's own chord: true when Monaco had one (and it ran). */
export function runEditorChord(editor: MonacoEditor.IStandaloneCodeEditor, first: Chord, second: KeyLike): boolean {
  const hit = editorChordCommand(editor, first, second)
  if (!hit) return false
  editor.focus()
  editor.trigger('keyboard', hit.commandId, hit.args)
  return true
}

export interface EditorKeybinding { command: string; action: string; label: string; keys: string }

/** Every default keybinding of the editor that has a label, for the screen (command ids in the registry's `editor.*` form). */
export function editorKeybindings(editor: MonacoEditor.IStandaloneCodeEditor): EditorKeybinding[] {
  const service = serviceOf(editor)
  if (!service) return []
  const titles = new Map(editor.getSupportedActions().map(a => [a.id, a.label]))
  const out: EditorKeybinding[] = []
  try {
    for (const item of service._getResolver().getKeybindings()) {
      if (!item.command || !item.resolvedKeybinding) continue
      const label = item.resolvedKeybinding.getLabel()
      const title = titles.get(item.command)
      if (!label || !title) continue
      out.push({ command: editorCommandId(item.command), action: item.command, label: title, keys: label })
    }
  } catch { return [] }
  return out
}
