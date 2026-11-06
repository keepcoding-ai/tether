// The markdown preview tab (F5): the GFM rendering (app/shared/markdown-render.ts), what the sanitizer does to hostile
// text, where links and images point (app/shared/markdown-links.ts), the source-line <-> pixel mapping the scroll sync
// uses (app/shared/markdown-scroll.ts), the pane's identity and params (app/shared/preview.ts), and its place in the
// layout, the chord and the commands.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { editorKeyOwner, terminalKeyOwner } from '../../app/renderer/key-capture.ts'
import { emptyLayout, orphanedPanels, planRestore, type Layout } from '../../app/renderer/layout.ts'
import { CommandRegistry, type CommandContext } from '../../app/renderer/commands.ts'
import { appCommands, type CommandHost } from '../../app/renderer/app-commands.ts'
import { paneShortcutOf, shortcutHint, shortcutOf } from '../../app/renderer/shortcuts.ts'
import { classifyLink, fileUrl, isInside, resolveAgainst, resolveImageSource } from '../../app/shared/markdown-links.ts'
import { renderMarkdown, renderMarkdownSync, sanitizeHtml, slugify } from '../../app/shared/markdown-render.ts'
import { lineAtOffset, offsetOfLine, type LineBlock } from '../../app/shared/markdown-scroll.ts'
import { isMarkdownPath, isPreviewPanelId, newPreviewPanelId, previewParams, previewTitle, withPreview } from '../../app/shared/preview.ts'
import { isSlotlessPanelId } from '../../app/shared/empty.ts'
import { noteCommands, withNoteKeybindings } from './note-extension.ts'

// The note's keys come from its extension (extensions/note/manifest.ts), contributed as at the app's startup.
withNoteKeybindings()

const WIN = 'C:\\notes\\proj'
const POSIX = '/home/u/notes'
const render = (text: string, noteDir = WIN): string => renderMarkdownSync(text, { noteDir })

describe('markdown rendering (GFM, the way VS Code shows it)', () => {
  test('tables, strikethrough, task lists and bare links', () => {
    const html = render('| a | b |\n|---|---|\n| 1 | ~~2~~ |\n\n- [ ] open\n- [x] done\n\nsee https://example.com now')
    assert.match(html, /<table[^>]*>/)
    assert.match(html, /<th>a<\/th>/)
    assert.match(html, /<s>2<\/s>/)
    assert.match(html, /<input class="task-list-item-checkbox" type="checkbox" disabled> open/)
    assert.match(html, /<input class="task-list-item-checkbox" type="checkbox" disabled checked> done/)
    assert.match(html, /contains-task-list/)
    assert.doesNotMatch(html, /contains-task-list contains-task-list/)
    assert.match(html, /<a href="https:\/\/example.com">https:\/\/example.com<\/a>/)
  })

  test('headings get the GitHub slug, repeated ones a counter; accents and punctuation as GitHub does', () => {
    const html = render('# Título *um*\n\n## Título *um*\n\n### What\'s up, Doc?\n')
    assert.match(html, /<h1[^>]* id="título-um"/)
    assert.match(html, /<h2[^>]* id="título-um-1"/)
    assert.match(html, /<h3[^>]* id="whats-up-doc"/)
    assert.equal(slugify('  Hello   World '), 'hello-world')
  })

  test('every block carries the source lines it came from (0-based, end exclusive)', () => {
    const html = render('# T\n\npara one\nstill one\n\n```js\nlet a = 1\n```\n\n- x\n- y\n')
    assert.match(html, /<h1 data-line="0" data-line-end="1"/)
    assert.match(html, /<p data-line="2" data-line-end="4"/)
    assert.match(html, /<pre data-line="5" data-line-end="8"/)
    assert.match(html, /<li data-line="10" data-line-end="11"/)
  })

  test('a fenced block is shown plain, or coloured by the host when it offers a highlighter', async () => {
    const plain = render('```ts\nconst a = 1 < 2\n```')
    assert.match(plain, /<code class="language-ts">const a = 1 &lt; 2\n<\/code>/)
    const coloured = await renderMarkdown('```ts\nconst a = 1\n```\n\n```\nno language\n```', {
      noteDir: WIN,
      highlight: async (code, lang) => `<span class="mtk1">${lang}:${code}</span>`,
    })
    assert.match(coloured, /<code class="language-ts"><span class="mtk1">ts:const a = 1<\/span><\/code>/)
    assert.match(coloured, /<code>no language\n<\/code>/, 'a block with no language is not sent to the highlighter')
    const failing = await renderMarkdown('```ts\nx\n```', { noteDir: WIN, highlight: async () => { throw new Error('boom') } })
    assert.match(failing, /<code class="language-ts">x\n<\/code>/, 'a highlighter that fails leaves the block plain')
  })

  test('inline HTML that is harmless survives; details/summary work across markdown blocks', () => {
    const html = render('<details><summary>More</summary>\n\ninside **bold**\n\n</details>\n\ntext <kbd>Ctrl</kbd> and <br> done')
    assert.match(html, /<details><summary>More<\/summary>/)
    assert.match(html, /<strong>bold<\/strong>/)
    assert.match(html, /<\/details>/)
    assert.match(html, /<kbd>Ctrl<\/kbd>/)
  })

  test('elements the document leaves open are closed at the end (the rest of the page cannot be swallowed)', () => {
    const html = render('<div><b>never closed\n\nnext')
    assert.ok(html.trimEnd().endsWith('</b></div>'), html)
  })
})

