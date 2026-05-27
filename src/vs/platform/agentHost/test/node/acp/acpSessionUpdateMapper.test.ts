/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { mapAcpSessionUpdate } from '../../../node/acp/acpSessionUpdateMapper.js';

suite('acpSessionUpdateMapper', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('maps text, reasoning, metadata, usage, and text-only unsupported updates', () => {
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
			{ kind: 'unsupported', message: 'This ACP agent requested a tool call, but ACP tools are not enabled in this text-only milestone.' },
			{ kind: 'unsupported', message: 'This ACP agent produced unsupported non-text content. Only text output is enabled in this milestone.' },
		]);
	});
});
