/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolDefinition } from './state/protocol/state.js';

export const enum DirectorToolMode {
	Agent = 'agent',
	Plan = 'plan',
}

export type DirectorToolAccess = 'read' | 'write' | 'execute' | 'coordination' | 'confirmation';

export interface DirectorToolPolicyEntry {
	readonly name: string;
	readonly access: DirectorToolAccess;
	readonly allowedModes: readonly DirectorToolMode[];
	readonly description?: string;
	readonly inputSchema?: ToolDefinition['inputSchema'];
	readonly directorPreApprovalReason?: string;
}

const AGENT_ONLY: readonly DirectorToolMode[] = [DirectorToolMode.Agent];
const READ_CONTEXT_MODES: readonly DirectorToolMode[] = [DirectorToolMode.Agent, DirectorToolMode.Plan];

const DIRECTOR_BROWSER_MUTATION_PRE_APPROVAL = 'Director browser policy requires explicit approval before the agent interacts with, navigates, or changes an integrated browser page.';
const DIRECTOR_BROWSER_SESSION_PRE_APPROVAL = 'Director browser policy requires explicit approval before the agent reads or captures integrated browser page content outside a user-opened Director browser session.';

const OPEN_BROWSER_PAGE_URL_DESCRIPTION = [
	'The URL to open in the browser.',
	'For webpages, use a complete http:// or https:// URL.',
	'Do not pass VS Code workspace folders, raw local filesystem paths, or the current working directory as url.',
	'For local files or workspace paths, use readFile, listDirectory, fileSearch, or textSearch instead.',
].join(' ');

const OPEN_BROWSER_PAGE_INPUT_SCHEMA: ToolDefinition['inputSchema'] = {
	type: 'object',
	properties: {
		url: {
			type: 'string',
			description: OPEN_BROWSER_PAGE_URL_DESCRIPTION,
		},
		forceNew: {
			type: 'boolean',
			description: 'Whether to force opening a new page even if a page with the same host already exists. Default is false.',
		},
	},
};

