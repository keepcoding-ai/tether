/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Port of VS Code's local link detector for the terminal: which text of a terminal line is a path to a file or
// folder, where it sits in the xterm buffer (wide characters, wrapped lines), and which line/column it names.
// Origin: https://github.com/microsoft/vscode, commit 7faf984945fefaceb533ca1d851697a2e72e4e68, under
//   src/vs/workbench/contrib/terminalContrib/links/browser/
//   terminalLocalLinkDetector.ts      TerminalLocalLinkDetector.detect (candidates, trailing characters, the fallback
//                                     matchers for paths with spaces, the ranges by text attributes), _validateAndGetLink
//   terminalLinkHelpers.ts            convertLinkRangeToBuffer, getXtermLineContent, getXtermRangesByAttr
//   terminalLinkDetectorAdapter.ts    _provideLinks (the wrapped line around the one asked for), the trailing ":" trim
//   terminalLink.ts                   which part of the buffer a link underlines
// and the line/column of a link as terminalLocalLinkOpener reads it (the parsed suffix, else the suffix of the text).
// What VS Code decides with its services is injected instead: whether a candidate is a file or folder comes from
// `resolve` (this app's main process, app/main/terminal-links-main.ts, which resolves a relative path against the
// pane's OPENING folder). Not ported on purpose: the cwd that shell integration tracks per line
// (updateLinkWithRelativeCwd) and the "../ stripped" extra candidate it falls back to when the cwd is unknown: the
// opening folder is the only base, so a relative path that does not exist there is not a link.
// Changes, only what this project's compiler needs (Node 24 erasable syntax, `noUncheckedIndexedAccess`): the xterm
// types are the structural subset used here; indexed reads carry `!`; the resolution of the candidates of one line
// runs side by side instead of one after the other (same order, same cap of 10).

import type { LineColumn } from './file-open.ts'
import { detectLinks, getLinkSuffix, type ILinkSuffix, type IParsedLink, type LinkOs } from './vscode-terminal-link-parsing.ts'

const Constants = {
	/** The max line length to try extract word links from. */
	MaxLineLength: 2000,
	/** The maximum number of links in a line to resolve against the file system. */
	MaxResolvedLinksInLine: 10,
	/** The maximum length of a link to resolve against the file system. */
	MaxResolvedLinkLength: 1024,
	/** Context taken around the line the pointer is on (characters). */
	MaxLinkLength: 500,
} as const

// ---------- the part of xterm's API the detection reads ----------

export interface LinkBufferCell {
	getWidth(): number
	getChars(): string
	isBold(): number
	isInverse(): number
	isStrikethrough(): number
	isUnderline(): number
	isDim(): number
	isItalic(): number
}

export interface LinkBufferLine {
	readonly isWrapped: boolean
	getCell(x: number): LinkBufferCell | undefined
	translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string
}

export interface LinkTerminal {
	readonly cols: number
	readonly buffer: { readonly active: { readonly length: number; getLine(y: number): LinkBufferLine | undefined } }
}

export interface BufferPosition { x: number; y: number }
/** 1-based, ends inclusive: xterm's ILink.range. */
export interface BufferRange { start: BufferPosition; end: BufferPosition }
interface Range { startColumn: number; startLineNumber: number; endColumn: number; endLineNumber: number }

// ---------- what the detection returns ----------

/** What the resolver found for one of the candidates (`link` is the candidate that matched). */
export interface ResolvedPath { link: string; path: string; isDirectory: boolean }
/** The first of the candidates that exists, or none. */
export type CandidateResolver = (candidates: string[]) => Promise<ResolvedPath | null | undefined>

export interface DetectedLink {
  /** The text of the link as the terminal shows it (path and line/column suffix). */
  text: string
  /** The resolved absolute path. */
  path: string
  isDirectory: boolean
  bufferRange: BufferRange
  position?: LineColumn
}

// ---------- terminalLinkHelpers.ts ----------

/**
 * Converts a possibly wrapped link's range (comprised of string indices) into a buffer range that plays nicely with xterm.js
 *
 * @param lines A single line (not the entire buffer)
 * @param bufferWidth The number of columns in the terminal
 * @param range The link range - string indices
 * @param startLine The absolute y position (on the buffer) of the line
 */
