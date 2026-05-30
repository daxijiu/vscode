/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { buildDirectorNativeMessageRequest, type DirectorNormalizedToolCall, type DirectorOpenAIReasoningEcho } from '../../../common/directorProviderAdapters.js';
import type { DirectorProviderApiType } from '../../../common/directorProviderBackend.js';
import type { DirectorCreateMessageParams, DirectorCreateMessageResponse, DirectorLLMProvider, DirectorNormalizedResponseBlock, DirectorProviderRuntimeOptions, DirectorProviderStreamEvent, DirectorRuntimeProviderApiType, DirectorTokenUsage } from '../../../common/directorProviderRuntime.js';

export interface DirectorProviderRuntimeCreateOptions extends DirectorProviderRuntimeOptions {
	readonly label?: string;
	readonly reasoningEcho?: DirectorOpenAIReasoningEcho;
}

export class DirectorProviderRuntimeHttpError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}

export function createDirectorProviderRuntime(apiType: DirectorRuntimeProviderApiType, options: DirectorProviderRuntimeCreateOptions): DirectorLLMProvider {
	return new DirectorFetchProvider(apiType, options);
}

class DirectorFetchProvider implements DirectorLLMProvider {
	readonly capabilities;

	constructor(
		readonly apiType: DirectorRuntimeProviderApiType,
		private readonly options: DirectorProviderRuntimeCreateOptions,
	) {
		this.capabilities = options.capabilities;
	}

	async createMessage(params: DirectorCreateMessageParams): Promise<DirectorCreateMessageResponse> {
		const response = await this.fetchRequest(params, false);
		const payload = await response.json() as unknown;
		return toCreateMessageResponse(parseProviderResponse(this.apiType, payload));
	}

	async *createMessageStream(params: DirectorCreateMessageParams): AsyncGenerator<DirectorProviderStreamEvent> {
		const response = await this.fetchRequest(params, true);
		let usage: DirectorTokenUsage | undefined;
		let stopReason = 'end_turn';
		for await (const data of readServerSentEventData(response, params.abortSignal)) {
			if (data === '[DONE]') {
				yield { type: 'message_complete', ...(usage ? { usage } : {}), stopReason };
				return;
			}
			const parsed = parseJsonObject(data);
			if (!parsed) {
				continue;
			}
			for (const event of parseProviderStreamEvent(this.apiType, parsed)) {
				if (event.type === 'message_complete') {
					usage = event.usage;
					stopReason = event.stopReason;
				}
				yield event;
			}
		}
		yield { type: 'message_complete', ...(usage ? { usage } : {}), stopReason };
	}

	private async fetchRequest(params: DirectorCreateMessageParams, stream: boolean): Promise<Response> {
		const request = buildDirectorNativeMessageRequest({
			apiType: this.apiType,
			baseURL: this.options.baseURL ?? defaultBaseURL(this.apiType),
			modelId: params.model,
			authHeader: authHeaderValue(this.options.auth),
			authKind: this.options.auth.kind,
			messages: params.messages,
			tools: params.tools,
			maxTokens: params.maxTokens,
			stream,
			thinking: params.thinking,
			reasoningEcho: this.options.reasoningEcho,
		});
		const fetcher = this.options.fetch ?? ((input, init) => fetch(input, init));
		const response = await fetcher(request.url, {
			method: request.method,
			headers: { ...(this.options.headers ?? {}), ...request.headers },
			body: request.body,
			signal: params.abortSignal,
		}, { callSite: `directorProvider.${this.apiType}` });
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new DirectorProviderRuntimeHttpError(
				response.status,
				`${this.options.label ?? 'Director provider'} returned ${response.status} ${response.statusText}${text ? `: ${redactCredential(text, this.options.auth)}` : ''}`
			);
		}
		return response;
	}
}

