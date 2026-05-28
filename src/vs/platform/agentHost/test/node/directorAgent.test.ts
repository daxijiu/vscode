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
import { ISchema, SchemaDefinition, SchemaValue } from '../../common/agentHostSchema.js';
import { DirectorDirectLanguageModelMessagesAttachmentMetaKey } from '../../common/directorProviderAdapters.js';
import { IDirectorProviderBackendHub } from '../../common/directorProviderBackend.js';
import { DirectorRuntimeCredential, DirectorRuntimeCredentialRequest, IDirectorRuntimeCredentialService } from '../../common/directorRuntimeCredentials.js';
import { AgentSession, AgentSignal } from '../../common/agentService.js';
import { SessionConfigKey } from '../../common/sessionConfigKeys.js';
import { ActionType } from '../../common/state/sessionActions.js';
import type { ToolDefinition } from '../../common/state/protocol/state.js';
import { MessageAttachmentKind, ResponsePartKind, ToolCallStatus, ToolResultContentType, TurnState } from '../../common/state/sessionState.js';
import { IAgentConfigurationService } from '../../node/agentConfigurationService.js';
import { DirectorAgent } from '../../node/director/directorAgent.js';
import { DirectorProviderBackendHub, DirectorProviderBackendHubFixtures } from '../../node/director/directorProviderBackendHub.js';

