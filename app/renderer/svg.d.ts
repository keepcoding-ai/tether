// SVG files are imported as strings (esbuild `text` loader in app/build.mjs): the Phosphor icons.
declare module '*.svg' {
  const svg: string
  export default svg
}