describe('markdown sanitizing (the text can come from any file)', () => {
  test('script, style, iframe and friends are shown as text, never as elements', () => {
    for (const tag of ['script', 'style', 'iframe', 'object', 'embed', 'form', 'svg', 'math', 'link', 'meta', 'base', 'input', 'textarea']) {
      const html = render(`<${tag} src="x" onload="alert(1)">payload</${tag}>`)
      assert.doesNotMatch(html, new RegExp(`<${tag}[\\s>]`, 'i'), `<${tag}> must not become an element: ${html}`)
      assert.doesNotMatch(html.replace(/<\/?p[^>]*>/g, ''), /</, 'no tag of any kind comes out of a refused one: its source is text')
    }
    assert.match(render('<script>alert(1)</script>'), /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  })

  test('on* handlers, style and unknown attributes are dropped from allowed tags', () => {
    const html = sanitizeHtml('<b onclick="x()" style="position:fixed" class="evil" id="x" data-x="1" title="hi">t</b> <img src="a.png" onerror="alert(1)" onload="alert(2)" alt="pic" style="x">', WIN)
    assert.equal(html, '<b title="hi">t</b> <img src="file:///C:/notes/proj/a.png" alt="pic">')
    for (const evil of ['onclick', 'onerror', 'onload', 'style=', 'class=', 'data-x']) assert.ok(!html.includes(evil), evil)
  })

  test('javascript:, vbscript: and data: URLs never reach an href, however they are disguised', () => {
    const cases = [
      '[x](javascript:alert(1))', '[x](JaVaScRiPt:alert(1))', '[x](vbscript:msgbox(1))', '[x](data:text/html,<script>alert(1)</script>)',
      '<a href="javascript:alert(1)">x</a>', '<a href=" javascript:alert(1)">x</a>', '<a href="jav&#x61;script:alert(1)">x</a>',
      '<a href="java\tscript:alert(1)">x</a>', '<a href="&#106;avascript:alert(1)">x</a>', '<a href="file:///C:/Windows/win.ini">x</a>',
    ]
    for (const c of cases) {
      const html = render(c)
      assert.doesNotMatch(html, /href="[^"]*(javascript|vbscript|data:|file:)/i, `${c} -> ${html}`)
    }
    assert.match(render('<a href="https://ok.example/p?a=1&b=2">x</a>'), /<a href="https:\/\/ok.example\/p\?a=1&amp;b=2">x<\/a>/)
    assert.match(render('<a href="#intro">x</a>'), /<a href="#intro">x<\/a>/)
  })

  test('attribute values cannot break out of their quotes', () => {
    const html = render('<img src="a.png" alt=\'x" onerror="alert(1)\'> <a href="https://a.example/&quot; onmouseover=&quot;x" title="a&quot;b">y</a>')
    // Every quote inside a value is an entity: the tags have exactly the attributes the sanitizer wrote.
    assert.match(html, /<img src="[^"]*" alt="x&quot; onerror=&quot;alert\(1\)">/)
    assert.match(html, /<a href="https:\/\/a.example\/&quot; onmouseover=&quot;x" title="a&quot;b">y<\/a>/)
  })

  test('comments vanish; stray closers and broken tags are text or nothing', () => {
    assert.equal(sanitizeHtml('a<!-- <script> -->b', WIN), 'ab')
    assert.equal(sanitizeHtml('</div>x', WIN), 'x')
    assert.equal(sanitizeHtml('1 < 2 and <b', WIN), '1 &lt; 2 and &lt;b')
    assert.equal(sanitizeHtml('a &amp; b & c', WIN), 'a &amp; b &amp; c')
  })

  test('an image of the document is a data image, a file under the note folder, or an inert placeholder', () => {
    const remote = render('![logo](https://tracker.example/pixel.png)')
    assert.doesNotMatch(remote, /<img/)
    assert.match(remote, /img-blocked/)
    assert.match(remote, />logo</)
    assert.doesNotMatch(render('<img src="//tracker.example/p.png">'), /<img/)
    assert.doesNotMatch(render('![x](file:///C:/Windows/win.ini)'), /<img/)
    assert.doesNotMatch(render('![x](../../secret.png)'), /<img/)
    assert.match(render('![x](img/a%20b.png "T")'), /<img src="file:\/\/\/C:\/notes\/proj\/img\/a%20b.png" alt="x" title="T">/)
    assert.match(render('![x](data:image/png;base64,AAAA)'), /<img src="data:image\/png;base64,AAAA"/)
    assert.doesNotMatch(render('![x](data:image/svg+xml;base64,AAAA)'), /<img/)
  })
})

