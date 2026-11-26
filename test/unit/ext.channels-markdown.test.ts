// The markdown of a channel message (extensions/channels/renderer/speech-markdown.ts): the pure tree and the plain text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { linkDisguise, linkTip, markdownPlain, markdownTree } from '../../extensions/channels/renderer/speech-markdown.ts'
import type { MdNode } from '../../extensions/channels/renderer/speech-markdown.ts'

// Compact form: el -> "tag[cls]{...}", text -> JSON-ish, code text -> `x`, link -> "a(href){...}".
const show = (nodes: MdNode[]): string => nodes.map((n) => {
  if (n.t === 'text') return n.code ? `\`${n.text}\`` : JSON.stringify(n.text)
  if (n.t === 'br') return 'br'
  if (n.t === 'hr') return 'hr'
  if (n.t === 'link') return `a(${n.href}){${show(n.kids)}}`
  return `${n.tag}${n.cls ? `.${n.cls.replace(/ /g, '.')}` : ''}${n.start !== undefined ? `@${n.start}` : ''}{${show(n.kids)}}`
}).join(' ')
const flat = (nodes: MdNode[]): MdNode[] => nodes.flatMap((n) => [n, ...('kids' in n ? flat(n.kids) : [])])
const anchors = (body: string): number => flat(markdownTree(body)).filter((n) => n.t === 'link').length

test('bold: strong without asterisks', () => {
  assert.equal(show(markdownTree('**Não rastreado (sete itens):**')), 'p{strong{"Não rastreado (sete itens):"}}')
})

test('inline code is a code element with literal text', () => {
  assert.equal(show(markdownTree('veja `knowledge/notes` aqui')), 'p{"veja " code{`knowledge/notes`} " aqui"}')
})

test('lists: numbered (start kept), bullets, nested', () => {
  assert.equal(show(markdownTree('1. a\n2. b')), 'ol{li{"a"} li{"b"}}')
  assert.equal(show(markdownTree('3. a\n4. b')), 'ol@3{li{"a"} li{"b"}}')
  assert.equal(show(markdownTree('- a\n- b')), 'ul{li{"a"} li{"b"}}')
  assert.equal(show(markdownTree('- a\n  - b\n  - c\n- d')), 'ul{li{"a" ul{li{"b"} li{"c"}}} li{"d"}}')
})

test('code blocks, fenced and indented, are pre > code with literal text', () => {
  assert.equal(show(markdownTree('```js\nlet a = **1**\n```')), 'pre{code{`let a = **1**\n`}}')
  assert.equal(show(markdownTree('    indented\n')), 'pre{code{`indented\n`}}')
})

test('heading is a div with classes, never h1-h6', () => {
  const tree = markdownTree('## Título')
  assert.equal(show(tree), 'div.ch-md-h.ch-md-h2{"Título"}')
})

test('blockquote, rule, strikethrough', () => {
  assert.equal(show(markdownTree('> citado')), 'blockquote{p{"citado"}}')
  assert.equal(show(markdownTree('a\n\n---\n\nb')), 'p{"a"} hr p{"b"}')
  assert.equal(show(markdownTree('~~x~~')), 'p{s{"x"}}')
})

test('table sits in div.ch-md-table', () => {
  assert.equal(
    show(markdownTree('| a | b |\n|---|---|\n| 1 | 2 |')),
    'div.ch-md-table{table{thead{tr{th{"a"} th{"b"}}} tbody{tr{td{"1"} td{"2"}}}}}',
  )
})

test('a single Enter is a br', () => {
  assert.equal(show(markdownTree('um\ndois')), 'p{"um" br "dois"}')
})

test('raw HTML stays text and creates no element', () => {
  const tree = markdownTree('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>')
  assert.equal(show(tree), 'p{"<script>alert(1)</script>"} p{"<img src=x onerror=alert(1)>"}')
  assert.deepEqual(flat(tree).filter((n) => n.t === 'el' && n.tag !== 'p'), [])
})

