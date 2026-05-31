/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { equals } from '../../../../base/common/objects.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../instantiation/common/instantiation.js';
import { ILogService } from '../../../log/common/log.js';
import { IAgentPluginManager } from '../../common/agentPluginManager.js';
import { AgentProvider, IAgentDescriptor, IAgentModelInfo } from '../../common/agentService.js';
import { DirectorBackendResolution, DirectorProviderApiType, DirectorProviderInstance, DirectorProviderModel, DirectorProviderSelection, DirectorResolvedProviderBackend, IDirectorProviderBackendHub, isResolvedBackend, toAgentModelInfo } from '../../common/directorProviderBackend.js';
import { ModelSelection, PolicyState, ProtectedResourceMetadata } from '../../common/state/protocol/state.js';
import { IAgentConfigurationService } from '../agentConfigurationService.js';
import { IAgentHostGitService } from '../agentHostGitService.js';
import { ClaudeSdkAgent } from '../claude/claudeAgent.js';
import { IClaudeAgentBackend } from '../claude/claudeAgentBackend.js';
import { IClaudeAgentSdkService } from '../claude/claudeAgentSdkService.js';
import { IClaudeSdkEndpointHandle } from '../claude/claudeSdkEndpoint.js';
import { IDirectorAnthropicEndpointService } from './directorAnthropicEndpointService.js';

export const DirectorClaudeAgentProviderId: AgentProvider = 'director-claude';

export class DirectorClaudeAgent extends ClaudeSdkAgent {
	constructor(
		@IDirectorProviderBackendHub backendHub: IDirectorProviderBackendHub,
		@IDirectorAnthropicEndpointService endpointService: IDirectorAnthropicEndpointService,
		@ILogService logService: ILogService,
		@IClaudeAgentSdkService sdkService: IClaudeAgentSdkService,
		@IAgentHostGitService gitService: IAgentHostGitService,
		@IAgentConfigurationService configurationService: IAgentConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IAgentPluginManager pluginManager: IAgentPluginManager,
	) {
		super(
			new DirectorClaudeAgentBackend(backendHub, endpointService, logService),
			logService,
			sdkService,
			gitService,
			configurationService,
			instantiationService,
			pluginManager,
		);
	}
}

class DirectorClaudeAgentBackend implements IClaudeAgentBackend {

	readonly id: AgentProvider = DirectorClaudeAgentProviderId;
	private _lastModels: readonly IAgentModelInfo[] = [];

	constructor(
		private readonly _backendHub: IDirectorProviderBackendHub,
		private readonly _endpointService: IDirectorAnthropicEndpointService,
		private readonly _logService: ILogService,
	) { }

	getDescriptor(): IAgentDescriptor {
		return {
			provider: this.id,
			displayName: localize('directorClaudeAgent.displayName', "Director Claude"),
			description: localize('directorClaudeAgent.description', "Claude SDK backed by Director Provider Backend"),
		};
	}

	getProtectedResources(): ProtectedResourceMetadata[] {
		return [];
	}

	ensureReady(): void { }

	authenticate(_resource: string, _token: string): Promise<boolean> {
		return Promise.resolve(false);
	}

	async refreshModels(): Promise<readonly IAgentModelInfo[]> {
		try {
			const providers = await this._backendHub.listProviderInstances();
			const providersById = new Map(providers.map(provider => [provider.id, provider]));
			const models = await this._backendHub.listModels();
			const available: IAgentModelInfo[] = [];
			for (const model of models) {
				const provider = providersById.get(model.providerInstanceId);
				if (!provider?.enabled || !isClaudeEndpointSupported(provider.apiType ?? model.apiType, provider.kind)) {
					continue;
				}
				if (!isClaudeEndpointSupported(model.apiType, provider.kind)) {
					continue;
				}
				const projected = model.providerDisplayName !== undefined
					? model
					: { ...model, providerDisplayName: provider.displayName };
				const resolved = await this._backendHub.resolveBackend({ providerInstanceId: model.providerInstanceId, modelId: model.id });
				const modelInfo = projectDirectorClaudeModel(this.id, projected);
				if (isResolvedBackend(resolved)) {
					if (isClaudeEndpointSupported(resolved.backend.apiType, provider.kind)) {
						available.push(modelInfo);
					}
				} else if (resolved.status === 'missingAuth') {
					available.push({
						...modelInfo,
						policyState: PolicyState.Unconfigured,
						_meta: {
							...(modelInfo._meta ?? {}),
							authStateKind: getDirectorProviderAuthStateKind(provider),
							statusMessage: resolved.message,
						},
					});
				}
			}
			if (!equals(this._lastModels, available)) {
				this._lastModels = available;
			}
			return this._lastModels;
		} catch (err) {
			this._logService.error('[Director Claude] Failed to refresh models', err);
			this._lastModels = [];
			return this._lastModels;
		}
	}

	async resolveInitialModel(model: ModelSelection | undefined): Promise<ModelSelection | undefined> {
		if (model) {
			const selected = await this._findModelBySelectionId(model.id);
			return selected ? { ...model, id: selected.id } : model;
		}
		const resolution = await this._backendHub.resolveBackend();
		if (isResolvedBackend(resolution) && isClaudeEndpointSupported(resolution.backend.apiType, resolution.backend.providerKind)) {
			return { id: await this._agentModelIdForBackend(resolution.backend) };
		}
		const fallback = await this._firstDisplayableModel(resolution);
		return fallback ? { id: fallback.id } : undefined;
	}