describe('where links and images point', () => {
  test('classifyLink: browser, anchor, file (with a line), or nothing', () => {
    assert.deepEqual(classifyLink('https://a.example/x', WIN), { kind: 'external', url: 'https://a.example/x' })
    assert.deepEqual(classifyLink('HTTP://a.example', WIN), { kind: 'external', url: 'HTTP://a.example' })
    assert.deepEqual(classifyLink('#Intro%20Dois', WIN), { kind: 'anchor', id: 'Intro Dois' })
    assert.deepEqual(classifyLink('./notes.md', WIN), { kind: 'file', path: 'C:\\notes\\proj\\notes.md' })
    assert.deepEqual(classifyLink('../other/a%20b.md#L12', WIN), { kind: 'file', path: 'C:\\notes\\other\\a b.md', line: 12 })
    assert.deepEqual(classifyLink('src/a.ts#42', POSIX), { kind: 'file', path: '/home/u/notes/src/a.ts', line: 42 })
    assert.deepEqual(classifyLink('/README.md', POSIX), { kind: 'file', path: '/home/u/notes/README.md' }, 'a leading slash is the note folder\'s root')
    assert.deepEqual(classifyLink('mailto:a@b.example', WIN), { kind: 'ignore' })
    assert.deepEqual(classifyLink('javascript:alert(1)', WIN), { kind: 'ignore' })
    assert.deepEqual(classifyLink('file:///C:/x', WIN), { kind: 'ignore' })
    assert.deepEqual(classifyLink('C:\\Windows\\win.ini', WIN), { kind: 'ignore' }, 'a drive path is not a link')
    assert.deepEqual(classifyLink('//host/share/x', WIN), { kind: 'ignore' })
    assert.deepEqual(classifyLink('../../../../x', WIN), { kind: 'ignore' }, 'climbing above the root is nothing')
    assert.deepEqual(classifyLink('', WIN), { kind: 'ignore' })
  })

  test('resolveImageSource stays inside the note folder', () => {
    assert.deepEqual(resolveImageSource('a.png', WIN), { kind: 'ok', src: 'file:///C:/notes/proj/a.png' })
    assert.deepEqual(resolveImageSource('./sub/a b.png?x=1#y', WIN), { kind: 'ok', src: 'file:///C:/notes/proj/sub/a%20b.png' })
    assert.deepEqual(resolveImageSource('sub/../a.png', WIN), { kind: 'ok', src: 'file:///C:/notes/proj/a.png' })
    assert.deepEqual(resolveImageSource('a.png', POSIX), { kind: 'ok', src: 'file:///home/u/notes/a.png' })
    for (const out of ['../a.png', '../proj-other/a.png', '%2e%2e/a.png', '%2E%2E%2Fa.png', 'sub/../../a.png', '/etc/passwd', '\\\\host\\share\\a.png', 'D:\\a.png', 'C:\\Windows\\a.png']) {
      const r = resolveImageSource(out, WIN)
      assert.equal(r.kind, 'blocked', `${out} -> ${JSON.stringify(r)}`)
    }
    assert.deepEqual(resolveImageSource('https://x.example/a.png', WIN), { kind: 'blocked', reason: 'remote' })
    assert.deepEqual(resolveImageSource('//x.example/a.png', WIN), { kind: 'blocked', reason: 'remote' })
    assert.deepEqual(resolveImageSource('javascript:alert(1)', WIN), { kind: 'blocked', reason: 'invalid' })
    assert.equal(resolveImageSource('%zz.png', WIN).kind, 'blocked', 'an undecodable name is refused')
  })

  test('path helpers: separators, case on a drive, siblings that share a prefix', () => {
    assert.equal(resolveAgainst(WIN, 'a/b\\c.md'), 'C:\\notes\\proj\\a\\b\\c.md')
    assert.equal(resolveAgainst('relative/dir', 'x'), undefined)
    assert.ok(isInside('C:\\Notes\\Proj', 'c:\\notes\\proj\\sub\\x'))
    assert.ok(!isInside('C:\\notes\\proj', 'C:\\notes\\proj-other\\x'))
    assert.ok(!isInside('/home/u/Notes', '/home/u/notes/x'), 'posix paths are case-sensitive')
    assert.equal(fileUrl('C:\\a b\\ç.png'), 'file:///C:/a%20b/%C3%A7.png')
  })
})