export function convertLinkRangeToBuffer(lines: LinkBufferLine[], bufferWidth: number, range: Range, startLine: number): BufferRange {
	const bufferRange: BufferRange = {
		start: {
			x: range.startColumn,
			y: range.startLineNumber + startLine
		},
		end: {
			x: range.endColumn - 1,
			y: range.endLineNumber + startLine
		}
	};

	// Shift start range right for each wide character before the link
	let startOffset = 0;
	const startWrappedLineCount = Math.ceil(range.startColumn / bufferWidth);
	for (let y = 0; y < Math.min(startWrappedLineCount); y++) {
		const lineLength = Math.min(bufferWidth, (range.startColumn - 1) - y * bufferWidth);
		let lineOffset = 0;
		const line = lines[y];
		// Sanity check for line, apparently this can happen but it's not clear under what
		// circumstances this happens. Continue on, skipping the remainder of start offset if this
		// happens to minimize impact.
		if (!line) {
			break;
		}
		for (let x = 0; x < Math.min(bufferWidth, lineLength + lineOffset); x++) {
			const cell = line.getCell(x);
			// This is unexpected but it means the character doesn't exist, so we shouldn't add to
			// the offset
			if (!cell) {
				break;
			}
			const width = cell.getWidth();
			if (width === 2) {
				lineOffset++;
			}
			const char = cell.getChars();
			if (char.length > 1) {
				lineOffset -= char.length - 1;
			}
		}
		startOffset += lineOffset;
	}

	// Shift end range right for each wide character inside the link
	let endOffset = 0;
	const endWrappedLineCount = Math.ceil(range.endColumn / bufferWidth);
	for (let y = Math.max(0, startWrappedLineCount - 1); y < endWrappedLineCount; y++) {
		const start = (y === startWrappedLineCount - 1 ? (range.startColumn - 1 + startOffset) % bufferWidth : 0);
		const lineLength = Math.min(bufferWidth, range.endColumn + startOffset - y * bufferWidth);
		let lineOffset = 0;
		const line = lines[y];
		// Sanity check for line, apparently this can happen but it's not clear under what
		// circumstances this happens. Continue on, skipping the remainder of start offset if this
		// happens to minimize impact.
		if (!line) {
			break;
		}
		for (let x = start; x < Math.min(bufferWidth, lineLength + lineOffset); x++) {
			const cell = line.getCell(x);
			// This is unexpected but it means the character doesn't exist, so we shouldn't add to
			// the offset
			if (!cell) {
				break;
			}
			const width = cell.getWidth();
			const chars = cell.getChars();
			// Offset for null cells following wide characters
			if (width === 2) {
				lineOffset++;
			}
			// Offset for early wrapping when the last cell in row is a wide character
			if (x === bufferWidth - 1 && chars === '') {
				lineOffset++;
			}
			// Offset multi-code characters like emoji
			if (chars.length > 1) {
				lineOffset -= chars.length - 1;
			}
		}
		endOffset += lineOffset;
	}

	// Apply the width character offsets to the result
	bufferRange.start.x += startOffset;
	bufferRange.end.x += startOffset + endOffset;

	// Convert back to wrapped lines
	while (bufferRange.start.x > bufferWidth) {
		bufferRange.start.x -= bufferWidth;
		bufferRange.start.y++;
	}
	while (bufferRange.end.x > bufferWidth) {
		bufferRange.end.x -= bufferWidth;
		bufferRange.end.y++;
	}

	return bufferRange;
}

export function getXtermLineContent(buffer: LinkTerminal['buffer']['active'], lineStart: number, lineEnd: number, cols: number): string {
	// Cap the maximum number of lines generated to prevent potential performance problems. This is
	// more of a sanity check as the wrapped line should already be trimmed down at this point.
	const maxLineLength = Math.max(2048, cols * 2);
	lineEnd = Math.min(lineEnd, lineStart + maxLineLength);
	let content = '';
	for (let i = lineStart; i <= lineEnd; i++) {
		// Make sure only 0 to cols are considered as resizing when windows mode is enabled will
		// retain buffer data outside of the terminal width as reflow is disabled.
		const line = buffer.getLine(i);
		if (line) {
			content += line.translateToString(true, 0, cols);
		}
	}
	return content;
}

