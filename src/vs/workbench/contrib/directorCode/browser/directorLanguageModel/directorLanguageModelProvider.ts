/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AsyncIterableSource, DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { buildDirectorNativeMessageRequest, type DirectorNormalizedMessage, type DirectorNormalizedToolCall, type DirectorNormalizedToolDefinition } from '../../../../../platform/agentHost/common/directorProviderAdapters.js';
import type { DirectorProviderApiType } from '../../../../../platform/agentHost/common/directorProviderBackend.js';
import type { DirectorRuntimeProviderApiType, DirectorTokenUsage } from '../../../../../platform/agentHost/common/directorProviderRuntime.js';
import { IDirectorRuntimeCredentialService, type DirectorRuntimeCredential } from '../../../../../platform/agentHost/common/directorRuntimeCredentials.js';
import type { DirectorProviderAuthStateKind } from '../../../../../platform/agentHost/common/directorProviderSnapshot.js';
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
		@IDirectorRuntimeCredentialService private readonly _runtimeCredentialService: IDirectorRuntimeCredentialService,
		private readonly _fetch: DirectorDirectFetch = fetchDirectorDirectRequest,
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

	async sendChatRequest(modelId: string, messages: IChatMessage[], _from: ExtensionIdentifier | undefined, options: ILanguageModelChatRequestOptions, token: CancellationToken): Promise<ILanguageModelChatResponse> {
		const selection = parseDirectorLanguageModelIdentifier(modelId);
		const stream = new AsyncIterableSource<IChatResponsePart>(() => {
			if (!result.isSettled) {
				cancel();
			}
		});
		const result = new DeferredPromise<DirectorTokenUsage | undefined>();
		const abortController = new AbortController();
		const store = new DisposableStore();
		const cancel = () => {
			abortController.abort();
			stream.reject(new CancellationError());
			void result.cancel();
		};
		store.add(token.onCancellationRequested(cancel));

		void (async () => {
			try {
				const response = await this._sendDirectProviderRequest(selection, messages, options, abortController.signal);
				if (response.thinking) {
					stream.emitOne({ type: 'thinking', value: response.thinking });
				}
				if (response.text) {
					stream.emitOne({ type: 'text', value: response.text });
				}
				for (const toolCall of response.toolCalls) {
					stream.emitOne({
						type: 'tool_use',
						name: toolCall.name,
						toolCallId: toolCall.id,
						parameters: parseToolInput(toolCall.input),
					});
				}
				stream.resolve();
				await result.complete(response.usage);
			} catch (err) {
				const error = err instanceof Error ? err : new Error(String(err));
				stream.reject(error);
				await result.error(error);
			} finally {
				store.dispose();
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

	private async _sendDirectProviderRequest(
		selection: { readonly providerInstanceId: string; readonly modelId: string },
		messages: readonly IChatMessage[],
		options: ILanguageModelChatRequestOptions,
		abortSignal: AbortSignal,
	): Promise<ParsedDirectorDirectResponse> {
		const provider = await this._registryService.getProvider(selection.providerInstanceId);
		if (!provider || !provider.enabled) {
			throw new Error(`Director provider '${selection.providerInstanceId}' is not enabled.`);
		}
		const apiType = toRuntimeProviderApiType(provider.apiType);
		const models = await this._modelResolverService.resolveModels(provider);
		const model = models.find(candidate => candidate.id === selection.modelId || candidate.providerModelId === selection.modelId);
		const providerModelId = model?.providerModelId ?? selection.modelId;
		const credential = await this._runtimeCredentialService.resolveCredential({
			providerInstanceId: provider.id,
			authKind: provider.authKind,
			authStateKind: await this._providerAuthStateKind(provider),
		});
		const authHeader = credentialAuthHeader(credential, provider.id);
		const request = buildDirectorNativeMessageRequest({
			apiType,
			baseURL: provider.baseURL ?? defaultBaseURL(apiType),
			modelId: providerModelId,
			authHeader,
			messages: toDirectorNormalizedMessages(messages),
			tools: normalizeRequestTools(options),
			maxTokens: model?.maxOutputTokens ?? 2048,
			stream: false,
			...(shouldUseOpenAIReasoningEcho(provider.kind, apiType) ? { reasoningEcho: { field: 'reasoning_content', includeEmpty: true } } : {}),
		});
		const response = await this._fetch(request.url, {
			method: request.method,
			headers: { ...(provider.headers ?? {}), ...request.headers },
			body: request.body,
			signal: abortSignal,
		});
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(`Director provider '${provider.id}' returned ${response.status} ${response.statusText}${text ? `: ${redactCredential(text, authHeader)}` : ''}`);
		}
		const payload = await response.json() as unknown;
		return parseDirectorDirectResponse(apiType, payload);
	}

	private async _providerAuthStateKind(provider: DirectorStoredProviderInstance): Promise<DirectorProviderAuthStateKind> {
		switch (provider.authKind) {
			case 'api-key':
			case 'bearer':
				return (await this._apiKeyService.getAuthState(provider)).kind;
			case 'oauth':
				return (await this._oauthService.getAuthState(provider)).kind;
			case 'none':
				return 'ready';
		}
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

export function createDirectorLanguageModelProviderDescriptor() {
	return {
		vendor: DirectorLanguageModelVendor,
		displayName: DirectorLanguageModelDisplayName,
		managementCommand: DirectorLanguageModelManagementCommand,
		when: undefined,
		configuration: undefined,
	};
}

type DirectorDirectFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface ParsedDirectorDirectResponse {
	readonly text: string;
	readonly thinking?: string;
	readonly usage?: DirectorTokenUsage;
	readonly toolCalls: readonly DirectorNormalizedToolCall[];
}

function fetchDirectorDirectRequest(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	return fetch(input, init);
}

function toRuntimeProviderApiType(apiType: DirectorProviderApiType | undefined): DirectorRuntimeProviderApiType {
	switch (apiType) {
		case 'anthropic-messages':
		case 'openai-completions':
		case 'openai-codex':
		case 'gemini-generative':
			return apiType;
		case undefined:
			return 'openai-completions';
		case 'local':
		case 'custom-http':
			throw new Error(`Director provider api type '${apiType}' is not supported by the direct BYOK provider.`);
	}
}

function defaultBaseURL(apiType: DirectorRuntimeProviderApiType): string {
	switch (apiType) {
		case 'anthropic-messages':
			return 'https://api.anthropic.com';
		case 'openai-completions':
			return 'https://api.openai.com/v1';
		case 'openai-codex':
			return 'https://chatgpt.com/backend-api/codex';
		case 'gemini-generative':
			return 'https://generativelanguage.googleapis.com/v1beta';
	}
}

function credentialAuthHeader(credential: DirectorRuntimeCredential, providerInstanceId: string): string {
	switch (credential.kind) {
		case 'api-key':
			return credential.value;
		case 'bearer':
			return credential.accessToken;
		case 'none':
			return '';
		case 'missing':
			throw new Error(credential.message || `Director provider '${providerInstanceId}' credentials are not available.`);
	}
}

function toDirectorNormalizedMessages(messages: readonly IChatMessage[]): readonly DirectorNormalizedMessage[] {
	const normalized: DirectorNormalizedMessage[] = [];
	for (const message of messages) {
		const textParts: string[] = [];
		const thinkingParts: string[] = [];
		const toolCalls: DirectorNormalizedToolCall[] = [];
		const toolResults: DirectorNormalizedMessage[] = [];
		for (const part of message.content) {
			switch (part.type) {
				case 'text':
					textParts.push(part.value);
					break;
				case 'thinking':
					thinkingParts.push(Array.isArray(part.value) ? part.value.join('') : part.value);
					break;
				case 'tool_use':
					toolCalls.push({ id: part.toolCallId, name: part.name, input: stableStringify(part.parameters) });
					break;
				case 'tool_result':
					toolResults.push({
						role: 'tool',
						content: part.value.map(value => value.type === 'text' ? value.value : `[${value.type}]`).join('\n'),
						toolCallId: part.toolCallId,
						isError: part.isError,
					});
					break;
				case 'image_url':
					textParts.push(`[image ${part.value.mimeType}]`);
					break;
				case 'data':
					textParts.push(`[data ${part.mimeType}]`);
					break;
			}
		}
		const content = textParts.filter(Boolean).join('\n');
		if (toolCalls.length || content || thinkingParts.length || !toolResults.length) {
			normalized.push({
				role: toDirectorRole(message.role),
				content,
				...(thinkingParts.length ? { thinking: thinkingParts.join('') } : {}),
				...(toolCalls.length ? { toolCalls } : {}),
			});
		}
		normalized.push(...toolResults);
	}
	return normalized;
}

function toDirectorRole(role: ChatMessageRole): DirectorNormalizedMessage['role'] {
	switch (role) {
		case ChatMessageRole.System:
			return 'system';
		case ChatMessageRole.User:
			return 'user';
		case ChatMessageRole.Assistant:
			return 'assistant';
	}
}

function normalizeRequestTools(options: ILanguageModelChatRequestOptions): readonly DirectorNormalizedToolDefinition[] {
	const tools = Array.isArray(options.tools) ? options.tools : [];
	return tools.flatMap((tool): DirectorNormalizedToolDefinition[] => {
		if (!tool || typeof tool.name !== 'string') {
			return [];
		}
		return [{
			name: tool.name,
			...(typeof tool.description === 'string' ? { description: tool.description } : {}),
			inputSchema: normalizeInputSchema(tool.inputSchema),
		}];
	});
}

function normalizeInputSchema(value: unknown): DirectorNormalizedToolDefinition['inputSchema'] {
	if (isRecord(value) && value.type === 'object') {
		return value as DirectorNormalizedToolDefinition['inputSchema'];
	}
	return { type: 'object', properties: {} };
}

function parseDirectorDirectResponse(apiType: DirectorRuntimeProviderApiType, payload: unknown): ParsedDirectorDirectResponse {
	const value = isRecord(payload) ? payload : undefined;
	if (!value) {
		return { text: '', toolCalls: [] };
	}
	switch (apiType) {
		case 'anthropic-messages':
			return {
				text: readAnthropicText(value),
				usage: readAnthropicUsage(value),
				toolCalls: readAnthropicToolCalls(value),
			};
		case 'openai-completions':
			return readOpenAIChatResponse(value);
		case 'openai-codex':
			return readOpenAIResponsesResponse(value);
		case 'gemini-generative':
			return {
				text: readGeminiText(value),
				usage: readGeminiUsage(value),
				toolCalls: readGeminiToolCalls(value),
			};
	}
}

function readOpenAIChatResponse(value: Record<string, unknown>): ParsedDirectorDirectResponse {
	const choice = isRecord(arrayField(value, 'choices')[0]) ? arrayField(value, 'choices')[0] as Record<string, unknown> : undefined;
	const message = isRecord(choice?.message) ? choice.message : undefined;
	const usage = isRecord(value.usage) ? value.usage : undefined;
	return {
		text: stringField(message, 'content') ?? '',
		thinking: stringField(message, 'reasoning_content'),
		usage: usage ? {
			input_tokens: numberField(usage, 'prompt_tokens') ?? 0,
			output_tokens: numberField(usage, 'completion_tokens') ?? 0,
		} : undefined,
		toolCalls: readOpenAIToolCalls(message),
	};
}

function readOpenAIToolCalls(message: Record<string, unknown> | undefined): readonly DirectorNormalizedToolCall[] {
	return arrayField(message, 'tool_calls').flatMap(toolCall => {
		const record = isRecord(toolCall) ? toolCall : undefined;
		const fn = isRecord(record?.function) ? record.function : undefined;
		const id = stringField(record, 'id');
		const name = stringField(fn, 'name');
		if (!id || !name) {
			return [];
		}
		return [{ id, name, input: stringField(fn, 'arguments') ?? '{}' }];
	});
}

function readAnthropicText(value: Record<string, unknown>): string {
	return arrayField(value, 'content').map(block => {
		const record = isRecord(block) ? block : undefined;
		return stringField(record, 'type') === 'text' || stringField(record, 'text') !== undefined ? stringField(record, 'text') : undefined;
	}).filter(Boolean).join('');
}

function readAnthropicUsage(value: Record<string, unknown>): DirectorTokenUsage | undefined {
	const usage = isRecord(value.usage) ? value.usage : undefined;
	if (!usage) {
		return undefined;
	}
	return {
		input_tokens: numberField(usage, 'input_tokens') ?? 0,
		output_tokens: numberField(usage, 'output_tokens') ?? 0,
		cache_read_input_tokens: numberField(usage, 'cache_read_input_tokens'),
	};
}

function readAnthropicToolCalls(value: Record<string, unknown>): readonly DirectorNormalizedToolCall[] {
	return arrayField(value, 'content').flatMap(block => {
		const record = isRecord(block) ? block : undefined;
		if (!record || stringField(record, 'type') !== 'tool_use') {
			return [];
		}
		const id = stringField(record, 'id');
		const name = stringField(record, 'name');
		if (!id || !name) {
			return [];
		}
		return [{ id, name, input: stableStringify(record.input) }];
	});
}

function readOpenAIResponsesResponse(value: Record<string, unknown>): ParsedDirectorDirectResponse {
	const outputText = stringField(value, 'output_text');
	return {
		text: outputText ?? arrayField(value, 'output').flatMap(item => {
			const content = arrayField(isRecord(item) ? item : undefined, 'content');
			return content.map(block => stringField(isRecord(block) ? block : undefined, 'text') ?? stringField(isRecord(block) ? block : undefined, 'content')).filter((entry): entry is string => !!entry);
		}).join(''),
		usage: readOpenAIResponsesUsage(value),
		toolCalls: readOpenAIResponsesToolCalls(value),
	};
}

function readOpenAIResponsesUsage(value: Record<string, unknown>): DirectorTokenUsage | undefined {
	const usage = isRecord(value.usage) ? value.usage : undefined;
	if (!usage) {
		return undefined;
	}
	return {
		input_tokens: numberField(usage, 'input_tokens') ?? 0,
		output_tokens: numberField(usage, 'output_tokens') ?? 0,
	};
}

function readOpenAIResponsesToolCalls(value: Record<string, unknown>): readonly DirectorNormalizedToolCall[] {
	return arrayField(value, 'output').flatMap((item, index) => {
		const record = isRecord(item) ? item : undefined;
		if (!record || stringField(record, 'type') !== 'function_call') {
			return [];
		}
		const name = stringField(record, 'name');
		if (!name) {
			return [];
		}
		return [{
			id: stringField(record, 'call_id') ?? stringField(record, 'id') ?? `director_tool_${index}`,
			name,
			input: stringField(record, 'arguments') ?? '{}',
		}];
	});
}

function readGeminiText(value: Record<string, unknown>): string {
	return arrayField(value, 'candidates').flatMap(candidate => {
		const record = isRecord(candidate) ? candidate : undefined;
		const content = isRecord(record?.content) ? record.content : undefined;
		const parts = arrayField(content, 'parts');
		return parts.map(part => stringField(isRecord(part) ? part : undefined, 'text')).filter((entry): entry is string => !!entry);
	}).join('');
}

function readGeminiUsage(value: Record<string, unknown>): DirectorTokenUsage | undefined {
	const metadata = isRecord(value.usageMetadata) ? value.usageMetadata : undefined;
	if (!metadata) {
		return undefined;
	}
	return {
		input_tokens: numberField(metadata, 'promptTokenCount') ?? 0,
		output_tokens: numberField(metadata, 'candidatesTokenCount') ?? 0,
	};
}

function readGeminiToolCalls(value: Record<string, unknown>): readonly DirectorNormalizedToolCall[] {
	return arrayField(value, 'candidates').flatMap((candidate, candidateIndex) => {
		const content = isRecord(candidate) && isRecord(candidate.content) ? candidate.content : undefined;
		return arrayField(content, 'parts').flatMap((part, partIndex) => {
			const functionCall = isRecord(part) && isRecord(part.functionCall) ? part.functionCall : undefined;
			const name = stringField(functionCall, 'name');
			if (!name) {
				return [];
			}
			return [{
				id: `gemini_${candidateIndex}_${partIndex}`,
				name,
				input: stableStringify(functionCall?.args ?? {}),
			}];
		});
	});
}

function parseToolInput(input: string): unknown {
	try {
		return JSON.parse(input) as unknown;
	} catch {
		return { input };
	}
}

function arrayField(value: Record<string, unknown> | undefined, key: string): readonly unknown[] {
	const entry = value?.[key];
	return Array.isArray(entry) ? entry : [];
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
	const entry = value?.[key];
	return typeof entry === 'string' ? entry : undefined;
}

function numberField(value: Record<string, unknown> | undefined, key: string): number | undefined {
	const entry = value?.[key];
	return typeof entry === 'number' ? entry : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function redactCredential(value: string, credential: string): string {
	return credential ? value.split(credential).join('<redacted>') : value;
}

function shouldUseOpenAIReasoningEcho(providerKind: DirectorStoredProviderInstance['kind'], apiType: DirectorRuntimeProviderApiType): boolean {
	return apiType === 'openai-completions' && providerKind === 'openai-compatible';
}
