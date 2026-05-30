/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { buildDirectorNativeMessageRequest } from '../../common/directorProviderAdapters.js';

suite('directorProviderAdapters', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const messages = [
		{ role: 'system' as const, content: 'You are Director.' },
		{ role: 'user' as const, content: 'hello' },
		{ role: 'assistant' as const, content: 'hi' },
	];

	test('builds provider-native request shapes from normalized messages', () => {
		const anthropic = buildDirectorNativeMessageRequest({ apiType: 'anthropic-messages', baseURL: 'https://api.anthropic.com/v1', modelId: 'claude-test', authHeader: 'secret', messages, maxTokens: 7, stream: true });
		const openai = buildDirectorNativeMessageRequest({ apiType: 'openai-completions', baseURL: 'https://api.openai.com/v1/', modelId: 'gpt-test', authHeader: 'secret', messages });
		const gemini = buildDirectorNativeMessageRequest({ apiType: 'gemini-generative', baseURL: 'https://generativelanguage.googleapis.com/v1beta', modelId: 'gemini test', authHeader: 'secret', messages });
		const codex = buildDirectorNativeMessageRequest({ apiType: 'openai-codex', baseURL: 'https://chatgpt.com/backend-api/codex', modelId: 'gpt-codex', authHeader: 'secret', messages });

		assert.deepStrictEqual({
			anthropic: {
				url: anthropic.url,
				system: JSON.parse(anthropic.body).system,
				stream: JSON.parse(anthropic.body).stream,
				messageRoles: JSON.parse(anthropic.body).messages.map((message: { role: string }) => message.role),
			},
			openai: {
				url: openai.url,
				auth: openai.headers.authorization,
				messageRoles: JSON.parse(openai.body).messages.map((message: { role: string }) => message.role),
			},
			gemini: {
				url: gemini.url,
				roles: JSON.parse(gemini.body).contents.map((message: { role: string }) => message.role),
			},
			codex: {
				url: codex.url,
				beta: codex.headers['openai-beta'],
				inputRoles: JSON.parse(codex.body).input.map((message: { role: string }) => message.role),
			},
		}, {
			anthropic: {
				url: 'https://api.anthropic.com/v1/messages',
				system: 'You are Director.',
				stream: true,
				messageRoles: ['user', 'assistant'],
			},
			openai: {
				url: 'https://api.openai.com/v1/chat/completions',
				auth: 'Bearer secret',
				messageRoles: ['system', 'user', 'assistant'],
			},
			gemini: {
				url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini%20test:generateContent',
				roles: ['user', 'model'],
			},
			codex: {
				url: 'https://chatgpt.com/backend-api/codex/responses',
				beta: 'responses=experimental',
				inputRoles: ['user', 'user', 'assistant'],
			},
		});
	});

	test('uses max_completion_tokens for OpenAI o-series models', () => {
		const request = buildDirectorNativeMessageRequest({
			apiType: 'openai-completions',
			baseURL: 'https://api.openai.com/v1',
			modelId: 'o3-mini',
			authHeader: 'secret',
			messages,
			maxTokens: 123,
		});
		const body = JSON.parse(request.body) as { readonly max_tokens?: number; readonly max_completion_tokens?: number };

		assert.deepStrictEqual({
			maxTokens: body.max_tokens,
			maxCompletionTokens: body.max_completion_tokens,
		}, {
			maxTokens: undefined,
			maxCompletionTokens: 123,
		});
	});

	test('serializes Anthropic bearer auth and thinking config', () => {
		const request = buildDirectorNativeMessageRequest({
			apiType: 'anthropic-messages',
			baseURL: 'https://api.anthropic.com',
			modelId: 'claude-test',
			authHeader: 'bearer-token',
			authKind: 'bearer',
			messages,
			thinking: { type: 'enabled', budget_tokens: 1024 },
		});
		const body = JSON.parse(request.body) as { readonly thinking?: unknown };

		assert.deepStrictEqual({
			apiKey: request.headers['x-api-key'],
			authorization: request.headers.authorization,
			thinking: body.thinking,
		}, {
			apiKey: undefined,
			authorization: 'Bearer bearer-token',
			thinking: { type: 'enabled', budget_tokens: 1024 },
		});
	});

	test('serializes OpenAI Chat tool calls, tool results, and function schema', () => {
		const request = buildDirectorNativeMessageRequest({
			apiType: 'openai-completions',
			baseURL: 'https://api.openai.com/v1',
			modelId: 'gpt-test',
			authHeader: 'secret',
			messages: [
				{ role: 'user' as const, content: 'Read the file.' },
				{ role: 'assistant' as const, content: 'I will inspect it.', toolCalls: [{ id: 'call_1', name: 'read_file', input: '{"path":"README.md"}' }] },
				{ role: 'tool' as const, content: 'File contents', toolCallId: 'call_1' },
			],
			tools: [{
				name: 'read_file',
				description: 'Read a workspace file',
				inputSchema: {
					type: 'object' as const,
					properties: {
						path: { type: 'string', description: 'Workspace-relative path' },
					},
					required: ['path'],
				},
			}],
		});
		const body = JSON.parse(request.body) as { readonly messages: readonly object[]; readonly tools: readonly object[]; readonly tool_choice: string };

		assert.deepStrictEqual({
			messages: body.messages,
			tools: body.tools,
			toolChoice: body.tool_choice,
		}, {
			messages: [
				{ role: 'user', content: 'Read the file.' },
				{
					role: 'assistant',
					content: 'I will inspect it.',
					tool_calls: [{
						id: 'call_1',
						type: 'function',
						function: {
							name: 'read_file',
							arguments: '{"path":"README.md"}',
						},
					}],
				},
				{ role: 'tool', tool_call_id: 'call_1', content: 'File contents' },
			],
			tools: [{
				type: 'function',
				function: {
					name: 'read_file',
					description: 'Read a workspace file',
					parameters: {
						type: 'object',
						properties: {
							path: { type: 'string', description: 'Workspace-relative path' },
						},
						required: ['path'],
					},
				},
			}],
			toolChoice: 'auto',
		});
	});

	test('serializes Anthropic tool use, tool results, and tools schema', () => {
		const request = buildDirectorNativeMessageRequest({
			apiType: 'anthropic-messages',
			baseURL: 'https://api.anthropic.com',
			modelId: 'claude-test',
			authHeader: 'secret',
			messages: [
				{ role: 'system' as const, content: 'You are Director.' },
				{ role: 'user' as const, content: 'Read the file.' },
				{ role: 'assistant' as const, content: 'I will inspect it.', toolCalls: [{ id: 'toolu_1', name: 'read_file', input: '{"path":"README.md"}' }] },
				{ role: 'tool' as const, content: 'File contents', toolCallId: 'toolu_1' },
			],
			tools: [{
				name: 'read_file',
				description: 'Read a workspace file',
				inputSchema: {
					type: 'object' as const,
					properties: {
						path: { type: 'string', description: 'Workspace-relative path' },
					},
					required: ['path'],
				},
			}],
		});
		const body = JSON.parse(request.body) as { readonly messages: readonly object[]; readonly tools: readonly object[] };

		assert.deepStrictEqual({
			messages: body.messages,
			tools: body.tools,
		}, {
			messages: [
				{ role: 'user', content: 'Read the file.' },
				{
					role: 'assistant',
					content: [
						{ type: 'text', text: 'I will inspect it.' },
						{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'README.md' } },
					],
				},
				{
					role: 'user',
					content: [{
						type: 'tool_result',
						tool_use_id: 'toolu_1',
						content: 'File contents',
					}],
				},
			],
			tools: [{
				name: 'read_file',
				description: 'Read a workspace file',
				input_schema: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Workspace-relative path' },
					},
					required: ['path'],
				},
			}],
		});
	});

	test('keeps unimplemented local/custom adapters unsupported', () => {
		assert.throws(
			() => buildDirectorNativeMessageRequest({ apiType: 'local', baseURL: 'http://localhost', modelId: 'local', authHeader: '', messages }),
			/does not have a Phase 3 normalized message adapter/
		);
	});
});
