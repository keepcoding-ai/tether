// Which `ext:<id>` a page may claim when it reports a fault (app/main/faults-main.ts): the extensions this app really has.
// Main and daemon know theirs from their indexes; these are the ones with a renderer entry only. A unit test
// (test/unit/core.faults-limits.test.ts) keeps the list equal to what extensions/index.renderer.ts has beyond the other two.
export const RENDERER_ONLY_EXTENSION_IDS: readonly string[] = ['frame-pads', 'settings-screen']
