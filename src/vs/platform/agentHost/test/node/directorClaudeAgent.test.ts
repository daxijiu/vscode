/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { GetSessionMessagesOptions, GetSubagentMessagesOptions, ListSessionsOptions, ListSubagentsOptions, McpSdkServerConfigWithInstance, Options, PermissionMode, Query, SDKMessage, SDKSessionInfo, SDKUserMessage, SdkMcpToolDefinition, SessionMessage, Settings, WarmQuery } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import assert from 'assert';
import type { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ServiceCollection } from '../../../instantiation/common/serviceCollection.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { IInstantiationService } from '../../../instantiation/common/instantiation.js';
import { ILogService, NullLogService } from '../../../log/common/log.js';
import { IAgentPluginManager, ISyncedCustomization } from '../../common/agentPluginManager.js';
import { AgentSession } from '../../common/agentService.js';
import { IDirectorProviderBackendHub } from '../../common/directorProviderBackend.js';
import { DirectorRuntimeCredential, DirectorRuntimeCredentialRequest, IDirectorRuntimeCredentialService } from '../../common/directorRuntimeCredentials.js';
import { ISessionDataService } from '../../common/sessionDataService.js';
import { ClientPluginCustomization, Customization } from '../../common/state/sessionState.js';
import { IAgentConfigurationService, AgentConfigurationService } from '../../node/agentConfigurationService.js';
import { AgentHostStateManager } from '../../node/agentHostStateManager.js';
import { IAgentHostGitService } from '../../node/agentHostGitService.js';
import { IClaudeAgentSdkService } from '../../node/claude/claudeAgentSdkService.js';
import { DirectorClaudeAgent } from '../../node/director/directorClaudeAgent.js';
import { DirectorAnthropicEndpointStartOptions, IDirectorAnthropicEndpointHandle, IDirectorAnthropicEndpointService } from '../../node/director/directorAnthropicEndpointService.js';
import { DirectorProviderBackendHub, DirectorProviderBackendHubFixtures } from '../../node/director/directorProviderBackendHub.js';
import { makeResultSuccess } from './claudeMapSessionEventsTestUtils.js';
import { createNoopGitService, createSessionDataService } from '../common/sessionTestHelpers.js';

class FakeAgentPluginManager implements IAgentPluginManager {
	declare readonly _serviceBrand: undefined;
	readonly basePath = URI.from({ scheme: 'inmemory', path: '/agentPlugins' });
	async syncCustomizations(_clientId: string, _customizations: ClientPluginCustomization[], _progress?: (status: Customization) => void): Promise<ISyncedCustomization[]> {
		return [];
	}
}

class FakeCredentialService implements IDirectorRuntimeCredentialService {
	declare readonly _serviceBrand: undefined;
	credential: DirectorRuntimeCredential = { kind: 'none' };
	resolveCredential(_request: DirectorRuntimeCredentialRequest): Promise<DirectorRuntimeCredential> {
		return Promise.resolve(this.credential);
	}
}

class FakeDirectorAnthropicEndpointService implements IDirectorAnthropicEndpointService {
	declare readonly _serviceBrand: undefined;
	readonly starts: DirectorAnthropicEndpointStartOptions[] = [];
	readonly disposeEvents: string[];
	baseUrl = 'http://127.0.0.1:43210';
	nonce = 'director-nonce';

	constructor(disposeEvents: string[] = []) {
		this.disposeEvents = disposeEvents;
	}

	async start(options: DirectorAnthropicEndpointStartOptions = {}): Promise<IDirectorAnthropicEndpointHandle> {
		this.starts.push(options);
		return {
			baseUrl: this.baseUrl,
			nonce: this.nonce,
			dispose: () => this.disposeEvents.push('endpoint'),
		};
	}

	dispose(): void { }
}

class FakeClaudeAgentSdkService implements IClaudeAgentSdkService {
	declare readonly _serviceBrand: undefined;
	readonly capturedStartupOptions: Options[] = [];
	readonly warmQueries: FakeWarmQuery[] = [];
	readonly disposeEvents: string[];

	constructor(disposeEvents: string[]) {
		this.disposeEvents = disposeEvents;
	}

	listSessions(_options?: ListSessionsOptions): Promise<SDKSessionInfo[]> {
		return Promise.resolve([]);
	}

	getSessionInfo(_sessionId: string): Promise<SDKSessionInfo | undefined> {
		return Promise.resolve(undefined);
	}

