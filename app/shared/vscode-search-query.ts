/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Port of VS Code's search query builder, the one that turns what the search view holds (pattern, "files to include",
// "files to exclude", toggles) into an `ITextQuery` with one `IFolderQuery` per folder.
// Origin: https://github.com/microsoft/vscode, commit 9cc2376778e119f759ff710c1238fdc58d402d7a
//   src/vs/workbench/services/search/common/queryBuilder.ts   (QueryBuilder.text and what it uses)
// plus the pieces it imports, cut down to what the text query needs:
//   search.ts (pathIncludedInQuery), strings.ts (containsUppercaseCharacter, escapeRegExpCharacters, rtrim),
//   textModelSearch.ts (isMultilineRegexSource), labels.ts (untildify), glob.ts (escapeExcludeException),
//   path.ts / resources.ts (the path operations used here, rewritten in this file for both platforms).
// Left out: aiText, file (IFileQuery), notebook search config, extraFileResources, onlyFileScheme, `_reason`,
//   non-file URI schemes (walkThrough, remote workspace folders), resolveResourcesForSearchIncludes.
// Changes:
//   - Services (configuration, workspace, editor groups, path service) become the `QueryBuilderEnv` argument; paths are
//     absolute strings in the separator of `env.platform`, not URIs. The configuration is the same for every folder.
//   - Path operations (join, dirname, basename, relative, isAbsolute, normalize, comparison) live in `createPathOps`,
//     parametrized by platform, so there is no `node:path` and both platforms can be tested anywhere.
//   - `getContentPattern` does not mutate its input and has no editor word separators or notebook info.
//   - `ISearchPatternBuilder.uri` is `folder` (a path). The "folder does not exist" error is in Portuguese.
//   - Added (not in VS Code): `SearchConfig.filesExclude`, `QueryBuilderEnv.userHome`, `ITextQueryBuilderOptions.fileEncoding`
//     reaching each folder query, `isSmartCase` falling back to `config.smartCase`.
//   - Nothing is cached or stateful: every call re-reads `env`.

import {
  parse,
  splitGlobAware,
  QueryType,
  type ExcludeGlobPattern,
  type IExpression,
  type IFolderQuery,
  type IPatternInfo,
  type ITextQuery,
  type ITextSearchPreviewOptions,
} from './vscode-search.ts'

//#region Environment

/** An open folder (project). */
export interface SearchFolder { path: string; name: string }

export interface SearchConfig {
  /** files.exclude + search.exclude, already merged (only `true` entries). */
  exclude: IExpression
  /** Only the files.exclude part of `exclude`; used when `disregardSearchExcludeSettings` is set. Optional. */
  filesExclude?: IExpression
  useIgnoreFiles: boolean
  useGlobalIgnoreFiles: boolean
  useParentIgnoreFiles: boolean
  followSymlinks: boolean
  smartCase: boolean
}

export interface QueryBuilderEnv {
  folders(): readonly SearchFolder[]
  config(): SearchConfig
  /** Paths of the files open in editors (for `onlyOpenEditors`). */
  openEditors(): readonly string[]
  /** 'win32' | 'posix': which path rules apply (separator, drive letters, case-insensitive compare on win32). */
  platform: 'win32' | 'posix'
  /** Home directory, to expand a leading `~` in the include/exclude fields. Optional. */
  userHome?: string
}

//#endregion

//#region Path operations

export interface PathOps {
  readonly sep: string
  isAbsolute(p: string): boolean
  /** Resolves `.` and `..`, collapses separators, uses the platform separator and drops a trailing one. */
  normalize(p: string): string
  join(...parts: string[]): string
  dirname(p: string): string
  basename(p: string): string
  relative(from: string, to: string): string
  isEqual(a: string, b: string): boolean
  isEqualOrParent(path: string, parent: string, ignoreCase?: boolean): boolean
}

