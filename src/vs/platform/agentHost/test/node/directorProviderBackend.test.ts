/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { DirectorAgentProviderId, findDefaultModel, isResolvedBackend, toAgentModelInfo } from '../../common/directorProviderBackend.js';
import { DirectorProviderBackendHub } from '../../node/director/directorProviderBackendHub.js';

suite('directorProviderBackend', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

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
				apiType: defaultResult.backend.apiType,
				modelId: defaultResult.backend.modelId,
				authKind: defaultResult.backend.auth.kind,
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
				apiType: 'local',
				modelId: 'echo',
				authKind: 'none',
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
				message: 'Director provider \'director-disabled\' is disabled.',
			},
			unknownModel: {
				status: 'modelUnavailable',
				providerInstanceId: 'director-fake',
				modelId: 'missing-model',
				message: 'Director model \'missing-model\' is not available for provider \'director-fake\'.',
			},
			missingAuth: {
				status: 'missingAuth',
				providerInstanceId: 'director-missing-key',
				message: 'Director provider \'director-missing-key\' requires api-key credentials.',
			},
			unknownProvider: {
				status: 'error',
				message: 'Director provider \'director-unknown\' is not registered.',
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
});