	startup(params: { options: Options; initializeTimeoutMs?: number }): Promise<WarmQuery> {
		this.capturedStartupOptions.push(params.options);
		const warm = new FakeWarmQuery(this);
		this.warmQueries.push(warm);
		return Promise.resolve(warm);
	}

	getSessionMessages(_sessionId: string, _options?: GetSessionMessagesOptions): Promise<SessionMessage[]> {
		return Promise.resolve([]);
	}

	listSubagents(_sessionId: string, _options?: ListSubagentsOptions): Promise<string[]> {
		return Promise.resolve([]);
	}

	getSubagentMessages(_sessionId: string, _agentId: string, _options?: GetSubagentMessagesOptions): Promise<SessionMessage[]> {
		return Promise.resolve([]);
	}

	createSdkMcpServer(options: { name: string; tools?: Array<SdkMcpToolDefinition<any>> }): Promise<McpSdkServerConfigWithInstance> {
		return Promise.resolve({ type: 'sdk', name: options.name, instance: {} } as unknown as McpSdkServerConfigWithInstance);
	}

	tool(name: string, _description: string, _inputSchema: Record<string, any>, _handler: (args: any, extra: unknown) => Promise<CallToolResult>): Promise<SdkMcpToolDefinition<any>> {
		return Promise.resolve({ name } as unknown as SdkMcpToolDefinition<any>);
	}
}

class FakeWarmQuery implements WarmQuery {
	queryCallCount = 0;
	asyncDisposeCount = 0;
	produced: FakeQuery | undefined;

	constructor(private readonly _sdk: FakeClaudeAgentSdkService) { }

	query(prompt: string | AsyncIterable<SDKUserMessage>): Query {
		this.queryCallCount++;
		if (typeof prompt === 'string') {
			throw new Error('DirectorClaudeAgent tests expect iterable prompts');
		}
		const query = new FakeQuery(prompt);
		this.produced = query;
		return query;
	}

	close(): void { }

	async [Symbol.asyncDispose](): Promise<void> {
		this.asyncDisposeCount++;
		this._sdk.disposeEvents.push('sdk');
	}
}

class FakeQuery implements AsyncGenerator<SDKMessage, void> {
	readonly drainedPrompts: SDKUserMessage[] = [];
	readonly recordedPermissionModes: PermissionMode[] = [];
	readonly recordedModels: (string | undefined)[] = [];
	readonly recordedFlagSettings: Settings[] = [];
	private readonly _iterator: AsyncIterator<SDKUserMessage>;
	private _yielded = false;

	constructor(prompt: AsyncIterable<SDKUserMessage>) {
		this._iterator = prompt[Symbol.asyncIterator]();
	}

	[Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
		return this;
	}

	async next(): Promise<IteratorResult<SDKMessage, void>> {
		if (this._yielded) {
			return { done: true, value: undefined };
		}
		const prompt = await this._iterator.next();
		if (prompt.done) {
			return { done: true, value: undefined };
		}
		this.drainedPrompts.push(prompt.value);
		this._yielded = true;
		return { done: false, value: makeResultSuccess(prompt.value.session_id ?? 'session-id') };
	}

	async return(_value: void): Promise<IteratorResult<SDKMessage, void>> {
		return { done: true, value: undefined };
	}

	async throw(err: unknown): Promise<IteratorResult<SDKMessage, void>> {
		throw err;
	}

	async setPermissionMode(mode: PermissionMode): Promise<void> { this.recordedPermissionModes.push(mode); }
	async setModel(model?: string): Promise<void> { this.recordedModels.push(model); }
	async applyFlagSettings(settings: Settings): Promise<void> { this.recordedFlagSettings.push(settings); }
	async interrupt(): Promise<void> { }
	setMaxThinkingTokens(): never { throw new Error('not modeled'); }
	initializationResult(): never { throw new Error('not modeled'); }
	supportedCommands(): never { return Promise.resolve([]) as never; }
	supportedModels(): never { throw new Error('not modeled'); }
	supportedAgents(): never { return Promise.resolve([]) as never; }
	mcpServerStatus(): never { return Promise.resolve([]) as never; }
	getContextUsage(): never { throw new Error('not modeled'); }
	reloadPlugins(): never { return Promise.resolve({ commands: [], agents: [], plugins: [], mcpServers: [], error_count: 0 }) as never; }
	accountInfo(): never { throw new Error('not modeled'); }
	rewindFiles(): never { throw new Error('not modeled'); }
	readFile(): never { throw new Error('not modeled'); }
	seedReadState(): never { throw new Error('not modeled'); }
	reconnectMcpServer(): never { throw new Error('not modeled'); }
	toggleMcpServer(): never { throw new Error('not modeled'); }
	setMcpServers(): never { throw new Error('not modeled'); }
	streamInput(): never { throw new Error('not modeled'); }
	stopTask(): never { throw new Error('not modeled'); }
	close(): void { }
	[Symbol.asyncDispose](): Promise<void> { return Promise.resolve(); }
}

