// monaco-editor ships no typings for its base actions (esm/vs/base/common/actions.js). Only what app/renderer/monaco-links.ts
// builds the rows of the note editor's context menu with is declared.
declare module 'monaco-editor/base/common/actions.js' {
  export class Action {
    constructor(id: string, label?: string, cssClass?: string, enabled?: boolean, actionCallback?: (event?: unknown) => unknown)
  }
  export class Separator {}
}
