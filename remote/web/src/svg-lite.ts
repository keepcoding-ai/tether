// An icon's text made into elements with no HTML sink. The web page enforces Trusted Types (`require-trusted-types-for
// 'script'; trusted-types 'none'`): `innerHTML`, `DOMParser` and the like throw there. The build (build.mjs) puts this module
// in the place of app/renderer/svg-node.ts, so every icon of the shared screen is built here.
// The text is always the build's own (an imported .svg file, the emblem catalogue, the brand's monogram), never data from
// the house; still, only SVG shapes are created and only presentation attributes are copied: no script, no handler, no link.

const SVG_NS = 'http://www.w3.org/2000/svg'

/** The elements an icon is made of (anything else in the text is skipped, with what it holds). */
const TAGS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'])
/** The attributes copied (names as written in the files). */
const ATTRS = new Set([
  'viewBox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'fill-rule', 'clip-rule',
  'opacity', 'fill-opacity', 'stroke-opacity', 'transform', 'd', 'x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r',
  'x1', 'y1', 'x2', 'y2', 'points',
])

const TAG = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>/g
const ATTR = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

/** Appends the shapes written in `markup` to `parent` (tags the icons do not use are left out). */
export function appendSvg(parent: Element, markup: string): void {
  const stack: Element[] = [parent]
  /** Depth inside an element that was left out: its children are left out with it. */
  let skipped = 0
  TAG.lastIndex = 0
  for (let m = TAG.exec(markup); m; m = TAG.exec(markup)) {
    const closing = m[1] === '/'
    const name = m[2]!
    const selfClosing = m[4] === '/'
    if (closing) {
      if (skipped > 0) skipped--
      else if (stack.length > 1) stack.pop()
      continue
    }
    if (skipped > 0 || !TAGS.has(name)) { if (!selfClosing) skipped++; continue }
    const el = document.createElementNS(SVG_NS, name)
    ATTR.lastIndex = 0
    const attrs = m[3] ?? ''
    for (let a = ATTR.exec(attrs); a; a = ATTR.exec(attrs)) {
      if (ATTRS.has(a[1]!)) el.setAttribute(a[1]!, a[2] ?? a[3] ?? '')
    }
    stack[stack.length - 1]!.append(el)
    if (!selfClosing) stack.push(el)
  }
}

/** The `<svg>` element of a bundled icon's text (the same element app/renderer/svg-node.ts gives the app). */
export function svgNode(text: string): SVGSVGElement {
  const holder = document.createElementNS(SVG_NS, 'g')
  appendSvg(holder, text)
  const svg = holder.firstElementChild
  if (svg instanceof SVGSVGElement) { svg.remove(); return svg }
  // A text that is no icon: an empty one, so the caller's layout holds.
  const empty = document.createElementNS(SVG_NS, 'svg')
  empty.setAttribute('viewBox', '0 0 256 256')
  return empty
}
