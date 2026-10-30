// macOS line-editing shortcuts for the terminals: the keys a Mac user expects in a text field, translated to the
// control sequences a readline-style prompt (zsh, bash, Claude Code) understands. Explicit mapping instead of
// xterm's macOptionIsMeta: Option must keep composing accented characters on ABNT2 keyboards.

export interface KeyLike {
  key: string
  code: string
  metaKey: boolean
  altKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
}

/** The bytes to send to the pty for this keydown, or undefined when it is not a line-editing shortcut. */
export function lineEditSequence(ev: KeyLike, isMac: boolean): string | undefined {
  if (!isMac || ev.ctrlKey) return undefined
  const { metaKey: meta, altKey: alt, shiftKey: shift } = ev
  if (ev.key === 'Enter') return shift && !meta && !alt ? '\x1b\r' : undefined // newline without submitting (Claude Code)
  if (shift) return undefined
  if (meta && !alt) {
    switch (ev.key) {
      case 'ArrowLeft': return '\x01' // Ctrl+A: start of line
      case 'ArrowRight': return '\x05' // Ctrl+E: end of line
      case 'Backspace': return '\x15' // Ctrl+U: delete to start of line
    }
  }
  if (alt && !meta) {
    switch (ev.key) {
      case 'ArrowLeft': return '\x1bb' // Meta+b: previous word
      case 'ArrowRight': return '\x1bf' // Meta+f: next word
      case 'Backspace': return '\x17' // Ctrl+W: delete word
    }
  }
  return undefined
}
