/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { Server } from 'http';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { hasKey } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ServiceCollection } from '../../../instantiation/common/serviceCollection.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { ILogService, NullLogService } from '../../../log/common/log.js';
import { IDirectorProviderBackendHub } from '../../common/directorProviderBackend.js';
import { DirectorRuntimeCredential, DirectorRuntimeCredentialRequest, IDirectorRuntimeCredentialService } from '../../common/directorRuntimeCredentials.js';
import { AgentSession, AgentSignal } from '../../common/agentService.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { ResponsePartKind, TurnState } from '../../common/state/sessionState.js';
import { DirectorAgent } from '../../node/director/directorAgent.js';
import { DirectorProviderBackendHub, DirectorProviderBackendHubFixtures } from '../../node/director/directorProviderBackendHub.js';

suite('DirectorAgent', () => {

	const disposables = new DisposableStore();

	teardown(() => disposables.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	function createAgent(fixtures: DirectorProviderBackendHubFixtures = {}, credential: DirectorRuntimeCredential = { kind: 'none' }): DirectorAgent {
		const services = new ServiceCollection(
			[ILogService, new NullLogService()],
			[IDirectorProviderBackendHub, new DirectorProviderBackendHub(fixtures)],
			[IDirectorRuntimeCredentialService, new TestDirectorRuntimeCredentialService(credential)],
		);
		const instantiationService = disposables.add(new InstantiationService(services));
		return disposables.add(instantiationService.createInstance(DirectorAgent));
	}

	function summarizeSignals(signals: readonly AgentSignal[]): readonly object[] {
		return signals.map(signal => {
			if (signal.kind !== 'action') {
				return { kind: signal.kind };
			}
			const action = signal.action;
			if (action.type === ActionType.SessionResponsePart) {
				return {
					type: action.type,
					turnId: action.turnId,
					kind: action.part.kind,
					content: action.part.kind === ResponsePartKind.Markdown || action.part.kind === ResponsePartKind.SystemNotification ? action.part.content : undefined,
				};
			}
			if (action.type === ActionType.SessionUsage) {
				return {
					type: action.type,
					turnId: action.turnId,
					usage: action.usage,
				};
			}
			if (action.type === ActionType.SessionError) {
				return {
					type: action.type,
					turnId: action.turnId,
					message: action.error.message,
				};
			}
			return {
				type: action.type,
				turnId: hasKey(action, { turnId: true }) ? action.turnId : undefined,
			};
		});
	}

	test('publishes descriptor, fake models, and no protected resources', async () => {
		const agent = createAgent();
		await agent.refreshModels();

		assert.deepStrictEqual({
			descriptor: agent.getDescriptor(),
			protectedResources: agent.getProtectedResources(),
			authenticated: await agent.authenticate('resource', 'token'),
			models: agent.models.get().map(model => ({
				provider: model.provider,
				id: model.id,
				name: model.name,
				providerInstanceId: model._meta?.providerInstanceId,
			})),
		}, {
			descriptor: {
				provider: 'director',
				displayName: 'Director',
				description: 'Director agent backed by Director Provider Backend',
			},
			protectedResources: [],
			authenticated: false,
			models: [
				{ provider: 'director', id: 'echo', name: 'Director Echo', providerInstanceId: 'director-fake' },
				{ provider: 'director', id: 'echo-large', name: 'Director Echo Large', providerInstanceId: 'director-fake' },
			],
		});
	});

	test('creates, lists, and disposes current-process sessions', async () => {
		const agent = createAgent();
		const workingDirectory = URI.file('C:/director/project');
		const created = await agent.createSession({ workingDirectory });
		const listed = await agent.listSessions();
		await agent.disposeSession(created.session);

		assert.deepStrictEqual({
			provider: AgentSession.provider(created.session),
			workingDirectory: created.workingDirectory,
			project: created.project,
			listed: listed.map(session => ({
				session: session.session.toString(),
				project: session.project,
				model: session.model,
			})),
			afterDispose: await agent.listSessions(),
		}, {
			provider: 'director',
			workingDirectory,
			project: { uri: workingDirectory, displayName: 'project' },
			listed: [{
				session: created.session.toString(),
				project: { uri: workingDirectory, displayName: 'project' },
				model: { id: 'echo' },
			}],
			afterDispose: [],
		});
	});

	test('runs a provider-backed Director AgentEngine turn and records in-memory turns', async () => {
		const server = disposables.add(await createJsonServer({
			status: 200,
			body: {
				choices: [{ message: { content: 'provider backed hello' } }],
				usage: { prompt_tokens: 11, completion_tokens: 3 },
			},
		}));
		const agent = createAgent(createOpenAIFixtures(server.url), { kind: 'api-key', value: 'sk-test' });
		const created = await agent.createSession();
		const signals: AgentSignal[] = [];
		disposables.add(agent.onDidSessionProgress(signal => signals.push(signal)));

		await agent.sendMessage(created.session, 'hello director', undefined, 'turn-1');
		const turns = await agent.getSessionMessages(created.session);

		assert.deepStrictEqual({
			signals: summarizeSignals(signals),
			turns: turns.map(turn => ({
				id: turn.id,
				text: turn.userMessage.text,
				state: turn.state,
				responseText: turn.responseParts
					.filter(part => part.kind === ResponsePartKind.Markdown)
					.map(part => part.content)
					.join(''),
			})),
		}, {
			signals: [
				{ type: ActionType.SessionResponsePart, turnId: 'turn-1', kind: ResponsePartKind.SystemNotification, content: 'Director AgentEngine using provider \'test-provider\' with model \'gpt-test\'.' },
				{ type: ActionType.SessionResponsePart, turnId: 'turn-1', kind: ResponsePartKind.Markdown, content: 'provider backed hello' },
				{ type: ActionType.SessionUsage, turnId: 'turn-1', usage: { inputTokens: 11, outputTokens: 3 } },
				{ type: ActionType.SessionTurnComplete, turnId: 'turn-1' },
			],
			turns: [{
				id: 'turn-1',
				text: 'hello director',
				state: TurnState.Complete,
				responseText: 'provider backed hello',
			}],
		});
	});

	test('reports missing runtime credentials without leaking secrets', async () => {
		const server = disposables.add(await createJsonServer({ status: 200, body: { choices: [{ message: { content: 'unused' } }] } }));
		const agent = createAgent(createOpenAIFixtures(server.url), { kind: 'missing', message: 'credential bridge missing' });
		const created = await agent.createSession();
		const signals: AgentSignal[] = [];
		disposables.add(agent.onDidSessionProgress(signal => signals.push(signal)));

		await agent.sendMessage(created.session, 'hello director', undefined, 'turn-missing');
		const turns = await agent.getSessionMessages(created.session);

		assert.deepStrictEqual({
			signals: summarizeSignals(signals),
			turns: turns.map(turn => ({ id: turn.id, state: turn.state })),
		}, {
			signals: [
				{ type: ActionType.SessionError, turnId: 'turn-missing', message: 'credential bridge missing' },
			],
			turns: [{ id: 'turn-missing', state: TurnState.Error }],
		});
	});

	test('aborts in-flight provider turn without completing the turn', async () => {
		const server = disposables.add(await createJsonServer({ status: 200, body: { choices: [{ message: { content: 'late' } }] }, delayMs: 10_000 }));
		const agent = createAgent(createOpenAIFixtures(server.url), { kind: 'api-key', value: 'sk-test' });
		const created = await agent.createSession();
		const signals: AgentSignal[] = [];
		disposables.add(agent.onDidSessionProgress(signal => signals.push(signal)));
		const firstSignal = Event.toPromise(agent.onDidSessionProgress, disposables);

		const send = agent.sendMessage(created.session, 'stop now', undefined, 'turn-abort');
		await firstSignal;
		await agent.abortSession(created.session);
		await send;

		const turns = await agent.getSessionMessages(created.session);
		assert.deepStrictEqual({
			signals: summarizeSignals(signals),
			turns: turns.map(turn => ({
				id: turn.id,
				state: turn.state,
				responseText: turn.responseParts
					.filter(part => part.kind === ResponsePartKind.Markdown)
					.map(part => part.content)
					.join(''),
			})),
		}, {
			signals: [
				{ type: ActionType.SessionResponsePart, turnId: 'turn-abort', kind: ResponsePartKind.SystemNotification, content: 'Director AgentEngine using provider \'test-provider\' with model \'gpt-test\'.' },
				{ type: ActionType.SessionTurnCancelled, turnId: 'turn-abort' },
			],
			turns: [{
				id: 'turn-abort',
				state: TurnState.Cancelled,
				responseText: '',
			}],
		});
	});
});

class TestDirectorRuntimeCredentialService implements IDirectorRuntimeCredentialService {
	declare readonly _serviceBrand: undefined;

	constructor(private readonly credential: DirectorRuntimeCredential) { }

	resolveCredential(_request: DirectorRuntimeCredentialRequest): Promise<DirectorRuntimeCredential> {
		return Promise.resolve(this.credential);
	}
}

function createOpenAIFixtures(baseURL: string): DirectorProviderBackendHubFixtures {
	return {
		defaultProviderId: 'test-provider',
		defaultModelId: 'test-provider:gpt-test',
		providerInstances: [{
			id: 'test-provider',
			kind: 'openai-compatible',
			displayName: 'Test Provider',
			enabled: true,
			authKind: 'api-key',
			apiType: 'openai-completions',
			baseURL,
			defaultModelId: 'test-provider:gpt-test',
			authState: { kind: 'ready' },
		}],
		models: [{
			providerInstanceId: 'test-provider',
			id: 'test-provider:gpt-test',
			providerModelId: 'gpt-test',
			name: 'GPT Test',
			supportsVision: false,
		}],
	};
}

interface TestJsonServer extends Server {
	readonly url: string;
	dispose(): void;
}

async function createJsonServer(options: { readonly status: number; readonly body: unknown; readonly delayMs?: number }): Promise<TestJsonServer> {
	const { createServer } = await import('http');
	const server = createServer((req, res) => {
		if (req.method !== 'POST' || req.url !== '/chat/completions') {
			res.writeHead(404);
			res.end();
			return;
		}
		setTimeout(() => {
			res.writeHead(options.status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(options.body));
		}, options.delayMs ?? 0);
	}) as TestJsonServer;
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === 'string') {
		throw new Error('Test server did not bind to a TCP port.');
	}
	Object.defineProperty(server, 'url', { value: `http://127.0.0.1:${address.port}` });
	server.dispose = () => server.close();
	return server;
}
