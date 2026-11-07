// The `tether` command inside the agents' panes. Claude Code only auto-approves a Bash command that has no unexpanded
// variable and matches an `allowed-tools: Bash(<prefix> *)` rule, so a skill that ran `node "$TETHER_CLI" faults ...`
// prompted at every call; and an absolute path in the skill would not be portable. So every launch that gets a composed
// share folder (src/daemon/share.ts) also gets <share>/bin/, put at the front of the pane's PATH, with two shims that carry
// the absolute path to bin/tether.mjs written at compose time:
//   tether       POSIX sh (Git Bash is what Claude Code runs on Windows):  exec node '<abs>/bin/tether.mjs' "$@"
//   tether.cmd   cmd / PowerShell:                                         node "<abs>\bin\tether.mjs" %*
// The skills then say `tether faults ...` and `allowed-tools: Bash(tether faults *)`. TETHER_CLI stays in the env.
import { chmodSync, mkdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { writeIfChanged } from '../daemon/share.ts'
import { TETHER_CLI_PATH, type LaunchPlan } from './types.ts'

export const SHIM_DIR = 'bin'

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** The contents of the two shims for the CLI script at `cli` (a path, written absolute). */
export function shimScripts(cli: string): { sh: string; cmd: string } {
  const posix = cli.replace(/\\/g, '/')
  const win = cli.replace(/\//g, '\\').replace(/%/g, '%%')
  return {
    sh: `#!/bin/sh\nexec node ${shQuote(posix)} "$@"\n`,
    cmd: `@echo off\r\nnode "${win}" %*\r\n`,
  }
}

/** Writes (or brings up to date) <shareDir>/bin/tether and tether.cmd; returns the folder. */
export function ensureCliShim(shareDir: string, cli: string = TETHER_CLI_PATH): string {
  const dir = join(shareDir, SHIM_DIR)
  mkdirSync(dir, { recursive: true })
  const { sh, cmd } = shimScripts(cli)
  writeIfChanged(join(dir, 'tether'), sh)
  writeIfChanged(join(dir, 'tether.cmd'), cmd)
  try { chmodSync(join(dir, 'tether'), 0o755) } catch { /* a filesystem without modes */ }
  return dir
}

/** `env` (a copy) with `dir` at the front of its PATH, under the key it already has (`Path` on Windows). */
export function withPathFront(env: Record<string, string>, dir: string): Record<string, string> {
  const out = { ...env }
  const key = Object.keys(out).find(k => (process.platform === 'win32' ? k.toUpperCase() : k) === 'PATH') ?? 'PATH'
  const parts = (out[key] ?? '').split(delimiter).filter(p => p && p !== dir)
  out[key] = [dir, ...parts].join(delimiter)
  return out
}

/** `plan` with the shim folder of `shareDir` at the front of the PATH (a copy; the shims written first). */
export function withCliShim(plan: LaunchPlan, shareDir: string): LaunchPlan {
  return { ...plan, env: withPathFront(plan.env, ensureCliShim(shareDir)) }
}
