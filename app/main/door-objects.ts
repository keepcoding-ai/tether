// Electron main's side of the extensions' object data (agent door): `TetherMain.objects` of each extension, a mirror of tetherd's
// store kept by the same rules as the renderer's (app/renderer/door/objects.ts), asking the daemon through main's own connection.
import type { ExtObjects } from '../shared/api.ts'
import { ObjectMirrors, type DaemonAsk, type ObjectEventBody } from '../renderer/door/objects.ts'
import type { MainDoorObjects } from './ext-host.ts'

export class DoorObjects implements MainDoorObjects {
  private readonly mirrors: ObjectMirrors

  constructor(ask: DaemonAsk) { this.mirrors = new ObjectMirrors(ask) }

  apiFor(ext: string): ExtObjects { return this.mirrors.apiFor(ext) }

  /** tetherd's `object` event. */
  apply(e: ObjectEventBody): void { this.mirrors.apply(e) }

  /** The daemon connected (the first time or again): every mirror reads it. */
  reload(): Promise<void> { return this.mirrors.reload() }
}
