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
import { toUserDataProfile } from '../../../../../../platform/userDataProfile/common/userDataProfile.js';
import { IUserDataProfileService } from '../../../../../services/userDataProfile/common/userDataProfile.js';
import { createDirectorProviderInstance, DirectorApiKeyService, DirectorModelResolverService, DirectorOAuthService, DirectorProviderRegistryService, DirectorProviderSnapshotService } from '../../../common/provider/directorProviderServices.js';
import { getDirectorProviderRegistryResourceFromGlobalStorageHome, getDirectorProviderSnapshotResourceFromGlobalStorageHome } from '../../../../../../platform/agentHost/common/directorProviderSnapshot.js';

suite('directorProviderServices', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let fileService: IFileService;
	let secretStorageService: TestSecretStorageService;
	let userDataProfileService: IUserDataProfileService;
	let registryService: DirectorProviderRegistryService;
	let apiKeyService: DirectorApiKeyService;
	let oauthService: DirectorOAuthService;
	let snapshotService: DirectorProviderSnapshotService;

	setup(() => {
		const logService = new NullLogService();
		fileService = disposables.add(new FileService(logService));
		disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new InMemoryFileSystemProvider())));
		secretStorageService = disposables.add(new TestSecretStorageService());
		const currentProfile = toUserDataProfile('director-test', 'Director Test', URI.file('/director-test/User'), URI.file('/director-test/cache'));
		userDataProfileService = {
			_serviceBrand: undefined,
			currentProfile,
			onDidChangeCurrentProfile: Event.None,
			updateCurrentProfile: async () => { },
		};

		registryService = disposables.add(new DirectorProviderRegistryService(fileService, userDataProfileService, logService));
		apiKeyService = disposables.add(new DirectorApiKeyService(secretStorageService));
		oauthService = disposables.add(new DirectorOAuthService(secretStorageService));
		const modelResolverService = new DirectorModelResolverService();
		snapshotService = disposables.add(new DirectorProviderSnapshotService(
			registryService,
			apiKeyService,
			oauthService,
			modelResolverService,
			fileService,
			userDataProfileService,
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
				'x-director-trace': 'safe-metadata',
			},
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
			hasSensitiveHeaderValue: registryText.includes('should-not-persist'),
		}, {
			providerIds: ['my-provider'],
			defaultProviderId: 'my-provider',
			defaultModelId: 'my-provider:gpt-test',
			headers: { 'x-director-trace': 'safe-metadata' },
			hasSensitiveHeaderValue: false,
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
		const readySnapshot = await snapshotService.writeSnapshot();
		await oauthService.signOutOpenAICodex(provider.id);
		const signedOutSnapshot = await snapshotService.writeSnapshot();
		const snapshotText = JSON.stringify(await readJson(getDirectorProviderSnapshotResourceFromGlobalStorageHome(userDataProfileService.currentProfile.globalStorageHome)));

		assert.deepStrictEqual({
			readyAuthState: readySnapshot.providers[0].authState.kind,
			signedOutAuthState: signedOutSnapshot.providers[0].authState.kind,
			leaksFakeToken: snapshotText.includes('director-code-fake-openai-codex-token'),
		}, {
			readyAuthState: 'ready',
			signedOutAuthState: 'signedOut',
			leaksFakeToken: false,
		});
	});

	async function readJson(resource: URI): Promise<unknown> {
		return JSON.parse((await fileService.readFile(resource)).value.toString());
	}
});
