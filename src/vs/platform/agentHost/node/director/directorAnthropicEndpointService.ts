/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as http from 'http';
import { once } from 'events';
import { AddressInfo } from 'net';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../instantiation/common/instantiation.js';
import { ILogService } from '../../../log/common/log.js';
import { DirectorBackendResolution, DirectorProviderModel, DirectorProviderSelection, DirectorResolvedProviderBackend, IDirectorProviderBackendHub, isResolvedBackend } from '../../common/directorProviderBackend.js';
import { DirectorCreateMessageParams, DirectorCreateMessageResponse, DirectorLLMProvider, DirectorNormalizedResponseBlock, DirectorProviderFetch, DirectorProviderRuntimeAuth, DirectorProviderStreamEvent, DirectorRuntimeProviderApiType, DirectorTokenUsage } from '../../common/directorProviderRuntime.js';
import { DirectorNormalizedMessage, DirectorNormalizedToolCall, DirectorNormalizedToolDefinition } from '../../common/directorProviderAdapters.js';
import { DirectorRuntimeCredential, IDirectorRuntimeCredentialService } from '../../common/directorRuntimeCredentials.js';
import { buildErrorEnvelope, formatSseErrorFrame, writeJsonError } from '../claude/anthropicErrors.js';
import { parseProxyBearer } from '../claude/claudeProxyAuth.js';
import { createDirectorProviderRuntime } from './providers/directorProviderRuntimeFactory.js';

export interface IDirectorAnthropicEndpointHandle extends IDisposable {
	readonly baseUrl: string;
	readonly nonce: string;
}

export interface DirectorAnthropicEndpointStartOptions {
	readonly providerInstanceId?: string;
	readonly modelId?: string;
	readonly sessionId?: string;
}

export interface IDirectorAnthropicEndpointService {
	readonly _serviceBrand: undefined;
	start(options?: DirectorAnthropicEndpointStartOptions): Promise<IDirectorAnthropicEndpointHandle>;
	dispose(): void;
}

export const IDirectorAnthropicEndpointService = createDecorator<IDirectorAnthropicEndpointService>('directorAnthropicEndpointService');

interface IInFlight {
	readonly ac: AbortController;
	readonly res: http.ServerResponse;
	clientGone: boolean;
}

interface IEndpointRuntime {
	readonly server: http.Server;
	readonly baseUrl: string;
	readonly nonce: string;
	readonly inFlight: Set<IInFlight>;
	readonly sessionSelections: Map<string, DirectorProviderSelection>;
	defaultSelection: DirectorProviderSelection;
	refcount: number;
}

const DIRECTOR_ANTHROPIC_ENDPOINT_NAME = 'DirectorAnthropicEndpointService';
const DEFAULT_MAX_TOKENS = 2048;

export class DirectorAnthropicEndpointService implements IDirectorAnthropicEndpointService {
	declare readonly _serviceBrand: undefined;