interface TestContext {
	readonly agent: DirectorClaudeAgent;
	readonly endpoint: FakeDirectorAnthropicEndpointService;
	readonly sdk: FakeClaudeAgentSdkService;
}

function createContext(disposables: Pick<DisposableStore, 'add'>, fixtures: DirectorProviderBackendHubFixtures = createDirectorClaudeFixtures()): TestContext {
	const disposeEvents: string[] = [];
	const endpoint = new FakeDirectorAnthropicEndpointService(disposeEvents);
	const sdk = new FakeClaudeAgentSdkService(disposeEvents);
	const logService = new NullLogService();
	const stateManager = disposables.add(new AgentHostStateManager(logService));
	const configurationService = disposables.add(new AgentConfigurationService(stateManager, logService));
	const services = new ServiceCollection(
		[ILogService, logService],
		[IDirectorProviderBackendHub, new DirectorProviderBackendHub(fixtures)],
		[IDirectorRuntimeCredentialService, new FakeCredentialService()],
		[IDirectorAnthropicEndpointService, endpoint],
		[IClaudeAgentSdkService, sdk],
		[ISessionDataService, createSessionDataService()],
		[IAgentPluginManager, new FakeAgentPluginManager()],
		[IAgentHostGitService, createNoopGitService()],
		[IAgentConfigurationService, configurationService],
	);
	const instantiationService: IInstantiationService = disposables.add(new InstantiationService(services));
	const agent = disposables.add(instantiationService.createInstance(DirectorClaudeAgent));
	return { agent, endpoint, sdk };
}

function createDirectorClaudeFixtures(): DirectorProviderBackendHubFixtures {
	return {
		defaultProviderId: 'openai-provider',
		defaultModelId: 'openai-main',
		providerInstances: [
			{ id: 'openai-provider', kind: 'openai-compatible', displayName: 'OpenAI Compatible', enabled: true, authKind: 'none', apiType: 'openai-completions', baseURL: 'https://openai.invalid/v1', defaultModelId: 'openai-main' },
			{ id: 'needs-key-provider', kind: 'anthropic-compatible', displayName: 'Needs Key', enabled: true, authKind: 'api-key', apiType: 'anthropic-messages', baseURL: 'https://anthropic.invalid/v1', defaultModelId: 'needs-key' },
			{ id: 'disabled-provider', kind: 'openai-compatible', displayName: 'Disabled', enabled: false, authKind: 'none', apiType: 'openai-completions', baseURL: 'https://disabled.invalid/v1', defaultModelId: 'disabled-model' },
			{ id: 'local-provider', kind: 'local', displayName: 'Local', enabled: true, authKind: 'none', apiType: 'local', defaultModelId: 'local-model' },
			{ id: 'custom-provider', kind: 'custom-http', displayName: 'Custom', enabled: true, authKind: 'none', apiType: 'custom-http', defaultModelId: 'custom-model' },
		],
		models: [
			{ providerInstanceId: 'openai-provider', id: 'openai-main', providerModelId: 'gpt-test', name: 'GPT Test', family: 'gpt', maxContextWindow: 128000, maxOutputTokens: 4096, supportsVision: true, apiType: 'openai-completions', capabilities: { streaming: true, toolCalling: true } },
			{ providerInstanceId: 'needs-key-provider', id: 'needs-key', providerModelId: 'claude-needs-key', name: 'Claude Needs Key', family: 'claude', maxContextWindow: 200000, supportsVision: false, apiType: 'anthropic-messages', capabilities: { streaming: true, toolCalling: true } },
			{ providerInstanceId: 'disabled-provider', id: 'disabled-model', providerModelId: 'disabled', name: 'Disabled Model', supportsVision: false, apiType: 'openai-completions' },
			{ providerInstanceId: 'local-provider', id: 'local-model', name: 'Local Model', supportsVision: false, apiType: 'local' },
			{ providerInstanceId: 'custom-provider', id: 'custom-model', name: 'Custom Model', supportsVision: false, apiType: 'custom-http' },
		],
	};
}

