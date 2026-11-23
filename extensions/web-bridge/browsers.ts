// Which Chromium browsers this machine has, as pure rules (unit-tested with fixtures): the Windows registry's
// StartMenuInternet clients (`reg query HKLM\SOFTWARE\Clients\StartMenuInternet /s`, the text handed in) plus the
// installers' known paths, classified by the executable's name. Only Chrome, Edge and Brave: the ones whose
// `<scheme>://extensions` page and "Load unpacked" flow are the same (design §1.2).

export type BrowserId = 'chrome' | 'edge' | 'brave'

export interface DetectedBrowser {
  id: BrowserId
  /** What the person reads ("Google Chrome"). */
  name: string
  /** The executable (or a launcher script, in tests). */
  exe: string
  /** The extensions page to open after the install. */
  extensionsUrl: string
}

interface Known {
  id: BrowserId
  name: string
  /** Lowercase executable base names that are this browser. */
  exeNames: readonly string[]
  scheme: string
  /** Installers' paths, from the environment (Windows) or fixed (macOS/Linux). */
  paths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[]
}

const win = (env: NodeJS.ProcessEnv, ...tails: string[]): string[] => {
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter((r): r is string => !!r)
  return roots.flatMap(r => tails.map(t => `${r}\\${t}`))
}

/** In the order the picker shows them. */
export const KNOWN_BROWSERS: readonly Known[] = [
  {
    id: 'chrome', name: 'Google Chrome', exeNames: ['chrome.exe', 'google chrome', 'google-chrome', 'google-chrome-stable', 'chrome'], scheme: 'chrome',
    paths: (platform, env) => platform === 'win32' ? win(env, 'Google\\Chrome\\Application\\chrome.exe')
      : platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'],
  },
  {
    id: 'edge', name: 'Microsoft Edge', exeNames: ['msedge.exe', 'microsoft edge', 'microsoft-edge', 'microsoft-edge-stable'], scheme: 'edge',
    paths: (platform, env) => platform === 'win32' ? win(env, 'Microsoft\\Edge\\Application\\msedge.exe')
      : platform === 'darwin' ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'],
  },
  {
    id: 'brave', name: 'Brave', exeNames: ['brave.exe', 'brave browser', 'brave-browser', 'brave'], scheme: 'brave',
    paths: (platform, env) => platform === 'win32' ? win(env, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe')
      : platform === 'darwin' ? ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser']
      : ['/usr/bin/brave-browser', '/usr/bin/brave'],
  },
]

export const extensionsUrlOf = (id: BrowserId): string => `${KNOWN_BROWSERS.find(k => k.id === id)!.scheme}://extensions`

/** The browser an executable path is, by its base name; undefined for anything else (Firefox, Opera, a shim). */
export function classifyExe(exe: string): BrowserId | undefined {
  const base = exe.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  return KNOWN_BROWSERS.find(k => k.exeNames.includes(base))?.id
}

/**
 * The executables named by `reg query HKLM\SOFTWARE\Clients\StartMenuInternet /s` (and HKCU): every
 * `shell\open\command` value, unquoted, in the order the registry lists them. Tolerant of other value lines.
 */
export function parseStartMenuInternet(text: string): string[] {
  const out: string[] = []
  let inOpenCommand = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (/^HK/i.test(line)) { inOpenCommand = /\\shell\\open\\command$/i.test(line); continue }
    if (!inOpenCommand) continue
    // "    (Default)    REG_SZ    "C:\...\chrome.exe"" — the value name is localized ("(Padrão)"), so it is matched by type.
    const m = /^\s+\S.*?\s+REG_(?:EXPAND_)?SZ\s+(.+)$/.exec(line)
    if (!m) continue
    const value = m[1]!.trim()
    const exe = value.startsWith('"') ? value.slice(1, value.indexOf('"', 1)) : value.split(/\s+/)[0]!
    if (exe && !out.includes(exe)) out.push(exe)
  }
  return out
}

export interface DetectInput {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** Does this path exist as a file. */
  exists(path: string): boolean
  /** The StartMenuInternet registry text (Windows), or ''. */
  registryText?: string
}

/**
 * The browsers found, one per kind, in the picker's order. The registry's path for a kind wins over the known paths
 * (it is what the person's shortcuts launch); a kind absent from both is not offered.
 */
export function detectBrowsers(input: DetectInput): DetectedBrowser[] {
  const found = new Map<BrowserId, string>()
  for (const exe of parseStartMenuInternet(input.registryText ?? '')) {
    const id = classifyExe(exe)
    if (id && !found.has(id) && input.exists(exe)) found.set(id, exe)
  }
  for (const k of KNOWN_BROWSERS) {
    if (found.has(k.id)) continue
    const exe = k.paths(input.platform, input.env).find(p => input.exists(p))
    if (exe) found.set(k.id, exe)
  }
  return KNOWN_BROWSERS.filter(k => found.has(k.id)).map(k => ({ id: k.id, name: k.name, exe: found.get(k.id)!, extensionsUrl: `${k.scheme}://extensions` }))
}

/**
 * The test and development override: `TETHER_WEB_BRIDGE_BROWSERS` names a JSON file with `[{ id, name, exe }]`. With it
 * set, detection is skipped and these are the browsers (an unknown id or a missing exe is dropped). Nothing else reads it.
 */
export function browsersFromOverride(json: string, exists: (p: string) => boolean): DetectedBrowser[] | undefined {
  let list: unknown
  try { list = JSON.parse(json) } catch { return undefined }
  if (!Array.isArray(list)) return undefined
  const out: DetectedBrowser[] = []
  for (const item of list as Partial<DetectedBrowser>[]) {
    const known = KNOWN_BROWSERS.find(k => k.id === item?.id)
    if (!known || typeof item.exe !== 'string' || !exists(item.exe)) continue
    out.push({ id: known.id, name: typeof item.name === 'string' && item.name ? item.name : known.name, exe: item.exe, extensionsUrl: `${known.scheme}://extensions` })
  }
  return out
}

/**
 * The extension's own options page. Chromium browsers ignore chrome:// / edge:// / brave:// URLs given on the
 * command line (the window lands on a New Tab), but chrome-extension:// is honoured when the extension is installed.
 */
export function optionsUrl(extensionId: string): string {
  return `chrome-extension://${extensionId}/options.html`
}
