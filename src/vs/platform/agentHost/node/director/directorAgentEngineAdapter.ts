/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationError } from '../../../../base/common/errors.js';
import { ResponsePartKind, ToolResultContentType, type MessageAttachment, type ToolCallResult, type ToolResultContent, type Turn, type UsageInfo } from '../../common/state/sessionState.js';
import { buildDirectorNativeMessageRequest, type DirectorNormalizedMessage, type DirectorNormalizedToolCall, type DirectorNormalizedToolDefinition } from '../../common/directorProviderAdapters.js';
import type { DirectorResolvedProviderBackend } from '../../common/directorProviderBackend.js';
import type { DirectorRuntimeCredential, IDirectorRuntimeCredentialService } from '../../common/directorRuntimeCredentials.js';

export type DirectorAgentEngineEvent =
	| { readonly type: 'system'; readonly message: string }
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'textDelta'; readonly text: string }
	| { readonly type: 'thinking'; readonly thinking: string }
	| { readonly type: 'thinkingDelta'; readonly thinking: string }
	| { readonly type: 'usage'; readonly usage: UsageInfo }
	| { readonly type: 'result'; readonly subtype: 'success' };

export interface DirectorAgentToolExecution {
	readonly success: boolean;
	readonly content: string;
	readonly isError?: boolean;
}

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

		const authHeader = credentialToHeaderValue(credential);
		const messages = [...this.buildMessages(options)];
		const tools = supportsToolCalling(backend) ? options.tools ?? [] : [];
		const advertisedToolNames = new Set(tools.map(tool => tool.name));
		const maxToolIterations = options.maxToolIterations ?? 4;
		let toolSideEffectOccurred = false;
		let toolIterations = 0;

		while (true) {
			const stream = toolIterations === 0 && tools.length === 0 && supportsStreaming(backend);
			const request = buildDirectorNativeMessageRequest({
				apiType: backend.apiType,
				baseURL: backend.baseURL,
				modelId: backend.modelId,
				authHeader,
				messages,
				tools: tools.length ? tools : undefined,
				maxTokens: 2048,
				stream,
			});
			const response = await this.fetchProviderWithRetry(request, backend, credential, options.abortSignal, toolSideEffectOccurred);
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
				if (!options.executeToolCall) {
					throw new Error(`Director provider '${backend.providerInstanceId}' requested tools, but the AgentHost tool bridge is not available.`);
				}
				const unsupportedToolCall = parsed.toolCalls.find(toolCall => !advertisedToolNames.has(toolCall.name));
				if (unsupportedToolCall) {
					throw new Error(`Director provider '${backend.providerInstanceId}' requested unsupported tool '${unsupportedToolCall.name}'.`);
				}
				toolIterations++;
				if (toolIterations > maxToolIterations) {
					throw new Error(`Director AgentEngine stopped after ${maxToolIterations} tool iterations to avoid an infinite tool loop.`);
				}
				messages.push({
					role: 'assistant',
					content: parsed.text,
					toolCalls: parsed.toolCalls,
				});
				for (const toolCall of parsed.toolCalls) {
					const result = await options.executeToolCall(toolCall);
					toolSideEffectOccurred = true;
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

	private buildMessages(options: DirectorAgentEngineTurnOptions): readonly DirectorNormalizedMessage[] {
		const messages: DirectorNormalizedMessage[] = [{
			role: 'system',
			content: buildDirectorSystemPrompt(options.cwd),
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

function buildDirectorSystemPrompt(cwd: string | undefined): string {
	return [
		'You are Director, an AI coding assistant running inside VS Code AgentHost.',
		'Use the selected Director provider backend for this turn.',
		cwd ? `Working directory: ${cwd}` : undefined,
	].filter((line): line is string => line !== undefined).join('\n');
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
