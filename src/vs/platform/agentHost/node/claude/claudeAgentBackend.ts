/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CCAModel } from '@vscode/copilot-api';
import { localize } from '../../../../nls.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { createClaudeThinkingLevelSchema, isClaudeEffortLevel } from '../../common/claudeModelConfig.js';
import { AgentProvider, GITHUB_COPILOT_PROTECTED_RESOURCE, IAgentDescriptor, IAgentModelInfo } from '../../common/agentService.js';
import { AHP_AUTH_REQUIRED, ProtocolError } from '../../common/state/sessionProtocol.js';
import { ModelSelection, PolicyState, ProtectedResourceMetadata } from '../../common/state/protocol/state.js';
import { ICopilotApiService } from '../shared/copilotApiService.js';
import { ILogService } from '../../../log/common/log.js';
import { tryParseClaudeModelId } from './claudeModelId.js';
import { IClaudeProxyHandle, IClaudeProxyService } from './claudeProxyService.js';
import { IClaudeSdkEndpointHandle } from './claudeSdkEndpoint.js';

export interface IClaudeAgentBackend extends IDisposable {
	readonly id: AgentProvider;
	getDescriptor(): IAgentDescriptor;
	getProtectedResources(): ProtectedResourceMetadata[];
	ensureReady(): void;
	authenticate(resource: string, token: string): Promise<boolean>;
	refreshModels(): Promise<readonly IAgentModelInfo[] | undefined>;
	resolveInitialModel(model: ModelSelection | undefined): Promise<ModelSelection | undefined>;
	acquireEndpoint(sessionId: string, model: ModelSelection | undefined): Promise<IClaudeSdkEndpointHandle>;
}

export class CopilotClaudeAgentBackend implements IClaudeAgentBackend {

	readonly id: AgentProvider = 'claude';

	private _githubToken: string | undefined;
	private _proxyHandle: IClaudeProxyHandle | undefined;

	constructor(
		private readonly _logService: ILogService,
		private readonly _copilotApiService: ICopilotApiService,
		private readonly _claudeProxyService: IClaudeProxyService,
	) { }

	getDescriptor(): IAgentDescriptor {
		return {
			provider: this.id,
			displayName: localize('claudeAgent.displayName', "Claude"),
			description: localize('claudeAgent.description', "Claude agent backed by the Anthropic Claude Agent SDK"),
		};
	}

	getProtectedResources(): ProtectedResourceMetadata[] {
		return [GITHUB_COPILOT_PROTECTED_RESOURCE];
	}

	ensureReady(): void {
		this._ensureAuthenticated();
	}

	async authenticate(resource: string, token: string): Promise<boolean> {
		if (resource !== GITHUB_COPILOT_PROTECTED_RESOURCE.resource) {
			return false;
		}
		const tokenChanged = this._githubToken !== token;
		if (!tokenChanged) {
			this._logService.info('[Claude] Auth token unchanged');
			return true;
		}
		const newHandle = await this._claudeProxyService.start(token);
		const oldHandle = this._proxyHandle;
		this._proxyHandle = newHandle;
		this._githubToken = token;
		this._logService.info('[Claude] Auth token updated');
		oldHandle?.dispose();
		return true;
	}

	async refreshModels(): Promise<readonly IAgentModelInfo[] | undefined> {
		const tokenAtStart = this._githubToken;
		if (!tokenAtStart) {
			return [];
		}
		try {
			const all = await this._copilotApiService.models(tokenAtStart);
			if (this._githubToken !== tokenAtStart) {
				return undefined;
			}
			return all
				.filter(isClaudeModel)
				.sort((a, b) => Number(b.is_chat_default) - Number(a.is_chat_default))
				.map(m => toAgentModelInfo(m, this.id));
		} catch (err) {
			this._logService.error(err, '[Claude] Failed to refresh models');
			return this._githubToken === tokenAtStart ? [] : undefined;
		}
	}

	resolveInitialModel(model: ModelSelection | undefined): Promise<ModelSelection | undefined> {
		return Promise.resolve(model);
	}

	acquireEndpoint(_sessionId: string, _model: ModelSelection | undefined): Promise<IClaudeSdkEndpointHandle> {
		const handle = this._ensureAuthenticated();
		return Promise.resolve({
			baseUrl: handle.baseUrl,
			nonce: handle.nonce,
			dispose: () => { },
		});
	}

	dispose(): void {
		this._proxyHandle?.dispose();
		this._proxyHandle = undefined;
		this._githubToken = undefined;
	}

	private _ensureAuthenticated(): IClaudeProxyHandle {
		const handle = this._proxyHandle;
		if (!handle) {
			throw new ProtocolError(
				AHP_AUTH_REQUIRED,
				'Authentication is required to use Claude',
				this.getProtectedResources(),
			);
		}
		return handle;
	}
}

/**
 * Returns true if `m` is a Claude-family model that should be advertised
 * to clients picking a model for the legacy Copilot-backed Claude provider.
 */
function isClaudeModel(m: CCAModel): boolean {
	return (
		m.vendor === 'Anthropic' &&
		!!m.supported_endpoints?.includes('/v1/messages') &&
		!!m.model_picker_enabled &&
		!!m.capabilities?.supports?.tool_calls &&
		tryParseClaudeModelId(m.id) !== undefined
	);
}

interface IClaudeModelSupports {
	readonly adaptive_thinking?: boolean;
	readonly reasoning_effort?: readonly string[];
}

function toAgentModelInfo(m: CCAModel, provider: AgentProvider): IAgentModelInfo {
	const supports = m.capabilities?.supports;
	const supportedEfforts = ((supports as IClaudeModelSupports | undefined)?.reasoning_effort ?? []).filter(isClaudeEffortLevel);
	const configSchema = createClaudeThinkingLevelSchema(supportedEfforts);
	const policyState = m.policy?.state as PolicyState | undefined;
	const multiplier = m.billing?.multiplier;
	return {
		provider,
		id: m.id,
		name: m.name,
		maxContextWindow: m.capabilities?.limits?.max_context_window_tokens,
		supportsVision: !!supports?.vision,
		...(configSchema ? { configSchema } : {}),
		...(policyState ? { policyState } : {}),
		...(typeof multiplier === 'number' ? { _meta: { multiplierNumeric: multiplier } } : {}),
	};
}
