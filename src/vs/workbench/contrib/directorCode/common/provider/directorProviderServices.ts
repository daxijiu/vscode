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
import { getDirectorApiKeySecretStorageKey, getDirectorOAuthTokenSecretStorageKey, isDirectorOAuthTokenExpired, parseDirectorOAuthAccessToken, parseDirectorOAuthTokenRecord, type DirectorOAuthAuthVariant, type DirectorOAuthTokenRecord, type DirectorRuntimeCredential, type DirectorRuntimeCredentialRequest, type IDirectorRuntimeCredentialService } from '../../../../../platform/agentHost/common/directorRuntimeCredentials.js';
import { buildDirectorConnectionTestRequest, type DirectorConnectionTestRequest } from '../../../../../platform/agentHost/common/directorProviderRequest.js';
import { DirectorProviderSnapshotVersion, getDirectorProviderRegistryResourceFromGlobalStorageHome, getDirectorProviderSnapshotResourceFromGlobalStorageHome, makeDirectorProviderModelKey, sanitizeDirectorProviderHeaders, sanitizeDirectorProviderId, type DirectorProviderAuthState, type DirectorProviderSnapshot, type DirectorProviderSnapshotModel, type DirectorProviderSnapshotProvider } from '../../../../../platform/agentHost/common/directorProviderSnapshot.js';

export const IDirectorProviderRegistryService = createDecorator<IDirectorProviderRegistryService>('directorProviderRegistryService');
export const IDirectorApiKeyService = createDecorator<IDirectorApiKeyService>('directorApiKeyService');
export const IDirectorOAuthService = createDecorator<IDirectorOAuthService>('directorOAuthService');
export const IDirectorModelResolverService = createDecorator<IDirectorModelResolverService>('directorModelResolverService');
export const IDirectorProviderSnapshotService = createDecorator<IDirectorProviderSnapshotService>('directorProviderSnapshotService');
export const IDirectorProviderConnectionTestService = createDecorator<IDirectorProviderConnectionTestService>('directorProviderConnectionTestService');

export interface DirectorStoredProviderInstance extends DirectorProviderInstance {
	readonly apiType: DirectorProviderApiType;
	readonly authVariant?: DirectorOAuthAuthVariant;
	readonly models?: readonly DirectorStoredProviderModel[];
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface DirectorStoredProviderModel {
	readonly id: string;
	readonly providerModelId?: string;
	readonly name?: string;
	readonly family?: string;
	readonly version?: string;
	readonly hidden?: boolean;
	readonly maxContextWindow?: number;
	readonly maxOutputTokens?: number;
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
	signInProvider(provider: DirectorStoredProviderInstance): Promise<void>;
	storeToken(provider: DirectorStoredProviderInstance, token: DirectorOAuthTokenPayload): Promise<void>;
	refreshProviderToken(provider: DirectorStoredProviderInstance): Promise<DirectorProviderAuthState>;
	signOutProvider(providerInstanceId: string): Promise<void>;
	getAccessToken(providerInstanceId: string): Promise<string | undefined>;
	getTokenRecord(providerInstanceId: string): Promise<DirectorOAuthTokenRecord | undefined>;
	signInOpenAICodex(providerInstanceId: string): Promise<void>;
	signOutOpenAICodex(providerInstanceId: string): Promise<void>;
	getOpenAICodexAccessToken(providerInstanceId: string): Promise<string | undefined>;
	getAuthState(provider: DirectorStoredProviderInstance): Promise<DirectorProviderAuthState>;
}

export interface DirectorOAuthTokenPayload {
	readonly accessToken: string;
	readonly refreshToken?: string;
	readonly expiresAt?: number;
	readonly identityKey?: string;
}

export interface IDirectorModelResolverService {
	readonly _serviceBrand: undefined;
	resolveModels(provider: DirectorStoredProviderInstance): Promise<readonly DirectorProviderSnapshotModel[]>;
	refreshModels(provider: DirectorStoredProviderInstance): Promise<readonly DirectorStoredProviderModel[]>;
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
		return getDirectorApiKeySecretStorageKey(providerInstanceId);
	}
}

