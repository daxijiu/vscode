/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { hasKey } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ServiceCollection } from '../../../instantiation/common/serviceCollection.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { ILogService, NullLogService } from '../../../log/common/log.js';
import { IDirectorProviderBackendHub } from '../../common/directorProviderBackend.js';
import { AgentSession, AgentSignal } from '../../common/agentService.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { ResponsePartKind, TurnState } from '../../common/state/sessionState.js';
import { DirectorAgent } from '../../node/director/directorAgent.js';
import { DirectorProviderBackendHub } from '../../node/director/directorProviderBackendHub.js';

suite('DirectorAgent', () => {

	const disposables = new DisposableStore();

	teardown(() => disposables.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	function createAgent(): DirectorAgent {
		const services = new ServiceCollection(
			[ILogService, new NullLogService()],
			[IDirectorProviderBackendHub, new DirectorProviderBackendHub()],
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
					content: action.part.kind === ResponsePartKind.Markdown ? action.part.content : undefined,
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

	test('streams deterministic markdown response and records in-memory turns', async () => {
		const agent = createAgent();
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
				{ type: ActionType.SessionResponsePart, turnId: 'turn-1', content: 'Director echo:' },
				{ type: ActionType.SessionResponsePart, turnId: 'turn-1', content: ' hello director' },
				{ type: ActionType.SessionTurnComplete, turnId: 'turn-1' },
			],
			turns: [{
				id: 'turn-1',
				text: 'hello director',
				state: TurnState.Complete,
				responseText: 'Director echo: hello director',
			}],
		});
	});

	test('aborts in-flight fake stream without completing the turn', async () => {
		const agent = createAgent();
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
				{ type: ActionType.SessionResponsePart, turnId: 'turn-abort', content: 'Director echo:' },
				{ type: ActionType.SessionTurnCancelled, turnId: 'turn-abort' },
			],
			turns: [{
				id: 'turn-abort',
				state: TurnState.Cancelled,
				responseText: 'Director echo:',
			}],
		});
	});
});
