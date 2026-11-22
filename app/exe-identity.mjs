// Gives a Windows Electron executable the tether's identity: the Task Manager reads the "Description" string of the PE
// version resource (Electron's is "Electron") and Explorer/the taskbar read the icon resource. Every Chromium child
// (renderer, GPU, utility) is the same exe, so one edit renames all of them.
// Used by app/install.mjs on the runtime copy (the packaged build is edited by electron-builder itself: electron-builder.yml). Never run it on
// node_modules/electron/dist: that binary is shared with the tests and `npm install` undoes it.
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const require = createRequire(import.meta.url)

/** What the executable is called on disk, in the Task Manager and in the icon/version resources. */
export const EXE_NAME = 'tether'
export const EXE_ICON = join(root, 'brand', 'assets', 'app', 'tether.ico')

/** The rcedit options for the tether (pure: tested without touching a binary). */
export function identityOptions({ version, icon = EXE_ICON }) {
  return {
    icon,
    'file-version': version,
    'product-version': version,
    'version-string': {
      ProductName: EXE_NAME,
      FileDescription: EXE_NAME,
      InternalName: EXE_NAME,
      OriginalFilename: `${EXE_NAME}.exe`,
      CompanyName: EXE_NAME,
      LegalCopyright: '',
    },
  }
}

/** Rewrites the icon and version resources of `exe` in place (rcedit; Windows only). */
export async function brandExecutable(exe, { version } = {}) {
  const { rcedit } = await import('rcedit')
  const v = version ?? require('../package.json').version
  await rcedit(exe, identityOptions({ version: v }))
}
