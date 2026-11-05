// Terminal path links, the parts that need no DOM: VS Code's own parsing cases (terminalLinkParsing.test.ts, copied from the
// same commit as the port: 7faf984945fefaceb533ca1d851697a2e72e4e68; only the harness changed: node:test instead of
// mocha's suite/test, a local OperatingSystem for the one type VS Code imports), then this app's own cases: the
// detection over a fake xterm buffer (formats of common tools, quotes, parentheses, wrapped lines, wide characters),
// the resolution against the pane's OPENING folder, the UNC refusal and the cache.
import { suite, test } from 'node:test'
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { detectLinks as detectLinksShared, detectLinkSuffixes, getLinkSuffix, type IParsedLink, removeLinkQueryString, removeLinkSuffix } from '../../app/shared/vscode-terminal-link-parsing.ts'

const OperatingSystem = { Windows: 1, Macintosh: 2, Linux: 3 } as const
type OperatingSystem = (typeof OperatingSystem)[keyof typeof OperatingSystem]
const detectLinks = (line: string, os: OperatingSystem): IParsedLink[] => detectLinksShared(line, os === OperatingSystem.Windows ? 'windows' : 'posix')

interface ITestLink {
	link: string;
	prefix: string | undefined;
	suffix: string | undefined;
	// TODO: These has vars would be nicer as a flags enum
	hasRow: boolean;
	hasCol: boolean;
	hasRowEnd?: boolean;
	hasColEnd?: boolean;
}

const operatingSystems: ReadonlyArray<OperatingSystem> = [
	OperatingSystem.Linux,
	OperatingSystem.Macintosh,
	OperatingSystem.Windows
];
const osTestPath: { [key: number | OperatingSystem]: string } = {
	[OperatingSystem.Linux]: '/test/path/linux',
	[OperatingSystem.Macintosh]: '/test/path/macintosh',
	[OperatingSystem.Windows]: 'C:\\test\\path\\windows'
};
const osLabel: { [key: number | OperatingSystem]: string } = {
	[OperatingSystem.Linux]: '[Linux]',
	[OperatingSystem.Macintosh]: '[macOS]',
	[OperatingSystem.Windows]: '[Windows]'
};

