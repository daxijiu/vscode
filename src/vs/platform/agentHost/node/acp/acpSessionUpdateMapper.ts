/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { redactExternalAcpAgentStatusMessage } from '../../common/acpAgentConfig.js';
import { ToolResultContent, ToolResultContentType, UsageInfo } from '../../common/state/protocol/state.js';
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
	readonly toolInput?: string;
	readonly content?: readonly ToolResultContent[];
	readonly progress?: string;
	readonly metadata?: Record<string, unknown>;
}

export interface AcpSessionUpdateMapperOptions {
	readonly mapToolCallId?: (toolCallId: string) => string;
	readonly mapTerminalContent?: (terminalId: string) => { readonly resource: string; readonly title: string } | undefined;
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
	const kind = normalizeToolKind(update.kind);
	const rawKind = typeof update.kind === 'string' && update.kind !== kind ? sanitizeDisplayText(update.kind, 80) : undefined;
	const displayName = sanitizeDisplayText(update.title, 160) ?? displayNameForKind(kind);
	const toolName = `acp.${kind}`;
	const phase = mapToolStatus(update);
	const content = mapToolContent(update, options);
	const rawInputPreview = previewJson(update.rawInput, 4000);
	const rawOutputPreview = previewJson(update.rawOutput, 6000);
	const locationsPreview = previewLocations(update.locations);
	const toolInput = toolInputForToolUpdate(rawInputPreview, locationsPreview);
	const resultContent = resultContentForToolUpdate(content, locationsPreview, rawOutputPreview);
	const metadata = metadataForToolUpdate(kind, rawKind, update, rawInputPreview, rawOutputPreview);
	return {
		kind: 'tool',
		tool: {
			phase,
			toolCallId,
			toolName,
			displayName,
			invocationMessage: invocationMessageForToolUpdate(phase, displayName),
			...(toolInput ? { toolInput } : {}),
			...(resultContent.length ? { content: resultContent } : {}),
			...(content.length ? { progress: progressMessageForToolUpdate(content) } : {}),
			...(metadata ? { metadata } : {}),
		},
	};
}

function mapToolStatus(update: AcpToolCallUpdate): AcpMappedToolUpdate['phase'] {
	const status = update.status?.toLowerCase();
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
		case 'in_progress':
		case 'running':
		case 'started':
			return 'update';
		default:
			return update.sessionUpdate === 'tool_call' ? 'start' : 'update';
	}
}

function invocationMessageForToolUpdate(phase: AcpMappedToolUpdate['phase'], displayName: string): string {
	switch (phase) {
		case 'complete':
			return localize('acpAgent.toolCallCompleted', "{0} completed.", displayName);
		case 'fail':
			return localize('acpAgent.toolCallFailed', "{0} failed or was rejected.", displayName);
		case 'update':
			return localize('acpAgent.toolCallRunning', "{0} is running.", displayName);
		case 'start':
		default:
			return localize('acpAgent.toolCallStarted', "{0} started.", displayName);
	}
}

function normalizeToolKind(kind: string | undefined): string {
	switch (kind?.toLowerCase()) {
		case 'read':
		case 'edit':
		case 'delete':
		case 'move':
		case 'search':
		case 'execute':
		case 'think':
		case 'fetch':
		case 'other':
			return kind.toLowerCase();
		case 'write':
			return 'edit';
		case 'terminal':
		case 'shell':
		case 'command':
			return 'execute';
		default:
			return 'other';
	}
}

function displayNameForKind(kind: string): string {
	switch (kind) {
		case 'read':
			return localize('acpAgent.toolDisplayRead', "Read");
		case 'edit':
			return localize('acpAgent.toolDisplayEdit', "Edit");
		case 'delete':
			return localize('acpAgent.toolDisplayDelete', "Delete");
		case 'move':
			return localize('acpAgent.toolDisplayMove', "Move");
		case 'search':
			return localize('acpAgent.toolDisplaySearch', "Search");
		case 'execute':
			return localize('acpAgent.toolDisplayExecute', "Command");
		case 'think':
			return localize('acpAgent.toolDisplayThink', "Thinking");
		case 'fetch':
			return localize('acpAgent.toolDisplayFetch', "Fetch");
		case 'other':
		default:
			return localize('acpAgent.toolDisplayGeneric', "ACP Tool");
	}
}

