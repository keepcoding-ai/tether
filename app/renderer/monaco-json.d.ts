// monaco-editor 0.57 ships no typings for its JSON language service entry (esm/vs/language/json/monaco.contribution.js, mapped
// by the package exports). Only what app/renderer/monaco.ts calls is declared: the diagnostics options of the service.
declare module 'monaco-editor/language/json/monaco.contribution.js' {
  export interface JsonDiagnosticsOptions {
    validate?: boolean
    allowComments?: boolean
    trailingCommas?: 'error' | 'warning' | 'ignore'
    schemaValidation?: 'error' | 'warning' | 'ignore'
    schemas?: { uri: string; fileMatch?: string[]; schema?: object }[]
  }
  export const jsonDefaults: { setDiagnosticsOptions(options: JsonDiagnosticsOptions): void }
}
