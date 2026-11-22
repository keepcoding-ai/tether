/**
 * Windows occlusion detection. Chromium's native window occlusion calculation (CalculateNativeWinOcclusion) can
 * wrongly conclude on Windows that the window is covered, which throttles timers to 1 Hz and suspends rAF (terminal
 * typing and scroll stall). It is the only cause of that stall, so it is the only thing disabled by default.
 * Renderer backgrounding and background timer throttling stay at Chromium's defaults, so a minimized or background
 * window still saves CPU and memory. `performance.throttling: true` in settings.json (or TETHER_THROTTLING=1) applies
 * no switch at all. Command-line switches must be appended before `app.whenReady()`.
 */
export interface ThrottleSwitches {
  /** Plain switches (no value). */
  flags: string[]
  /** Features for the single `disable-features` switch. */
  disableFeatures: string[]
}

export function throttleSwitches(throttling: boolean): ThrottleSwitches {
  if (throttling) return { flags: [], disableFeatures: [] }
  return {
    flags: [],
    disableFeatures: ['CalculateNativeWinOcclusion'],
  }
}

/** The restore switch: the env var wins, then the settings file's `performance.throttling`. */
export function throttlingWanted(env: string | undefined, setting: unknown): boolean {
  if (env === '1') return true
  return setting === true
}

export function applyThrottleSwitches(
  commandLine: { appendSwitch(name: string, value?: string): void },
  throttling: boolean,
): ThrottleSwitches {
  const sw = throttleSwitches(throttling)
  for (const f of sw.flags) commandLine.appendSwitch(f)
  if (sw.disableFeatures.length) commandLine.appendSwitch('disable-features', sw.disableFeatures.join(','))
  return sw
}
