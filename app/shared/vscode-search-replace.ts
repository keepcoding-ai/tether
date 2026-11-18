/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Port of VS Code's search-and-replace text substitution: the replace string with `$1`..`$99`, `$&`, `$$`,
// `\n`, `\t`, the case modifiers `\u \U \l \L`, and "Preserve Case".
// Origin: https://github.com/microsoft/vscode, commit 9cc2376778e119f759ff710c1238fdc58d402d7a
//   src/vs/workbench/services/search/common/replace.ts   (ReplacePattern: getReplaceString, buildReplaceString, hasParameters)
//   src/vs/editor/contrib/find/browser/replacePattern.ts (ReplacePattern, ReplacePiece, parseReplaceString)
//   src/vs/base/common/search.ts                         (buildReplaceStringWithCasePreserved)
// and the pieces they import, copied from the same commit into the "Dependencies" region below:
//   charCode.ts (the constants used here), strings.ts (escapeRegExpCharacters, RegExpOptions, createRegExp,
//   containsUppercaseCharacter).
// Changes, only what this project's compiler needs (Node 24 erasable syntax, `noUncheckedIndexedAccess`):
//   `CharCode` and the `ReplacePatternKind` const enum are const objects; parameter properties are plain fields;
//   indexed reads carry `!`; `IPatternInfo` is replaced by the minimal `ReplacePatternInfo` declared here; the
//   `any` constructor implementation signature is typed. Formatting and comments are VS Code's.
// Name clash resolved here: VS Code has two classes called `ReplacePattern` (the search one, which parses the
//   replace string and works on text, and the editor one, built from pieces). The search one keeps the name
//   `ReplacePattern`; the editor one is exported as `PieceReplacePattern`.

//#region Dependencies (copied from the files named above)

// --- charCode.ts ---
const CharCode = {
	DollarSign: 36,
	Ampersand: 38,
	SingleQuote: 39,
	Digit0: 48,
	Digit1: 49,
	Digit9: 57,
	Backslash: 92,
	BackTick: 96,
	L: 76,
	U: 85,
	l: 108,
	n: 110,
	t: 116,
	u: 117,
} as const;

// --- strings.ts ---

/**
 * Escapes regular expression characters in a given string
 */
function escapeRegExpCharacters(value: string): string {
	return value.replace(/[\\\{\}\*\+\?\|\^\$\.\[\]\(\)]/g, '\\$&');
}

interface RegExpOptions {
	matchCase?: boolean;
	wholeWord?: boolean;
	multiline?: boolean;
	global?: boolean;
	unicode?: boolean;
}

function createRegExp(searchString: string, isRegex: boolean, options: RegExpOptions = {}): RegExp {
	if (!searchString) {
		throw new Error('Cannot create regex from empty string');
	}
	if (!isRegex) {
		searchString = escapeRegExpCharacters(searchString);
	}
	if (options.wholeWord) {
		if (!/\B/.test(searchString.charAt(0))) {
			searchString = '\\b' + searchString;
		}
		if (!/\B/.test(searchString.charAt(searchString.length - 1))) {
			searchString = searchString + '\\b';
		}
	}
	let modifiers = '';
	if (options.global) {
		modifiers += 'g';
	}
	if (!options.matchCase) {
		modifiers += 'i';
	}
	if (options.multiline) {
		modifiers += 'm';
	}
	if (options.unicode) {
		modifiers += 'u';
	}

	return new RegExp(searchString, modifiers);
}

function containsUppercaseCharacter(target: string, ignoreEscapedChars = false): boolean {
	if (!target) {
		return false;
	}

	if (ignoreEscapedChars) {
		target = target.replace(/\\./g, '');
	}

	return target.toLowerCase() !== target;
}

//#endregion

//#region base/common/search.ts