describe('scroll sync by source line', () => {
  // h1 (line 0), paragraph (2-3), a list (5-8) holding two items (5-6, 6-8)
  const blocks: LineBlock[] = [
    { start: 0, end: 1, top: 0, height: 40 },
    { start: 2, end: 4, top: 60, height: 100 },
    { start: 5, end: 8, top: 180, height: 120 },
    { start: 5, end: 6, top: 180, height: 30 },
    { start: 6, end: 8, top: 210, height: 90 },
  ]

  test('offsetOfLine: inside a block it interpolates by line; the innermost block wins', () => {
    assert.equal(offsetOfLine(blocks, 0), 0)
    assert.equal(offsetOfLine(blocks, 2), 60)
    assert.equal(offsetOfLine(blocks, 3), 110)
    assert.equal(offsetOfLine(blocks, 5), 180)
    assert.equal(offsetOfLine(blocks, 7), 255)
  })

  test('offsetOfLine: a line in the gap between blocks lands between them; past the ends it clamps', () => {
    assert.equal(offsetOfLine(blocks, 1), 40 + (0 / 1) * 20, 'the blank line right after the heading starts at its bottom')
    assert.equal(offsetOfLine(blocks, 4), 160, 'after the paragraph, before the list: the paragraph\'s bottom')
    assert.equal(offsetOfLine(blocks, 50), 300)
    assert.equal(offsetOfLine([], 3), undefined)
  })

  test('lineAtOffset is the inverse inside a block', () => {
    assert.equal(lineAtOffset(blocks, 0), 0)
    assert.equal(lineAtOffset(blocks, 110), 3)
    assert.equal(lineAtOffset(blocks, 255), 7)
    for (const line of [0, 0.5, 2, 2.5, 3.5, 5, 6, 7.5]) {
      const y = offsetOfLine(blocks, line)!
      assert.ok(Math.abs(lineAtOffset(blocks, y)! - line) < 1e-9, `line ${line} -> y ${y} -> ${lineAtOffset(blocks, y)}`)
    }
  })

  test('lineAtOffset: gaps interpolate between the neighbours; past the ends it clamps', () => {
    assert.equal(lineAtOffset(blocks, 50), 1 + (10 / 20) * (2 - 1))
    assert.equal(lineAtOffset(blocks, 10_000), 8)
    assert.equal(lineAtOffset([], 10), undefined)
  })

  test('a document that starts with a gap before the first block', () => {
    const late: LineBlock[] = [{ start: 4, end: 5, top: 80, height: 20 }]
    assert.equal(offsetOfLine(late, 2), 40)
    assert.equal(lineAtOffset(late, 40), 2)
  })
})