	private _runtime: IEndpointRuntime | undefined;
	private _starting: Promise<IEndpointRuntime> | undefined;
	private _disposed = false;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IDirectorProviderBackendHub private readonly _backendHub: IDirectorProviderBackendHub,
		@IDirectorRuntimeCredentialService private readonly _credentialService: IDirectorRuntimeCredentialService,
		private readonly _fetcher: DirectorProviderFetch = (input, init) => fetch(input, init),
	) { }

	async start(options: DirectorAnthropicEndpointStartOptions = {}): Promise<IDirectorAnthropicEndpointHandle> {
		if (this._disposed) {
			throw new Error(`${DIRECTOR_ANTHROPIC_ENDPOINT_NAME} has been disposed`);
		}

		const runtime = await this._ensureRuntime(options);
		if (this._disposed || this._runtime !== runtime) {
			throw new Error(`${DIRECTOR_ANTHROPIC_ENDPOINT_NAME} has been disposed`);
		}

		const selection = toProviderSelection(options);
		runtime.defaultSelection = selection;
		if (options.sessionId) {
			runtime.sessionSelections.set(options.sessionId, selection);
		}
		runtime.refcount++;

		let disposed = false;
		return {
			baseUrl: runtime.baseUrl,
			nonce: runtime.nonce,
			dispose: () => {
				if (disposed) {
					return;
				}
				disposed = true;
				if (options.sessionId && runtime.sessionSelections.get(options.sessionId) === selection) {
					runtime.sessionSelections.delete(options.sessionId);
				}
				this._releaseHandle(runtime);
			},
		};
	}

	dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this._teardownRuntime();
	}

	private _ensureRuntime(options: DirectorAnthropicEndpointStartOptions): Promise<IEndpointRuntime> {
		if (this._runtime) {
			return Promise.resolve(this._runtime);
		}
		if (!this._starting) {
			this._starting = (async () => {
				try {
					const runtime = await this._startServer(toProviderSelection(options));
					if (this._disposed) {
						runtime.server.close();
						throw new Error(`${DIRECTOR_ANTHROPIC_ENDPOINT_NAME} has been disposed`);
					}
					this._runtime = runtime;
					return runtime;
				} finally {
					this._starting = undefined;
				}
			})();
		}
		return this._starting;
	}

	private async _startServer(defaultSelection: DirectorProviderSelection, attempt = 0): Promise<IEndpointRuntime> {
		const { createServer } = await import('http');
		const nonce = generateNonce();
		const inFlight = new Set<IInFlight>();
		const runtime: IEndpointRuntime = {
			server: undefined as unknown as http.Server,
			baseUrl: '',
			nonce,
			inFlight,
			sessionSelections: new Map(),
			defaultSelection,
			refcount: 0,
		};
		const server = createServer((req, res) => void this._handleRequest(req, res, runtime).catch(err => {
			this._logService.error(`[${DIRECTOR_ANTHROPIC_ENDPOINT_NAME}] request failed`, err);
			if (!res.headersSent) {
				writeJsonError(res, 500, 'api_error', stringifyError(err));
			} else if (!res.writableEnded) {
				try {
					res.end();
				} catch { /* ignore */ }
			}
		}));
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => {
				server.off('error', reject);
				resolve();
			});
		});
		const address = server.address() as AddressInfo;
		if (isFetchForbiddenPort(address.port)) {
			await new Promise<void>(resolve => server.close(() => resolve()));
			if (attempt >= 20) {
				throw new Error(`${DIRECTOR_ANTHROPIC_ENDPOINT_NAME} could not bind to a fetch-safe loopback port`);
			}
			return this._startServer(defaultSelection, attempt + 1);
		}
		return {
			...runtime,
			server,
			baseUrl: `http://127.0.0.1:${address.port}`,
		};
	}

	private _releaseHandle(runtime: IEndpointRuntime): void {
		if (this._runtime !== runtime) {
			return;
		}
		runtime.refcount--;
		if (runtime.refcount <= 0) {
			this._teardownRuntime();
		}
	}

	private _teardownRuntime(): void {
		const runtime = this._runtime;
		this._runtime = undefined;
		if (!runtime) {
			return;
		}
		for (const entry of runtime.inFlight) {
			entry.ac.abort();
			if (!entry.clientGone && !entry.res.writableEnded) {
				try {
					entry.res.destroy();
				} catch { /* ignore */ }
			}
		}
		runtime.inFlight.clear();
		runtime.sessionSelections.clear();
		try {
			runtime.server.close();
		} catch { /* ignore */ }
	}

	private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse, runtime: IEndpointRuntime): Promise<void> {
		const method = req.method ?? 'GET';
		const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
		this._logService.trace(`[${DIRECTOR_ANTHROPIC_ENDPOINT_NAME}] ${method} ${pathname}`);

		if (method === 'GET' && pathname === '/') {
			res.writeHead(200, { 'Content-Type': 'text/plain' });
			res.end('ok');
			return;
		}

		const auth = parseProxyBearer(req.headers, runtime.nonce);
		if (!auth.valid || !auth.sessionId) {
			writeJsonError(res, 401, 'authentication_error', 'Invalid authentication');
			return;
		}

		if (method === 'GET' && pathname === '/v1/models') {
			await this._handleModels(res, runtime, auth.sessionId);
			return;
		}

		if (method === 'POST' && pathname === '/v1/messages') {
			await this._handleMessages(req, res, runtime, auth.sessionId);
			return;
		}

		if (method === 'POST' && pathname === '/v1/messages/count_tokens') {
			writeJsonError(res, 501, 'api_error', 'count_tokens not supported by Director provider endpoint');
			return;
		}

		writeJsonError(res, 404, 'not_found_error', `No route for ${method} ${pathname}`);
	}

	private async _handleModels(res: http.ServerResponse, runtime: IEndpointRuntime, sessionId: string): Promise<void> {
		const selection = runtime.sessionSelections.get(sessionId) ?? runtime.defaultSelection;
		const models = await this._backendHub.listModels(selection.providerInstanceId);
		const data = models.map(model => ({
			id: model.providerModelId ?? model.id,
			type: 'model',
			display_name: model.name || model.providerModelId || model.id,
			created_at: '1970-01-01T00:00:00Z',
			capabilities: null,
			max_input_tokens: model.maxContextWindow ?? null,
			max_tokens: model.maxOutputTokens ?? null,
		}));
		const body = {
			data,
			has_more: false,
			first_id: data.length > 0 ? data[0].id : null,
			last_id: data.length > 0 ? data[data.length - 1].id : null,
		};
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(body));
	}

	private async _handleMessages(req: http.IncomingMessage, res: http.ServerResponse, runtime: IEndpointRuntime, sessionId: string): Promise<void> {
		const body = await this._readJsonBody(req, res);
		if (!body) {
			return;
		}

		const sdkModelId = stringField(body, 'model');
		if (!sdkModelId) {
			writeJsonError(res, 400, 'invalid_request_error', 'Missing required field: model');
			return;
		}
		if (!Array.isArray(body.messages)) {
			writeJsonError(res, 400, 'invalid_request_error', 'Missing required field: messages');
			return;
		}

		const selection = runtime.sessionSelections.get(sessionId) ?? runtime.defaultSelection;
		const resolution = await this._resolveBackendForRequest(selection, sdkModelId);
		if (!isResolvedBackend(resolution)) {
			this._writeResolutionError(res, resolution);
			return;
		}
		const backend = resolution.backend;
		const provider = await this._createProviderRuntime(backend, res);
		if (!provider) {
			return;
		}

		const entry: IInFlight = {
			ac: new AbortController(),
			res,
			clientGone: false,
		};
		runtime.inFlight.add(entry);
		const onClose = () => {
			entry.clientGone = true;
			entry.ac.abort();
		};
		res.on('close', onClose);

		const request = toDirectorCreateMessageParams(body, backend.modelId, entry.ac.signal);
		try {
			if (body.stream === true && supportsEndpointStreaming(backend)) {
				await this._streamMessages(provider, request, res, entry, sdkModelId);
			} else {
				await this._sendNonStreamingMessage(provider, request, res, entry, sdkModelId);
			}
		} finally {
			res.removeListener('close', onClose);
			runtime.inFlight.delete(entry);
		}
	}

	private async _readJsonBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<Record<string, unknown> | undefined> {
		let bodyString: string;
		try {
			bodyString = await readRequestBody(req);
		} catch (err) {
			writeJsonError(res, 400, 'invalid_request_error', `Failed to read request body: ${stringifyError(err)}`);
			return undefined;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(bodyString);
		} catch {
			writeJsonError(res, 400, 'invalid_request_error', 'Request body is not valid JSON');
			return undefined;
		}
		if (!isRecord(parsed)) {
			writeJsonError(res, 400, 'invalid_request_error', 'Request body must be a JSON object');
			return undefined;
		}
		return parsed;
	}

	private async _resolveBackendForRequest(selection: DirectorProviderSelection, sdkModelId: string): Promise<DirectorBackendResolution> {
		if (selection.modelId) {
			return this._backendHub.resolveBackend(selection);
		}

		const model = await this._findModel(selection.providerInstanceId, sdkModelId);
		if (model) {
			return this._backendHub.resolveBackend({ providerInstanceId: model.providerInstanceId, modelId: model.id });
		}

		if (selection.providerInstanceId) {
			return this._backendHub.resolveBackend({ providerInstanceId: selection.providerInstanceId });
		}

		return this._backendHub.resolveBackend({ modelId: sdkModelId });
	}

	private async _findModel(providerInstanceId: string | undefined, sdkModelId: string): Promise<DirectorProviderModel | undefined> {
		const models = await this._backendHub.listModels(providerInstanceId);
		return models.find(model =>
			model.id === sdkModelId
			|| model.providerModelId === sdkModelId
			|| model.name === sdkModelId
		);
	}

	private async _createProviderRuntime(backend: DirectorResolvedProviderBackend, res: http.ServerResponse): Promise<DirectorLLMProvider | undefined> {
		if (backend.apiType === 'local' || backend.apiType === 'custom-http') {
			writeJsonError(res, 400, 'invalid_request_error', `Director provider '${backend.providerInstanceId}' uses '${backend.apiType}', which is not supported by the Anthropic endpoint.`);
			return undefined;
		}
		if (!backend.baseURL) {
			writeJsonError(res, 400, 'invalid_request_error', `Director provider '${backend.providerInstanceId}' does not have a base URL.`);
			return undefined;
		}

		const credential = await this._resolveCredential(backend);
		if (credential.kind === 'missing') {
			writeJsonError(res, 401, 'authentication_error', credential.message);
			return undefined;
		}

		return createDirectorProviderRuntime(toRuntimeProviderApiType(backend.apiType), {
			auth: credentialToRuntimeAuth(credential),
			baseURL: backend.baseURL,
			headers: backend.headers,
			capabilities: backend.capabilities,
			label: `Director provider '${backend.providerInstanceId}'`,
			fetch: this._fetcher,
		});
	}

	private async _resolveCredential(backend: DirectorResolvedProviderBackend): Promise<DirectorRuntimeCredential> {
		if (backend.authKind === 'none') {
			return { kind: 'none' };
		}
		return this._credentialService.resolveCredential({
			providerInstanceId: backend.providerInstanceId,
			authKind: backend.authKind,
			authStateKind: backend.authState.kind,
		});
	}

	private _writeResolutionError(res: http.ServerResponse, resolution: Exclude<DirectorBackendResolution, { readonly status: 'ok'; readonly backend: DirectorResolvedProviderBackend }>): void {
		switch (resolution.status) {
			case 'missingAuth':
				writeJsonError(res, 401, 'authentication_error', resolution.message);
				return;
			case 'disabled':
				writeJsonError(res, 403, 'permission_error', resolution.message);
				return;
			case 'modelUnavailable':
				writeJsonError(res, 404, 'not_found_error', resolution.message);
				return;
			case 'error':
				writeJsonError(res, 404, 'not_found_error', resolution.message);
				return;
		}
	}

	private async _sendNonStreamingMessage(provider: DirectorLLMProvider, request: DirectorCreateMessageParams, res: http.ServerResponse, entry: IInFlight, sdkModelId: string): Promise<void> {
		let response: DirectorCreateMessageResponse;
		try {
			response = await provider.createMessage(request);
		} catch (err) {
			if (entry.ac.signal.aborted) {
				this._endAbortedResponse(res, entry);
				return;
			}
			writeJsonError(res, 502, 'api_error', stringifyError(err));
			return;
		}

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(toAnthropicMessage(response, sdkModelId)));
	}

	private async _streamMessages(provider: DirectorLLMProvider, request: DirectorCreateMessageParams, res: http.ServerResponse, entry: IInFlight, sdkModelId: string): Promise<void> {
		const stream = provider.createMessageStream?.(request);
		if (!stream) {
			const response = await provider.createMessage(request);
			this._writeSyntheticStreamFromMessage(res, response, sdkModelId);
			return;
		}

		let first: IteratorResult<DirectorProviderStreamEvent>;
		try {
			first = await stream.next();
		} catch (err) {
			if (entry.ac.signal.aborted) {
				this._endAbortedResponse(res, entry);
				return;
			}
			writeJsonError(res, 502, 'api_error', stringifyError(err));
			return;
		}

		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive',
		});
		res.flushHeaders();
		setNoDelay(res);

		const state = new AnthropicStreamState(sdkModelId);
		if (!await writeFrame(res, entry, 'message_start', state.messageStart())) {
			return;
		}

		try {
			if (!first.done && !await this._writeProviderStreamEvent(res, entry, state, first.value)) {
				return;
			}
			while (true) {
				let next: IteratorResult<DirectorProviderStreamEvent>;
				try {
					next = await stream.next();
				} catch (err) {
					if (entry.ac.signal.aborted) {
						this._endAbortedResponse(res, entry);
						return;
					}
					if (!res.writableEnded) {
						res.write(formatSseErrorFrame(buildErrorEnvelope('api_error', stringifyError(err))));
						res.end();
					}
					return;
				}
				if (next.done) {
					break;
				}
				if (!await this._writeProviderStreamEvent(res, entry, state, next.value)) {
					return;
				}
			}
			await this._writeStreamComplete(res, entry, state, 'end_turn');
		} catch (err) {
			this._logService.warn(`[${DIRECTOR_ANTHROPIC_ENDPOINT_NAME}] stream loop unexpected error: ${stringifyError(err)}`);
			if (!res.writableEnded) {
				try {
					res.end();
				} catch { /* ignore */ }
			}
		}
	}

	private async _writeProviderStreamEvent(res: http.ServerResponse, entry: IInFlight, state: AnthropicStreamState, event: DirectorProviderStreamEvent): Promise<boolean> {
		switch (event.type) {
			case 'text':
				return state.writeText(res, entry, event.text);
			case 'thinking':
				return state.writeThinking(res, entry, event.thinking);
			case 'tool_use_start':
				return state.writeToolStart(res, entry, event.index ?? 0, event.id, event.name);
			case 'tool_input_delta':
				return state.writeToolDelta(res, entry, event.index ?? 0, event.json);
			case 'tool_call_delta':
				return state.writeToolCallDelta(res, entry, event);
			case 'message_complete':
				return this._writeStreamComplete(res, entry, state, event.stopReason, event.usage);
		}
	}

	private async _writeStreamComplete(res: http.ServerResponse, entry: IInFlight, state: AnthropicStreamState, stopReason: string, usage?: DirectorTokenUsage): Promise<boolean> {
		if (!await state.closeOpenBlocks(res, entry)) {
			return false;
		}
		if (!await writeFrame(res, entry, 'message_delta', {
			type: 'message_delta',
			delta: {
				stop_reason: toAnthropicStopReason(stopReason),
				stop_sequence: null,
			},
			usage: toAnthropicUsage(usage),
		})) {
			return false;
		}
		if (!await writeFrame(res, entry, 'message_stop', { type: 'message_stop' })) {
			return false;
		}
		if (!res.writableEnded) {
			res.end();
		}
		return true;
	}

	private _writeSyntheticStreamFromMessage(res: http.ServerResponse, response: DirectorCreateMessageResponse, sdkModelId: string): void {
		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive',
		});
		res.flushHeaders();
		const state = new AnthropicStreamState(sdkModelId);
		const entry: IInFlight = { ac: new AbortController(), res, clientGone: false };
		void (async () => {
			await writeFrame(res, entry, 'message_start', state.messageStart());
			for (const block of response.content) {
				await state.writeBlock(res, entry, block);
			}
			await this._writeStreamComplete(res, entry, state, response.stopReason, response.usage);
		})();
	}

	private _endAbortedResponse(res: http.ServerResponse, entry: IInFlight): void {
		if (!entry.clientGone && !res.writableEnded) {
			res.destroy();
		}
	}
}

