// The bell (top bar, left of the extensions' status icons): the recent attention that reached the person while tether
// was not in front, the level of the system toasts (the SAME setting as the settings page: `notifications.os`) and a
// temporary mute. Main owns the history and the mute (app/main/main.ts, rules in app/shared/os-notify.ts); this draws them.
import { icon } from './icons.ts'
import { bellState, normalizeOsNotify, OS_NOTIFY_LEVELS, type AttentionState, type MuteChoice, type OsNotifyLevel } from '../shared/os-notify.ts'

const LEVEL_LABEL: Record<OsNotifyLevel, string> = { all: 'Todas', waiting: 'Só quando esperam você', off: 'Desligadas' }
const MUTE_LABEL: Array<[MuteChoice, string]> = [['30m', '30 min'], ['1h', '1 h'], ['tomorrow', 'até amanhã']]
const SETTING = 'notifications.os'

export interface BellDeps {
  openSlot(slotId: string): void
  /** "Mais opções…": the settings page on the notifications section. */
  showSettings(key: string): void
  /** The other toolbar popups close when this one opens. */
  closeOthers(): void
}

const hhmm = (t: number): string => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

export function setupBell(deps: BellDeps): { close(): void } {
  const wrap = document.getElementById('bell-wrap')!
  const btn = document.getElementById('btn-bell') as HTMLButtonElement
  const pop = document.getElementById('bell-pop')!
  let state: AttentionState = { items: [], unseen: 0 }
  let level: OsNotifyLevel = 'all'

  const paintButton = (): void => {
    const s = bellState(level, state.mutedUntil, Date.now())
    const glyph = s === 'muted' || s === 'off' ? icon('bell-slash') : icon('bell')
    btn.replaceChildren(glyph)
    if (s === 'waiting') btn.append(Object.assign(document.createElement('span'), { className: 'bell-dot' }))
    if (s === 'muted') { const c = icon('clock'); c.classList.add('bell-clock'); btn.append(c) }
    if (state.unseen) btn.append(Object.assign(document.createElement('span'), { className: 'bell-count', textContent: String(state.unseen) }))
    const title = s === 'muted' ? `Notificações silenciadas até ${hhmm(state.mutedUntil!)}` : `Notificações: ${LEVEL_LABEL[level]}`
    btn.title = state.unseen ? `${title} · ${state.unseen} não vista${state.unseen > 1 ? 's' : ''}` : title
  }

  const section = (label: string): HTMLElement => Object.assign(document.createElement('div'), { className: 'bell-label', textContent: label })

  const paintPop = (): void => {
    const parts: HTMLElement[] = []
    const head = document.createElement('div')
    head.className = 'bell-head'
    head.append(section('Pedem atenção'))
    if (state.unseen) {
      const seen = Object.assign(document.createElement('button'), { type: 'button', className: 'bell-link', textContent: 'Marcar como vistas' })
      seen.addEventListener('click', () => window.tether.attentionSeen())
      head.append(seen)
    }
    parts.push(head)
    const list = document.createElement('ul')
    list.className = 'bell-list'
    if (!state.items.length) list.append(Object.assign(document.createElement('li'), { className: 'bell-empty', textContent: 'Nenhum aviso recente.' }))
    for (const e of state.items) {
      const li = document.createElement('li')
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `bell-item${e.seen ? '' : ' unseen'}`
      const name = Object.assign(document.createElement('span'), { className: 'bell-name', textContent: e.label })
      const kind = Object.assign(document.createElement('span'), { className: `bell-kind ${e.kind}`, textContent: e.kind === 'waiting' ? 'esperando' : 'terminou' })
      const at = Object.assign(document.createElement('span'), { className: 'bell-at', textContent: hhmm(e.at) })
      b.append(name, kind, at)
      b.addEventListener('click', () => { toggle(false); deps.openSlot(e.slotId) })
      li.append(b)
      list.append(li)
    }
    parts.push(list, section('Avisar no Windows'))
    const radios = document.createElement('div')
    radios.className = 'bell-radios'
    radios.setAttribute('role', 'radiogroup')
    for (const l of OS_NOTIFY_LEVELS) {
      const label = document.createElement('label')
      const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'bell-level', value: l, checked: l === level })
      input.addEventListener('change', () => { level = l; paintButton(); void window.tether.settingsSet(SETTING, l) })
      label.append(input, LEVEL_LABEL[l])
      radios.append(label)
    }
    parts.push(radios, section('Silenciar'))
    const mute = document.createElement('div')
    mute.className = 'bell-mute'
    if (state.mutedUntil !== undefined) {
      mute.append(`Silenciado até ${hhmm(state.mutedUntil)} · `)
      const on = Object.assign(document.createElement('button'), { type: 'button', className: 'bell-link', textContent: 'Reativar' })
      on.addEventListener('click', () => window.tether.attentionMute(null))
      mute.append(on)
    } else {
      MUTE_LABEL.forEach(([choice, text], i) => {
        if (i) mute.append(' · ')
        const b = Object.assign(document.createElement('button'), { type: 'button', className: 'bell-link', textContent: text })
        b.addEventListener('click', () => window.tether.attentionMute(choice))
        mute.append(b)
      })
    }
    const more = Object.assign(document.createElement('button'), { type: 'button', className: 'bell-more', textContent: 'Mais opções…' })
    more.addEventListener('click', () => { toggle(false); deps.showSettings(SETTING) })
    parts.push(mute, more)
    pop.replaceChildren(...parts)
  }

  const paint = (): void => { paintButton(); if (!pop.hidden) paintPop() }

  function toggle(open: boolean): void {
    pop.hidden = !open
    btn.setAttribute('aria-expanded', String(open))
    if (!open) return
    deps.closeOthers()
    paintPop()
    // Opening the menu shows the list: what was unseen is seen now (the badge goes to zero, the rows keep their mark until the next paint).
    if (state.unseen) window.tether.attentionSeen()
  }

  const readLevel = async (): Promise<void> => {
    const list = await window.tether.settingsList()
    level = normalizeOsNotify(list.entries.find(e => e.key === SETTING)?.value)
    paint()
  }

  btn.setAttribute('aria-controls', 'bell-pop')
  btn.addEventListener('click', ev => { ev.stopPropagation(); toggle(pop.hidden) })
  document.addEventListener('click', ev => { if (!pop.hidden && !wrap.contains(ev.target as Node)) toggle(false) })
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape' || pop.hidden) return
    toggle(false)
    btn.focus()
  }, true)
  window.tether.onAttention(s => { state = s; paint() })
  window.tether.onSettingsChanged(keys => { if (keys.some(k => k === SETTING || k === 'notifications')) void readLevel() })
  void window.tether.attentionGet().then(s => { state = s; paint() })
  void readLevel()
  return { close: () => { if (!pop.hidden) toggle(false) } }
}
