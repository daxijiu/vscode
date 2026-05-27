/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ExternalAcpAgentSnapshotAgent, sanitizeExternalAcpAgentId } from '../../common/acpAgentConfig.js';
import { AgentProvider, IAgent, IAgentCreateSessionConfig, IAgentCreateSessionResult, IAgentDescriptor, IAgentModelInfo, IAgentResolveSessionConfigParams, IAgentSessionConfigCompletionsParams, IAgentSessionMetadata, AgentSignal } from '../../common/agentService.js';
import { ISyncedCustomization } from '../../common/agentPluginManager.js';
import { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import { ConfigSchema, CustomizationRef, MessageAttachment, ModelSelection, PendingMessage, ProtectedResourceMetadata, SessionInputAnswer, SessionInputResponseKind, ToolCallResult, ToolDefinition, Turn } from '../../common/state/protocol/state.js';

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

	async createSession(_config: IAgentCreateSessionConfig = {}): Promise<IAgentCreateSessionResult> {
		throw new Error(localize('acpAgent.phase4Required', "External ACP agent sessions are not available yet. Phase 4 will connect this agent to its ACP runtime."));
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

	async sendMessage(_session: URI, _prompt: string, _attachments?: readonly MessageAttachment[], _turnId?: string): Promise<void> {
		throw new Error(localize('acpAgent.sendUnsupported', "External ACP agent messaging is not available until Phase 4."));
	}

	setPendingMessages(_session: URI, _steeringMessage: PendingMessage | undefined, _queuedMessages: readonly PendingMessage[]): void { }

	async getSessionMessages(_session: URI): Promise<readonly Turn[]> {
		return [];
	}

	async disposeSession(_session: URI): Promise<void> { }

	async abortSession(_session: URI): Promise<void> { }

	async changeModel(_session: URI, _model: ModelSelection): Promise<void> {
		throw new Error(localize('acpAgent.changeModelUnsupported', "External ACP agent model selection is not available until ACP model capability support is implemented."));
	}

	respondToPermissionRequest(_requestId: string, _approved: boolean): void { }

	respondToUserInputRequest(_requestId: string, _response: SessionInputResponseKind, _answers?: Record<string, SessionInputAnswer>): void { }

	async listSessions(): Promise<IAgentSessionMetadata[]> {
		return [];
	}

	async getSessionMetadata(_session: URI): Promise<IAgentSessionMetadata | undefined> {
		return undefined;
	}

	async setClientCustomizations(_session: URI, _clientId: string, _customizations: CustomizationRef[]): Promise<ISyncedCustomization[]> {
		return [];
	}

	setClientTools(_session: URI, _clientId: string, _tools: ToolDefinition[]): void { }

	onClientToolCallComplete(_session: URI, _toolCallId: string, _result: ToolCallResult): void { }

	setCustomizationEnabled(_uri: string, _enabled: boolean): void { }

	async shutdown(): Promise<void> { }
}