class AnthropicStreamState {
	private _nextIndex = 0;
	private _textIndex: number | undefined;
	private _thinkingIndex: number | undefined;
	private readonly _toolIndices = new Map<number, number>();
	private readonly _openBlocks = new Set<number>();
	private _completed = false;

	constructor(private readonly _model: string) { }

	messageStart(): Record<string, unknown> {
		return {
			type: 'message_start',
			message: {
				id: createAnthropicMessageId(),
				type: 'message',
				role: 'assistant',
				model: this._model,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 0, output_tokens: 0 },
			},
		};
	}

	async writeBlock(res: http.ServerResponse, entry: IInFlight, block: DirectorNormalizedResponseBlock): Promise<boolean> {
		switch (block.type) {
			case 'text':
				return this.writeText(res, entry, block.text);
			case 'thinking':
				return this.writeThinking(res, entry, block.thinking);
			case 'tool_use':
				if (!await this.writeToolStart(res, entry, this._toolIndices.size, block.toolCall.id, block.toolCall.name)) {
					return false;
				}
				return this.writeToolDelta(res, entry, this._toolIndices.size - 1, block.toolCall.input);
		}
	}

	async writeText(res: http.ServerResponse, entry: IInFlight, text: string): Promise<boolean> {
		if (!text) {
			return true;
		}
		const index = await this._ensureTextBlock(res, entry);
		return writeFrame(res, entry, 'content_block_delta', {
			type: 'content_block_delta',
			index,
			delta: { type: 'text_delta', text },
		});
	}

	async writeThinking(res: http.ServerResponse, entry: IInFlight, thinking: string): Promise<boolean> {
		if (!thinking) {
			return true;
		}
		const index = await this._ensureThinkingBlock(res, entry);
		return writeFrame(res, entry, 'content_block_delta', {
			type: 'content_block_delta',
			index,
			delta: { type: 'thinking_delta', thinking },
		});
	}

	async writeToolStart(res: http.ServerResponse, entry: IInFlight, providerIndex: number, id: string, name: string): Promise<boolean> {
		if (this._toolIndices.has(providerIndex)) {
			return true;
		}
		const index = this._nextIndex++;
		this._toolIndices.set(providerIndex, index);
		this._openBlocks.add(index);
		return writeFrame(res, entry, 'content_block_start', {
			type: 'content_block_start',
			index,
			content_block: {
				type: 'tool_use',
				id,
				name,
				input: {},
			},
		});
	}

	async writeToolDelta(res: http.ServerResponse, entry: IInFlight, providerIndex: number, json: string): Promise<boolean> {
		if (!this._toolIndices.has(providerIndex)) {
			if (!await this.writeToolStart(res, entry, providerIndex, `toolu_${providerIndex}`, 'tool')) {
				return false;
			}
		}
		return writeFrame(res, entry, 'content_block_delta', {
			type: 'content_block_delta',
			index: this._toolIndices.get(providerIndex),
			delta: { type: 'input_json_delta', partial_json: json },
		});
	}

	async writeToolCallDelta(res: http.ServerResponse, entry: IInFlight, event: Extract<DirectorProviderStreamEvent, { readonly type: 'tool_call_delta' }>): Promise<boolean> {
		const providerIndex = event.index;
		if (!this._toolIndices.has(providerIndex) && (event.id || event.name)) {
			if (!await this.writeToolStart(res, entry, providerIndex, event.id ?? `toolu_${providerIndex}`, event.name ?? 'tool')) {
				return false;
			}
		}
		if (event.arguments) {
			return this.writeToolDelta(res, entry, providerIndex, event.arguments);
		}
		return true;
	}

	async closeOpenBlocks(res: http.ServerResponse, entry: IInFlight): Promise<boolean> {
		if (this._completed) {
			return true;
		}
		this._completed = true;
		for (const index of [...this._openBlocks].sort((a, b) => a - b)) {
			if (!await writeFrame(res, entry, 'content_block_stop', { type: 'content_block_stop', index })) {
				return false;
			}
		}
		this._openBlocks.clear();
		return true;
	}

	private async _ensureTextBlock(res: http.ServerResponse, entry: IInFlight): Promise<number> {
		if (this._textIndex !== undefined) {
			return this._textIndex;
		}
		const index = this._nextIndex++;
		this._textIndex = index;
		this._openBlocks.add(index);
		await writeFrame(res, entry, 'content_block_start', {
			type: 'content_block_start',
			index,
			content_block: { type: 'text', text: '' },
		});
		return index;
	}

	private async _ensureThinkingBlock(res: http.ServerResponse, entry: IInFlight): Promise<number> {
		if (this._thinkingIndex !== undefined) {
			return this._thinkingIndex;
		}
		const index = this._nextIndex++;
		this._thinkingIndex = index;
		this._openBlocks.add(index);
		await writeFrame(res, entry, 'content_block_start', {
			type: 'content_block_start',
			index,
			content_block: { type: 'thinking', thinking: '', signature: '' },
		});
		return index;
	}
}

