/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IFileService } from '../../../files/common/files.js';
import type { INativeEnvironmentService } from '../../../environment/common/environment.js';
import type { ILogService } from '../../../log/common/log.js';
import type { DirectorBackendResolution, DirectorProviderApiType, DirectorProviderInstance, DirectorProviderKind, DirectorProviderModel, DirectorProviderSelection, IDirectorProviderBackendHub } from '../../common/directorProviderBackend.js';
import { getDirectorProviderSnapshotResource, isAuthStateUsableForModelList, type DirectorProviderAuthState, type DirectorProviderSnapshot, type DirectorProviderSnapshotProvider } from '../../common/directorProviderSnapshot.js';

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
	readonly defaultProviderId?: string;
	readonly defaultModelId?: string;
}

interface DirectorProviderBackendState {
	readonly providerInstances: readonly DirectorProviderInstance[];
	readonly models: readonly DirectorProviderModel[];
	readonly defaultProviderId?: string;
	readonly defaultModelId?: string;
}

export class DirectorProviderBackendHub implements IDirectorProviderBackendHub {

	declare readonly _serviceBrand: undefined;

	private readonly providerInstances: readonly DirectorProviderInstance[];
	private readonly models: readonly DirectorProviderModel[];
	private readonly defaultProviderId: string | undefined;
	private readonly defaultModelId: string | undefined;
	private readonly hasFixtureState: boolean;

	constructor(
		fixtures: DirectorProviderBackendHubFixtures = {},
		private readonly fileService?: IFileService,
		private readonly environmentService?: INativeEnvironmentService,
		private readonly logService?: ILogService,
	) {
		this.providerInstances = fixtures.providerInstances ?? defaultProviderInstances;
		this.models = fixtures.models ?? defaultModels;
		this.defaultProviderId = fixtures.defaultProviderId;
		this.defaultModelId = fixtures.defaultModelId;
		this.hasFixtureState = fixtures.providerInstances !== undefined || fixtures.models !== undefined || fixtures.defaultProviderId !== undefined || fixtures.defaultModelId !== undefined;
	}

	async listProviderInstances(): Promise<readonly DirectorProviderInstance[]> {
		const state = await this.getState();
		return state.providerInstances.map(copyProviderInstance);
	}

	async listModels(providerInstanceId?: string): Promise<readonly DirectorProviderModel[]> {
		const state = await this.getState();
		return state.models
			.filter(model => providerInstanceId === undefined || model.providerInstanceId === providerInstanceId)
			.map(copyModel);
	}

	async resolveBackend(selection: DirectorProviderSelection = {}): Promise<DirectorBackendResolution> {
		const state = await this.getState();
		const provider = this.resolveProvider(state, selection.providerInstanceId, selection.modelId);
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

		const model = this.resolveModel(state, provider, selection.modelId);
		if (model === undefined) {
			return {
				status: 'modelUnavailable',
				providerInstanceId: provider.id,
				modelId: selection.modelId ?? provider.defaultModelId ?? '<default>',
				message: `Director model '${selection.modelId ?? provider.defaultModelId ?? '<default>'}' is not available for provider '${provider.id}'.`,
			};
		}

		const authState = this.resolveAuthState(provider);
		if (!isAuthStateUsableForModelList(authState)) {
			return {
				status: 'missingAuth',
				providerInstanceId: provider.id,
				message: authState.message ?? `Director provider '${provider.id}' requires ${provider.authKind} credentials.`,
			};
		}

		return {
			status: 'ok',
			backend: {
				providerInstanceId: provider.id,
				providerKind: provider.kind,
				apiType: provider.apiType ?? apiTypeForProviderKind(provider.kind),
				agentModelId: model.id,
				modelId: model.providerModelId ?? model.id,
				authState,
				...(provider.baseURL !== undefined ? { baseURL: provider.baseURL } : {}),
				...(provider.headers !== undefined ? { headers: sanitizeHeaders(provider.headers) } : {}),
				...(model.capabilities !== undefined ? { capabilities: { ...model.capabilities } } : {}),
				identityKey: `${provider.id}/${model.id}`,
			},
		};
	}

