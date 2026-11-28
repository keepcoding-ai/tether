// "Avisos neste aparelho" (RR4 step 4.4): what the item of the session says, from what the browser and the house tell. Pure:
// no DOM, no navigator; push.ts reads the browser and hands the facts here. The words are the product's (Portuguese); what
// a notice is about is said in one line: an agent that waits for the person, a speech or a poll that calls her.

export type PushPhase = 'on' | 'off' | 'blocked' | 'install' | 'unavailable' | 'busy' | 'failed'

export interface PushFacts {
  /** The TV: nothing to tap there (the notices are the phone's and the desk's). */
  tv: boolean
  /** The browser has a service worker, PushManager and Notification. */
  supported: boolean
  /** An iPhone or an iPad: there the notices exist only for the app on the home screen. */
  ios: boolean
  /** The page runs as the installed app (display-mode standalone). */
  standalone: boolean
  permission: 'default' | 'granted' | 'denied'
  /** The house said this device is subscribed (attention.push-key `on`) and the browser holds a subscription. */
  on: boolean
  busy: boolean
  /** The last attempt failed: the push service of this browser is not one the house posts to, or it just did not work. */
  fail?: 'service' | 'failed'
}

export interface PushModel {
  phase: PushPhase
  title: string
  /** What the notices are, in one line. */
  lead: string
  /** Where they are now. */
  state: string
  /** The one gesture, when there is one. */
  action?: { label: string; turn: 'on' | 'off' }
}

export const PUSH_TEXT = {
  title: 'Avisos neste aparelho',
  lead: 'Avisa quando um agente espera você ou quando falam com você num canal.',
  on: 'Ligados.',
  off: 'Desligados.',
  blocked: 'Bloqueados no navegador: libere as notificações deste site nas configurações dele.',
  install: 'Instale o app para receber avisos: no Safari, Compartilhar, depois Adicionar à Tela de Início.',
  unavailable: 'Não disponível aqui.',
  busy: 'Um momento…',
  service: 'Não liguei: o serviço de avisos deste navegador não é um dos que o tether aceita.',
  failed: 'Não consegui ligar agora. Tente de novo.',
  turnOn: 'Ligar avisos',
  turnOff: 'Desligar avisos',
  button: 'Avisos',
} as const

export function pushModel(f: PushFacts): PushModel {
  const base = { title: PUSH_TEXT.title, lead: PUSH_TEXT.lead }
  if (f.tv) return { ...base, phase: 'unavailable', state: PUSH_TEXT.unavailable }
  if (!f.supported) return f.ios && !f.standalone
    ? { ...base, phase: 'install', state: PUSH_TEXT.install }
    : { ...base, phase: 'unavailable', state: PUSH_TEXT.unavailable }
  if (f.ios && !f.standalone) return { ...base, phase: 'install', state: PUSH_TEXT.install }
  if (f.busy) return { ...base, phase: 'busy', state: PUSH_TEXT.busy }
  if (f.permission === 'denied') return { ...base, phase: 'blocked', state: PUSH_TEXT.blocked }
  if (f.on) return { ...base, phase: 'on', state: PUSH_TEXT.on, action: { label: PUSH_TEXT.turnOff, turn: 'off' } }
  if (f.fail) return { ...base, phase: 'failed', state: f.fail === 'service' ? PUSH_TEXT.service : PUSH_TEXT.failed, action: { label: PUSH_TEXT.turnOn, turn: 'on' } }
  return { ...base, phase: 'off', state: PUSH_TEXT.off, action: { label: PUSH_TEXT.turnOn, turn: 'on' } }
}

/** An iPhone or an iPad (an iPad says it is a Mac, but has touch). */
export function isIos(ua: string, platform: string, touchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (platform === 'MacIntel' && touchPoints > 1)
}

/** The same VAPID key: the browser's subscription was made for this house's K_V (bytes against base64url). */
export function sameKey(a: ArrayBuffer | null | undefined, b64: string): boolean {
  if (!a) return false
  const bytes = new Uint8Array(a)
  let s = ''
  for (const x of bytes) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') === b64
}
