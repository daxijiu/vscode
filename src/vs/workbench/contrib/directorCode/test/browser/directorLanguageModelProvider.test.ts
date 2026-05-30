/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { DirectorProviderAuthState, DirectorProviderSnapshotModel } from '../../../../../platform/agentHost/common/directorProviderSnapshot.js';
import type { DirectorRuntimeCredential, DirectorRuntimeCredentialRequest, IDirectorRuntimeCredentialService } from '../../../../../platform/agentHost/common/directorRuntimeCredentials.js';
import { syncDirectorLanguageModelConfigurationGroup } from '../../browser/directorLanguageModel/directorLanguageModelGroupSync.js';
import { DirectorLanguageModelProvider } from '../../browser/directorLanguageModel/directorLanguageModelProvider.js';
import { ChatMessageRole, type IChatResponsePart } from '../../../chat/common/languageModels.js';
import type { ConfigureLanguageModelsOptions, ILanguageModelsConfigurationService, ILanguageModelsProviderGroup } from '../../../chat/common/languageModelsConfiguration.js';
import { IDirectorApiKeyService, IDirectorModelResolverService, IDirectorOAuthService, IDirectorProviderRegistryService, type DirectorProviderRegistryState, type DirectorStoredProviderInstance } from '../../common/provider/directorProviderServices.js';