	private async getState(): Promise<DirectorProviderBackendState> {
		if (this.hasFixtureState || this.fileService === undefined || this.environmentService === undefined) {
			return {
				providerInstances: this.providerInstances,
				models: this.models,
				defaultProviderId: this.defaultProviderId,
				defaultModelId: this.defaultModelId,
			};
		}

		return this.loadSnapshotState();
	}

	private async loadSnapshotState(): Promise<DirectorProviderBackendState> {
		const resource = getDirectorProviderSnapshotResource(this.environmentService!.appSettingsHome);
		try {
			if (!await this.fileService!.exists(resource)) {
				return {
					providerInstances: this.providerInstances,
					models: this.models,
				};
			}

			const content = (await this.fileService!.readFile(resource)).value.toString();
			const snapshot = JSON.parse(content) as DirectorProviderSnapshot;
			if (snapshot.version !== 1 || !Array.isArray(snapshot.providers) || !Array.isArray(snapshot.models)) {
				this.logService?.warn(`[Director] Ignoring invalid provider snapshot at ${resource.toString()}`);
				return {
					providerInstances: this.providerInstances,
					models: this.models,
				};
			}

			return {
				providerInstances: snapshot.providers,
				models: snapshot.models,
				defaultProviderId: snapshot.defaultProviderId,
				defaultModelId: snapshot.defaultModelId,
			};
		} catch (err) {
			this.logService?.warn(`[Director] Failed to read provider snapshot at ${resource.toString()}`, err);
			return {
				providerInstances: this.providerInstances,
				models: this.models,
			};
		}
	}

	private resolveProvider(state: DirectorProviderBackendState, providerInstanceId: string | undefined, modelId: string | undefined): DirectorProviderInstance | undefined {
		if (providerInstanceId !== undefined) {
			return state.providerInstances.find(provider => provider.id === providerInstanceId);
		}

		if (modelId !== undefined) {
			const model = state.models.find(model => model.id === modelId);
			if (model !== undefined) {
				return state.providerInstances.find(provider => provider.id === model.providerInstanceId);
			}
		}

		if (state.defaultProviderId !== undefined) {
			const provider = state.providerInstances.find(provider => provider.id === state.defaultProviderId);
			if (provider !== undefined) {
				return provider;
			}
		}

		return state.providerInstances.find(provider => provider.enabled);
	}

	private resolveModel(state: DirectorProviderBackendState, provider: DirectorProviderInstance, modelId: string | undefined): DirectorProviderModel | undefined {
		const providerModels = state.models.filter(model => model.providerInstanceId === provider.id);
		if (modelId !== undefined) {
			return providerModels.find(model => model.id === modelId);
		}

		const defaultModelIds = [state.defaultModelId, provider.defaultModelId].filter(defaultModelId => defaultModelId !== undefined);
		for (const defaultModelId of defaultModelIds) {
			const model = providerModels.find(model => model.id === defaultModelId);
			if (model !== undefined) {
				return model;
			}
		}
		return providerModels[0];
	}

	private resolveAuthState(provider: DirectorProviderInstance): DirectorProviderAuthState {
		if (isSnapshotProvider(provider)) {
			return provider.authState;
		}

		if (provider.authKind === 'none') {
			return { kind: 'none' };
		}

		return {
			kind: 'missing',
			message: `Director provider '${provider.id}' requires ${provider.authKind} credentials.`,
		};
	}
}

function copyProviderInstance(provider: DirectorProviderInstance): DirectorProviderInstance {
	return {
		...provider,
		...(provider.headers !== undefined ? { headers: sanitizeHeaders(provider.headers) } : {}),
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

function isSnapshotProvider(provider: DirectorProviderInstance): provider is DirectorProviderSnapshotProvider {
	return 'authState' in provider;
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> | undefined {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (!isSensitiveHeaderName(key)) {
			result[key] = value;
		}
	}
	return Object.keys(result).length ? result : undefined;
}

function isSensitiveHeaderName(name: string): boolean {
	switch (name.toLowerCase()) {
		case 'authorization':
		case 'proxy-authorization':
		case 'x-api-key':
		case 'x-goog-api-key':
		case 'api-key':
		case 'anthropic-api-key':
			return true;
	}
	return false;
}
