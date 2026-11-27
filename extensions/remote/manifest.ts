// The remote extension (Regência remota, plano D1b): the person reaches this tether from a paired device, through a blind
// relay, end to end encrypted. Daemon half (RR1, step 1.3): the house's files, pairing gestures of the app, revocation, and
// the portal process (tether-remoted). App half (RR2, step 2.2): the state icon, "Aparelhos" in the Regency's "Sistema" and
// the pairing screen with the six digits typed on the machine. Ids never change.
import type { ExtensionManifest } from '../types.ts'
import { EXT_ID } from './rules.ts'

/** The top bar icon (`contributes.status`), never renamed. */
export const STATUS_ID = 'remote.status'

export const manifest: ExtensionManifest = {
  id: EXT_ID,
  version: '0.2.0',
  displayName: 'Acesso remoto',
  description: 'Deixa você acompanhar este tether de um aparelho pareado, pela internet, com cifra de ponta a ponta.',
  hosts: ['daemon', 'renderer'],
  optional: true,
  contributes: {
    status: [{ id: STATUS_ID, icon: 'device-mobile', order: 55 }],
  },
}
