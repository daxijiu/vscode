/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { NullLogService } from '../../../log/common/log.js';
import type { DirectorProviderFetch } from '../../common/directorProviderRuntime.js';
import type { DirectorRuntimeCredential, DirectorRuntimeCredentialRequest, IDirectorRuntimeCredentialService } from '../../common/directorRuntimeCredentials.js';
import { DirectorAnthropicEndpointService } from '../../node/director/directorAnthropicEndpointService.js';
import { DirectorProviderBackendHub, type DirectorProviderBackendHubFixtures } from '../../node/director/directorProviderBackendHub.js';

class FakeCredentialService implements IDirectorRuntimeCredentialService {
	declare readonly _serviceBrand: undefined;

	readonly requests: DirectorRuntimeCredentialRequest[] = [];
	credential: DirectorRuntimeCredential = { kind: 'api-key', value: 'director-secret' };

	async resolveCredential(request: DirectorRuntimeCredentialRequest): Promise<DirectorRuntimeCredential> {
		this.requests.push(request);
		return this.credential;
	}
}

interface FetchCall {
	readonly input: RequestInfo | URL;
	readonly init: RequestInit | undefined;
}

suite('DirectorAnthropicEndpointService', () => {
	const disposables = new DisposableStore();

	teardown(() => disposables.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	test('rejects invalid bearer without resolving credentials or calling provider transport', async () => {
		const calls: FetchCall[] = [];
		const credentials = new FakeCredentialService();
		const service = disposables.add(createService(createAnthropicFixtures('https://anthropic.invalid'), credentials, async (input, init) => {
			calls.push({ input, init });
			throw new Error('unexpected provider call');
		}));
		const handle = disposables.add(await service.start({ providerInstanceId: 'anthropic-provider', modelId: 'anthropic-provider:claude-test', sessionId: 'session-1' }));

		const response = await fetch(`${handle.baseUrl}/v1/messages`, {
			method: 'POST',
			headers: {
				authorization: 'Bearer wrong.session-1',
				'content-type': 'application/json',
			},
			body: JSON.stringify({ model: 'claude-test', max_tokens: 32, messages: [{ role: 'user', content: 'hello' }] }),
		});

		assert.strictEqual(response.status, 401);
		assert.strictEqual(calls.length, 0);
		assert.strictEqual(credentials.requests.length, 0);
	});

	test('projects Director backend models through /v1/models', async () => {
		const service = disposables.add(createService(createAnthropicFixtures('https://anthropic.invalid')));
		const handle = disposables.add(await service.start({ providerInstanceId: 'anthropic-provider', sessionId: 'session-1' }));

		const response = await fetch(`${handle.baseUrl}/v1/models`, {
			headers: { authorization: `Bearer ${handle.nonce}.session-1` },
		});
		const body = await response.json() as { data: Array<{ id: string; display_name: string; max_input_tokens: number; max_tokens: number }> };

		assert.strictEqual(response.status, 200);
		assert.deepStrictEqual(body.data.map(model => model.id), ['claude-test']);
		assert.strictEqual(body.data[0].display_name, 'Claude Test');
		assert.strictEqual(body.data[0].max_input_tokens, 200000);
		assert.strictEqual(body.data[0].max_tokens, 8192);
	});

	test('forwards Anthropic messages through Director provider runtime without Copilot CAPI', async () => {
		let providerRequest: Record<string, unknown> | undefined;
		let providerHeaders: Headers | undefined;
		const credentials = new FakeCredentialService();
		const service = disposables.add(createService(createAnthropicFixtures('https://anthropic.invalid'), credentials, async (input, init) => {
			assert.strictEqual(input.toString(), 'https://anthropic.invalid/v1/messages');
			providerHeaders = new Headers(init?.headers);
			providerRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return jsonResponse({
				id: 'msg_provider',
				type: 'message',
				role: 'assistant',
				model: 'claude-test',
				content: [{ type: 'text', text: 'hello from provider' }],
				stop_reason: 'end_turn',
				usage: { input_tokens: 3, output_tokens: 4, cache_creation_input_tokens: 5, cache_read_input_tokens: 6 },
			});
		}));
		const handle = disposables.add(await service.start({ providerInstanceId: 'anthropic-provider', modelId: 'anthropic-provider:claude-test', sessionId: 'session-1' }));

		const response = await postMessage(handle, {
			model: 'claude-test',
			max_tokens: 64,
			system: 'system prompt',
			messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
			tools: [{ name: 'readFile', description: 'Read file', input_schema: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] } }],
		});
		const body = await response.json() as Record<string, unknown>;
		const usage = body.usage as Record<string, unknown>;

		assert.strictEqual(response.status, 200);
		assert.strictEqual(body.model, 'claude-test');
		assert.deepStrictEqual(body.content, [{ type: 'text', text: 'hello from provider' }]);
		assert.strictEqual(usage.cache_creation_input_tokens, 5);
		assert.strictEqual(usage.cache_read_input_tokens, 6);
		assert.strictEqual(providerHeaders?.get('x-api-key'), 'director-secret');
		assert.strictEqual(providerHeaders?.get('authorization'), null);
		assert.strictEqual(providerRequest?.model, 'claude-test');
		assert.strictEqual(providerRequest?.system, 'system prompt');
		assert.ok(JSON.stringify(providerRequest).includes('readFile'));
		assert.deepStrictEqual(credentials.requests.map(request => request.providerInstanceId), ['anthropic-provider']);
		assert.ok(!JSON.stringify(body).includes('director-secret'));
	});

	test('provider-scoped sessions resolve each request model without stale materialization state', async () => {
		let providerRequest: Record<string, unknown> | undefined;
		const service = disposables.add(createService(createAnthropicMultiModelFixtures('https://anthropic.invalid'), new FakeCredentialService(), async (_input, init) => {
			providerRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return jsonResponse({
				id: 'msg_provider',
				type: 'message',
				role: 'assistant',
				model: 'claude-alt',
				content: [{ type: 'text', text: 'alt selected' }],
				stop_reason: 'end_turn',
				usage: { input_tokens: 1, output_tokens: 1 },
			});
		}));
		const handle = disposables.add(await service.start({ providerInstanceId: 'anthropic-provider', sessionId: 'session-1' }));

		const response = await postMessage(handle, {
			model: 'anthropic-provider:claude-alt',
			max_tokens: 64,
			messages: [{ role: 'user', content: 'use alt' }],
		});
		const body = await response.json() as Record<string, unknown>;

		assert.deepStrictEqual({
			status: response.status,
			responseModel: body.model,
			providerModel: providerRequest?.model,
			content: body.content,
		}, {
			status: 200,
			responseModel: 'anthropic-provider:claude-alt',
			providerModel: 'claude-alt',
			content: [{ type: 'text', text: 'alt selected' }],
		});
	});

	test('passes SDK thinking config through to Anthropic-compatible providers', async () => {
		let providerRequest: Record<string, unknown> | undefined;
		const service = disposables.add(createService(createAnthropicFixtures('https://anthropic.invalid'), new FakeCredentialService(), async (_input, init) => {
			providerRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return jsonResponse({
				id: 'msg_provider',
				type: 'message',
				role: 'assistant',
				model: 'claude-test',
				content: [{ type: 'text', text: 'thinking accepted' }],
				stop_reason: 'end_turn',
				usage: { input_tokens: 1, output_tokens: 1 },
			});
		}));
		const handle = disposables.add(await service.start({ providerInstanceId: 'anthropic-provider', modelId: 'anthropic-provider:claude-test', sessionId: 'session-1' }));

		const response = await postMessage(handle, {
			model: 'claude-test',
			max_tokens: 64,
			thinking: { type: 'enabled', budget_tokens: 1024 },
			messages: [{ role: 'user', content: 'think' }],
		});

		assert.strictEqual(response.status, 200);
		assert.deepStrictEqual(providerRequest?.thinking, { type: 'enabled', budget_tokens: 1024 });
	});

	test('uses bearer credentials for Anthropic-compatible providers when the Director credential is bearer', async () => {
		const credentials = new FakeCredentialService();
		credentials.credential = { kind: 'bearer', accessToken: 'anthropic-bearer' };
		let providerHeaders: Headers | undefined;
		const service = disposables.add(createService(createAnthropicFixtures('https://anthropic.invalid'), credentials, async (_input, init) => {
			providerHeaders = new Headers(init?.headers);
			return jsonResponse({
				id: 'msg_provider',
				type: 'message',
				role: 'assistant',
				model: 'claude-test',
				content: [{ type: 'text', text: 'bearer accepted' }],
				stop_reason: 'end_turn',
				usage: { input_tokens: 1, output_tokens: 1 },
			});
		}));
		const handle = disposables.add(await service.start({ providerInstanceId: 'anthropic-provider', modelId: 'anthropic-provider:claude-test', sessionId: 'session-1' }));

		const response = await postMessage(handle, {
			model: 'claude-test',
			max_tokens: 64,
			messages: [{ role: 'user', content: 'hello' }],
		});

		assert.strictEqual(response.status, 200);
		assert.strictEqual(providerHeaders?.get('authorization'), 'Bearer anthropic-bearer');
		assert.strictEqual(providerHeaders?.get('x-api-key'), null);
	});

	test('updates shared default selection for requests without a session-bound selection', async () => {
		let providerUrl = '';
		const service = disposables.add(createService(createMixedFixtures(), new FakeCredentialService(), async (input) => {
			providerUrl = input.toString();
			if (providerUrl.includes('openai.invalid')) {
				return jsonResponse({
					choices: [{ message: { content: 'openai selected' } }],
					usage: { prompt_tokens: 2, completion_tokens: 3 },
				});
			}
			return jsonResponse({
				id: 'msg_provider',
				type: 'message',
				role: 'assistant',
				model: 'claude-test',
				content: [{ type: 'text', text: 'anthropic selected' }],
				stop_reason: 'end_turn',
				usage: { input_tokens: 1, output_tokens: 1 },
			});
		}));
		disposables.add(await service.start({ providerInstanceId: 'anthropic-provider', modelId: 'anthropic-provider:claude-test' }));
		const handle = disposables.add(await service.start({ providerInstanceId: 'openai-provider', modelId: 'openai-provider:gpt-test' }));

		const response = await postMessage(handle, {
			model: 'gpt-test',
			max_tokens: 64,
			messages: [{ role: 'user', content: 'hello' }],
		});
		const body = await response.json() as Record<string, unknown>;

		assert.strictEqual(response.status, 200);
		assert.strictEqual(providerUrl, 'https://openai.invalid/v1/chat/completions');
		assert.deepStrictEqual(body.content, [{ type: 'text', text: 'openai selected' }]);
	});

	test('session-scoped start does not overwrite shared default selection', async () => {
		const providerUrls: string[] = [];
		const service = disposables.add(createService(createMixedFixtures(), new FakeCredentialService(), async (input) => {
			const providerUrl = input.toString();
			providerUrls.push(providerUrl);
			if (providerUrl.includes('openai.invalid')) {
				return jsonResponse({
					choices: [{ message: { content: 'openai selected' } }],
					usage: { prompt_tokens: 2, completion_tokens: 3 },
				});
			}
			return jsonResponse({
				id: 'msg_provider',
				type: 'message',
				role: 'assistant',
				model: 'claude-test',
				content: [{ type: 'text', text: 'anthropic selected' }],
				stop_reason: 'end_turn',
				usage: { input_tokens: 1, output_tokens: 1 },
			});
		}));
		const defaultHandle = disposables.add(await service.start({ providerInstanceId: 'anthropic-provider', modelId: 'anthropic-provider:claude-test' }));
		const sessionHandle = disposables.add(await service.start({ providerInstanceId: 'openai-provider', modelId: 'openai-provider:gpt-test', sessionId: 'session-1' }));

		const sessionResponse = await postMessage(sessionHandle, {
			model: 'gpt-test',
			max_tokens: 64,
			messages: [{ role: 'user', content: 'hello' }],
		});
		const defaultResponse = await postMessage(defaultHandle, {
			model: 'claude-test',
			max_tokens: 64,
			messages: [{ role: 'user', content: 'hello' }],
		}, undefined, 'session-2');
		const sessionBody = await sessionResponse.json() as Record<string, unknown>;
		const defaultBody = await defaultResponse.json() as Record<string, unknown>;

		assert.deepStrictEqual({
			sessionStatus: sessionResponse.status,
			defaultStatus: defaultResponse.status,
			providerUrls,
			sessionContent: sessionBody.content,
			defaultContent: defaultBody.content,
		}, {
			sessionStatus: 200,
			defaultStatus: 200,
			providerUrls: [
				'https://openai.invalid/v1/chat/completions',
				'https://anthropic.invalid/v1/messages',
			],
			sessionContent: [{ type: 'text', text: 'openai selected' }],
			defaultContent: [{ type: 'text', text: 'anthropic selected' }],
		});
	});

	test('synthesizes Anthropic SSE from non-streaming provider request when backend does not support endpoint streaming', async () => {
		let providerRequest: Record<string, unknown> | undefined;
		const service = disposables.add(createService(createOpenAIFixtures('https://openai.invalid/v1', { streaming: false, toolCalling: true }), new FakeCredentialService(), async (_input, init) => {
			providerRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return jsonResponse({
				choices: [{ message: { content: 'non streaming fallback' } }],
				usage: { prompt_tokens: 2, completion_tokens: 3 },
			});
		}));
		const handle = disposables.add(await service.start({ providerInstanceId: 'openai-provider', modelId: 'openai-provider:gpt-test', sessionId: 'session-1' }));

		const response = await postMessage(handle, {
			model: 'gpt-test',
			max_tokens: 64,
			stream: true,
			messages: [{ role: 'user', content: 'hello' }],
		});
		const text = await response.text();

		assert.strictEqual(response.status, 200);
		assert.strictEqual(response.headers.get('content-type')?.includes('text/event-stream'), true);
		assert.strictEqual(providerRequest?.stream, false);
		assert.ok(text.includes('event: message_start'));
		assert.ok(text.includes('"text":"non streaming fallback"'));
		assert.ok(text.includes('event: message_stop'));
	});

	test('provider transport failures return a safe Anthropic error without raw credential text', async () => {
		const service = disposables.add(createService(createAnthropicFixtures('https://anthropic.invalid'), new FakeCredentialService(), async () => {
			throw new Error('upstream failed with director-secret Authorization: Bearer provider-token');
		}));
		const handle = disposables.add(await service.start({ providerInstanceId: 'anthropic-provider', modelId: 'anthropic-provider:claude-test', sessionId: 'session-1' }));

		const response = await postMessage(handle, {
			model: 'claude-test',
			max_tokens: 64,
			messages: [{ role: 'user', content: 'hello' }],
		});
		const body = await response.json() as { readonly error: { readonly message: string } };

		assert.strictEqual(response.status, 502);
		assert.strictEqual(body.error.message, 'Director provider request failed.');
		assert.ok(!JSON.stringify(body).includes('director-secret'));
		assert.ok(!JSON.stringify(body).includes('provider-token'));
	});

	test('streams OpenAI-compatible backend output as Anthropic SSE', async () => {
		const credentials = new FakeCredentialService();
		credentials.credential = { kind: 'bearer', accessToken: 'director-bearer' };
		let providerUrl = '';
		let providerHeaders: Headers | undefined;
		const service = disposables.add(createService(createOpenAIFixtures('https://openai.invalid/v1'), credentials, async (input, init) => {
			providerUrl = input.toString();
			providerHeaders = new Headers(init?.headers);
			assert.ok(JSON.parse(String(init?.body)).stream);
			return sseResponse([
				{ choices: [{ delta: { content: 'hello ' } }] },
				{ choices: [{ delta: { content: 'world' } }], usage: { prompt_tokens: 7, completion_tokens: 8 } },
				'[DONE]',
			]);
		}));
		const handle = disposables.add(await service.start({ providerInstanceId: 'openai-provider', modelId: 'openai-provider:gpt-test', sessionId: 'session-1' }));

		const response = await postMessage(handle, {
			model: 'gpt-test',
			max_tokens: 64,
			stream: true,
			messages: [{ role: 'user', content: 'hello' }],
		});
		const text = await response.text();

		assert.strictEqual(response.status, 200);
		assert.strictEqual(response.headers.get('content-type')?.includes('text/event-stream'), true);
		assert.strictEqual(providerUrl, 'https://openai.invalid/v1/chat/completions');
		assert.strictEqual(providerHeaders?.get('authorization'), 'Bearer director-bearer');
		assert.ok(text.includes('event: message_start'));
		assert.ok(text.includes('"text":"hello "'));
		assert.ok(text.includes('"text":"world"'));
		assert.ok(text.includes('"input_tokens":7'));
		assert.ok(text.includes('"output_tokens":8'));
		assert.ok(text.includes('event: message_stop'));
		assert.ok(!text.includes('director-bearer'));
	});

	test('streams OpenAI-compatible tool calls with Anthropic tool_use stop reason', async () => {
		const service = disposables.add(createService(createOpenAIFixtures('https://openai.invalid/v1'), new FakeCredentialService(), async (_input, init) => {
			assert.ok(JSON.parse(String(init?.body)).stream);
			return sseResponse([
				{
					choices: [{
						delta: {
							tool_calls: [{
								index: 0,
								id: 'call_1',
								type: 'function',
								function: { name: 'readFile', arguments: '{"filePath":"README.md"}' },
							}],
						},
						finish_reason: 'tool_calls',
					}],
				},
				{ choices: [], usage: { prompt_tokens: 13, completion_tokens: 5 } },
				'[DONE]',
			]);
		}));
		const handle = disposables.add(await service.start({ providerInstanceId: 'openai-provider', modelId: 'openai-provider:gpt-test', sessionId: 'session-1' }));

		const response = await postMessage(handle, {
			model: 'gpt-test',
			max_tokens: 64,
			stream: true,
			messages: [{ role: 'user', content: 'hello' }],
			tools: [{ name: 'readFile', description: 'Read file', input_schema: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] } }],
		});
		const text = await response.text();

		assert.strictEqual(response.status, 200);
		assert.ok(text.includes('"type":"tool_use"'));
		assert.ok(text.includes('"partial_json":"{\\"filePath\\":\\"README.md\\"}"'));
		assert.ok(text.includes('"stop_reason":"tool_use"'));
		assert.ok(text.includes('"input_tokens":13'));
		assert.ok(text.includes('"output_tokens":5'));
		assert.ok(!text.includes('"stop_reason":"end_turn"'));
	});

	test('missing credentials return an Anthropic authentication error without provider transport', async () => {
		const credentials = new FakeCredentialService();
		credentials.credential = { kind: 'missing', message: 'missing Director credentials' };
		let called = false;
		const service = disposables.add(createService(createAnthropicFixtures('https://anthropic.invalid'), credentials, async () => {
			called = true;
			throw new Error('unexpected provider call');
		}));
		const handle = disposables.add(await service.start({ providerInstanceId: 'anthropic-provider', modelId: 'anthropic-provider:claude-test', sessionId: 'session-1' }));

		const response = await postMessage(handle, {
			model: 'claude-test',
			max_tokens: 32,
			messages: [{ role: 'user', content: 'hello' }],
		});
		const body = await response.json() as { error: { type: string; message: string } };

		assert.strictEqual(response.status, 401);
		assert.strictEqual(body.error.type, 'authentication_error');
		assert.strictEqual(body.error.message, 'missing Director credentials');
		assert.strictEqual(called, false);
	});

	test('client disconnect aborts provider transport', async () => {
		const credentials = new FakeCredentialService();
		let providerSignal: AbortSignal | undefined;
		let signalSeen!: () => void;
		const signalSeenPromise = new Promise<void>(resolve => signalSeen = resolve);
		let signalAborted!: () => void;
		const signalAbortedPromise = new Promise<void>(resolve => signalAborted = resolve);
		const service = disposables.add(createService(createAnthropicFixtures('https://anthropic.invalid'), credentials, async (_input, init) => {
			providerSignal = init?.signal ?? undefined;
			providerSignal?.addEventListener('abort', signalAborted, { once: true });
			signalSeen();
			return new Promise<Response>((_resolve, reject) => {
				providerSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
			});
		}));
		const handle = disposables.add(await service.start({ providerInstanceId: 'anthropic-provider', modelId: 'anthropic-provider:claude-test', sessionId: 'session-1' }));
		const ac = new AbortController();

		const pending = postMessage(handle, {
			model: 'claude-test',
			max_tokens: 32,
			messages: [{ role: 'user', content: 'hello' }],
		}, ac.signal).catch(() => undefined);
		await signalSeenPromise;
		ac.abort();
		await signalAbortedPromise;
		await pending;
		await new Promise(resolve => setTimeout(resolve, 20));

		assert.strictEqual(providerSignal?.aborted, true);
	});
});

