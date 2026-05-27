/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationError } from '../../../../base/common/errors.js';
import { ResponsePartKind, ToolResultContentType, type MessageAttachment, type ToolCallResult, type ToolResultContent, type Turn, type UsageInfo } from '../../common/state/sessionState.js';
import { buildDirectorNativeMessageRequest, type DirectorNormalizedMessage, type DirectorNormalizedToolCall, type DirectorNormalizedToolDefinition, type DirectorOpenAIReasoningEcho } from '../../common/directorProviderAdapters.js';
import type { DirectorResolvedProviderBackend } from '../../common/directorProviderBackend.js';
import type { DirectorRuntimeCredential, IDirectorRuntimeCredentialService } from '../../common/directorRuntimeCredentials.js';
import { isDirectorReadOnlyTool } from '../../common/directorToolPolicy.js';

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
		const authHeader = credentialToHeaderValue(credential);
		const messages = [...this.buildMessages(options, tools)];
		const advertisedToolNames = new Set(tools.map(tool => tool.name));
		const maxToolIterations = options.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
		let toolSideEffectOccurred = false;
		let toolIterations = 0;
		const toolCallSignatureCounts = new Map<string, number>();
		let reasoningEcho = getOpenAIReasoningEchoForBackend(backend);

		while (true) {
			const stream = toolIterations === 0 && tools.length === 0 && supportsStreaming(backend);
			let response: Response;
			while (true) {
				const request = buildDirectorNativeMessageRequest({
					apiType: backend.apiType,
					baseURL: backend.baseURL,
					modelId: backend.modelId,
					authHeader,
					messages,
					tools: tools.length ? tools : undefined,
					maxTokens: 2048,
					stream,
					reasoningEcho,
				});
				try {
					response = await this.fetchProviderWithRetry(request, backend, credential, options.abortSignal, toolSideEffectOccurred);
					break;
				} catch (err) {
					if (!reasoningEcho && canApplyOpenAIReasoningEchoFallback(backend, err)) {
						reasoningEcho = { field: 'reasoning_content', includeEmpty: true };
						continue;
					}
					throw err;
				}
			}
			if (stream) {
				const streamed = yield* this.streamProviderResponse(backend, response, options.abortSignal);
				if (!streamed.text.trim() && !streamed.thinking?.trim()) {
					throw new Error(`Director provider '${backend.providerInstanceId}' returned an empty response.`);
				}
				if (streamed.usage) {
					yield { type: 'usage', usage: streamed.usage };
				}
				yield { type: 'result', subtype: 'success' };
				return;
			}

			const payload = await response.json() as unknown;
			const parsed = parseProviderResponse(backend.apiType, payload);
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

	private async fetchProviderWithRetry(
		request: ReturnType<typeof buildDirectorNativeMessageRequest>,
		backend: DirectorResolvedProviderBackend,
		credential: DirectorRuntimeCredential,
		abortSignal: AbortSignal,
		toolSideEffectOccurred: boolean,
	): Promise<Response> {
		const headers = { ...backend.headers, ...request.headers };
		let lastError: Error | undefined;
		for (let attempt = 0; attempt < 2; attempt++) {
			if (abortSignal.aborted) {
				throw new CancellationError();
			}
			try {
				const response = await this.fetcher(request.url, {
					method: request.method,
					headers,
					body: request.body,
					signal: abortSignal,
				});
				if (abortSignal.aborted) {
					throw new CancellationError();
				}
				if (response.ok) {
					return response;
				}
				const text = await response.text().catch(() => '');
				const error = new DirectorProviderHttpError(
					response.status,
					`Director provider '${backend.providerInstanceId}' returned ${response.status} ${response.statusText}${text ? `: ${redactCredential(text, credential)}` : ''}`
				);
				if (attempt === 0 && !toolSideEffectOccurred && shouldRetryStatus(response.status)) {
					lastError = error;
					continue;
				}
				throw error;
			} catch (err) {
				if (abortSignal.aborted || err instanceof CancellationError) {
					throw new CancellationError();
				}
				const error = err instanceof Error ? err : new Error(String(err));
				if (attempt === 0 && !toolSideEffectOccurred && !(error instanceof DirectorProviderHttpError)) {
					lastError = error;
					continue;
				}
				throw error;
			}
		}
		throw lastError ?? new Error(`Director provider '${backend.providerInstanceId}' request failed.`);
	}

	private async *streamProviderResponse(
		backend: DirectorResolvedProviderBackend,
		response: Response,
		abortSignal: AbortSignal,
	): AsyncGenerator<DirectorAgentEngineEvent, ParsedProviderResponse> {
		const accumulated: MutableParsedProviderResponse = { text: '', toolCalls: [] };
		for await (const data of readServerSentEventData(response, abortSignal)) {
			if (data === '[DONE]') {
				break;
			}
			const parsed = parseJsonObject(data);
			if (!parsed) {
				continue;
			}
			const delta = parseProviderStreamDelta(backend.apiType, parsed);
			if (delta.text) {
				accumulated.text += delta.text;
				yield { type: 'textDelta', text: delta.text };
			}
			if (delta.thinking) {
				accumulated.thinking = (accumulated.thinking ?? '') + delta.thinking;
				yield { type: 'thinkingDelta', thinking: delta.thinking };
			}
			if (delta.usage) {
				accumulated.usage = mergeUsage(accumulated.usage, delta.usage);
			}
		}
		return accumulated;
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

function credentialToHeaderValue(credential: DirectorRuntimeCredential): string {
	switch (credential.kind) {
		case 'api-key':
			return credential.value;
		case 'bearer':
			return credential.accessToken;
		case 'none':
			return '';
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

interface ProviderStreamDelta {
	readonly text?: string;
	readonly thinking?: string;
	readonly usage?: UsageInfo;
}

function parseProviderResponse(apiType: DirectorResolvedProviderBackend['apiType'], payload: unknown): ParsedProviderResponse {
	const value = asRecord(payload);
	if (!value) {
		return { text: '', toolCalls: [] };
	}
	switch (apiType) {
		case 'anthropic-messages':
			return {
				text: readAnthropicText(value),
				usage: readAnthropicUsage(value),
				toolCalls: readAnthropicToolCalls(value),
			};
		case 'openai-completions':
			return readOpenAIChatResponse(value);
		case 'openai-codex':
			return readOpenAIResponsesResponse(value);
		case 'gemini-generative':
			return {
				text: readGeminiText(value),
				usage: readGeminiUsage(value),
				toolCalls: [],
			};
		case 'local':
		case 'custom-http':
			throw new Error(`Unsupported Director provider api type '${apiType}'.`);
	}
}

function readAnthropicText(value: Record<string, unknown>): string {
	const content = arrayField(value, 'content');
	return content.map(block => {
		const record = asRecord(block);
		return stringField(record, 'type') === 'text' || stringField(record, 'text') !== undefined ? stringField(record, 'text') : undefined;
	}).filter(Boolean).join('');
}

function readAnthropicUsage(value: Record<string, unknown>): UsageInfo | undefined {
	const usage = asRecord(value.usage);
	if (!usage) {
		return undefined;
	}
	return {
		inputTokens: numberField(usage, 'input_tokens'),
		outputTokens: numberField(usage, 'output_tokens'),
		cacheReadTokens: numberField(usage, 'cache_read_input_tokens'),
	};
}

function readAnthropicToolCalls(value: Record<string, unknown>): readonly DirectorNormalizedToolCall[] {
	return arrayField(value, 'content').flatMap(block => {
		const record = asRecord(block);
		if (!record || stringField(record, 'type') !== 'tool_use') {
			return [];
		}
		const id = stringField(record, 'id');
		const name = stringField(record, 'name');
		if (!id || !name) {
			return [];
		}
		return [{
			id,
			name,
			input: stableStringify(record.input),
		}];
	});
}

function readOpenAIChatResponse(value: Record<string, unknown>): ParsedProviderResponse {
	const choice = asRecord(arrayField(value, 'choices')[0]);
	const message = asRecord(choice?.message);
	const usage = asRecord(value.usage);
	return {
		text: stringField(message, 'content') ?? '',
		thinking: stringField(message, 'reasoning_content'),
		usage: usage ? {
			inputTokens: numberField(usage, 'prompt_tokens'),
			outputTokens: numberField(usage, 'completion_tokens'),
		} : undefined,
		toolCalls: readOpenAIToolCalls(message),
	};
}

function readOpenAIToolCalls(message: Record<string, unknown> | undefined): readonly DirectorNormalizedToolCall[] {
	return arrayField(message, 'tool_calls').flatMap(toolCall => {
		const record = asRecord(toolCall);
		const fn = asRecord(record?.function);
		const id = stringField(record, 'id');
		const name = stringField(fn, 'name');
		if (!id || !name) {
			return [];
		}
		return [{
			id,
			name,
			input: stringField(fn, 'arguments') ?? '{}',
		}];
	});
}

function readOpenAIResponsesResponse(value: Record<string, unknown>): ParsedProviderResponse {
	const outputText = stringField(value, 'output_text');
	if (outputText) {
		return { text: outputText, usage: readOpenAIResponsesUsage(value), toolCalls: [] };
	}

	const output = arrayField(value, 'output');
	const text = output.flatMap(item => {
		const content = arrayField(asRecord(item), 'content');
		return content.map(block => stringField(asRecord(block), 'text') ?? stringField(asRecord(block), 'content')).filter((entry): entry is string => !!entry);
	}).join('');
	return { text, usage: readOpenAIResponsesUsage(value), toolCalls: [] };
}

function readOpenAIResponsesUsage(value: Record<string, unknown>): UsageInfo | undefined {
	const usage = asRecord(value.usage);
	if (!usage) {
		return undefined;
	}
	return {
		inputTokens: numberField(usage, 'input_tokens'),
		outputTokens: numberField(usage, 'output_tokens'),
	};
}

function readGeminiText(value: Record<string, unknown>): string {
	const candidate = asRecord(arrayField(value, 'candidates')[0]);
	const content = asRecord(candidate?.content);
	return arrayField(content, 'parts')
		.map(part => stringField(asRecord(part), 'text'))
		.filter(Boolean)
		.join('');
}

function readGeminiUsage(value: Record<string, unknown>): UsageInfo | undefined {
	const usage = asRecord(value.usageMetadata);
	if (!usage) {
		return undefined;
	}
	return {
		inputTokens: numberField(usage, 'promptTokenCount'),
		outputTokens: numberField(usage, 'candidatesTokenCount'),
	};
}

function parseProviderStreamDelta(apiType: DirectorResolvedProviderBackend['apiType'], value: Record<string, unknown>): ProviderStreamDelta {
	switch (apiType) {
		case 'openai-completions':
			return readOpenAIChatStreamDelta(value);
		case 'anthropic-messages':
			return readAnthropicStreamDelta(value);
		case 'openai-codex':
		case 'gemini-generative':
		case 'local':
		case 'custom-http':
			return {};
	}
}

function readOpenAIChatStreamDelta(value: Record<string, unknown>): ProviderStreamDelta {
	const choice = asRecord(arrayField(value, 'choices')[0]);
	const delta = asRecord(choice?.delta);
	const usage = asRecord(value.usage);
	return {
		text: stringField(delta, 'content'),
		thinking: stringField(delta, 'reasoning_content'),
		usage: usage ? {
			inputTokens: numberField(usage, 'prompt_tokens'),
			outputTokens: numberField(usage, 'completion_tokens'),
		} : undefined,
	};
}

function readAnthropicStreamDelta(value: Record<string, unknown>): ProviderStreamDelta {
	const type = stringField(value, 'type');
	if (type === 'content_block_delta') {
		const delta = asRecord(value.delta);
		return {
			text: stringField(delta, 'text'),
			thinking: stringField(delta, 'thinking'),
		};
	}
	if (type === 'message_delta') {
		const usage = asRecord(value.usage);
		return {
			usage: usage ? {
				inputTokens: numberField(usage, 'input_tokens'),
				outputTokens: numberField(usage, 'output_tokens'),
				cacheReadTokens: numberField(usage, 'cache_read_input_tokens'),
			} : undefined,
		};
	}
	return {};
}

async function* readServerSentEventData(response: Response, abortSignal: AbortSignal): AsyncGenerator<string> {
	if (!response.body) {
		const text = await response.text();
		for (const block of text.split(/\r?\n\r?\n/)) {
			const data = readSseDataBlock(block);
			if (data !== undefined) {
				yield data;
			}
		}
		return;
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		while (true) {
			if (abortSignal.aborted) {
				throw new CancellationError();
			}
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			let boundary = findSseBoundary(buffer);
			while (boundary >= 0) {
				const block = buffer.slice(0, boundary);
				buffer = buffer.slice(buffer.charAt(boundary) === '\r' ? boundary + 4 : boundary + 2);
				const data = readSseDataBlock(block);
				if (data !== undefined) {
					yield data;
				}
				boundary = findSseBoundary(buffer);
			}
		}
		buffer += decoder.decode();
		const data = readSseDataBlock(buffer);
		if (data !== undefined) {
			yield data;
		}
	} finally {
		reader.releaseLock();
	}
}

function findSseBoundary(buffer: string): number {
	const lf = buffer.indexOf('\n\n');
	const crlf = buffer.indexOf('\r\n\r\n');
	if (lf === -1) {
		return crlf;
	}
	if (crlf === -1) {
		return lf;
	}
	return Math.min(lf, crlf);
}

function readSseDataBlock(block: string): string | undefined {
	const data = block
		.split(/\r?\n/)
		.filter(line => line.startsWith('data:'))
		.map(line => line.slice('data:'.length).trimStart())
		.join('\n');
	return data || undefined;
}

function parseJsonObject(data: string): Record<string, unknown> | undefined {
	try {
		return asRecord(JSON.parse(data) as unknown);
	} catch {
		return undefined;
	}
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
	if (!(err instanceof DirectorProviderHttpError) || err.status !== 400) {
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

function redactCredential(value: string, credential: DirectorRuntimeCredential): string {
	switch (credential.kind) {
		case 'api-key':
			return value.split(credential.value).join('<redacted>');
		case 'bearer':
			return value.split(credential.accessToken).join('<redacted>');
		case 'none':
		case 'missing':
			return value;
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function arrayField(value: Record<string, unknown> | undefined, key: string): readonly unknown[] {
	const field = value?.[key];
	return Array.isArray(field) ? field : [];
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
	const field = value?.[key];
	return typeof field === 'string' ? field : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
	const field = value[key];
	return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}

class DirectorProviderHttpError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}
