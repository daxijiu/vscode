/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { getErrorMessage } from '../../../../../base/common/errors.js';
import { getMediaMime } from '../../../../../base/common/mime.js';
import { Schemas } from '../../../../../base/common/network.js';
import { extUriBiasedIgnorePathCase, relativePath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileContent, IFileService, IFileStat } from '../../../../../platform/files/common/files.js';
import { IMarker, IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ISCMRepository, ISCMResource, ISCMService } from '../../../scm/common/scm.js';
import { detectEncodingFromBuffer } from '../../../../services/textfile/common/encoding.js';
import { IFileMatch, ITextSearchMatch, ISearchService, QueryType, resultIsMatch } from '../../../../services/search/common/search.js';
import { CountTokensCallback, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolProgress } from '../../../chat/common/tools/languageModelToolsService.js';

export const DirectorReadFileToolId = 'director_read_file';
export const DirectorListDirectoryToolId = 'director_list_dir';
export const DirectorFileSearchToolId = 'director_file_search';
export const DirectorGrepSearchToolId = 'director_grep_search';
export const DirectorGetErrorsToolId = 'director_get_errors';
export const DirectorGetChangedFilesToolId = 'director_get_changed_files';
export const DirectorViewImageToolId = 'director_view_image';
export const DirectorGithubRepoToolId = 'director_github_repo';

const DEFAULT_MAX_TEXT_BYTES = 200_000;
const HARD_MAX_TEXT_BYTES = 1_000_000;
const DEFAULT_MAX_RESULTS = 50;
const HARD_MAX_RESULTS = 200;
const DEFAULT_GREP_CONTEXT_LINES = 2;

type ToolParams = Record<string, unknown>;

export const DirectorReadFileToolData: IToolData = {
	id: DirectorReadFileToolId,
	toolReferenceName: 'readFile',
	displayName: 'Read File',
	userDescription: 'Read a text file from the current workspace.',
	modelDescription: 'Read a text file from the current workspace. Use workspace-relative paths. The result is truncated for large files and binary files are rejected.',
	source: ToolDataSource.Internal,
	canRequestPreApproval: false,
	canRequestPostApproval: false,
	inputSchema: {
		type: 'object',
		properties: {
			filePath: { type: 'string', description: 'Workspace-relative file path to read.' },
			startLine: { type: 'number', description: 'Optional 1-based first line to include.' },
			endLine: { type: 'number', description: 'Optional 1-based last line to include.' },
			maxBytes: { type: 'number', description: 'Maximum bytes to return before truncating. Defaults to 200000.' },
		},
		required: ['filePath']
	}
};

export const DirectorListDirectoryToolData: IToolData = {
	id: DirectorListDirectoryToolId,
	toolReferenceName: 'listDirectory',
	displayName: 'List Directory',
	userDescription: 'List files and folders in a workspace directory.',
	modelDescription: 'List files and folders in a workspace directory. Use workspace-relative paths. The result is capped and sorted.',
	source: ToolDataSource.Internal,
	canRequestPreApproval: false,
	canRequestPostApproval: false,
	inputSchema: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Workspace-relative directory path. Use "." for the workspace root.' },
			maxResults: { type: 'number', description: 'Maximum entries to return. Defaults to 50, hard limit 200.' },
		},
		required: ['path']
	}
};

export const DirectorFileSearchToolData: IToolData = {
	id: DirectorFileSearchToolId,
	toolReferenceName: 'fileSearch',
	displayName: 'File Search',
	userDescription: 'Find files in the current workspace by name or glob.',
	modelDescription: 'Find files in the current workspace by filename pattern. Searches are read-only, capped, and scoped to workspace folders.',
	source: ToolDataSource.Internal,
	canRequestPreApproval: false,
	canRequestPostApproval: false,
	inputSchema: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'File name fragment or glob pattern to search for.' },
			include: { type: 'string', description: 'Optional include glob pattern.' },
			exclude: { type: 'string', description: 'Optional exclude glob pattern.' },
			maxResults: { type: 'number', description: 'Maximum results to return. Defaults to 50, hard limit 200.' },
		},
		required: ['query']
	}
};

