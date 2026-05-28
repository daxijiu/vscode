/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationError } from '../../../../base/common/errors.js';
import { MessageAttachmentKind, ResponsePartKind, ToolResultContentType, type MessageAttachment, type ToolCallResult, type ToolResultContent, type Turn, type UsageInfo } from '../../common/state/sessionState.js';
import { DirectorDirectLanguageModelMessagesAttachmentMetaKey, type DirectorNormalizedMessage, type DirectorNormalizedToolCall, type DirectorNormalizedToolDefinition, type DirectorOpenAIReasoningEcho } from '../../common/directorProviderAdapters.js';
import type { DirectorResolvedProviderBackend } from '../../common/directorProviderBackend.js';
import type { DirectorCreateMessageParams, DirectorCreateMessageResponse, DirectorLLMProvider, DirectorProviderRuntimeAuth, DirectorRuntimeProviderApiType, DirectorTokenUsage } from '../../common/directorProviderRuntime.js';
import type { DirectorRuntimeCredential, IDirectorRuntimeCredentialService } from '../../common/directorRuntimeCredentials.js';
import { isDirectorReadOnlyTool } from '../../common/directorToolPolicy.js';
import { createDirectorProviderRuntime, DirectorProviderRuntimeHttpError } from './providers/directorProviderRuntimeFactory.js';

export type DirectorAgentEngineEvent =
	| { readonly type: 'system'; readonly message: string }
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'textDelta'; readonly text: string }
	| { readonly type: 'thinking'; readonly thinking: string }
	| { readonly type: 'thinkingDelta'; readonly thinking: string }
	| { readonly type: 'usage'; readonly usage: UsageInfo }
	| { readonly type: 'result'; readonly subtype: 'success' | 'error_max_turns' };

export interface DirectorAgentToolExecution {
	readonly success: boolean;
	readonly content: string;
	readonly isError?: boolean;
}

const DEFAULT_MAX_TOOL_ITERATIONS = 100;
const MAX_REPEATED_TOOL_CALLS = 3;

export interface DirectorAgentEngineTurnOptions {
	readonly backend: DirectorResolvedProviderBackend;
	readonly prompt: string;
	readonly attachments?: readonly MessageAttachment[];
	readonly turns: readonly Turn[];
	readonly cwd?: string;
	readonly abortSignal: AbortSignal;
	readonly tools?: readonly DirectorNormalizedToolDefinition[];
	readonly executeToolCall?: (toolCall: DirectorNormalizedToolCall) => Promise<DirectorAgentToolExecution>;
	readonly maxToolIterations?: number;
}

type DirectorFetch = (input: string, init: RequestInit) => Promise<Response>;

const MAX_HISTORY_TURNS = 16;
const MAX_HISTORY_CHARS = 48_000;
const MAX_HISTORY_MESSAGE_CHARS = 12_000;
const HISTORY_MESSAGE_HEAD_CHARS = 4_000;
const HISTORY_MESSAGE_TAIL_CHARS = 7_000;

export class DirectorAgentEngineAdapter {

	constructor(
		private readonly credentialService: IDirectorRuntimeCredentialService,
		private readonly fetcher: DirectorFetch = (input, init) => fetch(input, init),
	) { }

