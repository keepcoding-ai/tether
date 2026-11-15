// The programming ligatures of Fira Code 6.2, used as the ligatures addon's fallback list (the sequences the
// terminal joins into one cell run so the font can draw them as one glyph). Source: the `.liga` glyph names of
// FiraCode-VF.ttf 6.2 (86 sequences) plus the arrow sequences the font builds through its `calt` feature
// (they have no `.liga` glyph of their own), 124 in all. Ordered longest first: the fallback search takes the
// first sequence that matches at a position, so `===` must be tried before `==`.
export const FIRA_CODE_LIGATURES: readonly string[] = [
  '<---->', '<====>', '<--->', '<===>', '--->', '<!--', '<---', '<-->', '<===', '<==>', '<|||', '===>',
  '|||>', '!!.', '!==', '#_(', '***', '+++', '-->', '-<<', '->>', '...', '..<', '..=', '///', '/==', ':::',
  '::=', '<$>', '<*>', '<+>', '<--', '<->', '</>', '<<-', '<<<', '<<=', '<==', '<=>', '<|>', '<||', '<~>',
  '<~~', '=!=', '=/=', '=<<', '===', '==>', '=>>', '>-<', '>>-', '>>=', '>>>', 'www', '||>', '|||', '~~>',
  '!!', '!=', '#!', '#(', '#:', '#=', '#?', '#[', '#_', '#{', '$>', '%%', '&&', '**', '*/', '*>', '++', '+>',
  '--', '-<', '->', '-|', '-~', '..', '.?', '/*', '//', '/=', '/>', '/\\', '::', ':=', ';;', '<$', '<*',
  '<+', '<-', '</', '<<', '<=', '<>', '<|', '<~', '==', '=>', '=|', '>-', '>=', '>>', '?.', '?=', '??', '[|',
  '\\/', ']#', '^=', '{|', '|-', '|=', '|>', '|]', '||', '|}', '~-', '~>', '~@', '~~',
]