async function writeFrame(res: http.ServerResponse, entry: IInFlight, event: string, data: unknown): Promise<boolean> {
	if (entry.ac.signal.aborted || res.writableEnded) {
		return false;
	}
	const ok = res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	if (!ok) {
		try {
			await once(res, 'drain', { signal: entry.ac.signal });
		} catch {
			return false;
		}
	}
	return true;
}

function toProviderSelection(options: DirectorAnthropicEndpointStartOptions): DirectorProviderSelection {
	return {
		...(options.providerInstanceId !== undefined ? { providerInstanceId: options.providerInstanceId } : {}),
		...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
	};
}

function generateNonce(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	let out = '';
	for (let i = 0; i < bytes.length; i++) {
		out += bytes[i].toString(16).padStart(2, '0');
	}
	return out;
}

function isFetchForbiddenPort(port: number): boolean {
	return FetchForbiddenPorts.has(port);
}

const FetchForbiddenPorts = new Set([
	1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
	101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161,
	179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563,
	587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060,
	5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

function toDirectorCreateMessageParams(body: Record<string, unknown>, modelId: string, abortSignal: AbortSignal): DirectorCreateMessageParams {
	return {
		model: modelId,
		maxTokens: numberField(body, 'max_tokens') ?? DEFAULT_MAX_TOKENS,
		messages: toDirectorMessages(body),
		tools: toDirectorTools(body.tools),
		thinking: toDirectorThinking(body.thinking),
		abortSignal,
	};
}

function toDirectorThinking(value: unknown): DirectorCreateMessageParams['thinking'] | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const type = stringField(value, 'type');
	if (!type) {
		return undefined;
	}
	return {
		type,
		...(numberField(value, 'budget_tokens') !== undefined ? { budget_tokens: numberField(value, 'budget_tokens') } : {}),
	};
}

function toDirectorMessages(body: Record<string, unknown>): readonly DirectorNormalizedMessage[] {
	const messages: DirectorNormalizedMessage[] = [];
	const system = contentText(body.system);
	if (system) {
		messages.push({ role: 'system', content: system });
	}

	for (const item of arrayField(body, 'messages')) {
		const record = isRecord(item) ? item : undefined;
		const role = stringField(record, 'role');
		if (!record || (role !== 'user' && role !== 'assistant')) {
			continue;
		}

		const toolResults = toolResultMessages(record.content);
		const text = contentText(record.content);
		const thinking = contentThinking(record.content);
		const toolCalls = role === 'assistant' ? contentToolCalls(record.content) : [];
		if (text || thinking || toolCalls.length || !toolResults.length) {
			messages.push({
				role,
				content: text,
				...(thinking ? { thinking } : {}),
				...(toolCalls.length ? { toolCalls } : {}),
			});
		}
		messages.push(...toolResults);
	}
	return messages;
}

function toDirectorTools(value: unknown): readonly DirectorNormalizedToolDefinition[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const tools = value.flatMap((tool): DirectorNormalizedToolDefinition[] => {
		const record = isRecord(tool) ? tool : undefined;
		const name = stringField(record, 'name');
		if (!name) {
			return [];
		}
		const inputSchema = normalizeInputSchema(record?.input_schema);
		return [{
			name,
			description: stringField(record, 'description'),
			inputSchema,
		}];
	});
	return tools.length ? tools : undefined;
}

function toAnthropicMessage(response: DirectorCreateMessageResponse, model: string): Record<string, unknown> {
	return {
		id: createAnthropicMessageId(),
		type: 'message',
		role: 'assistant',
		model,
		content: response.content.map(toAnthropicContentBlock),
		stop_reason: toAnthropicStopReason(response.stopReason),
		stop_sequence: null,
		usage: toAnthropicUsage(response.usage),
	};
}

function toAnthropicContentBlock(block: DirectorNormalizedResponseBlock): Record<string, unknown> {
	switch (block.type) {
		case 'text':
			return { type: 'text', text: block.text };
		case 'thinking':
			return { type: 'thinking', thinking: block.thinking, signature: '' };
		case 'tool_use':
			return {
				type: 'tool_use',
				id: block.toolCall.id,
				name: block.toolCall.name,
				input: parseToolInput(block.toolCall.input),
			};
	}
}

function toAnthropicUsage(usage: DirectorTokenUsage | undefined): Record<string, number> {
	return {
		input_tokens: usage?.input_tokens ?? 0,
		output_tokens: usage?.output_tokens ?? 0,
		...(usage?.cache_creation_input_tokens !== undefined ? { cache_creation_input_tokens: usage.cache_creation_input_tokens } : {}),
		...(usage?.cache_read_input_tokens !== undefined ? { cache_read_input_tokens: usage.cache_read_input_tokens } : {}),
	};
}

function toAnthropicStopReason(stopReason: string): string {
	switch (stopReason) {
		case 'tool_use':
		case 'max_tokens':
		case 'end_turn':
			return stopReason;
		case 'stop':
			return 'end_turn';
		case 'length':
			return 'max_tokens';
		case 'tool_calls':
			return 'tool_use';
		default:
			return stopReason || 'end_turn';
	}
}

function contentText(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (!Array.isArray(value)) {
		return '';
	}
	return value.map(block => {
		const record = isRecord(block) ? block : undefined;
		if (stringField(record, 'type') === 'text') {
			return stringField(record, 'text') ?? '';
		}
		return '';
	}).filter(text => !!text).join('\n');
}

function contentThinking(value: unknown): string | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const thinking = value.map(block => {
		const record = isRecord(block) ? block : undefined;
		if (stringField(record, 'type') === 'thinking') {
			return stringField(record, 'thinking') ?? '';
		}
		return '';
	}).filter(text => !!text).join('\n');
	return thinking || undefined;
}

