// The note extension (F9 slice 1): the note editor (Monaco), the markdown preview and the HTML preview, one extension
// (decision 4: the previews follow the editor of their file). Its shape mirrors VS Code's built-in
// markdown-language-features (package.json `contributes` @7faf984: commands, keybindings, menus, configuration,
// customEditors): the data the core needs before activation lives here; renderer.ts and main.ts register the behaviour.
// Every id below (commands, pane components, prefixes, setting) is already in people's files and never changes.
import type { ExtensionManifest } from '../types.ts'
import { NOTE_PANE_LAYOUTS } from './layouts.ts'

const NOTE = 'Nota'
const LOOK = 'Aparência'

export const manifest: ExtensionManifest = {
  id: 'note',
  version: '1.0.0',
  displayName: 'Nota',
  description: 'Editor de notas e arquivos de texto, com prévia de markdown e de HTML.',
  hosts: ['renderer', 'main'],
  optional: true,
  contributes: {
    paneTypes: NOTE_PANE_LAYOUTS,
    settings: {
      wordWrap: { type: 'boolean', default: true, title: 'Quebra de linha no editor' },
    },
    commands: [
      { command: 'note.new', title: 'Nova nota', category: NOTE, icon: 'note-pencil' },
      { command: 'note.open', title: 'Abrir nota…', category: NOTE, icon: 'folder-open' },
      { command: 'markdown.preview', title: 'Prévia: abrir', category: NOTE, icon: 'eye', keepKeyWhenUnavailable: true, when: 'markdown.note' },
      { command: 'markdown.preview.side', title: 'Prévia: abrir ao lado', category: NOTE, icon: 'square-split-horizontal', when: 'markdown.note' },
      { command: 'markdown.source', title: 'Markdown: abrir o arquivo-fonte', category: NOTE, icon: 'note-pencil', when: 'markdown.preview' },
      { command: 'note.save', title: 'Salvar a nota agora', category: NOTE, icon: 'floppy-disk', when: 'focus == editor' },
      { command: 'note.save-as', title: 'Salvar nota como…', category: NOTE, icon: 'floppy-disk', when: 'focus == editor' },
      { command: 'ui.word-wrap', title: 'Quebra de linha no editor', category: LOOK, icon: 'text-aa' },
    ],
    keybindings: [
      { key: 'ctrl+o', command: 'note.open' },                          // "open file" (window and note; in a terminal Ctrl+O is Claude Code's verbose toggle)
      { key: 'ctrl+s', command: 'note.save', where: ['note'] },
      { key: 'ctrl+shift+s', command: 'note.save-as', where: ['note'] },
      { key: 'ctrl+shift+v', command: 'markdown.preview', where: ['note'] }, // in a terminal Ctrl+Shift+V pastes (PANE_SHORTCUTS)
      { key: 'ctrl+k v', command: 'markdown.preview.side', where: ['note'] },
    ],
    menus: {
      app: [
        { command: 'note.new', group: 'note', order: 10, icon: 'note-pencil', label: 'Nova nota' },
        { command: 'note.open', group: 'note', order: 20, icon: 'folder-open', label: 'Abrir nota…' },
        { command: 'note.save-as', group: 'note', order: 30, icon: 'floppy-disk', label: 'Salvar nota como…' },
        { command: 'ui.word-wrap', group: 'look', order: 70, kind: 'checkbox', toggled: 'wordWrap', label: 'Quebra de linha no editor' },
      ],
    },
    chooser: {
      groups: [{ id: 'note', label: 'Nota', icon: 'note-pencil' }],
      items: [
        { id: 'note-new', group: 'note', name: 'Nova nota', hint: 'arquivo .md novo em <pasta>/.tether/notes', icon: 'note-pencil', keywords: ['nota', 'note', 'nova', 'novo', 'md', 'markdown', 'arquivo', 'texto'], button: { verb: 'create', name: 'nota' } },
        { id: 'note-open', group: 'note', name: 'Abrir nota…', hint: 'um arquivo existente, pelo seletor de arquivos', icon: 'folder-open', keywords: ['nota', 'note', 'abrir', 'md', 'markdown', 'arquivo', 'existente'], button: { verb: 'open', name: 'nota…' } },
      ],
    },
    migrations: [
      { from: 'ui.wordWrap', to: { setting: 'wordWrap' } },
      { from: 'notes.gitignoreDeclined', to: { state: 'gitignoreDeclined' } },
    ],
  },
}
