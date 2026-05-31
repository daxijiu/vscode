/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as http from 'http';
import { AddressInfo } from 'net';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../instantiation/common/instantiation.js';
import { ILogService } from '../../../log/common/log.js';
import { DirectorBackendResolution, DirectorProviderModel, DirectorProviderSelection, DirectorResolvedProviderBackend, IDirectorProviderBackendHub, isResolvedBackend } from '../../common/directorProviderBackend.js';
import { DirectorCreateMessageParams, DirectorCreateMessageResponse, DirectorLLMProvider, DirectorProviderFetch, DirectorProviderRuntimeAuth, DirectorProviderStreamEvent, DirectorRuntimeProviderApiType } from '../../common/directorProviderRuntime.js';
import { DirectorRuntimeCredential, IDirectorRuntimeCredentialService } from '../../common/directorRuntimeCredentials.js';
import { buildErrorEnvelope, formatSseErrorFrame, writeJsonError } from '../claude/anthropicErrors.js';
import { parseProxyBearer } from '../claude/claudeProxyAuth.js';
import { createDirectorProviderRuntime, DirectorProviderRuntimeHttpError } from './providers/directorProviderRuntimeFactory.js';
import { isRecord, stringField, toAnthropicMessage, toDirectorCreateMessageParams } from './directorAnthropicEndpointProtocol.js';
import { AnthropicStreamState, beginAnthropicSse, writeAnthropicFrame, writeSyntheticAnthropicStream } from './directorAnthropicStreamWriter.js';

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
	server: http.Server;
	baseUrl: string;
	readonly nonce: string;
	readonly inFlight: Set<IInFlight>;
	readonly sessionSelections: Map<string, DirectorProviderSelection>;
	defaultSelection: DirectorProviderSelection;
	refcount: number;
}

const DIRECTOR_ANTHROPIC_ENDPOINT_NAME = 'DirectorAnthropicEndpointService';

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

		const runtime = await this._ensureRuntime(options.sessionId ? {} : options);
		if (this._disposed || this._runtime !== runtime) {
			throw new Error(`${DIRECTOR_ANTHROPIC_ENDPOINT_NAME} has been disposed`);
		}

		const selection = toProviderSelection(options);
		if (options.sessionId) {
			runtime.sessionSelections.set(options.sessionId, selection);
		} else {
			runtime.defaultSelection = selection;
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
			this._logService.error(`[${DIRECTOR_ANTHROPIC_ENDPOINT_NAME}] request failed: ${safeEndpointLogMessage(err)}`);
			if (!res.headersSent) {
				writeJsonError(res, 500, 'api_error', 'Internal Director endpoint error.');
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
		runtime.server = server;
		runtime.baseUrl = `http://127.0.0.1:${address.port}`;
		return runtime;
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
			if (body.stream === true) {
				if (supportsEndpointStreaming(backend)) {
					await this._streamMessages(provider, request, res, entry, sdkModelId);
				} else {
					await this._sendSyntheticStreamingMessage(provider, request, res, entry, sdkModelId);
				}
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
		} catch {
			writeJsonError(res, 400, 'invalid_request_error', 'Failed to read request body');
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
			writeJsonError(res, 400, 'invalid_request_error', `Selected Director provider uses '${backend.apiType}', which is not supported by the Anthropic endpoint.`);
			return undefined;
		}
		if (!backend.baseURL) {
			writeJsonError(res, 400, 'invalid_request_error', 'Selected Director provider does not have a base URL.');
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
			label: 'Director provider',
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
			writeJsonError(res, 502, 'api_error', safeProviderErrorMessage(err));
			return;
		}

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(toAnthropicMessage(response, sdkModelId)));
	}

	private async _sendSyntheticStreamingMessage(provider: DirectorLLMProvider, request: DirectorCreateMessageParams, res: http.ServerResponse, entry: IInFlight, sdkModelId: string): Promise<void> {
		let response: DirectorCreateMessageResponse;
		try {
			response = await provider.createMessage(request);
		} catch (err) {
			if (entry.ac.signal.aborted) {
				this._endAbortedResponse(res, entry);
				return;
			}
			writeJsonError(res, 502, 'api_error', safeProviderErrorMessage(err));
			return;
		}
		await writeSyntheticAnthropicStream(res, entry, response, sdkModelId);
	}

	private async _streamMessages(provider: DirectorLLMProvider, request: DirectorCreateMessageParams, res: http.ServerResponse, entry: IInFlight, sdkModelId: string): Promise<void> {
		const stream = provider.createMessageStream?.(request);
		if (!stream) {
			await this._sendSyntheticStreamingMessage(provider, request, res, entry, sdkModelId);
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
			writeJsonError(res, 502, 'api_error', safeProviderErrorMessage(err));
			return;
		}

		beginAnthropicSse(res);

		const state = new AnthropicStreamState(sdkModelId);
		if (!await writeAnthropicFrame(res, entry, 'message_start', state.messageStart())) {
			return;
		}

		try {
			if (!first.done && !await state.writeProviderEvent(res, entry, first.value)) {
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
						res.write(formatSseErrorFrame(buildErrorEnvelope('api_error', safeProviderErrorMessage(err))));
						res.end();
					}
					return;
				}
				if (next.done) {
					break;
				}
				if (!await state.writeProviderEvent(res, entry, next.value)) {
					return;
				}
			}
			await state.writeComplete(res, entry, 'end_turn');
		} catch (err) {
			this._logService.warn(`[${DIRECTOR_ANTHROPIC_ENDPOINT_NAME}] stream loop unexpected error: ${safeEndpointLogMessage(err)}`);
			if (!res.writableEnded) {
				try {
					res.end();
				} catch { /* ignore */ }
			}
		}
	}

	private _endAbortedResponse(res: http.ServerResponse, entry: IInFlight): void {
		if (!entry.clientGone && !res.writableEnded) {
			res.destroy();
		}
	}
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

function readRequestBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

function safeProviderErrorMessage(err: unknown): string {
	if (err instanceof DirectorProviderRuntimeHttpError) {
		return err.message;
	}
	return 'Director provider request failed.';
}

function safeEndpointLogMessage(err: unknown): string {
	if (err instanceof DirectorProviderRuntimeHttpError) {
		return err.message;
	}
	if (err instanceof Error) {
		return `${err.name}: ${redactSensitiveLogText(err.message)}`;
	}
	return redactSensitiveLogText(String(err));
}

function redactSensitiveLogText(value: string): string {
	return value
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
		.replace(/(authorization|x-api-key|api[_-]?key|access[_-]?token)(["':=\s]+)([^\s'",}]+)/gi, '$1$2<redacted>');
}
