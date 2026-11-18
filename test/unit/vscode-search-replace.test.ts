// Tests ported from VS Code (commit 9cc2376778e119f759ff710c1238fdc58d402d7a):
//   src/vs/workbench/services/search/test/common/replace.test.ts
//   src/vs/editor/contrib/find/test/browser/replacePattern.test.ts  (includes the buildReplaceStringWithCasePreserved cases;
//     base/test/common/search.test.ts does not exist at that commit)
// plus extra preserve-case cases for hyphens and underscores.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
	buildReplaceStringWithCasePreserved,
	parseReplaceString,
	PieceReplacePattern,
	ReplacePattern,
	ReplacePiece,
} from '../../app/shared/vscode-search-replace.ts';

describe('ReplacePattern (search)', () => {

	test('parse replace string', () => {
		const testParse = (input: string, expected: string, expectedHasParameters: boolean) => {
			let actual = new ReplacePattern(input, { pattern: 'somepattern', isRegExp: true });
			assert.strictEqual(expected, actual.pattern);
			assert.strictEqual(expectedHasParameters, actual.hasParameters);
			actual = new ReplacePattern('hello' + input + 'hi', { pattern: 'sonepattern', isRegExp: true });
			assert.strictEqual('hello' + expected + 'hi', actual.pattern);
			assert.strictEqual(expectedHasParameters, actual.hasParameters);
		};

		testParse('hello', 'hello', false);
		testParse('\\thello', '\thello', false);
		testParse('\\nhello', '\nhello', false);
		testParse('\\\\thello', '\\thello', false);
		testParse('\\\\\\thello', '\\\thello', false);
		testParse('\\\\\\\\thello', '\\\\thello', false);
		testParse('hello\\', 'hello\\', false);
		testParse('hello\\x', 'hello\\x', false);
		testParse('hello\\0', 'hello\\0', false);
		testParse('hello$1', 'hello$1', true);
		testParse('hello$2', 'hello$2', true);
		testParse('hello$12', 'hello$12', true);
		testParse('hello$99', 'hello$99', true);
		testParse('hello$99a', 'hello$99a', true);
		testParse('hello$100', 'hello$100', false);
		testParse('hello$100a', 'hello$100a', false);
		testParse('hello$10a0', 'hello$10a0', true);
		testParse('hello$$', 'hello$$', false);
		testParse('hello$$0', 'hello$$0', false);
		testParse('hello$0', 'hello$&', true);
		testParse('hello$02', 'hello$&2', true);
		testParse('hello$`', 'hello$`', true);
		testParse('hello$\'', 'hello$\'', true);
	});

	test('create pattern by passing regExp', () => {
		let expected = /abc/;
		let actual = new ReplacePattern('hello', false, expected).regExp;
		assert.deepStrictEqual(actual, expected);

		expected = /abc/;
		actual = new ReplacePattern('hello', false, /abc/g).regExp;
		assert.deepStrictEqual(actual, expected);

		let testObject = new ReplacePattern('hello$0', false, /abc/g);
		assert.strictEqual(testObject.hasParameters, false);

		testObject = new ReplacePattern('hello$0', true, /abc/g);
		assert.strictEqual(testObject.hasParameters, true);
	});

	test('get replace string if given text is a complete match', () => {
		let testObject = new ReplacePattern('hello', { pattern: 'bla', isRegExp: true });
		let actual = testObject.getReplaceString('bla');
		assert.strictEqual(actual, 'hello');

		testObject = new ReplacePattern('hello', { pattern: 'bla', isRegExp: false });
		actual = testObject.getReplaceString('bla');
		assert.strictEqual(actual, 'hello');

		testObject = new ReplacePattern('hello', { pattern: '(bla)', isRegExp: true });
		actual = testObject.getReplaceString('bla');
		assert.strictEqual(actual, 'hello');

		testObject = new ReplacePattern('hello$0', { pattern: '(bla)', isRegExp: true });
		actual = testObject.getReplaceString('bla');
		assert.strictEqual(actual, 'hellobla');

		const requirePattern = 'let\\s+(\\w+)\\s*=\\s*require\\s*\\(\\s*[\'"]([\\w.\\-/]+)\\s*[\'"]\\s*\\)\\s*';
		testObject = new ReplacePattern('import * as $1 from \'$2\';', { pattern: requirePattern, isRegExp: true });
		actual = testObject.getReplaceString('let fs = require(\'fs\')');
		assert.strictEqual(actual, 'import * as fs from \'fs\';');
		actual = testObject.getReplaceString('let something = require(\'fs\')');
		assert.strictEqual(actual, 'import * as something from \'fs\';');
		actual = testObject.getReplaceString('let require(\'fs\')');
		assert.strictEqual(actual, null);

		testObject = new ReplacePattern('import * as $1 from \'$1\';', { pattern: requirePattern, isRegExp: true });
		actual = testObject.getReplaceString('let something = require(\'fs\')');
		assert.strictEqual(actual, 'import * as something from \'something\';');

		testObject = new ReplacePattern('import * as $2 from \'$1\';', { pattern: requirePattern, isRegExp: true });
		actual = testObject.getReplaceString('let something = require(\'fs\')');
		assert.strictEqual(actual, 'import * as fs from \'something\';');

		testObject = new ReplacePattern('import * as $0 from \'$0\';', { pattern: requirePattern, isRegExp: true });
		actual = testObject.getReplaceString('let something = require(\'fs\');');
		assert.strictEqual(actual, 'import * as let something = require(\'fs\') from \'let something = require(\'fs\')\';');

		testObject = new ReplacePattern('import * as $1 from \'$2\';', { pattern: requirePattern, isRegExp: false });
		actual = testObject.getReplaceString('let fs = require(\'fs\');');
		assert.strictEqual(actual, null);

		testObject = new ReplacePattern('cat$1', { pattern: 'for(.*)', isRegExp: true });
		actual = testObject.getReplaceString('for ()');
		assert.strictEqual(actual, 'cat ()');
	});

	test('case operations', () => {
		const testObject = new ReplacePattern('a\\u$1l\\u\\l\\U$2M$3n', { pattern: 'a(l)l(good)m(e)n', isRegExp: true });
		const actual = testObject.getReplaceString('allgoodmen');
		assert.strictEqual(actual, 'aLlGoODMen');
	});

	test('case operations - no false positive', () => {
		let testObject = new ReplacePattern('\\left $1', { pattern: '(pattern)', isRegExp: true });
		let actual = testObject.getReplaceString('pattern');
		assert.strictEqual(actual, '\\left pattern');

		testObject = new ReplacePattern('\\hi \\left $1', { pattern: '(pattern)', isRegExp: true });
		actual = testObject.getReplaceString('pattern');
		assert.strictEqual(actual, '\\hi \\left pattern');

		testObject = new ReplacePattern('\\left \\L$1', { pattern: 'PATT(ERN)', isRegExp: true });
		actual = testObject.getReplaceString('PATTERN');
		assert.strictEqual(actual, '\\left ern');
	});

	test('case operations and newline', () => {
		const testObject = new ReplacePattern('$1\n\\U$2', { pattern: '(multi)(line)', isRegExp: true });
		const actual = testObject.getReplaceString('multiline');
		assert.strictEqual(actual, 'multi\nLINE');
	});

	test('get replace string for no matches', () => {
		let testObject = new ReplacePattern('hello', { pattern: 'bla', isRegExp: true });
		let actual = testObject.getReplaceString('foo');
		assert.strictEqual(actual, null);

		testObject = new ReplacePattern('hello', { pattern: 'bla', isRegExp: false });
		actual = testObject.getReplaceString('foo');
		assert.strictEqual(actual, null);
	});

	test('get replace string if match is sub-string of the text', () => {
		const text = 'this is a bla text';
		const check = (replace: string, pattern: string, expected: string) => {
			const testObject = new ReplacePattern(replace, { pattern, isRegExp: true });
			assert.strictEqual(testObject.getReplaceString(text), expected, `${pattern} -> ${replace}`);
		};
		check('hello', 'bla', 'hello');
		check('that', 'this(?=.*bla)', 'that');
		check('$1at', '(th)is(?=.*bla)', 'that');
		check('$1e', '(th)is(?=.*bla)', 'the');
		check('$1ere', '(th)is(?=.*bla)', 'there');
		check('$1', '(th)is(?=.*bla)', 'th');
		check('ma$1', '(th)is(?=.*bla)', 'math');
		check('ma$1s', '(th)is(?=.*bla)', 'maths');
		check('$0', '(th)is(?=.*bla)', 'this');
		check('$0$1', '(th)is(?=.*bla)', 'thisth');
		check('foo', 'bla(?=\\stext$)', 'foo');
		check('f$1', 'b(la)(?=\\stext$)', 'fla');
		check('f$0', 'b(la)(?=\\stext$)', 'fbla');
		check('$0ah', 'b(la)(?=\\stext$)', 'blaah');

		let testObject = new ReplacePattern('newrege$1', true, /Testrege(\w*)/);
		assert.strictEqual(testObject.getReplaceString('Testregex', true), 'Newregex');

		testObject = new ReplacePattern('newrege$1', true, /TESTREGE(\w*)/);
		assert.strictEqual(testObject.getReplaceString('TESTREGEX', true), 'NEWREGEX');

		testObject = new ReplacePattern('new_rege$1', true, /Test_Rege(\w*)/);
		assert.strictEqual(testObject.getReplaceString('Test_Regex', true), 'New_Regex');

		testObject = new ReplacePattern('new-rege$1', true, /Test-Rege(\w*)/);
		assert.strictEqual(testObject.getReplaceString('Test-Regex', true), 'New-Regex');
	});

	test('search options build the regexp (non-regex, case, whole word, multiline)', () => {
		const literal = new ReplacePattern('x', { pattern: 'a.c' });
		assert.strictEqual(literal.getReplaceString('abc'), null);
		assert.strictEqual(literal.getReplaceString('A.C'), 'x');
		assert.strictEqual(new ReplacePattern('x', { pattern: 'a.c', isCaseSensitive: true }).getReplaceString('A.C'), null);
		const word = new ReplacePattern('x', { pattern: 'cat', isWordMatch: true });
		assert.strictEqual(word.getReplaceString('concatenate'), null);
		assert.strictEqual(word.getReplaceString('a cat'), 'x');
		assert.ok(new ReplacePattern('x', { pattern: '^b', isRegExp: true, isMultiline: true }).regExp.multiline);
		assert.throws(() => new ReplacePattern('x', { pattern: '' }));
	});
});

