// Subject: the extensions' object data (`ui.objects`, slice R6). The hooks are in `window.__tether.ext['door-probe']`:
// `objGet(kind, id, key)` and `objEntries(kind, key)` read the renderer's mirror, `objSet(kind, id, key, value)` writes through it
// (undefined deletes) and `objHeard()` lists the changes the mirror told. The main side of the probe (main.ts) reads the same data
// through `TetherMain.objects`.
import type { ObjectKind } from '../../../../src/daemon/protocol.ts'
import type { ExtObjectChange } from '../../../../app/shared/api.ts'
import type { TetherUi } from '../../../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../../../app/shared/vscode-lifecycle.ts'

export function objects(ui: TetherUi): IDisposable[] {
  const heard: ExtObjectChange[] = []
  ui.test.expose('objGet', (kind: ObjectKind, id: string, key: string) => ui.objects.get(kind, id, key))
  ui.test.expose('objEntries', (kind: ObjectKind, key: string) => ui.objects.entries(kind, key))
  ui.test.expose('objSet', (kind: ObjectKind, id: string, key: string, value: unknown) => ui.objects.set(kind, id, key, value))
  ui.test.expose('objHeard', () => heard)
  return [ui.objects.onDidChange(e => { heard.push(e) })]
}