	async *runTurn(options: DirectorAgentEngineTurnOptions): AsyncGenerator<DirectorAgentEngineEvent> {
		const backend = options.backend;
		const credential = await this.resolveCredential(backend);
		if (options.abortSignal.aborted) {
			throw new CancellationError();
		}
		if (credential.kind === 'missing') {
			throw new Error(credential.message);
		}
		if (backend.apiType === 'local' || backend.apiType === 'custom-http') {
			throw new Error(`Director provider '${backend.providerInstanceId}' uses '${backend.apiType}', which is not supported by the Phase 4 AgentEngine adapter yet.`);
		}
		if (!backend.baseURL) {
			throw new Error(`Director provider '${backend.providerInstanceId}' does not have a base URL.`);
		}

		yield {
			type: 'system',
			message: `Director AgentEngine using provider '${backend.providerInstanceId}' with model '${backend.modelId}'.`,
		};

		const tools = supportsToolCalling(backend) ? options.tools ?? [] : [];
		const messages = [...this.buildMessages(options, tools)];
		const advertisedToolNames = new Set(tools.map(tool => tool.name));
		const maxToolIterations = options.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
		let toolSideEffectOccurred = false;
		let toolIterations = 0;
		const toolCallSignatureCounts = new Map<string, number>();
		let reasoningEcho = getOpenAIReasoningEchoForBackend(backend);

		while (true) {
			const stream = toolIterations === 0 && tools.length === 0 && supportsStreaming(backend);
			let response: DirectorCreateMessageResponse;
			while (true) {
				const provider = this.createProviderRuntime(backend, credential, reasoningEcho);
				const request: DirectorCreateMessageParams = {
					model: backend.modelId,
					messages,
					tools: tools.length ? tools : undefined,
					maxTokens: 2048,
					abortSignal: options.abortSignal,
				};
				try {
					if (stream && provider.createMessageStream) {
						const streamed = yield* this.streamProviderResponse(provider, request, backend, options.abortSignal, toolSideEffectOccurred);
						if (!streamed.text.trim() && !streamed.thinking?.trim()) {
							throw new Error(`Director provider '${backend.providerInstanceId}' returned an empty response.`);
						}
						if (streamed.usage) {
							yield { type: 'usage', usage: streamed.usage };
						}
						yield { type: 'result', subtype: 'success' };
						return;
					}
					response = await this.runProviderRequestWithRetry(() => provider.createMessage(request), backend, options.abortSignal, toolSideEffectOccurred);
					break;
				} catch (err) {
					if (!reasoningEcho && canApplyOpenAIReasoningEchoFallback(backend, err)) {
						reasoningEcho = { field: 'reasoning_content', includeEmpty: true };
						continue;
					}
					throw err;
				}
			}
			const parsed = parseProviderRuntimeResponse(response);
			if (parsed.thinking) {
				yield { type: 'thinking', thinking: parsed.thinking };
			}
			if (parsed.text) {
				yield { type: 'text', text: parsed.text };
			}
			if (parsed.toolCalls.length) {
				const repeatedToolCall = findRepeatedToolCall(parsed.toolCalls, toolCallSignatureCounts);
				if (repeatedToolCall) {
					yield { type: 'text', text: `Director AgentEngine stopped because provider '${backend.providerInstanceId}' repeatedly requested tool '${repeatedToolCall.name}' with the same input ${MAX_REPEATED_TOOL_CALLS + 1} times.` };
					yield { type: 'result', subtype: 'error_max_turns' };
					return;
				}
				toolIterations++;
				if (toolIterations > maxToolIterations) {
					yield { type: 'text', text: `Director AgentEngine stopped after ${maxToolIterations} tool iterations because the per-turn tool budget was exhausted. Last requested tools: ${parsed.toolCalls.map(toolCall => toolCall.name).join(', ') || 'none'}. This can happen on long tool-heavy requests; continue in a follow-up turn rather than repeating the same tool call.` };
					yield { type: 'result', subtype: 'error_max_turns' };
					return;
				}
				messages.push({
					role: 'assistant',
					content: parsed.text,
					thinking: parsed.thinking,
					toolCalls: parsed.toolCalls,
				});
				for (const { toolCall, result } of await executeToolCalls(parsed.toolCalls, advertisedToolNames, options.executeToolCall)) {
					if (advertisedToolNames.has(toolCall.name)) {
						toolSideEffectOccurred = true;
					}
					messages.push({
						role: 'tool',
						content: result.content,
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						isError: result.isError === true || !result.success,
					});
				}
				continue;
			}
			if (!parsed.text.trim()) {
				throw new Error(`Director provider '${backend.providerInstanceId}' returned an empty response.`);
			}
			if (parsed.usage) {
				yield { type: 'usage', usage: parsed.usage };
			}
			yield { type: 'result', subtype: 'success' };
			return;
		}
	}

