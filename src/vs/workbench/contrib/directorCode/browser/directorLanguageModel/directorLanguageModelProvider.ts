/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AsyncIterableSource, DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import type { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { DirectorAgentProviderId } from '../../../../../platform/agentHost/common/directorProviderBackend.js';
import { ActionType, type ActionEnvelope } from '../../../../../platform/agentHost/common/state/sessionActions.js';
import { ResponsePartKind, StateComponents, type SessionState } from '../../../../../platform/agentHost/common/state/sessionState.js';
import { IAgentHostService } from '../../../../../platform/agentHost/common/agentService.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { ChatAgentLocation } from '../../../chat/common/constants.js';
import { ChatMessageRole, type IChatMessage, type IChatMessagePart, type IChatResponsePart, type ILanguageModelChatInfoOptions, type ILanguageModelChatMetadataAndIdentifier, type ILanguageModelChatProvider, type ILanguageModelChatRequestOptions, type ILanguageModelChatResponse } from '../../../chat/common/languageModels.js';
import { nullExtensionDescription } from '../../../../services/extensions/common/extensions.js';
import { IDirectorApiKeyService, IDirectorModelResolverService, IDirectorOAuthService, IDirectorProviderRegistryService, type DirectorStoredProviderInstance } from '../../common/provider/directorProviderServices.js';

export const DirectorLanguageModelVendor = 'director-code';
export const DirectorLanguageModelDisplayName = 'Director Code';
export const DirectorLanguageModelManagementCommand = 'director-code.openSettings';

export class DirectorLanguageModelProvider extends Disposable implements ILanguageModelChatProvider {
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	constructor(
		@IDirectorProviderRegistryService private readonly _registryService: IDirectorProviderRegistryService,
		@IDirectorModelResolverService private readonly _modelResolverService: IDirectorModelResolverService,
		@IDirectorApiKeyService private readonly _apiKeyService: IDirectorApiKeyService,
		@IDirectorOAuthService private readonly _oauthService: IDirectorOAuthService,
		@IAgentHostService private readonly _agentHostService: IAgentHostService,
	) {
		super();
		this._register(Event.any(
			this._registryService.onDidChangeProviders,
			this._apiKeyService.onDidChangeAuth,
			this._oauthService.onDidChangeAuth,
		)(() => this._onDidChange.fire()));
	}

	async provideLanguageModelChatInfo(options: ILanguageModelChatInfoOptions, _token: CancellationToken): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		const providers = await this._registryService.listProviders();
		const state = await this._registryService.getState();
		const entries: ILanguageModelChatMetadataAndIdentifier[] = [];
		for (const provider of providers) {
			if (!provider.enabled || !matchesProviderGroup(provider, options.configuration)) {
				continue;
			}
			const models = await this._modelResolverService.resolveModels(provider);
			for (const model of models) {
				const identifier = toDirectorLanguageModelIdentifier(provider.id, model.id);
				entries.push({
					identifier,
					metadata: {
						extension: nullExtensionDescription.identifier,
						name: model.name,
						id: model.providerModelId ?? model.id,
						vendor: DirectorLanguageModelVendor,
						version: model.version ?? '1.0',
						family: model.family ?? provider.kind,
						maxInputTokens: model.maxContextWindow ?? 0,
						maxOutputTokens: model.maxOutputTokens ?? 0,
						isDefaultForLocation: state.defaultModelId === model.id ? { [ChatAgentLocation.Chat]: true } : {},
						isUserSelectable: true,
						detail: provider.displayName,
						auth: {
							providerLabel: provider.displayName,
						},
						capabilities: {
							vision: model.capabilities?.vision ?? model.supportsVision,
							toolCalling: model.capabilities?.toolCalling ?? false,
							agentMode: model.capabilities?.agentMode ?? false,
						},
					},
				});
			}
		}
		return entries;
	}

	async sendChatRequest(modelId: string, messages: IChatMessage[], _from: ExtensionIdentifier | undefined, _options: ILanguageModelChatRequestOptions, token: CancellationToken): Promise<ILanguageModelChatResponse> {
		const selection = parseDirectorLanguageModelIdentifier(modelId);
		const stream = new AsyncIterableSource<IChatResponsePart>(() => {
			if (!result.isSettled) {
				cancel();
			}
		});
		const result = new DeferredPromise<void>();
		let session: URI | undefined;
		let turnId: string | undefined;
		const store = new DisposableStore();
		const cancel = () => {
			if (session && turnId) {
				this._agentHostService.dispatch(session.toString(), {
					type: ActionType.SessionTurnCancelled,
					turnId,
				});
			}
			stream.reject(new CancellationError());
			void result.cancel();
		};
		store.add(token.onCancellationRequested(cancel));

		void (async () => {
			try {
				turnId = generateUuid();
				session = await this._agentHostService.createSession({
					provider: DirectorAgentProviderId,
					model: { id: selection.modelId },
				});
				const subscription = this._agentHostService.getSubscription(StateComponents.Session, session);
				store.add(subscription);
				await waitForSubscription(subscription.object);
				const responsePartKinds = new Map<string, ResponsePartKind.Markdown | ResponsePartKind.Reasoning>();
				store.add(this._agentHostService.onDidAction(envelope => {
					if (!session || envelope.channel.toString() !== session.toString()) {
						return;
					}
					handleAgentHostAction(envelope, turnId!, responsePartKinds, stream, result);
				}));
				this._agentHostService.dispatch(session.toString(), {
					type: ActionType.SessionTurnStarted,
					turnId,
					userMessage: {
						text: serializeChatMessages(messages),
					},
				});
				await result.p;
			} catch (err) {
				const error = err instanceof Error ? err : new Error(String(err));
				stream.reject(error);
				await result.error(error);
			} finally {
				store.dispose();
				if (session) {
					this._agentHostService.disposeSession(session).catch(() => { /* best effort cleanup */ });
				}
			}
		})();

		return {
			stream: stream.asyncIterable,
			result: result.p,
		};
	}

	async provideTokenCount(_modelId: string, message: string | IChatMessage, _token: CancellationToken): Promise<number> {
		const text = typeof message === 'string' ? message : serializeChatMessages([message]);
		return Math.ceil(text.length / 4);
	}
}