export class DirectorOAuthService extends Disposable implements IDirectorOAuthService {
	declare readonly _serviceBrand: undefined;

	private readonly onDidChangeAuthEmitter = this._register(new Emitter<string>());
	readonly onDidChangeAuth = this.onDidChangeAuthEmitter.event;

	constructor(@ISecretStorageService private readonly secretStorageService: ISecretStorageService) {
		super();
	}

	async signInProvider(provider: DirectorStoredProviderInstance): Promise<void> {
		await this.storeToken(provider, createLocalOAuthTokenPayload(provider, Date.now()));
	}

	async storeToken(provider: DirectorStoredProviderInstance, token: DirectorOAuthTokenPayload): Promise<void> {
		const now = Date.now();
		const providerId = getDirectorOAuthProviderId(provider);
		const authVariant = getDirectorOAuthAuthVariant(provider);
		await this.writeTokenRecord({
			providerInstanceId: provider.id,
			providerId,
			authVariant,
			identityKey: token.identityKey ?? getDirectorOAuthIdentityKey(provider),
			accessToken: token.accessToken,
			...(token.refreshToken !== undefined ? { refreshToken: token.refreshToken } : {}),
			...(token.expiresAt !== undefined ? { expiresAt: token.expiresAt } : {}),
			createdAt: now,
			updatedAt: now,
		});
	}

	async refreshProviderToken(provider: DirectorStoredProviderInstance): Promise<DirectorProviderAuthState> {
		const record = await this.getTokenRecord(provider.id);
		if (record === undefined) {
			return { kind: 'signedOut', message: `Director provider '${provider.displayName}' is signed out.`, updatedAt: Date.now() };
		}
		const providerId = getDirectorOAuthProviderId(provider);
		const authVariant = getDirectorOAuthAuthVariant(provider);
		if (record.providerInstanceId !== provider.id || record.providerId !== providerId || record.authVariant !== authVariant) {
			return {
				kind: 'error',
				message: `Director provider '${provider.displayName}' has OAuth state for a different provider identity.`,
				updatedAt: Date.now(),
			};
		}
		if (record.refreshToken === undefined) {
			return { kind: 'expired', identityKey: record.identityKey, message: `Director provider '${provider.displayName}' needs OAuth re-authentication.`, updatedAt: Date.now() };
		}
		const now = Date.now();
		await this.writeTokenRecord({
			...record,
			accessToken: createLocalOAuthAccessToken(record.providerId, record.authVariant, true),
			expiresAt: now + DirectorOAuthLocalTokenLifetimeMs,
			updatedAt: now,
		});
		return this.getAuthState(provider);
	}

	async signOutProvider(providerInstanceId: string): Promise<void> {
		await this.secretStorageService.delete(this.getKey(providerInstanceId));
		this.onDidChangeAuthEmitter.fire(providerInstanceId);
	}

	async getAccessToken(providerInstanceId: string): Promise<string | undefined> {
		const value = await this.secretStorageService.get(this.getKey(providerInstanceId));
		return parseDirectorOAuthAccessToken(value);
	}

	async getTokenRecord(providerInstanceId: string): Promise<DirectorOAuthTokenRecord | undefined> {
		const value = await this.secretStorageService.get(this.getKey(providerInstanceId));
		return parseDirectorOAuthTokenRecord(value);
	}

	async signInOpenAICodex(providerInstanceId: string): Promise<void> {
		await this.signInProvider(createDirectorProviderInstance({
			id: providerInstanceId,
			kind: 'openai-codex',
			displayName: 'OpenAI Codex',
			authKind: 'oauth',
			apiType: 'openai-codex',
			authVariant: 'openai-codex',
		}));
	}

	async signOutOpenAICodex(providerInstanceId: string): Promise<void> {
		await this.signOutProvider(providerInstanceId);
	}

	async getOpenAICodexAccessToken(providerInstanceId: string): Promise<string | undefined> {
		return this.getAccessToken(providerInstanceId);
	}