export function getXtermRangesByAttr(buffer: LinkTerminal['buffer']['active'], lineStart: number, lineEnd: number, cols: number): BufferRange[] {
	let bufferRangeStart: BufferPosition | undefined = undefined;
	let lastFgAttr: number = -1;
	let lastBgAttr: number = -1;
	const ranges: BufferRange[] = [];
	for (let y = lineStart; y <= lineEnd; y++) {
		const line = buffer.getLine(y);
		if (!line) {
			continue;
		}
		for (let x = 0; x < cols; x++) {
			const cell = line.getCell(x);
			if (!cell) {
				break;
			}
			// HACK: Re-construct the attributes from fg and bg, this is hacky as it relies
			// upon the internal buffer bit layout
			const thisFgAttr = (
				cell.isBold() |
				cell.isInverse() |
				cell.isStrikethrough() |
				cell.isUnderline()
			);
			const thisBgAttr = (
				cell.isDim() |
				cell.isItalic()
			);
			if (lastFgAttr === -1 || lastBgAttr === -1) {
				bufferRangeStart = { x, y };
			} else {
				if (lastFgAttr !== thisFgAttr || lastBgAttr !== thisBgAttr) {
					// TODO: x overflow
					const bufferRangeEnd = { x, y };
					ranges.push({
						start: bufferRangeStart!,
						end: bufferRangeEnd
					});
					bufferRangeStart = { x, y };
				}
			}
			lastFgAttr = thisFgAttr;
			lastBgAttr = thisBgAttr;
		}
	}
	return ranges;
}

// ---------- terminalLocalLinkDetector.ts ----------

const fallbackMatchers: RegExp[] = [
	// Python style error: File "<path>", line <line>
	/^ *File (?<link>"(?<path>.+)"(, line (?<line>\d+))?)/,
	// Unknown tool #200166: FILE  <path>:<line>:<col>
	/^ +FILE +(?<link>(?<path>.+)(?::(?<line>\d+)(?::(?<col>\d+))?)?)/,
	// Some C++ compile error formats:
	// C:\foo\bar baz(339) : error ...
	// C:\foo\bar baz(339,12) : error ...
	// C:\foo\bar baz(339, 12) : error ...
	// C:\foo\bar baz(339): error ...       [#178584, Visual Studio CL/NVIDIA CUDA compiler]
	// C:\foo\bar baz(339,12): ...
	// C:\foo\bar baz(339, 12): ...
	/^(?<link>(?<path>.+)\((?<line>\d+)(?:, ?(?<col>\d+))?\)) ?:/,
	// C:\foo/bar baz:339 : error ...
	// C:\foo/bar baz:339:12 : error ...
	// C:\foo/bar baz:339: error ...
	// C:\foo/bar baz:339:12: error ...     [#178584, Clang]
	/^(?<link>(?<path>.+):(?<line>\d+)(?::(?<col>\d+))?) ?:/,
	// PowerShell and cmd prompt
	/^(?:PS\s+)?(?<link>(?<path>[^>]+))>/,
	// The whole line is the path
	/^ *(?<link>(?<path>.+))/
];

/** The line/column a link names: the parsed suffix, else the suffix its text ends with (VS Code's terminalLocalLinkOpener). */
function positionOf(parsed: IParsedLink | undefined, text: string): LineColumn | undefined {
	const suffix: ILinkSuffix | null | undefined = parsed ? parsed.suffix : getLinkSuffix(text)
	if (!suffix || suffix.row === undefined) return undefined
	return suffix.col === undefined ? { line: suffix.row } : { line: suffix.row, column: suffix.col }
}

type Found = { stat: ResolvedPath; bufferRange: BufferRange }