export function buildReplaceStringWithCasePreserved(matches: string[] | null, pattern: string): string {
	if (matches && (matches[0] !== '')) {
		const containsHyphens = validateSpecificSpecialCharacter(matches, pattern, '-');
		const containsUnderscores = validateSpecificSpecialCharacter(matches, pattern, '_');
		if (containsHyphens && !containsUnderscores) {
			return buildReplaceStringForSpecificSpecialCharacter(matches, pattern, '-');
		} else if (!containsHyphens && containsUnderscores) {
			return buildReplaceStringForSpecificSpecialCharacter(matches, pattern, '_');
		}
		if (matches[0]!.toUpperCase() === matches[0]) {
			return pattern.toUpperCase();
		} else if (matches[0]!.toLowerCase() === matches[0]) {
			return pattern.toLowerCase();
		} else if (containsUppercaseCharacter(matches[0]![0]!) && pattern.length > 0) {
			return pattern[0]!.toUpperCase() + pattern.substr(1);
		} else if (matches[0]![0]!.toUpperCase() !== matches[0]![0] && pattern.length > 0) {
			return pattern[0]!.toLowerCase() + pattern.substr(1);
		} else {
			// we don't understand its pattern yet.
			return pattern;
		}
	} else {
		return pattern;
	}
}

function validateSpecificSpecialCharacter(matches: string[], pattern: string, specialCharacter: string): boolean {
	const doesContainSpecialCharacter = matches[0]!.indexOf(specialCharacter) !== -1 && pattern.indexOf(specialCharacter) !== -1;
	return doesContainSpecialCharacter && matches[0]!.split(specialCharacter).length === pattern.split(specialCharacter).length;
}

function buildReplaceStringForSpecificSpecialCharacter(matches: string[], pattern: string, specialCharacter: string): string {
	const splitPatternAtSpecialCharacter = pattern.split(specialCharacter);
	const splitMatchAtSpecialCharacter = matches[0]!.split(specialCharacter);
	let replaceString: string = '';
	splitPatternAtSpecialCharacter.forEach((splitValue, index) => {
		replaceString += buildReplaceStringWithCasePreserved([splitMatchAtSpecialCharacter[index]!], splitValue) + specialCharacter;
	});

	return replaceString.slice(0, -1);
}

//#endregion

//#region editor/contrib/find/browser/replacePattern.ts

const ReplacePatternKind = {
	StaticValue: 0,
	DynamicPieces: 1,
} as const;

/**
 * Assigned when the replace pattern is entirely static.
 */
class StaticValueReplacePattern {
	public readonly kind = ReplacePatternKind.StaticValue;
	public readonly staticValue: string;
	constructor(staticValue: string) {
		this.staticValue = staticValue;
	}
}

/**
 * Assigned when the replace pattern has replacement patterns.
 */
class DynamicPiecesReplacePattern {
	public readonly kind = ReplacePatternKind.DynamicPieces;
	public readonly pieces: ReplacePiece[];
	constructor(pieces: ReplacePiece[]) {
		this.pieces = pieces;
	}
}

export class PieceReplacePattern {

	public static fromStaticValue(value: string): PieceReplacePattern {
		return new PieceReplacePattern([ReplacePiece.staticValue(value)]);
	}

	private readonly _state: StaticValueReplacePattern | DynamicPiecesReplacePattern;

	public get hasReplacementPatterns(): boolean {
		return (this._state.kind === ReplacePatternKind.DynamicPieces);
	}

	constructor(pieces: ReplacePiece[] | null) {
		if (!pieces || pieces.length === 0) {
			this._state = new StaticValueReplacePattern('');
		} else if (pieces.length === 1 && pieces[0]!.staticValue !== null) {
			this._state = new StaticValueReplacePattern(pieces[0]!.staticValue);
		} else {
			this._state = new DynamicPiecesReplacePattern(pieces);
		}
	}

