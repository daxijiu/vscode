/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DirectorProviderApiType } from './directorProviderBackend.js';

export interface DirectorConnectionTestRequest {
	readonly url: string;
	readonly method: 'GET' | 'POST';
	readonly headers: Record<string, string>;
	readonly body?: string;
}

export function buildDirectorConnectionTestRequest(apiType: DirectorProviderApiType, baseURL: string, modelId: string, authHeader: string): DirectorConnectionTestRequest {
	const normalizedBaseURL = baseURL.replace(/\/+$/, '');
	switch (apiType) {
		case 'anthropic-messages':
			return {
				url: `${normalizedBaseURL}/v1/messages`,
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-api-key': authHeader,
					'anthropic-version': '2023-06-01',
				},
				body: JSON.stringify({ model: modelId, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
			};
		case 'openai-completions':
			return {
				url: `${normalizedBaseURL}/chat/completions`,
				method: 'POST',
				headers: {
					authorization: `Bearer ${authHeader}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({ model: modelId, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
			};
		case 'openai-codex':
			return {
				url: `${normalizedBaseURL}/models?client_version=1.0.0`,
				method: 'GET',
				headers: {
					authorization: `Bearer ${authHeader}`,
					'openai-beta': 'responses=experimental',
					originator: 'director-code',
				},
			};
		case 'gemini-generative':
			return {
				url: `${normalizedBaseURL}/models`,
				method: 'GET',
				headers: {
					'x-goog-api-key': authHeader,
				},
			};
		case 'local':
		case 'custom-http':
			return {
				url: normalizedBaseURL,
				method: 'GET',
				headers: {},
			};
	}
}
