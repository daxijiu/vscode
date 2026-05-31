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
import { ITelemetryService } from '../../../telemetry/common/telemetry.js';
import { platformSessionSchema } from '../../common/agentHostSchema.js';
import { DirectorAgentProviderId, IDirectorProviderBackendHub, isResolvedBackend, toAgentModelInfo, type DirectorProviderInstance } from '../../common/directorProviderBackend.js';
import { IDirectorRuntimeCredentialService } from '../../common/directorRuntimeCredentials.js';
import { ISessionDataService } from '../../common/sessionDataService.js';
import { ISyncedCustomization } from '../../common/agentPluginManager.js';
import { AgentProvider, AgentSession, AgentSignal, IAgent, IAgentCreateSessionConfig, IAgentCreateSessionResult, IAgentDescriptor, IAgentModelInfo, IAgentResolveSessionConfigParams, IAgentSessionConfigCompletionsParams, IAgentSessionMetadata } from '../../common/agentService.js';
import { SessionConfigKey } from '../../common/sessionConfigKeys.js';
import { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import { MessageAttachment, ModelSelection, ProtectedResourceMetadata, ToolDefinition } from '../../common/state/protocol/state.js';
import { ClientPluginCustomization, PendingMessage, PolicyState, SessionInputAnswer, SessionInputResponseKind, ToolCallResult, Turn, TurnState } from '../../common/state/sessionState.js';
import { IAgentConfigurationService } from '../agentConfigurationService.js';
import { DirectorAgentSession } from './directorAgentSession.js';
import { DirectorSessionStore, IDirectorPersistedSession } from './directorSessionStore.js';
import { DirectorTelemetryReporter } from './directorTelemetry.js';

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
	private readonly _consumedSteeringMessages = new Set<string>();
	private readonly _clientToolsBySession = new Map<string, { readonly clientId: string | undefined; readonly tools: readonly ToolDefinition[] }>();
	private readonly _sessionStore: DirectorSessionStore;
	private readonly _telemetryReporter: DirectorTelemetryReporter;
	private _modelRefreshPromise: Promise<void> | undefined;

	constructor(
		@IDirectorProviderBackendHub private readonly _backendHub: IDirectorProviderBackendHub,
		@IDirectorRuntimeCredentialService private readonly _credentialService: IDirectorRuntimeCredentialService,
		@IAgentConfigurationService private readonly _configurationService: IAgentConfigurationService,
		@ISessionDataService sessionDataService: ISessionDataService,
		@ILogService private readonly _logService: ILogService,
		@ITelemetryService telemetryService: ITelemetryService,
	) {
		super();
		this._sessionStore = new DirectorSessionStore(this.id, sessionDataService);
		this._telemetryReporter = new DirectorTelemetryReporter(telemetryService);
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
			const providers = await this._backendHub.listProviderInstances();
			const providersById = new Map(providers.map(provider => [provider.id, provider]));
			const models = await this._backendHub.listModels();
			const availableModels: IAgentModelInfo[] = [];
			for (const model of models) {
				const provider = providersById.get(model.providerInstanceId);
				if (!provider?.enabled) {
					continue;
				}
				const projectedModel = model.providerDisplayName !== undefined
					? model
					: { ...model, providerDisplayName: provider.displayName };
				const resolved = await this._backendHub.resolveBackend({ providerInstanceId: model.providerInstanceId, modelId: model.id });
				if (isResolvedBackend(resolved)) {
					availableModels.push(toAgentModelInfo(this.id, projectedModel));
				} else if (resolved.status === 'missingAuth') {
					const modelInfo = toAgentModelInfo(this.id, projectedModel);
					availableModels.push({
						...modelInfo,
						policyState: PolicyState.Unconfigured,
						_meta: {
							...(modelInfo._meta ?? {}),
							authStateKind: getDirectorProviderAuthStateKind(provider),
							statusMessage: resolved.message,
						},
					});
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
			this._telemetryReporter.session('create', 'success', { persisted: false, turnCount: existing.getTurns().length });
			return {
				session: existing.sessionUri,
				workingDirectory: existing.workingDirectory,
				...(existing.createMetadata().project ? { project: existing.createMetadata().project } : {}),
			};
		}

		const persisted = await this._restorePersistedSession(sessionUri);
		if (persisted) {
			const metadata = persisted.createMetadata();
			this._telemetryReporter.session('create', 'success', { persisted: true, turnCount: persisted.getTurns().length });
			return {
				session: persisted.sessionUri,
				workingDirectory: metadata.workingDirectory,
				...(metadata.project ? { project: metadata.project } : {}),
			};
		}

		const model = await this._resolveModelSelection(config.model);
		const session = this._registerSession(new DirectorAgentSession(
			sessionId,
			sessionUri,
			Date.now(),
			config.workingDirectory,
			model,
			sessionUri => this._readMode(sessionUri),
			this._telemetryReporter,
			[],
			undefined,
			this._backendHub,
			this._credentialService,
			this._logService,
		));
		await this._persistSession(session);

		const metadata = session.createMetadata();
		this._telemetryReporter.session('create', 'success', { persisted: true, turnCount: 0 });
		return {
			session: session.sessionUri,
			workingDirectory: metadata.workingDirectory,
			...(metadata.project ? { project: metadata.project } : {}),
		};
	}

	async resolveSessionConfig(params: IAgentResolveSessionConfigParams): Promise<ResolveSessionConfigResult> {
		return {
			schema: platformSessionSchema.toProtocol(),
			values: platformSessionSchema.validateOrDefault(params.config, {
				[SessionConfigKey.Mode]: 'interactive',
				[SessionConfigKey.AutoApprove]: 'default',
			}),
		};
	}

	async sessionConfigCompletions(_params: IAgentSessionConfigCompletionsParams): Promise<SessionConfigCompletionsResult> {
		return { items: [] };
	}

	async sendMessage(sessionUri: URI, prompt: string, attachments?: readonly MessageAttachment[], turnId?: string): Promise<void> {
		const sessionId = AgentSession.id(sessionUri);
		const effectiveTurnId = turnId ?? generateUuid();
		return this._sessionSequencer.queue(sessionId, async () => {
			let session: DirectorAgentSession;
			try {
				session = await this._getOrRestoreSession(sessionUri);
				await session.send(prompt, attachments, effectiveTurnId);
				await this._persistSession(session);
				this._telemetryReporter.session('send', sessionOutcome(session, effectiveTurnId), { persisted: true, turnCount: session.getTurns().length });
			} catch (err) {
				this._telemetryReporter.session('send', 'failure', { persisted: false });
				throw err;
			}
		});
	}

	setPendingMessages(session: URI, steeringMessage: PendingMessage | undefined, _queuedMessages: readonly PendingMessage[]): void {
		if (!steeringMessage) {
			return;
		}

		// The Phase 4 Director harness does not yet support injecting a
		// steering message into an in-flight provider stream. Acknowledge
		// system-generated steering messages (for example terminal completion
		// notifications) so they do not remain as stale chat pending requests.
		const key = `${session.toString()}:${steeringMessage.id}`;
		if (this._consumedSteeringMessages.has(key)) {
			return;
		}
		this._consumedSteeringMessages.add(key);
		this._logService.info(`[Director] Acknowledging unsupported steering message ${steeringMessage.id} for ${session.toString()}`);
		this._onDidSessionProgress.fire({
			kind: 'steering_consumed',
			session,
			id: steeringMessage.id,
		});
	}

	async getSessionMessages(session: URI): Promise<readonly Turn[]> {
		const current = this._sessions.get(AgentSession.id(session))?.session;
		if (current) {
			return current.getTurns();
		}
		const persisted = await this._readPersistedSession(session);
		return persisted?.turns ?? [];
	}

	async disposeSession(session: URI): Promise<void> {
		const sessionId = AgentSession.id(session);
		return this._disposeSequencer.queue(sessionId, async () => {
			this._sessions.deleteAndDispose(sessionId);
			this._clientToolsBySession.delete(sessionId);
			await this._sessionStore.deleteSession(session);
			this._telemetryReporter.session('dispose', 'success', { persisted: true });
		});
	}

	async abortSession(session: URI): Promise<void> {
		const current = this._sessions.get(AgentSession.id(session))?.session;
		if (!current) {
			return;
		}
		current.abort();
		await this._persistSession(current);
	}

	async changeModel(session: URI, model: ModelSelection): Promise<void> {
		const sessionId = AgentSession.id(session);
		await this._sessionSequencer.queue(sessionId, async () => {
			const resolvedModel = await this._resolveModelSelection(model);
			if (resolvedModel) {
				const current = await this._getOrRestoreSession(session);
				current.changeModel(resolvedModel);
				await this._persistSession(current);
				this._telemetryReporter.session('changeModel', 'success', { persisted: true, turnCount: current.getTurns().length });
			}
		});
	}

	respondToPermissionRequest(requestId: string, approved: boolean): void {
		for (const entry of this._sessions.values()) {
			if (entry.session.respondToPermissionRequest(requestId, approved)) {
				return;
			}
		}
	}

	respondToUserInputRequest(_requestId: string, _response: SessionInputResponseKind, _answers?: Record<string, SessionInputAnswer>): void { }

	async listSessions(): Promise<IAgentSessionMetadata[]> {
		const sessionsById = new Map<string, IAgentSessionMetadata>();
		let persisted = false;
		try {
			for (const metadata of await this._sessionStore.listSessions()) {
				sessionsById.set(AgentSession.id(metadata.session), metadata);
			}
			persisted = true;
		} catch (err) {
			this._logService.warn('[Director] Failed to list persisted sessions', err);
			this._telemetryReporter.session('list', 'failure', { persisted: true });
		}
		for (const entry of this._sessions.values()) {
			sessionsById.set(entry.session.sessionId, entry.session.createMetadata());
		}
		const result = [...sessionsById.values()];
		this._telemetryReporter.session('list', 'success', { persisted, sessionCount: result.length });
		return result;
	}

	async getSessionMetadata(session: URI): Promise<IAgentSessionMetadata | undefined> {
		const current = this._sessions.get(AgentSession.id(session))?.session;
		if (current) {
			this._telemetryReporter.session('metadata', 'success', { persisted: false, turnCount: current.getTurns().length });
			return current.createMetadata();
		}
		const persisted = await this._readPersistedSession(session);
		this._telemetryReporter.session('metadata', persisted ? 'success' : 'notFound', { persisted: !!persisted, turnCount: persisted?.turns.length });
		return persisted?.metadata;
	}

	async truncateSession(session: URI, turnId?: string): Promise<void> {
		const sessionId = AgentSession.id(session);
		await this._sessionSequencer.queue(sessionId, async () => {
			const current = await this._getOrRestoreSession(session);
			current.truncate(turnId);
			await this._persistSession(current);
			this._telemetryReporter.session('truncate', 'success', { persisted: true, turnCount: current.getTurns().length });
		});
	}

	async setClientCustomizations(_session: URI, _clientId: string, _customizations: ClientPluginCustomization[]): Promise<ISyncedCustomization[]> {
		return [];
	}

	setClientTools(session: URI, clientId: string, tools: ToolDefinition[]): void {
		const sessionId = AgentSession.id(session);
		const clientTools = { clientId: clientId || undefined, tools: [...tools] };
		this._clientToolsBySession.set(sessionId, clientTools);
		const current = this._sessions.get(sessionId)?.session;
		if (!current) {
			return;
		}
		if (!tools.length) {
			current.failClientTools(clientId, `Client ${clientId} disconnected before completing a Director tool call.`);
		}
		current.setClientTools(clientTools.clientId, clientTools.tools);
	}

	onClientToolCallComplete(session: URI, toolCallId: string, result: ToolCallResult): void {
		this._sessions.get(AgentSession.id(session))?.session.completeClientToolCall(toolCallId, result);
	}

	setCustomizationEnabled(_uri: string, _enabled: boolean): void { }

	async shutdown(): Promise<void> {
		for (const entry of this._sessions.values()) {
			entry.session.abort();
		}
		this._sessions.clearAndDisposeAll();
		this._clientToolsBySession.clear();
	}

	private _registerSession(session: DirectorAgentSession): DirectorAgentSession {
		const entry = new DirectorSessionEntry(session);
		entry.addDisposable(session.onDidSessionProgress(signal => this._onDidSessionProgress.fire(signal)));
		this._sessions.set(session.sessionId, entry);
		const clientTools = this._clientToolsBySession.get(session.sessionId);
		if (clientTools) {
			session.setClientTools(clientTools.clientId, clientTools.tools);
		}
		return session;
	}

	private async _getOrRestoreSession(sessionUri: URI): Promise<DirectorAgentSession> {
		const sessionId = AgentSession.id(sessionUri);
		const existing = this._sessions.get(sessionId)?.session;
		if (existing) {
			return existing;
		}
		const restored = await this._restorePersistedSession(sessionUri);
		if (restored) {
			return restored;
		}
		return this._registerSession(new DirectorAgentSession(
			sessionId,
			sessionUri,
			Date.now(),
			undefined,
			undefined,
			session => this._readMode(session),
			this._telemetryReporter,
			[],
			undefined,
			this._backendHub,
			this._credentialService,
			this._logService,
		));
	}

	private async _restorePersistedSession(sessionUri: URI): Promise<DirectorAgentSession | undefined> {
		const persisted = await this._readPersistedSession(sessionUri);
		if (!persisted) {
			return undefined;
		}
		const sessionId = AgentSession.id(sessionUri);
		const session = this._registerSession(new DirectorAgentSession(
			sessionId,
			sessionUri,
			persisted.metadata.startTime,
			persisted.metadata.workingDirectory,
			persisted.metadata.model,
			session => this._readMode(session),
			this._telemetryReporter,
			persisted.turns,
			persisted.metadata.modifiedTime,
			this._backendHub,
			this._credentialService,
			this._logService,
		));
		this._telemetryReporter.session('restore', 'success', { persisted: true, turnCount: persisted.turns.length });
		return session;
	}

	private async _readPersistedSession(session: URI): Promise<IDirectorPersistedSession | undefined> {
		try {
			return await this._sessionStore.readSession(session);
		} catch (err) {
			this._logService.warn(`[Director] Failed to read persisted session ${session.toString()}`, err);
			this._telemetryReporter.session('restore', 'failure', { persisted: true });
			return undefined;
		}
	}

	private async _persistSession(session: DirectorAgentSession): Promise<void> {
		await this._sessionStore.writeSession(session.createMetadata(), session.getTurns());
	}

	private async _resolveModelSelection(model: ModelSelection | undefined): Promise<ModelSelection | undefined> {
		const resolution = await this._backendHub.resolveBackend(model ? { modelId: model.id } : undefined);
		this._telemetryReporter.providerResolution(resolution);
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

	private _readMode(sessionUri: URI): 'interactive' | 'plan' | undefined {
		return this._configurationService.getEffectiveValue(sessionUri.toString(), platformSessionSchema, SessionConfigKey.Mode);
	}
}

function getDirectorProviderAuthStateKind(provider: DirectorProviderInstance): string | undefined {
	const authState = (provider as DirectorProviderInstance & { readonly authState?: { readonly kind?: unknown } }).authState;
	return typeof authState?.kind === 'string' ? authState.kind : undefined;
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

function sessionOutcome(session: DirectorAgentSession, turnId: string): 'success' | 'failure' | 'cancelled' {
	const turn = session.getTurns().find(candidate => candidate.id === turnId);
	if (turn?.state === TurnState.Cancelled) {
		return 'cancelled';
	}
	if (turn?.state === TurnState.Error) {
		return 'failure';
	}
	return 'success';
}
