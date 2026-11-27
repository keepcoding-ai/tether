// How a script of the remote web client is bundled, and what a bundle may never hold. One place for the build (build.mjs)
// and for the test that proves the closure (test/unit/remote.web-bundle.test.ts).
//
// The web client imports the Regency's shared screen (extensions/regency/renderer, extensions/channels/renderer). Two
// modules of the app's shell cannot run on the web's page, which enforces Trusted Types, and are swapped here for the web's
// own (remote/web/src):
//   app/renderer/svg-node.ts     -> src/svg-lite.ts   (an icon's text made into elements with no HTML sink)
//   app/renderer/tab-emblems.ts  -> src/ui-lite.ts    (the emblem chip without the sprite and the editor)
import { build, transform } from 'esbuild'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')

const SWAPS = new Map([
  [resolve(root, 'app', 'renderer', 'svg-node.ts'), join(here, 'src', 'svg-lite.ts')],
  [resolve(root, 'app', 'renderer', 'tab-emblems.ts'), join(here, 'src', 'ui-lite.ts')],
])

const shellLite = {
  name: 'shell-lite',
  setup(b) {
    b.onResolve({ filter: /(?:svg-node|tab-emblems)\.ts$/ }, (args) => {
      if (!args.path.startsWith('.')) return undefined
      const to = SWAPS.get(resolve(args.resolveDir, args.path))
      return to ? { path: to } : undefined
    })
  },
}

/** What a path of the bundle's inputs may never be: Node, Electron, the daemon, the app's main process, the dockview, a terminal, an editor. */
const FORBIDDEN_INPUT = [
  [/(^|[\\/])node:/, 'um módulo do Node'],
  [/src[\\/]remote[\\/]testing\.ts$/, 'src/remote/testing.ts (costura de teste)'],
  [/(^|[\\/])src[\\/](daemon|remoted|ptyd|agents|core|exec)[\\/]/, 'código do daemon'],
  [/(^|[\\/])app[\\/](main|preload)[\\/]/, 'o processo principal do app'],
  [/(^|[\\/])app[\\/]renderer[\\/](svg-node|tab-emblems)\.ts$/, 'um módulo da casca do app que a web troca pelo seu'],
  [/node_modules[\\/](electron|dockview-core|monaco-editor|@xterm|node-pty|koffi|ws)[\\/]/, 'um pacote que não é do navegador'],
]

/** What the bundle's text may never hold: an HTML sink (the page enforces Trusted Types), code from a string, a style written as an attribute. */
const FORBIDDEN_TEXT = [
  [/\beval\s*\(|new\s+Function\s*\(/, 'eval ou new Function'],
  [/\.\s*(?:innerHTML|outerHTML)\s*[+]?=[^=]|\binsertAdjacentHTML\s*\(|\bcreateContextualFragment\s*\(|\bdocument\s*\.\s*write(?:ln)?\s*\(|new\s+DOMParser\b/, 'um sumidouro de HTML (innerHTML, DOMParser e parentes)'],
  [/setAttribute\s*\(\s*["']style["']/, 'estilo escrito como atributo (a CSP só aceita o CSSOM)'],
  [/\brequire\s*\(\s*["']/, 'require() de um módulo'],
]

/**
 * Bundles `entry` for the browser (`define`: constants the build writes into the text, e.g. the service worker's file list).
 * Returns the text, the inputs and, when the bundle holds what it may not, why
 * (`refusal`, in the words the build prints).
 */
export async function bundle(entry, outfile, define) {
  const result = await build({
    bundle: true, platform: 'browser', format: 'esm', target: 'es2022', logLevel: 'warning', sourcemap: false,
    legalComments: 'none', metafile: true, charset: 'utf8', write: false, ...(define ? { define } : {}),
    loader: { '.svg': 'text' }, plugins: [shellLite],
    entryPoints: [entry], outfile: outfile ?? join(here, 'dist', 'out.js'),
  })
  const js = result.outputFiles[0].text
  const inputs = Object.keys(result.metafile.inputs)
  let refusal
  for (const [re, what] of FORBIDDEN_INPUT) {
    const hit = inputs.find((p) => re.test(p))
    if (hit) { refusal = `o bundle puxou ${what}: ${hit}`; break }
  }
  if (!refusal) {
    // The text is looked at without its comments (a comment may well say "never innerHTML").
    const code = (await transform(js, { minifyWhitespace: true, legalComments: 'none', charset: 'utf8' })).code
    for (const [re, what] of FORBIDDEN_TEXT) if (re.test(code)) { refusal = `o bundle tem ${what}`; break }
  }
  return { js, inputs, refusal }
}

export { here as webDir, root as repoRoot }