const testRow = 339;
const testCol = 12;
const testRowEnd = 341;
const testColEnd = 789;
const testLinks: ITestLink[] = [
	// Simple
	{ link: 'foo', prefix: undefined, suffix: undefined, hasRow: false, hasCol: false },
	{ link: 'foo:339', prefix: undefined, suffix: ':339', hasRow: true, hasCol: false },
	{ link: 'foo:339:12', prefix: undefined, suffix: ':339:12', hasRow: true, hasCol: true },
	{ link: 'foo:339:12-789', prefix: undefined, suffix: ':339:12-789', hasRow: true, hasCol: true, hasRowEnd: false, hasColEnd: true },
	{ link: 'foo:339.12', prefix: undefined, suffix: ':339.12', hasRow: true, hasCol: true },
	{ link: 'foo:339.12-789', prefix: undefined, suffix: ':339.12-789', hasRow: true, hasCol: true, hasRowEnd: false, hasColEnd: true },
	{ link: 'foo:339.12-341.789', prefix: undefined, suffix: ':339.12-341.789', hasRow: true, hasCol: true, hasRowEnd: true, hasColEnd: true },
	{ link: 'foo#339', prefix: undefined, suffix: '#339', hasRow: true, hasCol: false },
	{ link: 'foo#339:12', prefix: undefined, suffix: '#339:12', hasRow: true, hasCol: true },
	{ link: 'foo#339:12-789', prefix: undefined, suffix: '#339:12-789', hasRow: true, hasCol: true, hasRowEnd: false, hasColEnd: true },
	{ link: 'foo#339.12', prefix: undefined, suffix: '#339.12', hasRow: true, hasCol: true },
	{ link: 'foo#339.12-789', prefix: undefined, suffix: '#339.12-789', hasRow: true, hasCol: true, hasRowEnd: false, hasColEnd: true },
	{ link: 'foo#339.12-341.789', prefix: undefined, suffix: '#339.12-341.789', hasRow: true, hasCol: true, hasRowEnd: true, hasColEnd: true },
	{ link: 'foo 339', prefix: undefined, suffix: ' 339', hasRow: true, hasCol: false },
	{ link: 'foo 339:12', prefix: undefined, suffix: ' 339:12', hasRow: true, hasCol: true },
	{ link: 'foo 339:12-789', prefix: undefined, suffix: ' 339:12-789', hasRow: true, hasCol: true, hasRowEnd: false, hasColEnd: true },
	{ link: 'foo 339.12', prefix: undefined, suffix: ' 339.12', hasRow: true, hasCol: true },
	{ link: 'foo 339.12-789', prefix: undefined, suffix: ' 339.12-789', hasRow: true, hasCol: true, hasRowEnd: false, hasColEnd: true },
	{ link: 'foo 339.12-341.789', prefix: undefined, suffix: ' 339.12-341.789', hasRow: true, hasCol: true, hasRowEnd: true, hasColEnd: true },
	{ link: 'foo, 339', prefix: undefined, suffix: ', 339', hasRow: true, hasCol: false },

	// Double quotes
	{ link: '"foo",339', prefix: '"', suffix: '",339', hasRow: true, hasCol: false },
	{ link: '"foo",339:12', prefix: '"', suffix: '",339:12', hasRow: true, hasCol: true },
	{ link: '"foo",339.12', prefix: '"', suffix: '",339.12', hasRow: true, hasCol: true },
	{ link: '"foo", line 339', prefix: '"', suffix: '", line 339', hasRow: true, hasCol: false },
	{ link: '"foo", line 339, col 12', prefix: '"', suffix: '", line 339, col 12', hasRow: true, hasCol: true },
	{ link: '"foo", line 339, column 12', prefix: '"', suffix: '", line 339, column 12', hasRow: true, hasCol: true },
	{ link: '"foo":line 339', prefix: '"', suffix: '":line 339', hasRow: true, hasCol: false },
	{ link: '"foo":line 339, col 12', prefix: '"', suffix: '":line 339, col 12', hasRow: true, hasCol: true },
	{ link: '"foo":line 339, column 12', prefix: '"', suffix: '":line 339, column 12', hasRow: true, hasCol: true },
	{ link: '"foo": line 339', prefix: '"', suffix: '": line 339', hasRow: true, hasCol: false },
	{ link: '"foo": line 339, col 12', prefix: '"', suffix: '": line 339, col 12', hasRow: true, hasCol: true },
	{ link: '"foo": line 339, column 12', prefix: '"', suffix: '": line 339, column 12', hasRow: true, hasCol: true },
	{ link: '"foo" on line 339', prefix: '"', suffix: '" on line 339', hasRow: true, hasCol: false },
	{ link: '"foo" on line 339, col 12', prefix: '"', suffix: '" on line 339, col 12', hasRow: true, hasCol: true },
	{ link: '"foo" on line 339, column 12', prefix: '"', suffix: '" on line 339, column 12', hasRow: true, hasCol: true },
	{ link: '"foo" line 339', prefix: '"', suffix: '" line 339', hasRow: true, hasCol: false },
	{ link: '"foo" line 339 column 12', prefix: '"', suffix: '" line 339 column 12', hasRow: true, hasCol: true },

	// Single quotes
	{ link: '\'foo\',339', prefix: '\'', suffix: '\',339', hasRow: true, hasCol: false },
	{ link: '\'foo\',339:12', prefix: '\'', suffix: '\',339:12', hasRow: true, hasCol: true },
	{ link: '\'foo\',339.12', prefix: '\'', suffix: '\',339.12', hasRow: true, hasCol: true },
	{ link: '\'foo\', line 339', prefix: '\'', suffix: '\', line 339', hasRow: true, hasCol: false },
	{ link: '\'foo\', line 339, col 12', prefix: '\'', suffix: '\', line 339, col 12', hasRow: true, hasCol: true },
	{ link: '\'foo\', line 339, column 12', prefix: '\'', suffix: '\', line 339, column 12', hasRow: true, hasCol: true },
	{ link: '\'foo\':line 339', prefix: '\'', suffix: '\':line 339', hasRow: true, hasCol: false },
	{ link: '\'foo\':line 339, col 12', prefix: '\'', suffix: '\':line 339, col 12', hasRow: true, hasCol: true },
	{ link: '\'foo\':line 339, column 12', prefix: '\'', suffix: '\':line 339, column 12', hasRow: true, hasCol: true },
	{ link: '\'foo\': line 339', prefix: '\'', suffix: '\': line 339', hasRow: true, hasCol: false },
	{ link: '\'foo\': line 339, col 12', prefix: '\'', suffix: '\': line 339, col 12', hasRow: true, hasCol: true },
	{ link: '\'foo\': line 339, column 12', prefix: '\'', suffix: '\': line 339, column 12', hasRow: true, hasCol: true },
	{ link: '\'foo\' on line 339', prefix: '\'', suffix: '\' on line 339', hasRow: true, hasCol: false },
	{ link: '\'foo\' on line 339, col 12', prefix: '\'', suffix: '\' on line 339, col 12', hasRow: true, hasCol: true },
	{ link: '\'foo\' on line 339, column 12', prefix: '\'', suffix: '\' on line 339, column 12', hasRow: true, hasCol: true },
	{ link: '\'foo\' line 339', prefix: '\'', suffix: '\' line 339', hasRow: true, hasCol: false },
	{ link: '\'foo\' line 339 column 12', prefix: '\'', suffix: '\' line 339 column 12', hasRow: true, hasCol: true },

	// No quotes
	{ link: 'foo, line 339', prefix: undefined, suffix: ', line 339', hasRow: true, hasCol: false },
	{ link: 'foo, line 339, col 12', prefix: undefined, suffix: ', line 339, col 12', hasRow: true, hasCol: true },
	{ link: 'foo, line 339, column 12', prefix: undefined, suffix: ', line 339, column 12', hasRow: true, hasCol: true },
	{ link: 'foo:line 339', prefix: undefined, suffix: ':line 339', hasRow: true, hasCol: false },
	{ link: 'foo:line 339, col 12', prefix: undefined, suffix: ':line 339, col 12', hasRow: true, hasCol: true },
	{ link: 'foo:line 339, column 12', prefix: undefined, suffix: ':line 339, column 12', hasRow: true, hasCol: true },
	{ link: 'foo: line 339', prefix: undefined, suffix: ': line 339', hasRow: true, hasCol: false },
	{ link: 'foo: line 339, col 12', prefix: undefined, suffix: ': line 339, col 12', hasRow: true, hasCol: true },
	{ link: 'foo: line 339, column 12', prefix: undefined, suffix: ': line 339, column 12', hasRow: true, hasCol: true },
	{ link: 'foo on line 339', prefix: undefined, suffix: ' on line 339', hasRow: true, hasCol: false },
	{ link: 'foo on line 339, col 12', prefix: undefined, suffix: ' on line 339, col 12', hasRow: true, hasCol: true },
	{ link: 'foo on line 339, column 12', prefix: undefined, suffix: ' on line 339, column 12', hasRow: true, hasCol: true },
	{ link: 'foo line 339', prefix: undefined, suffix: ' line 339', hasRow: true, hasCol: false },
	{ link: 'foo line 339 column 12', prefix: undefined, suffix: ' line 339 column 12', hasRow: true, hasCol: true },

	// Parentheses
	{ link: 'foo(339)', prefix: undefined, suffix: '(339)', hasRow: true, hasCol: false },
	{ link: 'foo(339,12)', prefix: undefined, suffix: '(339,12)', hasRow: true, hasCol: true },
	{ link: 'foo(339, 12)', prefix: undefined, suffix: '(339, 12)', hasRow: true, hasCol: true },
	{ link: 'foo (339)', prefix: undefined, suffix: ' (339)', hasRow: true, hasCol: false },
	{ link: 'foo (339,12)', prefix: undefined, suffix: ' (339,12)', hasRow: true, hasCol: true },
	{ link: 'foo (339, 12)', prefix: undefined, suffix: ' (339, 12)', hasRow: true, hasCol: true },
	{ link: 'foo: (339)', prefix: undefined, suffix: ': (339)', hasRow: true, hasCol: false },
	{ link: 'foo: (339,12)', prefix: undefined, suffix: ': (339,12)', hasRow: true, hasCol: true },
	{ link: 'foo: (339, 12)', prefix: undefined, suffix: ': (339, 12)', hasRow: true, hasCol: true },
	{ link: 'foo(339:12)', prefix: undefined, suffix: '(339:12)', hasRow: true, hasCol: true },
	{ link: 'foo (339:12)', prefix: undefined, suffix: ' (339:12)', hasRow: true, hasCol: true },

	// Square brackets
	{ link: 'foo[339]', prefix: undefined, suffix: '[339]', hasRow: true, hasCol: false },
	{ link: 'foo[339,12]', prefix: undefined, suffix: '[339,12]', hasRow: true, hasCol: true },
	{ link: 'foo[339, 12]', prefix: undefined, suffix: '[339, 12]', hasRow: true, hasCol: true },
	{ link: 'foo [339]', prefix: undefined, suffix: ' [339]', hasRow: true, hasCol: false },
	{ link: 'foo [339,12]', prefix: undefined, suffix: ' [339,12]', hasRow: true, hasCol: true },
	{ link: 'foo [339, 12]', prefix: undefined, suffix: ' [339, 12]', hasRow: true, hasCol: true },
	{ link: 'foo: [339]', prefix: undefined, suffix: ': [339]', hasRow: true, hasCol: false },
	{ link: 'foo: [339,12]', prefix: undefined, suffix: ': [339,12]', hasRow: true, hasCol: true },
	{ link: 'foo: [339, 12]', prefix: undefined, suffix: ': [339, 12]', hasRow: true, hasCol: true },
	{ link: 'foo[339:12]', prefix: undefined, suffix: '[339:12]', hasRow: true, hasCol: true },
	{ link: 'foo [339:12]', prefix: undefined, suffix: ' [339:12]', hasRow: true, hasCol: true },

	// OCaml-style
	{ link: '"foo", line 339, character 12', prefix: '"', suffix: '", line 339, character 12', hasRow: true, hasCol: true },
	{ link: '"foo", line 339, characters 12-789', prefix: '"', suffix: '", line 339, characters 12-789', hasRow: true, hasCol: true, hasColEnd: true },
	{ link: '"foo", lines 339-341', prefix: '"', suffix: '", lines 339-341', hasRow: true, hasCol: false, hasRowEnd: true },
	{ link: '"foo", lines 339-341, characters 12-789', prefix: '"', suffix: '", lines 339-341, characters 12-789', hasRow: true, hasCol: true, hasRowEnd: true, hasColEnd: true },

	// Non-breaking space
	{ link: 'foo\u00A0339:12', prefix: undefined, suffix: '\u00A0339:12', hasRow: true, hasCol: true },
	{ link: '"foo" on line 339,\u00A0column 12', prefix: '"', suffix: '" on line 339,\u00A0column 12', hasRow: true, hasCol: true },
	{ link: '\'foo\' on line\u00A0339, column 12', prefix: '\'', suffix: '\' on line\u00A0339, column 12', hasRow: true, hasCol: true },
	{ link: 'foo (339,\u00A012)', prefix: undefined, suffix: ' (339,\u00A012)', hasRow: true, hasCol: true },
	{ link: 'foo\u00A0[339, 12]', prefix: undefined, suffix: '\u00A0[339, 12]', hasRow: true, hasCol: true },
];
const testLinksWithSuffix = testLinks.filter(e => !!e.suffix);

