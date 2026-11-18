// Pure module (no node imports): both the daemon and the renderer decide the "sem restrições" badge from this list.

/** Flags that make an agent act without asking for confirmation, per agent CLI. */
export const UNSAFE_ARGS: readonly string[] = [
  '--dangerously-skip-permissions', // claude
  '--dangerously-bypass-approvals-and-sandbox', // codex
  '--yolo', // codex alias of the flag above
]

/** The launch skips the agent's permission prompts: the UI shows a badge for it. */
export function isUnsafe(args: readonly string[]): boolean {
  return args.some(a => UNSAFE_ARGS.includes(a))
}

/** One argument is an unsafe flag (the args editor highlights it). */
export function isUnsafeArg(arg: string): boolean {
  return UNSAFE_ARGS.includes(arg)
}
