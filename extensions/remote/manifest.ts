// The remote extension (Regência remota, plano D1b): the person reaches this tether from a paired device, through a blind
// relay, end to end encrypted. Daemon half (RR1, step 1.3): the house's files, pairing gestures of the app, revocation, and
// the portal process (tether-remoted). The app half (state icon, devices, pairing screen) comes with RR2. Ids never change.
import type { ExtensionManifest } from '../types.ts'
import { EXT_ID } from './rules.ts'

export const manifest: ExtensionManifest = {
  id: EXT_ID,
  version: '0.1.0',
  displayName: 'Acesso remoto',
  description: 'Deixa você acompanhar este tether de um aparelho pareado, pela internet, com cifra de ponta a ponta.',
  hosts: ['daemon'],
  optional: true,
}