export const DirectorGrepSearchToolData: IToolData = {
	id: DirectorGrepSearchToolId,
	toolReferenceName: 'textSearch',
	displayName: 'Text Search',
	userDescription: 'Search file contents in the current workspace.',
	modelDescription: 'Search text in workspace files. Searches are read-only, capped, and scoped to workspace folders. Use includePattern/excludePattern globs to narrow the search.',
	source: ToolDataSource.Internal,
	canRequestPreApproval: false,
	canRequestPostApproval: false,
	inputSchema: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'Text or regular expression to search for.' },
			isRegexp: { type: 'boolean', description: 'Treat query as a regular expression.' },
			isCaseSensitive: { type: 'boolean', description: 'Use case-sensitive matching.' },
			includePattern: { type: 'string', description: 'Optional include glob pattern.' },
			excludePattern: { type: 'string', description: 'Optional exclude glob pattern.' },
			includeIgnoredFiles: { type: 'boolean', description: 'Include files that ignore files would normally exclude.' },
			maxResults: { type: 'number', description: 'Maximum file matches to return. Defaults to 50, hard limit 200.' },
		},
		required: ['query']
	}
};

export const DirectorGetErrorsToolData: IToolData = {
	id: DirectorGetErrorsToolId,
	toolReferenceName: 'problems',
	displayName: 'Problems',
	userDescription: 'Read workspace diagnostics and problems.',
	modelDescription: 'Read current workspace diagnostics. Returns errors by default and optionally warnings. Does not run builds or mutate files.',
	source: ToolDataSource.Internal,
	canRequestPreApproval: false,
	canRequestPostApproval: false,
	inputSchema: {
		type: 'object',
		properties: {
			filePaths: { type: 'array', items: { type: 'string' }, description: 'Optional workspace-relative files or folders to filter diagnostics.' },
			includeWarnings: { type: 'boolean', description: 'Include warnings as well as errors. Defaults to true.' },
			maxResults: { type: 'number', description: 'Maximum diagnostics to return. Defaults to 50, hard limit 200.' },
		}
	}
};

export const DirectorGetChangedFilesToolData: IToolData = {
	id: DirectorGetChangedFilesToolId,
	toolReferenceName: 'changes',
	displayName: 'Changes',
	userDescription: 'Read current source-control changes.',
	modelDescription: 'Read the current SCM resource groups and changed files. Returns controlled not-supported text if no SCM provider is available.',
	source: ToolDataSource.Internal,
	canRequestPreApproval: false,
	canRequestPostApproval: false,
	inputSchema: {
		type: 'object',
		properties: {
			repositoryPath: { type: 'string', description: 'Optional workspace-relative repository root path to filter SCM resources.' },
			sourceControlState: { type: 'array', items: { type: 'string' }, description: 'Optional SCM state, group, or status labels to include.' },
			maxResults: { type: 'number', description: 'Maximum changed resources to return. Defaults to 50, hard limit 200.' },
		}
	}
};

export const DirectorViewImageToolData: IToolData = {
	id: DirectorViewImageToolId,
	toolReferenceName: 'viewImage',
	displayName: 'View Image',
	userDescription: 'Inspect an image file in the workspace.',
	modelDescription: 'Read an image file from the workspace and return image metadata with an image data part when supported. Use workspace-relative paths.',
	source: ToolDataSource.Internal,
	canRequestPreApproval: false,
	canRequestPostApproval: false,
	inputSchema: {
		type: 'object',
		properties: {
			filePath: { type: 'string', description: 'Workspace-relative image path.' },
		},
		required: ['filePath']
	}
};

