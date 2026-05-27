/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Readable, Writable } from 'stream';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { acpErrorFromJsonRpcError, acpMalformedJsonError, acpProcessExitedError, acpTimeoutError, AcpError } from './acpErrors.js';
import { AcpJsonObject, AcpJsonRpcError, AcpJsonRpcId, AcpJsonRpcRequest, AcpJsonRpcResponse, AcpJsonValue } from './acpProtocol.js';

interface PendingRequest {
	readonly method: string;
	readonly resolve: (value: AcpJsonValue) => void;
	readonly reject: (err: AcpError) => void;
	readonly timeout: ReturnType<typeof setTimeout>;
}

export class AcpConnection extends Disposable {
	private readonly pending = new Map<AcpJsonRpcId, PendingRequest>();
	private readonly onDidCloseEmitter = this._register(new Emitter<AcpError>());
	private buffer = '';
	private nextRequestId = 1;
	private closed = false;

	readonly onDidClose: Event<AcpError> = this.onDidCloseEmitter.event;

	constructor(
		private readonly input: Readable,
		private readonly output: Writable,
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

function isAcpJsonRpcResponse(value: AcpJsonObject): boolean {
	if (value.jsonrpc !== '2.0') {
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