	private async resolveCredential(backend: DirectorResolvedProviderBackend): Promise<DirectorRuntimeCredential> {
		if (backend.authKind === 'none') {
			return { kind: 'none' };
		}
		return this.credentialService.resolveCredential({
			providerInstanceId: backend.providerInstanceId,
			authKind: backend.authKind,
			authStateKind: backend.authState.kind,
		});
	}

	private buildMessages(options: DirectorAgentEngineTurnOptions, tools: readonly DirectorNormalizedToolDefinition[]): readonly DirectorNormalizedMessage[] {
		const directLanguageModelMessages = readDirectLanguageModelMessages(options.attachments);
		if (directLanguageModelMessages) {
			return directLanguageModelMessages;
		}

		const messages: DirectorNormalizedMessage[] = [{
			role: 'system',
			content: buildDirectorSystemPrompt(options.cwd, tools),
		}];

		messages.push(...buildHistoryMessages(options.turns));

		const attachmentSummary = summarizeAttachments(options.attachments);
		messages.push({
			role: 'user',
			content: attachmentSummary ? `${options.prompt}\n\n${attachmentSummary}` : options.prompt,
		});
		return messages;
	}

	private createProviderRuntime(
		backend: DirectorResolvedProviderBackend,
		credential: DirectorRuntimeCredential,
		reasoningEcho: DirectorOpenAIReasoningEcho | undefined,
	): DirectorLLMProvider {
		return createDirectorProviderRuntime(toRuntimeProviderApiType(backend.apiType), {
			auth: credentialToRuntimeAuth(credential),
			baseURL: backend.baseURL,
			headers: backend.headers,
			capabilities: backend.capabilities,
			label: `Director provider '${backend.providerInstanceId}'`,
			reasoningEcho,
			fetch: (input, init) => this.fetcher(input.toString(), init ?? {}),
		});
	}

	private async runProviderRequestWithRetry<T>(
		request: () => Promise<T>,
		backend: DirectorResolvedProviderBackend,
		abortSignal: AbortSignal,
		toolSideEffectOccurred: boolean,
	): Promise<T> {
		let lastError: Error | undefined;
		for (let attempt = 0; attempt < 2; attempt++) {
			if (abortSignal.aborted) {
				throw new CancellationError();
			}
			try {
				const response = await request();
				if (abortSignal.aborted) {
					throw new CancellationError();
				}
				return response;
			} catch (err) {
				if (abortSignal.aborted || err instanceof CancellationError) {
					throw new CancellationError();
				}
				const error = err instanceof Error ? err : new Error(String(err));
				if (attempt === 0 && !toolSideEffectOccurred && error instanceof DirectorProviderRuntimeHttpError && shouldRetryStatus(error.status)) {
					lastError = error;
					continue;
				}
				if (attempt === 0 && !toolSideEffectOccurred && !(error instanceof DirectorProviderRuntimeHttpError)) {
					lastError = error;
					continue;
				}
				throw error;
			}
		}
		throw lastError ?? new Error(`Director provider '${backend.providerInstanceId}' request failed.`);
	}

	private async *streamProviderResponse(
		provider: DirectorLLMProvider,
		params: DirectorCreateMessageParams,
		backend: DirectorResolvedProviderBackend,
		abortSignal: AbortSignal,
		toolSideEffectOccurred: boolean,
	): AsyncGenerator<DirectorAgentEngineEvent, ParsedProviderResponse> {
		let lastError: Error | undefined;
		for (let attempt = 0; attempt < 2; attempt++) {
			const accumulated: MutableParsedProviderResponse = { text: '', toolCalls: [] };
			let emittedDelta = false;
			try {
				for await (const event of provider.createMessageStream!(params)) {
					if (event.type === 'text') {
						accumulated.text += event.text;
						emittedDelta = true;
						yield { type: 'textDelta', text: event.text };
					} else if (event.type === 'thinking') {
						accumulated.thinking = (accumulated.thinking ?? '') + event.thinking;
						emittedDelta = true;
						yield { type: 'thinkingDelta', thinking: event.thinking };
					} else if (event.type === 'message_complete') {
						accumulated.usage = event.usage ? mergeUsage(accumulated.usage, toUsageInfo(event.usage)) : accumulated.usage;
					}
				}
				return accumulated;
			} catch (err) {
				if (abortSignal.aborted || err instanceof CancellationError) {
					throw new CancellationError();
				}
				const error = err instanceof Error ? err : new Error(String(err));
				if (attempt === 0 && !emittedDelta && !toolSideEffectOccurred && error instanceof DirectorProviderRuntimeHttpError && shouldRetryStatus(error.status)) {
					lastError = error;
					continue;
				}
				if (attempt === 0 && !emittedDelta && !toolSideEffectOccurred && !(error instanceof DirectorProviderRuntimeHttpError)) {
					lastError = error;
					continue;
				}
				throw error;
			}
		}
		throw lastError ?? new Error(`Director provider '${backend.providerInstanceId}' stream request failed.`);
	}
}

