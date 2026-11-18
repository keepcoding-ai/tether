/**
 * Chromium's background throttling and native window occlusion detection. On Windows the occlusion detector can
 * wrongly treat the window as hidden/covered, which throttles timers to 1 Hz and suspends rAF (terminal typing and
 * scroll stall). We switch them off by default; `performance.throttling: true` in settings.json (or TETHER_THROTTLING=1)
 * restores Chromium's defaults. Command-line switches must be appended before `app.whenReady()`.
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
    flags: ['disable-renderer-backgrounding', 'disable-background-timer-throttling', 'disable-backgrounding-occluded-windows'],
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
