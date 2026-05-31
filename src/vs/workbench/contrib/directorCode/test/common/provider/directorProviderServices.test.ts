/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../../base/common/event.js';
import { Schemas } from '../../../../../../base/common/network.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../../platform/log/common/log.js';
import { TestSecretStorageService } from '../../../../../../platform/secrets/test/common/testSecretStorageService.js';
import { IUserDataProfilesService, toUserDataProfile } from '../../../../../../platform/userDataProfile/common/userDataProfile.js';
import { IUserDataProfileService } from '../../../../../services/userDataProfile/common/userDataProfile.js';
import { createDirectorProviderInstance, DirectorApiKeyService, DirectorModelResolverService, DirectorOAuthService, DirectorProviderConnectionTestService, DirectorProviderRegistryService, DirectorProviderSnapshotService, DirectorRuntimeCredentialService } from '../../../common/provider/directorProviderServices.js';
import { getDirectorProviderRegistryResourceFromGlobalStorageHome, getDirectorProviderSnapshotResourceFromGlobalStorageHome } from '../../../../../../platform/agentHost/common/directorProviderSnapshot.js';
import { getDirectorOAuthTokenSecretStorageKey, parseDirectorOAuthTokenRecord } from '../../../../../../platform/agentHost/common/directorRuntimeCredentials.js';

