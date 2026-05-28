/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AcpPermissionBridge, redactPermissionParams } from '../../../node/acp/acpPermissionBridge.js';
import { AcpRequestPermissionParams } from '../../../node/acp/acpProtocol.js';

suite('acpPermissionBridge', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('exposes permission options and returns the selected ACP option id', async () => {
		const bridge = disposables.add(new AcpPermissionBridge({ autoDeny: false }));
		let exposed: AcpRequestPermissionParams | undefined;
		disposables.add(bridge.onDidRequestPermission(params => {
			exposed = params;
		}));

		const pending = bridge.requestPermission(maliciousPermissionParams());

		assert.deepStrictEqual({
			exposed,
			exposesToolContent: JSON.stringify(exposed).includes('do not leak this file content'),
		}, {
			exposed: {
				sessionId: 'session-1',
				toolCall: {
					sessionUpdate: 'tool_call',
					toolCallId: 'acp-permission-1',
					title: 'ACP Tool',
					kind: 'tool',
					status: 'pending',
				},
				options: [
					{ optionId: 'allow-sk-abc123', name: 'Allow SECRET_FILE_CONTENT', kind: 'allow_once' },
					{ optionId: 'reject-ghp_secret', name: 'Reject SECRET_OPTION', kind: 'reject_once' },
				],
			},
			exposesToolContent: false,
		});

		assert.strictEqual(bridge.respond('acp-permission-1', false, 'reject-ghp_secret'), true);
		assert.deepStrictEqual(await pending, { outcome: { outcome: 'selected', optionId: 'reject-ghp_secret' } });
	});

	test('redactPermissionParams keeps tool details bounded while preserving selectable options', () => {
		const redacted = redactPermissionParams(maliciousPermissionParams(), 'acp-permission-test');

		assert.deepStrictEqual({
			redacted,
			exposesToolContent: JSON.stringify(redacted).includes('do not leak this file content'),
		}, {
			redacted: {
				sessionId: 'session-1',
				toolCall: {
					sessionUpdate: 'tool_call',
					toolCallId: 'acp-permission-test',
					title: 'ACP Tool',
					kind: 'tool',
					status: 'pending',
				},
				options: [
					{ optionId: 'allow-sk-abc123', name: 'Allow SECRET_FILE_CONTENT', kind: 'allow_once' },
					{ optionId: 'reject-ghp_secret', name: 'Reject SECRET_OPTION', kind: 'reject_once' },
				],
			},
			exposesToolContent: false,
		});
	});
});

function maliciousPermissionParams(): AcpRequestPermissionParams {
	return {
		sessionId: 'session-1',
		toolCall: {
			sessionUpdate: 'tool_call',
			toolCallId: 'call-token-sk-abc123',
			title: 'Write SECRET_FILE_CONTENT',
			kind: 'terminal output token=ghp_secret',
			status: 'pending',
			content: [{ type: 'text', text: 'do not leak this file content' }],
		},
		options: [
			{ optionId: 'allow-sk-abc123', name: 'Allow SECRET_FILE_CONTENT', kind: 'allow_once' },
			{ optionId: 'reject-ghp_secret', name: 'Reject SECRET_OPTION', kind: 'reject_once' },
		],
	};
}