function handleAgentHostAction(
	envelope: ActionEnvelope,
	turnId: string,
	responsePartKinds: Map<string, ResponsePartKind.Markdown | ResponsePartKind.Reasoning>,
	stream: AsyncIterableSource<IChatResponsePart>,
	result: DeferredPromise<void>,
): void {
	const action = envelope.action;
	switch (action.type) {
		case ActionType.SessionResponsePart:
			if (action.turnId !== turnId) {
				return;
			}
			if (action.part.kind === ResponsePartKind.Markdown) {
				responsePartKinds.set(action.part.id, ResponsePartKind.Markdown);
				if (action.part.content) {
					stream.emitOne({ type: 'text', value: action.part.content });
				}
			} else if (action.part.kind === ResponsePartKind.Reasoning) {
				responsePartKinds.set(action.part.id, ResponsePartKind.Reasoning);
				if (action.part.content) {
					stream.emitOne({ type: 'thinking', value: action.part.content });
				}
			}
			break;
		case ActionType.SessionDelta:
			if (action.turnId === turnId && responsePartKinds.get(action.partId) === ResponsePartKind.Markdown) {
				stream.emitOne({ type: 'text', value: action.content });
			}
			break;
		case ActionType.SessionReasoning:
			if (action.turnId === turnId) {
				stream.emitOne({ type: 'thinking', value: action.content });
			}
			break;
		case ActionType.SessionTurnComplete:
			if (action.turnId === turnId) {
				stream.resolve();
				void result.complete(undefined);
			}
			break;
		case ActionType.SessionTurnCancelled:
			if (action.turnId === turnId) {
				const error = new CancellationError();
				stream.reject(error);
				void result.error(error);
			}
			break;
		case ActionType.SessionError:
			if (action.turnId === turnId) {
				const error = new Error(action.error.message);
				stream.reject(error);
				void result.error(error);
			}
			break;
	}
}

function toDirectorLanguageModelIdentifier(providerInstanceId: string, modelId: string): string {
	return `${DirectorLanguageModelVendor}/${encodeURIComponent(providerInstanceId)}/${encodeURIComponent(modelId)}`;
}

function parseDirectorLanguageModelIdentifier(identifier: string): { readonly providerInstanceId: string; readonly modelId: string } {
	const parts = identifier.split('/');
	if (parts.length !== 3 || parts[0] !== DirectorLanguageModelVendor) {
		throw new Error(`Director language model identifier '${identifier}' is not valid.`);
	}
	return {
		providerInstanceId: decodeURIComponent(parts[1]),
		modelId: decodeURIComponent(parts[2]),
	};
}

function matchesProviderGroup(provider: DirectorStoredProviderInstance, configuration: ILanguageModelChatInfoOptions['configuration']): boolean {
	const configuredProviderId = typeof configuration?.directorProviderInstanceId === 'string'
		? configuration.directorProviderInstanceId
		: undefined;
	return configuredProviderId === undefined || configuredProviderId === provider.id;
}

function serializeChatMessages(messages: readonly IChatMessage[]): string {
	return messages.map(message => {
		const role = roleLabel(message.role);
		const content = message.content.map(serializeChatMessagePart).filter(Boolean).join('\n');
		return `${role}:\n${content}`;
	}).join('\n\n');
}

function roleLabel(role: ChatMessageRole): string {
	switch (role) {
		case ChatMessageRole.System:
			return 'System';
		case ChatMessageRole.User:
			return 'User';
		case ChatMessageRole.Assistant:
			return 'Assistant';
	}
}

function serializeChatMessagePart(part: IChatMessagePart): string {
	switch (part.type) {
		case 'text':
			return part.value;
		case 'thinking':
			return Array.isArray(part.value) ? part.value.join('') : part.value;
		case 'tool_result':
			return part.value.map(value => value.type === 'text' ? value.value : `[${value.type}]`).join('\n');
		case 'tool_use':
			return `[tool_use ${part.name} ${stableStringify(part.parameters)}]`;
		case 'image_url':
			return `[image ${part.value.mimeType}]`;
		case 'data':
			return `[data ${part.mimeType}]`;
	}
}

function stableStringify(value: unknown): string {
	try {
		return JSON.stringify(value ?? {});
	} catch {
		return '{}';
	}
}

async function waitForSubscription(subscription: { readonly value: SessionState | Error | undefined; readonly onDidChange: Event<SessionState> }): Promise<void> {
	if (subscription.value !== undefined) {
		if (subscription.value instanceof Error) {
			throw subscription.value;
		}
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const disposable = subscription.onDidChange(() => {
			disposable.dispose();
			if (subscription.value instanceof Error) {
				reject(subscription.value);
			} else {
				resolve();
			}
		});
	});
}

export function createDirectorLanguageModelProviderDescriptor() {
	return {
		vendor: DirectorLanguageModelVendor,
		displayName: DirectorLanguageModelDisplayName,
		managementCommand: DirectorLanguageModelManagementCommand,
		when: undefined,
		configuration: undefined,
	};
}