export function createPathOps(platform: 'win32' | 'posix'): PathOps {
  const win = platform === 'win32'
  const sep = win ? '\\' : '/'

  const fold = (s: string, ignoreCase = win) => (ignoreCase ? s.toLowerCase() : s)

  /** Splits into the root (`/`, `c:\`, `c:`, `\\server\share\`, or empty) and the segments. */
  function split(p: string): { root: string; segs: string[] } {
    let s = win ? p.replace(/\//g, '\\') : p
    let root = ''
    if (win) {
      const unc = /^\\\\[^\\]+\\[^\\]+/.exec(s)
      if (unc) {
        root = unc[0] + '\\'
        s = s.slice(unc[0].length)
      } else {
        const drive = /^[a-zA-Z]:/.exec(s)
        if (drive) {
          root = drive[0]
          s = s.slice(2)
        }
        if (s.startsWith('\\')) {
          root += '\\'
        }
      }
    } else if (s.startsWith('/')) {
      root = '/'
    }
    const rooted = root.endsWith(sep)
    const segs: string[] = []
    for (const seg of s.split(sep)) {
      if (seg === '' || seg === '.') {
        continue
      }
      if (seg === '..') {
        if (segs.length && segs[segs.length - 1] !== '..') {
          segs.pop()
        } else if (!rooted) {
          segs.push('..')
        }
      } else {
        segs.push(seg)
      }
    }
    return { root, segs }
  }

  function normalize(p: string): string {
    if (p === '') {
      return '.'
    }
    const { root, segs } = split(p)
    const out = root + segs.join(sep)
    return out === '' ? '.' : out
  }

  function isAbsolute(p: string): boolean {
    return win ? /^([a-zA-Z]:)?[\\/]/.test(p) : p.startsWith('/')
  }

  return {
    sep,
    isAbsolute,
    normalize,
    join(...parts: string[]): string {
      const joined = parts.filter(part => part.length > 0).join(sep)
      return joined === '' ? '.' : normalize(joined)
    },
    dirname(p: string): string {
      const { root, segs } = split(p)
      if (!segs.length) {
        return root || '.'
      }
      const rest = root + segs.slice(0, -1).join(sep)
      return rest === '' ? '.' : rest
    },
    basename(p: string): string {
      const { segs } = split(p)
      return segs[segs.length - 1] ?? ''
    },
    relative(from: string, to: string): string {
      const a = split(from)
      const b = split(to)
      if (fold(a.root) !== fold(b.root)) {
        return normalize(to)
      }
      let i = 0
      while (i < a.segs.length && i < b.segs.length && fold(a.segs[i]!) === fold(b.segs[i]!)) {
        i++
      }
      return [...a.segs.slice(i).map(() => '..'), ...b.segs.slice(i)].join(sep)
    },
    isEqual(a: string, b: string): boolean {
      return fold(normalize(a)) === fold(normalize(b))
    },
    isEqualOrParent(path: string, parent: string, ignoreCase = win): boolean {
      const a = split(path)
      const b = split(parent)
      if (fold(a.root, ignoreCase) !== fold(b.root, ignoreCase) || b.segs.length > a.segs.length) {
        return false
      }
      return b.segs.every((seg, i) => fold(seg, ignoreCase) === fold(a.segs[i]!, ignoreCase))
    },
  }
}

//#endregion

//#region Types

/** One folder to search and a glob expression that should be applied. */
interface IOneSearchPathPattern {
  searchPath: string
  pattern?: string
}

/** One folder to search and a set of glob expressions that should be applied. */
export interface ISearchPathPattern {
  searchPath: string
  pattern?: IExpression
}

type ISearchPathPatternBuilder = string | string[]

export interface ISearchPatternBuilder {
  /** Absolute path of the folder the pattern is relative to. */
  folder?: string
  pattern: ISearchPathPatternBuilder
}

/** A set of search paths and a set of glob expressions that should be applied. */
export interface ISearchPathsInfo {
  searchPaths?: ISearchPathPattern[]
  pattern?: IExpression
}

interface ICommonQueryBuilderOptions {
  excludePattern?: ISearchPatternBuilder[]
  includePattern?: ISearchPathPatternBuilder
  /** Parse the special ./ syntax supported by the search view, and expand foo to **\/foo */
  expandPatterns?: boolean
  maxResults?: number
  maxFileSize?: number
  disregardIgnoreFiles?: boolean
  disregardGlobalIgnoreFiles?: boolean
  disregardParentIgnoreFiles?: boolean
  disregardExcludeSettings?: boolean
  disregardSearchExcludeSettings?: boolean
  ignoreSymlinks?: boolean
  ignoreGlobCase?: boolean
  onlyOpenEditors?: boolean
  /** Paths of the changed files; the query is restricted to them. */
  changedFiles?: string[]
  fileEncoding?: string
}

export interface ITextQueryBuilderOptions extends ICommonQueryBuilderOptions {
  previewOptions?: ITextSearchPreviewOptions
  surroundingContext?: number
  isSmartCase?: boolean
}

/** `ITextQuery` plus the fields the builder sets that `vscode-search.ts` does not declare. */
export interface BuiltTextQuery extends ITextQuery {
  usingSearchPaths?: boolean
  onlyOpenEditors?: boolean
  userDisabledExcludesAndIgnoreFiles?: boolean
}

/** What `commonQuery` returns (the part shared by every query type). */
interface ICommonQueryProps {
  folderQueries: IFolderQuery[]
  usingSearchPaths: boolean
  excludePattern?: IExpression
  includePattern?: IExpression
  ignoreGlobCase?: boolean
  onlyOpenEditors?: boolean
  maxResults?: number
}

//#endregion

export class QueryBuilder {
  private readonly env: QueryBuilderEnv
  private readonly ops: PathOps

  constructor(env: QueryBuilderEnv) {
    this.env = env
    this.ops = createPathOps(env.platform)
  }

  text(contentPattern: IPatternInfo, folderResources?: readonly (string | SearchFolder)[], options: ITextQueryBuilderOptions = {}): BuiltTextQuery {
    const pattern = this.getContentPattern(contentPattern, options)

    const commonQuery = this.commonQuery(folderResources?.map(f => this.toSearchFolder(f)), options)
    return {
      ...commonQuery,
      type: QueryType.Text,
      contentPattern: pattern,
      previewOptions: options.previewOptions,
      maxFileSize: options.maxFileSize,
      surroundingContext: options.surroundingContext,
      userDisabledExcludesAndIgnoreFiles: options.disregardExcludeSettings && options.disregardIgnoreFiles,
    }
  }

  private toSearchFolder(folder: string | SearchFolder): SearchFolder {
    return typeof folder === 'string' ? { path: folder, name: this.ops.basename(folder) } : folder
  }

  /**
   * Adjusts input pattern for config
   */
  private getContentPattern(inputPattern: IPatternInfo, options: ITextQueryBuilderOptions): IPatternInfo {
    const newPattern: IPatternInfo = { ...inputPattern }

    if (inputPattern.isRegExp) {
      newPattern.pattern = inputPattern.pattern.replace(/\r?\n/g, '\\n')
    }

    if (this.isCaseSensitive(inputPattern, options)) {
      newPattern.isCaseSensitive = true
    }

    if (this.isMultiline(newPattern)) {
      newPattern.isMultiline = true
    }

    return newPattern
  }

  private handleIncludeExclude(pattern: string | string[] | undefined, expandPatterns: boolean | undefined): ISearchPathsInfo {
    if (!pattern) {
      return {}
    }

    if (Array.isArray(pattern)) {
      pattern = pattern.filter(p => p.length > 0).map(normalizeSlashes)
      if (!pattern.length) {
        return {}
      }
    } else {
      pattern = normalizeSlashes(pattern)
    }
    return expandPatterns
      ? this.parseSearchPaths(pattern)
      : { pattern: patternListToIExpression(...(Array.isArray(pattern) ? pattern : [pattern])) }
  }

  private commonQuery(folderResources: SearchFolder[] = [], options: ICommonQueryBuilderOptions = {}): ICommonQueryProps {
    let excludePatterns: string | string[] | undefined = Array.isArray(options.excludePattern) ? options.excludePattern.map(p => p.pattern).flat() : undefined
    excludePatterns = excludePatterns?.length === 1 ? excludePatterns[0] : excludePatterns
    const includeSearchPathsInfo: ISearchPathsInfo = this.handleIncludeExclude(options.includePattern, options.expandPatterns)
    const excludeSearchPathsInfo: ISearchPathsInfo = escapeExcludeExceptions(this.handleIncludeExclude(excludePatterns, options.expandPatterns))

    // Build folderQueries from searchPaths, if given, otherwise folderResources
    const includeFolderName = folderResources.length > 1
    const folderQueries = (includeSearchPathsInfo.searchPaths && includeSearchPathsInfo.searchPaths.length ?
      includeSearchPathsInfo.searchPaths.map(searchPath => this.getFolderQueryForSearchPath(searchPath, options, excludeSearchPathsInfo)) :
      folderResources.map(folder => this.getFolderQueryForRoot(folder, options, excludeSearchPathsInfo, includeFolderName)))
      .filter(query => !!query) as IFolderQuery[]

    const queryProps: ICommonQueryProps = {
      folderQueries,
      usingSearchPaths: !!(includeSearchPathsInfo.searchPaths && includeSearchPathsInfo.searchPaths.length),

      excludePattern: excludeSearchPathsInfo.pattern,
      includePattern: includeSearchPathsInfo.pattern,
      ignoreGlobCase: options.ignoreGlobCase,
      onlyOpenEditors: options.onlyOpenEditors,
      maxResults: options.maxResults,
    }

    if (options.onlyOpenEditors) {
      const openEditors = this.env.openEditors().filter(p => !!p)
      const openEditorsInQuery = openEditors.filter(editor => this.pathIncludedInQuery(queryProps, editor))
      const openEditorsQueryProps = this.commonQueryFromFileList(openEditorsInQuery)
      return { ...queryProps, ...openEditorsQueryProps }
    }

    if (options.changedFiles !== undefined) {
      const changedFilesInQuery = options.changedFiles.filter(file => this.pathIncludedInQuery(queryProps, file))
      const changedFilesQueryProps = this.commonQueryFromFileList(changedFilesInQuery)
      return { ...queryProps, ...changedFilesQueryProps }
    }

    return queryProps
  }

  private commonQueryFromFileList(files: string[]): ICommonQueryProps {
    const folderQueries: IFolderQuery[] = []
    const foldersToSearch = new Map<string, IFolderQuery>()
    const includePattern: IExpression = {}
    let hasIncludedFile = false
    const workspaceFolders = this.env.folders()
    files.forEach(file => {
      if (this.ops.isAbsolute(file)) {
        // the deepest open folder that contains the file, else the file's own folder
        const owning = workspaceFolders
          .filter(folder => this.ops.isEqualOrParent(file, folder.path))
          .sort((a, b) => b.path.length - a.path.length)[0]
        const searchRoot = owning ? owning.path : this.ops.dirname(file)

        const normalizedRoot = this.ops.normalize(searchRoot)
        const key = this.env.platform === 'win32' ? normalizedRoot.toLowerCase() : normalizedRoot
        let folderQuery = foldersToSearch.get(key)
        if (!folderQuery) {
          hasIncludedFile = true
          folderQuery = { folder: searchRoot, includePattern: {} }
          folderQueries.push(folderQuery)
          foldersToSearch.set(key, folderQuery)
        }

        const relPath = this.ops.relative(searchRoot, file)
        folderQuery.includePattern![escapeGlobPattern(relPath.replace(/\\/g, '/'))] = true
      } else if (file) {
        hasIncludedFile = true
        includePattern[escapeGlobPattern(file)] = true
      }
    })

    return {
      folderQueries,
      includePattern,
      usingSearchPaths: true,
      excludePattern: hasIncludedFile ? undefined : { '**/*': true },
    }
  }

  /**
   * Whether a file passes the query's global include/exclude expressions and search paths (`pathIncludedInQuery` of search.ts).
   */
  private pathIncludedInQuery(queryProps: ICommonQueryProps, fsPath: string): boolean {
    const globOptions = queryProps.ignoreGlobCase ? { ignoreCase: true } : undefined
    if (queryProps.excludePattern && withoutExceptions(queryProps.excludePattern, globOptions)(fsPath)) {
      return false
    }

    if (queryProps.includePattern || queryProps.usingSearchPaths) {
      if (queryProps.includePattern && parse(queryProps.includePattern, globOptions)(fsPath)) {
        return true
      }

      // If searchPaths are being used, the file must be in a subfolder and match the pattern, if present
      if (queryProps.usingSearchPaths) {
        return queryProps.folderQueries.some(fq => {
          const searchPath = fq.folder
          if (this.ops.isEqualOrParent(fsPath, searchPath, this.env.platform === 'win32' || !!queryProps.ignoreGlobCase)) {
            const relPath = this.ops.relative(searchPath, fsPath)
            return !fq.includePattern || !!parse(fq.includePattern, globOptions)(relPath)
          }
          return false
        })
      }

      return false
    }

    return true
  }

  /**
   * Resolve isCaseSensitive flag based on the query and the isSmartCase flag, for search providers that don't support smart case natively.
   */
  private isCaseSensitive(contentPattern: IPatternInfo, options: ITextQueryBuilderOptions): boolean {
    if (options.isSmartCase ?? this.env.config().smartCase) {
      if (contentPattern.isRegExp) {
        // Consider it case sensitive if it contains an unescaped capital letter
        if (containsUppercaseCharacter(contentPattern.pattern, true)) {
          return true
        }
      } else if (containsUppercaseCharacter(contentPattern.pattern)) {
        return true
      }
    }

    return !!contentPattern.isCaseSensitive
  }

  private isMultiline(contentPattern: IPatternInfo): boolean {
    if (contentPattern.isMultiline) {
      return true
    }

    if (contentPattern.isRegExp && isMultilineRegexSource(contentPattern.pattern)) {
      return true
    }

    return contentPattern.pattern.indexOf('\n') >= 0
  }

  /**
   * Take the includePattern as seen in the search viewlet, and split into components that look like searchPaths, and
   * glob patterns. Glob patterns are expanded from 'foo/bar' to '{foo/bar/**, **\/foo/bar}.
   *
   * Public for test.
   */
  parseSearchPaths(pattern: string | string[]): ISearchPathsInfo {
    const isSearchPath = (segment: string) => {
      // A segment is a search path if it is an absolute path or starts with ./, ../, .\, or ..\
      return this.ops.isAbsolute(segment) || /^\.\.?([\/\\]|$)/.test(segment)
    }

    const patterns = Array.isArray(pattern) ? pattern : splitGlobPattern(pattern)
    const userHome = this.env.userHome
    const segments = patterns.map(segment => (userHome ? untildify(segment, userHome) : segment))
    const searchPathSegments: string[] = []
    const exprSegments: string[] = []
    for (const segment of segments) {
      (isSearchPath(segment) ? searchPathSegments : exprSegments).push(segment)
    }

    const expandedExprSegments = exprSegments
      .map(s => rtrim(s, '/'))
      .map(s => rtrim(s, '\\'))
      .map(p => {
        if (p[0] === '.') {
          p = '*' + p // convert ".js" to "*.js"
        }

        return expandGlobalGlob(p)
      })

    const result: ISearchPathsInfo = {}
    const searchPaths = this.expandSearchPathPatterns(searchPathSegments)
    if (searchPaths && searchPaths.length) {
      result.searchPaths = searchPaths
    }

    const includePattern = patternListToIExpression(...expandedExprSegments.flat())
    if (includePattern) {
      result.pattern = includePattern
    }

    return result
  }

  private getExcludesForFolder(config: SearchConfig, options: ICommonQueryBuilderOptions): IExpression | undefined {
    if (options.disregardExcludeSettings) {
      return undefined
    }
    return options.disregardSearchExcludeSettings && config.filesExclude ? config.filesExclude : config.exclude
  }

  /**
   * Split search paths (./ or ../ or absolute paths in the includePatterns) into absolute paths and globs applied to those paths
   */
  private expandSearchPathPatterns(searchPaths: string[]): ISearchPathPattern[] {
    if (!searchPaths || !searchPaths.length) {
      // No workspace => ignore search paths
      return []
    }

    const expandedSearchPaths = searchPaths.flatMap(searchPath => {
      // 1 open folder => just resolve the search paths to absolute paths
      let { pathPortion, globPortion } = splitGlobFromPath(searchPath)

      if (globPortion) {
        globPortion = normalizeGlobPattern(globPortion)
      }

      // One pathPortion to multiple expanded search paths (e.g. duplicate matching workspace folders)
      const oneExpanded = this.expandOneSearchPath(pathPortion)

      // Expanded search paths to multiple resolved patterns (with ** and without)
      return oneExpanded.flatMap(oneExpandedResult => this.resolveOneSearchPathPattern(oneExpandedResult, globPortion))
    })

    const searchPathPatternMap = new Map<string, ISearchPathPattern>()
    expandedSearchPaths.forEach(oneSearchPathPattern => {
      const key = this.env.platform === 'win32' ? oneSearchPathPattern.searchPath.toLowerCase() : oneSearchPathPattern.searchPath
      const existing = searchPathPatternMap.get(key)
      if (existing) {
        if (oneSearchPathPattern.pattern) {
          existing.pattern = existing.pattern || {}
          existing.pattern[oneSearchPathPattern.pattern] = true
        }
      } else {
        searchPathPatternMap.set(key, {
          searchPath: oneSearchPathPattern.searchPath,
          pattern: oneSearchPathPattern.pattern ? patternListToIExpression(oneSearchPathPattern.pattern) : undefined,
        })
      }
    })

    return Array.from(searchPathPatternMap.values())
  }

  /**
   * Takes a searchPath like `./a/foo` or `../a/foo` and expands it to absolute paths for all the workspaces it matches.
   */
  private expandOneSearchPath(searchPath: string): IOneSearchPathPattern[] {
    if (this.ops.isAbsolute(searchPath)) {
      // TODO (as in VS Code) convert this to a workspace folder + pattern, so excludes will be resolved properly for an absolute path inside a workspace folder
      return [{
        searchPath: this.ops.normalize(searchPath),
      }]
    }

    const folders = this.env.folders()
    const onlyFolder = folders.length === 1 ? folders[0] : undefined
    if (onlyFolder) {
      const workspacePath = onlyFolder.path

      searchPath = normalizeSlashes(searchPath)
      if (searchPath.startsWith('../') || searchPath === '..') {
        return [{
          searchPath: this.ops.join(workspacePath, searchPath),
        }]
      }

      const cleanedPattern = normalizeGlobPattern(searchPath)
      return [{
        searchPath: workspacePath,
        pattern: cleanedPattern,
      }]
    } else if (searchPath === './' || searchPath === '.\\') {
      return [] // ./ or ./**/foo makes sense for single-folder but not multi-folder workspaces
    } else {
      const searchPathWithoutDotSlash = searchPath.replace(/^\.[\/\\]/, '')
      const folderMatches: { match: RegExpMatchArray; folder: SearchFolder }[] = []
      for (const folder of folders) {
        const match = searchPathWithoutDotSlash.match(new RegExp(`^${escapeRegExpCharacters(folder.name)}(?:/(.*)|$)`))
        if (match) {
          folderMatches.push({ match, folder })
        }
      }

      if (folderMatches.length) {
        return folderMatches.map(match => {
          const patternMatch = match.match[1]
          return {
            searchPath: match.folder.path,
            pattern: patternMatch && normalizeGlobPattern(patternMatch),
          }
        })
      } else {
        const probableWorkspaceFolderNameMatch = searchPath.match(/\.[\/\\](.+)[\/\\]?/)
        const probableWorkspaceFolderName = probableWorkspaceFolderNameMatch ? probableWorkspaceFolderNameMatch[1] : searchPath

        // No root folder with name
        throw new Error(`A pasta do projeto não existe: ${probableWorkspaceFolderName}`)
      }
    }
  }

  private resolveOneSearchPathPattern(oneExpandedResult: IOneSearchPathPattern, globPortion?: string): IOneSearchPathPattern[] {
    const pattern = oneExpandedResult.pattern && globPortion ?
      `${oneExpandedResult.pattern}/${globPortion}` :
      oneExpandedResult.pattern || globPortion

    const results: IOneSearchPathPattern[] = [
      {
        searchPath: oneExpandedResult.searchPath,
        pattern,
      }]

    if (pattern && !pattern.endsWith('**')) {
      results.push({
        searchPath: oneExpandedResult.searchPath,
        pattern: pattern + '/**',
      })
    }

    return results
  }

  private getFolderQueryForSearchPath(searchPath: ISearchPathPattern, options: ICommonQueryBuilderOptions, searchPathExcludes: ISearchPathsInfo): IFolderQuery | null {
    const rootConfig = this.getFolderQueryForRoot({ path: searchPath.searchPath, name: this.ops.basename(searchPath.searchPath) }, options, searchPathExcludes, false)
    if (!rootConfig) {
      return null
    }

    return {
      ...rootConfig,
      ...{
        includePattern: searchPath.pattern,
      },
    }
  }

  private getFolderQueryForRoot(folder: SearchFolder, options: ICommonQueryBuilderOptions, searchPathExcludes: ISearchPathsInfo, includeFolderName: boolean): IFolderQuery | null {
    let thisFolderExcludeSearchPathPattern: IExpression | undefined
    const folderPath = folder.path

    // the folder an exclude pattern is relative to, if the caller gave one
    let excludeFolderRoots: (string | undefined)[] | undefined = options.excludePattern?.map(excludePattern => excludePattern.folder)

    if (!excludeFolderRoots?.length) {
      excludeFolderRoots = [undefined]
    }

    if (searchPathExcludes.searchPaths) {
      const thisFolderExcludeSearchPath = searchPathExcludes.searchPaths.filter(sp => this.ops.isEqual(sp.searchPath, folderPath))[0]
      if (thisFolderExcludeSearchPath && !thisFolderExcludeSearchPath.pattern) {
        // entire folder is excluded
        return null
      } else if (thisFolderExcludeSearchPath) {
        thisFolderExcludeSearchPathPattern = thisFolderExcludeSearchPath.pattern
      }
    }

    const config = this.env.config()
    const settingExcludes = this.getExcludesForFolder(config, options)
    const excludePattern: IExpression = {
      ...(settingExcludes || {}),
      ...(thisFolderExcludeSearchPathPattern || {}),
    }

    const excludePatternRet: ExcludeGlobPattern[] = excludeFolderRoots.map(excludeFolderRoot => {
      return Object.keys(excludePattern).length > 0 ? {
        folder: excludeFolderRoot,
        pattern: excludePattern,
      } satisfies ExcludeGlobPattern : undefined
    }).filter((e) => e) as ExcludeGlobPattern[]

    return {
      folder: folderPath,
      folderName: includeFolderName ? folder.name : undefined,
      excludePattern: excludePatternRet,
      fileEncoding: options.fileEncoding,
      disregardIgnoreFiles: typeof options.disregardIgnoreFiles === 'boolean' ? options.disregardIgnoreFiles : !config.useIgnoreFiles,
      disregardGlobalIgnoreFiles: typeof options.disregardGlobalIgnoreFiles === 'boolean' ? options.disregardGlobalIgnoreFiles : !config.useGlobalIgnoreFiles,
      disregardParentIgnoreFiles: typeof options.disregardParentIgnoreFiles === 'boolean' ? options.disregardParentIgnoreFiles : !config.useParentIgnoreFiles,
      ignoreSymlinks: typeof options.ignoreSymlinks === 'boolean' ? options.ignoreSymlinks : !config.followSymlinks,
      ignoreGlobCase: options.ignoreGlobCase,
    }
  }
}

//#region Helpers

function splitGlobFromPath(searchPath: string): { pathPortion: string; globPortion?: string } {
  const globCharMatch = searchPath.match(/[\*\{\}\(\)\[\]\?]/)
  if (globCharMatch) {
    const globCharIdx = globCharMatch.index
    const lastSlashMatch = searchPath.substring(0, globCharIdx).match(/[/|\\][^/\\]*$/)
    if (lastSlashMatch) {
      const slashIdx = lastSlashMatch.index ?? 0
      let pathPortion = searchPath.substring(0, slashIdx)
      if (!pathPortion.match(/[/\\]/)) {
        // If the last slash was the only slash, then we now have '' or 'C:' or '.'. Append a slash.
        pathPortion += '/'
      }

      return {
        pathPortion,
        globPortion: searchPath.substring(slashIdx + 1),
      }
    }
  }

  // No glob char, or malformed
  return {
    pathPortion: searchPath,
  }
}

function patternListToIExpression(...patterns: string[]): IExpression | undefined {
  return patterns.length ?
    patterns.reduce((glob: IExpression, cur) => { glob[cur] = true; return glob }, Object.create(null) as IExpression) :
    undefined
}

const EXCLUDE_EXCEPTION_PREFIX = '!'

function isExcludeException(pattern: string): boolean {
  return pattern.trimStart().startsWith(EXCLUDE_EXCEPTION_PREFIX)
}

/** `!foo` becomes `{!}foo`, which matches a literal `!`. */
function escapeExcludeException(pattern: string): string {
  const trimmed = pattern.trimStart()
  return trimmed.startsWith(EXCLUDE_EXCEPTION_PREFIX) ? `{!}${trimmed.substring(EXCLUDE_EXCEPTION_PREFIX.length)}` : pattern
}

function withoutExceptions(expression: IExpression, globOptions: { ignoreCase: boolean } | undefined): (path: string) => boolean {
  const kept: IExpression = {}
  for (const key of Object.keys(expression)) {
    if (!isExcludeException(key)) {
      kept[key] = expression[key]!
    }
  }
  const parsed = parse(kept, globOptions)
  return path => typeof parsed(path) === 'string'
}

/**
 * Exclude patterns from the search input or the extension API are not settings, so a
 * leading `!` matches literally instead of being an exclude exception.
 */
function escapeExcludeExceptions(info: ISearchPathsInfo): ISearchPathsInfo {
  return {
    ...info,
    pattern: escapeExcludeExceptionKeys(info.pattern),
    searchPaths: info.searchPaths?.map(searchPath => ({ ...searchPath, pattern: escapeExcludeExceptionKeys(searchPath.pattern) })),
  }
}

function escapeExcludeExceptionKeys(expression: IExpression | undefined): IExpression | undefined {
  if (!expression || !Object.keys(expression).some(isExcludeException)) {
    return expression
  }

  const escaped: IExpression = Object.create(null)
  for (const key of Object.keys(expression)) {
    escaped[escapeExcludeException(key)] = expression[key]!
  }

  return escaped
}

function splitGlobPattern(pattern: string): string[] {
  return splitGlobAware(pattern, ',')
    .map(s => s.trim())
    .filter(s => !!s.length)
}

/**
 * Note - we used {} here previously but ripgrep can't handle nested {} patterns. See https://github.com/microsoft/vscode/issues/32761
 */
function expandGlobalGlob(pattern: string): string[] {
  const patterns = [
    `**/${pattern}/**`,
    `**/${pattern}`,
  ]

  return patterns.map(p => p.replace(/\*\*\/\*\*/g, '**'))
}

function normalizeSlashes(pattern: string): string {
  return pattern.replace(/\\/g, '/')
}

/**
 * Normalize slashes, remove `./` and trailing slashes
 */
function normalizeGlobPattern(pattern: string): string {
  return normalizeSlashes(pattern)
    .replace(/^\.\//, '')
    .replace(/\/+$/g, '')
}

/**
 * Escapes a path for use as a glob pattern that would match the input precisely.
 * Characters '?', '*', '[', and ']' are escaped into character range glob syntax
 * (for example, '?' becomes '[?]').
 * NOTE: This implementation makes no special cases for UNC paths. For example,
 * given the input "//?/C:/A?.txt", this would produce output '//[?]/C:/A[?].txt',
 * which may not be desirable in some cases. Use with caution if UNC paths could be expected.
 */
export function escapeGlobPattern(path: string): string {
  return path.replace(/([?*[\]])/g, '[$1]')
}

// --- strings.ts, labels.ts, textModelSearch.ts ---

function escapeRegExpCharacters(value: string): string {
  return value.replace(/[\\{}*+?|^$.[\]()]/g, '\\$&')
}

function rtrim(haystack: string, needle: string): string {
  if (!haystack || !needle) {
    return haystack
  }

  const needleLen = needle.length
  const haystackLen = haystack.length

  if (needleLen === 0 || haystackLen === 0) {
    return haystack
  }

  let offset = haystackLen
  let idx = -1

  while (true) {
    idx = haystack.lastIndexOf(needle, offset - 1)
    if (idx === -1 || idx + needleLen !== offset) {
      break
    }
    if (idx === 0) {
      return ''
    }
    offset = idx
  }

  return haystack.substring(0, offset)
}

function containsUppercaseCharacter(target: string, ignoreEscapedChars = false): boolean {
  if (!target) {
    return false
  }

  if (ignoreEscapedChars) {
    target = target.replace(/\\./g, '')
  }

  return target.toLowerCase() !== target
}

function untildify(path: string, userHome: string): string {
  return path.replace(/^~($|\/|\\)/, `${userHome}$1`)
}

function isMultilineRegexSource(searchString: string): boolean {
  if (!searchString || searchString.length === 0) {
    return false
  }

  for (let i = 0, len = searchString.length; i < len; i++) {
    const chCode = searchString.charCodeAt(i)

    if (chCode === 10 /* LineFeed */) {
      return true
    }

    if (chCode === 92 /* Backslash */) {

      // move to next char
      i++

      if (i >= len) {
        // string ends with a \
        break
      }

      const nextChCode = searchString.charCodeAt(i)
      if (nextChCode === 110 /* n */ || nextChCode === 114 /* r */ || nextChCode === 87 /* W */) {
        return true
      }
    }
  }

  return false
}

//#endregion
