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

	test('redacts permission tool and option metadata before exposing pending params', async () => {
		const bridge = disposables.add(new AcpPermissionBridge({ autoDeny: false }));
		let exposed: AcpRequestPermissionParams | undefined;
		disposables.add(bridge.onDidRequestPermission(params => {
			exposed = params;
		}));

		const pending = bridge.requestPermission(maliciousPermissionParams());

		assert.deepStrictEqual({
			exposed,
			leaksMetadata: JSON.stringify(exposed).includes('sk-abc123')
				|| JSON.stringify(exposed).includes('SECRET_FILE_CONTENT')
				|| JSON.stringify(exposed).includes('ghp_secret')
				|| JSON.stringify(exposed).includes('do not leak this file content'),
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
					{ optionId: 'acp-permission-option-1', name: 'Allow Once', kind: 'allow_once' },
					{ optionId: 'acp-permission-option-2', name: 'Reject Once', kind: 'reject_once' },
				],
			},
			leaksMetadata: false,
		});

		assert.strictEqual(bridge.respond('acp-permission-1', false), true);
		await pending;
	});

	test('redactPermissionParams never copies secret-like permission option ids or names', () => {
		const redacted = redactPermissionParams(maliciousPermissionParams(), 'acp-permission-test');

		assert.deepStrictEqual({
			redacted,
			leaksMetadata: JSON.stringify(redacted).includes('sk-abc123')
				|| JSON.stringify(redacted).includes('SECRET_FILE_CONTENT')
				|| JSON.stringify(redacted).includes('ghp_secret')
				|| JSON.stringify(redacted).includes('do not leak this file content'),
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
					{ optionId: 'acp-permission-option-1', name: 'Allow Once', kind: 'allow_once' },
					{ optionId: 'acp-permission-option-2', name: 'Reject Once', kind: 'reject_once' },
				],
			},
			leaksMetadata: false,
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
			{ optionId: 'reject-ghp_secret', name: 'Reject do not leak this file content', kind: 'reject_once' },
		],
	};
}