function defaultBaseURL(apiType: DirectorRuntimeProviderApiType): string {
	switch (apiType) {
		case 'anthropic-messages':
			return 'https://api.anthropic.com';
		case 'openai-completions':
			return 'https://api.openai.com/v1';
		case 'openai-codex':
			return 'https://chatgpt.com/backend-api/codex';
		case 'gemini-generative':
			return 'https://generativelanguage.googleapis.com/v1beta';
	}
}

function authHeaderValue(auth: DirectorProviderRuntimeOptions['auth']): string {
	return auth.kind === 'api-key' ? auth.value : auth.accessToken;
}

function redactCredential(value: string, auth: DirectorProviderRuntimeOptions['auth']): string {
	const credential = authHeaderValue(auth);
	return credential ? value.split(credential).join('<redacted>') : value;
}

interface ParsedProviderResponse {
	readonly text: string;
	readonly thinking?: string;
	readonly usage?: DirectorTokenUsage;
	readonly toolCalls: readonly DirectorNormalizedToolCall[];
}

function toCreateMessageResponse(parsed: ParsedProviderResponse): DirectorCreateMessageResponse {
	const content: DirectorNormalizedResponseBlock[] = [];
	if (parsed.thinking) {
		content.push({ type: 'thinking', thinking: parsed.thinking });
	}
	if (parsed.text) {
		content.push({ type: 'text', text: parsed.text });
	}
	for (const toolCall of parsed.toolCalls) {
		content.push({ type: 'tool_use', toolCall });
	}
	if (!content.length) {
		content.push({ type: 'text', text: '' });
	}
	return {
		content,
		stopReason: parsed.toolCalls.length ? 'tool_use' : 'end_turn',
		...(parsed.usage ? { usage: parsed.usage } : {}),
	};
}

function parseProviderResponse(apiType: DirectorProviderApiType, payload: unknown): ParsedProviderResponse {
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
				toolCalls: readGeminiToolCalls(value),
			};
		case 'local':
		case 'custom-http':
			throw new Error(`Unsupported Director provider api type '${apiType}'.`);
	}
}

function readAnthropicText(value: Record<string, unknown>): string {
	return arrayField(value, 'content').map(block => {
		const record = asRecord(block);
		return stringField(record, 'type') === 'text' || stringField(record, 'text') !== undefined ? stringField(record, 'text') : undefined;
	}).filter(Boolean).join('');
}

function readAnthropicUsage(value: Record<string, unknown>): DirectorTokenUsage | undefined {
	const usage = asRecord(value.usage);
	if (!usage) {
		return undefined;
	}
	return {
		input_tokens: numberField(usage, 'input_tokens') ?? 0,
		output_tokens: numberField(usage, 'output_tokens') ?? 0,
		cache_creation_input_tokens: numberField(usage, 'cache_creation_input_tokens'),
		cache_read_input_tokens: numberField(usage, 'cache_read_input_tokens'),
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
		return [{ id, name, input: stableStringify(record.input) }];
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
			input_tokens: numberField(usage, 'prompt_tokens') ?? 0,
			output_tokens: numberField(usage, 'completion_tokens') ?? 0,
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
		return [{ id, name, input: stringField(fn, 'arguments') ?? '{}' }];
	});
}

function readOpenAIResponsesResponse(value: Record<string, unknown>): ParsedProviderResponse {
	const outputText = stringField(value, 'output_text');
	if (outputText) {
		return { text: outputText, usage: readOpenAIResponsesUsage(value), toolCalls: readOpenAIResponsesToolCalls(value) };
	}
	const output = arrayField(value, 'output');
	const text = output.flatMap(item => {
		const content = arrayField(asRecord(item), 'content');
		return content.map(block => stringField(asRecord(block), 'text') ?? stringField(asRecord(block), 'content')).filter((entry): entry is string => !!entry);
	}).join('');
	return { text, usage: readOpenAIResponsesUsage(value), toolCalls: readOpenAIResponsesToolCalls(value) };
}

