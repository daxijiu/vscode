/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DirectorProviderApiType, DirectorProviderCapabilities } from './directorProviderBackend.js';
import type { DirectorNormalizedMessage, DirectorNormalizedToolCall, DirectorNormalizedToolDefinition } from './directorProviderAdapters.js';

export type DirectorRuntimeProviderApiType = Extract<DirectorProviderApiType, 'anthropic-messages' | 'openai-completions' | 'openai-codex' | 'gemini-generative'>;

export type DirectorProviderRuntimeAuth =
	| { readonly kind: 'api-key'; readonly value: string }
	| { readonly kind: 'bearer'; readonly accessToken: string; readonly refreshToken?: string; readonly clientId?: string };

export interface DirectorProviderRuntimeOptions {
	readonly auth: DirectorProviderRuntimeAuth;
	readonly baseURL?: string;
	readonly headers?: Record<string, string>;
	readonly capabilities?: DirectorProviderCapabilities;
	readonly fetch?: DirectorProviderFetch;
}

export type DirectorProviderFetch = (input: RequestInfo | URL, init?: RequestInit, options?: { readonly timeoutMs?: number; readonly callSite?: string }) => Promise<Response>;

export interface DirectorCreateMessageParams {
	readonly model: string;
	readonly maxTokens: number;
	readonly messages: readonly DirectorNormalizedMessage[];
	readonly tools?: readonly DirectorNormalizedToolDefinition[];
	readonly thinking?: { readonly type: string; readonly budget_tokens?: number };
	readonly abortSignal?: AbortSignal;
}

export interface DirectorCreateMessageResponse {
	readonly content: readonly DirectorNormalizedResponseBlock[];
	readonly stopReason: 'end_turn' | 'max_tokens' | 'tool_use' | string;
	readonly usage?: DirectorTokenUsage;
}

export type DirectorNormalizedResponseBlock =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'tool_use'; readonly toolCall: DirectorNormalizedToolCall; readonly thoughtSignature?: string }
	| { readonly type: 'thinking'; readonly thinking: string };

export interface DirectorTokenUsage {
	readonly input_tokens: number;
	readonly output_tokens: number;
	readonly cache_creation_input_tokens?: number;
	readonly cache_read_input_tokens?: number;
}

export type DirectorProviderStreamEvent =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'tool_use_start'; readonly id: string; readonly name: string; readonly index?: number; readonly thoughtSignature?: string }
	| { readonly type: 'tool_input_delta'; readonly json: string; readonly index?: number }
	| { readonly type: 'tool_call_delta'; readonly index: number; readonly id?: string; readonly name?: string; readonly arguments?: string }
	| { readonly type: 'thinking'; readonly thinking: string }
	| { readonly type: 'message_complete'; readonly usage?: DirectorTokenUsage; readonly stopReason: string };

export interface DirectorLLMProvider {
	readonly apiType: DirectorRuntimeProviderApiType;
	readonly capabilities?: DirectorProviderCapabilities;
	createMessage(params: DirectorCreateMessageParams): Promise<DirectorCreateMessageResponse>;
	createMessageStream?(params: DirectorCreateMessageParams): AsyncGenerator<DirectorProviderStreamEvent>;
}

export function mergeDirectorProviderCapabilities(
	base: DirectorProviderCapabilities | undefined,
	override: DirectorProviderCapabilities | undefined,
): DirectorProviderCapabilities | undefined {
	if (!base) {
		return override;
	}
	if (!override) {
		return base;
	}
	return { ...base, ...override };
}

export function buildDirectorProviderUrl(baseURL: string, path: string): string {
	const base = baseURL.replace(/\/+$/, '');
	const normalizedPath = path.startsWith('/') ? path : `/${path}`;
	if (base.endsWith('/v1') && normalizedPath.startsWith('/v1/')) {
		return `${base}${normalizedPath.slice('/v1'.length)}`;
	}
	if (base.endsWith('/v1') && normalizedPath === '/v1') {
		return base;
	}
	return `${base}${normalizedPath}`;
}

export function applyDirectorOpenAIMaxTokens(body: Record<string, unknown>, modelId: string, maxTokens: number): void {
	if (shouldUseDirectorOpenAIMaxCompletionTokens(modelId)) {
		body.max_completion_tokens = maxTokens;
	} else {
		body.max_tokens = maxTokens;
	}
}

export function shouldUseDirectorOpenAIMaxCompletionTokens(modelId: string): boolean {
	return /^o(?:1|3|4)(?:-|$)/.test(modelId);
}