function contentToolCalls(value: unknown): readonly DirectorNormalizedToolCall[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap((block): DirectorNormalizedToolCall[] => {
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

function toolResultMessages(value: unknown): readonly DirectorNormalizedMessage[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap((block): DirectorNormalizedMessage[] => {
		const record = isRecord(block) ? block : undefined;
		if (!record || stringField(record, 'type') !== 'tool_result') {
			return [];
		}
		const toolCallId = stringField(record, 'tool_use_id');
		return [{
			role: 'tool',
			content: contentText(record.content) || stableStringify(record.content),
			...(toolCallId ? { toolCallId } : {}),
			isError: record.is_error === true,
		}];
	});
}

function credentialToRuntimeAuth(credential: DirectorRuntimeCredential): DirectorProviderRuntimeAuth {
	switch (credential.kind) {
		case 'api-key':
			return { kind: 'api-key', value: credential.value };
		case 'bearer':
			return { kind: 'bearer', accessToken: credential.accessToken };
		case 'none':
			return { kind: 'api-key', value: '' };
		case 'missing':
			throw new Error(credential.message);
	}
}

function toRuntimeProviderApiType(apiType: DirectorResolvedProviderBackend['apiType']): DirectorRuntimeProviderApiType {
	switch (apiType) {
		case 'anthropic-messages':
		case 'openai-completions':
		case 'openai-codex':
		case 'gemini-generative':
			return apiType;
		case 'local':
		case 'custom-http':
			throw new Error(`Unsupported Director provider api type '${apiType}'.`);
	}
}

function supportsEndpointStreaming(backend: DirectorResolvedProviderBackend): boolean {
	return backend.capabilities?.streaming === true
		&& (backend.apiType === 'anthropic-messages' || backend.apiType === 'openai-completions');
}

function normalizeInputSchema(value: unknown): DirectorNormalizedToolDefinition['inputSchema'] | undefined {
	if (!isRecord(value) || value.type !== 'object') {
		return undefined;
	}
	const properties = isRecord(value.properties) ? value.properties as Record<string, object> : undefined;
	const required = Array.isArray(value.required) ? value.required.filter((item): item is string => typeof item === 'string') : undefined;
	return {
		type: 'object',
		...(properties ? { properties } : {}),
		...(required ? { required } : {}),
	} satisfies DirectorNormalizedToolDefinition['inputSchema'];
}

function parseToolInput(input: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(input) as unknown;
		if (isRecord(parsed)) {
			return parsed;
		}
		return { input: parsed };
	} catch {
		return { input };
	}
}

function stableStringify(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	try {
		return JSON.stringify(value ?? {});
	} catch {
		return '{}';
	}
}

function createAnthropicMessageId(): string {
	return `msg_${generateUuid().replace(/-/g, '')}`;
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

function setNoDelay(res: http.ServerResponse): void {
	const socket = res.socket;
	if (socket && typeof socket.setNoDelay === 'function') {
		try {
			socket.setNoDelay(true);
		} catch { /* ignore */ }
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function arrayField(value: Record<string, unknown> | undefined, key: string): readonly unknown[] {
	const field = value?.[key];
	return Array.isArray(field) ? field : [];
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
	const field = value?.[key];
	return typeof field === 'string' ? field : undefined;
}

function numberField(value: Record<string, unknown> | undefined, key: string): number | undefined {
	const field = value?.[key];
	return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}

function stringifyError(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}
