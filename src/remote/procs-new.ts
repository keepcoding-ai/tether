// "Novo processo" from afar (RR5 5.5, fio-spec 18): the shape and the ceilings of a recipe of the person's, which the PWA
// and the portal read alike. The checks that need the repo's rules (the command split as the Regency's form splits it, and
// the one rule of what looks like a secret, src/core/redact-args.ts) live with the portal and tetherd, in
// src/remoted/recipe.ts. The three protections of the app (mesa-regencia decisões item 6), and one more of the distance:
//   (a) a variable's value never comes back: the answer is the process as `remoteProc` projects it (env by names only);
//   (b) the value never goes to the audit, a log nor the actId's cache (the cache keeps the projected answer, never a body);
//   (c) a variable whose name or value looks like a secret is REFUSED (`secret-env`, with the names), and so is a command
//       that looks like it carries one (`secret-command`): there is no "create anyway" from afar, and the screen says to put
//       the secret in the command itself (`dotenvx run -- …`).
// Pure: no node:*, no DOM.

/** The process name tetherd accepts (src/daemon/procs.ts PROC_NAME_RE). */
export const PROC_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
/** A variable's name as the form takes it. */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
/** The command line as typed, how many words it splits into, a variable's value, how many variables and ports, a description. */
export const PROC_COMMAND_MAX = 2_000
export const PROC_ARGS_MAX = 128
export const ENV_VALUE_MAX = 4_096
export const ENV_MAX = 32
export const PORTS_MAX = 16
export const PROC_DESCRIPTION_MAX = 200

/** The recipe as tetherd takes it from a `remote` client (`proc-start` with `recipe`), every field there and nothing else. */
export interface RemoteRecipe {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  ports: number[]
  description?: string
}

/** The codes of a refused new process: the secret rules, a name some process has, a folder not of the known list now. */
export const PROC_NEW_ERROR_CODES = ['secret-env', 'secret-command', 'proc-exists', 'unknown-folder'] as const