suite('TerminalLinkParsing', () => {
	suite('removeLinkSuffix', () => {
		for (const testLink of testLinks) {
			test('`' + testLink.link + '`', () => {
				deepStrictEqual(
					removeLinkSuffix(testLink.link),
					testLink.suffix === undefined ? testLink.link : testLink.link.replace(testLink.suffix, '')
				);
			});
		}
	});
	suite('getLinkSuffix', () => {
		for (const testLink of testLinks) {
			test('`' + testLink.link + '`', () => {
				deepStrictEqual(
					getLinkSuffix(testLink.link),
					testLink.suffix === undefined ? null : {
						row: testLink.hasRow ? testRow : undefined,
						col: testLink.hasCol ? testCol : undefined,
						rowEnd: testLink.hasRowEnd ? testRowEnd : undefined,
						colEnd: testLink.hasColEnd ? testColEnd : undefined,
						suffix: {
							index: testLink.link.length - testLink.suffix.length,
							text: testLink.suffix
						}
					} as ReturnType<typeof getLinkSuffix>
				);
			});
		}
	});
	suite('detectLinkSuffixes', () => {
		for (const testLink of testLinks) {
			test('`' + testLink.link + '`', () => {
				deepStrictEqual(
					detectLinkSuffixes(testLink.link),
					testLink.suffix === undefined ? [] : [{
						row: testLink.hasRow ? testRow : undefined,
						col: testLink.hasCol ? testCol : undefined,
						rowEnd: testLink.hasRowEnd ? testRowEnd : undefined,
						colEnd: testLink.hasColEnd ? testColEnd : undefined,
						suffix: {
							index: testLink.link.length - testLink.suffix.length,
							text: testLink.suffix
						}
					} as ReturnType<typeof getLinkSuffix>]
				);
			});
		}

		test('foo(1, 2) bar[3, 4] baz on line 5', () => {
			deepStrictEqual(
				detectLinkSuffixes('foo(1, 2) bar[3, 4] baz on line 5'),
				[
					{
						col: 2,
						row: 1,
						rowEnd: undefined,
						colEnd: undefined,
						suffix: {
							index: 3,
							text: '(1, 2)'
						}
					},
					{
						col: 4,
						row: 3,
						rowEnd: undefined,
						colEnd: undefined,
						suffix: {
							index: 13,
							text: '[3, 4]'
						}
					},
					{
						col: undefined,
						row: 5,
						rowEnd: undefined,
						colEnd: undefined,
						suffix: {
							index: 23,
							text: ' on line 5'
						}
					}
				]
			);
		});
	});
	suite('removeLinkQueryString', () => {
		test('should remove any query string from the link', () => {
			strictEqual(removeLinkQueryString('?a=b'), '');
			strictEqual(removeLinkQueryString('foo?a=b'), 'foo');
			strictEqual(removeLinkQueryString('./foo?a=b'), './foo');
			strictEqual(removeLinkQueryString('/foo/bar?a=b'), '/foo/bar');
			strictEqual(removeLinkQueryString('foo?a=b?'), 'foo');
			strictEqual(removeLinkQueryString('foo?a=b&c=d'), 'foo');
		});
		test('should respect ? in UNC paths', () => {
			strictEqual(removeLinkQueryString('\\\\?\\foo?a=b'), '\\\\?\\foo');
		});
	});
	suite('detectLinks', () => {
		test('foo(1, 2) bar[3, 4] "baz" on line 5', () => {
			deepStrictEqual(
				detectLinks('foo(1, 2) bar[3, 4] "baz" on line 5', OperatingSystem.Linux),
				[
					{
						path: {
							index: 0,
							text: 'foo'
						},
						prefix: undefined,
						suffix: {
							col: 2,
							row: 1,
							rowEnd: undefined,
							colEnd: undefined,
							suffix: {
								index: 3,
								text: '(1, 2)'
							}
						}
					},
					{
						path: {
							index: 10,
							text: 'bar'
						},
						prefix: undefined,
						suffix: {
							col: 4,
							row: 3,
							rowEnd: undefined,
							colEnd: undefined,
							suffix: {
								index: 13,
								text: '[3, 4]'
							}
						}
					},
					{
						path: {
							index: 21,
							text: 'baz'
						},
						prefix: {
							index: 20,
							text: '"'
						},
						suffix: {
							col: undefined,
							row: 5,
							rowEnd: undefined,
							colEnd: undefined,
							suffix: {
								index: 24,
								text: '" on line 5'
							}
						}
					}
				] as IParsedLink[]
			);
		});

		test('should detect multiple links when opening brackets are in the text', () => {
			deepStrictEqual(
				detectLinks('notlink[foo:45]', OperatingSystem.Linux),
				[
					{
						path: {
							index: 0,
							text: 'notlink[foo'
						},
						prefix: undefined,
						suffix: {
							col: undefined,
							row: 45,
							rowEnd: undefined,
							colEnd: undefined,
							suffix: {
								index: 11,
								text: ':45'
							}
						}
					},
					{
						path: {
							index: 8,
							text: 'foo'
						},
						prefix: undefined,
						suffix: {
							col: undefined,
							row: 45,
							rowEnd: undefined,
							colEnd: undefined,
							suffix: {
								index: 11,
								text: ':45'
							}
						}
					},
				] as IParsedLink[]
			);
		});

		test('should extract the link prefix', () => {
			deepStrictEqual(
				detectLinks('"foo", line 5, col 6', OperatingSystem.Linux),
				[
					{
						path: {
							index: 1,
							text: 'foo'
						},
						prefix: {
							index: 0,
							text: '"',
						},
						suffix: {
							row: 5,
							col: 6,
							rowEnd: undefined,
							colEnd: undefined,
							suffix: {
								index: 4,
								text: '", line 5, col 6'
							}
						}
					},
				] as IParsedLink[]
			);
		});

		test('should be smart about determining the link prefix when multiple prefix characters exist', () => {
			deepStrictEqual(
				detectLinks('echo \'"foo", line 5, col 6\'', OperatingSystem.Linux),
				[
					{
						path: {
							index: 7,
							text: 'foo'
						},
						prefix: {
							index: 6,
							text: '"',
						},
						suffix: {
							row: 5,
							col: 6,
							rowEnd: undefined,
							colEnd: undefined,
							suffix: {
								index: 10,
								text: '", line 5, col 6'
							}
						}
					},
				] as IParsedLink[],
				'The outer single quotes should be excluded from the link prefix and suffix'
			);
		});

		test('should detect both suffix and non-suffix links on a single line', () => {
			deepStrictEqual(
				detectLinks('PS C:\\Github\\microsoft\\vscode> echo \'"foo", line 5, col 6\'', OperatingSystem.Windows),
				[
					{
						path: {
							index: 3,
							text: 'C:\\Github\\microsoft\\vscode'
						},
						prefix: undefined,
						suffix: undefined
					},
					{
						path: {
							index: 38,
							text: 'foo'
						},
						prefix: {
							index: 37,
							text: '"',
						},
						suffix: {
							row: 5,
							col: 6,
							rowEnd: undefined,
							colEnd: undefined,
							suffix: {
								index: 41,
								text: '", line 5, col 6'
							}
						}
					}
				] as IParsedLink[]
			);
		});

		suite('"|"', () => {
			test('should exclude pipe characters from link paths', () => {
				deepStrictEqual(
					detectLinks('|C:\\Github\\microsoft\\vscode|', OperatingSystem.Windows),
					[
						{
							path: {
								index: 1,
								text: 'C:\\Github\\microsoft\\vscode'
							},
							prefix: undefined,
							suffix: undefined
						}
					] as IParsedLink[]
				);
			});
			test('should exclude pipe characters from link paths with suffixes', () => {
				deepStrictEqual(
					detectLinks('|C:\\Github\\microsoft\\vscode:400|', OperatingSystem.Windows),
					[
						{
							path: {
								index: 1,
								text: 'C:\\Github\\microsoft\\vscode'
							},
							prefix: undefined,
							suffix: {
								col: undefined,
								row: 400,
								rowEnd: undefined,
								colEnd: undefined,
								suffix: {
									index: 27,
									text: ':400'
								}
							}
						}
					] as IParsedLink[]
				);
			});
		});

		suite('"<>"', () => {
			for (const os of operatingSystems) {
				test(`should exclude bracket characters from link paths ${osLabel[os]}`, () => {
					deepStrictEqual(
						detectLinks(`<${osTestPath[os]}<`, os),
						[
							{
								path: {
									index: 1,
									text: osTestPath[os]
								},
								prefix: undefined,
								suffix: undefined
							}
						] as IParsedLink[]
					);
					deepStrictEqual(
						detectLinks(`>${osTestPath[os]}>`, os),
						[
							{
								path: {
									index: 1,
									text: osTestPath[os]
								},
								prefix: undefined,
								suffix: undefined
							}
						] as IParsedLink[]
					);
				});
				test(`should exclude bracket characters from link paths with suffixes ${osLabel[os]}`, () => {
					deepStrictEqual(
						detectLinks(`<${osTestPath[os]}:400<`, os),
						[
							{
								path: {
									index: 1,
									text: osTestPath[os]
								},
								prefix: undefined,
								suffix: {
									col: undefined,
									row: 400,
									rowEnd: undefined,
									colEnd: undefined,
									suffix: {
										index: 1 + osTestPath[os]!.length,
										text: ':400'
									}
								}
							}
						] as IParsedLink[]
					);
					deepStrictEqual(
						detectLinks(`>${osTestPath[os]}:400>`, os),
						[
							{
								path: {
									index: 1,
									text: osTestPath[os]
								},
								prefix: undefined,
								suffix: {
									col: undefined,
									row: 400,
									rowEnd: undefined,
									colEnd: undefined,
									suffix: {
										index: 1 + osTestPath[os]!.length,
										text: ':400'
									}
								}
							}
						] as IParsedLink[]
					);
				});
			}
		});

		suite('query strings', () => {
			for (const os of operatingSystems) {
				test(`should exclude query strings from link paths ${osLabel[os]}`, () => {
					deepStrictEqual(
						detectLinks(`${osTestPath[os]}?a=b`, os),
						[
							{
								path: {
									index: 0,
									text: osTestPath[os]
								},
								prefix: undefined,
								suffix: undefined
							}
						] as IParsedLink[]
					);
					deepStrictEqual(
						detectLinks(`${osTestPath[os]}?a=b&c=d`, os),
						[
							{
								path: {
									index: 0,
									text: osTestPath[os]
								},
								prefix: undefined,
								suffix: undefined
							}
						] as IParsedLink[]
					);
				});
				test('should not detect links starting with ? within query strings that contain posix-style paths (#204195)', () => {
					// ? appended to the cwd will exist since it's just the cwd
					strictEqual(detectLinks(`http://foo.com/?bar=/a/b&baz=c`, os).some(e => e.path.text.startsWith('?')), false);
				});
				test('should not detect links starting with ? within query strings that contain Windows-style paths (#204195)', () => {
					// ? appended to the cwd will exist since it's just the cwd
					strictEqual(detectLinks(`http://foo.com/?bar=a:\\b&baz=c`, os).some(e => e.path.text.startsWith('?')), false);
				});
			}
		});

		suite('should detect file names in git diffs', () => {
			test('--- a/foo/bar', () => {
				['a', 'c', 'w', 'i', 'o'].forEach(prefix => {
					deepStrictEqual(
						detectLinks(`--- ${prefix}/foo/bar`, OperatingSystem.Linux),
						[
							{
								path: {
									index: 6,
									text: 'foo/bar'
								},
								prefix: undefined,
								suffix: undefined
							}
						] as IParsedLink[]
					);
				});
			});
			test('+++ b/foo/bar', () => {
				['b', 'c', 'w', 'i', 'o'].forEach(prefix => {
					deepStrictEqual(
						detectLinks(`+++ ${prefix}/foo/bar`, OperatingSystem.Linux),
						[
							{
								path: {
									index: 6,
									text: 'foo/bar'
								},
								prefix: undefined,
								suffix: undefined
							}
						] as IParsedLink[]
					);
				});
			});
			test('diff --git a/foo/bar b/foo/baz', () => {
				[['a', 'b'], ['c', 'w'], ['i', 'o']].forEach(([sourcePrefix, destinationPrefix]) => {
					deepStrictEqual(
						detectLinks(`diff --git ${sourcePrefix}/foo/bar ${destinationPrefix}/foo/baz`, OperatingSystem.Linux),
						[
							{
								path: {
									index: 13,
									text: 'foo/bar'
								},
								prefix: undefined,
								suffix: undefined
							},
							{
								path: {
									index: 23,
									text: 'foo/baz'
								},
								prefix: undefined,
								suffix: undefined
							}
						] as IParsedLink[]
					);
				});
			});
			test('numeric prefixes used by git diff --no-index', () => {
				deepStrictEqual(
					[
						detectLinks('--- 1/foo/bar', OperatingSystem.Linux),
						detectLinks('+++ 2/foo/baz', OperatingSystem.Linux),
						detectLinks('diff --git 1/foo/bar 2/foo/baz', OperatingSystem.Linux)
					],
					[
						[{
							path: { index: 6, text: 'foo/bar' },
							prefix: undefined,
							suffix: undefined
						}],
						[{
							path: { index: 6, text: 'foo/baz' },
							prefix: undefined,
							suffix: undefined
						}],
						[{
							path: { index: 13, text: 'foo/bar' },
							prefix: undefined,
							suffix: undefined
						}, {
							path: { index: 23, text: 'foo/baz' },
							prefix: undefined,
							suffix: undefined
						}]
					] as IParsedLink[][]
				);
			});
			test('reversed numeric prefixes used by git diff --no-index -R', () => {
				deepStrictEqual(
					[
						detectLinks('--- 2/foo/baz', OperatingSystem.Linux),
						detectLinks('+++ 1/foo/bar', OperatingSystem.Linux),
						detectLinks('diff --git 2/foo/baz 1/foo/bar', OperatingSystem.Linux)
					],
					[
						[{
							path: { index: 6, text: 'foo/baz' },
							prefix: undefined,
							suffix: undefined
						}],
						[{
							path: { index: 6, text: 'foo/bar' },
							prefix: undefined,
							suffix: undefined
						}],
						[{
							path: { index: 13, text: 'foo/baz' },
							prefix: undefined,
							suffix: undefined
						}, {
							path: { index: 23, text: 'foo/bar' },
							prefix: undefined,
							suffix: undefined
						}]
					] as IParsedLink[][]
				);
			});
			test('ordinary numeric line suffix', () => {
				deepStrictEqual(
					detectLinks('foo 1', OperatingSystem.Linux),
					[{
						path: { index: 0, text: 'foo' },
						prefix: undefined,
						suffix: {
							row: 1,
							col: undefined,
							rowEnd: undefined,
							colEnd: undefined,
							suffix: { index: 3, text: ' 1' }
						}
					}] as IParsedLink[]
				);
			});
			test('numeric suffix followed by a path separator', () => {
				deepStrictEqual(
					detectLinks('foo 1/bar', OperatingSystem.Linux),
					[{
						path: { index: 4, text: '1/bar' },
						prefix: undefined,
						suffix: undefined
					}] as IParsedLink[]
				);
			});
			test('ordinary numeric line suffix after diff --git text', () => {
				deepStrictEqual(
					detectLinks('diff --git foo.ts:123', OperatingSystem.Linux),
					[{
						path: { index: 11, text: 'foo.ts' },
						prefix: undefined,
						suffix: {
							row: 123,
							col: undefined,
							rowEnd: undefined,
							colEnd: undefined,
							suffix: { index: 17, text: ':123' }
						}
					}] as IParsedLink[]
				);
			});
		});

		suite('should detect 3 suffix links on a single line', () => {
			for (let i = 0; i < testLinksWithSuffix.length - 2; i++) {
				const link1 = testLinksWithSuffix[i]!;
				const link2 = testLinksWithSuffix[i + 1]!;
				const link3 = testLinksWithSuffix[i + 2]!;
				const line = ` ${link1.link} ${link2.link} ${link3.link} `;
				test('`' + line.replaceAll('\u00A0', '<nbsp>') + '`', () => {
					strictEqual(detectLinks(line, OperatingSystem.Linux).length, 3);
					ok(link1.suffix);
					ok(link2.suffix);
					ok(link3.suffix);
					const detectedLink1: IParsedLink = {
						prefix: link1.prefix ? {
							index: 1,
							text: link1.prefix
						} : undefined,
						path: {
							index: 1 + (link1.prefix?.length ?? 0),
							text: link1.link.replace(link1.suffix, '').replace(link1.prefix || '', '')
						},
						suffix: {
							row: link1.hasRow ? testRow : undefined,
							col: link1.hasCol ? testCol : undefined,
							rowEnd: link1.hasRowEnd ? testRowEnd : undefined,
							colEnd: link1.hasColEnd ? testColEnd : undefined,
							suffix: {
								index: 1 + (link1.link.length - link1.suffix.length),
								text: link1.suffix
							}
						}
					};
					const detectedLink2: IParsedLink = {
						prefix: link2.prefix ? {
							index: (detectedLink1.prefix?.index ?? detectedLink1.path.index) + link1.link.length + 1,
							text: link2.prefix
						} : undefined,
						path: {
							index: (detectedLink1.prefix?.index ?? detectedLink1.path.index) + link1.link.length + 1 + (link2.prefix ?? '').length,
							text: link2.link.replace(link2.suffix, '').replace(link2.prefix ?? '', '')
						},
						suffix: {
							row: link2.hasRow ? testRow : undefined,
							col: link2.hasCol ? testCol : undefined,
							rowEnd: link2.hasRowEnd ? testRowEnd : undefined,
							colEnd: link2.hasColEnd ? testColEnd : undefined,
							suffix: {
								index: (detectedLink1.prefix?.index ?? detectedLink1.path.index) + link1.link.length + 1 + (link2.link.length - link2.suffix.length),
								text: link2.suffix
							}
						}
					};
					const detectedLink3: IParsedLink = {
						prefix: link3.prefix ? {
							index: (detectedLink2.prefix?.index ?? detectedLink2.path.index) + link2.link.length + 1,
							text: link3.prefix
						} : undefined,
						path: {
							index: (detectedLink2.prefix?.index ?? detectedLink2.path.index) + link2.link.length + 1 + (link3.prefix ?? '').length,
							text: link3.link.replace(link3.suffix, '').replace(link3.prefix ?? '', '')
						},
						suffix: {
							row: link3.hasRow ? testRow : undefined,
							col: link3.hasCol ? testCol : undefined,
							rowEnd: link3.hasRowEnd ? testRowEnd : undefined,
							colEnd: link3.hasColEnd ? testColEnd : undefined,
							suffix: {
								index: (detectedLink2.prefix?.index ?? detectedLink2.path.index) + link2.link.length + 1 + (link3.link.length - link3.suffix.length),
								text: link3.suffix
							}
						}
					};
					deepStrictEqual(
						detectLinks(line, OperatingSystem.Linux),
						[detectedLink1, detectedLink2, detectedLink3]
					);
				});
			}
		});
		suite('should ignore links with suffixes when the path itself is the empty string', () => {
			deepStrictEqual(
				detectLinks('""",1', OperatingSystem.Linux),
				[] as IParsedLink[]
			);
		});
	});
});

