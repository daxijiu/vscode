/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import { FileAccess } from '../../../../../base/common/network.js';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ExternalAcpAgentCapability, ExternalAcpAgentCwdPolicy, ExternalAcpAgentSnapshotAgent } from '../../../common/acpAgentConfig.js';
import { AcpDiagnosticStatus } from '../../../node/acp/acpDiagnostics.js';
import { AcpError, AcpErrorCode } from '../../../node/acp/acpErrors.js';
import { AcpPermissionBridge } from '../../../node/acp/acpPermissionBridge.js';
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

	test('omits disabled side-effect capabilities from initialize by default', async () => {
		const process = disposables.add(createProcess('capabilities-echo', {
			agent: {
				...fakeAgent('capabilities-echo'),
				capabilities: [
					ExternalAcpAgentCapability.Text,
					ExternalAcpAgentCapability.Tools,
					ExternalAcpAgentCapability.Files,
					ExternalAcpAgentCapability.Terminal,
				],
			},
		}));

		const result = await process.initialize();

		assert.deepStrictEqual(result.agentInfo?._meta?.receivedClientCapabilities, {});
	});

	test('sends only policy-enabled side-effect capabilities during initialize', async () => {
		const process = disposables.add(createProcess('capabilities-echo', {
			agent: {
				...fakeAgent('capabilities-echo'),
				capabilities: [
					ExternalAcpAgentCapability.Text,
					ExternalAcpAgentCapability.Tools,
					ExternalAcpAgentCapability.Files,
					ExternalAcpAgentCapability.Terminal,
				],
			},
			capabilityPolicy: {
				allowFileRead: true,
				allowFileWrite: false,
				allowTerminal: true,
				allowTools: true,
			},
		}));

		const result = await process.initialize();

		assert.deepStrictEqual(result.agentInfo?._meta?.receivedClientCapabilities, {
			fs: { readTextFile: true },
			terminal: true,
			_meta: { toolCalls: true },
		});
	});

	test('records initialize auth methods without exposing auth secrets', async () => {
		const process = disposables.add(createProcess('auth-methods'));

		await process.initialize();

		assert.deepStrictEqual(process.getAuthMethods(), [{
			id: 'fake-login',
			name: 'Fake Login',
			description: 'Uses vendor-owned fake login',
		}]);
	});

	test('records negotiated initialize capabilities without exposing model secrets', async () => {
		const process = disposables.add(createProcess('models-list'));

		await process.initialize();

		const capabilities = process.getCapabilities();
		assert.deepStrictEqual({
			models: capabilities.models,
			leaksSecret: JSON.stringify(capabilities).includes('secret') || JSON.stringify(capabilities).includes('abc123') || JSON.stringify(capabilities).includes('apiKey'),
		}, {
			models: [{
				id: 'fake-model',
				name: 'Fake Model',
				maxContextWindow: 123456,
				supportsVision: true,
				configSchema: {
					type: 'object',
					properties: {
						effort: {
							type: 'string',
							title: 'Effort',
							enum: ['low', 'high'],
							default: 'low',
						},
					},
				},
			}],
			leaksSecret: false,
		});
	});

	test('authenticates with a vendor auth method after explicit caller action', async () => {
		const process = disposables.add(createProcess('authenticate-success'));

		const initialize = await process.initialize();
		const result = await process.authenticate(initialize.authMethods?.[0].id ?? '');

		assert.deepStrictEqual(result, { authenticated: true });
	});

	test('authenticate failures are structured and redacted', async () => {
		const process = disposables.add(createProcess('authenticate-fail'));

		await process.initialize();

		await assert.rejects(process.authenticate('fake-login'), (err: unknown) => {
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

	test('authenticate timeout rejects and caller disposal kills the child', async () => {
		const process = disposables.add(createProcess('authenticate-timeout', { authenticateTimeoutMs: 10 }));

		await process.initialize();
		await assertAcpRejects(process.authenticate('fake-login'), AcpErrorCode.Timeout);
		process.dispose();

		assert.strictEqual(process.diagnostic().status, AcpDiagnosticStatus.Exited);
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
		assert.strictEqual(process.diagnostic().status, AcpDiagnosticStatus.Exited);
	});

	test('request timeout rejects initialize and kills the child without manual dispose', async () => {
		const process = disposables.add(createProcess('timeout', { initializeTimeoutMs: 10 }));

		await assertAcpRejects(process.initialize(), AcpErrorCode.Timeout);

		assert.strictEqual(process.diagnostic().status, AcpDiagnosticStatus.Exited);
	});

	test('process exit rejects pending initialize and records exit diagnostics', async () => {
		const process = disposables.add(createProcess('exit-after-request'));

		await assertAcpRejects(process.initialize(), AcpErrorCode.ProcessExited);
		await waitForExitCode(process);
		assert.deepStrictEqual({
			status: process.diagnostic().status,
			exitCode: process.diagnostic().exitCode,
		}, {
			status: AcpDiagnosticStatus.Exited,
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
			stderrAvailable: process.diagnostic().stderrAvailable,
			stderrLineCount: process.diagnostic().stderrLineCount,
			leaked: JSON.stringify(process.diagnostic()).includes('super-secret-token') || JSON.stringify(process.diagnostic()).includes('token='),
		}, {
			stderrAvailable: true,
			stderrLineCount: 1,
			leaked: false,
		});
	});

	test('diagnostic command summary omits raw arguments', async () => {
		const process = disposables.add(createProcess('success', {
			agent: {
				...fakeAgent('success'),
				args: [...fakeAgent('success').args, '--token', 'super-secret-token'],
			},
		}));

		await process.initialize();

		assert.deepStrictEqual({
			argCount: process.diagnostic().command.argCount,
			resolvedBy: process.diagnostic().command.resolvedBy,
			leaksArgSecret: JSON.stringify(process.diagnostic().command).includes('super-secret-token'),
		}, {
			argCount: 4,
			resolvedBy: 'direct',
			leaksArgSecret: false,
		});
	});

	test('creates a session and streams prompt notifications', async () => {
		const process = disposables.add(createProcess('text-stream'));
		const updates: string[] = [];

		await process.initialize();
		disposables.add(process.onDidNotification(notification => {
			if (notification.method === 'session/update') {
				const params = notification.params as { readonly update?: { readonly content?: { readonly text?: string } } };
				const text = params.update?.content?.text;
				if (text) {
					updates.push(text);
				}
			}
		}));
		const session = await process.newSession(process.sessionCwd());
		const result = await process.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: 'text', text: 'Hello' }],
		});

		assert.deepStrictEqual({
			sessionId: session.sessionId.startsWith('fake-session-'),
			updates,
			result,
		}, {
			sessionId: true,
			updates: ['Hello ', 'ACP'],
			result: { stopReason: 'end_turn' },
		});
	});

	test('sends cancel as a notification and receives cancelled prompt result', async () => {
		const process = disposables.add(createProcess('cancel-race'));

		await process.initialize();
		const session = await process.newSession(process.sessionCwd());
		const prompt = process.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: 'text', text: 'Cancel me' }],
		});
		await process.cancel(session.sessionId);

		assert.deepStrictEqual(await prompt, { stopReason: 'cancelled' });
	});

	test('answers inbound permission requests with default deny outcome', async () => {
		const process = disposables.add(createProcess('permission-request-denied'));
		const updates: string[] = [];

		await process.initialize();
		disposables.add(process.onDidNotification(notification => {
			const params = notification.params as { readonly update?: { readonly content?: { readonly text?: string } } };
			const text = params.update?.content?.text;
			if (text) {
				updates.push(text);
			}
		}));
		const session = await process.newSession(process.sessionCwd());
		const result = await process.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: 'text', text: 'Need permission' }],
		});

		assert.deepStrictEqual({
			updates,
			result,
		}, {
			updates: ['permission:reject-once'],
			result: { stopReason: 'end_turn' },
		});
	});

	test('cancel resolves a pending inbound permission request with cancelled outcome', async () => {
		const permissionBridge = new AcpPermissionBridge({ autoDeny: false });
		const process = disposables.add(createProcess('permission-pending-cancel', { permissionBridge }));

		await process.initialize();
		const session = await process.newSession(process.sessionCwd());
		const prompt = process.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: 'text', text: 'Need cancellable permission' }],
		});
		await wait(20);
		await process.cancel(session.sessionId);

		assert.deepStrictEqual(await prompt, { stopReason: 'cancelled' });
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
		assert.strictEqual(process.diagnostic().status, AcpDiagnosticStatus.NotStarted);
	});

	test('Windows cmd shim spawns safe bat paths and arguments with spaces', async function () {
		if (process.platform !== 'win32') {
			this.skip();
		}
		const tempDir = await fs.mkdtemp(join(os.tmpdir(), 'vscode acp process '));
		try {
			const commandPath = join(tempDir, 'fake agent launcher.bat');
			const markerPath = join(tempDir, 'safe launch marker.txt');
			await fs.writeFile(commandPath, [
				'@echo off',
				'echo ran>"%ACP_MARKER%"',
				'"%ACP_NODE_EXE%" "%ACP_FAKE_AGENT%" success %*',
				'',
			].join('\r\n'));

			const acpProcess = disposables.add(createProcess('success', {
				agent: {
					...fakeAgent('success'),
					command: commandPath,
					args: ['safe profile'],
					envVariableNames: ['ACP_NODE_EXE', 'ACP_FAKE_AGENT', 'ACP_MARKER'],
				},
				hostEnv: {
					PATH: processEnvPath(),
					ACP_NODE_EXE: process.execPath,
					ACP_FAKE_AGENT: FileAccess.asFileUri('vs/platform/agentHost/test/node/acp/fixtures/fakeAcpAgent.js').fsPath,
					ACP_MARKER: markerPath,
				},
			}));

			assert.deepStrictEqual(await acpProcess.initialize(), {
				protocolVersion: 1,
				agentCapabilities: {},
				authMethods: [],
				agentInfo: {
					name: 'fake-acp-agent',
					title: 'Fake ACP Agent',
					version: '1.0.0',
				},
			});
			assert.strictEqual((await fs.readFile(markerPath, 'utf8')).trim(), 'ran');
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test('Windows cmd shim rejects dangerous bat arguments before execution', async function () {
		if (process.platform !== 'win32') {
			this.skip();
		}
		const tempDir = await fs.mkdtemp(join(os.tmpdir(), 'vscode acp process '));
		try {
			const commandPath = join(tempDir, 'fake agent launcher.cmd');
			const markerPath = join(tempDir, 'unsafe launch marker.txt');
			await fs.writeFile(commandPath, [
				'@echo off',
				'echo ran>"%ACP_MARKER%"',
				'"%ACP_NODE_EXE%" "%ACP_FAKE_AGENT%" success %*',
				'',
			].join('\r\n'));

			const acpProcess = disposables.add(createProcess('success', {
				agent: {
					...fakeAgent('success'),
					command: commandPath,
					args: ['safe profile & echo unsafe'],
					envVariableNames: ['ACP_NODE_EXE', 'ACP_FAKE_AGENT', 'ACP_MARKER'],
				},
				hostEnv: {
					PATH: processEnvPath(),
					ACP_NODE_EXE: process.execPath,
					ACP_FAKE_AGENT: FileAccess.asFileUri('vs/platform/agentHost/test/node/acp/fixtures/fakeAcpAgent.js').fsPath,
					ACP_MARKER: markerPath,
				},
			}));

			await assertAcpRejects(acpProcess.initialize(), AcpErrorCode.UnsupportedCommand);
			assert.strictEqual(await exists(markerPath), false);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
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
		await wait(5);
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await fs.access(path);
		return true;
	} catch {
		return false;
	}
}

function wait(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
