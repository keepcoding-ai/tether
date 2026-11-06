// The keybindings screen's channels between its renderer and main sides (the bus `ext:keybindings-screen:<channel>`).
// Reading and watching keybindings.json is the core's (it honours the file with this extension off); only the screen
// writes it. Main validates every argument: they come from the renderer.
export interface KeybindingsScreenChannels {
  invoke: {
    /** Writes the whole text of keybindings.json atomically; the core's watcher reports the change back. */
    write: (text: string) => { ok: true } | { ok: false; message: string }
    /** "Abrir keybindings.json": creates the file with `text` when it does not exist; returns its path. */
    ensure: (text: string) => { ok: true; path: string } | { ok: false; message: string }
  }
}