function sanitizeDisplayText(value: string | undefined, maxLength: number): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) {
		return undefined;
	}
	return redactExternalAcpAgentStatusMessage(boundedDisplayText(trimmed, maxLength));
}

function boundedDisplayText(value: string, maxLength: number): string {
	if (value.length <= maxLength) {
		return value;
	}
	return `${value.slice(0, maxLength)}...`;
}

function mapToolContent(update: AcpToolCallUpdate, options: AcpSessionUpdateMapperOptions): readonly ToolResultContent[] {
	if (!Array.isArray(update.content)) {
		return [];
	}
	return update.content.map(value => mapToolContentBlock(value, options)).filter((content): content is ToolResultContent => content !== undefined);
}

function mapToolContentBlock(value: AcpJsonValue, options: AcpSessionUpdateMapperOptions): ToolResultContent | undefined {
	if (!isAcpJsonObjectLike(value)) {
		return textContent(previewValue(value, 2000));
	}
	const type = readString(value, 'type');
	if (type === 'content') {
		const nested = readValue(value, 'content');
		return mapNestedContent(nested);
	}
	if (type === 'text') {
		return textContent(boundedDisplayText(readString(value, 'text') ?? '', 12000));
	}
	if (type === 'diff') {
		return textContent(diffPreview(value));
	}
	if (type === 'terminal') {
		const terminalId = readString(value, 'terminalId') ?? readString(value, 'terminal_id');
		const terminal = terminalId ? options.mapTerminalContent?.(terminalId) : undefined;
		if (terminal) {
			return {
				type: ToolResultContentType.Terminal,
				resource: terminal.resource,
				title: terminal.title,
			};
		}
		return textContent(terminalId
			? localize('acpAgent.toolContentTerminal', "Terminal: {0}", terminalId)
			: localize('acpAgent.toolContentTerminalUnknown', "Terminal output reported by the ACP agent."));
	}
	return textContent(previewValue(value, 4000));
}

function mapNestedContent(value: AcpJsonValue | undefined): ToolResultContent | undefined {
	if (!isAcpJsonObjectLike(value)) {
		return value === undefined ? undefined : textContent(previewValue(value, 2000));
	}
	if (readString(value, 'type') === 'text') {
		return textContent(boundedDisplayText(readString(value, 'text') ?? '', 12000));
	}
	return textContent(previewValue(value, 4000));
}

function diffPreview(value: AcpJsonObjectLike): string {
	const path = readString(value, 'path') ?? localize('acpAgent.toolDiffUnknownPath', "Unknown file");
	const oldText = readString(value, 'oldText') ?? readString(value, 'old_text') ?? '';
	const newText = readString(value, 'newText') ?? readString(value, 'new_text') ?? '';
	const preview = [
		localize('acpAgent.toolDiffTitle', "Diff: {0}", path),
		'--- old',
		boundedDisplayText(oldText, 4000),
		'+++ new',
		boundedDisplayText(newText, 4000),
	].join('\n');
	return boundedDisplayText(preview, 10000);
}

function textContent(text: string): ToolResultContent | undefined {
	if (!text) {
		return undefined;
	}
	return { type: ToolResultContentType.Text, text };
}

function previewJson(value: AcpJsonValue | undefined, maxLength: number): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	return redactExternalAcpAgentStatusMessage(previewValue(value, maxLength));
}

function previewValue(value: AcpJsonValue | undefined, maxLength: number): string {
	try {
		return boundedDisplayText(JSON.stringify(value, undefined, 2) ?? '', maxLength);
	} catch {
		return localize('acpAgent.toolPreviewUnavailable', "Preview unavailable.");
	}
}

