// Color environment for every agent PTY (claude, soul, shell). The terminal is xterm.js, which renders truecolor,
// but the daemon inherits whatever environment launched it: NO_COLOR / FORCE_COLOR=0 / TERM=dumb make Claude Code
// print monochrome. On Windows node-pty's `name` option does not become $TERM, so it must be set here.
// Call this on the inherited environment BEFORE the launch profile's env is merged: the profile wins.

/** Mutates and returns `env`: drops the "no color" switches, defaults TERM and COLORTERM. */
export function withColorSupport(env: Record<string, string>): Record<string, string> {
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'NO_COLOR') delete env[k]
  if (env.FORCE_COLOR === '0' || env.FORCE_COLOR === 'false') delete env.FORCE_COLOR
  if (!env.TERM || env.TERM === 'dumb') env.TERM = 'xterm-256color'
  if (!env.COLORTERM) env.COLORTERM = 'truecolor'
  return env
}
