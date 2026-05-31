/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../base/common/uuid.js';
import { DirectorCreateMessageParams, DirectorCreateMessageResponse, DirectorNormalizedResponseBlock, DirectorTokenUsage } from '../../common/directorProviderRuntime.js';
import { DirectorNormalizedMessage, DirectorNormalizedToolCall, DirectorNormalizedToolDefinition } from '../../common/directorProviderAdapters.js';

const DEFAULT_MAX_TOKENS = 2048;

export function toDirectorCreateMessageParams(body: Record<string, unknown>, modelId: string, abortSignal: AbortSignal): DirectorCreateMessageParams {
	return {
		model: modelId,
		maxTokens: numberField(body, 'max_tokens') ?? DEFAULT_MAX_TOKENS,
		messages: toDirectorMessages(body),
		tools: toDirectorTools(body.tools),
		thinking: toDirectorThinking(body.thinking),
		abortSignal,
	};
}

function toDirectorThinking(value: unknown): DirectorCreateMessageParams['thinking'] | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const type = stringField(value, 'type');
	if (!type) {
		return undefined;
	}
	return {
		type,
		...(numberField(value, 'budget_tokens') !== undefined ? { budget_tokens: numberField(value, 'budget_tokens') } : {}),
	};
}

function toDirectorMessages(body: Record<string, unknown>): readonly DirectorNormalizedMessage[] {
	const messages: DirectorNormalizedMessage[] = [];
	const system = contentText(body.system);
	if (system) {
		messages.push({ role: 'system', content: system });
	}

	for (const item of arrayField(body, 'messages')) {
		const record = isRecord(item) ? item : undefined;
		const role = stringField(record, 'role');
		if (!record || (role !== 'user' && role !== 'assistant')) {
			continue;
		}

		const toolResults = toolResultMessages(record.content);
		const text = contentText(record.content);
		const thinking = contentThinking(record.content);
		const toolCalls = role === 'assistant' ? contentToolCalls(record.content) : [];
		if (text || thinking || toolCalls.length || !toolResults.length) {
			messages.push({
				role,
				content: text,
				...(thinking ? { thinking } : {}),
				...(toolCalls.length ? { toolCalls } : {}),
			});
		}
		messages.push(...toolResults);
	}
	return messages;
}

function toDirectorTools(value: unknown): readonly DirectorNormalizedToolDefinition[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const tools = value.flatMap((tool): DirectorNormalizedToolDefinition[] => {
		const record = isRecord(tool) ? tool : undefined;
		const name = stringField(record, 'name');
		if (!name) {
			return [];
		}
		const inputSchema = normalizeInputSchema(record?.input_schema);
		return [{
			name,
			description: stringField(record, 'description'),
			inputSchema,
		}];
	});
	return tools.length ? tools : undefined;
}

export function toAnthropicMessage(response: DirectorCreateMessageResponse, model: string): Record<string, unknown> {
	return {
		id: createAnthropicMessageId(),
		type: 'message',
		role: 'assistant',
		model,
		content: response.content.map(toAnthropicContentBlock),
		stop_reason: toAnthropicStopReason(response.stopReason),
		stop_sequence: null,
		usage: toAnthropicUsage(response.usage),
	};
}

function toAnthropicContentBlock(block: DirectorNormalizedResponseBlock): Record<string, unknown> {
	switch (block.type) {
		case 'text':
			return { type: 'text', text: block.text };
		case 'thinking':
			return { type: 'thinking', thinking: block.thinking, signature: '' };
		case 'tool_use':
			return {
				type: 'tool_use',
				id: block.toolCall.id,
				name: block.toolCall.name,
				input: parseToolInput(block.toolCall.input),
			};
	}
}

export function toAnthropicUsage(usage: DirectorTokenUsage | undefined): Record<string, number> {
	return {
		input_tokens: usage?.input_tokens ?? 0,
		output_tokens: usage?.output_tokens ?? 0,
		...(usage?.cache_creation_input_tokens !== undefined ? { cache_creation_input_tokens: usage.cache_creation_input_tokens } : {}),
		...(usage?.cache_read_input_tokens !== undefined ? { cache_read_input_tokens: usage.cache_read_input_tokens } : {}),
	};
}

export function toAnthropicStopReason(stopReason: string): string {
	switch (stopReason) {
		case 'tool_use':
		case 'max_tokens':
		case 'end_turn':
			return stopReason;
		case 'stop':
			return 'end_turn';
		case 'length':
			return 'max_tokens';
		case 'tool_calls':
			return 'tool_use';
		default:
			return stopReason || 'end_turn';
	}
}

function contentText(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (!Array.isArray(value)) {
		return '';
	}
	return value.map(block => {
		const record = isRecord(block) ? block : undefined;
		if (stringField(record, 'type') === 'text') {
			return stringField(record, 'text') ?? '';
		}
		return '';
	}).filter(text => !!text).join('\n');
}

function contentThinking(value: unknown): string | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const thinking = value.map(block => {
		const record = isRecord(block) ? block : undefined;
		if (stringField(record, 'type') === 'thinking') {
			return stringField(record, 'thinking') ?? '';
		}
		return '';
	}).filter(text => !!text).join('\n');
	return thinking || undefined;
}

function contentToolCalls(value: unknown): readonly DirectorNormalizedToolCall[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap((block): DirectorNormalizedToolCall[] => {
		const record = isRecord(block) ? block : undefined;
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

function toolResultMessages(value: unknown): readonly DirectorNormalizedMessage[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap((block): DirectorNormalizedMessage[] => {
		const record = isRecord(block) ? block : undefined;
		if (!record || stringField(record, 'type') !== 'tool_result') {
			return [];
		}
		const toolCallId = stringField(record, 'tool_use_id');
		return [{
			role: 'tool',
			content: contentText(record.content) || stableStringify(record.content),
			...(toolCallId ? { toolCallId } : {}),
			isError: record.is_error === true,
		}];
	});
}

function normalizeInputSchema(value: unknown): DirectorNormalizedToolDefinition['inputSchema'] | undefined {
	if (!isRecord(value) || value.type !== 'object') {
		return undefined;
	}
	const properties = isRecord(value.properties) ? value.properties as Record<string, object> : undefined;
	const required = Array.isArray(value.required) ? value.required.filter((item): item is string => typeof item === 'string') : undefined;
	return {
		type: 'object',
		...(properties ? { properties } : {}),
		...(required ? { required } : {}),
	} satisfies DirectorNormalizedToolDefinition['inputSchema'];
}

function parseToolInput(input: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(input) as unknown;
		if (isRecord(parsed)) {
			return parsed;
		}
		return { input: parsed };
	} catch {
		return { input };
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

export function createAnthropicMessageId(): string {
	return `msg_${generateUuid().replace(/-/g, '')}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function arrayField(value: Record<string, unknown> | undefined, key: string): readonly unknown[] {
	const field = value?.[key];
	return Array.isArray(field) ? field : [];
}

export function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
	const field = value?.[key];
	return typeof field === 'string' ? field : undefined;
}

function numberField(value: Record<string, unknown> | undefined, key: string): number | undefined {
	const field = value?.[key];
	return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}
