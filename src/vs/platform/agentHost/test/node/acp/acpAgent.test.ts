/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ExternalAcpAgentCapability, ExternalAcpAgentCwdPolicy, ExternalAcpAgentSnapshotAgent } from '../../../common/acpAgentConfig.js';
import { AcpAgent, getAcpAgentSubscriptionDescription, toAcpAgentProviderId } from '../../../node/acp/acpAgent.js';

suite('AcpAgent', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('normalizes provider ids and describes external subscription ownership', () => {
		const agent = disposables.add(new AcpAgent(createSnapshotAgent({ id: 'Cursor Agent', displayName: 'Cursor Agent', vendorLabel: 'Cursor' })));

		assert.deepStrictEqual({
			id: agent.id,
			descriptor: agent.getDescriptor(),
			models: agent.models.get(),
		}, {
			id: 'acp-cursor-agent',
			descriptor: {
				provider: 'acp-cursor-agent',
				displayName: 'Cursor Agent',
				description: 'Uses your Cursor subscription/account.',
			},
			models: [{
				provider: 'acp-cursor-agent',
				id: 'external-acp-runtime',
				name: 'Cursor Agent Runtime',
				supportsVision: false,
				_meta: {
					externalAcpAgent: true,
					vendorLabel: 'Cursor',
				},
			}],
		});
	});

	test('keeps existing acp-prefixed ids stable', () => {
		assert.strictEqual(toAcpAgentProviderId('acp-codebuddy-code'), 'acp-codebuddy-code');
	});

	test('uses display name when vendor label is absent', () => {
		const agent = createSnapshotAgent({ displayName: 'Claude ACP' });
		delete (agent as { vendorLabel?: string }).vendorLabel;

		assert.strictEqual(
			getAcpAgentSubscriptionDescription(agent),
			'Uses your Claude ACP subscription/account.',
		);
	});

	test('skeleton methods are safe and do not launch ACP processes', async () => {
		const store = new DisposableStore();
		try {
			const agent = store.add(new AcpAgent(createSnapshotAgent({ command: 'definitely-not-a-real-acp-command' })));

			assert.deepStrictEqual(await agent.listSessions(), []);
			assert.deepStrictEqual(await agent.getSessionMessages(URI.parse('acp-test:///session')), []);
			await agent.disposeSession(URI.parse('acp-test:///session'));
			await agent.abortSession(URI.parse('acp-test:///session'));
			assert.deepStrictEqual(await agent.resolveSessionConfig({ provider: agent.id }), { schema: { type: 'object', properties: {} }, values: {} });
			assert.deepStrictEqual(await agent.sessionConfigCompletions({ provider: agent.id, property: 'model' }), { items: [] });
			assert.deepStrictEqual(await agent.setClientCustomizations(URI.parse('acp-test:///session'), 'client', []), []);
			assert.deepStrictEqual(agent.getProtectedResources(), []);
			assert.strictEqual(await agent.authenticate('resource', 'token'), false);
			await assert.rejects(agent.createSession(), /Phase 4/);
		} finally {
			store.dispose();
		}
	});
});

function createSnapshotAgent(overrides: Partial<ExternalAcpAgentSnapshotAgent> = {}): ExternalAcpAgentSnapshotAgent {
	return {
		id: 'cursor',
		displayName: 'Cursor Agent',
		command: 'cursor-agent',
		args: ['acp'],
		cwdPolicy: ExternalAcpAgentCwdPolicy.Workspace,
		vendorLabel: 'Cursor',
		capabilities: [ExternalAcpAgentCapability.Text, ExternalAcpAgentCapability.Reasoning],
		...overrides,
	};
}
