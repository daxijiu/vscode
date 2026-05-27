/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Readable, Writable } from 'stream';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { hasKey } from '../../../../base/common/types.js';
import { acpErrorFromJsonRpcError, acpMalformedJsonError, acpProcessExitedError, acpTimeoutError, AcpError } from './acpErrors.js';
import { AcpJsonObject, AcpJsonRpcError, AcpJsonRpcErrorCode, AcpJsonRpcId, AcpJsonRpcNotification, AcpJsonRpcRequest, AcpJsonRpcResponse, AcpJsonValue } from './acpProtocol.js';

interface PendingRequest {
	readonly method: string;
	readonly resolve: (value: AcpJsonValue) => void;
	readonly reject: (err: AcpError) => void;
	readonly timeout: ReturnType<typeof setTimeout>;
}

export type AcpInboundRequestResult =
	| { readonly result: AcpJsonValue }
	| { readonly error: AcpJsonRpcError };

export type AcpInboundRequestHandler = (request: AcpJsonRpcRequest) => Promise<AcpInboundRequestResult>;

export class AcpConnection extends Disposable {
	private readonly pending = new Map<AcpJsonRpcId, PendingRequest>();
	private readonly onDidCloseEmitter = this._register(new Emitter<AcpError>());
	private readonly onDidNotificationEmitter = this._register(new Emitter<AcpJsonRpcNotification>());
	private buffer = '';
	private nextRequestId = 1;
	private closed = false;

	readonly onDidClose: Event<AcpError> = this.onDidCloseEmitter.event;
	readonly onDidNotification: Event<AcpJsonRpcNotification> = this.onDidNotificationEmitter.event;

	constructor(
		private readonly input: Readable,
		private readonly output: Writable,
		private readonly requestHandler?: AcpInboundRequestHandler,
	) {
		super();

		this.input.setEncoding('utf8');
		this.input.on('data', chunk => this.acceptChunk(String(chunk)));
		this.input.on('end', () => this.close(acpProcessExitedError()));
		this.input.on('error', () => this.close(acpProcessExitedError()));
		this.output.on('error', () => this.close(acpProcessExitedError()));
	}

