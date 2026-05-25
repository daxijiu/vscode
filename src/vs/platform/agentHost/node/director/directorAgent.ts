/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IntervalTimer, SequencerByKey } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { equals } from '../../../../base/common/objects.js';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../log/common/log.js';
import { DirectorAgentProviderId, IDirectorProviderBackendHub, isResolvedBackend, toAgentModelInfo } from '../../common/directorProviderBackend.js';
import { ISyncedCustomization } from '../../common/agentPluginManager.js';
import { AgentProvider, AgentSession, AgentSignal, IAgent, IAgentCreateSessionConfig, IAgentCreateSessionResult, IAgentDescriptor, IAgentModelInfo, IAgentResolveSessionConfigParams, IAgentSessionConfigCompletionsParams, IAgentSessionMetadata } from '../../common/agentService.js';
import { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import { MessageAttachment, ModelSelection, ProtectedResourceMetadata, ToolDefinition } from '../../common/state/protocol/state.js';
import { CustomizationRef, PendingMessage, SessionInputAnswer, SessionInputResponseKind, ToolCallResult, Turn } from '../../common/state/sessionState.js';
import { DirectorAgentSession } from './directorAgentSession.js';

export class DirectorAgent extends Disposable implements IAgent {

	readonly id: AgentProvider = DirectorAgentProviderId;

	private readonly _onDidSessionProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidSessionProgress = this._onDidSessionProgress.event;

	private readonly _models = observableValue<readonly IAgentModelInfo[]>(this, []);
	readonly models: IObservable<readonly IAgentModelInfo[]> = this._models;

	private readonly _sessions = this._register(new DisposableMap<string, DirectorSessionEntry>());
	private readonly _sessionSequencer = new SequencerByKey<string>();
	private readonly _disposeSequencer = new SequencerByKey<string>();
	private readonly _modelRefreshTimer = this._register(new IntervalTimer());
	private _modelRefreshPromise: Promise<void> | undefined;

	constructor(
		@IDirectorProviderBackendHub private readonly _backendHub: IDirectorProviderBackendHub,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		void this.refreshModels();
		this._modelRefreshTimer.cancelAndSet(() => {
			void this.refreshModels();
		}, 2000);
	}

	async refreshModels(): Promise<void> {
		if (this._modelRefreshPromise !== undefined) {
			return this._modelRefreshPromise;
		}
		this._modelRefreshPromise = this.doRefreshModels().finally(() => {
			this._modelRefreshPromise = undefined;
		});
		return this._modelRefreshPromise;
	}

	private async doRefreshModels(): Promise<void> {
		try {
			const models = await this._backendHub.listModels();
			const availableModels = [];
			for (const model of models) {
				const resolved = await this._backendHub.resolveBackend({ providerInstanceId: model.providerInstanceId, modelId: model.id });
				if (isResolvedBackend(resolved)) {
					availableModels.push(toAgentModelInfo(this.id, model));
				}
			}
			if (!equals(this._models.get(), availableModels)) {
				this._models.set(availableModels, undefined);
			}
		} catch (err) {
			this._logService.error('[Director] Failed to refresh models', err);
			if (this._models.get().length !== 0) {
				this._models.set([], undefined);
			}
		}
	}

	getDescriptor(): IAgentDescriptor {
		return {
			provider: this.id,
			displayName: localize('directorAgent.displayName', "Director"),
			description: localize('directorAgent.description', "Director agent backed by Director Provider Backend"),
		};
	}

	getProtectedResources(): ProtectedResourceMetadata[] {
		return [];
	}

	async authenticate(_resource: string, _token: string): Promise<boolean> {
		return false;
	}

	async createSession(config: IAgentCreateSessionConfig = {}): Promise<IAgentCreateSessionResult> {
		const sessionUri = config.session ?? AgentSession.uri(this.id, generateUuid());
		const sessionId = AgentSession.id(sessionUri);
		const existing = this._sessions.get(sessionId)?.session;
		if (existing) {
			return {
				session: existing.sessionUri,
				workingDirectory: existing.workingDirectory,
				...(existing.createMetadata().project ? { project: existing.createMetadata().project } : {}),
			};
		}

		const model = await this._resolveModelSelection(config.model);
		const session = this._registerSession(new DirectorAgentSession(
			sessionId,
			sessionUri,
			Date.now(),
			config.workingDirectory,
			model,
		));

		const metadata = session.createMetadata();
		return {
			session: session.sessionUri,
			workingDirectory: metadata.workingDirectory,
			...(metadata.project ? { project: metadata.project } : {}),
		};
	}

	async resolveSessionConfig(params: IAgentResolveSessionConfigParams): Promise<ResolveSessionConfigResult> {
		return {
			schema: { type: 'object', properties: {} },
			values: params.config ?? {},
		};
	}

	async sessionConfigCompletions(_params: IAgentSessionConfigCompletionsParams): Promise<SessionConfigCompletionsResult> {
		return { items: [] };
	}

	async sendMessage(sessionUri: URI, prompt: string, attachments?: readonly MessageAttachment[], turnId?: string): Promise<void> {
		const sessionId = AgentSession.id(sessionUri);
		const effectiveTurnId = turnId ?? generateUuid();
		return this._sessionSequencer.queue(sessionId, async () => {
			const session = this._sessions.get(sessionId)?.session ?? this._registerSession(new DirectorAgentSession(
				sessionId,
				sessionUri,
				Date.now(),
				undefined,
				undefined,
			));
			await session.send(prompt, attachments, effectiveTurnId);
		});
	}

	setPendingMessages(_session: URI, _steeringMessage: PendingMessage | undefined, _queuedMessages: readonly PendingMessage[]): void { }

	async getSessionMessages(session: URI): Promise<readonly Turn[]> {
		return this._sessions.get(AgentSession.id(session))?.session.getTurns() ?? [];
	}

	async disposeSession(session: URI): Promise<void> {
		const sessionId = AgentSession.id(session);
		return this._disposeSequencer.queue(sessionId, async () => {
			this._sessions.deleteAndDispose(sessionId);
		});
	}

	async abortSession(session: URI): Promise<void> {
		this._sessions.get(AgentSession.id(session))?.session.abort();
	}

	async changeModel(session: URI, model: ModelSelection): Promise<void> {
		const sessionId = AgentSession.id(session);
		await this._sessionSequencer.queue(sessionId, async () => {
			const resolvedModel = await this._resolveModelSelection(model);
			if (resolvedModel) {
				this._sessions.get(sessionId)?.session.changeModel(resolvedModel);
			}
		});
	}

	respondToPermissionRequest(_requestId: string, _approved: boolean): void { }

	respondToUserInputRequest(_requestId: string, _response: SessionInputResponseKind, _answers?: Record<string, SessionInputAnswer>): void { }

	async listSessions(): Promise<IAgentSessionMetadata[]> {
		return [...this._sessions.values()].map(entry => entry.session.createMetadata());
	}

	async getSessionMetadata(session: URI): Promise<IAgentSessionMetadata | undefined> {
		return this._sessions.get(AgentSession.id(session))?.session.createMetadata();
	}

	async setClientCustomizations(_session: URI, _clientId: string, _customizations: CustomizationRef[]): Promise<ISyncedCustomization[]> {
		return [];
	}

	setClientTools(_session: URI, _clientId: string, _tools: ToolDefinition[]): void { }

	onClientToolCallComplete(_session: URI, _toolCallId: string, _result: ToolCallResult): void { }

	setCustomizationEnabled(_uri: string, _enabled: boolean): void { }

	async shutdown(): Promise<void> {
		for (const entry of this._sessions.values()) {
			entry.session.abort();
		}
		this._sessions.clearAndDisposeAll();
	}

	private _registerSession(session: DirectorAgentSession): DirectorAgentSession {
		const entry = new DirectorSessionEntry(session);
		entry.addDisposable(session.onDidSessionProgress(signal => this._onDidSessionProgress.fire(signal)));
		this._sessions.set(session.sessionId, entry);
		return session;
	}

	private async _resolveModelSelection(model: ModelSelection | undefined): Promise<ModelSelection | undefined> {
		const resolution = await this._backendHub.resolveBackend(model ? { modelId: model.id } : undefined);
		if (isResolvedBackend(resolution)) {
			return {
				id: model?.id ?? resolution.backend.agentModelId ?? resolution.backend.modelId,
				...(model?.config ? { config: model.config } : {}),
			};
		}
		if (model) {
			throw new Error(resolution.message);
		}
		this._logService.warn(`[Director] No default model resolved: ${resolution.message}`);
		return undefined;
	}
}

class DirectorSessionEntry extends Disposable {

	constructor(readonly session: DirectorAgentSession) {
		super();
		this._register(session);
	}

	addDisposable(disposable: { dispose(): void }): void {
		this._register(disposable);
	}
}