suite('DirectorLanguageModelProvider', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('projects enabled Director providers into direct language model metadata', async () => {
		const provider = createProvider();
		const model = createModel(provider.id);
		const languageModelProvider = disposables.add(new DirectorLanguageModelProvider(
			new TestRegistryService([provider], { defaultProviderId: provider.id, defaultModelId: model.id }),
			new TestModelResolverService([model]),
			new TestApiKeyService(),
			new TestOAuthService(),
			new TestRuntimeCredentialService(),
		));

		const infos = await languageModelProvider.provideLanguageModelChatInfo({ silent: true }, CancellationToken.None);

		assert.deepStrictEqual(infos.map(info => ({
			identifier: info.identifier,
			name: info.metadata.name,
			id: info.metadata.id,
			vendor: info.metadata.vendor,
			detail: info.metadata.detail,
			family: info.metadata.family,
			maxInputTokens: info.metadata.maxInputTokens,
			maxOutputTokens: info.metadata.maxOutputTokens,
			auth: info.metadata.auth,
			capabilities: info.metadata.capabilities,
		})), [{
			identifier: 'director-code/deepseek/deepseek%3Adeepseek-chat',
			name: 'DeepSeek Chat',
			id: 'deepseek-chat',
			vendor: 'director-code',
			detail: 'DeepSeek',
			family: 'deepseek',
			maxInputTokens: 64000,
			maxOutputTokens: 8192,
			auth: undefined,
			capabilities: { vision: false, toolCalling: true, agentMode: true },
		}]);
	});

	test('sends direct BYOK requests with tools and returns tool use parts', async () => {
		const provider = createProvider();
		const model = createModel(provider.id);
		const credentialService = new TestRuntimeCredentialService();
		const requests: Array<{ readonly input: RequestInfo | URL; readonly init?: RequestInit; readonly body: Record<string, unknown>; readonly headers: Headers }> = [];
		const fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = async (input, init) => {
			requests.push({
				input,
				init,
				body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
				headers: new Headers(init?.headers as HeadersInit),
			});
			return new Response(JSON.stringify({
				choices: [{
					message: {
						content: '',
						tool_calls: [{
							id: 'call_1',
							type: 'function',
							function: {
								name: 'grep_search',
								arguments: JSON.stringify({ pattern: 'xiaoxiao', include_pattern: '*.md', path: 'e:\\DAD' }),
							},
						}],
					},
				}],
				usage: { prompt_tokens: 10, completion_tokens: 2 },
			}), { status: 200, headers: { 'content-type': 'application/json' } });
		};
		const languageModelProvider = disposables.add(new DirectorLanguageModelProvider(
			new TestRegistryService([provider], { defaultProviderId: provider.id, defaultModelId: model.id }),
			new TestModelResolverService([model]),
			new TestApiKeyService(),
			new TestOAuthService(),
			credentialService,
			fetch,
		));

		const response = await languageModelProvider.sendChatRequest(
			'director-code/deepseek/deepseek%3Adeepseek-chat',
			[{ role: ChatMessageRole.User, content: [{ type: 'text', value: 'hello' }] }],
			undefined,
			{
				tools: [{
					name: 'grep_search',
					description: 'Search text in files',
					inputSchema: {
						type: 'object',
						properties: {
							pattern: { type: 'string' },
							path: { type: 'string' },
						},
					},
				}],
			},
			CancellationToken.None,
		);
		const parts: IChatResponsePart[] = [];
		for await (const part of response.stream) {
			if (Array.isArray(part)) {
				parts.push(...part);
			} else {
				parts.push(part);
			}
		}
		const usage = await response.result;

		assert.deepStrictEqual({
			requestUrl: requests[0].input,
			authorization: requests[0].headers.get('authorization'),
			toolName: ((requests[0].body.tools as Array<{ function: { name: string } }>)[0]).function.name,
			toolChoice: requests[0].body.tool_choice,
			messages: requests[0].body.messages,
			credentialRequests: credentialService.requests,
			parts,
			usage,
		}, {
			requestUrl: 'https://api.deepseek.com/v1/chat/completions',
			authorization: 'Bearer sk-test',
			toolName: 'grep_search',
			toolChoice: 'auto',
			messages: [{ role: 'user', content: 'hello' }],
			credentialRequests: [{ providerInstanceId: 'deepseek', authKind: 'api-key', authStateKind: 'ready' }],
			parts: [{
				type: 'tool_use',
				name: 'grep_search',
				toolCallId: 'call_1',
				parameters: { pattern: 'xiaoxiao', include_pattern: '*.md', path: 'e:\\DAD' },
			}],
			usage: { input_tokens: 10, output_tokens: 2 },
		});
	});

	test('syncs a non-secret Director language model provider group for BYOK setup detection', async () => {
		const provider = createProvider();
		const registry = new TestRegistryService([provider], { defaultProviderId: provider.id, defaultModelId: provider.defaultModelId });
		const languageModelsConfiguration = new TestLanguageModelsConfigurationService();

		await syncDirectorLanguageModelConfigurationGroup(registry, languageModelsConfiguration);

		assert.deepStrictEqual(languageModelsConfiguration.groups, [{
			vendor: 'director-code',
			name: 'Director Code',
			directorManaged: true,
		}]);
	});

	test('removes only the managed Director language model provider group when no provider is enabled', async () => {
		const disabledProvider = { ...createProvider(), enabled: false };
		const registry = new TestRegistryService([disabledProvider], { defaultProviderId: disabledProvider.id, defaultModelId: disabledProvider.defaultModelId });
		const languageModelsConfiguration = new TestLanguageModelsConfigurationService([
			{ vendor: 'director-code', name: 'Director Code', directorManaged: true },
			{ vendor: 'director-code', name: 'Custom Director Group' },
			{ vendor: 'openai', name: 'OpenAI' },
		]);

		await syncDirectorLanguageModelConfigurationGroup(registry, languageModelsConfiguration);

		assert.deepStrictEqual(languageModelsConfiguration.groups, [
			{ vendor: 'director-code', name: 'Custom Director Group' },
			{ vendor: 'openai', name: 'OpenAI' },
		]);
	});
});

function createProvider(): DirectorStoredProviderInstance {
	return {
		id: 'deepseek',
		kind: 'openai-compatible',
		displayName: 'DeepSeek',
		enabled: true,
		authKind: 'api-key',
		apiType: 'openai-completions',
		baseURL: 'https://api.deepseek.com/v1',
		defaultModelId: 'deepseek:deepseek-chat',
		createdAt: 1,
		updatedAt: 1,
	};
}

function createModel(providerInstanceId: string): DirectorProviderSnapshotModel {
	return {
		providerInstanceId,
		id: `${providerInstanceId}:deepseek-chat`,
		providerModelId: 'deepseek-chat',
		name: 'DeepSeek Chat',
		family: 'deepseek',
		maxContextWindow: 64000,
		maxOutputTokens: 8192,
		supportsVision: false,
		apiType: 'openai-completions',
		providerDisplayName: 'DeepSeek',
		capabilities: { streaming: true, toolCalling: true, agentMode: true, vision: false },
	};
}