// ---------- this app's cases: detection over a fake xterm buffer ----------

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CandidateResolver, type DetectedLink, type LinkBufferCell, type LinkBufferLine, type LinkTerminal, provideLocalLinks } from '../../app/shared/vscode-terminal-link-detector.ts'
import { candidatePath, TerminalLinkResolver } from '../../app/main/terminal-links-main.ts'

const isWide = (ch: string): boolean => /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60]/.test(ch)

/** A terminal whose rows hold `logical` lines, cut every `cols` cells (continuation rows are `isWrapped`); wide characters take two cells. */
function fakeTerm(logical: string[], cols = 80): LinkTerminal {
  const rows: LinkBufferLine[] = []
  const cell = (chars: string, width: number): LinkBufferCell => ({ getWidth: () => width, getChars: () => chars, isBold: () => 0, isInverse: () => 0, isStrikethrough: () => 0, isUnderline: () => 0, isDim: () => 0, isItalic: () => 0 })
  for (const text of logical) {
    const cells: LinkBufferCell[] = []
    for (const ch of text) { cells.push(cell(ch, isWide(ch) ? 2 : 1)); if (isWide(ch)) cells.push(cell('', 0)) }
    for (let start = 0, first = true; first || start < cells.length; start += cols, first = false) {
      const slice = cells.slice(start, start + cols)
      while (slice.length < cols) slice.push(cell('', 1))
      rows.push({
        isWrapped: start > 0,
        getCell: x => slice[x],
        translateToString(trimRight = false, startColumn = 0, endColumn = cols) {
          const s = slice.slice(startColumn, endColumn).map(c => (c.getChars() === '' && c.getWidth() === 1 ? ' ' : c.getChars())).join('')
          return trimRight ? s.replace(/\s+$/, '') : s
        },
      })
    }
  }
  return { cols, buffer: { active: { length: rows.length, getLine: y => rows[y] } } }
}

