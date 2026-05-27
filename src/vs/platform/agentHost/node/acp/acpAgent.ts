/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ExternalAcpAgentCwdPolicy, ExternalAcpAgentSnapshotAgent, sanitizeExternalAcpAgentId } from '../../common/acpAgentConfig.js';
import { AgentProvider, AgentSession, IAgent, IAgentCreateSessionConfig, IAgentCreateSessionResult, IAgentDescriptor, IAgentModelInfo, IAgentResolveSessionConfigParams, IAgentSessionConfigCompletionsParams, IAgentSessionMetadata, IAgentSessionProjectInfo, AgentSignal } from '../../common/agentService.js';
import { ISyncedCustomization } from '../../common/agentPluginManager.js';
import { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import { ConfigSchema, CustomizationRef, MessageAttachment, ModelSelection, PendingMessage, ProtectedResourceMetadata, SessionInputAnswer, SessionInputResponseKind, ToolCallResult, ToolDefinition, Turn } from '../../common/state/protocol/state.js';
import { AcpAgentSession, toAcpUserMessage } from './acpAgentSession.js';
import { AcpProcess } from './acpProcess.js';

const AcpAgentProviderPrefix = 'acp-';

const AcpTextSessionConfigSchema: ConfigSchema = {
	type: 'object',
	properties: {},
};

export function toAcpAgentProviderId(agentId: string): AgentProvider {
	const id = sanitizeExternalAcpAgentId(agentId);
	return id.startsWith(AcpAgentProviderPrefix) ? id : `${AcpAgentProviderPrefix}${id}`;
}

export function getAcpAgentSubscriptionDescription(agent: Pick<ExternalAcpAgentSnapshotAgent, 'displayName' | 'vendorLabel'>): string {
	const owner = agent.vendorLabel?.trim() || agent.displayName.trim();
	return localize('acpAgent.subscriptionDescription', "Uses your {0} subscription/account.", owner);
}

export class AcpAgent extends Disposable implements IAgent {

	readonly id: AgentProvider;

	private readonly _onDidSessionProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidSessionProgress = this._onDidSessionProgress.event;

	private readonly _models: IObservable<readonly IAgentModelInfo[]>;
	readonly models: IObservable<readonly IAgentModelInfo[]>;
	private readonly _sessions = new Map<string, { readonly session: AcpAgentSession; readonly store: DisposableStore }>();

	constructor(private readonly agent: ExternalAcpAgentSnapshotAgent) {
		super();
		this.id = toAcpAgentProviderId(agent.id);
		this._models = observableValue<readonly IAgentModelInfo[]>(this, [{
			provider: this.id,
			id: 'external-acp-runtime',
			name: localize('acpAgent.placeholderModel', "{0} Runtime", this.agent.displayName),
			supportsVision: false,
			_meta: {
				externalAcpAgent: true,
				vendorLabel: this.agent.vendorLabel ?? this.agent.displayName,
			},
		}]);
		this.models = this._models;
	}

	getDescriptor(): IAgentDescriptor {
		return {
			provider: this.id,
			displayName: this.agent.displayName,
			description: getAcpAgentSubscriptionDescription(this.agent),
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
		const sessionKey = sessionUri.toString();

		const process = new AcpProcess({
			agent: this.agent,
			workspaceCwd: config.workingDirectory?.fsPath,
		});
		let store: DisposableStore | undefined;
		try {
			const initializeResult = await process.initialize();
			const newSession = await process.newSession(process.sessionCwd());
			const createdAt = Date.now();
			const workingDirectory = this._resolveWorkingDirectory(config.workingDirectory);
			const session = new AcpAgentSession(
				newSession.sessionId,
				sessionUri,
				createdAt,
				workingDirectory,
				{
					vendorLabel: this.agent.vendorLabel ?? this.agent.displayName,
					...(this.agent.loginCommand ? { loginCommand: this.agent.loginCommand } : {}),
					...(this.agent.loginHelpUrl ? { loginHelpUrl: this.agent.loginHelpUrl } : {}),
					...(initializeResult.authMethods ? { authMethods: initializeResult.authMethods } : {}),
				},
				process,
			);
			store = new DisposableStore();
			store.add(session);
			store.add(session.onDidSessionProgress(signal => this._onDidSessionProgress.fire(signal)));
			const previousEntry = this._sessions.get(sessionKey);
			this._sessions.set(sessionKey, { session, store });
			store = undefined;
			previousEntry?.store.dispose();
			return {
				session: sessionUri,
				...(workingDirectory ? { workingDirectory, project: this._project(workingDirectory) } : {}),
			};
		} catch (err) {
			store?.dispose();
			process.dispose();
			throw new Error(toAcpUserMessage(err, {
				vendorLabel: this.agent.vendorLabel ?? this.agent.displayName,
				...(this.agent.loginCommand ? { loginCommand: this.agent.loginCommand } : {}),
				...(this.agent.loginHelpUrl ? { loginHelpUrl: this.agent.loginHelpUrl } : {}),
				...(process.getAuthMethods().length ? { authMethods: process.getAuthMethods() } : {}),
			}));
		}
	}

	async resolveSessionConfig(_params: IAgentResolveSessionConfigParams): Promise<ResolveSessionConfigResult> {
		return {
			schema: AcpTextSessionConfigSchema,
			values: {},
		};
	}

	async sessionConfigCompletions(_params: IAgentSessionConfigCompletionsParams): Promise<SessionConfigCompletionsResult> {
		return { items: [] };
	}

	async sendMessage(session: URI, prompt: string, attachments?: readonly MessageAttachment[], turnId?: string): Promise<void> {
		const activeSession = this._sessions.get(session.toString())?.session;
		if (!activeSession) {
			throw new Error(localize('acpAgent.sessionMissing', "External ACP agent session is no longer available."));
		}
		await activeSession.send(prompt, attachments, turnId ?? generateUuid());
	}

	setPendingMessages(_session: URI, _steeringMessage: PendingMessage | undefined, _queuedMessages: readonly PendingMessage[]): void { }

	async getSessionMessages(session: URI): Promise<readonly Turn[]> {
		return this._sessions.get(session.toString())?.session.getTurns() ?? [];
	}

	async disposeSession(session: URI): Promise<void> {
		this._disposeSession(session.toString());
	}

	private _disposeSession(sessionKey: string): void {
		const entry = this._sessions.get(sessionKey);
		if (!entry) {
			return;
		}
		this._sessions.delete(sessionKey);
		entry.store.dispose();
	}

	async abortSession(session: URI): Promise<void> {
		await this._sessions.get(session.toString())?.session.abort();
	}

	async changeModel(_session: URI, _model: ModelSelection): Promise<void> {
		throw new Error(localize('acpAgent.changeModelUnsupported', "External ACP agent model selection is not available until ACP model capability support is implemented."));
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
		return Array.from(this._sessions.values(), entry => entry.session.createMetadata());
	}

	async getSessionMetadata(session: URI): Promise<IAgentSessionMetadata | undefined> {
		return this._sessions.get(session.toString())?.session.createMetadata();
	}

	async setClientCustomizations(_session: URI, _clientId: string, _customizations: CustomizationRef[]): Promise<ISyncedCustomization[]> {
		return [];
	}

	setClientTools(_session: URI, _clientId: string, _tools: ToolDefinition[]): void { }

	onClientToolCallComplete(_session: URI, _toolCallId: string, _result: ToolCallResult): void { }

	setCustomizationEnabled(_uri: string, _enabled: boolean): void { }

	async shutdown(): Promise<void> {
		for (const entry of this._sessions.values()) {
			entry.store.dispose();
		}
		this._sessions.clear();
	}

	override dispose(): void {
		void this.shutdown();
		super.dispose();
	}

	private _resolveWorkingDirectory(requested: URI | undefined): URI | undefined {
		if (requested) {
			return requested;
		}
		if (this.agent.cwdPolicy === ExternalAcpAgentCwdPolicy.Fixed && this.agent.cwd) {
			return URI.file(this.agent.cwd);
		}
		return undefined;
	}

	private _project(workingDirectory: URI): IAgentSessionProjectInfo {
		return {
			uri: workingDirectory,
			displayName: basename(workingDirectory) || workingDirectory.fsPath || workingDirectory.path,
		};
	}
}