function previewLocations(locations: readonly AcpJsonValue[] | undefined): string | undefined {
	if (!Array.isArray(locations) || !locations.length) {
		return undefined;
	}
	const lines = locations.slice(0, 20).map(location => {
		if (!location || typeof location !== 'object' || Array.isArray(location)) {
			return `- ${previewValue(location, 400)}`;
		}
		const path = readString(location, 'path') ?? previewValue(location, 400);
		const line = readNumber(location, 'line');
		return line !== undefined ? `- ${path}:${line}` : `- ${path}`;
	});
	if (locations.length > lines.length) {
		lines.push(localize('acpAgent.toolLocationsMore', "- ...and {0} more locations", locations.length - lines.length));
	}
	return lines.join('\n');
}

function toolInputForToolUpdate(rawInputPreview: string | undefined, locationsPreview: string | undefined): string | undefined {
	const parts: string[] = [];
	if (rawInputPreview) {
		parts.push(`${localize('acpAgent.toolInputRawInput', "Raw input")}\n${rawInputPreview}`);
	}
	if (locationsPreview) {
		parts.push(`${localize('acpAgent.toolInputLocations', "Locations")}\n${locationsPreview}`);
	}
	return parts.length ? parts.join('\n\n') : undefined;
}

function resultContentForToolUpdate(content: readonly ToolResultContent[], locationsPreview: string | undefined, rawOutputPreview: string | undefined): readonly ToolResultContent[] {
	const result = [...content];
	if (locationsPreview) {
		result.push({ type: ToolResultContentType.Text, text: `${localize('acpAgent.toolResultLocations', "Locations")}\n${locationsPreview}` });
	}
	if (rawOutputPreview) {
		result.push({ type: ToolResultContentType.Text, text: `${localize('acpAgent.toolResultRawOutput', "Raw output")}\n${rawOutputPreview}` });
	}
	return result;
}

function progressMessageForToolUpdate(content: readonly ToolResultContent[]): string | undefined {
	const firstText = content.find(content => content.type === ToolResultContentType.Text);
	return firstText?.type === ToolResultContentType.Text ? boundedDisplayText(firstText.text, 400) : undefined;
}

function metadataForToolUpdate(kind: string, rawKind: string | undefined, update: AcpToolCallUpdate, rawInputPreview: string | undefined, rawOutputPreview: string | undefined): Record<string, unknown> | undefined {
	const acp: Record<string, unknown> = {
		kind,
	};
	if (rawKind) {
		acp.rawKind = rawKind;
	}
	if (update.status) {
		acp.status = update.status;
	}
	if (update.title) {
		acp.title = sanitizeDisplayText(update.title, 240);
	}
	if (rawInputPreview) {
		acp.rawInputPreview = rawInputPreview;
	}
	if (rawOutputPreview) {
		acp.rawOutputPreview = rawOutputPreview;
	}
	if (Array.isArray(update.locations)) {
		acp.locations = update.locations.slice(0, 20);
	}
	const terminalIds = terminalIdsFromContent(update.content);
	if (terminalIds.length) {
		acp.terminalIds = terminalIds;
	}
	return { toolKind: kind, acp };
}

function terminalIdsFromContent(content: readonly AcpJsonValue[] | undefined): readonly string[] {
	if (!Array.isArray(content)) {
		return [];
	}
	const ids: string[] = [];
	for (const item of content) {
		if (!isAcpJsonObjectLike(item)) {
			continue;
		}
		const type = readString(item, 'type');
		if (type !== 'terminal') {
			continue;
		}
		const terminalId = readString(item, 'terminalId') ?? readString(item, 'terminal_id');
		if (terminalId) {
			ids.push(terminalId);
		}
	}
	return ids;
}

type AcpJsonObjectLike = { readonly [key: string]: AcpJsonValue | undefined };

function isAcpJsonObjectLike(value: AcpJsonValue | undefined): value is AcpJsonObjectLike {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readValue(value: AcpJsonObjectLike, key: string): AcpJsonValue | undefined {
	return value[key];
}

function readString(value: AcpJsonObjectLike, key: string): string | undefined {
	const candidate = readValue(value, key);
	return typeof candidate === 'string' ? candidate : undefined;
}

function readNumber(value: AcpJsonObjectLike, key: string): number | undefined {
	const candidate = readValue(value, key);
	return typeof candidate === 'number' ? candidate : undefined;
}
