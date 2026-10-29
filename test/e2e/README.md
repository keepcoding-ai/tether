# E2E harness

`harness.ts` drives a real TUI agent (Claude Code today, soul-cli later) inside a Windows pseudo-terminal
(node-pty + ConPTY). It is agent-agnostic: it takes a `LaunchPlan` (`{ command, args, cwd, env }`) and only
knows how to read a screen and type. Nothing here depends on `src/core` or the adapters.

```ts
const t = await startTerminal({ command: 'claude.exe', args: ['--model', 'haiku'], cwd, env: cleanEnv() }, { log: 'run.jsonl' })
await t.type('responda apenas: ok')   // types, verifies the echo, presses Enter, waits until the line is accepted
await t.waitIdle()                    // answer finished
await t.type('/compact'); await t.waitIdle()
t.screen()                            // visible text, ANSI-free
await t.exit()                        // "/exit" → exit code, t.resumeId from the farewell banner
await t.kill()                        // taskkill /T /F + verify every pid of the tree is gone
```

Helpers: `cleanEnv(extra)` (process.env minus `CLAUDE*`), `tempDir(prefix)`, `processTree(pid)`, `alivePids(pids)`.

**Transports.** `Terminal` reads and types through a `Transport` (`pid`, `write`, `onData`, `onExit`, `kill`,
`dispose`). `LocalPtyTransport` is node-pty in this process (`startTerminal(plan)`); `daemon-driver.ts` has
`DaemonSlotTransport`, which drives a tetherd slot the way the app does: `attach` + `start`, screen fed from the
slot's `data` events, keys sent with `input`, exit = the slot's `state` losing its pid, kill = the daemon's `stop`.
`openSlot(client, slotId, opts)` returns a ready `Terminal`; `SuiteDaemon` spawns a tetherd of its own (unique
home + pipe) and shuts it down. `claude.scenarios.test.ts` proves PRD §5 (C1–C18) through it; `awaitReady(t)`
is the shared startup wait (trust dialog, first idle).

Run: `npm run test:e2e` (one file at a time; never two agents in parallel). `E2E_LOG_DIR=<dir>` keeps a JSONL
log per session: raw PTY chunks (replayable through `Screen`) plus a `mark` line with the full screen at every
harness step (`trust`, `ready`, `type`, `accepted`, `idle`, `kill`, `exit`). When a wait fails, the error message
carries the screen.

## How it works

**Virtual screen.** ConPTY does not forward the app's output; it re-renders it with absolute cursor moves
(`CUP`, `EL`, `ECH`, alt screen). Stripping escapes from the stream therefore gives garbage, so `Screen` is a small
VT emulator (cursor movement, erase, insert/delete, scroll, deferred wrap, alternate screen, OSC title). `screen()`
is its text; after `/exit` it shows the main buffer with `claude --resume <id>`.

**Ready.** Startup waits for either the trust dialog or a line starting with `❯` at column 0 (the input box; dialog
options are indented). The trust dialog resets its selection to "No, exit" about 150 ms after first paint, so the
harness lets it settle, presses Down, and only presses Enter once "Yes, I trust this folder" has stayed highlighted
through a quiet period.

**Idle** (`waitIdle`, default quiet 700 ms) = all of:
- an input box is visible (last line starting with `❯`);
- not busy: no `esc to interrupt` in the status bar, no spinner line (`✽ Doing…`), window title not `◐/◑`;
- the last typed text is no longer in the input box (Claude Code can take > 1 s between Enter and the first
  spinner frame; during that gap the text still sits in the box, so quiet time alone would be a false idle);
- no PTY output for `quietMs`.

**Typing.** Characters go one by one (10 ms apart; a burst can be treated as a paste). `type()` waits for the echo
in the input box, then for a slash command lets the autocomplete menu settle and checks that the highlighted entry
(indented `❯ /name` right above the input box's rule) is the command typed; it throws instead of pressing Enter on
a different one. Observed: a full command name is always highlighted first, and the menu closes as soon as an
argument is typed (`/resume <id>`, `/rename x`). After Enter it waits until the text leaves the box (or the
process exits), so the next `waitIdle` cannot fire early.

**Kill / orphans.** `kill()` snapshots the process tree (`Get-CimInstance Win32_Process`, walked from the PTY child
pid), runs `taskkill /PID <pid> /T /F`, closes the pseudo console and polls `tasklist` until every pid is gone
(15 s grace; `exit()` does the same wait after `/exit`). Process names are useless as a marker on a machine with
other Claude sessions; the tree is the marker. A process is identified by pid **and** creation time (`Proc`):
Windows reuses pids within seconds, and Claude Code keeps spawning short-lived `cmd /c tasklist | findstr`
children, so a pid-only check over a window reports phantom orphans. `aliveProcs()` is the identity check;
`alivePids()` is only the fast poll.

**ConPTY disposal.** node-pty 1.1 keeps its reader thread and pipes open after the child exits, which keeps the
Node process alive forever; its own `kill()` releases them but forks a helper that dies with "AttachConsole failed"
once the console is gone. `dispose()` releases the internals directly (closes the pseudo console, stops the
worker, destroys the sockets with error handlers attached). It runs 1.1 s after exit and inside `kill()`.

## Claude Code quirks worth knowing

- **Fullscreen boot canary.** Claude Code records a fullscreen boot in `~/.claude.json`
  (`fullscreenBootPending`) and marks it healthy 10 s after the first frame. A session killed before that is a
  strike; two strikes set `fullscreenAutoDisabled` and every later session on the machine starts with the inline
  renderer until `/tui fullscreen` (or an update). `kill()` therefore waits until the session has been up 11 s
  (`minUptimeBeforeKill`). A normal `/exit` never counts. The harness works with both renderers.
- Each fresh temp cwd shows the trust dialog and leaves a `projects` entry in `~/.claude.json`.
- `CLAUDE*` variables inherited from a parent Claude Code session stop the child from writing its transcript;
  always launch with `cleanEnv()`.
- Startup takes 4–7 s, a one-word haiku answer about 3 s, `/exit` about 2 s.
