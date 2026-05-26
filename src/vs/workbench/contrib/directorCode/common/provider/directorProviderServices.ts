/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Sequencer } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { dirname } from '../../../../../base/common/resources.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { IUserDataProfilesService } from '../../../../../platform/userDataProfile/common/userDataProfile.js';
import { IUserDataProfileService } from '../../../../services/userDataProfile/common/userDataProfile.js';
import type { DirectorProviderApiType, DirectorProviderAuthKind, DirectorProviderCapabilities, DirectorProviderInstance, DirectorProviderKind } from '../../../../../platform/agentHost/common/directorProviderBackend.js';
import { buildDirectorConnectionTestRequest, type DirectorConnectionTestRequest } from '../../../../../platform/agentHost/common/directorProviderRequest.js';
import { DirectorProviderSnapshotVersion, getDirectorProviderRegistryResourceFromGlobalStorageHome, getDirectorProviderSnapshotResourceFromGlobalStorageHome, makeDirectorProviderModelKey, sanitizeDirectorProviderHeaders, sanitizeDirectorProviderId, type DirectorProviderAuthState, type DirectorProviderSnapshot, type DirectorProviderSnapshotModel, type DirectorProviderSnapshotProvider } from '../../../../../platform/agentHost/common/directorProviderSnapshot.js';

export const IDirectorProviderRegistryService = createDecorator<IDirectorProviderRegistryService>('directorProviderRegistryService');
export const IDirectorApiKeyService = createDecorator<IDirectorApiKeyService>('directorApiKeyService');
export const IDirectorOAuthService = createDecorator<IDirectorOAuthService>('directorOAuthService');
export const IDirectorModelResolverService = createDecorator<IDirectorModelResolverService>('directorModelResolverService');
export const IDirectorProviderSnapshotService = createDecorator<IDirectorProviderSnapshotService>('directorProviderSnapshotService');
export const IDirectorProviderConnectionTestService = createDecorator<IDirectorProviderConnectionTestService>('directorProviderConnectionTestService');

const API_KEY_PREFIX = 'director-code.providerInstanceKey';
const OAUTH_TOKEN_PREFIX = 'director-code.oauth';

export interface DirectorStoredProviderInstance extends DirectorProviderInstance {
	readonly apiType: DirectorProviderApiType;
	readonly authVariant?: 'default' | 'openai-codex';
	readonly models?: readonly DirectorStoredProviderModel[];
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface DirectorStoredProviderModel {
	readonly id: string;
	readonly providerModelId?: string;
	readonly name?: string;
	readonly family?: string;
	readonly hidden?: boolean;
	readonly maxContextWindow?: number;
	readonly supportsVision?: boolean;
	readonly capabilities?: DirectorProviderCapabilities;
}

export interface DirectorProviderRegistryState {
	readonly version: 1;
	readonly instances: readonly DirectorStoredProviderInstance[];
	readonly defaultProviderId?: string;
	readonly defaultModelId?: string;
}

export interface IDirectorProviderRegistryService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeProviders: Event<void>;
	listProviders(): Promise<readonly DirectorStoredProviderInstance[]>;
	getProvider(id: string): Promise<DirectorStoredProviderInstance | undefined>;
	saveProvider(provider: DirectorStoredProviderInstance): Promise<void>;
	removeProvider(id: string): Promise<void>;
	setDefaults(providerId: string | undefined, modelId: string | undefined): Promise<void>;
	getState(): Promise<DirectorProviderRegistryState>;
}

export interface IDirectorApiKeyService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeAuth: Event<string>;
	hasProviderInstanceKey(providerInstanceId: string): Promise<boolean>;
	getProviderInstanceKey(providerInstanceId: string): Promise<string | undefined>;
	setProviderInstanceKey(providerInstanceId: string, value: string): Promise<void>;
	deleteProviderInstanceKey(providerInstanceId: string): Promise<void>;
	getAuthState(provider: DirectorStoredProviderInstance): Promise<DirectorProviderAuthState>;
}

