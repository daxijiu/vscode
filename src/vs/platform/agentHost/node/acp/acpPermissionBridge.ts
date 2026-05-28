/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { AcpPermissionOption, AcpRequestPermissionParams, AcpRequestPermissionResult } from './acpProtocol.js';

interface PendingPermission {
	readonly params: AcpRequestPermissionParams;
	readonly resolve: (result: AcpRequestPermissionResult) => void;
}

export interface AcpPermissionBridgeOptions {
	readonly autoDeny?: boolean;
}

export class AcpPermissionBridge extends Disposable {
	private readonly pending = new Map<string, PendingPermission>();
	private readonly onDidRequestPermissionEmitter = this._register(new Emitter<AcpRequestPermissionParams>());
	private nextPermissionRequestId = 1;
	readonly onDidRequestPermission: Event<AcpRequestPermissionParams> = this.onDidRequestPermissionEmitter.event;

	constructor(private readonly options: AcpPermissionBridgeOptions = {}) {
		super();
	}

	requestPermission(params: AcpRequestPermissionParams): Promise<AcpRequestPermissionResult> {
		if (this.options.autoDeny !== false) {
			return Promise.resolve(denyPermission(params.options));
		}

		return new Promise(resolve => {
			const key = this.permissionKey();
			this.pending.set(key, { params, resolve });
			this.onDidRequestPermissionEmitter.fire(redactPermissionParams(params, key));
		});
	}

	cancelPending(sessionId?: string): void {
		for (const [key, pending] of this.pending) {
			if (sessionId !== undefined && pending.params.sessionId !== sessionId) {
				continue;
			}
			this.pending.delete(key);
			pending.resolve(cancelledPermission());
		}
	}

	respond(toolCallId: string, approved: boolean, selectedOptionId?: string): boolean {
		const pending = this.pending.get(toolCallId);
		if (!pending) {
			return false;
		}
		this.pending.delete(toolCallId);
		pending.resolve(selectPermission(pending.params.options, approved, selectedOptionId));
		return true;
	}

	override dispose(): void {
		this.cancelPending();
		super.dispose();
	}

	private permissionKey(): string {
		return `acp-permission-${this.nextPermissionRequestId++}`;
	}
}

export function denyPermission(options: readonly AcpPermissionOption[] | undefined): AcpRequestPermissionResult {
	const optionId = options?.find(option => option.kind === 'reject_once' || option.kind === 'reject_always')?.optionId
		?? options?.find(option => /(?:reject|deny|skip)/i.test(option.optionId) || /(?:reject|deny|skip)/i.test(option.name))?.optionId;
	if (!optionId) {
		return cancelledPermission();
	}
	return { outcome: { outcome: 'selected', optionId } };
}

function selectPermission(options: readonly AcpPermissionOption[] | undefined, approved: boolean, selectedOptionId?: string): AcpRequestPermissionResult {
	const optionId = options?.find(option => option.optionId === selectedOptionId)?.optionId
		?? (approved
			? options?.find(option => option.kind === 'allow_once')?.optionId
			?? options?.find(option => option.kind === 'allow_always')?.optionId
			: options?.find(option => option.kind === 'reject_once' || option.kind === 'reject_always')?.optionId)
		?? options?.[0]?.optionId;
	if (!optionId) {
		return cancelledPermission();
	}
	return { outcome: { outcome: 'selected', optionId } };
}

function cancelledPermission(): AcpRequestPermissionResult {
	return { outcome: { outcome: 'cancelled' } };
}

export function redactPermissionParams(params: AcpRequestPermissionParams, requestId = 'acp-permission'): AcpRequestPermissionParams {
	return {
		sessionId: params.sessionId,
		toolCall: params.toolCall ? redactPermissionToolCall(params.toolCall, requestId) : defaultPermissionToolCall(requestId),
		options: params.options?.map((option, index) => redactPermissionOption(option, index)) ?? [],
	};
}

function defaultPermissionToolCall(requestId: string): NonNullable<AcpRequestPermissionParams['toolCall']> {
	return {
		sessionUpdate: 'tool_call',
		toolCallId: requestId,
		title: 'ACP Tool',
		kind: 'other',
		status: 'pending',
	};
}

function redactPermissionToolCall(toolCall: NonNullable<AcpRequestPermissionParams['toolCall']>, requestId: string): NonNullable<AcpRequestPermissionParams['toolCall']> {
	return {
		sessionUpdate: toolCall.sessionUpdate,
		toolCallId: requestId,
		title: 'ACP Tool',
		kind: 'tool',
		...(redactedToolStatus(toolCall.status) ? { status: redactedToolStatus(toolCall.status) } : {}),
	};
}

function redactPermissionOption(option: AcpPermissionOption, index: number): AcpPermissionOption {
	return {
		optionId: option.optionId || `acp-permission-option-${index + 1}`,
		name: option.name || permissionOptionName(option.kind),
		kind: permissionOptionKind(option.kind),
	};
}

function redactedToolStatus(status: string | undefined): string | undefined {
	switch (status?.toLowerCase()) {
		case 'pending':
		case 'running':
		case 'completed':
		case 'complete':
		case 'success':
		case 'succeeded':
		case 'failed':
		case 'error':
		case 'rejected':
		case 'cancelled':
			return status.toLowerCase();
		default:
			return undefined;
	}
}

function permissionOptionKind(kind: string): AcpPermissionOption['kind'] {
	switch (kind) {
		case 'allow_once':
		case 'allow_always':
		case 'reject_once':
		case 'reject_always':
			return kind;
		default:
			return 'reject_once';
	}
}

function permissionOptionName(kind: string): string {
	switch (permissionOptionKind(kind)) {
		case 'allow_once':
			return 'Allow Once';
		case 'allow_always':
			return 'Allow Always';
		case 'reject_always':
			return 'Reject Always';
		case 'reject_once':
		default:
			return 'Reject Once';
	}
}
