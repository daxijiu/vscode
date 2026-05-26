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
		const anthropic = buildDirectorNativeMessageRequest({ apiType: 'anthropic-messages', baseURL: 'https://api.anthropic.com', modelId: 'claude-test', authHeader: 'secret', messages, maxTokens: 7, stream: true });
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

	test('keeps unimplemented local/custom adapters unsupported', () => {
		assert.throws(
			() => buildDirectorNativeMessageRequest({ apiType: 'local', baseURL: 'http://localhost', modelId: 'local', authHeader: '', messages }),
			/does not have a Phase 3 normalized message adapter/
		);
	});
});