	public buildReplaceString(matches: string[] | null, preserveCase?: boolean): string {
		if (this._state.kind === ReplacePatternKind.StaticValue) {
			if (preserveCase) {
				return buildReplaceStringWithCasePreserved(matches, this._state.staticValue);
			} else {
				return this._state.staticValue;
			}
		}

		let result = '';
		for (let i = 0, len = this._state.pieces.length; i < len; i++) {
			const piece = this._state.pieces[i]!;
			if (piece.staticValue !== null) {
				// static value ReplacePiece
				result += piece.staticValue;
				continue;
			}

			// match index ReplacePiece
			let match: string = PieceReplacePattern._substitute(piece.matchIndex, matches);
			if (piece.caseOps !== null && piece.caseOps.length > 0) {
				const repl: string[] = [];
				const lenOps: number = piece.caseOps.length;
				let opIdx: number = 0;
				for (let idx: number = 0, len: number = match.length; idx < len; idx++) {
					if (opIdx >= lenOps) {
						repl.push(match.slice(idx));
						break;
					}
					switch (piece.caseOps[opIdx]) {
						case 'U':
							repl.push(match[idx]!.toUpperCase());
							break;
						case 'u':
							repl.push(match[idx]!.toUpperCase());
							opIdx++;
							break;
						case 'L':
							repl.push(match[idx]!.toLowerCase());
							break;
						case 'l':
							repl.push(match[idx]!.toLowerCase());
							opIdx++;
							break;
						default:
							repl.push(match[idx]!);
					}
				}
				match = repl.join('');
			}
			result += match;
		}

		return result;
	}

	private static _substitute(matchIndex: number, matches: string[] | null): string {
		if (matches === null) {
			return '';
		}
		if (matchIndex === 0) {
			return matches[0]!;
		}

		let remainder = '';
		while (matchIndex > 0) {
			if (matchIndex < matches.length) {
				// A match can be undefined
				const match = (matches[matchIndex] || '');
				return match + remainder;
			}
			remainder = String(matchIndex % 10) + remainder;
			matchIndex = Math.floor(matchIndex / 10);
		}
		return '$' + remainder;
	}
}

/**
 * A replace piece can either be a static string or an index to a specific match.
 */
export class ReplacePiece {

	public static staticValue(value: string): ReplacePiece {
		return new ReplacePiece(value, -1, null);
	}

	public static matchIndex(index: number): ReplacePiece {
		return new ReplacePiece(null, index, null);
	}

	public static caseOps(index: number, caseOps: string[]): ReplacePiece {
		return new ReplacePiece(null, index, caseOps);
	}

	public readonly staticValue: string | null;
	public readonly matchIndex: number;
	public readonly caseOps: string[] | null;

	private constructor(staticValue: string | null, matchIndex: number, caseOps: string[] | null) {
		this.staticValue = staticValue;
		this.matchIndex = matchIndex;
		if (!caseOps || caseOps.length === 0) {
			this.caseOps = null;
		} else {
			this.caseOps = caseOps.slice(0);
		}
	}
}

class ReplacePieceBuilder {

	private readonly _source: string;
	private _lastCharIndex: number;
	private readonly _result: ReplacePiece[];
	private _resultLen: number;
	private _currentStaticPiece: string;

	constructor(source: string) {
		this._source = source;
		this._lastCharIndex = 0;
		this._result = [];
		this._resultLen = 0;
		this._currentStaticPiece = '';
	}

	public emitUnchanged(toCharIndex: number): void {
		this._emitStatic(this._source.substring(this._lastCharIndex, toCharIndex));
		this._lastCharIndex = toCharIndex;
	}

	public emitStatic(value: string, toCharIndex: number): void {
		this._emitStatic(value);
		this._lastCharIndex = toCharIndex;
	}

	private _emitStatic(value: string): void {
		if (value.length === 0) {
			return;
		}
		this._currentStaticPiece += value;
	}

	public emitMatchIndex(index: number, toCharIndex: number, caseOps: string[]): void {
		if (this._currentStaticPiece.length !== 0) {
			this._result[this._resultLen++] = ReplacePiece.staticValue(this._currentStaticPiece);
			this._currentStaticPiece = '';
		}
		this._result[this._resultLen++] = ReplacePiece.caseOps(index, caseOps);
		this._lastCharIndex = toCharIndex;
	}


	public finalize(): PieceReplacePattern {
		this.emitUnchanged(this._source.length);
		if (this._currentStaticPiece.length !== 0) {
			this._result[this._resultLen++] = ReplacePiece.staticValue(this._currentStaticPiece);
			this._currentStaticPiece = '';
		}
		return new PieceReplacePattern(this._result);
	}
}

