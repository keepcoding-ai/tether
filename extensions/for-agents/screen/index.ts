// The screen as text (5.4 of the contract): what the conductors and the read-screen verb import.
export { createScreenReaders, MAX_READERS, SCROLLBACK_ROWS, type FetchScreen, type ScreenReaders, type ScreenReadersOptions } from './readers.ts'
export { historyString, readText, screenString, type ScreenText } from './text.ts'
export { createXtermLoader, DEFAULT_VENDOR_DIR, loadXterm, type XtermLoader } from './loader.ts'
