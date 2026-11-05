// Monaco (the VS Code editor) for the note tab, bundled by esbuild and served offline (app/build.mjs):
//   - the editor API plus the features a markdown note uses (multi-cursor and column selection, line
//     operations, find/replace with regex, folding, minimap, smart select, cursor undo, links, sticky scroll…);
//     the language-server features (suggest, rename, code lens, parameter hints…) stay out, as does Monaco's
//     own F1 palette: the app's palette (Ctrl+Shift+P) lists the editor's actions when a note has the focus;
//   - the markdown language definition (Monarch tokenizer: headings, emphasis, code, links), plus the Monarch
//     grammars of the common file types Quick Open opens (ts/js/json/css/html/yaml/ps1/sh/py/ini/xml/bat);
//   - the editor web worker (word-based features, link detection, diff) as app/dist/editor.worker.js;
//   - two themes built from the app's own tokens (styles.css), redefined on every scheme switch.
// monaco-editor's package exports map `monaco-editor/<path>.js` to `esm/vs/<path>.js`.
import * as monaco from 'monaco-editor/editor.js'
import 'monaco-editor/features/codeEditor/register.js'
import 'monaco-editor/features/codicon/register.js'
import 'monaco-editor/features/anchorSelect/register.js'
import 'monaco-editor/features/bracketMatching/register.js'
import 'monaco-editor/features/caretOperations/register.js'
import 'monaco-editor/features/clipboard/register.js'
import 'monaco-editor/features/comment/register.js'
import 'monaco-editor/features/contextmenu/register.js'
import 'monaco-editor/features/cursorUndo/register.js'
import 'monaco-editor/features/dnd/register.js'
import 'monaco-editor/features/find/register.js'
import 'monaco-editor/features/folding/register.js'
import 'monaco-editor/features/gotoLine/register.js'
import 'monaco-editor/features/hover/register.js'
import 'monaco-editor/features/indentation/register.js'
import 'monaco-editor/features/inPlaceReplace/register.js'
import 'monaco-editor/features/lineSelection/register.js'
import 'monaco-editor/features/linesOperations/register.js'
import 'monaco-editor/features/links/register.js'
import 'monaco-editor/features/longLinesHelper/register.js'
import 'monaco-editor/features/middleScroll/register.js'
import 'monaco-editor/features/multicursor/register.js'
import 'monaco-editor/features/placeholderText/register.js'
import 'monaco-editor/features/readOnlyMessage/register.js'
import 'monaco-editor/features/sectionHeaders/register.js'
import 'monaco-editor/features/smartSelect/register.js'
import 'monaco-editor/features/snippet/register.js'
import 'monaco-editor/features/stickyScroll/register.js'
import 'monaco-editor/features/toggleTabFocusMode/register.js'
import 'monaco-editor/features/tokenization/register.js'
import 'monaco-editor/features/unicodeHighlighter/register.js'
import 'monaco-editor/features/unusualLineTerminators/register.js'
import 'monaco-editor/features/wordHighlighter/register.js'
import 'monaco-editor/features/wordOperations/register.js'
import 'monaco-editor/features/wordPartOperations/register.js'
import 'monaco-editor/languages/definitions/markdown/register.js'
import 'monaco-editor/languages/definitions/typescript/register.js'
import 'monaco-editor/languages/definitions/javascript/register.js'
import 'monaco-editor/languages/definitions/css/register.js'
import 'monaco-editor/languages/definitions/html/register.js'
import 'monaco-editor/languages/definitions/yaml/register.js'
import 'monaco-editor/languages/definitions/powershell/register.js'
import 'monaco-editor/languages/definitions/shell/register.js'
import 'monaco-editor/languages/definitions/python/register.js'
import 'monaco-editor/languages/definitions/ini/register.js'
import 'monaco-editor/languages/definitions/xml/register.js'
import 'monaco-editor/languages/definitions/bat/register.js'
import type { ColorScheme } from '../shared/theme.ts'

export { monaco }
export type Editor = monaco.editor.IStandaloneCodeEditor
export type ViewState = monaco.editor.ICodeEditorViewState

// The worker is a sibling of the renderer bundle (app/dist/editor.worker.js, classic script). Same origin
// (file:), so the page's CSP (default-src 'self') admits it; Monaco falls back to the main thread if it fails.
;(globalThis as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
  getWorker: () => new Worker(new URL('./editor.worker.js', import.meta.url)),
}

