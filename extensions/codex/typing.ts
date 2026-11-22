// How text is typed into a Codex pane. Codex reads the console as key events, and the ConPTY turns UTF-8 input into them by
// the keyboard layout: a character that is not on the layout (`·`, `«`, `¿`, `—`, `€`) arrives as nothing (measured on Codex
// 0.169.0, pt-BR layout). Pure: no state, no I/O.
import { ENTER, PASTE_END, PASTE_START, type Typing, type TypingChunk } from '../../src/daemon/door/typing.ts'

/** Codex 0.169 takes text and an Enter less than ~170 ms apart as one paste and does not submit (130 and 150 ms fail). */
export const CODEX_ENTER_DELAY_MS = 300
/** After a bracketed paste Codex needs a longer wait before the Enter. */
export const CODEX_PASTE_ENTER_DELAY_MS = 400

/**
 * Every non-ASCII UTF-16 unit goes as a win32-input-mode key press (`CSI Vk;Sc;Uc;Kd;Cs;Rc _`, Vk and Sc 0), which carries the
 * character itself. ASCII stays raw.
 */
export function winKeyEvents(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    out += unit < 0x80 ? text[i] : `\x1b[0;0;${unit};1;0;1_`
  }
  return out
}

/** The text as the terminal must receive it: key events on Windows, the raw text elsewhere. */
export function codexKeyText(text: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? winKeyEvents(text) : text
}

/** The Codex typing: one line is text, 300 ms, Enter; several lines are a bracketed paste, 400 ms, Enter. */
export function codexTyping(platform: NodeJS.Platform = process.platform): Typing {
  return {
    submit(text: string): TypingChunk[] {
      const lines = text.replace(/\r\n?/g, '\n').split('\n')
      if (lines.length === 1) return [{ data: codexKeyText(lines[0]!, platform) }, { data: ENTER, waitMs: CODEX_ENTER_DELAY_MS }]
      return [{ data: `${PASTE_START}${codexKeyText(lines.join('\r'), platform)}${PASTE_END}` }, { data: ENTER, waitMs: CODEX_PASTE_ENTER_DELAY_MS }]
    },
  }
}