suite('DirectorAgent', () => {

	const disposables = new DisposableStore();

	teardown(() => disposables.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	function createAgent(fixtures: DirectorProviderBackendHubFixtures = {}, credential: DirectorRuntimeCredential = { kind: 'none' }, mode: 'interactive' | 'plan' = 'interactive'): DirectorAgent {
		const services = new ServiceCollection(
			[ILogService, new NullLogService()],
			[IDirectorProviderBackendHub, new DirectorProviderBackendHub(fixtures)],
			[IDirectorRuntimeCredentialService, new TestDirectorRuntimeCredentialService(credential)],
			[IAgentConfigurationService, new TestAgentConfigurationService(mode)],
		);
		const instantiationService = disposables.add(new InstantiationService(services));
		return disposables.add(instantiationService.createInstance(DirectorAgent));
	}

	function summarizeSignals(signals: readonly AgentSignal[]): readonly object[] {
		return signals.map(signal => {
			if (signal.kind === 'pending_confirmation') {
				return {
					kind: signal.kind,
					toolCallId: signal.state.toolCallId,
					toolName: signal.state.toolName,
				};
			}
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
					...(action.part.kind === ResponsePartKind.ToolCall ? { toolCallId: action.part.toolCall.toolCallId } : {}),
				};
			}
			if (action.type === ActionType.SessionDelta || action.type === ActionType.SessionReasoning) {
				return {
					type: action.type,
					turnId: action.turnId,
					content: action.content,
				};
			}
			if (action.type === ActionType.SessionToolCallStart) {
				return {
					type: action.type,
					turnId: action.turnId,
					toolCallId: action.toolCallId,
					toolName: action.toolName,
				};
			}
			if (action.type === ActionType.SessionToolCallDelta) {
				return {
					type: action.type,
					turnId: action.turnId,
					toolCallId: action.toolCallId,
					content: action.content,
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
				...(model.policyState !== undefined ? { policyState: model.policyState } : {}),
				...(typeof model._meta?.statusMessage === 'string' ? { statusMessage: model._meta.statusMessage } : {}),
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
				{
					provider: 'director',
					id: 'needs-key',
					name: 'Director Needs Key',
					providerInstanceId: 'director-missing-key',
					policyState: 'unconfigured',
					statusMessage: 'Director provider \'director-missing-key\' requires api-key credentials.',
				},
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

	test('acknowledges steering messages so unsupported injections do not stay pending', async () => {
		const agent = createAgent();
		const created = await agent.createSession();
		const signals: AgentSignal[] = [];
		disposables.add(agent.onDidSessionProgress(signal => signals.push(signal)));

		agent.setPendingMessages(created.session, { id: 'steer-1', userMessage: { text: 'terminal completed' } }, []);
		agent.setPendingMessages(created.session, { id: 'steer-1', userMessage: { text: 'terminal completed' } }, []);

		assert.deepStrictEqual(signals, [{
			kind: 'steering_consumed',
			session: created.session,
			id: 'steer-1',
		}]);
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

	test('preserves direct language model message structure through the AgentHost bridge', async () => {
		const requests: unknown[] = [];
		const server = disposables.add(await createSequenceJsonServer([{
			body: {
				choices: [{ message: { content: 'direct bridge hello' } }],
			},
		}], requests));
		const agent = createAgent(createOpenAIFixtures(server.url), { kind: 'api-key', value: 'sk-test' });
		const created = await agent.createSession();

		await agent.sendMessage(created.session, 'ignored prompt', [{
			type: MessageAttachmentKind.Simple,
			label: 'Director direct language model messages',
			modelRepresentation: JSON.stringify([
				{ role: 'system', content: 'direct system' },
				{ role: 'user', content: 'direct user' },
				{
					role: 'assistant',
					content: 'direct assistant',
					toolCalls: [{ id: 'call-1', name: 'readFile', input: '{"path":"src/a.ts"}' }],
				},
				{ role: 'tool', content: 'file content', toolCallId: 'call-1', isError: false },
			]),
			_meta: { [DirectorDirectLanguageModelMessagesAttachmentMetaKey]: true },
		}], 'turn-direct-lm');

		const request = requests[0] as { readonly messages: readonly Record<string, unknown>[] };
		assert.deepStrictEqual(request.messages, [
			{ role: 'system', content: 'direct system' },
			{ role: 'user', content: 'direct user' },
			{
				role: 'assistant',
				content: 'direct assistant',
				tool_calls: [{
					id: 'call-1',
					type: 'function',
					function: { name: 'readFile', arguments: '{"path":"src/a.ts"}' },
				}],
			},
			{ role: 'tool', tool_call_id: 'call-1', content: 'file content' },
		]);
	});

	test('streams OpenAI-compatible deltas into a stable markdown part', async () => {
		const server = disposables.add(await createSseServer([
			'data: {"choices":[{"delta":{"content":"stream "}}]}\n\n',
			'data: {"choices":[{"delta":{"content":"hello"}}],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n',
			'data: [DONE]\n\n',
		]));
		const agent = createAgent(createOpenAIFixtures(server.url, { streaming: true }), { kind: 'api-key', value: 'sk-test' });
		const created = await agent.createSession();
		const signals: AgentSignal[] = [];
		disposables.add(agent.onDidSessionProgress(signal => signals.push(signal)));

		await agent.sendMessage(created.session, 'stream please', undefined, 'turn-stream');
		const turns = await agent.getSessionMessages(created.session);

		const markdownPartIndex = signals.findIndex(signal => signal.kind === 'action' && signal.action.type === ActionType.SessionResponsePart && signal.action.part.kind === ResponsePartKind.Markdown);
		const deltaIndex = signals.findIndex(signal => signal.kind === 'action' && signal.action.type === ActionType.SessionDelta);
		assert.ok(markdownPartIndex >= 0);
		assert.ok(deltaIndex > markdownPartIndex);
		assert.deepStrictEqual({
			signals: summarizeSignals(signals),
			turns: turns.map(turn => ({
				id: turn.id,
				state: turn.state,
				responseText: turn.responseParts
					.filter(part => part.kind === ResponsePartKind.Markdown)
					.map(part => part.content)
					.join(''),
				usage: turn.usage,
			})),
		}, {
			signals: [
				{ type: ActionType.SessionResponsePart, turnId: 'turn-stream', kind: ResponsePartKind.SystemNotification, content: 'Director AgentEngine using provider \'test-provider\' with model \'gpt-test\'.' },
				{ type: ActionType.SessionResponsePart, turnId: 'turn-stream', kind: ResponsePartKind.Markdown, content: '' },
				{ type: ActionType.SessionDelta, turnId: 'turn-stream', content: 'stream ' },
				{ type: ActionType.SessionDelta, turnId: 'turn-stream', content: 'hello' },
				{ type: ActionType.SessionUsage, turnId: 'turn-stream', usage: { inputTokens: 7, outputTokens: 2 } },
				{ type: ActionType.SessionTurnComplete, turnId: 'turn-stream' },
			],
			turns: [{
				id: 'turn-stream',
				state: TurnState.Complete,
				responseText: 'stream hello',
				usage: { inputTokens: 7, outputTokens: 2 },
			}],
		});
	});

	test('streams Anthropic Messages deltas through the same markdown path', async () => {
		const server = disposables.add(await createSseServer([
			'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"anthropic "}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"stream"}}\n\n',
			'event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":5,"output_tokens":2}}\n\n',
		], '/v1/messages'));
		const agent = createAgent(createAnthropicFixtures(server.url, { streaming: true }), { kind: 'api-key', value: 'sk-test' });
		const created = await agent.createSession();
		const signals: AgentSignal[] = [];
		disposables.add(agent.onDidSessionProgress(signal => signals.push(signal)));

		await agent.sendMessage(created.session, 'stream please', undefined, 'turn-anthropic-stream');
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
				usage: turn.usage,
			})),
		}, {
			signals: [
				{ type: ActionType.SessionResponsePart, turnId: 'turn-anthropic-stream', kind: ResponsePartKind.SystemNotification, content: 'Director AgentEngine using provider \'anthropic-provider\' with model \'claude-test\'.' },
				{ type: ActionType.SessionResponsePart, turnId: 'turn-anthropic-stream', kind: ResponsePartKind.Markdown, content: '' },
				{ type: ActionType.SessionDelta, turnId: 'turn-anthropic-stream', content: 'anthropic ' },
				{ type: ActionType.SessionDelta, turnId: 'turn-anthropic-stream', content: 'stream' },
				{ type: ActionType.SessionUsage, turnId: 'turn-anthropic-stream', usage: { inputTokens: 5, outputTokens: 2 } },
				{ type: ActionType.SessionTurnComplete, turnId: 'turn-anthropic-stream' },
			],
			turns: [{
				id: 'turn-anthropic-stream',
				state: TurnState.Complete,
				responseText: 'anthropic stream',
				usage: { inputTokens: 5, outputTokens: 2 },
			}],
		});
	});

	test('gates Plan Mode with a clear AgentHost-visible message', async () => {
		const agent = createAgent({}, { kind: 'none' }, 'plan');
		const created = await agent.createSession();
		const signals: AgentSignal[] = [];
		disposables.add(agent.onDidSessionProgress(signal => signals.push(signal)));

		await agent.sendMessage(created.session, 'make a plan', undefined, 'turn-plan');
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
				{ type: ActionType.SessionResponsePart, turnId: 'turn-plan', kind: ResponsePartKind.SystemNotification, content: 'Director Plan Mode is not implemented in the AgentHost harness yet.' },
				{ type: ActionType.SessionResponsePart, turnId: 'turn-plan', kind: ResponsePartKind.Markdown, content: 'Director Plan Mode is recognized, but this Phase 4 AgentHost harness still gates it off. Switch the session mode back to Interactive to run provider-backed turns.' },
				{ type: ActionType.SessionTurnComplete, turnId: 'turn-plan' },
			],
			turns: [{
				id: 'turn-plan',
				state: TurnState.Complete,
				responseText: 'Director Plan Mode is recognized, but this Phase 4 AgentHost harness still gates it off. Switch the session mode back to Interactive to run provider-backed turns.',
			}],
		});
	});

	test('feeds approved client tool results back into the provider loop', async () => {
		const requests: unknown[] = [];
		const server = disposables.add(await createSequenceJsonServer([
			{ choices: [{ message: { content: '', reasoning_content: 'need tool context', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'runTests', arguments: '{"query":"abc"}' } }] } }] },
			{ choices: [{ message: { content: 'tool result observed' } }] },
		], requests));
		const agent = createAgent(createOpenAIFixtures(server.url, { toolCalling: true }), { kind: 'api-key', value: 'sk-test' });
		const created = await agent.createSession();
		agent.setClientTools(created.session, 'client-1', [{
			name: 'runTests',
			title: 'Run Tests',
			description: 'Returns a deterministic result',
			inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
		}]);
		const signals: AgentSignal[] = [];
		disposables.add(agent.onDidSessionProgress(signal => {
			signals.push(signal);
			if (signal.kind === 'pending_confirmation') {
				agent.respondToPermissionRequest(signal.state.toolCallId, true);
				agent.onClientToolCallComplete(created.session, signal.state.toolCallId, {
					success: true,
					pastTenseMessage: 'Ran Run Tests',
					content: [{ type: ToolResultContentType.Text, text: 'tool says abc' }],
				});
			}
		}));

		await agent.sendMessage(created.session, 'use a tool', undefined, 'turn-tool');
		const turns = await agent.getSessionMessages(created.session);
		const secondBody = requests[1] as { messages: Array<{ role: string; content?: string | null; reasoning_content?: string }> };

		assert.deepStrictEqual({
			requestCount: requests.length,
			secondRequestMessages: secondBody.messages.map(message => ({ role: message.role, content: message.content, reasoningContent: message.reasoning_content })),
			systemPromptHasToolList: secondBody.messages[0]?.role === 'system' && secondBody.messages[0]?.content?.includes('## Available Tools') && secondBody.messages[0]?.content?.includes('**runTests**'),
			signals: summarizeSignals(signals),
			turns: turns.map(turn => ({
				id: turn.id,
				state: turn.state,
				toolStatus: turn.responseParts.find(part => part.kind === ResponsePartKind.ToolCall)?.toolCall.status,
				responseText: turn.responseParts
					.filter(part => part.kind === ResponsePartKind.Markdown)
					.map(part => part.content)
					.join(''),
			})),
		}, {
			requestCount: 2,
			secondRequestMessages: [
				{ role: 'system', content: secondBody.messages[0]?.content, reasoningContent: undefined },
				{ role: 'user', content: 'use a tool', reasoningContent: undefined },
				{ role: 'assistant', content: null, reasoningContent: undefined },
				{ role: 'tool', content: 'tool says abc', reasoningContent: undefined },
			],
			systemPromptHasToolList: true,
			signals: [
				{ type: ActionType.SessionResponsePart, turnId: 'turn-tool', kind: ResponsePartKind.SystemNotification, content: 'Director AgentEngine using provider \'test-provider\' with model \'gpt-test\'.' },
				{ type: ActionType.SessionResponsePart, turnId: 'turn-tool', kind: ResponsePartKind.Reasoning, content: undefined },
				{ type: ActionType.SessionToolCallStart, turnId: 'turn-tool', toolCallId: 'call-1', toolName: 'runTests' },
				{ type: ActionType.SessionToolCallDelta, turnId: 'turn-tool', toolCallId: 'call-1', content: '{"query":"abc"}' },
				{ kind: 'pending_confirmation', toolCallId: 'call-1', toolName: 'runTests' },
				{ type: ActionType.SessionResponsePart, turnId: 'turn-tool', kind: ResponsePartKind.Markdown, content: 'tool result observed' },
				{ type: ActionType.SessionTurnComplete, turnId: 'turn-tool' },
			],
			turns: [{
				id: 'turn-tool',
				state: TurnState.Complete,
				toolStatus: ToolCallStatus.Completed,
				responseText: 'tool result observed',
			}],
		});
	});

	test('seeds client tools from createSession activeClient', async () => {
		const requests: unknown[] = [];
		const server = disposables.add(await createSequenceJsonServer([
			{ choices: [{ message: { content: '', tool_calls: [{ id: 'call-active-client', type: 'function', function: { name: 'runTests', arguments: '{"query":"active"}' } }] } }] },
			{ choices: [{ message: { content: 'active client result observed' } }] },
		], requests));
		const agent = createAgent(createOpenAIFixtures(server.url, { toolCalling: true }), { kind: 'api-key', value: 'sk-test' });
		const created = await agent.createSession({
			activeClient: {
				clientId: 'client-active',
				tools: [{
					name: 'runTests',
					title: 'Run Tests',
					description: 'Returns a deterministic result',
					inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
				}],
			},
		});
		const pendingToolClientIds: (string | undefined)[] = [];
		disposables.add(agent.onDidSessionProgress(signal => {
			if (signal.kind === 'pending_confirmation') {
				pendingToolClientIds.push(signal.state.toolClientId);
				agent.respondToPermissionRequest(signal.state.toolCallId, true);
				agent.onClientToolCallComplete(created.session, signal.state.toolCallId, {
					success: true,
					pastTenseMessage: 'Ran Run Tests',
					content: [{ type: ToolResultContentType.Text, text: 'active client tool result' }],
				});
			}
		}));

		await agent.sendMessage(created.session, 'use active client tool', undefined, 'turn-active-client');
		const firstBody = requests[0] as { tools: Array<{ function: { name: string } }> };
		const turns = await agent.getSessionMessages(created.session);

		assert.deepStrictEqual({
			toolNames: firstBody.tools.map(tool => tool.function.name),
			pendingToolClientIds,
			turns: turns.map(turn => ({
				id: turn.id,
				state: turn.state,
				toolClientId: turn.responseParts.find(part => part.kind === ResponsePartKind.ToolCall)?.toolCall.toolClientId,
				responseText: turn.responseParts
					.filter(part => part.kind === ResponsePartKind.Markdown)
					.map(part => part.content)
					.join(''),
			})),
		}, {
			toolNames: ['runTests'],
			pendingToolClientIds: ['client-active'],
			turns: [{
				id: 'turn-active-client',
				state: TurnState.Complete,
				toolClientId: 'client-active',
				responseText: 'active client result observed',
			}],
		});
	});

	test('executes delayed tool calls on the original per-turn client when another surface becomes active', async () => {
		const requests: unknown[] = [];
		const server = disposables.add(await createSequenceJsonServer([
			{ delayMs: 25, body: { choices: [{ message: { content: '', tool_calls: [{ id: 'call-reclaimed-client', type: 'function', function: { name: 'runTests', arguments: '{"query":"reclaimed"}' } }] } }] } },
			{ choices: [{ message: { content: 'reclaimed client result observed' } }] },
		], requests));
		const agent = createAgent(createOpenAIFixtures(server.url, { toolCalling: true }), { kind: 'api-key', value: 'sk-test' });
		const created = await agent.createSession();
		const tool: ToolDefinition = {
			name: 'runTests',
			title: 'Run Tests',
			description: 'Returns a deterministic result',
			inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
		};
		agent.setClientTools(created.session, 'client-editor', [tool]);
		const pendingToolClientIds: (string | undefined)[] = [];
		disposables.add(agent.onDidSessionProgress(signal => {
			if (signal.kind === 'pending_confirmation') {
				pendingToolClientIds.push(signal.state.toolClientId);
				agent.respondToPermissionRequest(signal.state.toolCallId, true);
				agent.onClientToolCallComplete(created.session, signal.state.toolCallId, {
					success: true,
					pastTenseMessage: 'Ran Run Tests',
					content: [{ type: ToolResultContentType.Text, text: 'reclaimed client tool result' }],
				});
			}
		}));

		const send = agent.sendMessage(created.session, 'use tool after reclaim', undefined, 'turn-reclaimed-client');
		await waitForRequestCount(requests, 1);
		agent.setClientTools(created.session, 'client-agent-window', [tool]);
		await send;
		const turns = await agent.getSessionMessages(created.session);

		assert.deepStrictEqual({
			pendingToolClientIds,
			turns: turns.map(turn => ({
				id: turn.id,
				state: turn.state,
				toolClientId: turn.responseParts.find(part => part.kind === ResponsePartKind.ToolCall)?.toolCall.toolClientId,
				responseText: turn.responseParts
					.filter(part => part.kind === ResponsePartKind.Markdown)
					.map(part => part.content)
					.join(''),
			})),
		}, {
			pendingToolClientIds: ['client-editor'],
			turns: [{
				id: 'turn-reclaimed-client',
				state: TurnState.Complete,
				toolClientId: 'client-editor',
				responseText: 'reclaimed client result observed',
			}],
		});
	});

	test('echoes empty reasoning_content for DeepSeek V4 tool-call follow-up requests', async () => {
		const requests: unknown[] = [];
		const server = disposables.add(await createSequenceJsonServer([
			{ choices: [{ message: { content: '', tool_calls: [{ id: 'call-deepseek-v4', type: 'function', function: { name: 'runTests', arguments: '{"query":"v4"}' } }] } }] },
			{ choices: [{ message: { content: 'deepseek v4 observed tool result' } }] },
		], requests));
		const agent = createAgent(createOpenAIFixtures(server.url, { toolCalling: true }, 'deepseek-v4-flash'), { kind: 'api-key', value: 'sk-test' });
		const created = await agent.createSession();
		agent.setClientTools(created.session, 'client-1', [{
			name: 'runTests',
			title: 'Run Tests',
			description: 'Returns a deterministic result',
			inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
		}]);
		disposables.add(agent.onDidSessionProgress(signal => {
			if (signal.kind === 'pending_confirmation') {
				agent.respondToPermissionRequest(signal.state.toolCallId, true);
				agent.onClientToolCallComplete(created.session, signal.state.toolCallId, {
					success: true,
					pastTenseMessage: 'Ran Run Tests',
					content: [{ type: ToolResultContentType.Text, text: 'tool says v4' }],
				});
			}
		}));

		await agent.sendMessage(created.session, 'use a deepseek v4 tool', undefined, 'turn-deepseek-v4');
		const secondBody = requests[1] as { messages: Array<{ role: string; reasoning_content?: string }> };
		const assistantMessage = secondBody.messages.find(message => message.role === 'assistant');

		assert.deepStrictEqual({
			requestCount: requests.length,
			reasoningContent: assistantMessage?.reasoning_content,
		}, {
			requestCount: 2,
			reasoningContent: '',
		});
	});

	test('retries once with reasoning_content when OpenAI-compatible provider requires it', async () => {
		const requests: unknown[] = [];
		const server = disposables.add(await createSequenceJsonServer([
			{ choices: [{ message: { content: '', tool_calls: [{ id: 'call-reasoning-fallback', type: 'function', function: { name: 'runTests', arguments: '{"query":"fallback"}' } }] } }] },
			{ status: 400, body: { error: { message: 'The reasoning_content in the thinking mode must be passed back to the API.' } } },
			{ choices: [{ message: { content: 'fallback observed tool result' } }] },
		], requests));
		const agent = createAgent(createOpenAIFixtures(server.url, { toolCalling: true }, 'custom-deepseek-v4'), { kind: 'api-key', value: 'sk-test' });
		const created = await agent.createSession();
		agent.setClientTools(created.session, 'client-1', [{
			name: 'runTests',
			title: 'Run Tests',
			description: 'Returns a deterministic result',
			inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
		}]);
		disposables.add(agent.onDidSessionProgress(signal => {
			if (signal.kind === 'pending_confirmation') {
				agent.respondToPermissionRequest(signal.state.toolCallId, true);
				agent.onClientToolCallComplete(created.session, signal.state.toolCallId, {
					success: true,
					pastTenseMessage: 'Ran Run Tests',
					content: [{ type: ToolResultContentType.Text, text: 'tool says fallback' }],
				});
			}
		}));

		await agent.sendMessage(created.session, 'use fallback tool', undefined, 'turn-reasoning-fallback');
		const secondBody = requests[1] as { messages: Array<{ role: string; reasoning_content?: string }> };
		const thirdBody = requests[2] as { messages: Array<{ role: string; reasoning_content?: string }> };
		const secondAssistant = secondBody.messages.find(message => message.role === 'assistant');
		const thirdAssistant = thirdBody.messages.find(message => message.role === 'assistant');

		assert.deepStrictEqual({
			requestCount: requests.length,
			beforeFallback: secondAssistant?.reasoning_content,
			afterFallback: thirdAssistant?.reasoning_content,
		}, {
			requestCount: 3,
			beforeFallback: undefined,
			afterFallback: '',
		});
	});

	test('feeds denied client tool calls back as model-visible tool errors', async () => {
		const requests: unknown[] = [];
		const server = disposables.add(await createSequenceJsonServer([
			{ choices: [{ message: { content: '', tool_calls: [{ id: 'call-denied', type: 'function', function: { name: 'runTests', arguments: '{"query":"deny"}' } }] } }] },
			{ choices: [{ message: { content: 'denial observed' } }] },
		], requests));
		const agent = createAgent(createOpenAIFixtures(server.url, { toolCalling: true }), { kind: 'api-key', value: 'sk-test' });
		const created = await agent.createSession();
		agent.setClientTools(created.session, 'client-1', [{
			name: 'runTests',
			title: 'Run Tests',
			description: 'Returns a deterministic result',
			inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
		}]);
		const signals: AgentSignal[] = [];
		disposables.add(agent.onDidSessionProgress(signal => {
			signals.push(signal);
			if (signal.kind === 'pending_confirmation') {
				agent.respondToPermissionRequest(signal.state.toolCallId, false);
			}
		}));

		await agent.sendMessage(created.session, 'try a denied tool', undefined, 'turn-tool-denied');
		const turns = await agent.getSessionMessages(created.session);
		const secondBody = requests[1] as { messages: Array<{ role: string; content?: string; tool_call_id?: string }> };
		const toolMessage = secondBody.messages.find(message => message.role === 'tool');

		assert.deepStrictEqual({
			requestCount: requests.length,
			toolMessage,
			pendingConfirmations: signals.filter(signal => signal.kind === 'pending_confirmation').length,
			turns: turns.map(turn => ({
				id: turn.id,
				state: turn.state,
				toolStatus: turn.responseParts.find(part => part.kind === ResponsePartKind.ToolCall)?.toolCall.status,
				responseText: turn.responseParts
					.filter(part => part.kind === ResponsePartKind.Markdown)
					.map(part => part.content)
					.join(''),
			})),
		}, {
			requestCount: 2,
			toolMessage: {
				role: 'tool',
				tool_call_id: 'call-denied',
				content: 'Director tool \'runTests\' was denied by the user.\nDirector tool \'runTests\' was denied by the user.',
			},
			pendingConfirmations: 1,
			turns: [{
				id: 'turn-tool-denied',
				state: TurnState.Complete,
				toolStatus: ToolCallStatus.Cancelled,
				responseText: 'denial observed',
			}],
		});
	});

	test('filters client tools through the Director tool policy before advertising them', async () => {
		const requests: unknown[] = [];
		const server = disposables.add(await createSequenceJsonServer([
			{ choices: [{ message: { content: 'tool policy observed' } }] },
		], requests));
		const agent = createAgent(createOpenAIFixtures(server.url, { toolCalling: true }), { kind: 'api-key', value: 'sk-test' });
		const created = await agent.createSession();
		agent.setClientTools(created.session, 'client-1', [{
			name: 'unreviewed_tool',
			title: 'Unreviewed Tool',
			description: 'Should not be visible to Director',
			inputSchema: { type: 'object', properties: {} },
		}, {
			name: 'openBrowserPage',
			title: 'Open Browser Page',
			description: 'Open a new browser page in the integrated browser at the given URL.',
			inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
		}, {
			name: 'runTests',
			title: 'Run Tests',
			description: 'Run tests',
			inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
		}]);

		await agent.sendMessage(created.session, 'list tools', undefined, 'turn-tool-policy');
		const body = requests[0] as { tools: Array<{ function: { name: string; description: string; parameters: { properties?: Record<string, { description?: string }> } } }> };

		assert.deepStrictEqual({
			toolNames: body.tools.map(tool => tool.function.name),
			openBrowserGuidance: body.tools.find(tool => tool.function.name === 'openBrowserPage')?.function.description.includes('never pass the workspace folder'),
			openBrowserUrlGuidance: body.tools.find(tool => tool.function.name === 'openBrowserPage')?.function.parameters.properties?.url?.description?.includes('Do not pass VS Code workspace folders'),
		}, {
			toolNames: ['openBrowserPage', 'runTests'],
			openBrowserGuidance: true,
			openBrowserUrlGuidance: true,
		});
	});

	test('rejects raw local paths before running openBrowserPage client tools', async () => {
		const requests: unknown[] = [];
		const localPath = 'E:\\Projects\\Director-Code-batch\\vscode';
		const server = disposables.add(await createSequenceJsonServer([
			{ choices: [{ message: { content: '', tool_calls: [{ id: 'call-open-browser', type: 'function', function: { name: 'openBrowserPage', arguments: JSON.stringify({ url: localPath }) } }] } }] },
			{ choices: [{ message: { content: 'Please provide a webpage URL.' } }] },
		], requests));
		const agent = createAgent(createOpenAIFixtures(server.url, { toolCalling: true }), { kind: 'api-key', value: 'sk-test' });
		const created = await agent.createSession();
		agent.setClientTools(created.session, 'client-1', [{
			name: 'openBrowserPage',
			title: 'Open Browser Page',
			description: 'Open a new browser page in the integrated browser at the given URL.',
			inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
		}]);
		const signals: AgentSignal[] = [];
		disposables.add(agent.onDidSessionProgress(signal => {
			signals.push(signal);
			if (signal.kind === 'pending_confirmation') {
				agent.respondToPermissionRequest(signal.state.toolCallId, false);
			}
		}));

		await agent.sendMessage(created.session, 'open the docs webpage', undefined, 'turn-open-browser');
		const turns = await agent.getSessionMessages(created.session);
		const secondBody = requests[1] as { messages: Array<{ role: string; content?: string }> };
		const toolMessage = secondBody.messages.find(message => message.role === 'tool');

		assert.deepStrictEqual({
			requestCount: requests.length,
			pendingConfirmations: signals.filter(signal => signal.kind === 'pending_confirmation').length,
			toolMessageIncludesValidationError: toolMessage?.content?.includes('Do not pass a raw local filesystem path or workspace directory'),
			turns: turns.map(turn => ({
				id: turn.id,
				state: turn.state,
				toolStatus: turn.responseParts.find(part => part.kind === ResponsePartKind.ToolCall)?.toolCall.status,
				responseText: turn.responseParts
					.filter(part => part.kind === ResponsePartKind.Markdown)
					.map(part => part.content)
					.join(''),
			})),
		}, {
			requestCount: 2,
			pendingConfirmations: 0,
			toolMessageIncludesValidationError: true,
			turns: [{
				id: 'turn-open-browser',
				state: TurnState.Complete,
				toolStatus: ToolCallStatus.Completed,
				responseText: 'Please provide a webpage URL.',
			}],
		});
	});

	test('rejects file URIs before running openBrowserPage client tools', async () => {
		const requests: unknown[] = [];
		const fileUri = URI.file('E:/Projects/Director-Code-batch/vscode/README.md').toString();
		const server = disposables.add(await createSequenceJsonServer([
			{ choices: [{ message: { content: '', tool_calls: [{ id: 'call-open-file-uri', type: 'function', function: { name: 'openBrowserPage', arguments: JSON.stringify({ url: fileUri }) } }] } }] },
			{ choices: [{ message: { content: 'I will use workspace file tools instead.' } }] },
		], requests));
		const agent = createAgent(createOpenAIFixtures(server.url, { toolCalling: true }), { kind: 'api-key', value: 'sk-test' });
		const created = await agent.createSession();
		agent.setClientTools(created.session, 'client-1', [{
			name: 'openBrowserPage',
			title: 'Open Browser Page',
			description: 'Open a new browser page in the integrated browser at the given URL.',
			inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
		}]);
		const signals: AgentSignal[] = [];
		disposables.add(agent.onDidSessionProgress(signal => {
			signals.push(signal);
			if (signal.kind === 'pending_confirmation') {
				agent.respondToPermissionRequest(signal.state.toolCallId, false);
			}
		}));

		await agent.sendMessage(created.session, 'open the local file', undefined, 'turn-open-file-uri');
		const turns = await agent.getSessionMessages(created.session);
		const secondBody = requests[1] as { messages: Array<{ role: string; content?: string }> };
		const toolMessage = secondBody.messages.find(message => message.role === 'tool');

		assert.deepStrictEqual({
			requestCount: requests.length,
			pendingConfirmations: signals.filter(signal => signal.kind === 'pending_confirmation').length,
			toolMessageIncludesValidationError: toolMessage?.content?.includes('unsupported URL scheme \'file\''),
			turns: turns.map(turn => ({
				id: turn.id,
				state: turn.state,
				toolStatus: turn.responseParts.find(part => part.kind === ResponsePartKind.ToolCall)?.toolCall.status,
				responseText: turn.responseParts
					.filter(part => part.kind === ResponsePartKind.Markdown)
					.map(part => part.content)
					.join(''),
			})),
		}, {
			requestCount: 2,
			pendingConfirmations: 0,
			toolMessageIncludesValidationError: true,
			turns: [{
				id: 'turn-open-file-uri',
				state: TurnState.Complete,
				toolStatus: ToolCallStatus.Completed,
				responseText: 'I will use workspace file tools instead.',
			}],
		});
	});

	test('does not execute tool calls that were not advertised to the provider', async () => {
		const requests: unknown[] = [];
		const server = disposables.add(await createSequenceJsonServer([
			{ choices: [{ message: { content: '', tool_calls: [{ id: 'call-unadvertised', type: 'function', function: { name: 'runTests', arguments: '{"query":"oops"}' } }] } }] },
			{ choices: [{ message: { content: 'I cannot run that tool here.' } }] },
		], requests));
		const agent = createAgent(createOpenAIFixtures(server.url, { toolCalling: false }), { kind: 'api-key', value: 'sk-test' });
		const created = await agent.createSession();
		agent.setClientTools(created.session, 'client-1', [{
			name: 'runTests',
			title: 'Run Tests',
			description: 'Returns a deterministic result',
			inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
		}]);
		const signals: AgentSignal[] = [];
		disposables.add(agent.onDidSessionProgress(signal => signals.push(signal)));

		await agent.sendMessage(created.session, 'unadvertised tool', undefined, 'turn-unadvertised-tool');
		const turns = await agent.getSessionMessages(created.session);
		const secondBody = requests[1] as { messages: Array<{ role: string; content?: string }> };

		assert.deepStrictEqual({
			requestCount: requests.length,
			pendingConfirmations: signals.filter(signal => signal.kind === 'pending_confirmation').length,
			errorSignals: signals.filter(signal => signal.kind === 'action' && signal.action.type === ActionType.SessionError)
				.map(signal => signal.kind === 'action' && signal.action.type === ActionType.SessionError ? signal.action.error.message : undefined),
			toolMessageIncludesError: secondBody.messages.some(message => message.role === 'tool' && message.content?.includes('Tool not found: runTests')),
			turns: turns.map(turn => ({
				id: turn.id,
				state: turn.state,
				toolParts: turn.responseParts.filter(part => part.kind === ResponsePartKind.ToolCall).length,
				responseText: turn.responseParts.find(part => part.kind === ResponsePartKind.Markdown)?.content,
			})),
		}, {
			requestCount: 2,
			pendingConfirmations: 0,
			errorSignals: [],
			toolMessageIncludesError: true,
			turns: [{
				id: 'turn-unadvertised-tool',
				state: TurnState.Complete,
				toolParts: 0,
				responseText: 'I cannot run that tool here.',
			}],
		});
	});

	test('executes client tool calls against the per-turn tool snapshot', async () => {
		const requests: unknown[] = [];
		const server = disposables.add(await createSequenceJsonServer([
			{ choices: [{ message: { content: '', tool_calls: [{ id: 'call-snapshot', type: 'function', function: { name: 'runTests', arguments: '{"query":"snapshot"}' } }] } }] },
			{ choices: [{ message: { content: 'snapshot result observed' } }] },
		], requests));
		const agent = createAgent(createOpenAIFixtures(server.url, { toolCalling: true }), { kind: 'api-key', value: 'sk-test' });
		const created = await agent.createSession();
		agent.setClientTools(created.session, 'client-1', [{
			name: 'runTests',
			title: 'Run Tests',
			description: 'Returns a deterministic result',
			inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
		}]);
		const signals: AgentSignal[] = [];
		disposables.add(agent.onDidSessionProgress(signal => {
			signals.push(signal);
			if (signal.kind === 'pending_confirmation') {
				agent.setClientTools(created.session, 'client-2', [{
					name: 'different_tool',
					title: 'Different Tool',
					inputSchema: { type: 'object', properties: {} },
				}]);
				agent.respondToPermissionRequest(signal.state.toolCallId, true);
				agent.onClientToolCallComplete(created.session, signal.state.toolCallId, {
					success: true,
					pastTenseMessage: 'Ran Run Tests',
					content: [{ type: ToolResultContentType.Text, text: 'snapshot tool result' }],
				});
			}
		}));

		await agent.sendMessage(created.session, 'use original snapshot tool', undefined, 'turn-tool-snapshot');
		const turns = await agent.getSessionMessages(created.session);

		assert.deepStrictEqual({
			requestCount: requests.length,
			turns: turns.map(turn => ({
				id: turn.id,
				state: turn.state,
				toolStatus: turn.responseParts.find(part => part.kind === ResponsePartKind.ToolCall)?.toolCall.status,
				toolClientId: turn.responseParts.find(part => part.kind === ResponsePartKind.ToolCall)?.toolCall.toolClientId,
				responseText: turn.responseParts
					.filter(part => part.kind === ResponsePartKind.Markdown)
					.map(part => part.content)
					.join(''),
			})),
		}, {
			requestCount: 2,
			turns: [{
				id: 'turn-tool-snapshot',
				state: TurnState.Complete,
				toolStatus: ToolCallStatus.Completed,
				toolClientId: 'client-1',
				responseText: 'snapshot result observed',
			}],
		});
	});

	test('fails in-flight client tools when the owning client disconnects', async () => {
		const requests: unknown[] = [];
		const server = disposables.add(await createSequenceJsonServer([
			{ choices: [{ message: { content: '', tool_calls: [{ id: 'call-disconnect', type: 'function', function: { name: 'runTests', arguments: '{"query":"disconnect"}' } }] } }] },
			{ choices: [{ message: { content: 'disconnect observed' } }] },
		], requests));
		const agent = createAgent(createOpenAIFixtures(server.url, { toolCalling: true }), { kind: 'api-key', value: 'sk-test' });
		const created = await agent.createSession();
		agent.setClientTools(created.session, 'client-1', [{
			name: 'runTests',
			title: 'Run Tests',
			description: 'Returns a deterministic result',
			inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
		}]);
		const signals: AgentSignal[] = [];
		disposables.add(agent.onDidSessionProgress(signal => {
			signals.push(signal);
			if (signal.kind === 'pending_confirmation') {
				agent.respondToPermissionRequest(signal.state.toolCallId, true);
				agent.setClientTools(created.session, 'client-1', []);
			}
		}));

		await agent.sendMessage(created.session, 'disconnect tool', undefined, 'turn-tool-disconnect');
		const turns = await agent.getSessionMessages(created.session);
		const secondBody = requests[1] as { messages: Array<{ role: string; content?: string; tool_call_id?: string }> };
		const toolMessage = secondBody.messages.find(message => message.role === 'tool');

		assert.deepStrictEqual({
			requestCount: requests.length,
			toolMessage,
			turns: turns.map(turn => ({
				id: turn.id,
				state: turn.state,
				toolStatus: turn.responseParts.find(part => part.kind === ResponsePartKind.ToolCall)?.toolCall.status,
				responseText: turn.responseParts
					.filter(part => part.kind === ResponsePartKind.Markdown)
					.map(part => part.content)
					.join(''),
			})),
		}, {
			requestCount: 2,
			toolMessage: {
				role: 'tool',
				tool_call_id: 'call-disconnect',
				content: 'Client client-1 disconnected before completing a Director tool call.\nClient client-1 disconnected before completing a Director tool call.',
			},
			turns: [{
				id: 'turn-tool-disconnect',
				state: TurnState.Complete,
				toolStatus: ToolCallStatus.Completed,
				responseText: 'disconnect observed',
			}],
		});
	});

	test('does not retry provider requests after an AgentHost tool side effect', async () => {
		const requests: unknown[] = [];
		const server = disposables.add(await createSequenceJsonServer([
			{ choices: [{ message: { content: '', tool_calls: [{ id: 'call-side-effect', type: 'function', function: { name: 'runTests', arguments: '{"query":"side-effect"}' } }] } }] },
			{ status: 500, body: { error: 'transient failure with sk-test' } },
			{ choices: [{ message: { content: 'must not be reached' } }] },
		], requests));
		const agent = createAgent(createOpenAIFixtures(server.url, { toolCalling: true }), { kind: 'api-key', value: 'sk-test' });
		const created = await agent.createSession();
		agent.setClientTools(created.session, 'client-1', [{
			name: 'runTests',
			title: 'Run Tests',
			description: 'Returns a deterministic result',
			inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
		}]);
		const signals: AgentSignal[] = [];
		disposables.add(agent.onDidSessionProgress(signal => {
			signals.push(signal);
			if (signal.kind === 'pending_confirmation') {
				agent.respondToPermissionRequest(signal.state.toolCallId, true);
				agent.onClientToolCallComplete(created.session, signal.state.toolCallId, {
					success: true,
					pastTenseMessage: 'Ran Run Tests',
					content: [{ type: ToolResultContentType.Text, text: 'tool side effect completed' }],
				});
			}
		}));

		await agent.sendMessage(created.session, 'use a tool then fail', undefined, 'turn-tool-fail');
		const turns = await agent.getSessionMessages(created.session);

		assert.deepStrictEqual({
			requestCount: requests.length,
			errorSignals: signals.filter(signal => signal.kind === 'action' && signal.action.type === ActionType.SessionError)
				.map(signal => ({
					type: signal.kind === 'action' ? signal.action.type : undefined,
					turnId: signal.kind === 'action' && hasKey(signal.action, { turnId: true }) ? signal.action.turnId : undefined,
					message: signal.kind === 'action' && signal.action.type === ActionType.SessionError ? signal.action.error.message : undefined,
				})),
			turns: turns.map(turn => ({
				id: turn.id,
				state: turn.state,
				toolStatus: turn.responseParts.find(part => part.kind === ResponsePartKind.ToolCall)?.toolCall.status,
			})),
		}, {
			requestCount: 2,
			errorSignals: [{
				type: ActionType.SessionError,
				turnId: 'turn-tool-fail',
				message: 'Director provider \'test-provider\' returned 500 Internal Server Error: {"error":"transient failure with <redacted>"}',
			}],
			turns: [{
				id: 'turn-tool-fail',
				state: TurnState.Error,
				toolStatus: ToolCallStatus.Completed,
			}],
		});
	});

	test('allows more than four distinct tool iterations in a long tool task', async () => {
		const requests: unknown[] = [];
		const server = disposables.add(await createSequenceJsonServer([
			...Array.from({ length: 5 }, (_, index) => ({
				choices: [{ message: { content: '', tool_calls: [{ id: `call-long-${index + 1}`, type: 'function', function: { name: 'runTests', arguments: `{"query":"${index + 1}"}` } }] } }],
			})),
			{ choices: [{ message: { content: 'long tool task complete' } }] },
		], requests));
		const agent = createAgent(createOpenAIFixtures(server.url, { toolCalling: true }), { kind: 'api-key', value: 'sk-test' });
		const created = await agent.createSession();
		agent.setClientTools(created.session, 'client-1', [{
			name: 'runTests',
			title: 'Run Tests',
			description: 'Returns a deterministic result',
			inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
		}]);
		const signals: AgentSignal[] = [];
		disposables.add(agent.onDidSessionProgress(signal => {
			signals.push(signal);
			if (signal.kind === 'pending_confirmation') {
				agent.respondToPermissionRequest(signal.state.toolCallId, true);
				agent.onClientToolCallComplete(created.session, signal.state.toolCallId, {
					success: true,
					pastTenseMessage: 'Ran Run Tests',
					content: [{ type: ToolResultContentType.Text, text: `result for ${signal.state.toolCallId}` }],
				});
			}
		}));

		await agent.sendMessage(created.session, 'use several tools', undefined, 'turn-long-tool-task');
		const turns = await agent.getSessionMessages(created.session);

		assert.deepStrictEqual({
			requestCount: requests.length,
			pendingConfirmations: signals.filter(signal => signal.kind === 'pending_confirmation').length,
			errorSignals: signals.filter(signal => signal.kind === 'action' && signal.action.type === ActionType.SessionError).length,
			turns: turns.map(turn => ({
				id: turn.id,
				state: turn.state,
				completedToolParts: turn.responseParts.filter(part => part.kind === ResponsePartKind.ToolCall && part.toolCall.status === ToolCallStatus.Completed).length,
				responseText: turn.responseParts
					.filter(part => part.kind === ResponsePartKind.Markdown)
					.map(part => part.content)
					.join(''),
			})),
		}, {
			requestCount: 6,
			pendingConfirmations: 5,
			errorSignals: 0,
			turns: [{
				id: 'turn-long-tool-task',
				state: TurnState.Complete,
				completedToolParts: 5,
				responseText: 'long tool task complete',
			}],
		});
	});

	test('stops repeated identical tool calls with a clear loop guard', async () => {
		const requests: unknown[] = [];
		const server = disposables.add(await createSequenceJsonServer([
			...Array.from({ length: 6 }, (_, index) => ({
				choices: [{ message: { content: '', tool_calls: [{ id: `call-loop-${index + 1}`, type: 'function', function: { name: 'runTests', arguments: '{"query":"same"}' } }] } }],
			})),
		], requests));
		const agent = createAgent(createOpenAIFixtures(server.url, { toolCalling: true }), { kind: 'api-key', value: 'sk-test' });
		const created = await agent.createSession();
		agent.setClientTools(created.session, 'client-1', [{
			name: 'runTests',
			title: 'Run Tests',
			description: 'Returns a deterministic result',
			inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
		}]);
		const signals: AgentSignal[] = [];
		disposables.add(agent.onDidSessionProgress(signal => {
			signals.push(signal);
			if (signal.kind === 'pending_confirmation') {
				agent.respondToPermissionRequest(signal.state.toolCallId, true);
				agent.onClientToolCallComplete(created.session, signal.state.toolCallId, {
					success: true,
					pastTenseMessage: 'Ran Run Tests',
					content: [{ type: ToolResultContentType.Text, text: `result for ${signal.state.toolCallId}` }],
				});
			}
		}));

		await agent.sendMessage(created.session, 'loop tools', undefined, 'turn-tool-loop');
		const turns = await agent.getSessionMessages(created.session);

		assert.deepStrictEqual({
			requestCount: requests.length,
			pendingConfirmations: signals.filter(signal => signal.kind === 'pending_confirmation').length,
			errorSignals: signals.filter(signal => signal.kind === 'action' && signal.action.type === ActionType.SessionError).length,
			turns: turns.map(turn => ({
				id: turn.id,
				state: turn.state,
				completedToolParts: turn.responseParts.filter(part => part.kind === ResponsePartKind.ToolCall && part.toolCall.status === ToolCallStatus.Completed).length,
				responseText: turn.responseParts
					.filter(part => part.kind === ResponsePartKind.Markdown)
					.map(part => part.content)
					.join(''),
			})),
		}, {
			requestCount: 4,
			pendingConfirmations: 3,
			errorSignals: 0,
			turns: [{
				id: 'turn-tool-loop',
				state: TurnState.Complete,
				completedToolParts: 3,
				responseText: 'Director AgentEngine stopped because provider \'test-provider\' repeatedly requested tool \'runTests\' with the same input 4 times.',
			}],
		});
	});

	test('trims oversized history before sending the next provider request', async () => {
		const requests: unknown[] = [];
		const longAnswer = 'x'.repeat(20_000);
		const server = disposables.add(await createSequenceJsonServer([
			{ choices: [{ message: { content: longAnswer } }] },
			{ choices: [{ message: { content: 'trimmed history observed' } }] },
		], requests));
		const agent = createAgent(createOpenAIFixtures(server.url), { kind: 'api-key', value: 'sk-test' });
		const created = await agent.createSession();

		await agent.sendMessage(created.session, 'first turn', undefined, 'turn-long-1');
		await agent.sendMessage(created.session, 'second turn', undefined, 'turn-long-2');

		const secondBody = requests[1] as { messages: Array<{ role: string; content: string }> };
		const historicalAssistant = secondBody.messages.find(message => message.role === 'assistant');
		assert.ok(historicalAssistant);
		assert.ok(historicalAssistant.content.length < longAnswer.length);
		assert.ok(historicalAssistant.content.includes('[Director truncated 9000 history characters]'));
		assert.deepStrictEqual(secondBody.messages.map(message => message.role), ['system', 'user', 'assistant', 'user']);
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

class TestAgentConfigurationService implements IAgentConfigurationService {
	declare readonly _serviceBrand: undefined;
	readonly onDidRootConfigChange = Event.None;

	constructor(private readonly mode: 'interactive' | 'plan') { }

	getEffectiveValue<D extends SchemaDefinition, K extends keyof D & string>(_session: string, schema: ISchema<D>, key: K): SchemaValue<D[K]> | undefined {
		if (key === SessionConfigKey.Mode && schema.validate(key, this.mode)) {
			return this.mode as SchemaValue<D[K]>;
		}
		return undefined;
	}

	getEffectiveWorkingDirectory(_session: string): string | undefined {
		return undefined;
	}

	updateSessionConfig(_session: string, _patch: Record<string, unknown>): void { }

	getSessionConfigValues(_session: string): Record<string, unknown> | undefined {
		return undefined;
	}

	getRootValue<D extends SchemaDefinition, K extends keyof D & string>(_schema: ISchema<D>, _key: K): SchemaValue<D[K]> | undefined {
		return undefined;
	}

	updateRootConfig(_patch: Record<string, unknown>, _replace?: boolean): void { }

	persistRootConfig(): void { }
}

function createOpenAIFixtures(baseURL: string, capabilities?: { readonly streaming?: boolean; readonly toolCalling?: boolean }, modelId = 'gpt-test'): DirectorProviderBackendHubFixtures {
	return {
		defaultProviderId: 'test-provider',
		defaultModelId: `test-provider:${modelId}`,
		providerInstances: [{
			id: 'test-provider',
			kind: 'openai-compatible',
			displayName: 'Test Provider',
			enabled: true,
			authKind: 'api-key',
			apiType: 'openai-completions',
			baseURL,
			defaultModelId: `test-provider:${modelId}`,
			authState: { kind: 'ready' },
		}],
		models: [{
			providerInstanceId: 'test-provider',
			id: `test-provider:${modelId}`,
			providerModelId: modelId,
			name: modelId,
			supportsVision: false,
			...(capabilities !== undefined ? { capabilities } : {}),
		}],
	};
}

function createAnthropicFixtures(baseURL: string, capabilities?: { readonly streaming?: boolean; readonly toolCalling?: boolean }): DirectorProviderBackendHubFixtures {
	return {
		defaultProviderId: 'anthropic-provider',
		defaultModelId: 'anthropic-provider:claude-test',
		providerInstances: [{
			id: 'anthropic-provider',
			kind: 'anthropic-compatible',
			displayName: 'Anthropic Provider',
			enabled: true,
			authKind: 'api-key',
			apiType: 'anthropic-messages',
			baseURL,
			defaultModelId: 'anthropic-provider:claude-test',
			authState: { kind: 'ready' },
		}],
		models: [{
			providerInstanceId: 'anthropic-provider',
			id: 'anthropic-provider:claude-test',
			providerModelId: 'claude-test',
			name: 'Claude Test',
			supportsVision: false,
			...(capabilities !== undefined ? { capabilities } : {}),
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

type TestSequenceJsonResponse = {
	readonly status: number;
	readonly body: unknown;
	readonly delayMs?: number;
};

async function createSequenceJsonServer(responses: readonly unknown[], requests: unknown[]): Promise<TestJsonServer> {
	const { createServer } = await import('http');
	let index = 0;
	const server = createServer((req, res) => {
		if (req.method !== 'POST' || req.url !== '/chat/completions') {
			res.writeHead(404);
			res.end();
			return;
		}
		const chunks: Buffer[] = [];
		req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
		req.on('end', () => {
			requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
			const response = normalizeSequenceJsonResponse(responses[Math.min(index, responses.length - 1)]);
			setTimeout(() => {
				res.writeHead(response.status, { 'content-type': 'application/json' });
				res.end(JSON.stringify(response.body));
				index++;
			}, response.delayMs ?? 0);
		});
	}) as TestJsonServer;
	await listen(server);
	return server;
}

function normalizeSequenceJsonResponse(response: unknown): TestSequenceJsonResponse {
	if (response && typeof response === 'object' && hasKey(response, { body: true })) {
		const candidate = response as { readonly status?: unknown; readonly body?: unknown; readonly delayMs?: unknown };
		if (typeof candidate.status === 'number') {
			return { status: candidate.status, body: candidate.body, delayMs: typeof candidate.delayMs === 'number' ? candidate.delayMs : undefined };
		}
		if (typeof candidate.delayMs === 'number') {
			return { status: 200, body: candidate.body, delayMs: candidate.delayMs };
		}
	}
	return { status: 200, body: response };
}

async function waitForRequestCount(requests: readonly unknown[], count: number): Promise<void> {
	const started = Date.now();
	while (requests.length < count) {
		if (Date.now() - started > 1_000) {
			throw new Error(`Timed out waiting for ${count} provider request(s).`);
		}
		await new Promise(resolve => setTimeout(resolve, 1));
	}
}

async function createSseServer(chunks: readonly string[], path = '/chat/completions'): Promise<TestJsonServer> {
	const { createServer } = await import('http');
	const server = createServer((req, res) => {
		if (req.method !== 'POST' || req.url !== path) {
			res.writeHead(404);
			res.end();
			return;
		}
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		for (const chunk of chunks) {
			res.write(chunk);
		}
		res.end();
	}) as TestJsonServer;
	await listen(server);
	return server;
}

async function listen(server: TestJsonServer): Promise<void> {
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
}
