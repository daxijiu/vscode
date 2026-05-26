/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DirectorProviderApiType } from './directorProviderBackend.js';

export type DirectorNormalizedMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface DirectorNormalizedMessage {
	readonly role: DirectorNormalizedMessageRole;
	readonly content: string;
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
					messages: options.messages.filter(message => message.role !== 'system').map(message => ({
						role: message.role === 'assistant' ? 'assistant' : 'user',
						content: message.content,
					})),
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
					messages: options.messages.map(message => ({
						role: message.role === 'tool' ? 'user' : message.role,
						content: message.content,
					})),
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