test('links: only http(s) and tether:// become links', () => {
  assert.equal(anchors('[x](javascript:alert(1))'), 0)
  assert.equal(anchors('[x](data:text/html,1)'), 0)
  assert.equal(anchors('[x](file:///c:/a)'), 0)
  assert.equal(anchors('[x](vbscript:a)'), 0)
  assert.equal(anchors('[x](/relativo)'), 0)
  assert.equal(show(markdownTree('[x](javascript:alert(1))')), 'p{"[x](javascript:alert(1))"}')
  assert.equal(show(markdownTree('[x](/relativo)')), 'p{"x"}')
  assert.equal(show(markdownTree('[x](https://a.b/c)')), 'p{a(https://a.b/c){"x"}}')
  assert.equal(show(markdownTree('[x](tether://desk/1)')), 'p{a(tether://desk/1){"x"}}')
  assert.equal(show(markdownTree('veja https://a.b/c')), 'p{"veja " a(https://a.b/c){"https://a.b/c"}}')
})

test('@name inside bold and list items is plain leaf text; inside code it is code text', () => {
  const bold = markdownTree('**@nome**')
  assert.deepEqual(flat(bold).filter((n) => n.t === 'text'), [{ t: 'text', text: '@nome' }])
  const item = markdownTree('- fale com @nome #canal')
  assert.deepEqual(flat(item).filter((n) => n.t === 'text'), [{ t: 'text', text: 'fale com @nome #canal' }])
  const code = markdownTree('`@nome`')
  assert.deepEqual(flat(code).filter((n) => n.t === 'text'), [{ t: 'text', text: '@nome', code: true }])
})

test('image: no img; allowed url gives a link with alt, otherwise just the alt', () => {
  assert.equal(show(markdownTree('![foto](https://a.b/i.png)')), 'p{a(https://a.b/i.png){"foto"}}')
  assert.equal(show(markdownTree('![foto](data:image/png;base64,AAA)')), 'p{"foto"}')
  assert.equal(show(markdownTree('![foto](/local.png)')), 'p{"foto"}')
})

test('markdownPlain drops the marks', () => {
  assert.equal(markdownPlain('**Não rastreado (sete itens):**'), 'Não rastreado (sete itens):')
  assert.equal(markdownPlain('veja `knowledge/notes` e [o site](https://a.b)'), 'veja knowledge/notes e o site')
  assert.equal(markdownPlain('1. a\n2. b\n- c'), 'a\nb\nc')
  assert.equal(markdownPlain('## Título\n\ncorpo\ndois'), 'Título\ncorpo\ndois')
  assert.equal(markdownPlain('```\nx = 1\n```'), 'x = 1')
  assert.equal(markdownPlain('> citado ~~x~~'), 'citado x')
  assert.equal(markdownPlain('| a | b |\n|---|---|\n| 1 | 2 |'), 'a b\n1 2')
})

test('a link whose text spells another address is told apart (tip and confirmation)', () => {
  const evil = 'https://evil.example/x'
  assert.deepEqual(linkDisguise('https://banco.example/login', evil), { shown: 'https://banco.example/login', real: evil }, 'another host, with scheme')
  assert.deepEqual(linkDisguise('banco.example/login', evil), { shown: 'banco.example/login', real: evil }, 'another host, no scheme')
  assert.deepEqual(linkDisguise('http://evil.example/x', evil), { shown: 'http://evil.example/x', real: evil }, 'the same host on another scheme')
  assert.deepEqual(linkDisguise('tether://tab/a', 'tether://tab/b'), undefined, 'the same place (scheme and host)')
  assert.deepEqual(linkDisguise('tether://desk/1', 'https://evil.example'), { shown: 'tether://desk/1', real: 'https://evil.example' })
  assert.equal(linkDisguise('www.x.com', 'http://www.x.com'), undefined, 'linkify of a bare host')
  assert.equal(linkDisguise('https://a.b/c', 'https://a.b/c'), undefined, 'autodetected: the text is the address')
  assert.equal(linkDisguise('HTTPS://A.B/', 'https://a.b/c'), undefined, 'same host, case aside')
  assert.equal(linkDisguise('o site', evil), undefined, 'plain words: no address, only the tip')
  assert.equal(linkDisguise('leia mais em banco.example', evil), undefined, 'a sentence is no address')
})

test('the tip of a markdown link names the real destination unless the text is the address', () => {
  assert.equal(linkTip('o site', 'https://a.b/c'), 'Leva a https://a.b/c')
  assert.equal(linkTip('https://a.b/c', 'https://a.b/c'), undefined)
})
