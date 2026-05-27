/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { AgentProvider, IAgentModelInfo } from './agentService.js';
import type { DirectorProviderAuthState } from './directorProviderSnapshot.js';

export const DirectorAgentProviderId: AgentProvider = 'director';

export type DirectorProviderKind =
	| 'anthropic'
	| 'anthropic-compatible'
	| 'openai'
	| 'openai-compatible'
	| 'openai-codex'
	| 'gemini'
	| 'local'
	| 'custom-http';

export type DirectorProviderAuthKind = 'none' | 'api-key' | 'oauth' | 'bearer';

export type DirectorProviderApiType =
	| 'anthropic-messages'
	| 'openai-completions'
	| 'openai-codex'
	| 'gemini-generative'
	| 'local'
	| 'custom-http';

export interface DirectorProviderCapabilities {
	readonly streaming?: boolean;
	readonly toolCalling?: boolean;
	readonly thinking?: boolean;
	readonly vision?: boolean;
	readonly agentMode?: boolean;
}

export interface DirectorProviderInstance {
	readonly id: string;
	readonly kind: DirectorProviderKind;
	readonly displayName: string;
	readonly enabled: boolean;
	readonly authKind: DirectorProviderAuthKind;
	readonly apiType?: DirectorProviderApiType;
	readonly baseURL?: string;
	readonly headers?: Record<string, string>;
	readonly defaultModelId?: string;
}

export interface DirectorProviderModel {
	readonly providerInstanceId: string;
	readonly id: string;
	readonly providerModelId?: string;
	readonly name: string;
	readonly family?: string;
	readonly version?: string;
	readonly maxContextWindow?: number;
	readonly maxOutputTokens?: number;
	readonly supportsVision: boolean;
	readonly apiType?: DirectorProviderApiType;
	readonly providerDisplayName?: string;
	readonly capabilities?: DirectorProviderCapabilities;
}

export interface DirectorProviderSelection {
	readonly providerInstanceId?: string;
	readonly modelId?: string;
}

export interface DirectorResolvedProviderBackend {
	readonly providerInstanceId: string;
	readonly providerKind: DirectorProviderKind;
	readonly authKind: DirectorProviderAuthKind;
	readonly apiType: DirectorProviderApiType;
	readonly agentModelId?: string;
	readonly modelId: string;
	readonly authState: DirectorProviderAuthState;
	readonly baseURL?: string;
	readonly headers?: Record<string, string>;
	readonly capabilities?: DirectorProviderCapabilities;
	readonly identityKey?: string;
}

export type DirectorBackendResolution =
	| { readonly status: 'ok'; readonly backend: DirectorResolvedProviderBackend }
	| { readonly status: 'missingAuth'; readonly providerInstanceId: string; readonly message: string }
	| { readonly status: 'disabled'; readonly providerInstanceId: string; readonly message: string }
	| { readonly status: 'modelUnavailable'; readonly providerInstanceId: string; readonly modelId: string; readonly message: string }
	| { readonly status: 'error'; readonly message: string };

export interface IDirectorProviderBackendHub {
	readonly _serviceBrand: undefined;

	listProviderInstances(): Promise<readonly DirectorProviderInstance[]>;
	listModels(providerInstanceId?: string): Promise<readonly DirectorProviderModel[]>;
	resolveBackend(selection?: DirectorProviderSelection): Promise<DirectorBackendResolution>;
}

export const IDirectorProviderBackendHub = createDecorator<IDirectorProviderBackendHub>('directorProviderBackendHub');

export function isResolvedBackend(result: DirectorBackendResolution): result is { readonly status: 'ok'; readonly backend: DirectorResolvedProviderBackend } {
	return result.status === 'ok';
}

export function toAgentModelInfo(agentProvider: AgentProvider, model: DirectorProviderModel): IAgentModelInfo {
	const metadata: Record<string, unknown> = {
		providerInstanceId: model.providerInstanceId,
		backendModelId: model.providerModelId ?? model.id,
	};

	if (model.providerDisplayName !== undefined) {
		metadata.providerDisplayName = model.providerDisplayName;
	}

	if (model.apiType !== undefined) {
		metadata.apiType = model.apiType;
	}

	if (model.family !== undefined) {
		metadata.family = model.family;
	}

	if (model.version !== undefined) {
		metadata.version = model.version;
	}

	if (model.maxOutputTokens !== undefined) {
		metadata.maxOutputTokens = model.maxOutputTokens;
	}

	if (model.capabilities !== undefined) {
		metadata.capabilities = { ...model.capabilities };
	}

	return {
		provider: agentProvider,
		id: model.id,
		name: model.name,
		...(model.maxContextWindow !== undefined ? { maxContextWindow: model.maxContextWindow } : {}),
		supportsVision: model.supportsVision,
		_meta: metadata,
	};
}

export function findDefaultModel(models: readonly DirectorProviderModel[], providerInstanceId?: string, modelId?: string): DirectorProviderModel | undefined {
	const candidates = providerInstanceId === undefined ? models : models.filter(model => model.providerInstanceId === providerInstanceId);

	if (modelId !== undefined) {
		return candidates.find(model => model.id === modelId);
	}

	return candidates[0];
}
