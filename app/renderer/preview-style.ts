// The look of the markdown preview, close to VS Code's markdown.css but painted with the app's own tokens
// (styles.css), so the same document follows the light/dark switch. The preview lives in its own frame (a separate
// document: nothing of the app's CSS reaches it), so the tokens are copied in as variables on every scheme change.
import type { ColorScheme } from '../shared/theme.ts'

/** The app tokens the preview uses, read from the page's computed style (monaco.ts `readTokens` gives hex only; here any CSS value is fine). */
export const PREVIEW_TOKENS = ['--bg', '--bg-2', '--bg-3', '--bg-hover', '--fg', '--fg-dim', '--accent', '--accent-hover', '--border', '--frame-bg', '--err', '--warn', '--ok', '--ui', '--mono'] as const

export function readPreviewTokens(el: Element = document.documentElement): Record<string, string> {
  const style = getComputedStyle(el)
  const out: Record<string, string> = {}
  for (const name of PREVIEW_TOKENS) {
    const v = style.getPropertyValue(name).trim()
    if (v) out[name] = v
  }
  return out
}

/** `:root { --x: …; }` for the tokens, with the colour scheme, the terminal's code font and its ligatures choice (off also covers `calt`, which browsers apply by default). */
export function tokensCss(tokens: Record<string, string>, scheme: ColorScheme, codeFont: string, ligatures = true): string {
  const vars = Object.entries(tokens).map(([k, v]) => `${k}:${v};`).join('')
  const off = ligatures ? '' : 'code,kbd,pre{font-variant-ligatures:none;font-feature-settings:"calt" 0,"liga" 0,"clig" 0,"dlig" 0;}'
  return `:root{${vars}--code-font:${codeFont};color-scheme:${scheme};}${off}`
}

/** The document's stylesheet (variables come from `tokensCss`). */
export const PREVIEW_CSS = `
html { background: var(--frame-bg); }
body {
  margin: 0; padding: 0 26px 48px; color: var(--fg); background: var(--frame-bg);
  font-family: var(--ui, system-ui, sans-serif); font-size: 14px; line-height: 1.6; word-wrap: break-word;
}
#root > :first-child { margin-top: 20px; }
#root > .code-line:first-child { margin-top: 20px; }
h1, h2, h3, h4, h5, h6 { font-weight: 600; line-height: 1.25; margin: 1.6em 0 .6em; }
h1 { font-size: 2em; padding-bottom: .3em; border-bottom: 1px solid var(--border); margin-top: .8em; }
h2 { font-size: 1.5em; padding-bottom: .3em; border-bottom: 1px solid var(--border); }
h3 { font-size: 1.25em; }
h4 { font-size: 1em; }
h5 { font-size: .875em; }
h6 { font-size: .85em; color: var(--fg-dim); }
p, ul, ol, dl, blockquote, pre, table, details { margin: 0 0 1em; }
ul, ol { padding-left: 2em; }
li > p { margin: .25em 0; }
li > ul, li > ol { margin: .25em 0; }
a { color: var(--accent); text-decoration: none; cursor: pointer; }
a:hover { color: var(--accent-hover); text-decoration: underline; }
a:not([href]) { color: inherit; cursor: default; text-decoration: none; }
strong { font-weight: 600; }
hr { border: 0; border-top: 1px solid var(--border); margin: 1.6em 0; height: 0; }
blockquote { margin-left: 0; padding: 2px 16px; border-left: 4px solid var(--border); background: var(--bg-2); color: var(--fg-dim); }
blockquote > :last-child { margin-bottom: 0; }
code { font-family: var(--code-font, var(--mono, monospace)); font-size: .9em; padding: .15em .4em; border-radius: 4px; background: var(--bg-3); }
pre { padding: 12px 14px; overflow: auto; border-radius: 6px; background: var(--bg-2); border: 1px solid var(--border); line-height: 1.45; }
pre code { padding: 0; background: none; font-size: .9em; white-space: pre; }
table { border-collapse: collapse; display: block; overflow: auto; max-width: 100%; }
th, td { border: 1px solid var(--border); padding: 6px 12px; }
th { background: var(--bg-2); font-weight: 600; text-align: left; }
tr:nth-child(even) td { background: color-mix(in srgb, var(--bg-2) 55%, transparent); }
img { max-width: 100%; vertical-align: middle; }
kbd { font-family: var(--code-font, var(--mono, monospace)); font-size: .85em; padding: 1px 6px; border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 4px; background: var(--bg-2); }
mark { background: color-mix(in srgb, var(--warn) 35%, transparent); color: inherit; }
summary { cursor: pointer; }
del, s { color: var(--fg-dim); }
.img-blocked { display: inline-block; padding: 1px 8px; border: 1px dashed var(--border); border-radius: 4px; color: var(--fg-dim); font-size: .9em; }
.contains-task-list { list-style: none; padding-left: 1.2em; }
.task-list-item-checkbox { margin: 0 .5em 0 -1.2em; vertical-align: middle; }
:target, .flash { background: color-mix(in srgb, var(--accent) 18%, transparent); }
::selection { background: color-mix(in srgb, var(--accent) 35%, transparent); }
::-webkit-scrollbar { width: 12px; height: 12px; }
::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--fg-dim) 35%, transparent); border-radius: 6px; border: 3px solid transparent; background-clip: content-box; }
::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--fg-dim) 55%, transparent); background-clip: content-box; }
.mtki { font-style: italic; } .mtkb { font-weight: 600; } .mtku { text-decoration: underline; }
`

/** The page of the preview frame: no script, no network, only images from files and inline data. */
export function previewShell(): string {
  return `<!doctype html><html><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file: data:; style-src 'unsafe-inline'">`
    + `<style id="tokens"></style><style id="base">${PREVIEW_CSS}</style><style id="syntax"></style>`
    + `</head><body><main id="root"></main></body></html>`
}