	async getAuthState(provider: DirectorStoredProviderInstance): Promise<DirectorProviderAuthState> {
		if (provider.authKind !== 'oauth') {
			return { kind: 'missing', message: `Director provider '${provider.id}' is not configured for OAuth.`, updatedAt: Date.now() };
		}
		const value = await this.secretStorageService.get(this.getKey(provider.id));
		if (!value) {
			return { kind: 'signedOut', message: `Director provider '${provider.displayName}' is signed out.`, updatedAt: Date.now() };
		}
		const record = parseDirectorOAuthTokenRecord(value);
		if (record !== undefined) {
			const providerId = getDirectorOAuthProviderId(provider);
			const authVariant = getDirectorOAuthAuthVariant(provider);
			if (record.providerInstanceId !== provider.id || record.providerId !== providerId || record.authVariant !== authVariant) {
				return {
					kind: 'error',
					message: `Director provider '${provider.displayName}' has OAuth state for a different provider identity.`,
					updatedAt: Date.now(),
				};
			}
			if (isDirectorOAuthTokenExpired(record)) {
				return {
					kind: 'expired',
					identityKey: record.identityKey,
					message: `Director provider '${provider.displayName}' OAuth token expired. Sign in again or refresh the token.`,
					updatedAt: Date.now(),
				};
			}
			return { kind: 'ready', identityKey: record.identityKey, updatedAt: Date.now() };
		}
		return parseDirectorOAuthAccessToken(value)
			? { kind: 'ready', identityKey: getDirectorOAuthIdentityKey(provider), updatedAt: Date.now() }
			: { kind: 'error', message: `Director provider '${provider.displayName}' has an invalid OAuth token record.`, updatedAt: Date.now() };
	}

	private getKey(providerInstanceId: string): string {
		return getDirectorOAuthTokenSecretStorageKey(providerInstanceId);
	}

	private async writeTokenRecord(record: DirectorOAuthTokenRecord): Promise<void> {
		await this.secretStorageService.set(this.getKey(record.providerInstanceId), JSON.stringify(record));
		this.onDidChangeAuthEmitter.fire(record.providerInstanceId);
	}
}

const DirectorOAuthLocalTokenLifetimeMs = 60 * 60 * 1000;

function createLocalOAuthTokenPayload(provider: DirectorStoredProviderInstance, now: number): DirectorOAuthTokenPayload {
	const providerId = getDirectorOAuthProviderId(provider);
	const authVariant = getDirectorOAuthAuthVariant(provider);
	return {
		accessToken: createLocalOAuthAccessToken(providerId, authVariant, false),
		refreshToken: `director-code-fake-${providerId}-${authVariant}-refresh-token`,
		expiresAt: now + DirectorOAuthLocalTokenLifetimeMs,
		identityKey: getDirectorOAuthIdentityKey(provider),
	};
}

function createLocalOAuthAccessToken(providerId: string, authVariant: DirectorOAuthAuthVariant, refreshed: boolean): string {
	if (providerId === 'openai' && authVariant === 'openai-codex') {
		return refreshed ? 'director-code-fake-openai-codex-refreshed-token' : 'director-code-fake-openai-codex-token';
	}
	if (providerId === 'anthropic') {
		return refreshed ? 'director-code-fake-anthropic-oauth-refreshed-token' : 'director-code-fake-anthropic-oauth-token';
	}
	return `director-code-fake-${providerId}-${authVariant}-${refreshed ? 'refreshed' : 'access'}-token`;
}

function getDirectorOAuthProviderId(provider: Pick<DirectorStoredProviderInstance, 'kind'>): string {
	switch (provider.kind) {
		case 'openai':
		case 'openai-codex':
			return 'openai';
		case 'anthropic':
		case 'anthropic-compatible':
			return 'anthropic';
		case 'openai-compatible':
			return 'openai-compatible';
		case 'gemini':
			return 'gemini';
		case 'local':
			return 'local';
		case 'custom-http':
			return 'custom-http';
	}
}

