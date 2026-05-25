/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DirectorProviderApiType } from './directorProviderBackend.js';

export type DirectorHarnessProtocol =
	| 'anthropic-messages'
	| 'openai-chat-completions'
	| 'openai-codex'
	| 'openai-responses'
	| 'director-normalized';

export type DirectorProtocolRouteKind = 'native' | 'proxy' | 'adapter' | 'unsupported';

export interface DirectorProtocolRoute {
	readonly kind: DirectorProtocolRouteKind;
	readonly reason?: string;
}

export function resolveDirectorProtocolRoute(harnessProtocol: DirectorHarnessProtocol, providerApiType: DirectorProviderApiType): DirectorProtocolRoute {
	if (harnessProtocol === 'anthropic-messages' && providerApiType === 'anthropic-messages') {
		return { kind: 'native' };
	}

	if (harnessProtocol === 'openai-chat-completions' && providerApiType === 'openai-completions') {
		return { kind: 'native' };
	}

	if (harnessProtocol === 'openai-codex' && providerApiType === 'openai-codex') {
		return { kind: 'native' };
	}

	if (harnessProtocol === 'director-normalized') {
		switch (providerApiType) {
			case 'anthropic-messages':
				return { kind: 'adapter', reason: 'Director normalized messages map directly to Anthropic Messages with a thin adapter.' };
			case 'openai-completions':
			case 'openai-codex':
			case 'gemini-generative':
				return { kind: 'adapter', reason: 'Director normalized messages require a provider-specific adapter.' };
			case 'local':
			case 'custom-http':
				return { kind: 'unsupported', reason: 'No generic normalized adapter is available for this provider type.' };
		}
	}

	if (harnessProtocol === 'openai-responses') {
		return { kind: 'unsupported', reason: 'Public OpenAI Responses is reserved until implemented separately from openai-codex.' };
	}

	return { kind: 'unsupported', reason: 'No tested route exists for this harness/provider protocol combination.' };
}

export function isDirectorProviderVisibleForHarness(harnessProtocol: DirectorHarnessProtocol, providerApiType: DirectorProviderApiType): boolean {
	const route = resolveDirectorProtocolRoute(harnessProtocol, providerApiType);
	return route.kind === 'native' || route.kind === 'proxy' || route.kind === 'adapter';
}