/**
 * \n			=> inserts a LF
 * \t			=> inserts a TAB
 * \\			=> inserts a "\".
 * \u			=> upper-cases one character in a match.
 * \U			=> upper-cases ALL remaining characters in a match.
 * \l			=> lower-cases one character in a match.
 * \L			=> lower-cases ALL remaining characters in a match.
 * $$			=> inserts a "$".
 * $& and $0	=> inserts the matched substring.
 * $n			=> Where n is a non-negative integer lesser than 100, inserts the nth parenthesized submatch string
 * everything else stays untouched
 *
 * Also see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/replace#Specifying_a_string_as_a_parameter
 */
export function parseReplaceString(replaceString: string): PieceReplacePattern {
	if (!replaceString || replaceString.length === 0) {
		return new PieceReplacePattern(null);
	}

	const caseOps: string[] = [];
	const result = new ReplacePieceBuilder(replaceString);

	for (let i = 0, len = replaceString.length; i < len; i++) {
		const chCode = replaceString.charCodeAt(i);

		if (chCode === CharCode.Backslash) {

			// move to next char
			i++;

			if (i >= len) {
				// string ends with a \
				break;
			}

			const nextChCode = replaceString.charCodeAt(i);
			// let replaceWithCharacter: string | null = null;

			switch (nextChCode) {
				case CharCode.Backslash:
					// \\ => inserts a "\"
					result.emitUnchanged(i - 1);
					result.emitStatic('\\', i + 1);
					break;
				case CharCode.n:
					// \n => inserts a LF
					result.emitUnchanged(i - 1);
					result.emitStatic('\n', i + 1);
					break;
				case CharCode.t:
					// \t => inserts a TAB
					result.emitUnchanged(i - 1);
					result.emitStatic('\t', i + 1);
					break;
				// Case modification of string replacements, patterned after Boost, but only applied
				// to the replacement text, not subsequent content.
				case CharCode.u:
				// \u => upper-cases one character.
				case CharCode.U:
				// \U => upper-cases ALL following characters.
				case CharCode.l:
				// \l => lower-cases one character.
				case CharCode.L:
					// \L => lower-cases ALL following characters.
					result.emitUnchanged(i - 1);
					result.emitStatic('', i + 1);
					caseOps.push(String.fromCharCode(nextChCode));
					break;
			}

			continue;
		}

		if (chCode === CharCode.DollarSign) {

			// move to next char
			i++;

			if (i >= len) {
				// string ends with a $
				break;
			}

			const nextChCode = replaceString.charCodeAt(i);

			if (nextChCode === CharCode.DollarSign) {
				// $$ => inserts a "$"
				result.emitUnchanged(i - 1);
				result.emitStatic('$', i + 1);
				continue;
			}

			if (nextChCode === CharCode.Digit0 || nextChCode === CharCode.Ampersand) {
				// $& and $0 => inserts the matched substring.
				result.emitUnchanged(i - 1);
				result.emitMatchIndex(0, i + 1, caseOps);
				caseOps.length = 0;
				continue;
			}

			if (CharCode.Digit1 <= nextChCode && nextChCode <= CharCode.Digit9) {
				// $n

				let matchIndex = nextChCode - CharCode.Digit0;

				// peek next char to probe for $nn
				if (i + 1 < len) {
					const nextNextChCode = replaceString.charCodeAt(i + 1);
					if (CharCode.Digit0 <= nextNextChCode && nextNextChCode <= CharCode.Digit9) {
						// $nn

						// move to next char
						i++;
						matchIndex = matchIndex * 10 + (nextNextChCode - CharCode.Digit0);

						result.emitUnchanged(i - 2);
						result.emitMatchIndex(matchIndex, i + 1, caseOps);
						caseOps.length = 0;
						continue;
					}
				}

				result.emitUnchanged(i - 1);
				result.emitMatchIndex(matchIndex, i + 1, caseOps);
				caseOps.length = 0;
				continue;
			}
		}
	}

	return result.finalize();
}

//#endregion

//#region workbench/services/search/common/replace.ts

/**
 * The part of VS Code's `IPatternInfo` (services/search/common/search.ts) that `ReplacePattern` reads.
 */
export interface ReplacePatternInfo {
	pattern: string;
	isRegExp?: boolean;
	isCaseSensitive?: boolean;
	isWordMatch?: boolean;
	isMultiline?: boolean;
	isUnicode?: boolean;
}