// Files opened by Quick Open get the language of their extension (Monaco picks it from the model's URI). Only
// Monarch tokenizers (colouring, brackets, comments), no language services or workers. Monaco ships no Monarch
// grammar for JSON (its JSON support is a language service), so a small one is declared here.
monaco.languages.register({ id: 'json', extensions: ['.json', '.jsonc', '.json5', '.code-workspace', '.babelrc', '.eslintrc'], filenames: ['.prettierrc'], aliases: ['JSON', 'json'], mimetypes: ['application/json'] })
monaco.languages.setLanguageConfiguration('json', {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [['{', '}'], ['[', ']']],
  autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '"', close: '"', notIn: ['string'] }],
})
monaco.languages.setMonarchTokensProvider('json', {
  tokenizer: {
    root: [
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'type'],
      [/"(?:[^"\\]|\\.)*"/, 'string'],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
      [/\b(?:true|false|null)\b/, 'keyword'],
      [/\/\/.*$/, 'comment'],
      [/\/\*/, 'comment', '@comment'],
      [/[{}[\]]/, '@brackets'],
      [/[,:]/, 'delimiter'],
    ],
    comment: [[/[^/*]+/, 'comment'], [/\*\//, 'comment', '@pop'], [/[/*]/, 'comment']],
  },
})

export const THEME_NAME: Record<ColorScheme, string> = { light: 'tether-light', dark: 'tether-dark' }

/** `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()` → `#rrggbb[aa]` (Monaco wants hex); anything else → undefined. */
export function cssColorToHex(value: string): string | undefined {
  const v = value.trim()
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v)) return v.toLowerCase()
  if (/^#[0-9a-f]{3,4}$/i.test(v)) return `#${[...v.slice(1)].map(c => c + c).join('')}`.toLowerCase()
  const m = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i.exec(v)
  if (!m) return undefined
  const hex = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  let out = `#${hex(Number(m[1]))}${hex(Number(m[2]))}${hex(Number(m[3]))}`
  if (m[4] !== undefined) {
    const a = m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4])
    out += hex(a * 255)
  }
  return out
}

/** The app's tokens the editor theme is painted with (styles.css), read from the document. */
export function readTokens(el: Element = document.documentElement): Record<string, string> {
  const style = getComputedStyle(el)
  const out: Record<string, string> = {}
  for (const name of ['--bg', '--bg-2', '--bg-3', '--bg-hover', '--fg', '--fg-dim', '--accent', '--border', '--frame-bg', '--frame-border', '--err', '--warn']) {
    const hex = cssColorToHex(style.getPropertyValue(name))
    if (hex) out[name] = hex
  }
  return out
}

/** With-alpha variant of a 6-digit hex. */
function alpha(hex: string, a: number): string {
  return `${hex.slice(0, 7)}${Math.round(a * 255).toString(16).padStart(2, '0')}`
}

/**
 * (Re)defines the theme of a scheme from the tokens painted right now: the editor sits inside a frame card, so
 * its background is the frame's; selection, cursor and widgets follow the accent; line numbers the dim text.
 */
export function defineTheme(scheme: ColorScheme, tokens: Record<string, string> = readTokens()): string {
  const name = THEME_NAME[scheme]
  const bg = tokens['--frame-bg'] ?? (scheme === 'dark' ? '#1e1e23' : '#fbfbfd')
  const fg = tokens['--fg'] ?? (scheme === 'dark' ? '#d8d8dc' : '#24292f')
  const dim = tokens['--fg-dim'] ?? (scheme === 'dark' ? '#9a9aa3' : '#5f6368')
  const accent = tokens['--accent'] ?? (scheme === 'dark' ? '#6aa6ff' : '#1f6fe0')
  const widget = tokens['--bg-2'] ?? bg
  const border = tokens['--border'] ?? dim
  monaco.editor.defineTheme(name, {
    base: scheme === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': bg,
      'editor.foreground': fg,
      'editorLineNumber.foreground': alpha(dim, 0.7),
      'editorLineNumber.activeForeground': fg,
      'editorCursor.foreground': accent,
      'editor.selectionBackground': alpha(accent, scheme === 'dark' ? 0.35 : 0.25),
      'editor.inactiveSelectionBackground': alpha(accent, 0.15),
      'editor.selectionHighlightBackground': alpha(accent, 0.18),
      'editor.wordHighlightBackground': alpha(accent, 0.15),
      'editor.findMatchBackground': alpha(accent, 0.45),
      'editor.findMatchHighlightBackground': alpha(accent, 0.22),
      'editor.lineHighlightBackground': alpha(fg, 0.04),
      'editor.lineHighlightBorder': '#00000000',
      'editorIndentGuide.background1': alpha(dim, 0.2),
      'editorIndentGuide.activeBackground1': alpha(dim, 0.45),
      'editorWhitespace.foreground': alpha(dim, 0.3),
      'editorGutter.background': bg,
      'editorWidget.background': widget,
      'editorWidget.border': border,
      'editorWidget.foreground': fg,
      'editorSuggestWidget.background': widget,
      'editorHoverWidget.background': widget,
      'editorHoverWidget.border': border,
      'input.background': tokens['--bg'] ?? widget,
      'input.foreground': fg,
      'input.border': border,
      'focusBorder': accent,
      'scrollbarSlider.background': alpha(dim, 0.25),
      'scrollbarSlider.hoverBackground': alpha(dim, 0.4),
      'scrollbarSlider.activeBackground': alpha(dim, 0.55),
      'scrollbar.shadow': '#00000000',
      'minimap.background': bg,
      'minimap.selectionHighlight': alpha(accent, 0.6),
      'editorOverviewRuler.border': '#00000000',
      'editorBracketMatch.background': alpha(accent, 0.2),
      'editorBracketMatch.border': alpha(accent, 0.6),
      'editorStickyScroll.background': bg,
      'editorStickyScroll.shadow': alpha(fg, 0.12),
      'list.hoverBackground': tokens['--bg-hover'] ?? alpha(fg, 0.08),
      'list.activeSelectionBackground': alpha(accent, 0.3),
      'list.focusBackground': alpha(accent, 0.3),
      'button.background': accent,
      'badge.background': alpha(accent, 0.3),
      'badge.foreground': fg,
      'errorForeground': tokens['--err'] ?? '#ef6a6a',
      'editorError.foreground': tokens['--err'] ?? '#ef6a6a',
      'editorWarning.foreground': tokens['--warn'] ?? '#e6b450',
    },
  })
  return name
}
