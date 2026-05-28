/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { mapAcpSessionUpdate } from '../../../node/acp/acpSessionUpdateMapper.js';

suite('acpSessionUpdateMapper', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('maps text, reasoning, metadata, usage, tool lifecycle, and unsupported content updates', () => {
		assert.deepStrictEqual([
			mapAcpSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } }),
			mapAcpSessionUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'think' } }),
			mapAcpSessionUpdate({ sessionUpdate: 'session_info_update', title: 'Session title', updatedAt: '2026-05-27T00:00:00.000Z' }),
			mapAcpSessionUpdate({ sessionUpdate: 'usage_update', inputTokens: 1, output_tokens: 2, thought_tokens: 3 }),
			mapAcpSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Read', status: 'pending' }),
			mapAcpSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'ignored' } }),
		], [
			{ kind: 'text', text: 'hello' },
			{ kind: 'reasoning', text: 'think' },
			{ kind: 'metadata', title: 'Session title', updatedAt: Date.parse('2026-05-27T00:00:00.000Z') },
			{ kind: 'usage', usage: { inputTokens: 1, outputTokens: 2, _meta: { thoughtTokens: 3 } } },
			{
				kind: 'tool',
				tool: {
					phase: 'start',
					toolCallId: 'acp-tool',
					toolName: 'acp.other',
					displayName: 'Read',
					invocationMessage: 'Read started.',
					metadata: {
						toolKind: 'other',
						acp: {
							kind: 'other',
							status: 'pending',
							title: 'Read',
						},
					},
				},
			},
			{ kind: 'unsupported', message: 'This ACP agent produced unsupported non-text content. Only text output is enabled in this milestone.' },
		]);
	});

	test('maps agent-owned tool report details without requiring client tool capabilities', () => {
		const mapped = mapAcpSessionUpdate({
			sessionUpdate: 'tool_call_update',
			toolCallId: 'call-1',
			title: 'Edit config',
			kind: 'edit',
			status: 'completed',
			rawInput: { path: '/repo/config.json', token: 'abc123' },
			content: [
				{ type: 'content', content: { type: 'text', text: 'Updated config' } },
				{ type: 'diff', path: '/repo/config.json', oldText: '{"debug":false}', newText: '{"debug":true}' },
				{ type: 'terminal', terminalId: 'term-1' },
			],
			locations: [{ path: '/repo/config.json', line: 2 }],
		}, { mapToolCallId: () => 'acp-tool-1' });

		assert.deepStrictEqual({
			mapped,
			hasPhase6Placeholder: JSON.stringify(mapped).includes('Phase 6A'),
		}, {
			mapped: {
				kind: 'tool',
				tool: {
					phase: 'complete',
					toolCallId: 'acp-tool-1',
					toolName: 'acp.edit',
					displayName: 'Edit config',
					invocationMessage: 'Edit config completed.',
					toolInput: 'Raw input\n{\n  "path": "/repo/config.json",\n  "token": "[redacted]"\n}\n\nLocations\n- /repo/config.json:2',
					content: [
						{ type: 'text', text: 'Updated config' },
						{ type: 'text', text: 'Diff: /repo/config.json\n--- old\n{"debug":false}\n+++ new\n{"debug":true}' },
						{ type: 'text', text: 'Terminal: term-1' },
						{ type: 'text', text: 'Locations\n- /repo/config.json:2' },
					],
					progress: 'Updated config',
					metadata: {
						toolKind: 'edit',
						acp: {
							kind: 'edit',
							status: 'completed',
							title: 'Edit config',
							rawInputPreview: '{\n  "path": "/repo/config.json",\n  "token": "[redacted]"\n}',
							locations: [{ path: '/repo/config.json', line: 2 }],
							terminalIds: ['term-1'],
						},
					},
				},
			},
			hasPhase6Placeholder: false,
		});
	});

	test('maps ACP terminal content to native AgentHost terminal content when available', () => {
		const mapped = mapAcpSessionUpdate({
			sessionUpdate: 'tool_call_update',
			toolCallId: 'call-1',
			kind: 'execute',
			content: [{ type: 'terminal', terminalId: 'term-1' }],
		}, {
			mapTerminalContent: terminalId => terminalId === 'term-1'
				? { resource: 'agenthost-terminal://acp/term-1', title: 'npm test' }
				: undefined,
		});

		if (mapped.kind !== 'tool') {
			assert.fail(`Expected tool update, got ${mapped.kind}`);
		}
		assert.deepStrictEqual(mapped.tool.content, [{
			type: 'terminal',
			resource: 'agenthost-terminal://acp/term-1',
			title: 'npm test',
		}]);
	});
});
