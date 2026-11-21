// Loads the vendored terminal without a screen: on the first read, never at start-up. A tetherd in which nobody reads a screen
// never pays for the package. The folder is checked against its manifest first (vendor-rules.ts); a copy that disagrees is not
// loaded. Asynchronous throughout (the tetherd's loop runs it).
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { XtermModule } from './text.ts'
import { auditVendor, VENDOR_ENTRY, VENDOR_PACKAGE_DIR } from './vendor-rules.ts'

/**
 * The vendor folder of this extension (extensions/for-agents/vendor), found on use, never when the module loads: Electron main
 * bundles this module as CommonJS (import.meta is empty there), and the screen is read in the tetherd, which runs the source as ESM.
 * ESM: this file's folder. CJS bundle (app/dist/main.cjs, in development or packaged): `__dirname` is app/dist, two levels
 * below the root; a packaged root inside app.asar is read from app.asar.unpacked (`extensions/**` is in asarUnpack).
 */
export function defaultVendorDir(): string {
  const here = import.meta.dirname
  if (typeof here === 'string' && here) return join(here, '..', 'vendor')
  if (typeof __dirname === 'string') return join(__dirname, '..', '..', 'extensions', 'for-agents', 'vendor').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  throw new Error('não achei a pasta vendor da extensão for-agents')
}

export type XtermLoader = () => Promise<XtermModule>

/**
 * A loader that audits `vendorDir` and imports the package once; later calls share the result. A failure is not kept, so a
 * repaired copy loads on the next read. `importModule` is replaceable for tests.
 */
export function createXtermLoader(vendorDir?: string, importModule: (path: string) => Promise<unknown> = p => import(pathToFileURL(p).href)): XtermLoader {
  let loaded: Promise<XtermModule> | undefined
  return () => {
    if (!loaded) {
      loaded = (async () => {
        const dir = vendorDir ?? defaultVendorDir()
        const problems = await auditVendor(dir)
        if (problems.length) throw new Error(`o pacote vendorizado não confere com o manifesto: ${problems.join('; ')}`)
        const mod = await importModule(join(dir, VENDOR_PACKAGE_DIR, VENDOR_ENTRY)) as { Terminal?: unknown; default?: { Terminal?: unknown } }
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
