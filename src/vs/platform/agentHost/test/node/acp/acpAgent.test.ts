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
import { ResponsePartKind, ToolCallStatus, ToolResultContentType, TurnState } from '../../../common/state/protocol/state.js';
import { AcpAgent, getAcpAgentSubscriptionDescription, toAcpAgentProviderId } from '../../../node/acp/acpAgent.js';

suite('AcpAgent', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function hasActionType(action: unknown, type: ActionType): boolean {
		if (typeof action !== 'object' || action === null) {
			return false;
		}
		const candidate = action as { readonly type?: unknown };
		return Object.prototype.hasOwnProperty.call(candidate, 'type') && candidate.type === type;
	}

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

	test('execution disabled gate prevents createSession from spawning', async () => {
		const agent = disposables.add(new AcpAgent(createSnapshotAgent({ command: 'definitely-not-a-real-acp-command' }), { executionEnabled: false }));

		await assert.rejects(agent.createSession({ workingDirectory: URI.file(process.cwd()) }), /External ACP agent execution is disabled/);
	});

	test('workspace cwd policy rejects non-local workspace URIs before spawning', async () => {
		const agent = disposables.add(new AcpAgent(createSnapshotAgent({ command: 'definitely-not-a-real-acp-command' })));

		await assert.rejects(agent.createSession({ workingDirectory: URI.parse('vscode-remote://ssh-remote+host/workspace') }), /only local file workspaces/);
	});

	test('keeps placeholder model when initialize returns no model list', async () => {
		const agent = disposables.add(new AcpAgent(fakeAgent('text-stream')));

		await agent.createSession({ workingDirectory: URI.file(process.cwd()) });

		assert.deepStrictEqual(agent.models.get(), [{
			provider: 'acp-fake-text-stream',
			id: 'external-acp-runtime',
			name: 'Fake ACP Agent Runtime',
			supportsVision: false,
			_meta: {
				externalAcpAgent: true,
				vendorLabel: 'Cursor',
			},
		}]);
	});

	test('updates AgentHost models from explicit initialize model list without leaking secret fields', async () => {
		const agent = disposables.add(new AcpAgent(fakeAgent('models-list')));

		await agent.createSession({ workingDirectory: URI.file(process.cwd()) });
		const models = agent.models.get();
		const payload = JSON.stringify(models);

		assert.deepStrictEqual({
			models,
			leaksSecret: payload.includes('secret') || payload.includes('abc123') || payload.includes('apiKey'),
		}, {
			models: [{
				provider: 'acp-fake-models-list',
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
				_meta: {
					externalAcpAgent: true,
					vendorLabel: 'Cursor',
				},
			}],
			leaksSecret: false,
		});
	});

	test('exposes mode and config schema only from explicit capability state', async () => {
		const agent = disposables.add(new AcpAgent(fakeAgent('config-modes')));

		assert.deepStrictEqual(await agent.resolveSessionConfig({ provider: agent.id }), { schema: { type: 'object', properties: {} }, values: {} });

		await agent.createSession({ workingDirectory: URI.file(process.cwd()) });
		const resolved = await agent.resolveSessionConfig({
			provider: agent.id,
			config: {
				mode: 'plan',
				temperature: 0.7,
				note: 'token=abc123',
				password: 'super-secret',
			},
		});
		const completions = await agent.sessionConfigCompletions({ provider: agent.id, property: 'profile', query: 'a' });
		const payload = JSON.stringify({ resolved, completions });

		assert.deepStrictEqual({
			resolved,
			completions,
			leaksSecret: payload.includes('abc123') || payload.includes('password') || payload.includes('super-secret') || payload.includes('token='),
		}, {
			resolved: {
				schema: {
					type: 'object',
					properties: {
						temperature: {
							type: 'number',
							title: 'Temperature',
							default: 0.4,
						},
						profile: {
							type: 'string',
							title: 'Profile',
							enumDynamic: true,
						},
						note: {
							type: 'string',
							title: 'Note',
						},
						mode: {
							type: 'string',
							title: 'Mode',
							description: 'Vendor-advertised ACP session mode.',
							enum: ['interactive', 'plan'],
							enumLabels: ['Interactive', 'Plan'],
							enumDescriptions: ['', 'Plan first'],
							default: 'interactive',
							sessionMutable: false,
						},
					},
					required: ['temperature'],
				},
				values: {
					temperature: 0.7,
					mode: 'plan',
				},
			},
			completions: {
				items: [
					{ value: 'fast', label: 'Fast' },
					{ value: 'accurate', label: 'Accurate' },
				],
			},
			leaksSecret: false,
		});
	});

	test('ignores direct initialize metadata capabilities outside explicit capability containers', async () => {
		const agent = disposables.add(new AcpAgent(fakeAgent('meta-capability-boundary')));

		await agent.createSession({ workingDirectory: URI.file(process.cwd()) });
		const resolved = await agent.resolveSessionConfig({ provider: agent.id });

		assert.deepStrictEqual({
			models: agent.models.get(),
			resolved,
		}, {
			models: [{
				provider: 'acp-fake-meta-capability-boundary',
				id: 'nested-capability-model',
				name: 'Nested Capability Model',
				supportsVision: false,
				_meta: {
					externalAcpAgent: true,
					vendorLabel: 'Cursor',
				},
			}],
			resolved: {
				schema: {
					type: 'object',
					properties: {
						nestedCapabilityProperty: {
							type: 'string',
							title: 'Nested Capability Property',
						},
					},
				},
				values: {},
			},
		});
	});

	test('rejects config completions for non-schema and secret-like properties', async () => {
		const agent = disposables.add(new AcpAgent(fakeAgent('config-modes')));

		await agent.createSession({ workingDirectory: URI.file(process.cwd()) });
		const completions = {
			unknownProperty: await agent.sessionConfigCompletions({ provider: agent.id, property: 'unknownProperty' }),
			token: await agent.sessionConfigCompletions({ provider: agent.id, property: 'token' }),
			credentials: await agent.sessionConfigCompletions({ provider: agent.id, property: 'credentials' }),
		};

		assert.deepStrictEqual(completions, {
			unknownProperty: { items: [] },
			token: { items: [] },
			credentials: { items: [] },
		});
	});

	test('changeModel remains unsupported and does not call ACP set-model methods', async () => {
		const tempDir = await fs.mkdtemp(join(os.tmpdir(), 'vscode-acp-agent-test-'));
		try {
			const markerPath = join(tempDir, 'methods.txt');
			const agent = new AcpAgent(fakeAgent('unsupported-set-model', {
				args: [FileAccess.asFileUri('vs/platform/agentHost/test/node/acp/fixtures/fakeAcpAgent.js').fsPath, 'unsupported-set-model', markerPath],
			}));
			try {
				const created = await agent.createSession({ workingDirectory: URI.file(process.cwd()) });

				await assert.rejects(agent.changeModel(created.session, { id: 'fake-model' }), /model selection is not available/);

				assert.deepStrictEqual({
					models: agent.models.get().map(model => model.id),
					methodCalls: await readOptionalFile(markerPath),
				}, {
					models: ['fake-model'],
					methodCalls: undefined,
				});
			} finally {
				agent.dispose();
			}
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test('listSessions remains local-only even when restore capabilities are advertised', async () => {
		const tempDir = await fs.mkdtemp(join(os.tmpdir(), 'vscode-acp-agent-test-'));
		try {
			const markerPath = join(tempDir, 'methods.txt');
			const agent = new AcpAgent(fakeAgent('restore-capability-only', {
				args: [FileAccess.asFileUri('vs/platform/agentHost/test/node/acp/fixtures/fakeAcpAgent.js').fsPath, 'restore-capability-only', markerPath],
			}));
			try {
				const created = await agent.createSession({ workingDirectory: URI.file(process.cwd()) });

				assert.deepStrictEqual({
					listed: (await agent.listSessions()).map(session => session.session.toString()),
					methodCalls: await readOptionalFile(markerPath),
				}, {
					listed: [created.session.toString()],
					methodCalls: undefined,
				});
			} finally {
				agent.dispose();
			}
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test('failed replacement initialize does not pollute previous capability state', async () => {
		const tempDir = await fs.mkdtemp(join(os.tmpdir(), 'vscode-acp-agent-test-'));
		try {
			const markerPath = join(tempDir, 'started.txt');
			const session = URI.parse('acp-fake-models-list-fail-second-initialize:///same-session');
			const agent = new AcpAgent(fakeAgent('models-list-fail-second-initialize', {
				args: [FileAccess.asFileUri('vs/platform/agentHost/test/node/acp/fixtures/fakeAcpAgent.js').fsPath, 'models-list-fail-second-initialize', markerPath],
			}));
			try {
				await agent.createSession({ session, workingDirectory: URI.file(process.cwd()) });
				const before = agent.models.get();

				await assert.rejects(agent.createSession({ session, workingDirectory: URI.file(process.cwd()) }), /ACP request failed\./);

				assert.deepStrictEqual({
					starts: (await waitForStartedPids(markerPath, 2)).length,
					before,
					after: agent.models.get(),
				}, {
					starts: 2,
					before: [{
						provider: 'acp-fake-models-list-fail-second-initialize',
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
						_meta: {
							externalAcpAgent: true,
							vendorLabel: 'Cursor',
						},
					}],
					after: before,
				});
			} finally {
				agent.dispose();
			}
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
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

	test('crash during prompt emits one redacted terminal error and cleans up child', async () => {
		const agent = disposables.add(new AcpAgent(fakeAgent('crash-during-prompt')));
		const terminalActions: string[] = [];
		disposables.add(agent.onDidSessionProgress(signal => {
			if (signal.kind === 'action' && (signal.action.type === ActionType.SessionTurnCancelled || signal.action.type === ActionType.SessionTurnComplete || signal.action.type === ActionType.SessionError)) {
				terminalActions.push(signal.action.type);
			}
		}));
		const created = await agent.createSession({ workingDirectory: URI.file(process.cwd()) });

		await agent.sendMessage(created.session, 'Crash safely', undefined, 'turn-1');
		await wait(20);

		assert.deepStrictEqual({
			terminalActions,
			turns: (await agent.getSessionMessages(created.session)).map(turn => ({
				state: turn.state,
				error: turn.error?.message,
				leaksSecret: JSON.stringify(turn).includes('abc123'),
			})),
		}, {
			terminalActions: [ActionType.SessionError],
			turns: [{
				state: TurnState.Error,
				error: 'ACP runtime process exited.',
				leaksSecret: false,
			}],
		});
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

	test('tool_call lifecycle updates render AgentHost tool actions and reported content', async () => {
		const agent = disposables.add(new AcpAgent(fakeAgent('tool-call-lifecycle')));
		const actions: string[] = [];
		disposables.add(agent.onDidSessionProgress(signal => {
			if (signal.kind === 'action') {
				actions.push(signal.action.type);
			}
		}));
		const created = await agent.createSession({ workingDirectory: URI.file(process.cwd()) });

		await agent.sendMessage(created.session, 'Tool?', undefined, 'turn-1');
		const turn = (await agent.getSessionMessages(created.session))[0];
		const toolPart = turn.responseParts[0];

		assert.deepStrictEqual({
			actions,
			state: turn.state,
			tool: toolPart.kind === ResponsePartKind.ToolCall ? {
				status: toolPart.toolCall.status,
				toolName: toolPart.toolCall.toolName,
				displayName: toolPart.toolCall.displayName,
				toolCallId: toolPart.toolCall.toolCallId,
				success: toolPart.toolCall.status === ToolCallStatus.Completed ? toolPart.toolCall.success : undefined,
				contentType: toolPart.toolCall.status === ToolCallStatus.Completed ? toolPart.toolCall.content?.[0]?.type : undefined,
				contentText: toolPart.toolCall.status === ToolCallStatus.Completed ? toolPart.toolCall.content?.[0]?.type === ToolResultContentType.Text ? toolPart.toolCall.content[0].text : undefined : undefined,
				toolInput: toolPart.toolCall.status === ToolCallStatus.Completed ? toolPart.toolCall.toolInput : undefined,
			} : undefined,
		}, {
			actions: [
				ActionType.SessionToolCallStart,
				ActionType.SessionToolCallReady,
				ActionType.SessionToolCallContentChanged,
				ActionType.SessionToolCallDelta,
				ActionType.SessionToolCallComplete,
				ActionType.SessionTurnComplete,
			],
			state: TurnState.Complete,
			tool: {
				status: ToolCallStatus.Completed,
				toolName: 'acp.read',
				displayName: 'Read file',
				toolCallId: 'acp-tool-1',
				success: true,
				contentType: ToolResultContentType.Text,
				contentText: 'terminal output token=abc123',
				toolInput: 'Locations\n- /secret/file.txt',
			},
		});
	});

	test('maps malicious tool_call id and kind while preserving user-facing report content', async () => {
		const agent = disposables.add(new AcpAgent(fakeAgent('tool-call-malicious-metadata')));
		const actions: unknown[] = [];
		disposables.add(agent.onDidSessionProgress(signal => {
			if (signal.kind === 'action') {
				actions.push(signal.action);
			}
		}));
		const created = await agent.createSession({ workingDirectory: URI.file(process.cwd()) });

		await agent.sendMessage(created.session, 'Tool?', undefined, 'turn-1');
		const payload = JSON.stringify({
			actions,
			turns: await agent.getSessionMessages(created.session),
		});

		assert.deepStrictEqual({
			hasToolStart: actions.some(action => hasActionType(action, ActionType.SessionToolCallStart)),
			hasOpaqueId: payload.includes('acp-tool-1'),
			leaksRawToolCallId: payload.includes('call-token-sk-abc123'),
			hasReportedContent: payload.includes('terminal output token=abc123'),
		}, {
			hasToolStart: true,
			hasOpaqueId: true,
			leaksRawToolCallId: false,
			hasReportedContent: true,
		});
	});

	test('failed tool_call lifecycle completes as a failed reported tool result', async () => {
		const agent = disposables.add(new AcpAgent(fakeAgent('tool-call-failed')));
		const created = await agent.createSession({ workingDirectory: URI.file(process.cwd()) });

		await agent.sendMessage(created.session, 'Tool?', undefined, 'turn-1');
		const turn = (await agent.getSessionMessages(created.session))[0];
		const toolPart = turn.responseParts[0];

		assert.deepStrictEqual({
			state: turn.state,
			tool: toolPart.kind === ResponsePartKind.ToolCall && toolPart.toolCall.status === ToolCallStatus.Completed ? {
				success: toolPart.toolCall.success,
				error: toolPart.toolCall.error?.message,
				hasRawOutputSummary: JSON.stringify(toolPart).includes('terminal secret output'),
			} : undefined,
		}, {
			state: TurnState.Complete,
			tool: {
				success: false,
				error: 'ACP tool failed or was rejected.',
				hasRawOutputSummary: true,
			},
		});
	});

	test('permission request renders options and returns selected ACP option id', async () => {
		const agent = disposables.add(new AcpAgent(fakeAgent('permission-request-denied')));
		const signals: unknown[] = [];
		disposables.add(agent.onDidSessionProgress(signal => {
			signals.push(signal);
			if (signal.kind === 'pending_confirmation') {
				agent.respondToPermissionRequest(signal.state.toolCallId, false, 'reject-once');
			}
		}));
		const created = await agent.createSession({ workingDirectory: URI.file(process.cwd()) });

		await agent.sendMessage(created.session, 'Need permission', undefined, 'turn-1');
		const turn = (await agent.getSessionMessages(created.session))[0];
		const pending = signals.find((signal): signal is { readonly kind: 'pending_confirmation'; readonly state: { readonly options?: readonly { readonly id: string; readonly label: string }[] } } => {
			return typeof signal === 'object' && signal !== null && (signal as { readonly kind?: unknown }).kind === 'pending_confirmation';
		});

		assert.deepStrictEqual({
			options: pending?.state.options,
			response: turn.responseParts[1]?.kind === ResponsePartKind.Markdown ? turn.responseParts[1].content : undefined,
		}, {
			options: [
				{ id: 'allow-once', label: 'Allow Once', kind: 'approve', group: 1 },
				{ id: 'reject-once', label: 'Reject Once', kind: 'deny', group: 2 },
			],
			response: 'permission:reject-once',
		});
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

async function readOptionalFile(file: string): Promise<string | undefined> {
	try {
		return await fs.readFile(file, 'utf8');
	} catch {
		return undefined;
	}
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