describe('parseReplaceString (editor)', () => {
	const testParse = (input: string, expectedPieces: ReplacePiece[]) => {
		assert.deepStrictEqual(parseReplaceString(input), new PieceReplacePattern(expectedPieces), 'Parsing ' + input);
	};

	function assertReplace(target: string, search: RegExp, replaceString: string, expected: string): void {
		const replacePattern = parseReplaceString(replaceString);
		const m = search.exec(target);
		const actual = replacePattern.buildReplaceString(m);
		assert.strictEqual(actual, expected, `${target}.replace(${search}, ${replaceString}) === ${expected}`);
	}

	test('parse replace string', () => {
		testParse('hello', [ReplacePiece.staticValue('hello')]);
		testParse('\\thello', [ReplacePiece.staticValue('\thello')]);
		testParse('h\\tello', [ReplacePiece.staticValue('h\tello')]);
		testParse('hello\\t', [ReplacePiece.staticValue('hello\t')]);
		testParse('\\nhello', [ReplacePiece.staticValue('\nhello')]);
		testParse('\\\\thello', [ReplacePiece.staticValue('\\thello')]);
		testParse('h\\\\tello', [ReplacePiece.staticValue('h\\tello')]);
		testParse('hello\\\\t', [ReplacePiece.staticValue('hello\\t')]);
		testParse('\\\\\\thello', [ReplacePiece.staticValue('\\\thello')]);
		testParse('\\\\\\\\thello', [ReplacePiece.staticValue('\\\\thello')]);
		testParse('hello\\', [ReplacePiece.staticValue('hello\\')]);
		testParse('hello\\x', [ReplacePiece.staticValue('hello\\x')]);
		testParse('hello\\0', [ReplacePiece.staticValue('hello\\0')]);
		testParse('hello$&', [ReplacePiece.staticValue('hello'), ReplacePiece.matchIndex(0)]);
		testParse('hello$0', [ReplacePiece.staticValue('hello'), ReplacePiece.matchIndex(0)]);
		testParse('hello$02', [ReplacePiece.staticValue('hello'), ReplacePiece.matchIndex(0), ReplacePiece.staticValue('2')]);
		testParse('hello$1', [ReplacePiece.staticValue('hello'), ReplacePiece.matchIndex(1)]);
		testParse('hello$2', [ReplacePiece.staticValue('hello'), ReplacePiece.matchIndex(2)]);
		testParse('hello$9', [ReplacePiece.staticValue('hello'), ReplacePiece.matchIndex(9)]);
		testParse('$9hello', [ReplacePiece.matchIndex(9), ReplacePiece.staticValue('hello')]);
		testParse('hello$12', [ReplacePiece.staticValue('hello'), ReplacePiece.matchIndex(12)]);
		testParse('hello$99', [ReplacePiece.staticValue('hello'), ReplacePiece.matchIndex(99)]);
		testParse('hello$99a', [ReplacePiece.staticValue('hello'), ReplacePiece.matchIndex(99), ReplacePiece.staticValue('a')]);
		testParse('hello$1a', [ReplacePiece.staticValue('hello'), ReplacePiece.matchIndex(1), ReplacePiece.staticValue('a')]);
		testParse('hello$100', [ReplacePiece.staticValue('hello'), ReplacePiece.matchIndex(10), ReplacePiece.staticValue('0')]);
		testParse('hello$100a', [ReplacePiece.staticValue('hello'), ReplacePiece.matchIndex(10), ReplacePiece.staticValue('0a')]);
		testParse('hello$10a0', [ReplacePiece.staticValue('hello'), ReplacePiece.matchIndex(10), ReplacePiece.staticValue('a0')]);
		testParse('hello$$', [ReplacePiece.staticValue('hello$')]);
		testParse('hello$$0', [ReplacePiece.staticValue('hello$0')]);
		testParse('hello$`', [ReplacePiece.staticValue('hello$`')]);
		testParse('hello$\'', [ReplacePiece.staticValue('hello$\'')]);
	});

	test('parse replace string with case modifiers', () => {
		testParse('hello\\U$1', [ReplacePiece.staticValue('hello'), ReplacePiece.caseOps(1, ['U'])]);
		assertReplace('func privateFunc(', /func (\w+)\(/, 'func \\U$1(', 'func PRIVATEFUNC(');

		testParse('hello\\u$1', [ReplacePiece.staticValue('hello'), ReplacePiece.caseOps(1, ['u'])]);
		assertReplace('func privateFunc(', /func (\w+)\(/, 'func \\u$1(', 'func PrivateFunc(');

		testParse('hello\\L$1', [ReplacePiece.staticValue('hello'), ReplacePiece.caseOps(1, ['L'])]);
		assertReplace('func privateFunc(', /func (\w+)\(/, 'func \\L$1(', 'func privatefunc(');

		testParse('hello\\l$1', [ReplacePiece.staticValue('hello'), ReplacePiece.caseOps(1, ['l'])]);
		assertReplace('func PrivateFunc(', /func (\w+)\(/, 'func \\l$1(', 'func privateFunc(');

		testParse('hello$1\\u\\u\\U$4goodbye', [ReplacePiece.staticValue('hello'), ReplacePiece.matchIndex(1), ReplacePiece.caseOps(4, ['u', 'u', 'U']), ReplacePiece.staticValue('goodbye')]);
		assertReplace('hellogooDbye', /hello(\w+)/, 'hello\\u\\u\\l\\l\\U$1', 'helloGOodBYE');
	});

	test('replace has JavaScript semantics', () => {
		const js = (target: string, search: RegExp, replaceString: string, expected: string) => {
			const m = search.exec(target);
			assert.deepStrictEqual(parseReplaceString(replaceString).buildReplaceString(m), expected, `${target}.replace(${search}, ${replaceString})`);
		};

		js('hi', /hi/, 'hello', 'hi'.replace(/hi/, 'hello'));
		js('hi', /hi/, '\\t', 'hi'.replace(/hi/, '\t'));
		js('hi', /hi/, '\\n', 'hi'.replace(/hi/, '\n'));
		js('hi', /hi/, '\\\\t', 'hi'.replace(/hi/, '\\t'));
		js('hi', /hi/, '\\\\n', 'hi'.replace(/hi/, '\\n'));

		// implicit capture group 0
		js('hi', /hi/, 'hello$&', 'hi'.replace(/hi/, 'hello$&'));
		js('hi', /hi/, 'hello$0', 'hi'.replace(/hi/, 'hello$&'));
		js('hi', /hi/, 'hello$&1', 'hi'.replace(/hi/, 'hello$&1'));
		js('hi', /hi/, 'hello$01', 'hi'.replace(/hi/, 'hello$&1'));

		// $nn is a captured group only if it exists in the search regex
		js('hi', /(hi)/, 'hello$10', 'hi'.replace(/(hi)/, 'hello$10'));
		js('hi', /(hi)()()()()()()()()()/, 'hello$10', 'hi'.replace(/(hi)()()()()()()()()()/, 'hello$10'));
		js('hi', /(hi)/, 'hello$100', 'hi'.replace(/(hi)/, 'hello$100'));
		js('hi', /(hi)/, 'hello$20', 'hi'.replace(/(hi)/, 'hello$20'));
	});

	test('get replace string if given text is a complete match', () => {
		assertReplace('bla', /bla/, 'hello', 'hello');
		assertReplace('bla', /(bla)/, 'hello', 'hello');
		assertReplace('bla', /(bla)/, 'hello$0', 'hellobla');

		const searchRegex = /let\s+(\w+)\s*=\s*require\s*\(\s*['"]([\w\.\-/]+)\s*['"]\s*\)\s*/;
		assertReplace('let fs = require(\'fs\')', searchRegex, 'import * as $1 from \'$2\';', 'import * as fs from \'fs\';');
		assertReplace('let something = require(\'fs\')', searchRegex, 'import * as $1 from \'$2\';', 'import * as something from \'fs\';');
		assertReplace('let something = require(\'fs\')', searchRegex, 'import * as $1 from \'$1\';', 'import * as something from \'something\';');
		assertReplace('let something = require(\'fs\')', searchRegex, 'import * as $2 from \'$1\';', 'import * as fs from \'something\';');
		assertReplace('let something = require(\'fs\')', searchRegex, 'import * as $0 from \'$0\';', 'import * as let something = require(\'fs\') from \'let something = require(\'fs\')\';');
		assertReplace('let fs = require(\'fs\')', searchRegex, 'import * as $1 from \'$2\';', 'import * as fs from \'fs\';');
		assertReplace('for ()', /for(.*)/, 'cat$1', 'cat ()');

		// issue #18111
		assertReplace('HRESULT OnAmbientPropertyChange(DISPID   dispid);', /\b\s{3}\b/, ' ', ' ');
	});

	test('get replace string if match is sub-string of the text', () => {
		const t = 'this is a bla text';
		assertReplace(t, /bla/, 'hello', 'hello');
		assertReplace(t, /this(?=.*bla)/, 'that', 'that');
		assertReplace(t, /(th)is(?=.*bla)/, '$1at', 'that');
		assertReplace(t, /(th)is(?=.*bla)/, '$1e', 'the');
		assertReplace(t, /(th)is(?=.*bla)/, '$1ere', 'there');
		assertReplace(t, /(th)is(?=.*bla)/, '$1', 'th');
		assertReplace(t, /(th)is(?=.*bla)/, 'ma$1', 'math');
		assertReplace(t, /(th)is(?=.*bla)/, 'ma$1s', 'maths');
		assertReplace(t, /(th)is(?=.*bla)/, '$0', 'this');
		assertReplace(t, /(th)is(?=.*bla)/, '$0$1', 'thisth');
		assertReplace(t, /bla(?=\stext$)/, 'foo', 'foo');
		assertReplace(t, /b(la)(?=\stext$)/, 'f$1', 'fla');
		assertReplace(t, /b(la)(?=\stext$)/, 'f$0', 'fbla');
		assertReplace(t, /b(la)(?=\stext$)/, '$0ah', 'blaah');
	});

	test('issue #19740 capture group that did not participate inserts an empty string', () => {
		const replacePattern = parseReplaceString('a{$1}');
		const matches = /a(z)?/.exec('abcd');
		assert.strictEqual(replacePattern.buildReplaceString(matches), 'a{}');
	});

	test('empty replace string and fromStaticValue', () => {
		assert.strictEqual(parseReplaceString('').buildReplaceString(null), '');
		assert.strictEqual(parseReplaceString('').hasReplacementPatterns, false);
		assert.strictEqual(parseReplaceString('a$1').hasReplacementPatterns, true);
		assert.strictEqual(PieceReplacePattern.fromStaticValue('x').buildReplaceString(null), 'x');
	});
});

describe('preserve case', () => {
	const cases: Array<[string[], string, string]> = [
		[['abc'], 'Def', 'def'],
		[['Abc'], 'Def', 'Def'],
		[['ABC'], 'Def', 'DEF'],
		[['abc', 'Abc'], 'Def', 'def'],
		[['Abc', 'abc'], 'Def', 'Def'],
		[['ABC', 'abc'], 'Def', 'DEF'],
		[['aBc', 'abc'], 'Def', 'def'],
		[['AbC'], 'Def', 'Def'],
		[['aBC'], 'Def', 'def'],
		[['aBc'], 'DeF', 'deF'],
		[['Foo-Bar'], 'newfoo-newbar', 'Newfoo-Newbar'],
		[['Foo-Bar-Abc'], 'newfoo-newbar-newabc', 'Newfoo-Newbar-Newabc'],
		[['Foo-Bar-abc'], 'newfoo-newbar', 'Newfoo-newbar'],
		[['foo-Bar'], 'newfoo-newbar', 'newfoo-Newbar'],
		[['foo-BAR'], 'newfoo-newbar', 'newfoo-NEWBAR'],
		[['foO-BAR'], 'NewFoo-NewBar', 'newFoo-NEWBAR'],
		[['Foo_Bar'], 'newfoo_newbar', 'Newfoo_Newbar'],
		[['Foo_Bar_Abc'], 'newfoo_newbar_newabc', 'Newfoo_Newbar_Newabc'],
		[['Foo_Bar_abc'], 'newfoo_newbar', 'Newfoo_newbar'],
		[['Foo_Bar-abc'], 'newfoo_newbar-abc', 'Newfoo_newbar-abc'],
		[['foo_Bar'], 'newfoo_newbar', 'newfoo_Newbar'],
		[['Foo_BAR'], 'newfoo_newbar', 'Newfoo_NEWBAR'],
		// extra: hyphen and underscore (not in the origin tests)
		[['foo-bar'], 'new-name', 'new-name'],
		[['Foo-Bar'], 'new-name', 'New-Name'],
		[['FOO-BAR'], 'new-name', 'NEW-NAME'],
		[['FOO_BAR'], 'new_name', 'NEW_NAME'],
		[['Foo_Bar'], 'new_name', 'New_Name'],
		[['foo_bar'], 'NEW_NAME', 'new_name'],
		[[''], 'Def', 'Def'],
	];

	test('buildReplaceStringWithCasePreserved', () => {
		for (const [target, replaceString, expected] of cases.slice(0, 22)) {
			assert.strictEqual(buildReplaceStringWithCasePreserved(target, replaceString), expected, `${target} / ${replaceString}`);
		}
		assert.strictEqual(buildReplaceStringWithCasePreserved(null, 'Def'), 'Def');
	});

	test('PieceReplacePattern.buildReplaceString(matches, true)', () => {
		for (const [target, replaceString, expected] of cases) {
			assert.strictEqual(parseReplaceString(replaceString).buildReplaceString(target, true), expected, `${target} / ${replaceString}`);
		}
		// the origin test also has foo_BAR -> newfoo_NEWBAR
		assert.strictEqual(parseReplaceString('newfoo_newbar').buildReplaceString(['foo_BAR'], true), 'newfoo_NEWBAR');
	});

	test('ReplacePattern.getReplaceString preserves hyphen/underscore case', () => {
		const dash = new ReplacePattern('new-name', { pattern: 'foo-bar' });
		assert.strictEqual(dash.getReplaceString('Foo-Bar', true), 'New-Name');
		assert.strictEqual(dash.getReplaceString('Foo-Bar'), 'new-name');
		const snake = new ReplacePattern('new_name', { pattern: 'foo_bar' });
		assert.strictEqual(snake.getReplaceString('FOO_BAR', true), 'NEW_NAME');
	});
});
