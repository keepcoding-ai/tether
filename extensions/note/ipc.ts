// The note extension's channels between its renderer and main sides (the bus `ext:note:<channel>`,
// app/shared/ext-ipc.ts). They replace the bespoke `note:*` and `htmlpreview:*` channels of the core. Main validates
// every argument: they come from the renderer.
import type { ImageRead, NotePrepared, NoteRead, NoteRenamed, NoteWritten, PreviewKey, PreviewReport } from '../../app/shared/api.ts'

export interface NoteChannels {
  invoke: {
    /**
     * Creates the empty file of a new note: without a destination, under the pane's folder (`<cwd>/.tether/notes/`) or
     * the person's; with one, `project` (`<cwd>/.tether/notes/`), `home` ("Minhas notas") or `other` (`cwd` itself),
     * remembered for the next time.
     */
    prepare: (paneCwd?: string, destination?: 'project' | 'home' | 'other') => NotePrepared
    /** The destination the chooser starts on (the last one used) and a warning when it could not be kept. */
    destination: () => { id: 'project' | 'home' | 'other'; folder?: string; warning?: string }
    /** The folder of "Minhas notas" (the setting, or `~/.tether/notes`). */
    personalFolder: () => string
    read: (path: string) => NoteRead
    /** The bytes of an image file (the viewer draws them from a blob); main refuses any other extension and files above 100 MB. */
    readImage: (path: string) => ImageRead
    /** Atomic write. */
    write: (path: string, text: string) => NoteWritten
    rename: (from: string, to: string) => NoteRenamed
    /** The OS file dialogs. */
    pickOpen: (initialDir?: string) => string | null
    pickSaveAs: (currentPath: string) => string | null
    /** A repository's `.gitignore` gets `.tether/` (`add`), or the question is not asked again for it. */
    gitignore: (repoRoot: string, add: boolean) => void
    /** "Abrir no navegador": an existing .html file with the system's program. */
    openInBrowser: (path: string) => { ok: true } | { ok: false; message: string }
  }
  send: {
    /** The fire-and-forget write of a page going away (beforeunload cannot await). */
    flush: (path: string, text: string) => void
    watch: (path: string) => void
    unwatch: (path: string) => void
  }
  events: {
    /** A watched file changed on disk (our own save included: the renderer compares). */
    changed: (path: string) => void
    /** What an HTML preview's page loaded from its folder and what the policy refused. */
    htmlReport: (report: PreviewReport) => void
    /** A chord pressed inside an HTML preview's page, to be replayed on the pane. */
    htmlKey: (key: PreviewKey) => void
  }
}