/** The links of one (possibly wrapped) line of the terminal: `lines` are its buffer lines, `startLine`..`endLine` 0-based. */
export async function detectLocalLinks(term: LinkTerminal, lines: LinkBufferLine[], startLine: number, endLine: number, os: LinkOs, resolve: CandidateResolver): Promise<DetectedLink[]> {
	const links: DetectedLink[] = [];
	const cols = term.cols;
	const buffer = term.buffer.active;

	// Get the text representation of the wrapped line
	const text = getXtermLineContent(buffer, startLine, endLine, cols);
	if (text === '' || text.length > Constants.MaxLineLength) {
		return [];
	}

	const validate = async (bufferRange: BufferRange, linkCandidates: string[], trimRangeMap?: Map<string, number>): Promise<Found | undefined> => {
		const stat = await resolve(linkCandidates);
		if (!stat) {
			return undefined;
		}
		// Offset the buffer range if the link range was trimmed
		const trimRange = trimRangeMap?.get(stat.link);
		if (trimRange) {
			bufferRange.end.x -= trimRange;
			if (bufferRange.end.x < 0) {
				bufferRange.end.y--;
				bufferRange.end.x += cols;
			}
		}
		return { stat, bufferRange };
	};

	const parsedLinks = detectLinks(text, os)
		// Don't try resolve any links of excessive length; stop early if too many links exist in the line
		.filter(parsedLink => parsedLink.path.text.length <= Constants.MaxResolvedLinkLength)
		.slice(0, Constants.MaxResolvedLinksInLine);
	const detected = await Promise.all(parsedLinks.map(async parsedLink => {
		// Convert the link text's string index into a wrapped buffer range
		const bufferRange = convertLinkRangeToBuffer(lines, cols, {
			startColumn: (parsedLink.prefix?.index ?? parsedLink.path.index) + 1,
			startLineNumber: 1,
			endColumn: parsedLink.path.index + parsedLink.path.text.length + (parsedLink.suffix?.suffix.text.length ?? 0) + 1,
			endLineNumber: 1
		}, startLine);

		// The only candidate is the text itself: the resolver reads a relative path against the pane's opening folder.
		const linkCandidates: string[] = [parsedLink.path.text];

		// If any candidates end with special characters that are likely to not be part of the
		// link, add a candidate excluding them.
		const specialEndCharRegex = /[\[\]"'\.]$/;
		const trimRangeMap: Map<string, number> = new Map();
		const specialEndLinkCandidates: string[] = [];
		for (const candidate of linkCandidates) {
			let previous = candidate;
			let removed = previous.replace(specialEndCharRegex, '');
			let trimRange = 0;
			while (removed !== previous) {
				// Only trim the link if there is no suffix, otherwise the underline would be incorrect
				if (!parsedLink.suffix) {
					trimRange++;
				}
				specialEndLinkCandidates.push(removed);
				trimRangeMap.set(removed, trimRange);
				previous = removed;
				removed = removed.replace(specialEndCharRegex, '');
			}
		}
		linkCandidates.push(...specialEndLinkCandidates);

		// Validate the path and convert to the outgoing type
		const found = await validate(bufferRange, linkCandidates, trimRangeMap);
		if (!found) {
			return undefined;
		}
		const linkText = text.substring(
			parsedLink.prefix?.index ?? parsedLink.path.index,
			parsedLink.suffix ? parsedLink.suffix.suffix.index + parsedLink.suffix.suffix.text.length : parsedLink.path.index + parsedLink.path.text.length
		);
		return toDetected(found, linkText, positionOf(parsedLink, linkText));
	}));
	for (const link of detected) {
		if (link) links.push(link);
	}

	// Match against the fallback matchers which are mainly designed to catch paths with spaces
	// that aren't possible using the regular mechanism.
	if (links.length === 0) {
		for (const matcher of fallbackMatchers) {
			const match = text.match(matcher);
			const group = match?.groups;
			if (!group) {
				continue;
			}
			const link = group?.link;
			const path = group?.path;
			const line = group?.line;
			const col = group?.col;
			if (!link || !path) {
				continue;
			}

			// Don't try resolve any links of excessive length
			if (link.length > Constants.MaxResolvedLinkLength) {
				continue;
			}

			// Convert the link text's string index into a wrapped buffer range
			const stringIndex = text.indexOf(link);
			const bufferRange = convertLinkRangeToBuffer(lines, cols, {
				startColumn: stringIndex + 1,
				startLineNumber: 1,
				endColumn: stringIndex + link.length + 1,
				endLineNumber: 1
			}, startLine);

			// Validate and add link
			const suffix = line ? `:${line}${col ? `:${col}` : ''}` : '';
			const found = await validate(bufferRange, [path]);
			if (found) {
				const linkText = `${path}${suffix}`;
				links.push(toDetected(found, linkText, positionOf(undefined, linkText)));
			}
		}
	}

	// Sometimes links are styled specially in the terminal like underlined or bolded, try split
	// the line by attributes and test whether it matches a path
	if (links.length === 0) {
		const rangeCandidates = getXtermRangesByAttr(buffer, startLine, endLine, cols);
		let resolvedLinkCount = 0;
		for (const rangeCandidate of rangeCandidates) {
			let candidateText = '';
			for (let y = rangeCandidate.start.y; y <= rangeCandidate.end.y; y++) {
				const line = buffer.getLine(y);
				if (!line) {
					break;
				}
				const lineStartX = y === rangeCandidate.start.y ? rangeCandidate.start.x : 0;
				const lineEndX = y === rangeCandidate.end.y ? rangeCandidate.end.x : cols - 1;
				candidateText += line.translateToString(false, lineStartX, lineEndX);
			}

			// HACK: Adjust to 1-based for link API
			rangeCandidate.start.x++;
			rangeCandidate.start.y++;
			rangeCandidate.end.y++;

			// Validate and add link
			const found = await validate(rangeCandidate, [candidateText]);
			if (found) {
				links.push(toDetected(found, candidateText, positionOf(undefined, candidateText)));
			}

			// Stop early if too many links exist in the line
			if (++resolvedLinkCount >= Constants.MaxResolvedLinksInLine) {
				break;
			}
		}
	}

	return links;
}

function toDetected(found: Found, text: string, position: LineColumn | undefined): DetectedLink {
	return {
		text,
		path: found.stat.path,
		isDirectory: found.stat.isDirectory,
		bufferRange: found.bufferRange,
		...(position ? { position } : {}),
	}
}

// ---------- terminalLinkDetectorAdapter.ts ----------

/**
 * The links of the buffer line the pointer is on (1-based, as xterm's ILinkProvider gives it): the wrapped line it belongs to
 * is read as one text, so a path that wraps is one link. A trailing ":" is dropped from the link ("file.ts:12:5:" of tsc).
 */
export async function provideLocalLinks(term: LinkTerminal, bufferLineNumber: number, os: LinkOs, resolve: CandidateResolver): Promise<DetectedLink[]> {
	const buffer = term.buffer.active;
	let startLine = bufferLineNumber - 1;
	let endLine = startLine;

	const first = buffer.getLine(startLine);
	if (!first) return [];
	const lines: LinkBufferLine[] = [first];

	// Cap the maximum context on either side of the line being provided, by taking the context
	// around the line being provided for this ensures the line the pointer is on will have
	// links provided.
	const maxCharacterContext = Math.max(Constants.MaxLinkLength, term.cols);
	const maxLineContext = Math.ceil(maxCharacterContext / term.cols);
	const minStartLine = Math.max(startLine - maxLineContext, 0);
	const maxEndLine = Math.min(endLine + maxLineContext, buffer.length);

	while (startLine >= minStartLine && buffer.getLine(startLine)?.isWrapped) {
		const previous = buffer.getLine(startLine - 1);
		if (!previous) break;
		lines.unshift(previous);
		startLine--;
	}

	while (endLine < maxEndLine && buffer.getLine(endLine + 1)?.isWrapped) {
		const next = buffer.getLine(endLine + 1);
		if (!next) break;
		lines.push(next);
		endLine++;
	}

	const detected = await detectLocalLinks(term, lines, startLine, endLine, os, resolve);
	for (const l of detected) {
		// Remove trailing colon if there is one so the link is more useful
		if (l.text.length > 0 && l.text.charAt(l.text.length - 1) === ':') {
			l.text = l.text.slice(0, -1);
			l.bufferRange.end.x--;
		}
	}
	return detected;
}
