// Loads the vendored terminal without a screen: on the first read, never at start-up. A tetherd in which nobody reads a screen
// never pays for the package. The folder is checked against its manifest first (vendor-rules.ts); a copy that disagrees is not
// loaded. Asynchronous throughout (the tetherd's loop runs it).
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { XtermModule } from './text.ts'
import { auditVendor, VENDOR_ENTRY, VENDOR_PACKAGE_DIR } from './vendor-rules.ts'

/** The vendor folder of this extension (extensions/for-agents/vendor). */
export const DEFAULT_VENDOR_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor')

export type XtermLoader = () => Promise<XtermModule>

/**
 * A loader that audits `vendorDir` and imports the package once; later calls share the result. A failure is not kept, so a
 * repaired copy loads on the next read. `importModule` is replaceable for tests.
 */
export function createXtermLoader(vendorDir: string = DEFAULT_VENDOR_DIR, importModule: (path: string) => Promise<unknown> = p => import(pathToFileURL(p).href)): XtermLoader {
  let loaded: Promise<XtermModule> | undefined
  return () => {
    if (!loaded) {
      loaded = (async () => {
        const problems = await auditVendor(vendorDir)
        if (problems.length) throw new Error(`o pacote vendorizado não confere com o manifesto: ${problems.join('; ')}`)
        const mod = await importModule(join(vendorDir, VENDOR_PACKAGE_DIR, VENDOR_ENTRY)) as { Terminal?: unknown; default?: { Terminal?: unknown } }
        const Terminal = mod.Terminal ?? mod.default?.Terminal
        if (typeof Terminal !== 'function') throw new Error('o pacote vendorizado não exporta Terminal')
        return { Terminal } as XtermModule
      })()
      loaded.catch(() => { loaded = undefined })
    }
    return loaded
  }
}

/** The loader the extension uses: one for the process. */
export const loadXterm: XtermLoader = createXtermLoader()