class TestRegistryService implements IDirectorProviderRegistryService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeProviders = Event.None;

	constructor(
		private readonly providers: readonly DirectorStoredProviderInstance[],
		private readonly defaults: Pick<DirectorProviderRegistryState, 'defaultProviderId' | 'defaultModelId'>,
	) { }

	listProviders(): Promise<readonly DirectorStoredProviderInstance[]> {
		return Promise.resolve(this.providers);
	}

	getProvider(id: string): Promise<DirectorStoredProviderInstance | undefined> {
		return Promise.resolve(this.providers.find(provider => provider.id === id));
	}

	saveProvider(_provider: DirectorStoredProviderInstance): Promise<void> {
		throw new Error('Not implemented in test');
	}

	removeProvider(_id: string): Promise<void> {
		throw new Error('Not implemented in test');
	}

	setDefaults(_providerId: string | undefined, _modelId: string | undefined): Promise<void> {
		throw new Error('Not implemented in test');
	}

	getState(): Promise<DirectorProviderRegistryState> {
		return Promise.resolve({ version: 1, instances: this.providers, ...this.defaults });
	}
}

class TestModelResolverService implements IDirectorModelResolverService {
	declare readonly _serviceBrand: undefined;

	constructor(private readonly models: readonly DirectorProviderSnapshotModel[]) { }

	resolveModels(provider: DirectorStoredProviderInstance): Promise<readonly DirectorProviderSnapshotModel[]> {
		return Promise.resolve(this.models.filter(model => model.providerInstanceId === provider.id));
	}

	refreshModels(): Promise<never> {
		throw new Error('Not implemented in test');
	}
}

class TestLanguageModelsConfigurationService implements ILanguageModelsConfigurationService {
	declare readonly _serviceBrand: undefined;
	readonly configurationFile = undefined as unknown as never;
	readonly onDidChangeLanguageModelGroups = Event.None;

	constructor(public groups: ILanguageModelsProviderGroup[] = []) { }

	getLanguageModelsProviderGroups(): readonly ILanguageModelsProviderGroup[] {
		return this.groups;
	}

	addLanguageModelsProviderGroup(languageModelsProviderGroup: ILanguageModelsProviderGroup): Promise<ILanguageModelsProviderGroup> {
		this.groups.push(languageModelsProviderGroup);
		return Promise.resolve(languageModelsProviderGroup);
	}

	updateLanguageModelsProviderGroup(_from: ILanguageModelsProviderGroup, _to: ILanguageModelsProviderGroup): Promise<ILanguageModelsProviderGroup> {
		throw new Error('Not implemented in test');
	}

	removeLanguageModelsProviderGroup(languageModelGroup: ILanguageModelsProviderGroup): Promise<void> {
		this.groups = this.groups.filter(group => group !== languageModelGroup);
		return Promise.resolve();
	}

	configureLanguageModels(_options?: ConfigureLanguageModelsOptions): Promise<void> {
		throw new Error('Not implemented in test');
	}
}

class TestApiKeyService implements IDirectorApiKeyService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeAuth = Event.None;

	hasProviderInstanceKey(): Promise<boolean> { return Promise.resolve(true); }
	getProviderInstanceKey(): Promise<string | undefined> { return Promise.resolve(undefined); }
	setProviderInstanceKey(): Promise<void> { return Promise.resolve(); }
	deleteProviderInstanceKey(): Promise<void> { return Promise.resolve(); }
	getAuthState(): Promise<DirectorProviderAuthState> { return Promise.resolve({ kind: 'ready' }); }
}

class TestOAuthService implements IDirectorOAuthService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeAuth = Event.None;

	signInOpenAICodex(): Promise<void> { return Promise.resolve(); }
	signOutOpenAICodex(): Promise<void> { return Promise.resolve(); }
	getOpenAICodexAccessToken(): Promise<string | undefined> { return Promise.resolve(undefined); }
	getAuthState(): Promise<DirectorProviderAuthState> { return Promise.resolve({ kind: 'signedOut' }); }
}

class TestRuntimeCredentialService implements IDirectorRuntimeCredentialService {
	declare readonly _serviceBrand: undefined;
	readonly requests: DirectorRuntimeCredentialRequest[] = [];

	constructor(private readonly credential: DirectorRuntimeCredential = { kind: 'api-key', value: 'sk-test' }) { }

	resolveCredential(request: DirectorRuntimeCredentialRequest): Promise<DirectorRuntimeCredential> {
		this.requests.push(request);
		return Promise.resolve(this.credential);
	}
}
