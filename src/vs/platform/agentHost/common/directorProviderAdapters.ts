/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DirectorProviderApiType } from './directorProviderBackend.js';

export type DirectorNormalizedMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface DirectorNormalizedToolCall {
	readonly id: string;
	readonly name: string;
	readonly input: string;
}

export interface DirectorNormalizedMessage {
	readonly role: DirectorNormalizedMessageRole;
	readonly content: string;
	readonly toolCalls?: readonly DirectorNormalizedToolCall[];
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly isError?: boolean;
}

export interface DirectorNormalizedToolDefinition {
	readonly name: string;
	readonly title?: string;
	readonly description?: string;
	readonly inputSchema?: {
		readonly type: 'object';
		readonly properties?: Record<string, object>;
		readonly required?: string[];
	};
}

export interface DirectorNativeMessageRequest {
	readonly apiType: DirectorProviderApiType;
	readonly url: string;
	readonly method: 'POST';
	readonly headers: Record<string, string>;
	readonly body: string;
}

export interface DirectorNativeMessageRequestOptions {
	readonly apiType: DirectorProviderApiType;
	readonly baseURL: string;
	readonly modelId: string;
	readonly authHeader: string;
	readonly messages: readonly DirectorNormalizedMessage[];
	readonly tools?: readonly DirectorNormalizedToolDefinition[];
	readonly maxTokens?: number;
	readonly stream?: boolean;
}

export function buildDirectorNativeMessageRequest(options: DirectorNativeMessageRequestOptions): DirectorNativeMessageRequest {
	const normalizedBaseURL = options.baseURL.replace(/\/+$/, '');
	const maxTokens = options.maxTokens ?? 1024;

	switch (options.apiType) {
		case 'anthropic-messages':
			return {
				apiType: options.apiType,
				url: `${normalizedBaseURL}/v1/messages`,
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-api-key': options.authHeader,
					'anthropic-version': '2023-06-01',
				},
				body: JSON.stringify({
					model: options.modelId,
					max_tokens: maxTokens,
					...(systemPrompt(options.messages) ? { system: systemPrompt(options.messages) } : {}),
					messages: buildAnthropicMessages(options.messages),
					...(options.tools?.length ? { tools: buildAnthropicTools(options.tools) } : {}),
					stream: options.stream === true,
				}),
			};
		case 'openai-completions':
			return {
				apiType: options.apiType,
				url: `${normalizedBaseURL}/chat/completions`,
				method: 'POST',
				headers: {
					authorization: `Bearer ${options.authHeader}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					model: options.modelId,
					max_tokens: maxTokens,
					messages: buildOpenAIChatMessages(options.messages),
					...(options.tools?.length ? { tools: buildOpenAITools(options.tools), tool_choice: 'auto' } : {}),
					stream: options.stream === true,
				}),
			};
		case 'openai-codex':
			return {
				apiType: options.apiType,
				url: `${normalizedBaseURL}/responses`,
				method: 'POST',
				headers: {
					authorization: `Bearer ${options.authHeader}`,
					'content-type': 'application/json',
					'openai-beta': 'responses=experimental',
					originator: 'director-code',
				},
				body: JSON.stringify({
					model: options.modelId,
					input: options.messages.map(message => ({
						role: message.role === 'assistant' ? 'assistant' : 'user',
						content: message.content,
					})),
					max_output_tokens: maxTokens,
					stream: options.stream === true,
				}),
			};
		case 'gemini-generative':
			return {
				apiType: options.apiType,
				url: `${normalizedBaseURL}/models/${encodeURIComponent(options.modelId)}:generateContent`,
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-goog-api-key': options.authHeader,
				},
				body: JSON.stringify({
					contents: options.messages.filter(message => message.role !== 'system').map(message => ({
						role: message.role === 'assistant' ? 'model' : 'user',
						parts: [{ text: message.content }],
					})),
					generationConfig: {
						maxOutputTokens: maxTokens,
					},
				}),
			};
		case 'local':
		case 'custom-http':
			throw new Error(`Director provider api type '${options.apiType}' does not have a Phase 3 normalized message adapter.`);
	}
}

function systemPrompt(messages: readonly DirectorNormalizedMessage[]): string | undefined {
	const content = messages
		.filter(message => message.role === 'system')
		.map(message => message.content.trim())
		.filter(message => !!message)
		.join('\n\n');
	return content || undefined;
}

function buildOpenAIChatMessages(messages: readonly DirectorNormalizedMessage[]): readonly Record<string, unknown>[] {
	return messages.map(message => {
		if (message.role === 'tool') {
			return {
				role: 'tool',
				tool_call_id: message.toolCallId ?? message.toolName ?? 'director-tool-call',
				content: message.content,
			};
		}
		if (message.role === 'assistant' && message.toolCalls?.length) {
			return {
				role: 'assistant',
				content: message.content || null,
				tool_calls: message.toolCalls.map(toolCall => ({
					id: toolCall.id,
					type: 'function',
					function: {
						name: toolCall.name,
						arguments: toolCall.input,
					},
				})),
			};
		}
		return {
			role: message.role,
			content: message.content,
		};
	});
}

function buildOpenAITools(tools: readonly DirectorNormalizedToolDefinition[]): readonly Record<string, unknown>[] {
	return tools.map(tool => ({
		type: 'function',
		function: {
			name: tool.name,
			description: tool.description ?? tool.title ?? '',
			parameters: tool.inputSchema ?? { type: 'object', properties: {} },
		},
	}));
}

function buildAnthropicMessages(messages: readonly DirectorNormalizedMessage[]): readonly Record<string, unknown>[] {
	return messages
		.filter(message => message.role !== 'system')
		.map(message => {
			if (message.role === 'assistant' && message.toolCalls?.length) {
				const content: Record<string, unknown>[] = [];
				if (message.content.trim()) {
					content.push({ type: 'text', text: message.content });
				}
				content.push(...message.toolCalls.map(toolCall => ({
					type: 'tool_use',
					id: toolCall.id,
					name: toolCall.name,
					input: parseToolInput(toolCall.input),
				})));
				return { role: 'assistant', content };
			}
			if (message.role === 'tool') {
				return {
					role: 'user',
					content: [{
						type: 'tool_result',
						tool_use_id: message.toolCallId ?? message.toolName ?? 'director-tool-call',
						content: message.content,
						...(message.isError ? { is_error: true } : {}),
					}],
				};
			}
			return {
				role: message.role === 'assistant' ? 'assistant' : 'user',
				content: message.content,
			};
		});
}

function buildAnthropicTools(tools: readonly DirectorNormalizedToolDefinition[]): readonly Record<string, unknown>[] {
	return tools.map(tool => ({
		name: tool.name,
		description: tool.description ?? tool.title ?? '',
		input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
	}));
}

function parseToolInput(input: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(input) as unknown;
		if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return { input: parsed };
	} catch {
		return { input };
	}
}
