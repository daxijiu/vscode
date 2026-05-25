/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DirectorBackendResolution, DirectorProviderApiType, DirectorProviderInstance, DirectorProviderKind, DirectorProviderModel, DirectorProviderSelection, DirectorResolvedProviderAuth, IDirectorProviderBackendHub } from '../../common/directorProviderBackend.js';

const defaultProviderInstances: readonly DirectorProviderInstance[] = [
	{
		id: 'director-fake',
		kind: 'local',
		displayName: 'Director Fake',
		enabled: true,
		authKind: 'none',
		defaultModelId: 'echo',
	},
	{
		id: 'director-disabled',
		kind: 'local',
		displayName: 'Director Disabled',
		enabled: false,
		authKind: 'none',
		defaultModelId: 'disabled-model',
	},
	{
		id: 'director-missing-key',
		kind: 'openai-compatible',
		displayName: 'Director Missing API Key',
		enabled: true,
		authKind: 'api-key',
		baseURL: 'https://director.invalid/v1',
		defaultModelId: 'needs-key',
	},
];

const defaultModels: readonly DirectorProviderModel[] = [
	{
		providerInstanceId: 'director-fake',
		id: 'echo',
		name: 'Director Echo',
		family: 'echo',
		maxContextWindow: 8192,
		supportsVision: false,
		capabilities: { streaming: true, toolCalling: false, agentMode: true },
	},
	{
		providerInstanceId: 'director-fake',
		id: 'echo-large',
		name: 'Director Echo Large',
		family: 'echo',
		maxContextWindow: 32768,
		supportsVision: false,
		capabilities: { streaming: true, toolCalling: false, agentMode: true },
	},
	{
		providerInstanceId: 'director-disabled',
		id: 'disabled-model',
		name: 'Director Disabled Model',
		family: 'echo',
		supportsVision: false,
		capabilities: { streaming: false, toolCalling: false },
	},
	{
		providerInstanceId: 'director-missing-key',
		id: 'needs-key',
		name: 'Director Needs Key',
		family: 'openai-compatible',
		supportsVision: false,
		capabilities: { streaming: true, toolCalling: false },
	},
];

export interface DirectorProviderBackendHubFixtures {
	readonly providerInstances?: readonly DirectorProviderInstance[];
	readonly models?: readonly DirectorProviderModel[];
}

export class DirectorProviderBackendHub implements IDirectorProviderBackendHub {

	declare readonly _serviceBrand: undefined;

	private readonly providerInstances: readonly DirectorProviderInstance[];
	private readonly models: readonly DirectorProviderModel[];

	constructor(fixtures: DirectorProviderBackendHubFixtures = {}) {
		this.providerInstances = fixtures.providerInstances ?? defaultProviderInstances;
		this.models = fixtures.models ?? defaultModels;
	}

	async listProviderInstances(): Promise<readonly DirectorProviderInstance[]> {
		return this.providerInstances.map(copyProviderInstance);
	}

	async listModels(providerInstanceId?: string): Promise<readonly DirectorProviderModel[]> {
		return this.models
			.filter(model => providerInstanceId === undefined || model.providerInstanceId === providerInstanceId)
			.map(copyModel);
	}

	async resolveBackend(selection: DirectorProviderSelection = {}): Promise<DirectorBackendResolution> {
		const provider = this.resolveProvider(selection.providerInstanceId);
		if (provider === undefined) {
			return {
				status: 'error',
				message: selection.providerInstanceId === undefined
					? 'No enabled Director provider is available.'
					: `Director provider '${selection.providerInstanceId}' is not registered.`,
			};
		}

		if (!provider.enabled) {
			return {
				status: 'disabled',
				providerInstanceId: provider.id,
				message: `Director provider '${provider.id}' is disabled.`,
			};
		}

		const model = this.resolveModel(provider, selection.modelId);
		if (model === undefined) {
			return {
				status: 'modelUnavailable',
				providerInstanceId: provider.id,
				modelId: selection.modelId ?? provider.defaultModelId ?? '<default>',
				message: `Director model '${selection.modelId ?? provider.defaultModelId ?? '<default>'}' is not available for provider '${provider.id}'.`,
			};
		}

		const auth = this.resolveAuth(provider);
		if (auth === undefined) {
			return {
				status: 'missingAuth',
				providerInstanceId: provider.id,
				message: `Director provider '${provider.id}' requires ${provider.authKind} credentials.`,
			};
		}

		return {
			status: 'ok',
			backend: {
				providerInstanceId: provider.id,
				providerKind: provider.kind,
				apiType: apiTypeForProviderKind(provider.kind),
				modelId: model.id,
				auth,
				...(provider.baseURL !== undefined ? { baseURL: provider.baseURL } : {}),
				...(provider.headers !== undefined ? { headers: { ...provider.headers } } : {}),
				...(model.capabilities !== undefined ? { capabilities: { ...model.capabilities } } : {}),
				identityKey: `${provider.id}/${model.id}`,
			},
		};
	}

	private resolveProvider(providerInstanceId: string | undefined): DirectorProviderInstance | undefined {
		if (providerInstanceId !== undefined) {
			return this.providerInstances.find(provider => provider.id === providerInstanceId);
		}

		return this.providerInstances.find(provider => provider.enabled);
	}

	private resolveModel(provider: DirectorProviderInstance, modelId: string | undefined): DirectorProviderModel | undefined {
		const providerModels = this.models.filter(model => model.providerInstanceId === provider.id);
		if (modelId !== undefined) {
			return providerModels.find(model => model.id === modelId);
		}

		return provider.defaultModelId === undefined
			? providerModels[0]
			: providerModels.find(model => model.id === provider.defaultModelId) ?? providerModels[0];
	}

	private resolveAuth(provider: DirectorProviderInstance): DirectorResolvedProviderAuth | undefined {
		if (provider.authKind === 'none') {
			return { kind: 'none' };
		}

		return undefined;
	}
}

function copyProviderInstance(provider: DirectorProviderInstance): DirectorProviderInstance {
	return {
		...provider,
		...(provider.headers !== undefined ? { headers: { ...provider.headers } } : {}),
	};
}

function copyModel(model: DirectorProviderModel): DirectorProviderModel {
	return {
		...model,
		...(model.capabilities !== undefined ? { capabilities: { ...model.capabilities } } : {}),
	};
}

function apiTypeForProviderKind(kind: DirectorProviderKind): DirectorProviderApiType {
	switch (kind) {
		case 'anthropic':
		case 'anthropic-compatible':
			return 'anthropic-messages';
		case 'openai':
		case 'openai-compatible':
			return 'openai-completions';
		case 'openai-codex':
			return 'openai-codex';
		case 'gemini':
			return 'gemini-generative';
		case 'local':
			return 'local';
		case 'custom-http':
			return 'custom-http';
	}
}
