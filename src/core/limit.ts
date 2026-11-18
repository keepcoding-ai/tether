// Bounded concurrency for async disk work: the daemon shares one loop with terminal echo, so boot-time reads go in small waves.

/** A gate that runs at most `n` of the functions given to it at a time, in the order they came; each call resolves with its function's result. */
export function limiter(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: (() => void)[] = []
  const next = (): void => {
    active--
    waiting.shift()?.()
  }
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((resolve) => waiting.push(resolve))
    active++
    try {
      return await fn()
    } finally {
      next()
    }
  }
}

/** Runs `fn` over `items` with at most `n` in flight, starting them in order; a failure rejects after the ones in flight settle. */
export async function mapLimit<T, R>(items: readonly T[], n: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0
  let failed: { error: unknown } | undefined
  const worker = async (): Promise<void> => {
    while (!failed && cursor < items.length) {
      const i = cursor++
      try { out[i] = await fn(items[i]!, i) } catch (error) { failed ??= { error } }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  if (failed) throw failed.error
  return out
}
