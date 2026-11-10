// A short message at the bottom of the window, with at most one action ("Desfazer", "Ver"), that goes away on its own.
// One at a time: a new message takes the place of the one on screen.
let current: { el: HTMLElement; timer: ReturnType<typeof setTimeout> } | undefined

export interface ToastSpec {
  text: string
  action?: { label: string; run(): void }
  /** How long it stays (ms). */
  ms?: number
}

export function dismissToast(): void {
  if (!current) return
  clearTimeout(current.timer)
  current.el.remove()
  current = undefined
}

export function showToast(spec: ToastSpec): void {
  dismissToast()
  const el = document.createElement('div')
  el.className = 'pf-toast'
  el.setAttribute('role', 'status')
  el.setAttribute('aria-live', 'polite')
  const text = document.createElement('span')
  text.textContent = spec.text
  el.append(text)
  if (spec.action) {
    const { label, run } = spec.action
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'pf-toast-action'
    b.textContent = label
    b.addEventListener('click', () => { dismissToast(); run() })
    el.append(b)
  }
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'pf-toast-close'
  close.title = 'Dispensar'
  close.setAttribute('aria-label', 'Dispensar')
  close.textContent = '×'
  close.addEventListener('click', () => dismissToast())
  el.append(close)
  document.body.append(el)
  current = { el, timer: setTimeout(() => { if (current?.el === el) dismissToast() }, spec.ms ?? 8000) }
}

/** What the e2e reads: the message on screen and its action's label. */
export function toastSnapshot(): { text: string; action?: string } | undefined {
  if (!current) return undefined
  const action = current.el.querySelector<HTMLElement>('.pf-toast-action')?.textContent ?? undefined
  return { text: current.el.querySelector('span')?.textContent ?? '', ...(action ? { action } : {}) }
}