function readOpenAIResponsesUsage(value: Record<string, unknown>): DirectorTokenUsage | undefined {
	const usage = asRecord(value.usage);
	if (!usage) {
		return undefined;
	}
	return {
		input_tokens: numberField(usage, 'input_tokens') ?? 0,
		output_tokens: numberField(usage, 'output_tokens') ?? 0,
	};
}

function readOpenAIResponsesToolCalls(value: Record<string, unknown>): readonly DirectorNormalizedToolCall[] {
	return arrayField(value, 'output').flatMap((item, index) => {
		const record = asRecord(item);
		const type = stringField(record, 'type');
		if (type !== 'function_call') {
			return [];
		}
		const name = stringField(record, 'name');
		if (!name) {
			return [];
		}
		return [{
			id: stringField(record, 'call_id') ?? stringField(record, 'id') ?? `call_${index}`,
			name,
			input: stringField(record, 'arguments') ?? '{}',
		}];
	});
}

function readGeminiText(value: Record<string, unknown>): string {
	const candidate = asRecord(arrayField(value, 'candidates')[0]);
	const content = asRecord(candidate?.content);
	return arrayField(content, 'parts')
		.map(part => stringField(asRecord(part), 'text'))
		.filter(Boolean)
		.join('');
}

function readGeminiUsage(value: Record<string, unknown>): DirectorTokenUsage | undefined {
	const usage = asRecord(value.usageMetadata);
	if (!usage) {
		return undefined;
	}
	return {
		input_tokens: numberField(usage, 'promptTokenCount') ?? 0,
		output_tokens: numberField(usage, 'candidatesTokenCount') ?? 0,
	};
}

function readGeminiToolCalls(value: Record<string, unknown>): readonly DirectorNormalizedToolCall[] {
	const candidate = asRecord(arrayField(value, 'candidates')[0]);
	const content = asRecord(candidate?.content);
	return arrayField(content, 'parts').flatMap((part, index) => {
		const functionCall = asRecord(asRecord(part)?.functionCall);
		const name = stringField(functionCall, 'name');
		if (!name) {
			return [];
		}
		return [{ id: `gemini_call_${index}`, name, input: stableStringify(functionCall?.args ?? {}) }];
	});
}

function parseProviderStreamEvent(apiType: DirectorRuntimeProviderApiType, value: Record<string, unknown>): readonly DirectorProviderStreamEvent[] {
	switch (apiType) {
		case 'openai-completions':
			return readOpenAIChatStreamEvents(value);
		case 'anthropic-messages':
			return readAnthropicStreamEvents(value);
		case 'openai-codex':
			return readOpenAIResponsesStreamEvents(value);
		case 'gemini-generative':
			return readGeminiStreamEvents(value);
	}
}

function readOpenAIChatStreamEvents(value: Record<string, unknown>): readonly DirectorProviderStreamEvent[] {
	const choice = asRecord(arrayField(value, 'choices')[0]);
	const delta = asRecord(choice?.delta);
	const usage = asRecord(value.usage);
	const events: DirectorProviderStreamEvent[] = [];
	const thinking = stringField(delta, 'reasoning_content');
	const text = stringField(delta, 'content');
	if (thinking) {
		events.push({ type: 'thinking', thinking });
	}
	if (text) {
		events.push({ type: 'text', text });
	}
	for (const toolCall of arrayField(delta, 'tool_calls')) {
		const record = asRecord(toolCall);
		const fn = asRecord(record?.function);
		events.push({
			type: 'tool_call_delta',
			index: numberField(record, 'index') ?? 0,
			id: stringField(record, 'id'),
			name: stringField(fn, 'name'),
			arguments: stringField(fn, 'arguments'),
		});
	}
	if (usage) {
		events.push({
			type: 'message_complete',
			usage: {
				input_tokens: numberField(usage, 'prompt_tokens') ?? 0,
				output_tokens: numberField(usage, 'completion_tokens') ?? 0,
			},
			stopReason: mapOpenAIFinishReason(stringField(choice, 'finish_reason')),
		});
	}
	return events;
}

