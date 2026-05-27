/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { UsageInfo } from '../../common/state/protocol/state.js';
import { AcpContentBlock, AcpJsonValue, AcpSessionUpdate, AcpUsageUpdate } from './acpProtocol.js';

export type AcpMappedSessionUpdate =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'reasoning'; readonly text: string }
	| { readonly kind: 'usage'; readonly usage: UsageInfo }
	| { readonly kind: 'metadata'; readonly title?: string; readonly updatedAt?: number }
	| { readonly kind: 'unsupported'; readonly message: string }
	| { readonly kind: 'ignored' };

export function mapAcpSessionUpdate(update: AcpSessionUpdate): AcpMappedSessionUpdate {
	switch (update.sessionUpdate) {
		case 'agent_message_chunk':
			return mapTextContent(update.content, 'text');
		case 'agent_thought_chunk':
			return mapTextContent(update.content, 'reasoning');
		case 'tool_call':
		case 'tool_call_update':
			return {
				kind: 'unsupported',
				message: localize('acpAgent.unsupportedToolUpdate', "This ACP agent requested a tool call, but ACP tools are not enabled in this text-only milestone."),
			};
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
