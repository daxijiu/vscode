/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { ConfigSchema, SessionModelInfo } from '../../../../../../platform/agentHost/common/state/sessionState.js';
import { nullExtensionDescription } from '../../../../../services/extensions/common/extensions.js';
import { ILanguageModelChatMetadataAndIdentifier, ILanguageModelChatProvider, ILanguageModelConfigurationSchema } from '../../../common/languageModels.js';

/**
 * Exposes models available from the agent host process as selectable
 * language models in the chat model picker. Models are provided from
 * root state (via {@link AgentInfo.models}) rather than via RPC.
 */
export class AgentHostLanguageModelProvider extends Disposable implements ILanguageModelChatProvider {
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _models: readonly SessionModelInfo[] = [];

	constructor(
		private readonly _sessionType: string,
		private readonly _vendor: string,
	) {
		super();
	}

	/**
	 * Called by {@link AgentHostContribution} when models change in root state.
	 */
	updateModels(models: readonly SessionModelInfo[]): void {
		this._models = models;
		this._onDidChange.fire();
	}

	async provideLanguageModelChatInfo(_options: unknown, _token: CancellationToken): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		return this._models
			.filter(m => m.policyState !== 'disabled')
			.map(m => {
				const multiplierNumeric = typeof m._meta?.multiplierNumeric === 'number' ? m._meta.multiplierNumeric : undefined;
				const capabilities = readModelCapabilities(m);
				const providerDisplayName = readStringMeta(m, 'providerDisplayName');
				const maxOutputTokens = readNumberMeta(m, 'maxOutputTokens');
				const family = readStringMeta(m, 'family') ?? m.id;
				const version = readStringMeta(m, 'version') ?? '1.0';
				const tooltip = readStringMeta(m, 'statusMessage');
				return {
					identifier: `${this._vendor}:${m.id}`,
					metadata: {
						extension: nullExtensionDescription.identifier,
						name: m.name,
						id: m.id,
						vendor: this._vendor,
						version,
						family,
						maxInputTokens: m.maxContextWindow ?? 0,
						maxOutputTokens: maxOutputTokens ?? 0,
						isDefaultForLocation: {},
						isUserSelectable: true,
						detail: providerDisplayName,
						tooltip,
						pricing: multiplierNumeric !== undefined ? `${multiplierNumeric}x` : undefined,
						multiplierNumeric,
						targetChatSessionType: this._sessionType,
						capabilities: {
							vision: capabilities.vision ?? m.supportsVision ?? false,
							toolCalling: capabilities.toolCalling ?? true,
							agentMode: capabilities.agentMode ?? true,
						},
						configurationSchema: this._toLanguageModelConfigurationSchema(m.configSchema),
					},
				};
			});
	}

	private _toLanguageModelConfigurationSchema(schema: ConfigSchema | undefined): ILanguageModelConfigurationSchema | undefined {
		if (!schema) {
			return undefined;
		}

		return {
			type: schema.type,
			required: schema.required,
			properties: Object.fromEntries(Object.entries(schema.properties).map(([key, property]) => [key, {
				type: property.type,
				title: property.title,
				description: property.description,
				default: property.default,
				enum: property.enum,
				enumItemLabels: property.enumLabels,
				enumDescriptions: property.enumDescriptions,
				readOnly: property.readOnly,
				group: key === 'thinkingLevel' ? 'navigation' : undefined,
			}])),
		};
	}

	async sendChatRequest(): Promise<never> {
		throw new Error('Agent-host models do not support direct chat requests');
	}

	async provideTokenCount(): Promise<number> {
		return 0;
	}
}

function readStringMeta(model: SessionModelInfo, key: string): string | undefined {
	const value = model._meta?.[key];
	return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readNumberMeta(model: SessionModelInfo, key: string): number | undefined {
	const value = model._meta?.[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readModelCapabilities(model: SessionModelInfo): { readonly vision?: boolean; readonly toolCalling?: boolean; readonly agentMode?: boolean } {
	const value = model._meta?.capabilities;
	if (!value || typeof value !== 'object') {
		return {};
	}
	const candidate = value as Record<string, unknown>;
	return {
		vision: typeof candidate.vision === 'boolean' ? candidate.vision : undefined,
		toolCalling: typeof candidate.toolCalling === 'boolean' ? candidate.toolCalling : undefined,
		agentMode: typeof candidate.agentMode === 'boolean' ? candidate.agentMode : undefined,
	};
}