export class ReplacePattern {

	private _replacePattern: string;
	private _hasParameters: boolean = false;
	private _regExp: RegExp;
	private _caseOpsRegExp: RegExp;

	constructor(replaceString: string, searchPatternInfo: ReplacePatternInfo);
	constructor(replaceString: string, parseParameters: boolean, regEx: RegExp);
	constructor(replaceString: string, arg2: ReplacePatternInfo | boolean, arg3?: RegExp) {
		this._replacePattern = replaceString;
		let parseParameters: boolean;
		if (typeof arg2 === 'boolean') {
			parseParameters = arg2;
			this._regExp = arg3!;

		} else {
			const searchPatternInfo = arg2;
			parseParameters = !!searchPatternInfo.isRegExp;
			this._regExp = createRegExp(searchPatternInfo.pattern, !!searchPatternInfo.isRegExp, { matchCase: searchPatternInfo.isCaseSensitive, wholeWord: searchPatternInfo.isWordMatch, multiline: searchPatternInfo.isMultiline, global: false, unicode: true });
		}

		if (parseParameters) {
			this.parseReplaceString(replaceString);
		}

		if (this._regExp.global) {
			this._regExp = createRegExp(this._regExp.source, true, { matchCase: !this._regExp.ignoreCase, wholeWord: false, multiline: this._regExp.multiline, global: false });
		}

		this._caseOpsRegExp = new RegExp(/([\s\S]*?)((?:\\[uUlL])+?|)(\$[0-9]+)([\s\S]*?)/g);
	}

	get hasParameters(): boolean {
		return this._hasParameters;
	}

	get pattern(): string {
		return this._replacePattern;
	}

	get regExp(): RegExp {
		return this._regExp;
	}

	/**
	* Returns the replace string for the first match in the given text.
	* If text has no matches then returns null.
	*/
	getReplaceString(text: string, preserveCase?: boolean): string | null {
		this._regExp.lastIndex = 0;
		const match = this._regExp.exec(text);
		if (match) {
			if (this.hasParameters) {
				const replaceString = this.replaceWithCaseOperations(text, this._regExp, this.buildReplaceString(match, preserveCase));
				if (match[0] === text) {
					return replaceString;
				}
				return replaceString.substr(match.index, match[0].length - (text.length - replaceString.length));
			}
			return this.buildReplaceString(match, preserveCase);
		}

		return null;
	}

	/**
	 * replaceWithCaseOperations applies case operations to relevant replacement strings and applies
	 * the affected $N arguments. It then passes unaffected $N arguments through to string.replace().
	 *
	 * \u			=> upper-cases one character in a match.
	 * \U			=> upper-cases ALL remaining characters in a match.
	 * \l			=> lower-cases one character in a match.
	 * \L			=> lower-cases ALL remaining characters in a match.
	 */
	private replaceWithCaseOperations(text: string, regex: RegExp, replaceString: string): string {
		// Short-circuit the common path.
		if (!/\\[uUlL]/.test(replaceString)) {
			return text.replace(regex, replaceString);
		}
		// Store the values of the search parameters.
		const firstMatch = regex.exec(text);
		if (firstMatch === null) {
			return text.replace(regex, replaceString);
		}

		let patMatch: RegExpExecArray | null;
		let newReplaceString = '';
		let lastIndex = 0;
		let lastMatch = '';
		// For each annotated $N, perform text processing on the parameters and perform the substitution.
		while ((patMatch = this._caseOpsRegExp.exec(replaceString)) !== null) {
			lastIndex = patMatch.index;
			const fullMatch = patMatch[0];
			lastMatch = fullMatch;
			let caseOps = patMatch[2]!; // \u, \l\u, etc.
			const money = patMatch[3]!; // $1, $2, etc.

			if (!caseOps) {
				newReplaceString += fullMatch;
				continue;
			}
			const replacement = firstMatch[parseInt(money.slice(1))];
			if (!replacement) {
				newReplaceString += fullMatch;
				continue;
			}
			const replacementLen = replacement.length;

			newReplaceString += patMatch[1]; // prefix
			caseOps = caseOps.replace(/\\/g, '');
			let i = 0;
			for (; i < caseOps.length; i++) {
				switch (caseOps[i]) {
					case 'U':
						newReplaceString += replacement.slice(i).toUpperCase();
						i = replacementLen;
						break;
					case 'u':
						newReplaceString += replacement[i]!.toUpperCase();
						break;
					case 'L':
						newReplaceString += replacement.slice(i).toLowerCase();
						i = replacementLen;
						break;
					case 'l':
						newReplaceString += replacement[i]!.toLowerCase();
						break;
				}
			}
			// Append any remaining replacement string content not covered by case operations.
			if (i < replacementLen) {
				newReplaceString += replacement.slice(i);
			}

			newReplaceString += patMatch[4]; // suffix
		}

		// Append any remaining trailing content after the final regex match.
		newReplaceString += replaceString.slice(lastIndex + lastMatch.length);

		return text.replace(regex, newReplaceString);
	}