export const DirectorGithubRepoToolData: IToolData = {
	id: DirectorGithubRepoToolId,
	toolReferenceName: 'githubRepo',
	displayName: 'GitHub Repository Context',
	userDescription: 'Read minimal GitHub repository context.',
	modelDescription: 'Return minimal read-only GitHub repository context from an explicit owner/repo, GitHub URL, or workspace Git remotes. Remote indexed search and PR/issue mutation are intentionally not supported in v1.',
	source: ToolDataSource.Internal,
	canRequestPreApproval: false,
	canRequestPostApproval: false,
	inputSchema: {
		type: 'object',
		properties: {
			repo: { type: 'string', description: 'Optional owner/repo or GitHub repository URL.' },
			query: { type: 'string', description: 'Optional search query. v1 returns a controlled not-supported result for remote GitHub search.' },
		}
	}
};

export const DirectorReadOnlyToolData = [
	DirectorReadFileToolData,
	DirectorListDirectoryToolData,
	DirectorFileSearchToolData,
	DirectorGrepSearchToolData,
	DirectorGetErrorsToolData,
	DirectorGetChangedFilesToolData,
	DirectorViewImageToolData,
	DirectorGithubRepoToolData,
] as const;

export class DirectorReadFileTool implements IToolImpl {
	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) { }

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as ToolParams;
		const resolved = resolveWorkspacePath(this.workspaceContextService, invocation.context?.workingDirectory, stringParam(params, 'filePath') ?? stringParam(params, 'path'));
		if (!resolved.ok) {
			return textResult(resolved.message);
		}

		let stat: IFileStat;
		try {
			stat = await this.fileService.resolve(resolved.uri, { resolveMetadata: true });
		} catch (error) {
			return textResult(`Cannot read ${resolved.relativePath}: ${getErrorMessage(error)}`);
		}
		if (stat.isDirectory) {
			return textResult(`${resolved.relativePath} is a directory. Use listDirectory for directories and readFile for text files.`);
		}

		let content: IFileContent;
		try {
			content = await this.fileService.readFile(resolved.uri, undefined, token);
		} catch (error) {
			return textResult(`Cannot read ${resolved.relativePath}: ${getErrorMessage(error)}`);
		}
		const detected = detectEncodingFromBuffer({ buffer: content.value, bytesRead: content.value.byteLength });
		if (detected.seemsBinary) {
			return textResult(`Cannot read ${resolved.relativePath}: binary files are not returned by readFile.`);
		}

		const maxBytes = boundedNumber(params.maxBytes, DEFAULT_MAX_TEXT_BYTES, HARD_MAX_TEXT_BYTES);
		const truncatedByBytes = content.value.byteLength > maxBytes;
		let text = content.value.slice(0, maxBytes).toString();
		const startLine = positiveNumber(params.startLine);
		const endLine = positiveNumber(params.endLine);
		let lineNote = '';
		if (startLine !== undefined || endLine !== undefined) {
			const lines = text.split(/\r\n|\r|\n/);
			const start = Math.max(1, startLine ?? 1);
			const end = Math.min(lines.length, Math.max(start, endLine ?? lines.length));
			text = lines.slice(start - 1, end).join('\n');
			lineNote = `\nlines: ${start}-${end}`;
		}

		return textResult(`path: ${resolved.relativePath}\nsize: ${content.value.byteLength} bytes\ntruncated: ${truncatedByBytes}${lineNote}\n\n${text}`);
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext): Promise<IPreparedToolInvocation | undefined> {
		return { invocationMessage: `Reading ${stringParam(context.parameters, 'filePath') ?? stringParam(context.parameters, 'path') ?? 'file'}` };
	}
}