export interface IDirectorOAuthService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeAuth: Event<string>;
	signInOpenAICodex(providerInstanceId: string): Promise<void>;
	signOutOpenAICodex(providerInstanceId: string): Promise<void>;
	getAuthState(provider: DirectorStoredProviderInstance): Promise<DirectorProviderAuthState>;
}

export interface IDirectorModelResolverService {
	readonly _serviceBrand: undefined;
	resolveModels(provider: DirectorStoredProviderInstance): Promise<readonly DirectorProviderSnapshotModel[]>;
}

export interface IDirectorProviderSnapshotService {
	readonly _serviceBrand: undefined;
	writeSnapshot(): Promise<DirectorProviderSnapshot>;
	getSnapshotResource(): Promise<string>;
}

export interface DirectorProviderConnectionTestResult {
	readonly status: 'ok' | 'missingAuth' | 'modelUnavailable' | 'unsupported';
	readonly message: string;
	readonly request?: DirectorConnectionTestRequest;
	readonly authState?: DirectorProviderAuthState;
}

export interface IDirectorProviderConnectionTestService {
	readonly _serviceBrand: undefined;
	validateProviderSetup(provider: DirectorStoredProviderInstance, modelId?: string): Promise<DirectorProviderConnectionTestResult>;
}

export class DirectorProviderRegistryService extends Disposable implements IDirectorProviderRegistryService {
	declare readonly _serviceBrand: undefined;

	private readonly onDidChangeProvidersEmitter = this._register(new Emitter<void>());
	readonly onDidChangeProviders = this.onDidChangeProvidersEmitter.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IUserDataProfileService private readonly userDataProfileService: IUserDataProfileService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async listProviders(): Promise<readonly DirectorStoredProviderInstance[]> {
		return (await this.getState()).instances;
	}

	async getProvider(id: string): Promise<DirectorStoredProviderInstance | undefined> {
		return (await this.listProviders()).find(provider => provider.id === id);
	}

	async saveProvider(provider: DirectorStoredProviderInstance): Promise<void> {
		const state = await this.getState();
		const normalizedProvider = normalizeStoredProvider(provider);
		const providers = state.instances.filter(candidate => candidate.id !== normalizedProvider.id);
		await this.writeState({
			...state,
			instances: [...providers, normalizedProvider],
			defaultProviderId: state.defaultProviderId ?? normalizedProvider.id,
			defaultModelId: state.defaultModelId ?? normalizedProvider.defaultModelId ?? normalizedProvider.models?.[0]?.id,
		});
	}

	async removeProvider(id: string): Promise<void> {
		const state = await this.getState();
		const defaultModelId = state.defaultModelId?.startsWith(`${id}:`) ? undefined : state.defaultModelId;
		await this.writeState({
			version: 1,
			instances: state.instances.filter(provider => provider.id !== id),
			defaultProviderId: state.defaultProviderId === id ? undefined : state.defaultProviderId,
			defaultModelId: state.defaultProviderId === id ? undefined : defaultModelId,
		});
	}

	async setDefaults(providerId: string | undefined, modelId: string | undefined): Promise<void> {
		await this.writeState({
			...await this.getState(),
			defaultProviderId: providerId,
			defaultModelId: modelId,
		});
	}

	async getState(): Promise<DirectorProviderRegistryState> {
		const resource = getDirectorProviderRegistryResourceFromGlobalStorageHome(this.userDataProfileService.currentProfile.globalStorageHome);
		try {
			if (!await this.fileService.exists(resource)) {
				return { version: 1, instances: [] };
			}
			const value = JSON.parse((await this.fileService.readFile(resource)).value.toString()) as DirectorProviderRegistryState;
			if (value.version !== 1 || !Array.isArray(value.instances)) {
				return { version: 1, instances: [] };
			}
			return {
				version: 1,
				instances: value.instances.map(normalizeStoredProvider),
				defaultProviderId: value.defaultProviderId,
				defaultModelId: value.defaultModelId,
			};
		} catch (err) {
			this.logService.warn('[Director] Failed to read provider registry', err);
			return { version: 1, instances: [] };
		}
	}

