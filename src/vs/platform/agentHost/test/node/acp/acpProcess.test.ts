/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { FileAccess } from '../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ExternalAcpAgentCapability, ExternalAcpAgentCwdPolicy, ExternalAcpAgentSnapshotAgent } from '../../../common/acpAgentConfig.js';
import { AcpError, AcpErrorCode } from '../../../node/acp/acpErrors.js';
import { AcpProcess } from '../../../node/acp/acpProcess.js';

suite('acpProcess', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('initializes fake ACP process successfully', async () => {
		const process = disposables.add(createProcess('success'));

		assert.deepStrictEqual(await process.initialize(), {
			protocolVersion: 1,
			agentCapabilities: {},
			authMethods: [],
			agentInfo: {
				name: 'fake-acp-agent',
				title: 'Fake ACP Agent',
				version: '1.0.0',
			},
		});
	});

	test('unsupported protocol version fails clearly', async () => {
		const process = disposables.add(createProcess('unsupported-version'));

		await assertAcpRejects(process.initialize(), AcpErrorCode.UnsupportedProtocolVersion);
	});

	test('auth-required JSON-RPC errors are structured and redacted', async () => {
		const process = disposables.add(createProcess('auth-required'));

		await assert.rejects(process.initialize(), (err: unknown) => {
			assert.ok(err instanceof AcpError);
			assert.deepStrictEqual({
				code: err.acpCode,
				message: err.message,
				leaksRemoteSecret: err.message.includes('abc123'),
			}, {
				code: AcpErrorCode.AuthRequired,
				message: 'ACP agent requires authentication.',
				leaksRemoteSecret: false,
			});
			return true;
		});
	});

	test('malformed JSON cleans up the process and rejects initialize', async () => {
		const process = disposables.add(createProcess('malformed-json'));

		await assertAcpRejects(process.initialize(), AcpErrorCode.MalformedJson);
		assert.strictEqual(process.diagnostic().running, false);
	});

	test('request timeout rejects initialize and kills the child without manual dispose', async () => {
		const process = disposables.add(createProcess('timeout', { initializeTimeoutMs: 10 }));

		await assertAcpRejects(process.initialize(), AcpErrorCode.Timeout);

		assert.strictEqual(process.diagnostic().running, false);
	});

	test('process exit rejects pending initialize and records exit diagnostics', async () => {
		const process = disposables.add(createProcess('exit-after-request'));

		await assertAcpRejects(process.initialize(), AcpErrorCode.ProcessExited);
		await waitForExitCode(process);
		assert.deepStrictEqual({
			running: process.diagnostic().running,
			exitCode: process.diagnostic().exitCode,
		}, {
			running: false,
			exitCode: 4,
		});
	});

	test('stderr diagnostics redact copied secret env values', async () => {
		const process = disposables.add(createProcess('stderr-secret', {
			agent: { ...fakeAgent('stderr-secret'), envVariableNames: ['ACP_FAKE_SECRET'] },
			hostEnv: { PATH: processEnvPath(), ACP_FAKE_SECRET: 'super-secret-token' },
		}));

		await process.initialize();

		assert.deepStrictEqual({
			stderr: process.diagnostic().stderr.trim(),
			leaked: process.diagnostic().stderr.includes('super-secret-token'),
		}, {
			stderr: 'token=[redacted]',
			leaked: false,
		});
	});

	test('missing env and secret refs fail before spawn with structured errors', async () => {
		const missingEnv = createProcess('success', {
			agent: { ...fakeAgent('success'), envVariableNames: ['ACP_REQUIRED_TOKEN'] },
			hostEnv: { PATH: processEnvPath() },
		});
		const secretRef = createProcess('success', {
			agent: { ...fakeAgent('success'), secretRefs: ['secret://cursor/auth'] },
			hostEnv: { PATH: processEnvPath() },
		});
		disposables.add(missingEnv);
		disposables.add(secretRef);

		await assertAcpRejects(missingEnv.initialize(), AcpErrorCode.MissingRuntimeEnv);
		await assertAcpRejects(secretRef.initialize(), AcpErrorCode.MissingRuntimeEnv);
	});

	test('process not found is reported without shell execution', async () => {
		const process = disposables.add(new AcpProcess({
			agent: {
				...fakeAgent('success'),
				command: 'definitely-not-a-real-acp-command-for-vscode-tests',
				args: [],
			},
			hostEnv: { PATH: processEnvPath() },
			initializeTimeoutMs: 1_000,
		}));

		await assertAcpRejects(process.initialize(), AcpErrorCode.ProcessNotFound);
		assert.strictEqual(process.diagnostic().running, false);
	});

	function createProcess(mode: string, options: Partial<ConstructorParameters<typeof AcpProcess>[0]> = {}): AcpProcess {
		return new AcpProcess({
			agent: fakeAgent(mode),
			hostEnv: { PATH: processEnvPath() },
			initializeTimeoutMs: 1_000,
			...options,
		});
	}
});

function fakeAgent(mode: string): ExternalAcpAgentSnapshotAgent {
	return {
		id: `fake-${mode}`,
		displayName: 'Fake ACP Agent',
		command: process.execPath,
		args: [FileAccess.asFileUri('vs/platform/agentHost/test/node/acp/fixtures/fakeAcpAgent.js').fsPath, mode],
		cwdPolicy: ExternalAcpAgentCwdPolicy.None,
		capabilities: [ExternalAcpAgentCapability.Text, ExternalAcpAgentCapability.Reasoning],
	};
}

function processEnvPath(): string {
	return process.env.PATH ?? process.env.Path ?? '';
}

async function assertAcpRejects(promise: Promise<unknown>, code: AcpErrorCode): Promise<void> {
	await assert.rejects(promise, (err: unknown) => err instanceof AcpError && err.acpCode === code);
}

async function waitForExitCode(process: AcpProcess): Promise<void> {
	for (let i = 0; i < 20; i++) {
		if (process.diagnostic().exitCode !== undefined) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}