	async acquireEndpoint(sessionId: string, model: ModelSelection | undefined): Promise<IClaudeSdkEndpointHandle> {
		const selection = await this._resolveEndpointSelection(model);
		return this._endpointService.start({
			sessionId,
			...(selection.providerInstanceId !== undefined ? { providerInstanceId: selection.providerInstanceId } : {}),
		});
	}

	dispose(): void { }

	private async _resolveEndpointSelection(model: ModelSelection | undefined): Promise<DirectorProviderSelection> {
		if (model?.id) {
			const selected = await this._findModelBySelectionId(model.id);
			if (!selected) {
				throw new Error('Selected Director Claude model is not available.');
			}
			const selection: DirectorProviderSelection = { providerInstanceId: selected.providerInstanceId, modelId: selected.id };
			const resolution = await this._backendHub.resolveBackend(selection);
			if (isResolvedBackend(resolution)) {
				if (!isClaudeEndpointSupported(resolution.backend.apiType, resolution.backend.providerKind)) {
					throw new Error('Selected Director provider is not supported by the Director Claude endpoint.');
				}
				return this._selectionForBackend(resolution.backend);
			}
			if (resolution.status === 'missingAuth') {
				return selection;
			}
			throw new Error(resolution.message);
		}

		const resolution = await this._backendHub.resolveBackend();
		if (isResolvedBackend(resolution) && isClaudeEndpointSupported(resolution.backend.apiType, resolution.backend.providerKind)) {
			return this._selectionForBackend(resolution.backend);
		}
		const fallback = await this._firstDisplayableModel(resolution);
		if (fallback) {
			return { providerInstanceId: fallback.providerInstanceId, modelId: fallback.id };
		}
		throw new Error(getDirectorClaudeResolutionMessage(resolution));
	}

	private async _selectionForBackend(backend: DirectorResolvedProviderBackend): Promise<DirectorProviderSelection> {
		return {
			providerInstanceId: backend.providerInstanceId,
			modelId: await this._agentModelIdForBackend(backend),
		};
	}

	private async _agentModelIdForBackend(backend: DirectorResolvedProviderBackend): Promise<string> {
		if (backend.agentModelId !== undefined) {
			return backend.agentModelId;
		}
		const models = await this._backendHub.listModels(backend.providerInstanceId);
		return models.find(model => model.providerModelId === backend.modelId || model.id === backend.modelId)?.id ?? backend.modelId;
	}

	private async _findModelBySelectionId(modelId: string): Promise<DirectorProviderModel | undefined> {
		const models = await this._backendHub.listModels();
		const internal = models.find(model => model.id === modelId);
		if (internal) {
			return internal;
		}
		const providerModelMatches = models.filter(model => model.providerModelId === modelId || model.name === modelId);
		return providerModelMatches.length === 1 ? providerModelMatches[0] : undefined;
	}

	private async _firstDisplayableModel(resolution: DirectorBackendResolution): Promise<DirectorProviderModel | undefined> {
		const providers = await this._backendHub.listProviderInstances();
		const providersById = new Map(providers.map(provider => [provider.id, provider]));
		const models = await this._backendHub.listModels();
		if (resolution.status === 'missingAuth') {
			return models.find(model => {
				const provider = providersById.get(model.providerInstanceId);
				return model.providerInstanceId === resolution.providerInstanceId
					&& !!provider?.enabled
					&& isClaudeEndpointSupported(provider.apiType ?? model.apiType, provider.kind)
					&& isClaudeEndpointSupported(model.apiType, provider.kind);
			});
		}
		return models.find(model => {
			const provider = providersById.get(model.providerInstanceId);
			return !!provider?.enabled
				&& isClaudeEndpointSupported(provider.apiType ?? model.apiType, provider.kind)
				&& isClaudeEndpointSupported(model.apiType, provider.kind);
		});
	}
}

function projectDirectorClaudeModel(agentProvider: AgentProvider, model: DirectorProviderModel): IAgentModelInfo {
	return toAgentModelInfo(agentProvider, model);
}

function getDirectorClaudeResolutionMessage(resolution: DirectorBackendResolution): string {
	if (isResolvedBackend(resolution)) {
		return 'Selected Director provider is not supported by the Director Claude endpoint.';
	}
	return resolution.message;
}

function isClaudeEndpointSupported(apiType: DirectorProviderApiType | undefined, providerKind: DirectorProviderInstance['kind'] | undefined): boolean {
	const resolvedApiType = apiType ?? (providerKind === 'local' || providerKind === 'custom-http' ? providerKind : undefined);
	return resolvedApiType === undefined
		|| resolvedApiType === 'anthropic-messages'
		|| resolvedApiType === 'openai-completions'
		|| resolvedApiType === 'openai-codex'
		|| resolvedApiType === 'gemini-generative';
}

function getDirectorProviderAuthStateKind(provider: DirectorProviderInstance): string | undefined {
	const authState = (provider as DirectorProviderInstance & { readonly authState?: { readonly kind?: unknown } }).authState;
	return typeof authState?.kind === 'string' ? authState.kind : undefined;
}