describe('preview pane identity, params and place in the layout', () => {
  test('ids carry the preview prefix and never collide with notes or slots', () => {
    const id = newPreviewPanelId(1000, 0.5)
    assert.ok(isPreviewPanelId(id) && !isPreviewPanelId('note:abc') && !isPreviewPanelId('slot-1'))
    assert.ok(newPreviewPanelId(1000, 0.1) < newPreviewPanelId(2000, 0.1))
    assert.ok(isSlotlessPanelId(id))
  })

  test('params: the file, and the scroll line only when it is a sane number', () => {
    assert.deepEqual(previewParams({ preview: { path: 'C:\\a\\b.md', line: 12.5 } }), { path: 'C:\\a\\b.md', line: 12.5 })
    assert.deepEqual(previewParams({ preview: { path: '/a/b.md', line: -1 } }), { path: '/a/b.md' })
    assert.deepEqual(previewParams({ preview: { path: '/a/b.md', line: Number.NaN } }), { path: '/a/b.md' })
    assert.equal(previewParams({ preview: { path: '' } }), undefined)
    assert.equal(previewParams({ note: { path: '/a/b.md' } }), undefined)
    assert.equal(previewParams(undefined), undefined)
    assert.deepEqual(withPreview({ keep: 1 }, { path: '/a/b.md', line: 3 }), { keep: 1, preview: { path: '/a/b.md', line: 3 } })
  })

  test('the tab reads "Prévia: nome.md"; markdown files are the ones with a preview', () => {
    assert.equal(previewTitle('C:\\notes\\proj\\leia-me.md'), 'Prévia: leia-me.md')
    assert.equal(previewTitle('/a/b/c.md'), 'Prévia: c.md')
    for (const p of ['a.md', 'A.MD', 'a.markdown', 'x/y/z.mdx']) assert.ok(isMarkdownPath(p), p)
    for (const p of ['a.txt', 'a.md.bak', 'md', 'a.ts']) assert.ok(!isMarkdownPath(p), p)
  })

  test('a restore never prunes a preview: it has no slot, by design', () => {
    const id = newPreviewPanelId(5, 0.5)
    assert.deepEqual(orphanedPanels([id, 'gone-slot'], new Set(['slot-1'])), ['gone-slot'])
    const layout: Layout = emptyLayout()
    const desk = layout.desks[0]!
    const frame = desk.activeFrame!
    desk.frames.views[frame] = {
      grid: { root: { type: 'branch', data: [{ type: 'leaf', data: { id: 'g1', views: [id, 'gone-slot'], activeView: id } }], size: 800 }, width: 1200, height: 800, orientation: 'HORIZONTAL' },
      panels: { [id]: { id, contentComponent: 'md-preview', tabComponent: 'md-preview-tab', title: 'Prévia: a.md', params: { preview: { path: '/a/a.md' } } }, 'gone-slot': { id: 'gone-slot', contentComponent: 'terminal' } },
      activeGroup: 'g1',
    } as unknown as (typeof desk.frames.views)[string]
    const plan = planRestore(layout, new Set(['slot-1']))
    assert.deepEqual(plan.orphaned, ['gone-slot'])
    const kept = Object.keys(plan.layout!.desks[0]!.frames.views[frame]!.panels)
    assert.deepEqual(kept, [id])
  })
})