function buildHistoryMessages(turns: readonly Turn[]): readonly DirectorNormalizedMessage[] {
	const history: DirectorNormalizedMessage[] = [];
	let historyChars = 0;
	for (const turn of turns.slice(-MAX_HISTORY_TURNS).reverse()) {
		const turnMessages = buildTurnMessages(turn);
		const turnChars = turnMessages.reduce((sum, message) => sum + message.content.length, 0);
		if (!turnChars) {
			continue;
		}
		if (history.length && historyChars + turnChars > MAX_HISTORY_CHARS) {
			break;
		}
		history.unshift(...turnMessages);
		historyChars += turnChars;
	}
	return history;
}

function buildTurnMessages(turn: Turn): readonly DirectorNormalizedMessage[] {
	const messages: DirectorNormalizedMessage[] = [];
	if (turn.userMessage.text) {
		messages.push({ role: 'user', content: truncateHistoryContent(turn.userMessage.text) });
	}
	const assistantText = turn.responseParts
		.filter(part => part.kind === ResponsePartKind.Markdown)
		.map(part => part.content)
		.join('');
	if (assistantText.trim()) {
		messages.push({ role: 'assistant', content: truncateHistoryContent(assistantText) });
	}
	return messages;
}

function truncateHistoryContent(content: string): string {
	if (content.length <= MAX_HISTORY_MESSAGE_CHARS) {
		return content;
	}
	return [
		content.slice(0, HISTORY_MESSAGE_HEAD_CHARS),
		`[Director truncated ${content.length - HISTORY_MESSAGE_HEAD_CHARS - HISTORY_MESSAGE_TAIL_CHARS} history characters]`,
		content.slice(-HISTORY_MESSAGE_TAIL_CHARS),
	].join('\n\n');
}

function buildDirectorSystemPrompt(cwd: string | undefined, tools: readonly DirectorNormalizedToolDefinition[]): string {
	const parts = [
		'You are Director, an expert AI coding assistant running inside VS Code AgentHost.',
		'',
		'## Guidelines',
		'- Use tools proactively when they help you understand the codebase or accomplish the task.',
		'- Read files before modifying them to understand the existing code.',
		'- Explain your reasoning briefly before taking actions.',
		'- If a tool call fails, analyze the error and try a different approach.',
		'- Do not repeat the same tool call with the same input after an error or unsupported result.',
		'- When writing code, follow the existing code style and conventions in the project.',
		'- Be concise in your responses and focus on what matters.',
		'',
		'## Execution Guidance',
		'- For terminal commands, shell execution, package installs, builds, tests, and task-like command execution, prefer execution_subagent when it is available.',
		'- Do not use runSubagent for terminal commands, builds, tests, package installs, shell execution, or command output collection.',
		'- Use runSubagent only for generic non-terminal research, context-gathering, or delegation tasks.',
		'- Use runInTerminal only in rare cases when the entire output of a single command is needed without summarization or truncation.',
		'- When directly calling runInTerminal in sync mode, always include timeout in milliseconds from 1 to 600000. Use 30000 for short commands, 120000 for ordinary builds/tests, and 600000 for package installs, full builds, or long test suites. Do not omit timeout and do not use timeout=0.',
		'- If execution_subagent reports that a command timed out, moved to background, or needed input and includes a terminal id, immediately continue with getTerminalOutput using that exact id until the command has completed, failed, or clearly needs user input.',
		'- Use mode="async" only for servers, watchers, dev daemons, or other commands that should keep running while you continue other work.',
		'- Do not call execution_subagent multiple times in parallel. Invoke one execution subagent and wait for its response before starting another execution task.',
		'- Do not call runInTerminal multiple times in parallel. Run one command and wait for output before running the next command.',
		'- Use runTask or createAndRunTask when the request is better represented as a VS Code task and the expected task lifecycle is appropriate for the current timeout behavior.',
		'',
		'## Working Directory',
		cwd ?? '(no workspace directory)',
		'',
		'The working directory is local filesystem context, not a URL.',
		'For browser tools, openBrowserPage.url must be a complete http:// or https:// URL for webpages; never pass a workspace folder, current working directory, file:// URI, or raw local filesystem path as a browser URL. Use readFile, listDirectory, fileSearch, or textSearch for local workspace files.',
	];

	if (tools.length > 0) {
		parts.push('', '## Available Tools');
		for (const tool of tools) {
			parts.push(`- **${tool.name}**: ${tool.description ?? tool.title ?? 'Available Director tool.'}`);
		}
	}

	return parts.join('\n');
}