export class DirectorListDirectoryTool implements IToolImpl {
	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) { }

	async invoke(invocation: IToolInvocation): Promise<IToolResult> {
		const params = invocation.parameters as ToolParams;
		const resolved = resolveWorkspacePath(this.workspaceContextService, invocation.context?.workingDirectory, stringParam(params, 'path') ?? '.');
		if (!resolved.ok) {
			return textResult(resolved.message);
		}

		const stat = await this.fileService.resolve(resolved.uri, { resolveMetadata: true });
		if (!stat.isDirectory) {
			return textResult(`${resolved.relativePath} is not a directory.`);
		}

		const maxResults = boundedNumber(params.maxResults, DEFAULT_MAX_RESULTS, HARD_MAX_RESULTS);
		const children = (stat.children ?? []).slice().sort(compareFileStats);
		const visible = children.slice(0, maxResults);
		const rows = visible.map(child => `${child.isDirectory ? 'dir ' : child.isFile ? 'file' : 'item'}\t${child.name}${child.isDirectory ? '/' : ''}\t${child.size ?? 0} bytes`);
		const truncated = children.length > visible.length;
		return textResult(`path: ${resolved.relativePath}\nentries: ${children.length}\ntruncated: ${truncated}\n\n${rows.join('\n') || '(empty directory)'}`);
	}
}

export class DirectorFileSearchTool implements IToolImpl {
	constructor(
		@ISearchService private readonly searchService: ISearchService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) { }

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as ToolParams;
		const queryText = stringParam(params, 'query');
		if (!queryText) {
			return textResult('fileSearch requires a non-empty query.');
		}

		const roots = workspaceRoots(this.workspaceContextService, invocation.context?.workingDirectory);
		if (!roots.length) {
			return textResult('fileSearch is unavailable because no workspace folder is open.');
		}

		const maxResults = boundedNumber(params.maxResults, DEFAULT_MAX_RESULTS, HARD_MAX_RESULTS);
		const complete = await this.searchService.fileSearch({
			type: QueryType.File,
			folderQueries: roots.map(folder => ({ folder })),
			filePattern: queryText,
			includePattern: globExpression(stringParam(params, 'include')),
			excludePattern: globExpression(stringParam(params, 'exclude')),
			maxResults,
			sortByScore: true,
		}, token);

		const results = complete.results
			.map(match => formatUri(this.workspaceContextService, match.resource))
			.sort()
			.slice(0, maxResults);

		return textResult(`query: ${queryText}\nresults: ${results.length}\nlimitHit: ${complete.limitHit === true}\n\n${results.join('\n') || '(no matches)'}`);
	}
}

export class DirectorGrepSearchTool implements IToolImpl {
	constructor(
		@ISearchService private readonly searchService: ISearchService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) { }

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as ToolParams;
		const queryText = stringParam(params, 'query');
		if (!queryText) {
			return textResult('textSearch requires a non-empty query.');
		}

		const roots = workspaceRoots(this.workspaceContextService, invocation.context?.workingDirectory);
		if (!roots.length) {
			return textResult('textSearch is unavailable because no workspace folder is open.');
		}

		const maxResults = boundedNumber(params.maxResults, DEFAULT_MAX_RESULTS, HARD_MAX_RESULTS);
		const includeIgnoredFiles = booleanParam(params, 'includeIgnoredFiles') === true;
		const complete = await this.searchService.textSearch({
			type: QueryType.Text,
			folderQueries: roots.map(folder => ({
				folder,
				disregardIgnoreFiles: includeIgnoredFiles,
				disregardGlobalIgnoreFiles: includeIgnoredFiles,
				disregardParentIgnoreFiles: includeIgnoredFiles,
			})),
			contentPattern: {
				pattern: queryText,
				isRegExp: booleanParam(params, 'isRegexp') ?? booleanParam(params, 'isRegExp'),
				isCaseSensitive: booleanParam(params, 'isCaseSensitive'),
			},
			includePattern: globExpression(stringParam(params, 'includePattern') ?? stringParam(params, 'include')),
			excludePattern: globExpression(stringParam(params, 'excludePattern') ?? stringParam(params, 'exclude')),
			maxResults,
			previewOptions: { matchLines: 1 + (DEFAULT_GREP_CONTEXT_LINES * 2), charsPerLine: 240 },
		}, token);

