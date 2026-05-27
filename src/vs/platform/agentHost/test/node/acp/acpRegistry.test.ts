/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ExternalAcpAgentCwdPolicy } from '../../../common/acpAgentConfig.js';
import { getAcpRegistryInstallCommandCopyText, getAcpRegistryLoginCommandCopyText, normalizeAcpRegistryAgent, parseAcpRegistry, toAcpRegistryDraftOptions } from '../../../common/acpRegistry.js';

suite('acpRegistry', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('ignores malformed registry entries safely', () => {
		const result = parseAcpRegistry({
			version: '1.0.0',
			agents: [
				createRegistryEntry(),
				{ id: 'Bad ID', name: 'Bad', version: '1.0.0', description: 'Bad', distribution: { npx: { package: 'bad' } } },
				{ id: 'missing-distribution', name: 'Missing', version: '1.0.0', description: 'Missing' },
			],
		});

		assert.deepStrictEqual({
			ids: result.agents.map(agent => agent.id),
			ignored: result.ignored,
		}, {
			ids: ['cursor-agent'],
			ignored: 2,
		});
	});

	test('renders install and login commands as copy-only text', () => {
		const agent = normalizeAcpRegistryAgent(createRegistryEntry())!;

		assert.deepStrictEqual({
			installCommand: getAcpRegistryInstallCommandCopyText(agent),
			loginCommand: getAcpRegistryLoginCommandCopyText(agent),
		}, {
			installCommand: 'npm install -g @cursor/agent',
			loginCommand: 'cursor-agent login',
		});
	});

	test('rejects or redacts secret-like registry text', () => {
		const agent = normalizeAcpRegistryAgent(createRegistryEntry({
			name: 'Cursor token=super-secret',
			description: 'Use bearer abc123',
			installCommand: 'npm install x --token super-secret',
			loginCommand: 'cursor-agent login --token super-secret',
			loginHint: 'Run login with token=super-secret',
		}))!;

		assert.deepStrictEqual({
			name: agent.name,
			description: agent.description,
			installCommand: getAcpRegistryInstallCommandCopyText(agent),
			loginCommand: getAcpRegistryLoginCommandCopyText(agent),
			loginHint: agent.loginHint,
		}, {
			name: 'Cursor token=[redacted]',
			description: 'Use bearer [redacted]',
			installCommand: 'npx -y @cursor/agent acp',
			loginCommand: undefined,
			loginHint: undefined,
		});
	});

	test('preserves provenance when creating disabled draft options', () => {
		const agent = normalizeAcpRegistryAgent(createRegistryEntry())!;
		const draft = toAcpRegistryDraftOptions(agent);

		assert.deepStrictEqual(draft, {
			id: 'cursor-agent',
			displayName: 'Cursor Agent',
			command: 'npx',
			args: ['-y', '@cursor/agent', 'acp'],
			cwdPolicy: ExternalAcpAgentCwdPolicy.Workspace,
			vendorLabel: 'uses your Cursor Agent account',
			loginHint: 'Run cursor-agent login outside VS Code.',
			loginCommand: 'cursor-agent login',
			loginHelpUrl: 'https://cursor.example/login',
			capabilities: ['text', 'reasoning'],
			registryId: 'cursor-agent',
			registryVersion: '1.2.3',
		});
	});

	function createRegistryEntry(overrides: object = {}): object {
		return {
			id: 'cursor-agent',
			name: 'Cursor Agent',
			version: '1.2.3',
			description: 'Cursor-owned ACP runtime.',
			authors: ['Cursor'],
			distribution: {
				npx: {
					package: '@cursor/agent',
					args: ['acp'],
				},
			},
			installCommand: 'npm install -g @cursor/agent',
			loginHint: 'Run cursor-agent login outside VS Code.',
			loginCommand: 'cursor-agent login',
			loginHelpUrl: 'https://cursor.example/login',
			...overrides,
		};
	}
});