	private async writeState(state: DirectorProviderRegistryState): Promise<void> {
		const resource = getDirectorProviderRegistryResourceFromGlobalStorageHome(this.userDataProfileService.currentProfile.globalStorageHome);
		await this.fileService.createFolder(dirname(resource));
		await this.fileService.writeFile(resource, VSBuffer.fromString(JSON.stringify(state, undefined, '\t')));
		this.onDidChangeProvidersEmitter.fire();
	}
}

export class DirectorApiKeyService extends Disposable implements IDirectorApiKeyService {
	declare readonly _serviceBrand: undefined;

	private readonly onDidChangeAuthEmitter = this._register(new Emitter<string>());
	readonly onDidChangeAuth = this.onDidChangeAuthEmitter.event;

	constructor(@ISecretStorageService private readonly secretStorageService: ISecretStorageService) {
		super();
	}

	async hasProviderInstanceKey(providerInstanceId: string): Promise<boolean> {
		return (await this.getProviderInstanceKey(providerInstanceId)) !== undefined;
	}

	getProviderInstanceKey(providerInstanceId: string): Promise<string | undefined> {
		return this.secretStorageService.get(this.getKey(providerInstanceId));
	}

	async setProviderInstanceKey(providerInstanceId: string, value: string): Promise<void> {
		await this.secretStorageService.set(this.getKey(providerInstanceId), value);
		this.onDidChangeAuthEmitter.fire(providerInstanceId);
	}

	async deleteProviderInstanceKey(providerInstanceId: string): Promise<void> {
		await this.secretStorageService.delete(this.getKey(providerInstanceId));
		this.onDidChangeAuthEmitter.fire(providerInstanceId);
	}

	async getAuthState(provider: DirectorStoredProviderInstance): Promise<DirectorProviderAuthState> {
		if (provider.authKind === 'none') {
			return { kind: 'none', updatedAt: Date.now() };
		}
		if (provider.authKind !== 'api-key') {
			return { kind: 'missing', message: `Director provider '${provider.id}' is not configured for API-key auth.`, updatedAt: Date.now() };
		}
		const value = await this.getProviderInstanceKey(provider.id);
		return value
			? { kind: 'ready', identityKey: `api-key:${provider.id}`, updatedAt: Date.now() }
			: { kind: 'missing', message: `Director provider '${provider.displayName}' is missing an API key.`, updatedAt: Date.now() };
	}

	private getKey(providerInstanceId: string): string {
		return `${API_KEY_PREFIX}.${providerInstanceId}`;
	}
}

export class DirectorOAuthService extends Disposable implements IDirectorOAuthService {
	declare readonly _serviceBrand: undefined;

	private readonly onDidChangeAuthEmitter = this._register(new Emitter<string>());
	readonly onDidChangeAuth = this.onDidChangeAuthEmitter.event;

	constructor(@ISecretStorageService private readonly secretStorageService: ISecretStorageService) {
		super();
	}

	async signInOpenAICodex(providerInstanceId: string): Promise<void> {
		await this.secretStorageService.set(this.getKey(providerInstanceId), JSON.stringify({
			authVariant: 'openai-codex',
			accessToken: 'director-code-fake-openai-codex-token',
			createdAt: Date.now(),
		}));
		this.onDidChangeAuthEmitter.fire(providerInstanceId);
	}

	async signOutOpenAICodex(providerInstanceId: string): Promise<void> {
		await this.secretStorageService.delete(this.getKey(providerInstanceId));
		this.onDidChangeAuthEmitter.fire(providerInstanceId);
	}

	async getAuthState(provider: DirectorStoredProviderInstance): Promise<DirectorProviderAuthState> {
		if (provider.authKind !== 'oauth') {
			return { kind: 'missing', message: `Director provider '${provider.id}' is not configured for OAuth.`, updatedAt: Date.now() };
		}
		const value = await this.secretStorageService.get(this.getKey(provider.id));
		return value
			? { kind: 'ready', identityKey: `oauth:openai:openai-codex:${provider.id}`, updatedAt: Date.now() }
			: { kind: 'signedOut', message: `Director provider '${provider.displayName}' is signed out.`, updatedAt: Date.now() };
	}

