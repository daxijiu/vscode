/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import type { IReference } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAgentHostService, type IAgentCreateSessionConfig } from '../../../../../platform/agentHost/common/agentService.js';
import { DirectorDirectLanguageModelMessagesAttachmentMetaKey } from '../../../../../platform/agentHost/common/directorProviderAdapters.js';
import { ActionType, type ActionEnvelope, type INotification, type SessionAction, type TerminalAction, type IRootConfigChangedAction } from '../../../../../platform/agentHost/common/state/sessionActions.js';
import type { IAgentSubscription } from '../../../../../platform/agentHost/common/state/agentSubscription.js';
import { MessageAttachmentKind, ResponsePartKind, StateComponents, type ComponentToState, type MessageAttachment, type SessionState } from '../../../../../platform/agentHost/common/state/sessionState.js';
import { DirectorProviderSnapshotVersion, type DirectorProviderAuthState, type DirectorProviderSnapshot, type DirectorProviderSnapshotModel } from '../../../../../platform/agentHost/common/directorProviderSnapshot.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { DirectorCodeContribution } from '../../browser/directorCode.contribution.js';
import { DirectorLanguageModelProvider } from '../../browser/directorLanguageModel/directorLanguageModelProvider.js';
import { ChatMessageRole, getTextResponseFromStream, type ILanguageModelChatProvider, type ILanguageModelChatSelector, type ILanguageModelsService, type IUserFriendlyLanguageModel } from '../../../chat/common/languageModels.js';
import { IDirectorApiKeyService, IDirectorModelResolverService, IDirectorOAuthService, IDirectorProviderRegistryService, IDirectorProviderSnapshotService, type DirectorProviderRegistryState, type DirectorStoredProviderInstance } from '../../common/provider/directorProviderServices.js';

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
			new TestAgentHostService(),
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

	test('contribution resolves director-code models after provider registration', () => {
		const provider = createProvider();
		const model = createModel(provider.id);
		const languageModelsService = new TestLanguageModelsService();
		const snapshotService = new TestSnapshotService();
		const instantiationService = new class extends mock<IInstantiationService>() {
			override createInstance<T>(ctor: unknown): T {
				assert.strictEqual(ctor, DirectorLanguageModelProvider);
				return new DirectorLanguageModelProvider(
					new TestRegistryService([provider], { defaultProviderId: provider.id, defaultModelId: model.id }),
					new TestModelResolverService([model]),
					new TestApiKeyService(),
					new TestOAuthService(),
					new TestAgentHostService(),
				) as T;
			}
		};

		disposables.add(new DirectorCodeContribution(snapshotService, languageModelsService, instantiationService, new NullLogService()));

		assert.deepStrictEqual({
			snapshotWrites: snapshotService.writeCount,
			addedVendors: languageModelsService.addedDescriptors.map(descriptor => descriptor.vendor),
			registeredVendors: languageModelsService.registeredVendors,
			selectedVendors: languageModelsService.selectedSelectors.map(selector => selector.vendor),
		}, {
			snapshotWrites: 1,
			addedVendors: ['director-code'],
			registeredVendors: ['director-code'],
			selectedVendors: ['director-code'],
		});
	});

	test('routes direct requests through AgentHost Director sessions', async () => {
		const provider = createProvider();
		const model = createModel(provider.id);
		const agentHost = new TestAgentHostService();
		const languageModelProvider = disposables.add(new DirectorLanguageModelProvider(
			new TestRegistryService([provider], { defaultProviderId: provider.id, defaultModelId: model.id }),
			new TestModelResolverService([model]),
			new TestApiKeyService(),
			new TestOAuthService(),
			agentHost,
		));

		const response = await languageModelProvider.sendChatRequest(
			'director-code/deepseek/deepseek%3Adeepseek-chat',
			[{ role: ChatMessageRole.User, content: [{ type: 'text', value: 'hello' }] }],
			undefined,
			{},
			CancellationToken.None,
		);
		const text = await getTextResponseFromStream(response);

		assert.deepStrictEqual({
			text,
			createSessionConfigs: agentHost.createSessionConfigs,
			turnMessages: agentHost.turnMessages,
			directMessages: readDirectMessages(agentHost.turnAttachments[0]),
			disposedSessions: agentHost.disposedSessions.map(session => session.toString()),
		}, {
			text: 'provider direct hello',
			createSessionConfigs: [{ provider: 'director', model: { id: 'deepseek:deepseek-chat' } }],
			turnMessages: ['Direct language model request'],
			directMessages: [{ role: 'user', content: 'hello' }],
			disposedSessions: ['director://direct-test'],
		});
	});
});

