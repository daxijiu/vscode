/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { UsageInfo } from '../../common/state/protocol/state.js';
import { AcpContentBlock, AcpJsonValue, AcpSessionUpdate, AcpToolCallUpdate, AcpUsageUpdate } from './acpProtocol.js';

export type AcpMappedSessionUpdate =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'reasoning'; readonly text: string }
	| { readonly kind: 'usage'; readonly usage: UsageInfo }
	| { readonly kind: 'metadata'; readonly title?: string; readonly updatedAt?: number }
	| { readonly kind: 'tool'; readonly tool: AcpMappedToolUpdate }
	| { readonly kind: 'unsupported'; readonly message: string }
	| { readonly kind: 'ignored' };

export interface AcpMappedToolUpdate {
	readonly phase: 'start' | 'update' | 'complete' | 'fail';
	readonly toolCallId: string;
	readonly toolName: string;
	readonly displayName: string;
	readonly invocationMessage: string;
	readonly progress?: string;
}

export interface AcpSessionUpdateMapperOptions {
	readonly mapToolCallId?: (toolCallId: string) => string;
}

export function mapAcpSessionUpdate(update: AcpSessionUpdate, options: AcpSessionUpdateMapperOptions = {}): AcpMappedSessionUpdate {
	switch (update.sessionUpdate) {
		case 'agent_message_chunk':
			return mapTextContent(update.content, 'text');
		case 'agent_thought_chunk':
			return mapTextContent(update.content, 'reasoning');
		case 'tool_call':
		case 'tool_call_update':
			return mapToolUpdate(update as AcpToolCallUpdate, options);
		case 'session_info_update':
			return {
				kind: 'metadata',
				...(typeof update.title === 'string' ? { title: update.title } : {}),
				...(typeof update.updatedAt === 'string' ? { updatedAt: Date.parse(update.updatedAt) } : {}),
			};
		case 'usage_update':
			return mapUsage(update as AcpUsageUpdate);
		default:
			return { kind: 'ignored' };
	}
}

function mapTextContent(content: AcpContentBlock | AcpJsonValue | undefined, kind: 'text' | 'reasoning'): AcpMappedSessionUpdate {
	if (isAcpContentBlock(content) && content.type === 'text' && typeof content.text === 'string') {
		return { kind, text: content.text };
	}
	return {
		kind: 'unsupported',
		message: localize('acpAgent.unsupportedContent', "This ACP agent produced unsupported non-text content. Only text output is enabled in this milestone."),
	};
}

function isAcpContentBlock(value: AcpContentBlock | AcpJsonValue | undefined): value is AcpContentBlock {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mapUsage(update: AcpUsageUpdate): AcpMappedSessionUpdate {
	const usage: UsageInfo = {};
	const inputTokens = update.inputTokens ?? update.input_tokens;
	const outputTokens = update.outputTokens ?? update.output_tokens;
	const thoughtTokens = update.thoughtTokens ?? update.thought_tokens;
	if (typeof inputTokens === 'number') {
		usage.inputTokens = inputTokens;
	}
	if (typeof outputTokens === 'number') {
		usage.outputTokens = outputTokens;
	}
	if (typeof thoughtTokens === 'number') {
		usage._meta = { thoughtTokens };
	}
	return Object.keys(usage).length > 0 ? { kind: 'usage', usage } : { kind: 'ignored' };
}

function mapToolUpdate(update: AcpToolCallUpdate, options: AcpSessionUpdateMapperOptions): AcpMappedSessionUpdate {
	if (!update.toolCallId) {
		return {
			kind: 'unsupported',
			message: localize('acpAgent.toolCallMissingId', "This ACP agent sent a tool update without a tool call id. The update was ignored."),
		};
	}
	const toolCallId = options.mapToolCallId?.(update.toolCallId) ?? 'acp-tool';
	const displayName = localize('acpAgent.toolCallDisplayName', "ACP Tool");
	const toolName = 'acp.tool';
	const phase = mapToolStatus(update);
	return {
		kind: 'tool',
		tool: {
			phase,
			toolCallId,
			toolName,
			displayName,
			invocationMessage: invocationMessageForToolUpdate(phase),
			...(updateHasRedactedContent(update) ? { progress: localize('acpAgent.toolCallRedactedContent', "ACP tool content is redacted in this Phase 6A lifecycle view.") } : {}),
		},
	};
}

function mapToolStatus(update: AcpToolCallUpdate): AcpMappedToolUpdate['phase'] {
	const status = update.status?.toLowerCase();
	if (update.sessionUpdate === 'tool_call') {
		return 'start';
	}
	switch (status) {
		case 'completed':
		case 'complete':
		case 'success':
		case 'succeeded':
			return 'complete';
		case 'failed':
		case 'error':
		case 'rejected':
		case 'cancelled':
			return 'fail';
		default:
			return 'update';
	}
}

function invocationMessageForToolUpdate(phase: AcpMappedToolUpdate['phase']): string {
	switch (phase) {
		case 'complete':
			return localize('acpAgent.toolCallCompleted', "ACP tool completed. Output is not executed or recorded in Phase 6A.");
		case 'fail':
			return localize('acpAgent.toolCallFailed', "ACP tool failed or was rejected. Output is not executed or recorded in Phase 6A.");
		case 'update':
			return localize('acpAgent.toolCallRunning', "ACP tool reported progress. Side effects are not executed by VS Code in Phase 6A.");
		case 'start':
		default:
			return localize('acpAgent.toolCallStarted', "ACP tool started. Side effects are not executed by VS Code in Phase 6A.");
	}
}

function updateHasRedactedContent(update: AcpToolCallUpdate): boolean {
	return update.content !== undefined || update.rawInput !== undefined || update.rawOutput !== undefined || update.locations !== undefined;
}