	private getKey(providerInstanceId: string): string {
		return `${OAUTH_TOKEN_PREFIX}.${providerInstanceId}`;
	}
}

export class DirectorModelResolverService implements IDirectorModelResolverService {
	declare readonly _serviceBrand: undefined;

	async resolveModels(provider: DirectorStoredProviderInstance): Promise<readonly DirectorProviderSnapshotModel[]> {
		const models = provider.models?.length ? provider.models : getDefaultModels(provider.apiType);
		return models.filter(model => model.hidden !== true).map(model => {
			const providerModelId = model.providerModelId ?? getProviderModelId(provider.id, model.id);
			return {
				providerInstanceId: provider.id,
				id: makeDirectorProviderModelKey(provider.id, providerModelId),
				providerModelId,
				name: model.name ?? providerModelId,
				family: model.family ?? provider.kind,
				maxContextWindow: model.maxContextWindow,
				supportsVision: model.supportsVision ?? false,
				capabilities: model.capabilities ?? defaultCapabilities(provider.apiType),
				apiType: provider.apiType,
				providerDisplayName: provider.displayName,
			};
		});
	}
}

export class DirectorProviderSnapshotService extends Disposable implements IDirectorProviderSnapshotService {
	declare readonly _serviceBrand: undefined;

	private readonly writeSequencer = new Sequencer();

	constructor(
		@IDirectorProviderRegistryService private readonly registryService: IDirectorProviderRegistryService,
		@IDirectorApiKeyService private readonly apiKeyService: IDirectorApiKeyService,
		@IDirectorOAuthService private readonly oauthService: IDirectorOAuthService,
		@IDirectorModelResolverService private readonly modelResolverService: IDirectorModelResolverService,
		@IFileService private readonly fileService: IFileService,
		@IUserDataProfileService private readonly userDataProfileService: IUserDataProfileService,
		@IUserDataProfilesService private readonly userDataProfilesService: IUserDataProfilesService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.registryService.onDidChangeProviders(() => { void this.writeSnapshot(); }));
		this._register(this.apiKeyService.onDidChangeAuth(() => { void this.writeSnapshot(); }));
		this._register(this.oauthService.onDidChangeAuth(() => { void this.writeSnapshot(); }));
		this._register(this.userDataProfileService.onDidChangeCurrentProfile(() => { void this.writeSnapshot(); }));
	}

	async writeSnapshot(): Promise<DirectorProviderSnapshot> {
		return this.writeSequencer.queue(() => this.doWriteSnapshot());
	}

	private async doWriteSnapshot(): Promise<DirectorProviderSnapshot> {
		const state = await this.registryService.getState();
		const providers: DirectorProviderSnapshotProvider[] = [];
		const models: DirectorProviderSnapshotModel[] = [];

		for (const provider of state.instances) {
			const authState = await this.getAuthState(provider);
			const providerModels = await this.modelResolverService.resolveModels(provider);
			const providerDefaultModelId = provider.defaultModelId && providerModels.some(model => model.id === provider.defaultModelId)
				? provider.defaultModelId
				: providerModels[0]?.id;
			providers.push({
				id: provider.id,
				kind: provider.kind,
				displayName: provider.displayName,
				enabled: provider.enabled,
				authKind: provider.authKind,
				apiType: provider.apiType,
				...(provider.baseURL !== undefined ? { baseURL: provider.baseURL } : {}),
				...(provider.headers !== undefined ? { headers: provider.headers } : {}),
				...(providerDefaultModelId !== undefined ? { defaultModelId: providerDefaultModelId } : {}),
				authState,
			});
			models.push(...providerModels);
		}

		const defaultModelId = state.defaultModelId && models.some(model => model.id === state.defaultModelId)
			? state.defaultModelId
			: models.find(model => model.providerInstanceId === state.defaultProviderId)?.id ?? models[0]?.id;
		const snapshot: DirectorProviderSnapshot = {
			version: DirectorProviderSnapshotVersion,
			updatedAt: Date.now(),
			defaultProviderId: state.defaultProviderId,
			defaultModelId,
			providers,
			models,
		};
		const resources = this.getSnapshotResources();
		try {
			const content = VSBuffer.fromString(JSON.stringify(snapshot, undefined, '\t'));
			for (const resource of resources) {
				await this.fileService.createFolder(dirname(resource));
				await this.fileService.writeFile(resource, content);
			}
		} catch (err) {
			this.logService.error('[Director] Failed to write provider snapshot', err);
			throw err;
		}
		return snapshot;
	}

	async getSnapshotResource(): Promise<string> {
		return getDirectorProviderSnapshotResourceFromGlobalStorageHome(this.userDataProfileService.currentProfile.globalStorageHome).fsPath;
	}

	private getSnapshotResources(): readonly ReturnType<typeof getDirectorProviderSnapshotResourceFromGlobalStorageHome>[] {
		const current = getDirectorProviderSnapshotResourceFromGlobalStorageHome(this.userDataProfileService.currentProfile.globalStorageHome);
		const defaultProfile = getDirectorProviderSnapshotResourceFromGlobalStorageHome(this.userDataProfilesService.defaultProfile.globalStorageHome);
		return current.toString() === defaultProfile.toString() ? [current] : [current, defaultProfile];
	}

	private getAuthState(provider: DirectorStoredProviderInstance): Promise<DirectorProviderAuthState> {
		switch (provider.authKind) {
			case 'none':
				return Promise.resolve({ kind: 'none', updatedAt: Date.now() });
			case 'api-key':
				return this.apiKeyService.getAuthState(provider);
			case 'oauth':
			case 'bearer':
				return this.oauthService.getAuthState(provider);
		}
	}
}

