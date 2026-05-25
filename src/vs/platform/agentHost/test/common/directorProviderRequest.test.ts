/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { buildDirectorConnectionTestRequest } from '../../common/directorProviderRequest.js';

suite('directorProviderRequest', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('builds provider-specific connection requests without owning process services', () => {
		assert.deepStrictEqual([
			buildDirectorConnectionTestRequest('openai-completions', 'https://api.openai.com/v1/', 'gpt-4.1', 'token').url,
			buildDirectorConnectionTestRequest('anthropic-messages', 'https://api.anthropic.com', 'claude', 'token').headers['anthropic-version'],
			buildDirectorConnectionTestRequest('openai-codex', 'https://chatgpt.com/backend-api/codex', 'gpt-5.2-codex', 'token').headers.originator,
		], [
			'https://api.openai.com/v1/chat/completions',
			'2023-06-01',
			'director-code',
		]);
	});
});