function readAnthropicStreamEvents(value: Record<string, unknown>): readonly DirectorProviderStreamEvent[] {
	const type = stringField(value, 'type');
	if (type === 'content_block_start') {
		const contentBlock = asRecord(value.content_block);
		if (stringField(contentBlock, 'type') === 'tool_use') {
			return [{
				type: 'tool_use_start',
				id: stringField(contentBlock, 'id') ?? `tool_${numberField(value, 'index') ?? 0}`,
				name: stringField(contentBlock, 'name') ?? 'tool',
				index: numberField(value, 'index'),
			}];
		}
	}
	if (type === 'content_block_delta') {
		const delta = asRecord(value.delta);
		const deltaType = stringField(delta, 'type');
		if (deltaType === 'input_json_delta') {
			return [{ type: 'tool_input_delta', json: stringField(delta, 'partial_json') ?? '', index: numberField(value, 'index') }];
		}
		const text = stringField(delta, 'text');
		const thinking = stringField(delta, 'thinking');
		return [
			...(text ? [{ type: 'text' as const, text }] : []),
			...(thinking ? [{ type: 'thinking' as const, thinking }] : []),
		];
	}
	if (type === 'message_delta') {
		const usage = asRecord(value.usage);
		return [{
			type: 'message_complete',
			usage: usage ? {
				input_tokens: numberField(usage, 'input_tokens') ?? 0,
				output_tokens: numberField(usage, 'output_tokens') ?? 0,
				cache_creation_input_tokens: numberField(usage, 'cache_creation_input_tokens'),
				cache_read_input_tokens: numberField(usage, 'cache_read_input_tokens'),
			} : { input_tokens: 0, output_tokens: 0 },
			stopReason: stringField(asRecord(value.delta), 'stop_reason') ?? 'end_turn',
		}];
	}
	return [];
}

function readOpenAIResponsesStreamEvents(value: Record<string, unknown>): readonly DirectorProviderStreamEvent[] {
	const type = stringField(value, 'type');
	const delta = stringField(value, 'delta');
	if ((type === 'response.output_text.delta' || type === 'response.output_item.delta') && delta) {
		return [{ type: 'text', text: delta }];
	}
	if (type === 'response.reasoning_summary_text.delta' && delta) {
		return [{ type: 'thinking', thinking: delta }];
	}
	if (type === 'response.completed') {
		const response = asRecord(value.response);
		return [{ type: 'message_complete', usage: response ? readOpenAIResponsesUsage(response) ?? { input_tokens: 0, output_tokens: 0 } : { input_tokens: 0, output_tokens: 0 }, stopReason: 'end_turn' }];
	}
	return [];
}

function readGeminiStreamEvents(value: Record<string, unknown>): readonly DirectorProviderStreamEvent[] {
	const text = readGeminiText(value);
	const usage = readGeminiUsage(value);
	return [
		...(text ? [{ type: 'text' as const, text }] : []),
		...(usage ? [{ type: 'message_complete' as const, usage, stopReason: 'end_turn' }] : []),
	];
}

async function* readServerSentEventData(response: Response, abortSignal: AbortSignal | undefined): AsyncGenerator<string> {
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
			if (abortSignal?.aborted) {
				throw new Error('Director provider request was cancelled.');
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

function mapOpenAIFinishReason(reason: string | undefined): string {
	switch (reason) {
		case 'stop':
			return 'end_turn';
		case 'length':
			return 'max_tokens';
		case 'tool_calls':
			return 'tool_use';
		default:
			return reason ?? 'end_turn';
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

function numberField(value: Record<string, unknown> | undefined, key: string): number | undefined {
	const field = value?.[key];
	return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}