export class DirectorProviderConnectionTestService implements IDirectorProviderConnectionTestService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IDirectorApiKeyService private readonly apiKeyService: IDirectorApiKeyService,
		@IDirectorOAuthService private readonly oauthService: IDirectorOAuthService,
		@IDirectorModelResolverService private readonly modelResolverService: IDirectorModelResolverService,
	) { }

	async validateProviderSetup(provider: DirectorStoredProviderInstance, modelId?: string): Promise<DirectorProviderConnectionTestResult> {
		const authState = await this.getAuthState(provider);
		if (authState.kind !== 'ready' && authState.kind !== 'none') {
			return {
				status: 'missingAuth',
				message: authState.message ?? `Director provider '${provider.displayName}' credentials are not ready.`,
				authState,
			};
		}

		if (!provider.baseURL && provider.apiType !== 'local') {
			return {
				status: 'unsupported',
				message: `Director provider '${provider.displayName}' needs a base URL before it can be validated.`,
				authState,
			};
		}

		const models = await this.modelResolverService.resolveModels(provider);
		const model = models.find(model => model.id === modelId || model.providerModelId === modelId)
			?? models.find(model => model.id === provider.defaultModelId)
			?? models[0];
		if (model === undefined) {
			return {
				status: 'modelUnavailable',
				message: `Director provider '${provider.displayName}' has no models to validate.`,
				authState,
			};
		}

		return {
			status: 'ok',
			message: `Director provider '${provider.displayName}' is configured. No network request was sent.`,
			request: buildDirectorConnectionTestRequest(provider.apiType, provider.baseURL ?? '', model.providerModelId ?? model.id, '<redacted>'),
			authState,
		};
	}

	private getAuthState(provider: DirectorStoredProviderInstance): Promise<DirectorProviderAuthState> {
		switch (provider.authKind) {
			case 'none':
				return Promise.resolve({ kind: 'none', updatedAt: Date.now() });
			case 'api-key':
				return this.apiKeyService.getAuthState(provider);
			case 'oauth':
			case 'bearer':
				return this.oauthService.getAuthState(provider);
		}
	}
}

