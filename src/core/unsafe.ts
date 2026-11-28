// Pure module (no node imports): both the daemon and the renderer decide the "sem restrições" badge from this list.

/** Flags that make an agent act without asking for confirmation, per agent CLI. */
export const UNSAFE_ARGS: readonly string[] = [
  '--dangerously-skip-permissions', // claude
  '--dangerously-bypass-approvals-and-sandbox', // codex
  '--yolo', // codex alias of the flag above
  '--permission-mode=bypassPermissions', // soul (the same flag with its value joined)
]

/** `--permission-mode <value>`: the soul's bypass as two arguments. */
const MODE_FLAG = '--permission-mode'
const BYPASS_MODE = 'bypassPermissions'

/** The launch skips the agent's permission prompts: the UI shows a badge for it. */
export function isUnsafe(args: readonly string[]): boolean {
  return args.some((a, i) => UNSAFE_ARGS.includes(a) || (a === MODE_FLAG && args[i + 1] === BYPASS_MODE))
}

/** One argument is an unsafe flag (the args editor highlights it). */
export function isUnsafeArg(arg: string): boolean {
  return UNSAFE_ARGS.includes(arg)
}