/** A resolver where only these candidates exist (the path it answers is `ABS:<candidate>`); records what it was asked. */
function existing(...names: string[]): { resolve: CandidateResolver; asked: string[][] } {
  const asked: string[][] = []
  return {
    asked,
    resolve: async candidates => {
      asked.push([...candidates])
      for (const c of candidates) if (names.includes(removeLinkSuffix(c))) return { link: c, path: `ABS:${c}`, isDirectory: false }
      return null
    },
  }
}

async function links(rows: string[], line: number, resolver: ReturnType<typeof existing>, os: 'windows' | 'posix' = 'windows', cols = 80): Promise<DetectedLink[]> {
  return provideLocalLinks(fakeTerm(rows, cols), line, os, resolver.resolve)
}
const summary = (l: DetectedLink): unknown => ({ text: l.text, path: l.path, position: l.position, x: [l.bufferRange.start.x, l.bufferRange.end.x], y: [l.bufferRange.start.y, l.bufferRange.end.y] })

suite('terminal path links: detection', () => {
  test('relative, ./ and ..\\ paths, absolute Windows paths with either slash', async () => {
    for (const [line, candidate] of [
      ['saved src/app.ts now', 'src/app.ts'],
      ['saved .\\x.md now', '.\\x.md'],
      ['saved ./x.md now', './x.md'],
      ['saved ..\\a\\b.ts now', '..\\a\\b.ts'],
      ['saved D:\\atrium\\x.md now', 'D:\\atrium\\x.md'],
      ['saved D:/atrium/x.md now', 'D:/atrium/x.md'],
    ] as const) {
      const found = await links([line], 1, existing(candidate))
      strictEqual(found.length, 1, line)
      strictEqual(found[0]!.text, candidate)
      strictEqual(found[0]!.path, `ABS:${candidate}`)
      strictEqual(found[0]!.position, undefined)
      strictEqual(found[0]!.bufferRange.start.x, 'saved '.length + 1, 'the range starts on the path (1-based)')
      strictEqual(found[0]!.bufferRange.end.x, 'saved '.length + candidate.length)
    }
  })

  test(':line, :line:col, (line,col) and tsc/eslint style', async () => {
    const cases: [string, string, unknown][] = [
      ['src/app.ts:3', 'src/app.ts:3', { line: 3 }],
      ['src/app.ts:3:9', 'src/app.ts:3:9', { line: 3, column: 9 }],
      ['src/app.ts(12,5): error TS2322: x', 'src/app.ts(12,5)', { line: 12, column: 5 }],
      ['src/app.ts(12): warning', 'src/app.ts(12)', { line: 12 }],
      ['src/app.ts:12:5: error TS2322', 'src/app.ts:12:5', { line: 12, column: 5 }],
      ['D:\\atrium\\x.md:7:1 - error', 'D:\\atrium\\x.md:7:1', { line: 7, column: 1 }],
    ]
    for (const [line, text, position] of cases) {
      const path = text.replace(/[:(]\d.*$/, '')
      const found = await links([line], 1, existing(path))
      strictEqual(found.length, 1, line)
      strictEqual(found[0]!.text, text)
      deepStrictEqual(found[0]!.position, position, line)
      strictEqual(found[0]!.bufferRange.end.x, text.length, 'the underline covers the suffix')
    }
  })

  test('stack trace: at fn (path:line:col) links the path, not the parenthesis', async () => {
    const line = '    at run (D:\\atrium\\src\\x.ts:12:5)'
    const found = await links([line], 1, existing('D:\\atrium\\src\\x.ts'))
    const text = 'D:\\atrium\\src\\x.ts:12:5'
    deepStrictEqual(found.map(summary), [{ text, path: 'ABS:D:\\atrium\\src\\x.ts', position: { line: 12, column: 5 }, x: [line.indexOf('D:') + 1, line.indexOf('D:') + text.length], y: [1, 1] }])
  })

  test('quotes: "file", line N and \'file\':N; the quote is part of the underline, not of the path', async () => {
    const found = await links(['File "src/app.ts", line 3, in <module>'], 1, existing('src/app.ts'))
    strictEqual(found.length, 1)
    strictEqual(found[0]!.path, 'ABS:src/app.ts')
    deepStrictEqual(found[0]!.position, { line: 3 })
    const q = await links(['see \'src/app.ts\':9 done'], 1, existing('src/app.ts'))
    strictEqual(q[0]!.text, '\'src/app.ts\':9')
    deepStrictEqual(q[0]!.position, { line: 9 })
  })

  test('a path that does not exist is not a link; the resolver gets the text as printed, nothing stripped', async () => {
    const r = existing()
    deepStrictEqual(await links(['saved src/missing.ts:3'], 1, r), [])
    ok(r.asked.some(c => c.includes('src/missing.ts')))
    // Reading a relative path against the opening folder is main's job; "../" is not stripped to look for a lucky match
    // (VS Code's fallback when it does not know the cwd).
    const up = existing()
    await links(['saved ..\\a\\b.ts'], 1, up)
    ok(up.asked.some(c => c.includes('..\\a\\b.ts')))
    ok(!up.asked.some(c => c.includes('a\\b.ts')), 'no stripped candidate')
  })

  test('paths with spaces: the fallback matchers (compiler output, a line that is only the path)', async () => {
    const msvc = await links(['D:\\my dir\\a b.cpp(7,3): error C2065'], 1, existing('D:\\my dir\\a b.cpp'))
    strictEqual(msvc.length, 1)
    deepStrictEqual(msvc[0]!.position, { line: 7, column: 3 })
    strictEqual(msvc[0]!.path, 'ABS:D:\\my dir\\a b.cpp')
    const clang = await links(['D:\\my dir\\a b.c:7:2: error: x'], 1, existing('D:\\my dir\\a b.c'))
    deepStrictEqual(clang[0]!.position, { line: 7, column: 2 })
    const whole = await links(['D:\\my dir\\notes.md'], 1, existing('D:\\my dir\\notes.md'))
    strictEqual(whole.length, 1)
    strictEqual(whole[0]!.position, undefined)
  })

  test('PowerShell prompt: the folder is a link', async () => {
    const found = await links(['PS D:\\atrium\\workspace> '], 1, existing('D:\\atrium\\workspace'))
    strictEqual(found.length, 1)
    strictEqual(found[0]!.path, 'ABS:D:\\atrium\\workspace')
  })

  test('a trailing . is not part of the path', async () => {
    const found = await links(['see src/app.ts.'], 1, existing('src/app.ts'))
    deepStrictEqual(found.map(summary), [{ text: 'src/app.ts.', path: 'ABS:src/app.ts', position: undefined, x: [5, 14], y: [1, 1] }])
  })

  test('a path that wraps across rows is one link spanning both', async () => {
    const text = 'see src/components/Button.tsx:42'
    const r = existing('src/components/Button.tsx')
    for (const row of [1, 2]) {
      const found = await links([text], row, r, 'windows', 20)
      strictEqual(found.length, 1, `asked on row ${row}`)
      deepStrictEqual(found[0]!.position, { line: 42 })
      deepStrictEqual([found[0]!.bufferRange.start.y, found[0]!.bufferRange.end.y], [1, 2])
      strictEqual(found[0]!.bufferRange.start.x, 5)
    }
  })

  test('wide characters before the path shift the range by their extra cell', async () => {
    const found = await links(['漢字 src/a.ts'], 1, existing('src/a.ts'))
    strictEqual(found.length, 1)
    strictEqual(found[0]!.bufferRange.start.x, '漢字 '.length + 2 + 1)
  })

  test('posix lines are read with posix paths', async () => {
    const found = await links(['error in /home/me/x.ts:4:2'], 1, existing('/home/me/x.ts'), 'posix')
    deepStrictEqual(found[0]!.position, { line: 4, column: 2 })
  })

  test('at most 10 links in a line are resolved, an over-long line is skipped', async () => {
    const names = Array.from({ length: 15 }, (_, i) => `a/f${i}.ts`)
    strictEqual((await links([names.join(' ')], 1, existing(...names), 'windows', 200)).length, 10)
    deepStrictEqual(await links(['x '.repeat(1100) + 'a/b.ts'], 1, existing('a/b.ts')), [])
  })
})

// ---------- resolution against the OPENING folder ----------

suite('terminal path links: resolution', () => {
  test('relative paths are read against the opening folder (Windows)', () => {
    const p = (c: string, cwd: string | undefined = 'D:\\proj') => candidatePath(c, cwd, 'C:\\Users\\me', 'win32')
    strictEqual(p('src/app.ts'), 'D:\\proj\\src\\app.ts')
    strictEqual(p('.\\x.md'), 'D:\\proj\\x.md')
    strictEqual(p('..\\a\\b.ts'), 'D:\\a\\b.ts')
    strictEqual(p('src/app.ts:12:5'), 'D:\\proj\\src\\app.ts', 'the line/column suffix is not part of the path')
    strictEqual(p('app.ts(12,5)'), 'D:\\proj\\app.ts')
    strictEqual(p('a.ts?x=1'), 'D:\\proj\\a.ts', 'a query string is dropped')
    strictEqual(candidatePath('src/app.ts', undefined, undefined, 'win32'), null, 'no opening folder: a relative path names nothing')
    strictEqual(p(''), null)
  })

  test('absolute paths work from anywhere: drive paths, either slash, \\\\?\\ and file://', () => {
    const p = (c: string, cwd?: string) => candidatePath(c, cwd, 'C:\\Users\\me', 'win32')
    strictEqual(p('D:\\atrium\\x.md'), 'D:\\atrium\\x.md')
    strictEqual(p('D:/atrium/x.md'), 'D:\\atrium\\x.md')
    strictEqual(p('d:/atrium/x.md:3:1', 'E:\\elsewhere'), 'd:\\atrium\\x.md')
    strictEqual(p('\\\\?\\D:\\atrium\\x.md'), 'D:\\atrium\\x.md')
    strictEqual(p('file:///D:/atrium/x.md'), 'D:\\atrium\\x.md')
    strictEqual(p('~\\notes.md'), 'C:\\Users\\me\\notes.md')
    strictEqual(candidatePath('~/x', undefined, undefined, 'win32'), null, 'no home')
  })

  test('network paths (UNC) are never resolved: hovering must not touch a share', () => {
    const p = (c: string) => candidatePath(c, 'D:\\proj', 'C:\\Users\\me', 'win32')
    strictEqual(p('\\\\evil\\share\\x.md'), null)
    strictEqual(p('//evil/share/x.md'), null)
    strictEqual(p('\\\\evil\\share\\x.md:3'), null)
    strictEqual(p('file://evil/share/x.md'), null)
    strictEqual(candidatePath('//evil/share/x', '/home/me', '/home/me', 'posix'), null)
  })

  test('posix paths', () => {
    const p = (c: string, cwd: string | undefined = '/home/me/proj') => candidatePath(c, cwd, '/home/me', 'posix')
    strictEqual(p('src/a.ts:3'), '/home/me/proj/src/a.ts')
    strictEqual(p('../a.ts'), '/home/me/a.ts')
    strictEqual(p('/etc/hosts'), '/etc/hosts')
    strictEqual(p('~/n.md'), '/home/me/n.md')
    strictEqual(candidatePath('a.ts', undefined, '/home/me', 'posix'), null)
  })

  test('files and folders on disk: the opening folder decides, a different folder finds nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tether-links-'))
    try {
      const open = join(root, 'open'), other = join(root, 'other')
      mkdirSync(join(open, 'src'), { recursive: true }); mkdirSync(other)
      writeFileSync(join(open, 'src', 'app.ts'), 'x\n'); writeFileSync(join(other, 'only-here.md'), 'y\n')
      const r = new TerminalLinkResolver({ home: root })
      const file = await r.resolve(open, ['src/app.ts:3:1'])
      strictEqual(file?.isDirectory, false)
      strictEqual(file?.path.toLowerCase(), join(open, 'src', 'app.ts').toLowerCase())
      strictEqual((await r.resolve(open, ['src']))?.isDirectory, true)
      // After a `cd other` the pane's opening folder is still `open`: what lives only in `other` is no link, an absolute path is.
      strictEqual(await r.resolve(open, ['only-here.md']), null)
      strictEqual((await r.resolve(open, [join(other, 'only-here.md')]))?.path.toLowerCase(), join(other, 'only-here.md').toLowerCase())
      strictEqual((await r.resolve(other, ['only-here.md']))?.isDirectory, false, 'the same text under another opening folder is another answer')
      // The first candidate that exists wins (the trimmed one after a trailing dot).
      strictEqual((await r.resolve(open, ['src/app.ts.', 'src/app.ts']))?.link, 'src/app.ts')
      strictEqual(await r.resolve(open, []), null)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('the answer is cached for seconds: found longer than missing', async () => {
    let clock = 0, stats = 0
    const present = new Set(['D:\\p\\a.ts'])
    const r = new TerminalLinkResolver({ platform: 'win32', now: () => clock, stat: async p => { stats++; if (!present.has(p)) throw new Error('ENOENT'); return { isDirectory: () => false } } })
    ok(await r.resolve('D:\\p', ['a.ts']))
    ok(await r.resolve('D:\\p', ['a.ts']))
    strictEqual(stats, 1, 'second ask served from the cache')
    strictEqual(await r.resolve('D:\\p', ['b.ts']), null)
    strictEqual(await r.resolve('D:\\p', ['b.ts']), null)
    strictEqual(stats, 2)
    present.add('D:\\p\\b.ts')
    clock = 2_001
    ok(await r.resolve('D:\\p', ['b.ts']), 'a missing file is asked again after 2 s: a file created meanwhile becomes a link')
    clock = 9_000
    await r.resolve('D:\\p', ['a.ts'])
    strictEqual(stats, 3, 'a found file is kept for 10 s')
    clock = 10_001
    await r.resolve('D:\\p', ['a.ts'])
    strictEqual(stats, 4)
    await r.resolve('E:\\q', ['a.ts'])
    strictEqual(stats, 5, 'the opening folder is part of the key')
  })
})
