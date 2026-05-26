/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationError } from '../../../../base/common/errors.js';
import { ResponsePartKind, type MessageAttachment, type Turn, type UsageInfo } from '../../common/state/sessionState.js';
import { buildDirectorNativeMessageRequest, type DirectorNormalizedMessage } from '../../common/directorProviderAdapters.js';
import type { DirectorResolvedProviderBackend } from '../../common/directorProviderBackend.js';
import type { DirectorRuntimeCredential, IDirectorRuntimeCredentialService } from '../../common/directorRuntimeCredentials.js';

export type DirectorAgentEngineEvent =
	| { readonly type: 'system'; readonly message: string }
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'thinking'; readonly thinking: string }
	| { readonly type: 'usage'; readonly usage: UsageInfo }
	| { readonly type: 'result'; readonly subtype: 'success' };

export interface DirectorAgentEngineTurnOptions {
	readonly backend: DirectorResolvedProviderBackend;
	readonly prompt: string;
	readonly attachments?: readonly MessageAttachment[];
	readonly turns: readonly Turn[];
	readonly cwd?: string;
	readonly abortSignal: AbortSignal;
}

type DirectorFetch = (input: string, init: RequestInit) => Promise<Response>;

export class DirectorAgentEngineAdapter {

	constructor(
		private readonly credentialService: IDirectorRuntimeCredentialService,
		private readonly fetcher: DirectorFetch = (input, init) => fetch(input, init),
	) { }

	async *runTurn(options: DirectorAgentEngineTurnOptions): AsyncGenerator<DirectorAgentEngineEvent> {
		const backend = options.backend;
		const credential = await this.resolveCredential(backend);
		if (options.abortSignal.aborted) {
			throw new CancellationError();
		}
		if (credential.kind === 'missing') {
			throw new Error(credential.message);
		}
		if (backend.apiType === 'local' || backend.apiType === 'custom-http') {
			throw new Error(`Director provider '${backend.providerInstanceId}' uses '${backend.apiType}', which is not supported by the Phase 4 AgentEngine adapter yet.`);
		}
		if (!backend.baseURL) {
			throw new Error(`Director provider '${backend.providerInstanceId}' does not have a base URL.`);
		}

		yield {
			type: 'system',
			message: `Director AgentEngine using provider '${backend.providerInstanceId}' with model '${backend.modelId}'.`,
		};

		const request = buildDirectorNativeMessageRequest({
			apiType: backend.apiType,
			baseURL: backend.baseURL,
			modelId: backend.modelId,
			authHeader: credentialToHeaderValue(credential),
			messages: this.buildMessages(options),
			maxTokens: 2048,
			stream: false,
		});
		const headers = { ...backend.headers, ...request.headers };
		const response = await this.fetcher(request.url, {
			method: request.method,
			headers,
			body: request.body,
			signal: options.abortSignal,
		});
		if (options.abortSignal.aborted) {
			throw new CancellationError();
		}
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(`Director provider '${backend.providerInstanceId}' returned ${response.status} ${response.statusText}${text ? `: ${redactCredential(text, credential)}` : ''}`);
		}

		const payload = await response.json() as unknown;
		const parsed = parseProviderResponse(backend.apiType, payload);
		if (parsed.thinking) {
			yield { type: 'thinking', thinking: parsed.thinking };
		}
		if (!parsed.text.trim()) {
			throw new Error(`Director provider '${backend.providerInstanceId}' returned an empty response.`);
		}
		yield { type: 'text', text: parsed.text };
		if (parsed.usage) {
			yield { type: 'usage', usage: parsed.usage };
		}
		yield { type: 'result', subtype: 'success' };
	}

	private async resolveCredential(backend: DirectorResolvedProviderBackend): Promise<DirectorRuntimeCredential> {
		if (backend.authKind === 'none') {
			return { kind: 'none' };
		}
		return this.credentialService.resolveCredential({
			providerInstanceId: backend.providerInstanceId,
			authKind: backend.authKind,
			authStateKind: backend.authState.kind,
		});
	}

	private buildMessages(options: DirectorAgentEngineTurnOptions): readonly DirectorNormalizedMessage[] {
		const messages: DirectorNormalizedMessage[] = [{
			role: 'system',
			content: buildDirectorSystemPrompt(options.cwd),
		}];

		for (const turn of options.turns.slice(-16)) {
			if (turn.userMessage.text) {
				messages.push({ role: 'user', content: turn.userMessage.text });
			}
			const assistantText = turn.responseParts
				.filter(part => part.kind === ResponsePartKind.Markdown)
				.map(part => part.content)
				.join('');
			if (assistantText.trim()) {
				messages.push({ role: 'assistant', content: assistantText });
			}
		}

		const attachmentSummary = summarizeAttachments(options.attachments);
		messages.push({
			role: 'user',
			content: attachmentSummary ? `${options.prompt}\n\n${attachmentSummary}` : options.prompt,
		});
		return messages;
	}
}