function readDirectMessages(attachments: readonly MessageAttachment[] | undefined): unknown {
	assert.ok(attachments?.length);
	const attachment = attachments[0];
	assert.strictEqual(attachment.type, MessageAttachmentKind.Simple);
	if (attachment.type !== MessageAttachmentKind.Simple) {
		throw new Error('Expected direct language model messages attachment');
	}
	assert.strictEqual(attachment._meta?.[DirectorDirectLanguageModelMessagesAttachmentMetaKey], true);
	assert.strictEqual(typeof attachment.modelRepresentation, 'string');
	const modelRepresentation = attachment.modelRepresentation;
	assert.ok(modelRepresentation);
	return JSON.parse(modelRepresentation);
}

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

class TestSnapshotService implements IDirectorProviderSnapshotService {
	declare readonly _serviceBrand: undefined;
	writeCount = 0;

	writeSnapshot(): Promise<DirectorProviderSnapshot> {
		this.writeCount++;
		return Promise.resolve({ version: DirectorProviderSnapshotVersion, updatedAt: 1, providers: [], models: [] });
	}

	getSnapshotResource(): Promise<string> {
		return Promise.resolve('director/provider-snapshot.json');
	}
}

class TestLanguageModelsService extends mock<ILanguageModelsService>() {
	declare readonly _serviceBrand: undefined;
	readonly addedDescriptors: IUserFriendlyLanguageModel[] = [];
	readonly registeredVendors: string[] = [];
	readonly selectedSelectors: ILanguageModelChatSelector[] = [];

	override deltaLanguageModelChatProviderDescriptors(added: IUserFriendlyLanguageModel[], _removed: IUserFriendlyLanguageModel[]): void {
		this.addedDescriptors.push(...added);
	}

	override registerLanguageModelProvider(vendor: string, _provider: ILanguageModelChatProvider) {
		this.registeredVendors.push(vendor);
		return { dispose() { } };
	}

	override selectLanguageModels(selector: ILanguageModelChatSelector): Promise<string[]> {
		this.selectedSelectors.push(selector);
		return Promise.resolve([]);
	}
}

class TestAgentHostService extends mock<IAgentHostService>() {
	declare readonly _serviceBrand: undefined;
	override readonly clientId = 'test-client';
	private readonly onDidActionEmitter = new Emitter<ActionEnvelope>();
	override readonly onDidAction = this.onDidActionEmitter.event;
	override readonly onDidNotification: Event<INotification> = Event.None;
	override readonly onAgentHostExit = Event.None;
	override readonly onAgentHostStart = Event.None;
	readonly createSessionConfigs: IAgentCreateSessionConfig[] = [];
	readonly turnMessages: string[] = [];
	readonly turnAttachments: (readonly MessageAttachment[] | undefined)[] = [];
	readonly disposedSessions: URI[] = [];
	private readonly session = URI.parse('director://direct-test');

	override createSession(config?: IAgentCreateSessionConfig): Promise<URI> {
		this.createSessionConfigs.push(config ?? {});
		return Promise.resolve(this.session);
	}

	override getSubscription<T extends StateComponents>(): IReference<IAgentSubscription<ComponentToState[T]>> {
		return {
			object: {
				value: {} as SessionState,
				verifiedValue: undefined,
				onDidChange: Event.None,
				onWillApplyAction: Event.None,
				onDidApplyAction: Event.None,
			},
			dispose: () => { },
		} as IReference<IAgentSubscription<ComponentToState[T]>>;
	}

	override dispatch(channel: string, action: SessionAction | TerminalAction | IRootConfigChangedAction): void {
		if (action.type !== ActionType.SessionTurnStarted) {
			return;
		}
		this.turnMessages.push(action.userMessage.text);
		this.turnAttachments.push(action.userMessage.attachments);
		const turnId = action.turnId;
		queueMicrotask(() => {
			this.fireAction(channel, {
				type: ActionType.SessionResponsePart,
				turnId,
				part: { kind: ResponsePartKind.Markdown, id: 'markdown-1', content: 'provider direct hello' },
			});
			this.fireAction(channel, { type: ActionType.SessionTurnComplete, turnId });
		});
	}

	override disposeSession(session: URI): Promise<void> {
		this.disposedSessions.push(session);
		return Promise.resolve();
	}

	private fireAction(channel: string, action: SessionAction): void {
		this.onDidActionEmitter.fire({ channel, action, serverSeq: 1, origin: undefined });
	}
}
