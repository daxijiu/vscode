/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import { FileAccess } from '../../../../../base/common/network.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { join } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ExternalAcpAgentCapability, ExternalAcpAgentCwdPolicy, ExternalAcpAgentSnapshotAgent } from '../../../common/acpAgentConfig.js';
import { ActionType } from '../../../common/state/sessionActions.js';
import { ResponsePartKind, TurnState } from '../../../common/state/protocol/state.js';
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

	test('non-runtime methods are safe and do not launch ACP processes', async () => {
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
		} finally {
			store.dispose();
		}
	});

	test('creates ACP session and streams text transcript', async () => {
		const agent = disposables.add(new AcpAgent(fakeAgent('text-stream')));
		const actions: string[] = [];
		disposables.add(agent.onDidSessionProgress(signal => {
			if (signal.kind === 'action') {
				actions.push(signal.action.type);
			}
		}));

		const created = await agent.createSession({ workingDirectory: URI.file(process.cwd()) });
		await agent.sendMessage(created.session, 'Say hello', undefined, 'turn-1');
		const turns = await agent.getSessionMessages(created.session);

		assert.deepStrictEqual({
			sessionScheme: created.session.scheme,
			actions,
			turns,
			listed: (await agent.listSessions()).map(session => session.session.toString()),
		}, {
			sessionScheme: 'acp-fake-text-stream',
			actions: [
				ActionType.SessionResponsePart,
				ActionType.SessionDelta,
				ActionType.SessionDelta,
				ActionType.SessionTurnComplete,
			],
			turns: [{
				id: 'turn-1',
				userMessage: { text: 'Say hello' },
				responseParts: [{
					kind: ResponsePartKind.Markdown,
					id: turns[0].responseParts[0].kind === ResponsePartKind.Markdown ? turns[0].responseParts[0].id : '',
					content: 'Hello ACP',
				}],
				usage: undefined,
				state: TurnState.Complete,
			}],
			listed: [created.session.toString()],
		});
	});

	test('streams reasoning and completes max-token stop reason', async () => {
		const agent = disposables.add(new AcpAgent(fakeAgent('reasoning-stream')));
		const created = await agent.createSession({ workingDirectory: URI.file(process.cwd()) });

		await agent.sendMessage(created.session, 'Think', undefined, 'turn-1');
		const turn = (await agent.getSessionMessages(created.session))[0];
		const reasoningPart = turn.responseParts[0];
		const markdownPart = turn.responseParts[1];

		assert.deepStrictEqual(turn, {
			id: 'turn-1',
			userMessage: { text: 'Think' },
			responseParts: [
				{
					kind: ResponsePartKind.Reasoning,
					id: reasoningPart.kind === ResponsePartKind.Reasoning ? reasoningPart.id : '',
					content: 'Thinking',
				},
				{
					kind: ResponsePartKind.Markdown,
					id: markdownPart.kind === ResponsePartKind.Markdown ? markdownPart.id : '',
					content: 'Done',
				},
			],
			usage: { inputTokens: 2, outputTokens: 3 },
			state: TurnState.Complete,
		});
	});

	test('reports vendor login message when session/new requires auth', async () => {
		const agent = disposables.add(new AcpAgent(fakeAgent('auth-on-session-new', {
			vendorLabel: 'Cursor',
			loginCommand: 'cursor-agent login',
			loginHelpUrl: 'https://cursor.example/login',
		})));

		await assert.rejects(agent.createSession({ workingDirectory: URI.file(process.cwd()) }), /Sign in with Cursor using the vendor-owned login flow, then retry this ACP agent\. Login command: cursor-agent login Login help: https:\/\/cursor\.example\/login/);
	});

	test('reports redacted auth method hints when session/new requires auth', async () => {
		const agent = disposables.add(new AcpAgent(fakeAgent('auth-on-session-new-with-methods', { vendorLabel: 'Cursor' })));

		await assert.rejects(agent.createSession({ workingDirectory: URI.file(process.cwd()) }), (err: unknown) => {
			assert.ok(err instanceof Error);
			assert.deepStrictEqual({
				hasAuthMethods: err.message.includes('Advertised auth methods: Fake Login'),
				leaksToken: err.message.includes('abc123'),
			}, {
				hasAuthMethods: true,
				leaksToken: false,
			});
			return true;
		});
	});

	test('recreating the same session URI disposes the previous ACP process', async () => {
		const tempDir = await fs.mkdtemp(join(os.tmpdir(), 'vscode-acp-agent-test-'));
		disposables.add({ dispose: () => { void fs.rm(tempDir, { recursive: true, force: true }); } });
		const markerPath = join(tempDir, 'disposed.txt');
		const session = URI.parse('acp-fake-dispose-marker:///same-session');
		const agent = disposables.add(new AcpAgent(fakeAgent('dispose-marker', {
			args: [FileAccess.asFileUri('vs/platform/agentHost/test/node/acp/fixtures/fakeAcpAgent.js').fsPath, 'dispose-marker', markerPath],
		})));

		await agent.createSession({ session, workingDirectory: URI.file(process.cwd()) });
		await agent.createSession({ session, workingDirectory: URI.file(process.cwd()) });
		const pids = await waitForStartedPids(markerPath, 2);
		await waitForProcessExit(pids[0]);

		assert.deepStrictEqual({
			startedProcesses: pids.length,
			listed: (await agent.listSessions()).map(session => session.session.toString()),
		}, {
			startedProcesses: 2,
			listed: [session.toString()],
		});
	});

	test('failed replacement during initialize keeps the previous ACP session and process', async () => {
		await assertFailedReplacementKeepsExistingSession('dispose-marker-fail-second-initialize', /ACP request failed\./);
	});

	test('failed replacement during session/new keeps the previous ACP session and process', async () => {
		await assertFailedReplacementKeepsExistingSession('dispose-marker-fail-second-session-new', /Sign in with Cursor using the vendor-owned login flow, then retry this ACP agent\./);
	});

	test('maps prompt error to terminal error turn', async () => {
		const agent = disposables.add(new AcpAgent(fakeAgent('prompt-error')));
		const created = await agent.createSession({ workingDirectory: URI.file(process.cwd()) });

		await agent.sendMessage(created.session, 'Fail', undefined, 'turn-1');

		assert.deepStrictEqual((await agent.getSessionMessages(created.session)).map(turn => ({ state: turn.state, error: turn.error?.message })), [{
			state: TurnState.Error,
			error: 'ACP request failed.',
		}]);
	});

	test('cancels active turn once and absorbs late updates', async () => {
		const agent = disposables.add(new AcpAgent(fakeAgent('cancel-race')));
		const terminalActions: string[] = [];
		disposables.add(agent.onDidSessionProgress(signal => {
			if (signal.kind === 'action' && (signal.action.type === ActionType.SessionTurnCancelled || signal.action.type === ActionType.SessionTurnComplete || signal.action.type === ActionType.SessionError)) {
				terminalActions.push(signal.action.type);
			}
		}));
		const created = await agent.createSession({ workingDirectory: URI.file(process.cwd()) });

		const send = agent.sendMessage(created.session, 'Cancel', undefined, 'turn-1');
		await wait(20);
		await agent.abortSession(created.session);
		await send;
		await wait(20);

		assert.deepStrictEqual({
			terminalActions,
			turns: await agent.getSessionMessages(created.session),
		}, {
			terminalActions: [ActionType.SessionTurnCancelled],
			turns: [{
				id: 'turn-1',
				userMessage: { text: 'Cancel' },
				responseParts: [],
				usage: undefined,
				state: TurnState.Cancelled,
			}],
		});
	});

	test('absorbs late updates after complete', async () => {
		const agent = disposables.add(new AcpAgent(fakeAgent('late-update-after-complete')));
		const created = await agent.createSession({ workingDirectory: URI.file(process.cwd()) });

		await agent.sendMessage(created.session, 'Complete', undefined, 'turn-1');
		await wait(20);

		const turn = (await agent.getSessionMessages(created.session))[0];
		assert.strictEqual(turn.responseParts[0].kind === ResponsePartKind.Markdown ? turn.responseParts[0].content : '', 'Finished');
	});

	test('unexpected tool calls fail clearly without waiting for tool execution', async () => {
		const agent = disposables.add(new AcpAgent(fakeAgent('tool-call-unexpected')));
		const created = await agent.createSession({ workingDirectory: URI.file(process.cwd()) });

		await agent.sendMessage(created.session, 'Tool?', undefined, 'turn-1');

		assert.deepStrictEqual((await agent.getSessionMessages(created.session)).map(turn => ({
			state: turn.state,
			error: turn.error?.message,
			system: turn.responseParts[0].kind === ResponsePartKind.SystemNotification ? turn.responseParts[0].content : undefined,
		})), [{
			state: TurnState.Error,
			error: 'This ACP agent requested a tool call, but ACP tools are not enabled in this text-only milestone.',
			system: 'This ACP agent requested a tool call, but ACP tools are not enabled in this text-only milestone.',
		}]);
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

function fakeAgent(mode: string, overrides: Partial<ExternalAcpAgentSnapshotAgent> = {}): ExternalAcpAgentSnapshotAgent {
	return createSnapshotAgent({
		id: `fake-${mode}`,
		displayName: 'Fake ACP Agent',
		command: process.execPath,
		args: [FileAccess.asFileUri('vs/platform/agentHost/test/node/acp/fixtures/fakeAcpAgent.js').fsPath, mode],
		cwdPolicy: ExternalAcpAgentCwdPolicy.None,
		...overrides,
	});
}

function wait(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function assertFailedReplacementKeepsExistingSession(mode: string, expectedError: RegExp): Promise<void> {
	const tempDir = await fs.mkdtemp(join(os.tmpdir(), 'vscode-acp-agent-test-'));
	try {
		const markerPath = join(tempDir, 'disposed.txt');
		const session = URI.parse(`acp-fake-${mode}:///same-session`);
		const agent = new AcpAgent(fakeAgent(mode, {
			args: [FileAccess.asFileUri('vs/platform/agentHost/test/node/acp/fixtures/fakeAcpAgent.js').fsPath, mode, markerPath],
		}));
		try {
			await agent.createSession({ session, workingDirectory: URI.file(process.cwd()) });
			const oldPid = (await waitForStartedPids(markerPath, 1))[0];

			await assert.rejects(agent.createSession({ session, workingDirectory: URI.file(process.cwd()) }), expectedError);
			const pids = await waitForStartedPids(markerPath, 2);
			await waitForProcessExit(pids[1]);
			assertProcessRunning(oldPid);

			await agent.sendMessage(session, 'Still works', undefined, 'turn-after-failed-replace');

			assert.deepStrictEqual({
				startedProcesses: pids.length,
				listed: (await agent.listSessions()).map(session => session.session.toString()),
				turns: (await agent.getSessionMessages(session)).map(turn => ({ id: turn.id, state: turn.state })),
			}, {
				startedProcesses: 2,
				listed: [session.toString()],
				turns: [{ id: 'turn-after-failed-replace', state: TurnState.Complete }],
			});
		} finally {
			agent.dispose();
		}
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

async function waitForStartedPids(file: string, count: number): Promise<number[]> {
	for (let i = 0; i < 50; i++) {
		try {
			const pids = (await fs.readFile(file, 'utf8'))
				.split(/\r?\n/)
				.map(line => /^start (?<pid>\d+)$/.exec(line)?.groups?.pid)
				.filter((pid): pid is string => !!pid)
				.map(pid => Number(pid));
			if (pids.length >= count) {
				return pids;
			}
		} catch {
		}
		await wait(20);
	}
	assert.fail(`Timed out waiting for ${count} ACP process starts in ${file}`);
}

function assertProcessRunning(pid: number): void {
	try {
		process.kill(pid, 0);
	} catch {
		assert.fail(`Expected process ${pid} to still be running`);
	}
}

async function waitForProcessExit(pid: number): Promise<void> {
	for (let i = 0; i < 50; i++) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		await wait(20);
	}
	assert.fail(`Timed out waiting for process ${pid} to exit`);
}
