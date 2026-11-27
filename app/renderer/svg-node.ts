// The one place an icon's text becomes an element. The text is always the build's own (an imported .svg file, the brand's
// monogram), never data. The remote web client's build swaps this module for one that builds the same element without an
// HTML sink (remote/web/build.mjs, remote/web/src/svg-lite.ts): its page enforces Trusted Types, where `innerHTML` throws.

/** The `<svg>` element of a bundled icon's text. */
export function svgNode(text: string): SVGSVGElement {
  const tpl = document.createElement('template')
  tpl.innerHTML = text
  return tpl.content.firstElementChild as SVGSVGElement
}