function getDirectorOAuthAuthVariant(provider: Pick<DirectorStoredProviderInstance, 'authVariant'>): DirectorOAuthAuthVariant {
	return provider.authVariant ?? 'default';
}

function getDirectorOAuthIdentityKey(provider: Pick<DirectorStoredProviderInstance, 'id' | 'kind' | 'authVariant'>): string {
	const providerId = getDirectorOAuthProviderId(provider);
	const authVariant = getDirectorOAuthAuthVariant(provider);
	return `oauth:${providerId}:${authVariant}:${provider.id}:local`;
}

export class DirectorRuntimeCredentialService implements IDirectorRuntimeCredentialService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IDirectorApiKeyService private readonly apiKeyService: IDirectorApiKeyService,
		@IDirectorOAuthService private readonly oauthService: IDirectorOAuthService,
	) { }

	async resolveCredential(request: DirectorRuntimeCredentialRequest): Promise<DirectorRuntimeCredential> {
		switch (request.authKind) {
			case 'none':
				return { kind: 'none' };
			case 'api-key': {
				const value = await this.apiKeyService.getProviderInstanceKey(request.providerInstanceId);
				return value
					? { kind: 'api-key', value }
					: { kind: 'missing', message: `Director provider '${request.providerInstanceId}' is missing an API key.` };
			}
			case 'oauth':
			case 'bearer': {
				const accessToken = await this.oauthService.getAccessToken(request.providerInstanceId);
				return accessToken
					? { kind: 'bearer', accessToken }
					: { kind: 'missing', message: `Director provider '${request.providerInstanceId}' is signed out or missing an OAuth token.` };
			}
		}
	}
}

const DirectorModelRefreshTimeoutMs = 15_000;
const DirectorModelRefreshErrorBodyLimit = 200;

