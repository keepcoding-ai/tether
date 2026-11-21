// How a text is typed into an agent's terminal and submitted (contract 4.4). The bytes belong to the engine, so an agent
// contribution may bring its own `typing`; this is the core's default and the builder the contributions use.
// - One line: the text, then Enter (`\r`) in a SEPARATE write after a wait. Claude Code takes a burst that ends in CR as a
//   paste and does not submit a long one; Codex needs the wait (it takes text and CR arriving within ~150 ms as one paste).
// - Several lines: a bracketed paste (`ESC[200~ ... ESC[201~`, lines joined with CR as a terminal pastes them), then the
//   wait, then `\r`. Claude Code shows it as `[Pasted text #1 +N lines]` and the model gets it as `<pasted_content>`; Soul and
//   Codex take it whole.
// Proven waits (probes of 21/11): Claude Code and Soul submit with 150 ms (and less); Codex 0.169 fails at 130 and 150 ms
// and submits from 170 ms, so its contribution says 300 ms.
// Pure: no state, no I/O.
import type { AgentContribution } from '../../agents/registry.ts'

export interface TypingChunk { data: string; waitMs?: number }
export interface Typing { submit(text: string): TypingChunk[] }

export const PASTE_START = '\x1b[200~'
export const PASTE_END = '\x1b[201~'
export const ENTER = '\r'
export const DEFAULT_ENTER_DELAY_MS = 150

/** A typing that writes the text (pasted in brackets when it has several lines) and, `enterDelayMs` later, Enter. */
export function typingWith(opts: { enterDelayMs: number }): Typing {
  return {
    submit(text: string): TypingChunk[] {
      const lines = text.replace(/\r\n?/g, '\n').split('\n')
      const data = lines.length > 1 ? `${PASTE_START}${lines.join('\r')}${PASTE_END}` : lines[0]!
      return [{ data }, { data: ENTER, waitMs: opts.enterDelayMs }]
    },
  }
}

/** The core's default: text, 150 ms, Enter. */
export const defaultTyping: Typing = typingWith({ enterDelayMs: DEFAULT_ENTER_DELAY_MS })

/** The agent's own typing, or the core's default. */
export function typingOf(agent: Pick<AgentContribution, 'typing'> | undefined): Typing {
  return agent?.typing ?? defaultTyping
}
