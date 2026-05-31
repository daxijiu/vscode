/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Schemas } from '../../../../base/common/network.js';
import { dirname } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { FileService } from '../../../files/common/fileService.js';
import { IFileService } from '../../../files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../files/common/inMemoryFilesystemProvider.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { NullLogService } from '../../../log/common/log.js';
import { DirectorAgentProviderId, findDefaultModel, isResolvedBackend, toAgentModelInfo } from '../../common/directorProviderBackend.js';
import { DirectorProviderSnapshotVersion, getDirectorProviderSnapshotResource } from '../../common/directorProviderSnapshot.js';
import { DirectorProviderBackendHub } from '../../node/director/directorProviderBackendHub.js';

suite('directorProviderBackend', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('lists deterministic fake providers and models', async () => {
		const hub = new DirectorProviderBackendHub();
		const providers = await hub.listProviderInstances();
		const models = await hub.listModels();

		assert.deepStrictEqual({
			providers: providers.map(provider => ({
				id: provider.id,
				kind: provider.kind,
				enabled: provider.enabled,
				authKind: provider.authKind,
				defaultModelId: provider.defaultModelId,
			})),
			models: models.map(model => ({
				providerInstanceId: model.providerInstanceId,
				id: model.id,
				name: model.name,
			})),
		}, {
			providers: [
				{ id: 'director-fake', kind: 'local', enabled: true, authKind: 'none', defaultModelId: 'echo' },
				{ id: 'director-disabled', kind: 'local', enabled: false, authKind: 'none', defaultModelId: 'disabled-model' },
				{ id: 'director-missing-key', kind: 'openai-compatible', enabled: true, authKind: 'api-key', defaultModelId: 'needs-key' },
			],
			models: [
				{ providerInstanceId: 'director-fake', id: 'echo', name: 'Director Echo' },
				{ providerInstanceId: 'director-fake', id: 'echo-large', name: 'Director Echo Large' },
				{ providerInstanceId: 'director-disabled', id: 'disabled-model', name: 'Director Disabled Model' },
				{ providerInstanceId: 'director-missing-key', id: 'needs-key', name: 'Director Needs Key' },
			],
		});
	});

	test('filters models and finds defaults without mutating inputs', async () => {
		const hub = new DirectorProviderBackendHub();
		const fakeModels = await hub.listModels('director-fake');
		const explicit = findDefaultModel(fakeModels, 'director-fake', 'echo-large');
		const fallback = findDefaultModel(fakeModels, 'director-fake');

		assert.deepStrictEqual({
			filteredModelIds: fakeModels.map(model => model.id),
			explicitModelId: explicit?.id,
			fallbackModelId: fallback?.id,
		}, {
			filteredModelIds: ['echo', 'echo-large'],
			explicitModelId: 'echo-large',
			fallbackModelId: 'echo',
		});
	});

	test('resolves default and explicit fake backends', async () => {
		const hub = new DirectorProviderBackendHub();
		const defaultResult = await hub.resolveBackend();
		const explicitResult = await hub.resolveBackend({ providerInstanceId: 'director-fake', modelId: 'echo-large' });

		assert.ok(isResolvedBackend(defaultResult));
		assert.ok(isResolvedBackend(explicitResult));
		assert.deepStrictEqual({
			defaultBackend: {
				providerInstanceId: defaultResult.backend.providerInstanceId,
				providerKind: defaultResult.backend.providerKind,
				authKind: defaultResult.backend.authKind,
				apiType: defaultResult.backend.apiType,
				modelId: defaultResult.backend.modelId,
				agentModelId: defaultResult.backend.agentModelId,
				authState: defaultResult.backend.authState.kind,
				identityKey: defaultResult.backend.identityKey,
			},
			explicitBackend: {
				providerInstanceId: explicitResult.backend.providerInstanceId,
				modelId: explicitResult.backend.modelId,
				identityKey: explicitResult.backend.identityKey,
			},
		}, {
			defaultBackend: {
				providerInstanceId: 'director-fake',
				providerKind: 'local',
				authKind: 'none',
				apiType: 'local',
				modelId: 'echo',
				agentModelId: 'echo',
				authState: 'none',
				identityKey: 'director-fake/echo',
			},
			explicitBackend: {
				providerInstanceId: 'director-fake',
				modelId: 'echo-large',
				identityKey: 'director-fake/echo-large',
			},
		});
	});

	test('returns expected resolution failures', async () => {
		const hub = new DirectorProviderBackendHub();
		const disabled = await hub.resolveBackend({ providerInstanceId: 'director-disabled' });
		const unknownModel = await hub.resolveBackend({ providerInstanceId: 'director-fake', modelId: 'missing-model' });
		const missingAuth = await hub.resolveBackend({ providerInstanceId: 'director-missing-key' });
		const unknownProvider = await hub.resolveBackend({ providerInstanceId: 'director-unknown' });

		assert.deepStrictEqual({
			disabled,
			unknownModel,
			missingAuth,
			unknownProvider,
		}, {
			disabled: {
				status: 'disabled',
				providerInstanceId: 'director-disabled',
				message: 'Selected Director provider is disabled.',
			},
			unknownModel: {
				status: 'modelUnavailable',
				providerInstanceId: 'director-fake',
				modelId: 'missing-model',
				message: 'Selected Director model is not available.',
			},
			missingAuth: {
				status: 'missingAuth',
				providerInstanceId: 'director-missing-key',
				message: 'Selected Director provider requires api-key credentials.',
			},
			unknownProvider: {
				status: 'error',
				message: 'Selected Director provider is not registered.',
			},
		});
	});

	test('converts Director models to AgentHost model info', async () => {
		const hub = new DirectorProviderBackendHub();
		const [model] = await hub.listModels('director-fake');
		const modelInfo = toAgentModelInfo(DirectorAgentProviderId, model);

		assert.deepStrictEqual(modelInfo, {
			provider: 'director',
			id: 'echo',
			name: 'Director Echo',
			maxContextWindow: 8192,
			supportsVision: false,
			_meta: {
				providerInstanceId: 'director-fake',
				backendModelId: 'echo',
				family: 'echo',
				capabilities: { streaming: true, toolCalling: false, agentMode: true },
			},
		});
	});

	test('keeps AgentHost model ids distinct from provider wire model ids', async () => {
		const hub = new DirectorProviderBackendHub({
			providerInstances: [{
				id: 'openai-compatible',
				kind: 'openai-compatible',
				displayName: 'OpenAI Compatible',
				enabled: true,
				authKind: 'none',
				apiType: 'openai-completions',
				defaultModelId: 'openai-compatible:gpt-4.1',
			}],
			models: [{
				providerInstanceId: 'openai-compatible',
				id: 'openai-compatible:gpt-4.1',
				providerModelId: 'gpt-4.1',
				name: 'GPT-4.1',
				family: 'gpt-4.1',
				version: '2026-05-27',
				maxContextWindow: 128000,
				maxOutputTokens: 16384,
				supportsVision: false,
				apiType: 'openai-completions',
				providerDisplayName: 'OpenAI Compatible',
				capabilities: { streaming: true, toolCalling: true, vision: false, agentMode: true },
			}],
		});
		const [model] = await hub.listModels('openai-compatible');
		const resolved = await hub.resolveBackend({ providerInstanceId: 'openai-compatible', modelId: 'openai-compatible:gpt-4.1' });

		assert.ok(isResolvedBackend(resolved));
		const modelInfo = toAgentModelInfo(DirectorAgentProviderId, model);
		assert.deepStrictEqual({
			agentModelId: modelInfo.id,
			backendModelId: (modelInfo._meta ?? {}).backendModelId,
			providerDisplayName: (modelInfo._meta ?? {}).providerDisplayName,
			apiType: (modelInfo._meta ?? {}).apiType,
			family: (modelInfo._meta ?? {}).family,
			version: (modelInfo._meta ?? {}).version,
			maxInputTokens: modelInfo.maxContextWindow,
			maxOutputTokens: (modelInfo._meta ?? {}).maxOutputTokens,
			capabilities: (modelInfo._meta ?? {}).capabilities,
			resolvedAgentModelId: resolved.backend.agentModelId,
			resolvedModelId: resolved.backend.modelId,
		}, {
			agentModelId: 'openai-compatible:gpt-4.1',
			backendModelId: 'gpt-4.1',
			providerDisplayName: 'OpenAI Compatible',
			apiType: 'openai-completions',
			family: 'gpt-4.1',
			version: '2026-05-27',
			maxInputTokens: 128000,
			maxOutputTokens: 16384,
			capabilities: { streaming: true, toolCalling: true, vision: false, agentMode: true },
			resolvedAgentModelId: 'openai-compatible:gpt-4.1',
			resolvedModelId: 'gpt-4.1',
		});
	});

	test('infers provider from globally unique model id and honors global default model first', async () => {
		const hub = new DirectorProviderBackendHub({
			defaultProviderId: 'provider-a',
			defaultModelId: 'provider-a:gpt-4.1-mini',
			providerInstances: [
				{
					id: 'provider-a',
					kind: 'openai-compatible',
					displayName: 'Provider A',
					enabled: true,
					authKind: 'none',
					apiType: 'openai-completions',
					defaultModelId: 'provider-a:gpt-4.1',
				},
				{
					id: 'provider-b',
					kind: 'anthropic-compatible',
					displayName: 'Provider B',
					enabled: true,
					authKind: 'none',
					apiType: 'anthropic-messages',
					defaultModelId: 'provider-b:claude-sonnet-4.5',
				},
			],
			models: [
				{ providerInstanceId: 'provider-a', id: 'provider-a:gpt-4.1', providerModelId: 'gpt-4.1', name: 'GPT-4.1', supportsVision: false },
				{ providerInstanceId: 'provider-a', id: 'provider-a:gpt-4.1-mini', providerModelId: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsVision: false },
				{ providerInstanceId: 'provider-b', id: 'provider-b:claude-sonnet-4.5', providerModelId: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', supportsVision: false },
			],
		});
		const defaultProviderA = await hub.resolveBackend();
		const explicitProviderB = await hub.resolveBackend({ modelId: 'provider-b:claude-sonnet-4.5' });

		assert.ok(isResolvedBackend(defaultProviderA));
		assert.ok(isResolvedBackend(explicitProviderB));
		assert.deepStrictEqual({
			defaultAgentModelId: defaultProviderA.backend.agentModelId,
			defaultModelId: defaultProviderA.backend.modelId,
			providerInstanceId: explicitProviderB.backend.providerInstanceId,
			agentModelId: explicitProviderB.backend.agentModelId,
			modelId: explicitProviderB.backend.modelId,
		}, {
			defaultAgentModelId: 'provider-a:gpt-4.1-mini',
			defaultModelId: 'gpt-4.1-mini',
			providerInstanceId: 'provider-b',
			agentModelId: 'provider-b:claude-sonnet-4.5',
			modelId: 'claude-sonnet-4.5',
		});
	});

	test('loads a file-backed secret-free provider snapshot', async () => {
		const logService = new NullLogService();
		const fileService: IFileService = new FileService(logService);
		disposables.add(fileService);
		disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new InMemoryFileSystemProvider())));
		const appSettingsHome = URI.file('/director/User');
		const resource = getDirectorProviderSnapshotResource(appSettingsHome);
		await fileService.createFolder(dirname(resource));
		await fileService.writeFile(resource, VSBuffer.fromString(JSON.stringify({
			version: DirectorProviderSnapshotVersion,
			updatedAt: 1,
			defaultProviderId: 'snapshot-provider',
			defaultModelId: 'snapshot-provider:gpt-test',
			providers: [{
				id: 'snapshot-provider',
				kind: 'openai-compatible',
				displayName: 'Snapshot Provider',
				enabled: true,
				authKind: 'api-key',
				apiType: 'openai-completions',
				baseURL: 'https://example.test/v1',
				headers: {
					authorization: 'Bearer should-not-surface',
					'x-director-trace': 'safe',
				},
				defaultModelId: 'snapshot-provider:gpt-test',
				authState: { kind: 'ready', identityKey: 'api-key:snapshot-provider' },
			}],
			models: [{
				providerInstanceId: 'snapshot-provider',
				id: 'snapshot-provider:gpt-test',
				providerModelId: 'gpt-test',
				name: 'GPT Test',
				supportsVision: false,
				apiType: 'openai-completions',
			}],
		})));

		const hub = new DirectorProviderBackendHub({}, fileService, { appSettingsHome } as Partial<INativeEnvironmentService> as INativeEnvironmentService, logService);
		const providers = await hub.listProviderInstances();
		const models = await hub.listModels();
		const resolved = await hub.resolveBackend();

		assert.ok(isResolvedBackend(resolved));
		assert.deepStrictEqual({
			providerIds: providers.map(provider => provider.id),
			modelIds: models.map(model => model.id),
			headers: providers[0].headers,
			resolvedHeaders: resolved.backend.headers,
			resolvedModelId: resolved.backend.modelId,
		}, {
			providerIds: ['snapshot-provider'],
			modelIds: ['snapshot-provider:gpt-test'],
			headers: { 'x-director-trace': 'safe' },
			resolvedHeaders: { 'x-director-trace': 'safe' },
			resolvedModelId: 'gpt-test',
		});
	});
});