		const rows: string[] = [];
		for (const fileMatch of complete.results.slice(0, maxResults)) {
			rows.push(...formatGrepMatch(this.workspaceContextService, fileMatch, maxResults - rows.length));
			if (rows.length >= maxResults) {
				break;
			}
		}

		return textResult(`query: ${queryText}\nresults: ${rows.length}\nlimitHit: ${complete.limitHit === true}\n\n${rows.join('\n') || '(no matches)'}`);
	}
}

export class DirectorGetErrorsTool implements IToolImpl {
	constructor(
		@IMarkerService private readonly markerService: IMarkerService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) { }

	async invoke(invocation: IToolInvocation): Promise<IToolResult> {
		const params = invocation.parameters as ToolParams;
		const maxResults = boundedNumber(params.maxResults, DEFAULT_MAX_RESULTS, HARD_MAX_RESULTS);
		const includeWarnings = params.includeWarnings !== false;
		const filterPaths = stringArrayParam(params, 'filePaths') ?? (stringParam(params, 'path') ? [stringParam(params, 'path')!] : undefined);
		const resolvedPaths: Array<Extract<ResolvedWorkspacePath, { ok: true }>> = [];
		for (const filterPath of filterPaths ?? []) {
			const resolved = resolveWorkspacePath(this.workspaceContextService, invocation.context?.workingDirectory, filterPath);
			if (!resolved.ok) {
				return textResult(resolved.message);
			}
			resolvedPaths.push(resolved);
		}

		const severities = includeWarnings ? MarkerSeverity.Error | MarkerSeverity.Warning : MarkerSeverity.Error;
		const markers = this.markerService.read({ severities, take: maxResults, ignoreResourceFilters: true })
			.filter(marker => this.workspaceContextService.getWorkspaceFolder(marker.resource))
			.filter(marker => !resolvedPaths.length || resolvedPaths.some(resolved => extUriBiasedIgnorePathCase.isEqualOrParent(marker.resource, resolved.uri)))
			.sort(compareMarkers)
			.slice(0, maxResults);

		const rows = markers.map(marker => `${MarkerSeverity.toString(marker.severity)}\t${formatUri(this.workspaceContextService, marker.resource)}:${marker.startLineNumber}:${marker.startColumn}\t${marker.message}${marker.source ? ` (${marker.source})` : ''}`);
		return textResult(`diagnostics: ${markers.length}\nincludeWarnings: ${includeWarnings}\n\n${rows.join('\n') || '(no diagnostics)'}`);
	}
}

export class DirectorGetChangedFilesTool implements IToolImpl {
	constructor(
		@ISCMService private readonly scmService: ISCMService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) { }

	async invoke(invocation: IToolInvocation): Promise<IToolResult> {
		const params = invocation.parameters as ToolParams;
		const maxResults = boundedNumber(params.maxResults, DEFAULT_MAX_RESULTS, HARD_MAX_RESULTS);
		const repositoryPath = stringParam(params, 'repositoryPath');
		const resolvedRepositoryPath = repositoryPath ? resolveWorkspacePath(this.workspaceContextService, invocation.context?.workingDirectory, repositoryPath) : undefined;
		if (resolvedRepositoryPath && !resolvedRepositoryPath.ok) {
			return textResult(resolvedRepositoryPath.message);
		}
		const sourceControlStates = normalizedStringSet(params.sourceControlState);
		const rows: string[] = [];

		for (const repository of this.scmService.repositories) {
			if (resolvedRepositoryPath?.ok && !repositoryMatchesPath(repository, resolvedRepositoryPath.uri)) {
				continue;
			}
			for (const group of repository.provider.groups) {
				for (const resource of group.resources) {
					if (sourceControlStates && !scmResourceMatchesState(resource, sourceControlStates)) {
						continue;
					}
					rows.push(formatScmResource(this.workspaceContextService, repository, resource));
					if (rows.length >= maxResults) {
						return textResult(`changedFiles: ${rows.length}\ntruncated: true\n\n${rows.join('\n')}`);
					}
				}
			}
		}

		if (!rows.length && this.scmService.repositoryCount === 0) {
			return textResult('changes is available, but no SCM repositories are currently registered for this workspace.');
		}

		return textResult(`changedFiles: ${rows.length}\ntruncated: false\n\n${rows.join('\n') || '(no changed files)'}`);
	}
}