const DIRECTOR_TOOL_POLICY: readonly DirectorToolPolicyEntry[] = [
	entry('askQuestions', 'confirmation', AGENT_ONLY),
	entry('vscode_get_confirmation', 'confirmation', AGENT_ONLY),
	entry('vscode_get_confirmation_with_options', 'confirmation', AGENT_ONLY),
	entry('vscode_get_modified_files_confirmation', 'confirmation', AGENT_ONLY),

	entry('todo', 'coordination', AGENT_ONLY),
	entry('task_complete', 'coordination', AGENT_ONLY),
	entry('runSubagent', 'execute', AGENT_ONLY, {
		description: 'Run a generic non-terminal subagent for research, context gathering, or delegation. Do not use runSubagent for terminal commands, builds, tests, package installs, shell execution, or command output collection; use execution_subagent for those execution tasks.',
	}),

	entry('fetch', 'read', READ_CONTEXT_MODES),
	entry('usages', 'read', READ_CONTEXT_MODES),
	entry('readFile', 'read', READ_CONTEXT_MODES),
	entry('listDirectory', 'read', READ_CONTEXT_MODES),
	entry('fileSearch', 'read', READ_CONTEXT_MODES),
	entry('textSearch', 'read', READ_CONTEXT_MODES),
	entry('problems', 'read', READ_CONTEXT_MODES),
	entry('changes', 'read', READ_CONTEXT_MODES),
	entry('viewImage', 'read', READ_CONTEXT_MODES),
	entry('githubRepo', 'read', READ_CONTEXT_MODES),

	entry('runInTerminal', 'execute', AGENT_ONLY),
	entry('execution_subagent', 'execute', AGENT_ONLY, {
		description: 'Run terminal commands, builds, tests, package installs, and shell execution through a constrained terminal-only subagent. Prefer this over runSubagent for execution tasks. The subagent uses sync runInTerminal calls with explicit timeouts and returns compact output plus terminal id/status when follow-up is needed.',
	}),
	entry('sendToTerminal', 'execute', AGENT_ONLY),
	entry('getTerminalOutput', 'read', AGENT_ONLY),
	entry('killTerminal', 'execute', AGENT_ONLY),
	entry('terminalSelection', 'read', AGENT_ONLY),
	entry('terminalLastCommand', 'read', AGENT_ONLY),
	entry('vscode_get_terminal_confirmation', 'confirmation', AGENT_ONLY),
	entry('runTask', 'execute', AGENT_ONLY),
	entry('createAndRunTask', 'execute', AGENT_ONLY),
	entry('getTaskOutput', 'read', AGENT_ONLY),
	entry('runTests', 'execute', AGENT_ONLY),

	entry('openBrowserPage', 'execute', AGENT_ONLY, {
		inputSchema: OPEN_BROWSER_PAGE_INPUT_SCHEMA,
		directorPreApprovalReason: DIRECTOR_BROWSER_MUTATION_PRE_APPROVAL,
	}),
	entry('readPage', 'read', AGENT_ONLY, { directorPreApprovalReason: DIRECTOR_BROWSER_SESSION_PRE_APPROVAL }),
	entry('screenshotPage', 'read', AGENT_ONLY, { directorPreApprovalReason: DIRECTOR_BROWSER_SESSION_PRE_APPROVAL }),
	entry('navigatePage', 'execute', AGENT_ONLY, { directorPreApprovalReason: DIRECTOR_BROWSER_MUTATION_PRE_APPROVAL }),
	entry('clickElement', 'execute', AGENT_ONLY, { directorPreApprovalReason: DIRECTOR_BROWSER_MUTATION_PRE_APPROVAL }),
	entry('dragElement', 'execute', AGENT_ONLY, { directorPreApprovalReason: DIRECTOR_BROWSER_MUTATION_PRE_APPROVAL }),
	entry('hoverElement', 'execute', AGENT_ONLY),
	entry('typeInPage', 'execute', AGENT_ONLY, { directorPreApprovalReason: DIRECTOR_BROWSER_MUTATION_PRE_APPROVAL }),
	entry('runPlaywrightCode', 'execute', AGENT_ONLY, { directorPreApprovalReason: DIRECTOR_BROWSER_MUTATION_PRE_APPROVAL }),
	entry('handleDialog', 'execute', AGENT_ONLY, { directorPreApprovalReason: DIRECTOR_BROWSER_MUTATION_PRE_APPROVAL }),

	entry('artifacts', 'coordination', AGENT_ONLY),
	entry('artifactRules', 'coordination', AGENT_ONLY),
	entry('extensions', 'read', READ_CONTEXT_MODES),
	entry('renderMermaidDiagram', 'read', AGENT_ONLY),
];

export const DirectorDefaultClientToolReferenceNames = Object.freeze([
	'askQuestions',
	'vscode_get_confirmation',
	'vscode_get_confirmation_with_options',
	'vscode_get_modified_files_confirmation',
	'todo',
	'task_complete',
	'runSubagent',
	'fetch',
	'usages',
	'readFile',
	'listDirectory',
	'fileSearch',
	'textSearch',
	'problems',
	'changes',
	'viewImage',
	'githubRepo',
	'runInTerminal',
	'execution_subagent',
	'sendToTerminal',
	'getTerminalOutput',
	'killTerminal',
	'terminalSelection',
	'terminalLastCommand',
	'vscode_get_terminal_confirmation',
	'runTask',
	'createAndRunTask',
	'getTaskOutput',
	'runTests',
	'openBrowserPage',
	'readPage',
	'screenshotPage',
	'navigatePage',
	'clickElement',
	'dragElement',
	'hoverElement',
	'typeInPage',
	'runPlaywrightCode',
	'handleDialog',
	'artifacts',
	'artifactRules',
	'extensions',
	'renderMermaidDiagram',
] satisfies readonly string[]);

const directorToolPolicyByName = new Map(DIRECTOR_TOOL_POLICY.map(policy => [policy.name, policy]));

function entry(
	name: string,
	access: DirectorToolAccess,
	allowedModes: readonly DirectorToolMode[],
	options: Omit<DirectorToolPolicyEntry, 'name' | 'access' | 'allowedModes'> = {},
): DirectorToolPolicyEntry {
	return {
		name,
		access,
		allowedModes,
		...options,
	};
}