describe('Ctrl+Shift+V and the commands', () => {
  const ctrlShiftV = { ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, code: 'KeyV' }

  test('the key is "markdown.preview" in a note only; the editor leaves it to the app; a terminal pastes', () => {
    assert.equal(shortcutOf(ctrlShiftV, false, 'note'), 'markdown.preview')
    assert.deepEqual(editorKeyOwner(ctrlShiftV, false), { owner: 'app', command: 'markdown.preview' })
    assert.equal(paneShortcutOf({ ...ctrlShiftV, type: 'keydown' }, false, false), 'paste', 'the terminal\'s own pane shortcut is decided before the app\'s')
    assert.equal(shortcutHint('markdown.preview', false), 'Ctrl+Shift+V')
    assert.equal(shortcutHint('markdown.preview.side', false), 'Ctrl+K V')
    assert.equal(shortcutOf({ ...ctrlShiftV, ctrlKey: false, metaKey: true }, true, 'note'), 'markdown.preview')
    assert.equal(terminalKeyOwner(ctrlShiftV, false).owner, 'terminal', 'in a terminal the key is the pane\'s paste (the binding is note-only)')
  })

  const calls: string[] = []
  const host = new Proxy({}, { get: (_t, name) => (...args: unknown[]) => { calls.push(`${String(name)}(${args.join(',')})`) } }) as CommandHost
  const ctx = (markdown?: 'note' | 'preview'): CommandContext => ({ pane: true, desks: 1, drawerOpen: false, focus: 'editor', flags: new Set(markdown ? [`markdown.${markdown}`] : []) })

  test('the preview commands exist with the titles of the palette and appear only where they apply', async () => {
    const registry = new CommandRegistry(() => ctx('note'))
    registry.register(...appCommands(host), ...noteCommands(id => calls.push(id)))
    const open = registry.get('markdown.preview')!
    const side = registry.get('markdown.preview.side')!
    const source = registry.get('markdown.source')!
    assert.equal(open.title, 'Prévia: abrir')
    assert.equal(side.title, 'Prévia: abrir ao lado')
    assert.equal(registry.hint(side, false), 'Ctrl+K V', 'the two-key chord of VS Code')
    assert.equal(registry.hint(open, false), 'Ctrl+Shift+V')
    assert.ok(open.keepKeyWhenUnavailable, 'Ctrl+Shift+V keeps pasting where there is nothing to preview')
    assert.ok(registry.isAvailable(open, ctx('note')) && registry.isAvailable(side, ctx('note')))
    assert.ok(!registry.isAvailable(open, ctx()) && !registry.isAvailable(side, ctx()), 'not on a terminal, an empty pane or a note that is not markdown')
    assert.ok(!registry.isAvailable(open, ctx('preview')))
    assert.ok(registry.isAvailable(source, ctx('preview')) && !registry.isAvailable(source, ctx('note')))
    calls.length = 0
    assert.equal(await registry.run('markdown.preview', 'key'), 'ran')
    assert.equal(await registry.run('markdown.preview.side', 'palette'), 'ran')
    assert.deepEqual(calls, ['markdown.preview', 'markdown.preview.side'])
  })
})