export class DirectorViewImageTool implements IToolImpl {
	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) { }

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as ToolParams;
		const resolved = resolveWorkspacePath(this.workspaceContextService, invocation.context?.workingDirectory, stringParam(params, 'filePath') ?? stringParam(params, 'path'));
		if (!resolved.ok) {
			return textResult(resolved.message);
		}

		const mimeType = getMediaMime(resolved.uri.path);
		if (!mimeType?.startsWith('image/')) {
			return textResult(`${resolved.relativePath} is not a supported image file.`);
		}

		const content = await this.fileService.readFile(resolved.uri, undefined, token);
		return {
			content: [
				{ kind: 'text', value: `path: ${resolved.relativePath}\nmimeType: ${mimeType}\nsize: ${content.value.byteLength} bytes\nimageData: included when the selected model/tool bridge supports image data parts` },
				{ kind: 'data', value: { mimeType, data: content.value } }
			]
		};
	}
}

export class DirectorGithubRepoTool implements IToolImpl {
	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) { }

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as ToolParams;
		const explicitRepo = stringParam(params, 'repo');
		const query = stringParam(params, 'query');
		const explicit = explicitRepo ? parseGithubRepo(explicitRepo) : undefined;

		if (query) {
			const repoLabel = explicit ? `${explicit.owner}/${explicit.name}` : explicitRepo || 'workspace repository';
			return textResult(`githubRepo resolved ${repoLabel}, but remote GitHub search is not supported in Director v1. Use textSearch for local workspace search.`);
		}

		if (explicit) {
			return textResult(JSON.stringify({
				repository: `${explicit.owner}/${explicit.name}`,
				source: 'explicit',
				search: 'not-supported-v1',
				mutation: 'not-supported-v1'
			}, null, 2));
		}

		const repos = await this.readWorkspaceGithubRemotes(invocation.context?.workingDirectory, token);
		if (!repos.length) {
			return textResult('githubRepo could not infer a GitHub repository from workspace .git/config files. Pass repo as owner/repo or a GitHub URL, or use local workspace tools.');
		}

		return textResult(JSON.stringify({
			repositories: repos,
			search: 'not-supported-v1',
			mutation: 'not-supported-v1'
		}, null, 2));
	}

	private async readWorkspaceGithubRemotes(workingDirectory: URI | undefined, token: CancellationToken): Promise<Array<{ workspaceFolder: string; repository: string; remote: string; url: string }>> {
		const repos: Array<{ workspaceFolder: string; repository: string; remote: string; url: string }> = [];
		for (const folder of workspaceRoots(this.workspaceContextService, workingDirectory)) {
			try {
				const config = await this.fileService.readFile(URI.joinPath(folder, '.git', 'config'), undefined, token);
				for (const remote of parseGitConfigRemotes(config.value.toString())) {
					const parsed = parseGithubRepo(remote.url);
					if (parsed) {
						repos.push({
							workspaceFolder: formatUri(this.workspaceContextService, folder),
							repository: `${parsed.owner}/${parsed.name}`,
							remote: remote.name,
							url: sanitizeRemoteUrl(remote.url),
						});
					}
				}
			} catch {
				// A workspace folder may not be a Git repository, or .git may be a file/worktree pointer.
			}
		}
		return repos.sort((left, right) => left.repository.localeCompare(right.repository) || left.remote.localeCompare(right.remote));
	}
}

