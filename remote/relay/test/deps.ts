// Whether the relay package's own dependencies are installed. The root test suite runs the relay tests, but `ws`
// lives in remote/relay/node_modules: a checkout without `npm ci` there skips them instead of failing to load.
import { createRequire } from 'node:module'

export const RELAY_DEPS_HINT = 'rode npm ci em remote/relay'

/** The skip reason when `ws` does not resolve from the relay package, or false when it does. */
export function relayDepsMissing(): string | false {
  try {
    createRequire(new URL('../package.json', import.meta.url)).resolve('ws')
    return false
  } catch {
    return RELAY_DEPS_HINT
  }
}
