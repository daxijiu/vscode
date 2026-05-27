/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ExternalAcpAgentCapability } from '../../../common/acpAgentConfig.js';
import { buildAcpClientCapabilities } from '../../../node/acp/acpClientCapabilities.js';

suite('acpClientCapabilities', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('omits side-effect capabilities when policy disables files, terminal, and tools', () => {
		assert.deepStrictEqual(buildAcpClientCapabilities({
			capabilities: [
				ExternalAcpAgentCapability.Text,
				ExternalAcpAgentCapability.Files,
				ExternalAcpAgentCapability.Terminal,
				ExternalAcpAgentCapability.Tools,
			],
		}), {});
	});

	test('uses snapshot capabilities and policy to advertise only enabled client capabilities', () => {
		assert.deepStrictEqual(buildAcpClientCapabilities({
			capabilities: [
				ExternalAcpAgentCapability.Text,
				ExternalAcpAgentCapability.Files,
				ExternalAcpAgentCapability.Terminal,
				ExternalAcpAgentCapability.Tools,
			],
		}, {
			allowFileRead: true,
			allowFileWrite: false,
			allowTerminal: true,
			allowTools: true,
		}), {
			fs: { readTextFile: true },
			terminal: true,
			_meta: { toolCalls: true },
		});
	});

	test('does not advertise capabilities absent from the snapshot even when policy allows them', () => {
		assert.deepStrictEqual(buildAcpClientCapabilities({
			capabilities: [ExternalAcpAgentCapability.Text],
		}, {
			allowFileRead: true,
			allowFileWrite: true,
			allowTerminal: true,
			allowTools: true,
		}), {});
	});
});