	request<TParams extends AcpJsonValue, TResult extends AcpJsonValue>(method: string, params: TParams, timeoutMs: number): Promise<TResult> {
		if (this.closed) {
			return Promise.reject(acpProcessExitedError());
		}

		const id = this.nextRequestId++;
		const message: AcpJsonRpcRequest<TParams> = {
			jsonrpc: '2.0',
			id,
			method,
			params,
		};

		return new Promise<TResult>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(acpTimeoutError(method));
			}, timeoutMs);

			this.pending.set(id, {
				method,
				resolve: value => resolve(value as TResult),
				reject,
				timeout,
			});

			this.output.write(`${JSON.stringify(message)}\n`, err => {
				if (err) {
					const pending = this.pending.get(id);
					if (pending) {
						this.pending.delete(id);
						clearTimeout(pending.timeout);
						pending.reject(acpProcessExitedError());
					}
				}
			});
		});
	}

	notify<TParams extends AcpJsonValue>(method: string, params: TParams): Promise<void> {
		if (this.closed) {
			return Promise.reject(acpProcessExitedError());
		}

		const message: AcpJsonRpcNotification<TParams> = {
			jsonrpc: '2.0',
			method,
			params,
		};

		return new Promise<void>((resolve, reject) => {
			this.output.write(`${JSON.stringify(message)}\n`, err => {
				if (err) {
					reject(acpProcessExitedError());
					return;
				}
				resolve();
			});
		});
	}

	override dispose(): void {
		this.close(acpProcessExitedError());
		super.dispose();
	}

	closeWithError(reason: AcpError): void {
		this.close(reason);
	}

	private acceptChunk(chunk: string): void {
		if (this.closed) {
			return;
		}
		this.buffer += chunk;
		let newlineIndex: number;
		while ((newlineIndex = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, '');
			this.buffer = this.buffer.slice(newlineIndex + 1);
			if (!line.trim()) {
				continue;
			}
			this.acceptLine(line);
			if (this.closed) {
				return;
			}
		}
	}

	private acceptLine(line: string): void {
		let message: AcpJsonObject;
		try {
			message = JSON.parse(line) as AcpJsonObject;
		} catch {
			this.close(acpMalformedJsonError());
			return;
		}

		if (isAcpJsonRpcNotification(message)) {
			this.onDidNotificationEmitter.fire({
				jsonrpc: '2.0',
				method: message.method as string,
				...(message.params !== undefined ? { params: message.params } : {}),
			});
			return;
		}

		if (isAcpJsonRpcRequest(message)) {
			void this.acceptRequest({
				jsonrpc: '2.0',
				id: message.id as AcpJsonRpcId,
				method: message.method as string,
				...(message.params !== undefined ? { params: message.params } : {}),
			});
			return;
		}

		if (!isAcpJsonRpcResponse(message)) {
			this.close(acpMalformedJsonError());
			return;
		}
		const error = message.error !== undefined ? toAcpJsonRpcError(message.error) : undefined;
		const response: AcpJsonRpcResponse = {
			jsonrpc: '2.0',
			id: message.id as AcpJsonRpcId,
			...(message.result !== undefined ? { result: message.result } : {}),
			...(error !== undefined ? { error } : {}),
		};

		const pending = this.pending.get(response.id);
		if (!pending) {
			return;
		}
		this.pending.delete(response.id);
		clearTimeout(pending.timeout);

		if (response.error) {
			pending.reject(acpErrorFromJsonRpcError(response.error));
			return;
		}
		pending.resolve(response.result ?? null);
	}

	private async acceptRequest(request: AcpJsonRpcRequest): Promise<void> {
		if (!this.requestHandler) {
			this.sendUnsupportedRequestResponse(request.id, request.method);
			return;
		}
		try {
			const result = await this.requestHandler(request);
			if (hasKey(result, { error: true })) {
				this.sendErrorResponse(request.id, result.error);
				return;
			}
			this.sendResultResponse(request.id, result.result);
		} catch (err) {
			this.sendErrorResponse(request.id, {
				code: AcpJsonRpcErrorCode.InternalError,
				message: err instanceof Error && err.message ? err.message : 'ACP request failed.',
			});
		}
	}

	private sendUnsupportedRequestResponse(id: AcpJsonRpcId, method: string): void {
		this.sendErrorResponse(id, {
			code: AcpJsonRpcErrorCode.MethodNotFound,
			message: `Unsupported ACP request: ${method}`,
		});
	}

	private sendResultResponse(id: AcpJsonRpcId, result: AcpJsonValue): void {
		this.output.write(`${JSON.stringify({
			jsonrpc: '2.0',
			id,
			result,
		})}\n`, err => {
			if (err) {
				this.close(acpProcessExitedError());
			}
		});
	}

	private sendErrorResponse(id: AcpJsonRpcId, error: AcpJsonRpcError): void {
		this.output.write(`${JSON.stringify({
			jsonrpc: '2.0',
			id,
			error,
		})}\n`, err => {
			if (err) {
				this.close(acpProcessExitedError());
			}
		});
	}

	private close(reason: AcpError): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(reason);
		}
		this.pending.clear();
		this.onDidCloseEmitter.fire(reason);
	}
}

function isAcpJsonRpcNotification(value: AcpJsonObject): boolean {
	return value.jsonrpc === '2.0'
		&& value.id === undefined
		&& typeof value.method === 'string';
}

function isAcpJsonRpcRequest(value: AcpJsonObject): boolean {
	if (value.jsonrpc !== '2.0' || typeof value.method !== 'string') {
		return false;
	}
	const id = value.id;
	return typeof id === 'number' || typeof id === 'string';
}

function isAcpJsonRpcResponse(value: AcpJsonObject): boolean {
	if (value.jsonrpc !== '2.0') {
		return false;
	}
	if (typeof value.method === 'string') {
		return false;
	}
	const id = value.id;
	if (typeof id !== 'number' && typeof id !== 'string') {
		return false;
	}
	if (value.error !== undefined) {
		return isAcpJsonRpcError(value.error);
	}
	return true;
}

function isAcpJsonRpcError(value: AcpJsonValue | undefined): boolean {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}
	const candidate = value as { readonly [key: string]: AcpJsonValue };
	return typeof candidate.code === 'number' && typeof candidate.message === 'string';
}

function toAcpJsonRpcError(value: AcpJsonValue): AcpJsonRpcError {
	const candidate = value as { readonly [key: string]: AcpJsonValue };
	return {
		code: typeof candidate.code === 'number' ? candidate.code : 0,
		message: typeof candidate.message === 'string' ? candidate.message : '',
		...(candidate.data !== undefined ? { data: candidate.data } : {}),
	};
}