	public buildReplaceString(matches: string[] | null, preserveCase?: boolean): string {
		if (preserveCase) {
			return buildReplaceStringWithCasePreserved(matches, this._replacePattern);
		} else {
			return this._replacePattern;
		}
	}

	/**
	 * \n => LF
	 * \t => TAB
	 * \\ => \
	 * $0 => $& (see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/replace#Specifying_a_string_as_a_parameter)
	 * everything else stays untouched
	 */
	private parseReplaceString(replaceString: string): void {
		if (!replaceString || replaceString.length === 0) {
			return;
		}

		let substrFrom = 0, result = '';
		for (let i = 0, len = replaceString.length; i < len; i++) {
			const chCode = replaceString.charCodeAt(i);

			if (chCode === CharCode.Backslash) {

				// move to next char
				i++;

				if (i >= len) {
					// string ends with a \
					break;
				}

				const nextChCode = replaceString.charCodeAt(i);
				let replaceWithCharacter: string | null = null;

				switch (nextChCode) {
					case CharCode.Backslash:
						// \\ => \
						replaceWithCharacter = '\\';
						break;
					case CharCode.n:
						// \n => LF
						replaceWithCharacter = '\n';
						break;
					case CharCode.t:
						// \t => TAB
						replaceWithCharacter = '\t';
						break;
				}

				if (replaceWithCharacter) {
					result += replaceString.substring(substrFrom, i - 1) + replaceWithCharacter;
					substrFrom = i + 1;
				}
			}

			if (chCode === CharCode.DollarSign) {

				// move to next char
				i++;

				if (i >= len) {
					// string ends with a $
					break;
				}

				const nextChCode = replaceString.charCodeAt(i);
				let replaceWithCharacter: string | null = null;

				switch (nextChCode) {
					case CharCode.Digit0:
						// $0 => $&
						replaceWithCharacter = '$&';
						this._hasParameters = true;
						break;
					case CharCode.BackTick:
					case CharCode.SingleQuote:
						this._hasParameters = true;
						break;
					default: {
						// check if it is a valid string parameter $n (0 <= n <= 99). $0 is already handled by now.
						if (!this.between(nextChCode, CharCode.Digit1, CharCode.Digit9)) {
							break;
						}
						if (i === replaceString.length - 1) {
							this._hasParameters = true;
							break;
						}
						let charCode = replaceString.charCodeAt(++i);
						if (!this.between(charCode, CharCode.Digit0, CharCode.Digit9)) {
							this._hasParameters = true;
							--i;
							break;
						}
						if (i === replaceString.length - 1) {
							this._hasParameters = true;
							break;
						}
						charCode = replaceString.charCodeAt(++i);
						if (!this.between(charCode, CharCode.Digit0, CharCode.Digit9)) {
							this._hasParameters = true;
							--i;
							break;
						}
						break;
					}
				}

				if (replaceWithCharacter) {
					result += replaceString.substring(substrFrom, i - 1) + replaceWithCharacter;
					substrFrom = i + 1;
				}
			}
		}

		if (substrFrom === 0) {
			// no replacement occurred
			return;
		}

		this._replacePattern = result + replaceString.substring(substrFrom);
	}

	private between(value: number, from: number, to: number): boolean {
		return from <= value && value <= to;
	}
}

//#endregion
