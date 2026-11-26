// The one way this client builds DOM: elements by name, attributes from a closed list, and every string child as a
// text node. There is no innerHTML, no insertAdjacentHTML and no string that becomes markup (A-4): whatever comes
// from the house is rendered as text, always. The CSP (require-trusted-types-for 'script') would refuse the rest.

type Attr = 'class' | 'id' | 'type' | 'role' | 'for' | 'name' | 'inputmode' | 'autocomplete' | 'autocapitalize'
  | 'spellcheck' | 'enterkeyhint' | 'maxlength' | 'placeholder' | 'datetime' | 'aria-live' | 'aria-label'
  | 'aria-describedby' | 'aria-hidden' | `data-${string}`

export type Child = Node | string | false | null | undefined

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Partial<Record<Attr, string>> = {}, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, v)
  for (const c of children) {
    if (c === false || c === null || c === undefined) continue
    el.append(typeof c === 'string' ? document.createTextNode(c) : c)
  }
  return el
}

/** Replaces everything inside `parent` with `children`. */
export function mount(parent: HTMLElement, ...children: Child[]): void {
  parent.replaceChildren()
  for (const c of children) {
    if (c === false || c === null || c === undefined) continue
    parent.append(typeof c === 'string' ? document.createTextNode(c) : c)
  }
}