function buildDirectorSystemPrompt(cwd: string | undefined): string {
	return [
		'You are Director, an AI coding assistant running inside VS Code AgentHost.',
		'Use the selected Director provider backend for this turn.',
		cwd ? `Working directory: ${cwd}` : undefined,
	].filter((line): line is string => line !== undefined).join('\n');
}

function summarizeAttachments(attachments: readonly MessageAttachment[] | undefined): string | undefined {
	if (!attachments?.length) {
		return undefined;
	}
	return [
		'Attached context:',
		...attachments.slice(0, 20).map((attachment, index) => {
			const label = attachment.label ? ` (${attachment.label})` : '';
			return `- attachment ${index + 1}: ${attachment.type}${label}`;
		}),
	].join('\n');
}

function credentialToHeaderValue(credential: DirectorRuntimeCredential): string {
	switch (credential.kind) {
		case 'api-key':
			return credential.value;
		case 'bearer':
			return credential.accessToken;
		case 'none':
			return '';
		case 'missing':
			throw new Error(credential.message);
	}
}

interface ParsedProviderResponse {
	readonly text: string;
	readonly thinking?: string;
	readonly usage?: UsageInfo;
}

function parseProviderResponse(apiType: DirectorResolvedProviderBackend['apiType'], payload: unknown): ParsedProviderResponse {
	const value = asRecord(payload);
	if (!value) {
		return { text: '' };
	}
	switch (apiType) {
		case 'anthropic-messages':
			return {
				text: readAnthropicText(value),
				usage: readAnthropicUsage(value),
			};
		case 'openai-completions':
			return readOpenAIChatResponse(value);
		case 'openai-codex':
			return readOpenAIResponsesResponse(value);
		case 'gemini-generative':
			return {
				text: readGeminiText(value),
				usage: readGeminiUsage(value),
			};
		case 'local':
		case 'custom-http':
			throw new Error(`Unsupported Director provider api type '${apiType}'.`);
	}
}

function readAnthropicText(value: Record<string, unknown>): string {
	const content = arrayField(value, 'content');
	return content.map(block => stringField(asRecord(block), 'text')).filter(Boolean).join('');
}

function readAnthropicUsage(value: Record<string, unknown>): UsageInfo | undefined {
	const usage = asRecord(value.usage);
	if (!usage) {
		return undefined;
	}
	return {
		inputTokens: numberField(usage, 'input_tokens'),
		outputTokens: numberField(usage, 'output_tokens'),
		cacheReadTokens: numberField(usage, 'cache_read_input_tokens'),
	};
}

function readOpenAIChatResponse(value: Record<string, unknown>): ParsedProviderResponse {
	const choice = asRecord(arrayField(value, 'choices')[0]);
	const message = asRecord(choice?.message);
	const usage = asRecord(value.usage);
	return {
		text: stringField(message, 'content') ?? '',
		thinking: stringField(message, 'reasoning_content'),
		usage: usage ? {
			inputTokens: numberField(usage, 'prompt_tokens'),
			outputTokens: numberField(usage, 'completion_tokens'),
		} : undefined,
	};
}

function readOpenAIResponsesResponse(value: Record<string, unknown>): ParsedProviderResponse {
	const outputText = stringField(value, 'output_text');
	if (outputText) {
		return { text: outputText, usage: readOpenAIResponsesUsage(value) };
	}

	const output = arrayField(value, 'output');
	const text = output.flatMap(item => {
		const content = arrayField(asRecord(item), 'content');
		return content.map(block => stringField(asRecord(block), 'text') ?? stringField(asRecord(block), 'content')).filter((entry): entry is string => !!entry);
	}).join('');
	return { text, usage: readOpenAIResponsesUsage(value) };
}

function readOpenAIResponsesUsage(value: Record<string, unknown>): UsageInfo | undefined {
	const usage = asRecord(value.usage);
	if (!usage) {
		return undefined;
	}
	return {
		inputTokens: numberField(usage, 'input_tokens'),
		outputTokens: numberField(usage, 'output_tokens'),
	};
}

function readGeminiText(value: Record<string, unknown>): string {
	const candidate = asRecord(arrayField(value, 'candidates')[0]);
	const content = asRecord(candidate?.content);
	return arrayField(content, 'parts')
		.map(part => stringField(asRecord(part), 'text'))
		.filter(Boolean)
		.join('');
}

function readGeminiUsage(value: Record<string, unknown>): UsageInfo | undefined {
	const usage = asRecord(value.usageMetadata);
	if (!usage) {
		return undefined;
	}
	return {
		inputTokens: numberField(usage, 'promptTokenCount'),
		outputTokens: numberField(usage, 'candidatesTokenCount'),
	};
}

function redactCredential(value: string, credential: DirectorRuntimeCredential): string {
	switch (credential.kind) {
		case 'api-key':
			return value.split(credential.value).join('<redacted>');
		case 'bearer':
			return value.split(credential.accessToken).join('<redacted>');
		case 'none':
		case 'missing':
			return value;
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function arrayField(value: Record<string, unknown> | undefined, key: string): readonly unknown[] {
	const field = value?.[key];
	return Array.isArray(field) ? field : [];
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
	const field = value?.[key];
	return typeof field === 'string' ? field : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
	const field = value[key];
	return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}