export function createDirectorProviderInstance(options: {
	readonly id?: string;
	readonly kind: DirectorProviderKind;
	readonly displayName: string;
	readonly authKind: DirectorProviderAuthKind;
	readonly apiType: DirectorProviderApiType;
	readonly baseURL?: string;
	readonly modelId?: string;
	readonly authVariant?: 'default' | 'openai-codex';
}): DirectorStoredProviderInstance {
	const id = sanitizeDirectorProviderId(options.id ?? options.displayName);
	const modelLabel = options.modelId?.trim();
	const modelId = modelLabel ? makeDirectorProviderModelKey(id, modelLabel) : undefined;
	const now = Date.now();
	return {
		id,
		kind: options.kind,
		displayName: options.displayName.trim() || id,
		enabled: true,
		authKind: options.authKind,
		apiType: options.apiType,
		authVariant: options.authVariant,
		baseURL: options.baseURL?.trim() || undefined,
		defaultModelId: modelId,
		models: modelId && modelLabel ? [{ id: modelId, providerModelId: modelLabel, name: modelLabel }] : undefined,
		createdAt: now,
		updatedAt: now,
	};
}

function getProviderModelId(providerInstanceId: string, modelId: string): string {
	const prefix = `${sanitizeDirectorProviderId(providerInstanceId)}:`;
	return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
}

function normalizeStoredProvider(provider: DirectorStoredProviderInstance): DirectorStoredProviderInstance {
	const id = sanitizeDirectorProviderId(provider.id);
	const apiType = provider.apiType ?? apiTypeForKind(provider.kind);
	const models = provider.models?.map(model => normalizeStoredModel(id, model));
	const requestedDefaultModelId = provider.defaultModelId !== undefined ? makeDirectorProviderModelKey(id, getProviderModelId(id, provider.defaultModelId)) : undefined;
	const defaultModelId = models !== undefined
		? requestedDefaultModelId !== undefined && models.some(model => model.id === requestedDefaultModelId && model.hidden !== true)
			? requestedDefaultModelId
			: models.find(model => model.hidden !== true)?.id
		: requestedDefaultModelId;
	return {
		id,
		kind: provider.kind,
		displayName: provider.displayName || id,
		enabled: provider.enabled !== false,
		authKind: provider.authKind,
		apiType,
		...(provider.authVariant !== undefined ? { authVariant: provider.authVariant } : {}),
		...(provider.baseURL !== undefined ? { baseURL: provider.baseURL } : {}),
		...(provider.headers !== undefined ? { headers: sanitizeDirectorProviderHeaders(provider.headers) } : {}),
		...(defaultModelId !== undefined ? { defaultModelId } : {}),
		...(models !== undefined ? { models } : {}),
		createdAt: provider.createdAt ?? Date.now(),
		updatedAt: provider.updatedAt ?? Date.now(),
	};
}

function normalizeStoredModel(providerInstanceId: string, model: DirectorStoredProviderModel): DirectorStoredProviderModel {
	const providerModelId = model.providerModelId ?? getProviderModelId(providerInstanceId, model.id);
	return {
		id: makeDirectorProviderModelKey(providerInstanceId, providerModelId),
		providerModelId,
		name: model.name ?? providerModelId,
		...(model.family !== undefined ? { family: model.family } : {}),
		...(model.hidden !== undefined ? { hidden: model.hidden } : {}),
		...(model.maxContextWindow !== undefined ? { maxContextWindow: model.maxContextWindow } : {}),
		...(model.supportsVision !== undefined ? { supportsVision: model.supportsVision } : {}),
		...(model.capabilities !== undefined ? { capabilities: model.capabilities } : {}),
	};
}

function apiTypeForKind(kind: DirectorProviderKind): DirectorProviderApiType {
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

function getDefaultModels(apiType: DirectorProviderApiType): readonly DirectorStoredProviderModel[] {
	switch (apiType) {
		case 'anthropic-messages':
			return [{ id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5' }];
		case 'openai-completions':
			return [{ id: 'gpt-4.1', name: 'GPT-4.1' }];
		case 'openai-codex':
			return [{ id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex' }];
		case 'gemini-generative':
			return [{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }];
		case 'local':
		case 'custom-http':
			return [{ id: 'local-model', name: 'Local Model' }];
	}
}

function defaultCapabilities(apiType: DirectorProviderApiType): DirectorProviderCapabilities {
	return {
		streaming: apiType !== 'local',
		toolCalling: apiType !== 'local',
		vision: false,
		agentMode: true,
	};
}