function textResult(value: string): IToolResult {
	return { content: [{ kind: 'text', value }] };
}

function workspaceRoots(workspaceContextService: IWorkspaceContextService, workingDirectory: URI | undefined): URI[] {
	if (workingDirectory) {
		return [workingDirectory];
	}
	return workspaceContextService.getWorkspace().folders.map(folder => folder.uri);
}

type ResolvedWorkspacePath =
	| { readonly ok: true; readonly uri: URI; readonly root: URI; readonly relativePath: string }
	| { readonly ok: false; readonly message: string };

function resolveWorkspacePath(workspaceContextService: IWorkspaceContextService, workingDirectory: URI | undefined, rawPath: string | undefined): ResolvedWorkspacePath {
	const folders = workspaceContextService.getWorkspace().folders;
	if (!folders.length && !workingDirectory) {
		return { ok: false, message: 'No workspace folder is open.' };
	}

	const raw = (rawPath || '.').trim();
	if (!raw) {
		return { ok: false, message: 'A non-empty workspace path is required.' };
	}

	let uri: URI;
	if (raw.startsWith(`${Schemas.file}:`)) {
		uri = URI.parse(raw);
	} else if (isAbsoluteNativePath(raw)) {
		uri = URI.file(raw);
	} else if (workingDirectory) {
		uri = URI.joinPath(workingDirectory, ...raw.split(/[\\/]+/).filter(Boolean));
	} else {
		uri = URI.joinPath(folders[0].uri, ...raw.split(/[\\/]+/).filter(Boolean));
	}

	const normalized = extUriBiasedIgnorePathCase.normalizePath(uri);
	const root = workingDirectory
		? extUriBiasedIgnorePathCase.normalizePath(workingDirectory)
		: workspaceContextService.getWorkspaceFolder(normalized)?.uri;
	if (!root || !(extUriBiasedIgnorePathCase.isEqual(root, normalized) || extUriBiasedIgnorePathCase.isEqualOrParent(normalized, root))) {
		return { ok: false, message: `Path is outside the current workspace and was rejected: ${raw}` };
	}

	return {
		ok: true,
		uri: normalized,
		root,
		relativePath: relativePath(root, normalized) || '.',
	};
}

function isAbsoluteNativePath(value: string): boolean {
	return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(value);
}