export function getDirectorToolPolicyEntry(name: string): DirectorToolPolicyEntry | undefined {
	return directorToolPolicyByName.get(name);
}

export function isDirectorReadOnlyTool(name: string): boolean {
	return getDirectorToolPolicyEntry(name)?.access === 'read';
}

export function normalizeDirectorClientToolDefinitions(
	tools: readonly ToolDefinition[],
	mode: DirectorToolMode = DirectorToolMode.Agent,
): readonly ToolDefinition[] {
	const normalized: ToolDefinition[] = [];
	const seen = new Set<string>();
	for (const tool of tools) {
		const policy = getDirectorToolPolicyEntry(tool.name);
		if (!policy || !policy.allowedModes.includes(mode) || seen.has(policy.name)) {
			continue;
		}
		const description = normalizeDirectorToolDescription(tool, policy);
		if (!description) {
			continue;
		}
		seen.add(policy.name);
		normalized.push({
			name: policy.name,
			...(tool.title !== undefined ? { title: tool.title } : {}),
			description,
			inputSchema: policy.inputSchema ?? tool.inputSchema ?? { type: 'object', properties: {} },
		});
	}
	return normalized.sort((left, right) => left.name.localeCompare(right.name));
}

export function validateDirectorToolCallInput(toolName: string, input: string): string | undefined {
	const parsed = parseToolCallInput(input);
	if (!parsed.ok) {
		return `Invalid tool input for '${toolName}': expected JSON object parameters.`;
	}
	if (toolName === 'openBrowserPage') {
		return validateOpenBrowserPageInput(parsed.value);
	}
	return undefined;
}

function normalizeDirectorToolDescription(tool: ToolDefinition, policy: DirectorToolPolicyEntry): string | undefined {
	const description = policy.description ?? tool.description ?? tool.title;
	if (tool.name !== 'openBrowserPage' || !description) {
		return description;
	}
	const guidance = 'When opening a webpage, pass a complete http:// or https:// URL; never pass the workspace folder, current working directory, file:// URI, or a raw local filesystem path as url.';
	return description.includes(guidance) ? description : `${description}\n\n${guidance}`;
}

function parseToolCallInput(input: string): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false } {
	const trimmed = input.trim();
	if (!trimmed) {
		return { ok: true, value: {} };
	}
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return { ok: true, value: parsed as Record<string, unknown> };
		}
	} catch {
		// Return the common invalid-input message below.
	}
	return { ok: false };
}

function validateOpenBrowserPageInput(input: Record<string, unknown>): string | undefined {
	const rawUrl = input.url;
	if (rawUrl === undefined || rawUrl === '') {
		return undefined;
	}
	if (typeof rawUrl !== 'string') {
		return 'Invalid tool input for \'openBrowserPage\': url must be a string.';
	}
	const url = rawUrl.trim();
	if (!url) {
		return undefined;
	}
	if (looksLikeRawLocalPath(url)) {
		return 'Invalid tool input for \'openBrowserPage\': url must be a complete http:// or https:// URL for webpages. Do not pass a raw local filesystem path or workspace directory; use readFile, listDirectory, fileSearch, or textSearch for local files.';
	}
	const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
	if (!schemeMatch) {
		return 'Invalid tool input for \'openBrowserPage\': url must include a scheme such as http:// or https://.';
	}
	const scheme = schemeMatch[1].toLowerCase();
	if (scheme !== 'http' && scheme !== 'https') {
		return `Invalid tool input for 'openBrowserPage': unsupported URL scheme '${scheme}'. Use http:// or https:// for webpages, and use workspace file tools for local files.`;
	}
	return undefined;
}

function looksLikeRawLocalPath(value: string): boolean {
	return /^[a-zA-Z]:[\\/]/.test(value)
		|| /^\\\\/.test(value)
		|| /^~[\\/]/.test(value)
		|| /^\.\.?[\\/]/.test(value)
		|| /^\/(?!\/)/.test(value);
}