export class DirectorModelResolverService implements IDirectorModelResolverService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IDirectorApiKeyService private readonly apiKeyService: IDirectorApiKeyService,
		@IDirectorOAuthService private readonly oauthService: IDirectorOAuthService,
	) { }

	async resolveModels(provider: DirectorStoredProviderInstance): Promise<readonly DirectorProviderSnapshotModel[]> {
		const models = provider.models?.length ? provider.models : getDefaultModels(provider.apiType);
		return models.filter(model => model.hidden !== true).map(model => {
			const providerModelId = model.providerModelId ?? getProviderModelId(provider.id, model.id);
			const limits = getDefaultModelLimits(provider.apiType, providerModelId);
			return {
				providerInstanceId: provider.id,
				id: makeDirectorProviderModelKey(provider.id, providerModelId),
				providerModelId,
				name: model.name ?? providerModelId,
				family: model.family ?? provider.kind,
				version: model.version,
				maxContextWindow: model.maxContextWindow ?? limits.maxContextWindow,
				maxOutputTokens: model.maxOutputTokens ?? limits.maxOutputTokens,
				supportsVision: model.supportsVision ?? false,
				capabilities: model.capabilities ?? defaultCapabilities(provider.apiType),
				apiType: provider.apiType,
				providerDisplayName: provider.displayName,
			};
		});
	}

	async refreshModels(provider: DirectorStoredProviderInstance): Promise<readonly DirectorStoredProviderModel[]> {
		const credential = await this.resolveModelRefreshCredential(provider);
		if (credential === undefined) {
			throw new Error(`Director provider '${provider.displayName}' needs a saved credential before models can be refreshed.`);
		}
		if (!provider.baseURL && provider.apiType !== 'local') {
			throw new Error(`Director provider '${provider.displayName}' needs a base URL before models can be refreshed.`);
		}

		const models = await this.fetchProviderModels(provider, credential);
		if (!models.length) {
			throw new Error(`Director provider '${provider.displayName}' did not return any models. Enter model IDs manually if this endpoint does not expose model discovery.`);
		}
		return models;
	}

	private async resolveModelRefreshCredential(provider: DirectorStoredProviderInstance): Promise<DirectorModelRefreshCredential | undefined> {
		switch (provider.authKind) {
			case 'none':
				return { kind: 'none', value: '', identityKey: `none:${provider.id}` };
			case 'api-key': {
				const value = await this.apiKeyService.getProviderInstanceKey(provider.id);
				return value ? { kind: 'api-key', value, identityKey: `api-key:${provider.id}` } : undefined;
			}
			case 'oauth':
			case 'bearer': {
				const record = await this.oauthService.getTokenRecord(provider.id);
				const value = await this.oauthService.getAccessToken(provider.id);
				return value ? { kind: 'bearer', value, identityKey: record?.identityKey ?? `oauth:${provider.id}` } : undefined;
			}
		}
	}

	private async fetchProviderModels(provider: DirectorStoredProviderInstance, credential: DirectorModelRefreshCredential): Promise<readonly DirectorStoredProviderModel[]> {
		switch (provider.apiType) {
			case 'openai-completions':
				return this.fetchOpenAICompatibleModels(provider, credential);
			case 'anthropic-messages':
				return this.fetchAnthropicModels(provider, credential);
			case 'gemini-generative':
				return this.fetchGeminiModels(provider, credential);
			case 'openai-codex':
				return this.fetchOpenAICodexModels(provider, credential);
			case 'local':
			case 'custom-http':
				throw new Error(`Director provider '${provider.displayName}' does not support model discovery for '${provider.apiType}'.`);
		}
	}

	private async fetchOpenAICompatibleModels(provider: DirectorStoredProviderInstance, credential: DirectorModelRefreshCredential): Promise<readonly DirectorStoredProviderModel[]> {
		const response = await fetchDirectorJson<DirectorOpenAIModelList>(
			`${normalizeOpenAIModelBaseURL(provider)}/models`,
			{
				method: 'GET',
				headers: {
					...(provider.headers ?? {}),
					authorization: `Bearer ${credential.value}`,
				},
			},
			credential,
		);
		const models = Array.isArray(response.data) ? response.data : [];
		return models
			.filter(model => typeof model.id === 'string' && model.id.trim().length > 0 && isRelevantOpenAIModel(model.id, provider.kind))
			.map(model => createStoredModel(provider.id, model.id));
	}

	private async fetchAnthropicModels(provider: DirectorStoredProviderInstance, credential: DirectorModelRefreshCredential): Promise<readonly DirectorStoredProviderModel[]> {
		const headers: Record<string, string> = {
			...(provider.headers ?? {}),
			'anthropic-version': '2023-06-01',
		};
		if (credential.kind === 'bearer') {
			headers.authorization = `Bearer ${credential.value}`;
		} else {
			headers['x-api-key'] = credential.value;
		}
		const response = await fetchDirectorJson<DirectorAnthropicModelList>(
			`${normalizeAnthropicBaseURL(provider.baseURL)}/v1/models?limit=1000`,
			{ method: 'GET', headers },
			credential,
		);
		const models = Array.isArray(response.data) ? response.data : [];
		return models
			.filter(model => typeof model.id === 'string' && model.id.trim().length > 0)
			.map(model => createStoredModel(provider.id, model.id!.trim(), {
				name: model.display_name,
				family: model.id!.includes('claude') ? 'claude' : provider.kind,
				maxContextWindow: model.max_input_tokens,
				maxOutputTokens: model.max_tokens,
			}));
	}

	private async fetchGeminiModels(provider: DirectorStoredProviderInstance, credential: DirectorModelRefreshCredential): Promise<readonly DirectorStoredProviderModel[]> {
		const response = await fetchDirectorJson<DirectorGeminiModelList>(
			`${normalizeGeminiModelBaseURL(provider.baseURL)}/models`,
			{
				method: 'GET',
				headers: {
					...(provider.headers ?? {}),
					'x-goog-api-key': credential.value,
				},
			},
			credential,
		);
		const models = Array.isArray(response.models) ? response.models : [];
		return models
			.filter(model => typeof model.name === 'string' && model.name.includes('gemini') && model.supportedGenerationMethods?.includes('generateContent') === true)
			.map(model => {
				const providerModelId = model.name.replace(/^models\//, '');
				return createStoredModel(provider.id, providerModelId, {
					name: model.displayName,
					family: 'gemini',
					maxContextWindow: model.inputTokenLimit,
					maxOutputTokens: model.outputTokenLimit,
				});
			});
	}

	private async fetchOpenAICodexModels(provider: DirectorStoredProviderInstance, credential: DirectorModelRefreshCredential): Promise<readonly DirectorStoredProviderModel[]> {
		const response = await fetchDirectorJson<DirectorOpenAICodexModelList>(
			`${normalizeBaseURL(provider.baseURL)}/models?client_version=1.0.0`,
			{
				method: 'GET',
				headers: {
					...(provider.headers ?? {}),
					authorization: `Bearer ${credential.value}`,
					'openai-beta': 'responses=experimental',
					originator: 'director-code',
				},
			},
			credential,
		);
		const models = Array.isArray(response.models) ? response.models : [];
		return models
			.filter(model => typeof model.slug === 'string' && model.slug.trim().length > 0)
			.filter(model => model.supported_in_api !== false)
			.filter(model => !['hide', 'hidden'].includes((model.visibility ?? '').trim().toLowerCase()))
			.sort((a, b) => (typeof a.priority === 'number' ? a.priority : 10_000) - (typeof b.priority === 'number' ? b.priority : 10_000) || a.slug!.localeCompare(b.slug!))
			.map(model => createStoredModel(provider.id, model.slug!.trim(), {
				name: model.display_name,
				family: 'openai-codex',
				maxContextWindow: model.max_context_window ?? model.context_window,
			}));
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
	readonly authVariant?: DirectorOAuthAuthVariant;
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
		...(model.version !== undefined ? { version: model.version } : {}),
		...(model.hidden !== undefined ? { hidden: model.hidden } : {}),
		...(model.maxContextWindow !== undefined ? { maxContextWindow: model.maxContextWindow } : {}),
		...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
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

function getDefaultModelLimits(apiType: DirectorProviderApiType, modelId: string): { readonly maxContextWindow: number; readonly maxOutputTokens: number } {
	const normalized = modelId.toLowerCase();
	if (apiType === 'gemini-generative' || normalized.includes('gemini')) {
		return { maxContextWindow: 1_000_000, maxOutputTokens: 65_536 };
	}
	if (apiType === 'openai-codex') {
		return { maxContextWindow: 272_000, maxOutputTokens: 64_000 };
	}
	if (normalized.includes('claude')) {
		return { maxContextWindow: 200_000, maxOutputTokens: 8_192 };
	}
	if (normalized.includes('deepseek')) {
		return { maxContextWindow: 128_000, maxOutputTokens: 8_192 };
	}
	if (normalized.includes('gpt-3.5')) {
		return { maxContextWindow: 16_385, maxOutputTokens: 4_096 };
	}
	if (normalized.includes('o1') || normalized.includes('o3') || normalized.includes('o4')) {
		return { maxContextWindow: 200_000, maxOutputTokens: 100_000 };
	}
	if (normalized.includes('gpt-4') || normalized.includes('gpt-5') || normalized.includes('chatgpt-')) {
		return { maxContextWindow: 128_000, maxOutputTokens: 16_384 };
	}
	if (apiType === 'anthropic-messages') {
		return { maxContextWindow: 200_000, maxOutputTokens: 8_192 };
	}
	if (apiType === 'openai-completions') {
		return { maxContextWindow: 128_000, maxOutputTokens: 8_192 };
	}
	return { maxContextWindow: 8_192, maxOutputTokens: 1_024 };
}

interface DirectorModelRefreshCredential {
	readonly kind: 'none' | 'api-key' | 'bearer';
	readonly value: string;
	readonly identityKey: string;
}

interface DirectorOpenAIModelList {
	readonly data?: readonly { readonly id?: string }[];
}

interface DirectorAnthropicModelList {
	readonly data?: readonly {
		readonly id?: string;
		readonly display_name?: string;
		readonly max_input_tokens?: number;
		readonly max_tokens?: number;
	}[];
}

interface DirectorGeminiModelList {
	readonly models?: readonly {
		readonly name?: string;
		readonly displayName?: string;
		readonly inputTokenLimit?: number;
		readonly outputTokenLimit?: number;
		readonly supportedGenerationMethods?: readonly string[];
	}[];
}

interface DirectorOpenAICodexModelList {
	readonly models?: readonly {
		readonly slug?: string;
		readonly display_name?: string;
		readonly visibility?: string;
		readonly supported_in_api?: boolean;
		readonly context_window?: number;
		readonly max_context_window?: number;
		readonly priority?: number;
	}[];
}

function createStoredModel(providerInstanceId: string, providerModelId: string, options: {
	readonly name?: string;
	readonly family?: string;
	readonly version?: string;
	readonly maxContextWindow?: number;
	readonly maxOutputTokens?: number;
	readonly supportsVision?: boolean;
} = {}): DirectorStoredProviderModel {
	const trimmedModelId = providerModelId.trim();
	return {
		id: makeDirectorProviderModelKey(providerInstanceId, trimmedModelId),
		providerModelId: trimmedModelId,
		name: options.name ?? trimmedModelId,
		...(options.family !== undefined ? { family: options.family } : {}),
		...(options.version !== undefined ? { version: options.version } : {}),
		...(options.maxContextWindow !== undefined ? { maxContextWindow: options.maxContextWindow } : {}),
		...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
		...(options.supportsVision !== undefined ? { supportsVision: options.supportsVision } : {}),
	};
}

async function fetchDirectorJson<T>(url: string, init: RequestInit, credential: DirectorModelRefreshCredential): Promise<T> {
	if (typeof fetch !== 'function') {
		throw new Error('Director model refresh is not available in this environment.');
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DirectorModelRefreshTimeoutMs);
	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		const body = await response.text();
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}${body ? `: ${redactCredential(limitBodySnippet(body), credential)}` : ''}`);
		}
		try {
			return JSON.parse(body) as T;
		} catch {
			throw new Error(`Failed to parse JSON response: ${redactCredential(limitBodySnippet(body), credential)}`);
		}
	} catch (err) {
		if (err instanceof Error && err.name === 'AbortError') {
			throw new Error(`Director model refresh timed out after ${DirectorModelRefreshTimeoutMs}ms.`);
		}
		if (err instanceof Error) {
			throw new Error(redactCredential(err.message, credential));
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

function limitBodySnippet(body: string): string {
	return body.slice(0, DirectorModelRefreshErrorBodyLimit);
}

function redactCredential(value: string, credential: DirectorModelRefreshCredential): string {
	return credential.value ? value.split(credential.value).join('<redacted>') : value;
}

function normalizeBaseURL(baseURL: string | undefined): string {
	return (baseURL ?? '').trim().replace(/\/+$/, '');
}

function normalizeOpenAIModelBaseURL(provider: DirectorStoredProviderInstance): string {
	const base = normalizeBaseURL(provider.baseURL);
	if (provider.kind === 'openai' && !base.endsWith('/v1')) {
		return `${base}/v1`;
	}
	return base;
}

function normalizeAnthropicBaseURL(baseURL: string | undefined): string {
	return normalizeBaseURL(baseURL).replace(/\/v1$/, '');
}

function normalizeGeminiModelBaseURL(baseURL: string | undefined): string {
	const base = normalizeBaseURL(baseURL);
	return base.endsWith('/v1beta') ? base : `${base}/v1beta`;
}

function isRelevantOpenAIModel(id: string, providerKind: DirectorProviderKind): boolean {
	const lower = id.toLowerCase();
	if (lower.includes('embed')) {
		return false;
	}
	if (providerKind === 'openai-compatible') {
		return true;
	}
	if (['moderation', 'tts', 'whisper', 'dall-e'].some(excluded => lower.includes(excluded))) {
		return false;
	}
	return /^(gpt-|o1|o3|o4|chatgpt-)/.test(id);
}