function createSingleProviderMultiModelFixtures(): DirectorProviderBackendHubFixtures {
	return {
		defaultProviderId: 'openai-provider',
		defaultModelId: 'openai-main',
		providerInstances: [
			{ id: 'openai-provider', kind: 'openai-compatible', displayName: 'OpenAI Compatible', enabled: true, authKind: 'none', apiType: 'openai-completions', baseURL: 'https://openai.invalid/v1', defaultModelId: 'openai-main' },
		],
		models: [
			{ providerInstanceId: 'openai-provider', id: 'openai-main', providerModelId: 'gpt-main', name: 'GPT Main', supportsVision: false, apiType: 'openai-completions', capabilities: { streaming: true, toolCalling: true } },
			{ providerInstanceId: 'openai-provider', id: 'openai-alt', providerModelId: 'gpt-alt', name: 'GPT Alt', supportsVision: false, apiType: 'openai-completions', capabilities: { streaming: true, toolCalling: true } },
		],
	};
}

function createDuplicateProviderModelIdFixtures(): DirectorProviderBackendHubFixtures {
	return {
		defaultProviderId: 'provider-a',
		defaultModelId: 'provider-a:gpt',
		providerInstances: [
			{ id: 'provider-a', kind: 'openai-compatible', displayName: 'Provider A', enabled: true, authKind: 'none', apiType: 'openai-completions', baseURL: 'https://provider-a.invalid/v1', defaultModelId: 'provider-a:gpt' },
			{ id: 'provider-b', kind: 'openai-compatible', displayName: 'Provider B', enabled: true, authKind: 'none', apiType: 'openai-completions', baseURL: 'https://provider-b.invalid/v1', defaultModelId: 'provider-b:gpt' },
		],
		models: [
			{ providerInstanceId: 'provider-a', id: 'provider-a:gpt', providerModelId: 'gpt-shared', name: 'GPT Shared A', supportsVision: false, apiType: 'openai-completions', capabilities: { streaming: true, toolCalling: true } },
			{ providerInstanceId: 'provider-b', id: 'provider-b:gpt', providerModelId: 'gpt-shared', name: 'GPT Shared B', supportsVision: false, apiType: 'openai-completions', capabilities: { streaming: true, toolCalling: true } },
		],
	};
}

function tick(): Promise<void> {
	return new Promise(resolve => setImmediate(resolve));
}

