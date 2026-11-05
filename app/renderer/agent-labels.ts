// Per-agent text in the renderer is still a fixed table for the built-ins (the AgentUi registry of F9 §4.8
// comes with slice 4). Since the daemon's agent names are open strings now, every table answers for any
// name: an agent it does not know (an extension's, or one whose extension is off) gets `fallback(name)`.
export function byAgent<T>(known: Record<string, T>, fallback: (name: string) => T): Record<string, T> {
  return new Proxy(known, {
    get: (target, key) => (typeof key === 'string' && !Object.hasOwn(target, key) ? fallback(key) : Reflect.get(target, key)),
  })
}