function summarizeAttachments(attachments: readonly MessageAttachment[] | undefined): string | undefined {
	if (!attachments?.length) {
		return undefined;
	}
	return [
		'Attached context:',
		...attachments.slice(0, 20).map((attachment, index) => {
			const label = attachment.label ? ` (${attachment.label})` : '';
			return `- attachment ${index + 1}: ${attachment.type}${label}`;
		}),
	].join('\n');
}

function readDirectLanguageModelMessages(attachments: readonly MessageAttachment[] | undefined): readonly DirectorNormalizedMessage[] | undefined {
	const attachment = attachments?.find(attachment =>
		attachment.type === MessageAttachmentKind.Simple
		&& attachment._meta?.[DirectorDirectLanguageModelMessagesAttachmentMetaKey] === true
		&& typeof attachment.modelRepresentation === 'string');
	if (!attachment || attachment.type !== MessageAttachmentKind.Simple || typeof attachment.modelRepresentation !== 'string') {
		return undefined;
	}
	try {
		const parsed = JSON.parse(attachment.modelRepresentation) as unknown;
		return isDirectorNormalizedMessageArray(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function isDirectorNormalizedMessageArray(value: unknown): value is readonly DirectorNormalizedMessage[] {
	return Array.isArray(value) && value.every(isDirectorNormalizedMessage);
}

function isDirectorNormalizedMessage(value: unknown): value is DirectorNormalizedMessage {
	if (!isObject(value)) {
		return false;
	}
	const role = value.role;
	if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') {
		return false;
	}
	if (typeof value.content !== 'string') {
		return false;
	}
	if (value.thinking !== undefined && typeof value.thinking !== 'string') {
		return false;
	}
	if (value.toolCallId !== undefined && typeof value.toolCallId !== 'string') {
		return false;
	}
	if (value.toolName !== undefined && typeof value.toolName !== 'string') {
		return false;
	}
	if (value.isError !== undefined && typeof value.isError !== 'boolean') {
		return false;
	}
	return value.toolCalls === undefined || (Array.isArray(value.toolCalls) && value.toolCalls.every(isDirectorNormalizedToolCall));
}

function isDirectorNormalizedToolCall(value: unknown): value is DirectorNormalizedToolCall {
	return isObject(value)
		&& typeof value.id === 'string'
		&& typeof value.name === 'string'
		&& typeof value.input === 'string';
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function credentialToRuntimeAuth(credential: DirectorRuntimeCredential): DirectorProviderRuntimeAuth {
	switch (credential.kind) {
		case 'api-key':
			return { kind: 'api-key', value: credential.value };
		case 'bearer':
			return {
				kind: 'bearer',
				accessToken: credential.accessToken,
			};
		case 'none':
			return { kind: 'api-key', value: '' };
		case 'missing':
			throw new Error(credential.message);
	}
}

interface ParsedProviderResponse {
	readonly text: string;
	readonly thinking?: string;
	readonly usage?: UsageInfo;
	readonly toolCalls: readonly DirectorNormalizedToolCall[];
}

interface MutableParsedProviderResponse {
	text: string;
	thinking?: string;
	usage?: UsageInfo;
	toolCalls: DirectorNormalizedToolCall[];
}

function parseProviderRuntimeResponse(response: DirectorCreateMessageResponse): ParsedProviderResponse {
	const textParts: string[] = [];
	const thinkingParts: string[] = [];
	const toolCalls: DirectorNormalizedToolCall[] = [];
	for (const block of response.content) {
		switch (block.type) {
			case 'text':
				textParts.push(block.text);
				break;
			case 'thinking':
				thinkingParts.push(block.thinking);
				break;
			case 'tool_use':
				toolCalls.push(block.toolCall);
				break;
		}
	}
	return {
		text: textParts.join(''),
		...(thinkingParts.length ? { thinking: thinkingParts.join('') } : {}),
		...(response.usage ? { usage: toUsageInfo(response.usage) } : {}),
		toolCalls,
	};
}

function toUsageInfo(usage: DirectorTokenUsage): UsageInfo {
	return {
		inputTokens: usage.input_tokens,
		outputTokens: usage.output_tokens,
		...(usage.cache_read_input_tokens !== undefined ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
	};
}

function mergeUsage(previous: UsageInfo | undefined, next: UsageInfo): UsageInfo {
	const inputTokens = next.inputTokens ?? previous?.inputTokens;
	const outputTokens = next.outputTokens ?? previous?.outputTokens;
	const cacheReadTokens = next.cacheReadTokens ?? previous?.cacheReadTokens;
	return {
		...(inputTokens !== undefined ? { inputTokens } : {}),
		...(outputTokens !== undefined ? { outputTokens } : {}),
		...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
	};
}

function supportsStreaming(backend: DirectorResolvedProviderBackend): boolean {
	return backend.capabilities?.streaming === true && (backend.apiType === 'openai-completions' || backend.apiType === 'anthropic-messages');
}

function supportsToolCalling(backend: DirectorResolvedProviderBackend): boolean {
	return backend.capabilities?.toolCalling === true && (backend.apiType === 'openai-completions' || backend.apiType === 'anthropic-messages');
}

function toRuntimeProviderApiType(apiType: DirectorResolvedProviderBackend['apiType']): DirectorRuntimeProviderApiType {
	switch (apiType) {
		case 'anthropic-messages':
		case 'openai-completions':
		case 'openai-codex':
		case 'gemini-generative':
			return apiType;
		case 'local':
		case 'custom-http':
			throw new Error(`Unsupported Director provider api type '${apiType}'.`);
	}
}

async function executeToolCalls(
	toolCalls: readonly DirectorNormalizedToolCall[],
	advertisedToolNames: ReadonlySet<string>,
	executeToolCall: ((toolCall: DirectorNormalizedToolCall) => Promise<DirectorAgentToolExecution>) | undefined,
): Promise<readonly { readonly toolCall: DirectorNormalizedToolCall; readonly result: DirectorAgentToolExecution }[]> {
	const results = new Array<{ readonly toolCall: DirectorNormalizedToolCall; readonly result: DirectorAgentToolExecution }>(toolCalls.length);
	const readOnlyIndices: number[] = [];
	const mutationIndices: number[] = [];

	for (let index = 0; index < toolCalls.length; index++) {
		if (!advertisedToolNames.has(toolCalls[index].name) || !executeToolCall) {
			results[index] = {
				toolCall: toolCalls[index],
				result: {
					success: false,
					isError: true,
					content: !executeToolCall
						? `Error: No tool executor configured for "${toolCalls[index].name}"`
						: `Error: Tool not found: ${toolCalls[index].name}`,
				},
			};
		} else if (isDirectorReadOnlyTool(toolCalls[index].name)) {
			readOnlyIndices.push(index);
		} else {
			mutationIndices.push(index);
		}
	}

	const maxConcurrency = 10;
	const invokeAdvertisedTool = executeToolCall;
	if (!invokeAdvertisedTool && (readOnlyIndices.length || mutationIndices.length)) {
		throw new Error('Director AgentHost tool executor is unexpectedly unavailable.');
	}
	for (let index = 0; index < readOnlyIndices.length; index += maxConcurrency) {
		const batch = readOnlyIndices.slice(index, index + maxConcurrency);
		const batchResults = await Promise.all(batch.map(async toolCallIndex => ({
			toolCall: toolCalls[toolCallIndex],
			result: await invokeAdvertisedTool!(toolCalls[toolCallIndex]),
		})));
		for (let batchIndex = 0; batchIndex < batch.length; batchIndex++) {
			results[batch[batchIndex]] = batchResults[batchIndex];
		}
	}

	for (const toolCallIndex of mutationIndices) {
		const toolCall = toolCalls[toolCallIndex];
		results[toolCallIndex] = {
			toolCall,
			result: await invokeAdvertisedTool!(toolCall),
		};
	}

	return results;
}

function findRepeatedToolCall(toolCalls: readonly DirectorNormalizedToolCall[], counts: Map<string, number>): DirectorNormalizedToolCall | undefined {
	for (const toolCall of toolCalls) {
		const signature = stableToolCallSignature(toolCall);
		const count = (counts.get(signature) ?? 0) + 1;
		counts.set(signature, count);
		if (count > MAX_REPEATED_TOOL_CALLS) {
			return toolCall;
		}
	}
	return undefined;
}

function stableToolCallSignature(toolCall: DirectorNormalizedToolCall): string {
	return `${toolCall.name}\n${stableJsonObjectString(toolCall.input)}`;
}

function stableJsonObjectString(value: string): string {
	try {
		const parsed = JSON.parse(value) as unknown;
		return stableStringify(parsed);
	} catch {
		return value;
	}
}

function getOpenAIReasoningEchoForBackend(backend: DirectorResolvedProviderBackend): DirectorOpenAIReasoningEcho | undefined {
	if (backend.apiType !== 'openai-completions' || backend.providerKind !== 'openai-compatible') {
		return undefined;
	}
	const modelId = backend.modelId.trim().toLowerCase();
	return modelId === 'deepseek-v4-flash' || modelId === 'deepseek-v4-pro'
		? { field: 'reasoning_content', includeEmpty: true }
		: undefined;
}

function canApplyOpenAIReasoningEchoFallback(backend: DirectorResolvedProviderBackend, err: unknown): boolean {
	if (backend.apiType !== 'openai-completions' || backend.providerKind !== 'openai-compatible') {
		return false;
	}
	if (!(err instanceof DirectorProviderRuntimeHttpError) || err.status !== 400) {
		return false;
	}
	return /reasoning_content/i.test(err.message)
		&& /must be passed back/i.test(err.message)
		&& !/must\s+not/i.test(err.message);
}

function shouldRetryStatus(status: number): boolean {
	return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function stableStringify(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	try {
		return JSON.stringify(value ?? {});
	} catch {
		return '{}';
	}
}

export function stringifyDirectorToolResult(result: ToolCallResult): DirectorAgentToolExecution {
	const content = result.content?.map(stringifyToolResultContent).filter(Boolean).join('\n') ?? '';
	const structured = result.structuredContent ? stableStringify(result.structuredContent) : '';
	const text = [content, structured, result.error?.message].filter(Boolean).join('\n') || result.pastTenseMessage.toString();
	return {
		success: result.success,
		content: text,
		...(result.success ? {} : { isError: true }),
	};
}

function stringifyToolResultContent(content: ToolResultContent): string {
	switch (content.type) {
		case ToolResultContentType.Text:
			return content.text;
		case ToolResultContentType.EmbeddedResource:
			return `[embedded resource: ${content.contentType}]`;
		case ToolResultContentType.Resource:
			return `[resource: ${content.uri.toString()}]`;
		case ToolResultContentType.FileEdit:
			return `[file edit: ${(content.after?.uri ?? content.before?.uri)?.toString() ?? 'unknown'}]`;
		case ToolResultContentType.Terminal:
			return `[terminal: ${content.title}]`;
		case ToolResultContentType.Subagent:
			return `[subagent: ${content.title}]`;
	}
}