suite('DirectorClaudeAgent', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('advertises director-claude without protected resources or authentication', async () => {
		const { agent } = createContext(disposables);

		assert.deepStrictEqual({
			descriptor: agent.getDescriptor(),
			protectedResources: agent.getProtectedResources(),
			authenticated: await agent.authenticate('https://api.github.com', 'github-token'),
		}, {
			descriptor: {
				provider: 'director-claude',
				displayName: 'Director Claude',
				description: 'Claude SDK backed by Director Provider Backend',
			},
			protectedResources: [],
			authenticated: false,
		});

		agent.dispose();
	});

	test('projects Director models, keeps missing-auth unconfigured, and hides disabled or unsupported providers', async () => {
		const { agent } = createContext(disposables);
		await tick();

		assert.deepStrictEqual(agent.models.get().map(model => ({
			provider: model.provider,
			id: model.id,
			name: model.name,
			policyState: model.policyState,
			providerInstanceId: model._meta?.providerInstanceId,
			backendModelId: model._meta?.backendModelId,
			statusMessage: model._meta?.statusMessage,
			leaksSecret: JSON.stringify(model).includes('secret') || JSON.stringify(model).includes('token'),
		})), [
			{ provider: 'director-claude', id: 'openai-main', name: 'GPT Test', policyState: undefined, providerInstanceId: 'openai-provider', backendModelId: 'gpt-test', statusMessage: undefined, leaksSecret: false },
			{
				provider: 'director-claude',
				id: 'needs-key',
				name: 'Claude Needs Key',
				policyState: 'unconfigured',
				providerInstanceId: 'needs-key-provider',
				backendModelId: 'claude-needs-key',
				statusMessage: 'Director provider \'needs-key-provider\' requires api-key credentials.',
				leaksSecret: false,
			},
		]);

		agent.dispose();
	});

	test('materializes through Director endpoint without GitHub auth and passes endpoint settings to SDK options', async () => {
		const { agent, endpoint, sdk } = createContext(disposables);
		const created = await agent.createSession({ workingDirectory: URI.file('/workspace') });

		await agent.sendMessage(created.session, 'hello director claude', undefined, 'turn-1');

		const sessionId = AgentSession.id(created.session);
		const options = sdk.capturedStartupOptions[0];
		const settings = options.settings as Settings | undefined;
		assert.deepStrictEqual({
			provider: AgentSession.provider(created.session),
			endpointStarts: endpoint.starts,
			model: options.model,
			baseUrl: settings?.env?.ANTHROPIC_BASE_URL,
			authToken: settings?.env?.ANTHROPIC_AUTH_TOKEN,
			prompt: sdk.warmQueries[0].produced?.drainedPrompts[0]?.message.content,
		}, {
			provider: 'director-claude',
			endpointStarts: [{ sessionId, providerInstanceId: 'openai-provider' }],
			model: 'openai-main',
			baseUrl: endpoint.baseUrl,
			authToken: `${endpoint.nonce}.${sessionId}`,
			prompt: [{ type: 'text', text: 'hello director claude' }],
		});

		agent.dispose();
	});

	test('selected model reaches SDK options and pins endpoint selection to the provider', async () => {
		const { agent, endpoint, sdk } = createContext(disposables);
		const created = await agent.createSession({
			workingDirectory: URI.file('/workspace'),
			model: { id: 'needs-key' },
		});

		await agent.sendMessage(created.session, 'use selected model', undefined, 'turn-1');

		assert.deepStrictEqual({
			model: sdk.capturedStartupOptions[0].model,
			endpointStarts: endpoint.starts,
		}, {
			model: 'needs-key',
			endpointStarts: [{ sessionId: AgentSession.id(created.session), providerInstanceId: 'needs-key-provider' }],
		});

		agent.dispose();
	});

	test('changeModel on a materialized session leaves endpoint model resolution live', async () => {
		const { agent, endpoint, sdk } = createContext(disposables, createSingleProviderMultiModelFixtures());
		const created = await agent.createSession({ workingDirectory: URI.file('/workspace') });

		await agent.sendMessage(created.session, 'first model', undefined, 'turn-1');
		await agent.changeModel(created.session, { id: 'openai-alt' });
		await agent.sendMessage(created.session, 'second model', undefined, 'turn-2');

		assert.deepStrictEqual({
			endpointStarts: endpoint.starts,
			startupModels: sdk.capturedStartupOptions.map(options => options.model),
		}, {
			endpointStarts: [{ sessionId: AgentSession.id(created.session), providerInstanceId: 'openai-provider' }],
			startupModels: ['openai-main', 'openai-alt'],
		});

		agent.dispose();
	});

	test('keeps provider identity when providers share the same provider model id', async () => {
		const { agent, endpoint, sdk } = createContext(disposables, createDuplicateProviderModelIdFixtures());
		await tick();
		const created = await agent.createSession({
			workingDirectory: URI.file('/workspace'),
			model: { id: 'provider-b:gpt' },
		});

		await agent.sendMessage(created.session, 'use duplicate wire id model', undefined, 'turn-1');

		assert.deepStrictEqual({
			projectedModelIds: agent.models.get().map(model => model.id),
			optionsModel: sdk.capturedStartupOptions[0].model,
			endpointStarts: endpoint.starts,
		}, {
			projectedModelIds: ['provider-a:gpt', 'provider-b:gpt'],
			optionsModel: 'provider-b:gpt',
			endpointStarts: [{ sessionId: AgentSession.id(created.session), providerInstanceId: 'provider-b' }],
		});

		agent.dispose();
	});

	test('disposing a materialized session releases SDK before Director endpoint handle', async () => {
		const { agent, endpoint, sdk } = createContext(disposables);
		const created = await agent.createSession({ workingDirectory: URI.file('/workspace') });
		await agent.sendMessage(created.session, 'dispose order', undefined, 'turn-1');

		agent.dispose();

		assert.deepStrictEqual({
			warmDisposes: sdk.warmQueries[0].asyncDisposeCount,
			events: sdk.disposeEvents,
			endpointHandleDisposes: endpoint.disposeEvents.filter(event => event === 'endpoint').length,
		}, {
			warmDisposes: 1,
			events: ['sdk', 'endpoint'],
			endpointHandleDisposes: 1,
		});
	});
});
