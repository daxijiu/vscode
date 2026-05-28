/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IObservable, ISettableObservable, observableValue } from '../../../../base/common/observable.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../files/common/files.js';
import { ExternalAcpAgentCapability, ExternalAcpAgentSnapshotAgent, sanitizeExternalAcpAgentId } from '../../common/acpAgentConfig.js';
import { AgentProvider, AgentSession, IAgent, IAgentCreateSessionConfig, IAgentCreateSessionResult, IAgentDescriptor, IAgentModelInfo, IAgentResolveSessionConfigParams, IAgentSessionConfigCompletionsParams, IAgentSessionMetadata, IAgentSessionProjectInfo, AgentSignal } from '../../common/agentService.js';
import { ISyncedCustomization } from '../../common/agentPluginManager.js';
import { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import { CustomizationRef, MessageAttachment, ModelSelection, PendingMessage, ProtectedResourceMetadata, SessionInputAnswer, SessionInputResponseKind, ToolCallResult, ToolDefinition, Turn } from '../../common/state/protocol/state.js';
import { AcpAgentSession, toAcpUserMessage } from './acpAgentSession.js';
import { acpModelsToAgentModels, AcpNegotiatedCapabilities, EmptyAcpNegotiatedCapabilities, EmptyAcpSessionConfigSchema, resolveAcpSessionConfigValues } from './acpCapabilities.js';
import { AcpFileSystemBridge } from './acpFileSystemBridge.js';
import { AcpPermissionBridge } from './acpPermissionBridge.js';
import { AcpProcess } from './acpProcess.js';
import { resolveAcpLocalCwd } from './acpLocalCwd.js';

const AcpAgentProviderPrefix = 'acp-';

export function toAcpAgentProviderId(agentId: string): AgentProvider {
	const id = sanitizeExternalAcpAgentId(agentId);
	return id.startsWith(AcpAgentProviderPrefix) ? id : `${AcpAgentProviderPrefix}${id}`;
}

export function getAcpAgentSubscriptionDescription(agent: Pick<ExternalAcpAgentSnapshotAgent, 'displayName' | 'vendorLabel'>): string {
	const owner = agent.vendorLabel?.trim() || agent.displayName.trim();
	return localize('acpAgent.subscriptionDescription', "Uses your {0} subscription/account.", owner);
}

export interface AcpAgentOptions {
	readonly executionEnabled?: boolean;
	readonly fileService?: IFileService;
}

export class AcpAgent extends Disposable implements IAgent {

	readonly id: AgentProvider;

	private readonly _onDidSessionProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidSessionProgress = this._onDidSessionProgress.event;

	private readonly _models: ISettableObservable<readonly IAgentModelInfo[]>;
	readonly models: IObservable<readonly IAgentModelInfo[]>;
	private _capabilities: AcpNegotiatedCapabilities = EmptyAcpNegotiatedCapabilities;
	private readonly _sessions = new Map<string, { readonly session: AcpAgentSession; readonly store: DisposableStore }>();

	constructor(private readonly agent: ExternalAcpAgentSnapshotAgent, private readonly options: AcpAgentOptions = {}) {
		super();
		this.id = toAcpAgentProviderId(agent.id);
		this._models = observableValue<readonly IAgentModelInfo[]>(this, this._placeholderModels());
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
		if (this.options.executionEnabled === false) {
			throw new Error(localize('acpAgent.executionDisabled', "External ACP agent execution is disabled by setting or policy."));
		}
		const sessionUri = config.session ?? AgentSession.uri(this.id, generateUuid());
		const sessionKey = sessionUri.toString();
		const localCwd = resolveAcpLocalCwd(this.agent, config.workingDirectory);
		const fileSystemBridge = this._createFileSystemBridge(localCwd.workingDirectory ?? config.workingDirectory, config.activeClient?.clientId);

		const permissionBridge = new AcpPermissionBridge({ autoDeny: false });
		const process = new AcpProcess({
			agent: this.agent,
			workspaceCwd: localCwd.processCwd,
			capabilityPolicy: {
				allowFileRead: fileSystemBridge !== undefined,
				allowFileWrite: fileSystemBridge !== undefined,
			},
			permissionBridge,
			...(fileSystemBridge ? { fileSystemBridge } : {}),
		});
		let store: DisposableStore | undefined;
		try {
			const initializeResult = await process.initialize();
			const newSession = await process.newSession(localCwd.sessionCwd);
			this._applyCapabilities(process.getCapabilities());
			const createdAt = Date.now();
			const session = new AcpAgentSession(
				newSession.sessionId,
				sessionUri,
				createdAt,
				localCwd.workingDirectory,
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
				...(localCwd.workingDirectory ? { workingDirectory: localCwd.workingDirectory, project: this._project(localCwd.workingDirectory) } : {}),
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

	async resolveSessionConfig(params: IAgentResolveSessionConfigParams): Promise<ResolveSessionConfigResult> {
		return {
			schema: this._capabilities.sessionConfigSchema,
			values: this._capabilities.sessionConfigSchema === EmptyAcpSessionConfigSchema ? {} : resolveAcpSessionConfigValues(this._capabilities, params.config),
		};
	}

	async sessionConfigCompletions(params: IAgentSessionConfigCompletionsParams): Promise<SessionConfigCompletionsResult> {
		const items = this._capabilities.sessionConfigCompletions[params.property] ?? [];
		const query = params.query?.trim().toLowerCase();
		if (!query) {
			return { items: [...items] };
		}
		return {
			items: items.filter(item => item.value.toLowerCase().includes(query) || item.label.toLowerCase().includes(query)),
		};
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

	respondToPermissionRequest(requestId: string, approved: boolean, selectedOptionId?: string): void {
		for (const entry of this._sessions.values()) {
			if (entry.session.respondToPermissionRequest(requestId, approved, selectedOptionId)) {
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

	private _project(workingDirectory: URI): IAgentSessionProjectInfo {
		return {
			uri: workingDirectory,
			displayName: basename(workingDirectory) || workingDirectory.fsPath || workingDirectory.path,
		};
	}

	private _createFileSystemBridge(workingDirectory: URI | undefined, activeClientId: string | undefined): AcpFileSystemBridge | undefined {
		if (!this.options.fileService || !workingDirectory || workingDirectory.scheme !== 'file' || workingDirectory.authority) {
			return undefined;
		}
		if (!this.agent.capabilities.includes(ExternalAcpAgentCapability.Files)) {
			return undefined;
		}
		return new AcpFileSystemBridge(this.options.fileService, {
			workspaceRoot: workingDirectory,
			...(activeClientId ? { activeClientId } : {}),
		});
	}

	private _applyCapabilities(capabilities: AcpNegotiatedCapabilities): void {
		this._capabilities = capabilities;
		const models = acpModelsToAgentModels(this.id, this.agent.vendorLabel ?? this.agent.displayName, capabilities);
		this._models.set(models.length ? models : this._placeholderModels(), undefined);
	}

	private _placeholderModels(): readonly IAgentModelInfo[] {
		return [{
			provider: this.id,
			id: 'external-acp-runtime',
			name: localize('acpAgent.placeholderModel', "{0} Runtime", this.agent.displayName),
			supportsVision: false,
			_meta: {
				externalAcpAgent: true,
				vendorLabel: this.agent.vendorLabel ?? this.agent.displayName,
			},
		}];
	}
}