function createService(fixtures: DirectorProviderBackendHubFixtures, credentialService = new FakeCredentialService(), fetcher?: DirectorProviderFetch): DirectorAnthropicEndpointService {
	return new DirectorAnthropicEndpointService(
		new NullLogService(),
		new DirectorProviderBackendHub(fixtures),
		credentialService,
		fetcher ?? (async () => { throw new Error('provider fetch not configured'); }),
	);
}

async function postMessage(handle: { readonly baseUrl: string; readonly nonce: string }, body: unknown, signal?: AbortSignal, sessionId = 'session-1'): Promise<Response> {
	return fetch(`${handle.baseUrl}/v1/messages`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${handle.nonce}.${sessionId}`,
			'content-type': 'application/json',
		},
		body: JSON.stringify(body),
		signal,
	});
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

function sseResponse(events: readonly (Record<string, unknown> | '[DONE]')[]): Response {
	return new Response(events.map(event => `data: ${event === '[DONE]' ? event : JSON.stringify(event)}\n\n`).join(''), {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	});
}

function createAnthropicFixtures(baseURL: string): DirectorProviderBackendHubFixtures {
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
			maxContextWindow: 200000,
			maxOutputTokens: 8192,
			supportsVision: false,
			capabilities: { streaming: true, toolCalling: true },
		}],
	};
}

function createAnthropicMultiModelFixtures(baseURL: string): DirectorProviderBackendHubFixtures {
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
		models: [
			{
				providerInstanceId: 'anthropic-provider',
				id: 'anthropic-provider:claude-test',
				providerModelId: 'claude-test',
				name: 'Claude Test',
				maxContextWindow: 200000,
				maxOutputTokens: 8192,
				supportsVision: false,
				capabilities: { streaming: true, toolCalling: true },
			},
			{
				providerInstanceId: 'anthropic-provider',
				id: 'anthropic-provider:claude-alt',
				providerModelId: 'claude-alt',
				name: 'Claude Alt',
				maxContextWindow: 200000,
				maxOutputTokens: 8192,
				supportsVision: false,
				capabilities: { streaming: true, toolCalling: true },
			},
		],
	};
}

function createOpenAIFixtures(baseURL: string, capabilities: { readonly streaming?: boolean; readonly toolCalling?: boolean } = { streaming: true, toolCalling: true }): DirectorProviderBackendHubFixtures {
	return {
		defaultProviderId: 'openai-provider',
		defaultModelId: 'openai-provider:gpt-test',
		providerInstances: [{
			id: 'openai-provider',
			kind: 'openai-compatible',
			displayName: 'OpenAI Provider',
			enabled: true,
			authKind: 'bearer',
			apiType: 'openai-completions',
			baseURL,
			defaultModelId: 'openai-provider:gpt-test',
			authState: { kind: 'ready' },
		}],
		models: [{
			providerInstanceId: 'openai-provider',
			id: 'openai-provider:gpt-test',
			providerModelId: 'gpt-test',
			name: 'GPT Test',
			maxContextWindow: 128000,
			maxOutputTokens: 4096,
			supportsVision: false,
			capabilities,
		}],
	};
}

function createMixedFixtures(): DirectorProviderBackendHubFixtures {
	const anthropic = createAnthropicFixtures('https://anthropic.invalid');
	const openai = createOpenAIFixtures('https://openai.invalid/v1');
	return {
		defaultProviderId: anthropic.defaultProviderId,
		defaultModelId: anthropic.defaultModelId,
		providerInstances: [...(anthropic.providerInstances ?? []), ...(openai.providerInstances ?? [])],
		models: [...(anthropic.models ?? []), ...(openai.models ?? [])],
	};
}
