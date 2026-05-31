/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import type { DirectorProviderFetch, DirectorProviderStreamEvent } from '../../common/directorProviderRuntime.js';
import { createDirectorProviderRuntime } from '../../node/director/providers/directorProviderRuntimeFactory.js';

suite('DirectorProviderRuntimeFactory', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('preserves OpenAI tool_calls finish reason when trailing usage arrives before DONE', async () => {
		const fetcher: DirectorProviderFetch = async () => sseResponse([
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
		const provider = createDirectorProviderRuntime('openai-completions', {
			auth: { kind: 'bearer', accessToken: 'test-token' },
			baseURL: 'https://openai.invalid/v1',
			fetch: fetcher,
		});

		const events: DirectorProviderStreamEvent[] = [];
		for await (const event of provider.createMessageStream!({
			model: 'gpt-test',
			maxTokens: 64,
			messages: [{ role: 'user', content: 'hello' }],
		})) {
			events.push(event);
		}

		assert.deepStrictEqual(events, [
			{ type: 'tool_call_delta', index: 0, id: 'call_1', name: 'readFile', arguments: '{"filePath":"README.md"}' },
			{ type: 'message_complete', usage: { input_tokens: 13, output_tokens: 5 }, stopReason: 'tool_use' },
		]);
	});
});

function sseResponse(events: readonly (Record<string, unknown> | '[DONE]')[]): Response {
	return new Response(events.map(event => `data: ${event === '[DONE]' ? event : JSON.stringify(event)}\n\n`).join(''), {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	});
}