function stringParam(params: unknown, key: string): string | undefined {
	if (!params || typeof params !== 'object') {
		return undefined;
	}
	const value = (params as Record<string, unknown>)[key];
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArrayParam(params: unknown, key: string): string[] | undefined {
	if (!params || typeof params !== 'object') {
		return undefined;
	}
	const value = (params as Record<string, unknown>)[key];
	if (!Array.isArray(value)) {
		return undefined;
	}
	const result = value.filter((item): item is string => typeof item === 'string' && !!item.trim()).map(item => item.trim());
	return result.length ? result : undefined;
}

function booleanParam(params: ToolParams, key: string): boolean | undefined {
	return typeof params[key] === 'boolean' ? params[key] as boolean : undefined;
}

function normalizedStringSet(value: unknown): Set<string> | undefined {
	const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : undefined;
	const normalized = values
		?.filter((item): item is string => typeof item === 'string' && !!item.trim())
		.map(item => item.trim().toLowerCase());
	return normalized?.length ? new Set(normalized) : undefined;
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function boundedNumber(value: unknown, fallback: number, hardMax: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		return fallback;
	}
	return Math.min(hardMax, Math.floor(value));
}

function globExpression(pattern: string | undefined): Record<string, boolean> | undefined {
	return pattern ? { [pattern]: true } : undefined;
}

function compareFileStats(left: IFileStat, right: IFileStat): number {
	if (left.isDirectory !== right.isDirectory) {
		return left.isDirectory ? -1 : 1;
	}
	return left.name.localeCompare(right.name);
}

function compareMarkers(left: IMarker, right: IMarker): number {
	return MarkerSeverity.compare(left.severity, right.severity)
		|| formatMarkerResource(left).localeCompare(formatMarkerResource(right))
		|| left.startLineNumber - right.startLineNumber
		|| left.startColumn - right.startColumn;
}

function formatMarkerResource(marker: IMarker): string {
	return marker.resource.toString();
}

function formatUri(workspaceContextService: IWorkspaceContextService, uri: URI): string {
	const folder = workspaceContextService.getWorkspaceFolder(uri);
	return folder ? (relativePath(folder.uri, uri) || '.') : uri.toString(true);
}

function formatGrepMatch(workspaceContextService: IWorkspaceContextService, fileMatch: IFileMatch, remaining: number): string[] {
	const rows: string[] = [];
	for (const result of fileMatch.results ?? []) {
		if (!resultIsMatch(result)) {
			continue;
		}
		rows.push(formatTextSearchMatch(workspaceContextService, fileMatch, result));
		if (rows.length >= remaining) {
			break;
		}
	}
	return rows;
}

function formatTextSearchMatch(workspaceContextService: IWorkspaceContextService, fileMatch: IFileMatch, match: ITextSearchMatch): string {
	const firstRange = match.rangeLocations[0]?.source;
	const line = firstRange ? `${firstRange.startLineNumber}:${firstRange.startColumn}` : '?:?';
	const preview = match.previewText.replace(/\r?\n/g, '\\n').trim();
	return `${formatUri(workspaceContextService, fileMatch.resource)}:${line}\t${preview}`;
}

function formatScmResource(workspaceContextService: IWorkspaceContextService, repository: ISCMRepository, resource: ISCMResource): string {
	const group = resource.resourceGroup;
	const status = resource.decorations.tooltip || resource.contextValue || group.label || group.id;
	const repo = repository.provider.rootUri ? formatUri(workspaceContextService, repository.provider.rootUri) : repository.provider.label;
	return `${status}\t${formatUri(workspaceContextService, resource.sourceUri)}\trepository: ${repo}`;
}

function repositoryMatchesPath(repository: ISCMRepository, uri: URI): boolean {
	const rootUri = repository.provider.rootUri;
	return !!rootUri && (extUriBiasedIgnorePathCase.isEqual(rootUri, uri) || extUriBiasedIgnorePathCase.isEqualOrParent(rootUri, uri));
}

function scmResourceMatchesState(resource: ISCMResource, states: Set<string>): boolean {
	const group = resource.resourceGroup;
	const values = [
		group.id,
		group.label,
		resource.contextValue,
		resource.decorations.tooltip,
	].filter((item): item is string => typeof item === 'string' && !!item.trim());
	return values.some(item => states.has(item.trim().toLowerCase()));
}

function parseGitConfigRemotes(config: string): Array<{ name: string; url: string }> {
	const remotes: Array<{ name: string; url: string }> = [];
	let currentRemote: string | undefined;
	for (const rawLine of config.split(/\r\n|\r|\n/)) {
		const section = /^\s*\[remote\s+"([^"]+)"\]\s*$/.exec(rawLine);
		if (section) {
			currentRemote = section[1];
			continue;
		}
		const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(rawLine);
		if (currentRemote && url) {
			remotes.push({ name: currentRemote, url: url[1] });
		}
	}
	return remotes;
}

function parseGithubRepo(value: string): { owner: string; name: string } | undefined {
	const trimmed = value.trim();
	const ownerRepo = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(trimmed);
	if (ownerRepo) {
		return { owner: ownerRepo[1], name: ownerRepo[2] };
	}

	const https = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[#/?].*)?$/.exec(trimmed);
	if (https) {
		return { owner: https[1], name: https[2] };
	}

	return undefined;
}

function sanitizeRemoteUrl(value: string): string {
	return value.replace(/^(https?:\/\/)([^/@]+@)/, '$1');
}