suite('directorProviderServices', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let fileService: IFileService;
	let secretStorageService: TestSecretStorageService;
	let userDataProfileService: IUserDataProfileService;
	let userDataProfilesService: IUserDataProfilesService;
	let registryService: DirectorProviderRegistryService;
	let apiKeyService: DirectorApiKeyService;
	let oauthService: DirectorOAuthService;
	let modelResolverService: DirectorModelResolverService;
	let connectionTestService: DirectorProviderConnectionTestService;
	let snapshotService: DirectorProviderSnapshotService;
	let runtimeCredentialService: DirectorRuntimeCredentialService;

	setup(() => {
		const logService = new NullLogService();
		fileService = disposables.add(new FileService(logService));
		disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new InMemoryFileSystemProvider())));
		secretStorageService = disposables.add(new TestSecretStorageService());
		const currentProfile = toUserDataProfile('director-test', 'Director Test', URI.file('/director-test/User'), URI.file('/director-test/cache'));
		const defaultProfile = toUserDataProfile('default', 'Default', URI.file('/director-test/DefaultUser'), URI.file('/director-test/cache-default'));
		userDataProfileService = {
			_serviceBrand: undefined,
			currentProfile,
			onDidChangeCurrentProfile: Event.None,
			updateCurrentProfile: async () => { },
		};
		userDataProfilesService = {
			_serviceBrand: undefined,
			profilesHome: URI.file('/director-test/profiles'),
			defaultProfile,
			onDidChangeProfiles: Event.None,
			profiles: [defaultProfile, currentProfile],
			onDidResetWorkspaces: Event.None,
			createNamedProfile: async () => currentProfile,
			createTransientProfile: async () => currentProfile,
			createProfile: async () => currentProfile,
			updateProfile: async profile => profile,
			removeProfile: async () => { },
			setProfileForWorkspace: async () => { },
			resetWorkspaces: async () => { },
			cleanUp: async () => { },
			cleanUpTransientProfiles: async () => { },
		};

		registryService = disposables.add(new DirectorProviderRegistryService(fileService, userDataProfileService, logService));
		apiKeyService = disposables.add(new DirectorApiKeyService(secretStorageService));
		oauthService = disposables.add(new DirectorOAuthService(secretStorageService));
		runtimeCredentialService = new DirectorRuntimeCredentialService(apiKeyService, oauthService);
		modelResolverService = new DirectorModelResolverService(apiKeyService, oauthService);
		connectionTestService = new DirectorProviderConnectionTestService(apiKeyService, oauthService, modelResolverService);
		snapshotService = disposables.add(new DirectorProviderSnapshotService(
			registryService,
			apiKeyService,
			oauthService,
			modelResolverService,
			fileService,
			userDataProfileService,
			userDataProfilesService,
			logService,
		));
	});

	test('stores provider registry metadata without secrets or sensitive headers', async () => {
		const provider = {
			...createDirectorProviderInstance({
				id: 'My Provider!',
				kind: 'openai-compatible',
				displayName: 'My Provider',
				authKind: 'api-key',
				apiType: 'openai-completions',
				baseURL: 'https://example.test/v1',
				modelId: 'gpt-test',
			}),
			headers: {
				authorization: 'Bearer should-not-persist',
				'x-api-key': 'should-not-persist',
				' OpenAI-Api-Key ': 'should-not-persist',
				'X-ApiKey': 'should-not-persist',
				'x-apiKey': 'should-not-persist',
				'x-director-token': 'should-not-persist',
				'x-director-trace': 'safe-metadata',
			},
			accessToken: 'should-not-persist',
		};

		await registryService.saveProvider(provider);
		const state = await registryService.getState();
		const registry = await readJson(getDirectorProviderRegistryResourceFromGlobalStorageHome(userDataProfileService.currentProfile.globalStorageHome));
		const registryText = JSON.stringify(registry);

		assert.deepStrictEqual({
			providerIds: state.instances.map(provider => provider.id),
			defaultProviderId: state.defaultProviderId,
			defaultModelId: state.defaultModelId,
			headers: state.instances[0].headers,
			hasSensitiveValue: registryText.includes('should-not-persist'),
			hasUnknownTokenField: registryText.includes('accessToken'),
		}, {
			providerIds: ['my-provider'],
			defaultProviderId: 'my-provider',
			defaultModelId: 'my-provider:gpt-test',
			headers: { 'x-director-trace': 'safe-metadata' },
			hasSensitiveValue: false,
			hasUnknownTokenField: false,
		});
	});

	test('writes API-key auth state into the AgentHost snapshot without leaking the key', async () => {
		const provider = createDirectorProviderInstance({
			kind: 'anthropic-compatible',
			displayName: 'Anthropic Compatible',
			authKind: 'api-key',
			apiType: 'anthropic-messages',
			baseURL: 'https://api.anthropic.test',
			modelId: 'claude-test',
		});

		await registryService.saveProvider(provider);
		await apiKeyService.setProviderInstanceKey(provider.id, 'sk-director-secret');
		const snapshot = await snapshotService.writeSnapshot();
		const registryText = JSON.stringify(await readJson(getDirectorProviderRegistryResourceFromGlobalStorageHome(userDataProfileService.currentProfile.globalStorageHome)));
		const snapshotText = JSON.stringify(await readJson(getDirectorProviderSnapshotResourceFromGlobalStorageHome(userDataProfileService.currentProfile.globalStorageHome)));

		assert.deepStrictEqual({
			authState: snapshot.providers[0].authState.kind,
			identityKey: snapshot.providers[0].authState.identityKey,
			modelId: snapshot.models[0].id,
			providerModelId: snapshot.models[0].providerModelId,
			registryLeaksKey: registryText.includes('sk-director-secret'),
			snapshotLeaksKey: snapshotText.includes('sk-director-secret'),
		}, {
			authState: 'ready',
			identityKey: `api-key:${provider.id}`,
			modelId: `${provider.id}:claude-test`,
			providerModelId: 'claude-test',
			registryLeaksKey: false,
			snapshotLeaksKey: false,
		});
	});

	test('keeps hidden models out of the AgentHost snapshot default surface', async () => {
		const base = createDirectorProviderInstance({
			id: 'models-provider',
			kind: 'openai-compatible',
			displayName: 'Models Provider',
			authKind: 'api-key',
			apiType: 'openai-completions',
			baseURL: 'https://api.openai.test/v1',
			modelId: 'visible-model',
		});
		const provider = {
			...base,
			models: [
				{ id: `${base.id}:hidden-model`, providerModelId: 'hidden-model', name: 'Hidden Model', hidden: true, maxContextWindow: 1000 },
				{ id: `${base.id}:visible-model`, providerModelId: 'visible-model', name: 'Visible Model', family: 'visible-family', version: '2026-05-27', maxContextWindow: 2000, maxOutputTokens: 4096 },
			],
			defaultModelId: `${base.id}:hidden-model`,
		};

		await registryService.saveProvider(provider);
		await apiKeyService.setProviderInstanceKey(provider.id, 'sk-director-secret');
		const snapshot = await snapshotService.writeSnapshot();

		assert.deepStrictEqual({
			registryDefault: (await registryService.getState()).defaultModelId,
			snapshotDefault: snapshot.defaultModelId,
			models: snapshot.models.map(model => ({
				id: model.id,
				providerModelId: model.providerModelId,
				name: model.name,
				family: model.family,
				version: model.version,
				maxContextWindow: model.maxContextWindow,
				maxOutputTokens: model.maxOutputTokens,
			})),
			leaksHidden: JSON.stringify(snapshot).includes('hidden-model'),
		}, {
			registryDefault: `${base.id}:visible-model`,
			snapshotDefault: `${base.id}:visible-model`,
			models: [{
				id: `${base.id}:visible-model`,
				providerModelId: 'visible-model',
				name: 'Visible Model',
				family: 'visible-family',
				version: '2026-05-27',
				maxContextWindow: 2000,
				maxOutputTokens: 4096,
			}],
			leaksHidden: false,
		});
	});

	test('tracks deterministic OpenAI Codex OAuth state without leaking the fake token', async () => {
		const provider = createDirectorProviderInstance({
			id: 'openai-codex',
			kind: 'openai-codex',
			displayName: 'OpenAI Codex',
			authKind: 'oauth',
			apiType: 'openai-codex',
			authVariant: 'openai-codex',
			baseURL: 'https://chatgpt.com/backend-api/codex',
			modelId: 'gpt-5.2-codex',
		});

		await registryService.saveProvider(provider);
		await oauthService.signInOpenAICodex(provider.id);
		const tokenRecord = parseDirectorOAuthTokenRecord(await secretStorageService.get(getDirectorOAuthTokenSecretStorageKey(provider.id)));
		const readySnapshot = await snapshotService.writeSnapshot();
		await oauthService.signOutOpenAICodex(provider.id);
		const signedOutSnapshot = await snapshotService.writeSnapshot();
		const snapshotText = JSON.stringify(await readJson(getDirectorProviderSnapshotResourceFromGlobalStorageHome(userDataProfileService.currentProfile.globalStorageHome)));

		assert.deepStrictEqual({
			tokenRecord: tokenRecord && {
				providerInstanceId: tokenRecord.providerInstanceId,
				providerId: tokenRecord.providerId,
				authVariant: tokenRecord.authVariant,
				identityKey: tokenRecord.identityKey,
				hasRefreshToken: tokenRecord.refreshToken !== undefined,
				hasExpiresAt: tokenRecord.expiresAt !== undefined,
			},
			readyAuthState: readySnapshot.providers[0].authState.kind,
			readyIdentityKey: readySnapshot.providers[0].authState.identityKey,
			signedOutAuthState: signedOutSnapshot.providers[0].authState.kind,
			leaksFakeToken: snapshotText.includes('director-code-fake-openai-codex-token'),
		}, {
			tokenRecord: {
				providerInstanceId: provider.id,
				providerId: 'openai',
				authVariant: 'openai-codex',
				identityKey: `oauth:openai:openai-codex:${provider.id}:local`,
				hasRefreshToken: true,
				hasExpiresAt: true,
			},
			readyAuthState: 'ready',
			readyIdentityKey: `oauth:openai:openai-codex:${provider.id}:local`,
			signedOutAuthState: 'signedOut',
			leaksFakeToken: false,
		});
	});

	test('tracks Anthropic OAuth state through provider-scoped token records', async () => {
		const provider = createDirectorProviderInstance({
			id: 'anthropic-oauth',
			kind: 'anthropic',
			displayName: 'Anthropic OAuth',
			authKind: 'oauth',
			apiType: 'anthropic-messages',
			authVariant: 'default',
			baseURL: 'https://api.anthropic.test',
			modelId: 'claude-test',
		});

		await registryService.saveProvider(provider);
		await oauthService.signInProvider(provider);
		const snapshot = await snapshotService.writeSnapshot();
		const tokenRecord = parseDirectorOAuthTokenRecord(await secretStorageService.get(getDirectorOAuthTokenSecretStorageKey(provider.id)));
		const registryText = JSON.stringify(await readJson(getDirectorProviderRegistryResourceFromGlobalStorageHome(userDataProfileService.currentProfile.globalStorageHome)));
		const snapshotText = JSON.stringify(await readJson(getDirectorProviderSnapshotResourceFromGlobalStorageHome(userDataProfileService.currentProfile.globalStorageHome)));

		assert.deepStrictEqual({
			tokenRecord: tokenRecord && {
				providerInstanceId: tokenRecord.providerInstanceId,
				providerId: tokenRecord.providerId,
				authVariant: tokenRecord.authVariant,
				identityKey: tokenRecord.identityKey,
				accessToken: tokenRecord.accessToken,
				hasRefreshToken: tokenRecord.refreshToken !== undefined,
			},
			authState: snapshot.providers[0].authState,
			runtimeCredential: await runtimeCredentialService.resolveCredential({ providerInstanceId: provider.id, authKind: 'oauth' }),
			registryLeaksAccessToken: registryText.includes('director-code-fake-anthropic-oauth-token'),
			snapshotLeaksAccessToken: snapshotText.includes('director-code-fake-anthropic-oauth-token'),
			runtimeCredentialLeaksRefreshToken: JSON.stringify(await runtimeCredentialService.resolveCredential({ providerInstanceId: provider.id, authKind: 'oauth' })).includes('refresh'),
		}, {
			tokenRecord: {
				providerInstanceId: provider.id,
				providerId: 'anthropic',
				authVariant: 'default',
				identityKey: `oauth:anthropic:default:${provider.id}:local`,
				accessToken: 'director-code-fake-anthropic-oauth-token',
				hasRefreshToken: true,
			},
			authState: {
				kind: 'ready',
				identityKey: `oauth:anthropic:default:${provider.id}:local`,
				updatedAt: snapshot.providers[0].authState.updatedAt,
			},
			runtimeCredential: { kind: 'bearer', accessToken: 'director-code-fake-anthropic-oauth-token' },
			registryLeaksAccessToken: false,
			snapshotLeaksAccessToken: false,
			runtimeCredentialLeaksRefreshToken: false,
		});
	});

	test('tracks OAuth expiry, deterministic refresh, and logout state', async () => {
		const provider = createDirectorProviderInstance({
			id: 'anthropic-oauth',
			kind: 'anthropic',
			displayName: 'Anthropic OAuth',
			authKind: 'oauth',
			apiType: 'anthropic-messages',
			authVariant: 'default',
			baseURL: 'https://api.anthropic.test',
			modelId: 'claude-test',
		});

		await oauthService.storeToken(provider, {
			accessToken: 'expired-token',
			refreshToken: 'refresh-token',
			expiresAt: Date.now() - 1,
			identityKey: `oauth:anthropic:default:${provider.id}:local`,
		});
		const expired = await oauthService.getAuthState(provider);
		const missingCredential = await runtimeCredentialService.resolveCredential({ providerInstanceId: provider.id, authKind: 'oauth' });
		const refreshed = await oauthService.refreshProviderToken(provider);
		const refreshedCredential = await runtimeCredentialService.resolveCredential({ providerInstanceId: provider.id, authKind: 'oauth' });
		await oauthService.signOutProvider(provider.id);
		const signedOut = await oauthService.getAuthState(provider);

		assert.deepStrictEqual({
			expired: expired.kind,
			missingCredential: missingCredential.kind,
			refreshed: refreshed.kind,
			refreshedCredential,
			signedOut: signedOut.kind,
		}, {
			expired: 'expired',
			missingCredential: 'missing',
			refreshed: 'ready',
			refreshedCredential: { kind: 'bearer', accessToken: 'director-code-fake-anthropic-oauth-refreshed-token' },
			signedOut: 'signedOut',
		});
	});

	test('writes a default-profile snapshot mirror for AgentHost while keeping current profile storage', async () => {
		const provider = createDirectorProviderInstance({
			kind: 'openai-compatible',
			displayName: 'OpenAI Compatible',
			authKind: 'api-key',
			apiType: 'openai-completions',
			baseURL: 'https://api.openai.test/v1',
			modelId: 'gpt-test',
		});

		await registryService.saveProvider(provider);
		await apiKeyService.setProviderInstanceKey(provider.id, 'sk-director-secret');
		await snapshotService.writeSnapshot();

		assert.deepStrictEqual({
			currentExists: await fileService.exists(getDirectorProviderSnapshotResourceFromGlobalStorageHome(userDataProfileService.currentProfile.globalStorageHome)),
			defaultExists: await fileService.exists(getDirectorProviderSnapshotResourceFromGlobalStorageHome(userDataProfilesService.defaultProfile.globalStorageHome)),
		}, {
			currentExists: true,
			defaultExists: true,
		});
	});

	test('validates provider setup through a redacted no-network request template', async () => {
		const provider = createDirectorProviderInstance({
			kind: 'openai-compatible',
			displayName: 'OpenAI Compatible',
			authKind: 'api-key',
			apiType: 'openai-completions',
			baseURL: 'https://api.openai.test/v1',
			modelId: 'gpt-test',
		});

		const missing = await connectionTestService.validateProviderSetup(provider);
		await apiKeyService.setProviderInstanceKey(provider.id, 'sk-director-secret');
		const ready = await connectionTestService.validateProviderSetup(provider);

		assert.deepStrictEqual({
			missing: missing.status,
			ready: ready.status,
			requestUrl: ready.request?.url,
			requestAuth: ready.request?.headers.authorization,
			leaksKey: JSON.stringify(ready).includes('sk-director-secret'),
		}, {
			missing: 'missingAuth',
			ready: 'ok',
			requestUrl: 'https://api.openai.test/v1/chat/completions',
			requestAuth: 'Bearer <redacted>',
			leaksKey: false,
		});
	});

	test('resolves runtime credentials only through the narrow bridge', async () => {
		const apiKeyProvider = createDirectorProviderInstance({
			id: 'api-key-provider',
			kind: 'openai-compatible',
			displayName: 'API Key Provider',
			authKind: 'api-key',
			apiType: 'openai-completions',
			baseURL: 'https://api.openai.test/v1',
			modelId: 'gpt-test',
		});
		const oauthProvider = createDirectorProviderInstance({
			id: 'openai-codex',
			kind: 'openai-codex',
			displayName: 'OpenAI Codex',
			authKind: 'oauth',
			apiType: 'openai-codex',
			authVariant: 'openai-codex',
			baseURL: 'https://chatgpt.com/backend-api/codex',
			modelId: 'gpt-5.2-codex',
		});

		await apiKeyService.setProviderInstanceKey(apiKeyProvider.id, 'sk-director-secret');
		await oauthService.signInOpenAICodex(oauthProvider.id);

		assert.deepStrictEqual({
			apiKey: await runtimeCredentialService.resolveCredential({ providerInstanceId: apiKeyProvider.id, authKind: 'api-key' }),
			oauth: await runtimeCredentialService.resolveCredential({ providerInstanceId: oauthProvider.id, authKind: 'oauth' }),
			missing: await runtimeCredentialService.resolveCredential({ providerInstanceId: 'missing-provider', authKind: 'api-key' }),
		}, {
			apiKey: { kind: 'api-key', value: 'sk-director-secret' },
			oauth: { kind: 'bearer', accessToken: 'director-code-fake-openai-codex-token' },
			missing: { kind: 'missing', message: 'Director provider \'missing-provider\' is missing an API key.' },
		});
	});

	test('refreshes OpenAI-compatible models from the provider endpoint without persisting secrets', async () => {
		const provider = createDirectorProviderInstance({
			id: 'deepseek',
			kind: 'openai-compatible',
			displayName: 'DeepSeek',
			authKind: 'api-key',
			apiType: 'openai-completions',
			modelId: 'placeholder',
		});
		let requestedUrl: string | undefined;
		let requestedAuth: string | undefined;
		const server = await startModelServer((req, res) => {
			requestedUrl = req.url;
			requestedAuth = Array.isArray(req.headers.authorization) ? req.headers.authorization.join(',') : req.headers.authorization;
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({
				data: [
					{ id: 'deepseek-chat' },
					{ id: 'deepseek-reasoner' },
					{ id: 'embedding-model' },
				],
			}));
		});
		try {
			const providerWithBase = { ...provider, baseURL: server.baseURL };
			await apiKeyService.setProviderInstanceKey(provider.id, 'sk-director-secret');
			const models = await modelResolverService.refreshModels(providerWithBase);
			await registryService.saveProvider({ ...providerWithBase, models });
			const snapshot = await snapshotService.writeSnapshot();
			const registryText = JSON.stringify(await readJson(getDirectorProviderRegistryResourceFromGlobalStorageHome(userDataProfileService.currentProfile.globalStorageHome)));
			const snapshotText = JSON.stringify(await readJson(getDirectorProviderSnapshotResourceFromGlobalStorageHome(userDataProfileService.currentProfile.globalStorageHome)));

			assert.deepStrictEqual({
				requestedUrl,
				requestedAuth,
				models: models.map(model => ({ id: model.id, providerModelId: model.providerModelId })),
				snapshotModels: snapshot.models.map(model => ({
					providerModelId: model.providerModelId,
					maxContextWindow: model.maxContextWindow,
					maxOutputTokens: model.maxOutputTokens,
				})),
				registryLeaksKey: registryText.includes('sk-director-secret'),
				snapshotLeaksKey: snapshotText.includes('sk-director-secret'),
			}, {
				requestedUrl: '/models',
				requestedAuth: 'Bearer sk-director-secret',
				models: [
					{ id: 'deepseek:deepseek-chat', providerModelId: 'deepseek-chat' },
					{ id: 'deepseek:deepseek-reasoner', providerModelId: 'deepseek-reasoner' },
				],
				snapshotModels: [
					{ providerModelId: 'deepseek-chat', maxContextWindow: 128000, maxOutputTokens: 8192 },
					{ providerModelId: 'deepseek-reasoner', maxContextWindow: 128000, maxOutputTokens: 8192 },
				],
				registryLeaksKey: false,
				snapshotLeaksKey: false,
			});
		} finally {
			await server.close();
		}
	});

	test('refreshModels requires credentials and does not fall back to default compatible models', async () => {
		const provider = createDirectorProviderInstance({
			id: 'compatible',
			kind: 'openai-compatible',
			displayName: 'Compatible',
			authKind: 'api-key',
			apiType: 'openai-completions',
			baseURL: 'https://example.invalid',
			modelId: 'placeholder',
		});

		await assert.rejects(
			() => modelResolverService.refreshModels(provider),
			/needs a saved credential/
		);
	});

	test('refreshModels redacts credentials from provider error responses', async () => {
		const provider = createDirectorProviderInstance({
			id: 'redacted',
			kind: 'openai-compatible',
			displayName: 'Redacted',
			authKind: 'api-key',
			apiType: 'openai-completions',
			modelId: 'placeholder',
		});
		const server = await startModelServer((_req, res) => {
			res.writeHead(401, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'invalid key sk-director-secret' }));
		});
		try {
			await apiKeyService.setProviderInstanceKey(provider.id, 'sk-director-secret');
			await assert.rejects(
				() => modelResolverService.refreshModels({ ...provider, baseURL: server.baseURL }),
				(err: unknown) => {
					assert.ok(err instanceof Error);
					assert.ok(!err.message.includes('sk-director-secret'), err.message);
					assert.ok(err.message.includes('<redacted>'), err.message);
					return true;
				}
			);
		} finally {
			await server.close();
		}
	});

	async function readJson(resource: URI): Promise<unknown> {
		return JSON.parse((await fileService.readFile(resource)).value.toString());
	}

	async function startModelServer(handler: (req: import('http').IncomingMessage, res: import('http').ServerResponse) => void): Promise<{ readonly baseURL: string; readonly close: () => Promise<void> }> {
		const { createServer } = await import('http');
		const server = createServer(handler);
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => {
				server.off('error', reject);
				resolve();
			});
		});
		const address = server.address();
		assert.ok(address && typeof address !== 'string');
		return {
			baseURL: `http://127.0.0.1:${address.port}`,
			close: () => closeServer(server),
		};
	}

	async function closeServer(server: import('http').Server): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			server.closeAllConnections();
			server.close(err => err ? reject(err) : resolve());
		});
		await new Promise(resolve => setTimeout(resolve, 50));
	}
});
